import { GoogleGenAI } from "@google/genai";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import { researchPerson, getPerson, listPeople } from "./people.js";
import { canonicalUrlForId, canonicalYoutubeUrl, isVideoId, videoIdFrom } from "./youtube-url.js";
import { plainSnippet } from "./snippet.js";
import {
  DEFAULT_MODEL, SUMMARY_INDEX, SUMMARY_INDEX_PK, SUMMARY_INDEX_PK_VALUE,
} from "./constants.js";
import { buildModelChain } from "./people-pure.js";
import { getAllowedModels } from "./models.js";
import { generateSummaryItem, putFreshSummary, putUpgradedSummary } from "./summarise-core.js";

// The HTTP request core — every `GET`/`POST` the Function URL serves. Not a
// Lambda entry point itself: `web.js` is, and it imports handleHttpRequest()
// below. The internally-invoked jobs live on the worker function (worker.js)
// and are unreachable from here.

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE = process.env.DYNAMODB_TABLE;
const SHARED_SECRET = process.env.SHARED_SECRET || "";

const JSON_HEADERS = { "Content-Type": "application/json" };

async function isAllowedModel(model) {
  const models = await getAllowedModels();
  return models.some((m) => m.value === model);
}

function headerValue(event, name) {
  const headers = event.headers || {};
  const lower = name.toLowerCase();
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === lower) return headers[k];
  }
  return undefined;
}

// Shape of a summary in every response body. Rows written before speaker tags
// existed have no speakers/channelTitle/videoTitle — they come back as [] and
// null so the frontend can render old and new rows the same way.
function summaryPayload(item, url, extra = {}) {
  return {
    url,
    markdown: item.markdown,
    title: item.title,
    date: item.date,
    model: item.model,
    videoTitle: item.videoTitle || null,
    channelTitle: item.channelTitle || null,
    speakers: item.speakers || [],
    ...extra,
  };
}

// `url` is always canonical here — the POST handler rewrites it before calling,
// so the dedupe GetItem, the item build and the race re-read below all address
// the one row this video can have. `regenerate` skips the cached return and
// overwrites the row instead — the user's way out of a bad or stale summary.
async function summarise(url, requestedModel = DEFAULT_MODEL, { regenerate = false } = {}) {
  const existing = await ddb.send(new GetCommand({ TableName: TABLE, Key: { url } }));
  if (existing.Item && !regenerate) {
    return {
      statusCode: 200,
      headers: JSON_HEADERS,
      body: JSON.stringify(summaryPayload(existing.Item, url, { cached: true })),
    };
  }

  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY, apiVersion: "v1beta" });
  const allowedModels = await getAllowedModels();
  const chain = buildModelChain(requestedModel, allowedModels.map((m) => m.value));

  // One try per model, no backoff and no timeout: someone is waiting on this
  // response, so a quota error moves straight to the next model and anything
  // else fails the request outright.
  const outcome = await generateSummaryItem(ai, url, chain, {
    attempts: 1,
    throwOnNonRetryable: true,
    logLabel: "summarise",
  });

  if (!outcome.ok) {
    console.error("all models exhausted for summarise", outcome.error);
    return {
      statusCode: 503,
      headers: JSON_HEADERS,
      body: JSON.stringify({ error: "all models are currently rate-limited — try again shortly" }),
    };
  }

  // A regeneration of an existing row is an upgrade write: unconditional, but
  // keeping the old createdAt/date so the row holds its place in history, and
  // keeping known-good metadata if the fresh lookup failed. The old summary is
  // only ever replaced by a successful generation — the failure path above
  // never touched it.
  if (existing.Item) {
    const item = await putUpgradedSummary(outcome.item, existing.Item);
    return {
      statusCode: 200,
      headers: JSON_HEADERS,
      body: JSON.stringify(summaryPayload(item, url)),
    };
  }

  const { adopted, item } = await putFreshSummary(outcome.item);
  return {
    statusCode: 200,
    headers: JSON_HEADERS,
    body: JSON.stringify(summaryPayload(item, url, adopted ? { cached: true } : {})),
  };
}

async function listModels() {
  const models = await getAllowedModels();
  return {
    statusCode: 200,
    headers: JSON_HEADERS,
    body: JSON.stringify({ models }),
  };
}

const LIST_LIMIT = 50;

// The wire contract for `GET /` rows, and the field whitelist for it: an
// attribute added to the item is invisible to `GET /` until it is added here
// *and* to summaryPayload(). `gsi1pk` is deliberately absent — it is an index
// key, not data.
//
// - The row carries the video `id`, not the full url. The client rebuilds the
//   canonical url with the shared canonicalUrlForId(); "one video, one row"
//   guarantees the two biject.
// - `summary` is ALWAYS a plain-text snippet (plainSnippet(), 200 chars), never
//   renderable markdown. So the `truncated` flag is gone from the wire — the
//   client sets it unconditionally — and the full markdown comes from `?video=`.
// - `createdAt` is gone: nothing in src/ reads it.
// Measured on a 32 KB list response: the old 300-char markdown `summary` was
// 47.9% of the bytes and the home page never rendered it as markdown.
function listRow({ url, title, date, markdown, model, videoTitle, channelTitle, speakers }) {
  return {
    id: videoIdFrom(url) || url,
    title, date, model,
    videoTitle: videoTitle || null,
    channelTitle: channelTitle || null,
    speakers: speakers || [],
    summary: plainSnippet(markdown),
  };
}

// The index is ordered by createdAt, so "newest 50" is exact and costs one
// Query of 50 items however large the table gets.
async function queryRecent() {
  const result = await ddb.send(new QueryCommand({
    TableName: TABLE,
    IndexName: SUMMARY_INDEX,
    KeyConditionExpression: "#pk = :pk",
    ExpressionAttributeNames: { "#pk": SUMMARY_INDEX_PK },
    ExpressionAttributeValues: { ":pk": SUMMARY_INDEX_PK_VALUE },
    ScanIndexForward: false,
    Limit: LIST_LIMIT,
  }));
  return result.Items || [];
}

async function listSummaries() {
  const rows = await queryRecent();
  return {
    statusCode: 200,
    headers: JSON_HEADERS,
    body: JSON.stringify({ summaries: rows.map(listRow) }),
  };
}

// The POST handler canonicalises before it writes, and the July 2026 backfill
// moved every pre-canonicalisation row onto its canonical key, so the GetItem
// is the whole answer.
async function findByVideoId(id) {
  const direct = await ddb.send(new GetCommand({ TableName: TABLE, Key: { url: canonicalUrlForId(id) } }));
  return direct.Item || null;
}

// GET ?video=<id> → one full summary. This is what makes /summary/<videoId>
// permalinks outlive the newest-50 window the list response covers.
async function getSummaryByVideo(id) {
  if (!isVideoId(id)) {
    return {
      statusCode: 400,
      headers: JSON_HEADERS,
      body: JSON.stringify({ error: "invalid video id" }),
    };
  }
  const item = await findByVideoId(id);
  if (!item) {
    // 200, not 404: this passes through a CloudFront behavior on a distribution
    // whose spa_mode maps 403/404 to /index.html with a 200, distribution-wide
    // and not scopeable per behavior — a real 404 would reach the browser as the
    // HTML shell.
    return {
      statusCode: 200,
      headers: JSON_HEADERS,
      body: JSON.stringify({ found: false }),
    };
  }
  return {
    statusCode: 200,
    headers: JSON_HEADERS,
    body: JSON.stringify(summaryPayload(item, item.url)),
  };
}

// Called by web.js once the event is known to be an HTTP request — this is the
// whole public surface. Dispatch is by method, then by query string / body.
export async function handleHttpRequest(event) {
  const method = event.requestContext?.http?.method || event.httpMethod || "GET";

  if (SHARED_SECRET) {
    const provided = headerValue(event, "x-yt2txt-key");
    if (provided !== SHARED_SECRET) {
      return {
        statusCode: 401,
        headers: JSON_HEADERS,
        body: JSON.stringify({ error: "unauthorized" }),
      };
    }
  }

  try {
    if (method === "POST") {
      const raw = event.body || "{}";
      if (raw.length > 4096) {
        return {
          statusCode: 413,
          headers: JSON_HEADERS,
          body: JSON.stringify({ error: "payload too large" }),
        };
      }
      const body = JSON.parse(raw);
      if (body.action === "research") {
        if (!body.person || typeof body.person !== "string") {
          return { statusCode: 400, headers: JSON_HEADERS, body: JSON.stringify({ error: "person required" }) };
        }
        const model = body.model || DEFAULT_MODEL;
        if (!(await isAllowedModel(model))) {
          return { statusCode: 400, headers: JSON_HEADERS, body: JSON.stringify({ error: "model not supported" }) };
        }
        return await researchPerson(body.person, model, { force: !!body.force });
      }
      // Canonicalise before anything reads or writes. The table is keyed by
      // `url`, so `youtu.be/<id>` and `watch?v=<id>&si=…` used to open two rows
      // for one video; every path below sees the same
      // `https://www.youtube.com/watch?v=<id>` instead. This is also the
      // validation — no extractable video id, no request — which is why it
      // replaced the old YOUTUBE_URL_RE: it accepts strictly more link shapes
      // (shorts, live, embed, m./music.) and emits strictly one of them.
      const url = canonicalYoutubeUrl(body.url);
      if (!url) {
        return {
          statusCode: 400,
          headers: JSON_HEADERS,
          body: JSON.stringify({ error: "valid youtube url is required" }),
        };
      }
      const model = body.model || DEFAULT_MODEL;
      if (!(await isAllowedModel(model))) {
        return {
          statusCode: 400,
          headers: JSON_HEADERS,
          body: JSON.stringify({ error: "model not supported" }),
        };
      }
      return await summarise(url, model, { regenerate: !!body.regenerate });
    }

    if (method === "GET") {
      const qs = event.queryStringParameters || {};
      if (qs.models === "1") {
        return await listModels();
      }
      if (qs.people === "1") {
        return await listPeople();
      }
      if (qs.person) {
        return await getPerson(qs.person);
      }
      if (qs.video) {
        return await getSummaryByVideo(qs.video);
      }
      return await listSummaries();
    }

    return { statusCode: 405, body: "Method Not Allowed" };
  } catch (err) {
    console.error(err);
    return {
      statusCode: 500,
      headers: JSON_HEADERS,
      body: JSON.stringify({ error: "internal error" }),
    };
  }
}
