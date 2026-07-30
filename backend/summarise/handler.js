import { GoogleGenAI } from "@google/genai";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, QueryCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import { researchPerson, getPerson, listPeople } from "./people.js";
import { getVideoMetadata } from "./youtube.js";
import { canonicalUrlForId, canonicalYoutubeUrl, isVideoId, videoIdFrom } from "./youtube-url.js";
import { normaliseSpeakers, parseSpeakerTrailer, stripSpeakerTrailer } from "./tags.js";
import { extractSpeakersFromMarkdown } from "./speakers.js";
import {
  DEFAULT_MODEL, DEFAULT_FPS, MEDIA_RESOLUTION_LOW, fpsForDuration,
  SUMMARY_INDEX, SUMMARY_INDEX_PK, SUMMARY_INDEX_PK_VALUE,
} from "./constants.js";
import { buildModelChain } from "./people-pure.js";
import { getAllowedModels } from "./models.js";
import { generateWithFallback } from "./gemini.js";

// The HTTP request core — every `GET`/`POST` the Function URL serves. Not a
// Lambda entry point itself: `web.js` is, and it imports handleHttpRequest()
// below. The internally-invoked jobs live on the worker function (worker.js)
// and are unreachable from here.

const SYSTEM_PROMPT = `Role: You are a no-nonsense Content Analyst. Your goal is to give me the "meat" of the video in plain English. Cut all fluff, repetitive points, and AI-sounding filler.

Task: Analyze the YouTube video at the provided URL. Use the YouTube tool to get the transcript.
Instructions:
1. Title: Give me a simple, clear title that explains exactly what the video is about. No buzzwords. Use Markdown Heading format '# Title'
2. The Bottom Line (Synthesis): In 100 words or less, explain the main point and why it matters. Use simple language.
3. 3 Quick "Aha!" Moments: Give me 3 bullet points. Each must be under 15 words. Focus on the most useful or surprising things said. Put these below "The Bottom Line."
4. The Metrics (Numbers Only):
  Signal-to-Noise: (x/5)
  Clickbait Factor: (x/5)
5. Key Insights: Use headers for main topics.
6. Speakers: The very last line of your reply, after everything else, must name every person who actually speaks in the video — the host and any guests — in exactly this form:
Speakers: Jane Doe, John Smith
  Real names only. Skip anyone who is merely mentioned but never speaks, and skip generic labels like "host" or "narrator". If you cannot name anyone, write exactly "Speakers: none". This line is metadata, not part of the summary.
 Constraint: Skip the ads and random filler conversation.
 Output: Distill the insights and a timestamp link like this: [HH:MM:SS](https://youtu.be/VIDEO_ID?t=SECONDS).
 Use exactly the Video ID provided below in timestamp links. Do not infer it from the content.
Tone: Clear, direct, and brief. Use plain Markdown. No fancy jargon.`;
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE = process.env.DYNAMODB_TABLE;
const SHARED_SECRET = process.env.SHARED_SECRET || "";

function extractTitle(markdown) {
  const match = markdown.match(/^#{1,2}\s+(.+)/m);
  return match ? match[1].trim() : "Untitled";
}

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

const NO_VIDEO_META = { fps: DEFAULT_FPS, videoTitle: null, channelTitle: null, channelId: null };

// Frame sample rate plus the video's own title and channel, from one YouTube
// API call. Best-effort: the YouTube API is not required for summarising, so
// any failure (including a missing YOUTUBE_API_KEY) falls back to DEFAULT_FPS
// and no channel metadata rather than erroring.
async function lookupVideoMeta(videoId) {
  if (!videoId) return NO_VIDEO_META;
  try {
    const meta = await getVideoMetadata([videoId]);
    const info = meta?.[videoId];
    if (!info) return NO_VIDEO_META;
    return {
      fps: fpsForDuration(info.durationSeconds),
      videoTitle: info.title || null,
      channelTitle: info.channelTitle || null,
      channelId: info.channelId || null,
    };
  } catch (err) {
    console.warn(`metadata lookup failed for ${videoId}, using defaults`, err?.message || err);
    return NO_VIDEO_META;
  }
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
// the one row this video can have.
async function summarise(url, requestedModel = DEFAULT_MODEL) {
  const existing = await ddb.send(new GetCommand({ TableName: TABLE, Key: { url } }));
  if (existing.Item) {
    return {
      statusCode: 200,
      headers: JSON_HEADERS,
      body: JSON.stringify(summaryPayload(existing.Item, url, { cached: true })),
    };
  }

  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY, apiVersion: "v1beta" });
  const videoId = videoIdFrom(url);
  const promptText = `${SYSTEM_PROMPT}\n\nVideo URL: ${url}\nVideo ID: ${videoId}`;
  const allowedModels = await getAllowedModels();
  const chain = buildModelChain(requestedModel, allowedModels.map((m) => m.value));
  const { fps, videoTitle, channelTitle, channelId } = await lookupVideoMeta(videoId);

  // One try per model, no backoff and no timeout: someone is waiting on this
  // response, so a quota error moves straight to the next model and anything
  // else fails the request outright.
  const outcome = await generateWithFallback(ai, {
    chain,
    contents: [{
      parts: [
        { fileData: { fileUri: url }, videoMetadata: { fps } },
        { text: promptText },
      ],
    }],
    config: { mediaResolution: MEDIA_RESOLUTION_LOW },
    attempts: 1,
    throwOnNonRetryable: true,
    onResponse: (response, model) =>
      console.log(`summarise tokens: model=${model} fps=${fps} total=${response.usageMetadata?.totalTokenCount ?? "?"}`),
    onRetryableError: (err, model) =>
      console.warn(`model ${model} failed (${err?.status || ""} ${err?.message || ""}), trying next`),
  });

  if (!outcome.ok) {
    console.error("all models exhausted for summarise", outcome.error);
    return {
      statusCode: 503,
      headers: JSON_HEADERS,
      body: JSON.stringify({ error: "all models are currently rate-limited — try again shortly" }),
    };
  }
  const markdown = outcome.text;
  const usedModel = outcome.model;

  // The speaker trailer is metadata, so it is stripped before the summary is
  // stored. If the model skipped it, re-read the finished summary with a cheap
  // text-only call; tags are optional, so an empty list is a fine outcome.
  const trailer = parseSpeakerTrailer(markdown);
  const cleanMarkdown = stripSpeakerTrailer(markdown);
  let speakers = normaliseSpeakers(trailer || []);
  if (speakers.length === 0 && trailer === null) {
    // null means the extraction call failed; on the request path that is the
    // same as no tags — the summary still ships.
    speakers = (await extractSpeakersFromMarkdown(ai, usedModel, cleanMarkdown)) || [];
  }

  const title = extractTitle(cleanMarkdown);
  const date = new Date().toISOString().split("T")[0];
  const createdAt = Date.now();
  const item = {
    url,
    title,
    markdown: cleanMarkdown,
    date,
    createdAt,
    model: usedModel,
    videoTitle,
    channelTitle,
    channelId,
    speakers,
    // Constant partition key of the byCreatedAt index — this is the only place
    // new rows get it, which is what makes the index a complete feed. It is an
    // index key, not data: neither summaryPayload() nor listRow() returns it.
    [SUMMARY_INDEX_PK]: SUMMARY_INDEX_PK_VALUE,
  };

  try {
    await ddb.send(new PutCommand({
      TableName: TABLE,
      Item: item,
      ConditionExpression: "attribute_not_exists(#u)",
      ExpressionAttributeNames: { "#u": "url" },
    }));
  } catch (err) {
    if (err.name !== "ConditionalCheckFailedException") throw err;
    const again = await ddb.send(new GetCommand({ TableName: TABLE, Key: { url } }));
    if (again.Item) {
      return {
        statusCode: 200,
        headers: JSON_HEADERS,
        body: JSON.stringify(summaryPayload(again.Item, url, { cached: true })),
      };
    }
  }

  return {
    statusCode: 200,
    headers: JSON_HEADERS,
    body: JSON.stringify(summaryPayload(item, url)),
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

// The list cards render ~200 characters of the summary, so that is all the list
// response carries. Shipping whole summaries (up to 8 KB × 50 rows) made every
// cold load pay for the entire archive just so the detail page could read the
// markdown out of memory; it fetches the full row from `?video=` instead.
const LIST_MARKDOWN_CHARS = 300;

// Whitelists what reaches the client: an attribute added to the item is
// invisible to `GET /` until it is added here *and* to summaryPayload().
// `gsi1pk` is deliberately absent — it is an index key, not data.
function listRow({ url, title, date, createdAt, markdown, model, videoTitle, channelTitle, speakers }) {
  const full = markdown || "";
  const summary = full.slice(0, LIST_MARKDOWN_CHARS);
  return {
    url, title, date, createdAt, model,
    videoTitle: videoTitle || null,
    channelTitle: channelTitle || null,
    speakers: speakers || [],
    summary,
    // Tells the detail page the markdown it has is a snippet, so it fetches the
    // real row before rendering or offering a download.
    ...(summary.length < full.length ? { truncated: true } : {}),
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
    return {
      statusCode: 404,
      headers: JSON_HEADERS,
      body: JSON.stringify({ error: "not found" }),
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
      return await summarise(url, model);
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
