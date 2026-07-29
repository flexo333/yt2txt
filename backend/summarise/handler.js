import { GoogleGenAI } from "@google/genai";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, ScanCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import { researchPerson, runPersonJob, getPerson, listPeople, resumeStalledJobs } from "./people.js";
import { extractVideoId, getVideoMetadata } from "./youtube.js";
import { normaliseSpeakers, parseSpeakerTrailer, stripSpeakerTrailer } from "./tags.js";
import { extractSpeakersFromMarkdown } from "./speakers.js";
import { runBackfill } from "./backfill.js";
import { DEFAULT_MODEL, DEFAULT_FPS, MEDIA_RESOLUTION_LOW, fpsForDuration } from "./constants.js";
import { buildModelChain } from "./people-pure.js";
import { generateWithFallback } from "./gemini.js";

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

const YOUTUBE_URL_RE = /^https:\/\/(www\.)?(youtube\.com\/watch\?v=[\w-]{11}|youtu\.be\/[\w-]{11})(\S*)?$/;

const MODEL_CACHE_SUCCESS_TTL_MS = 24 * 60 * 60 * 1000;
const MODEL_CACHE_FALLBACK_TTL_MS = 5 * 60 * 1000;

// Used when ai.models.list() fails or returns nothing usable, so summarising
// and request validation never hard-fail on a Google API hiccup.
const FALLBACK_MODELS = [
  { value: DEFAULT_MODEL, label: "Gemini Flash Latest" },
  { value: "models/gemini-3-flash-preview", label: "Gemini 3 Flash" },
  { value: "models/gemini-flash-lite-latest", label: "Gemini 3.1 Flash Lite" },
  { value: "models/gemini-2.5-flash", label: "Gemini 2.5 Flash" },
  { value: "models/gemini-2.5-flash-lite", label: "Gemini 2.5 Flash Lite" },
  { value: "models/gemma-4-31b-it", label: "Gemma 4 31B" },
  { value: "models/gemma-4-26b-a4b-it", label: "Gemma 4 26B" },
];

function isWantedModel(name) {
  const n = name.toLowerCase();
  if (["tts", "image", "audio", "live"].some((bad) => n.includes(bad))) return false;
  if (n.includes("gemma")) return true;
  if (n.includes("gemini") && n.includes("flash")) return true;
  return false;
}

// Pure: maps raw @google/genai Model objects to sorted [{ value, label }].
// Exported so it can be smoke-tested without a network call.
export function filterModels(rawModels) {
  const wanted = (rawModels || []).filter(
    (m) =>
      m &&
      typeof m.name === "string" &&
      (m.supportedActions || []).includes("generateContent") &&
      isWantedModel(m.name),
  );
  const toOption = (m) => ({ value: m.name, label: m.displayName || m.name });
  const byNameDesc = (a, b) => b.value.localeCompare(a.value);
  const gemini = wanted
    .filter((m) => m.name.toLowerCase().includes("gemini"))
    .map(toOption)
    .sort(byNameDesc);
  const gemma = wanted
    .filter((m) => !m.name.toLowerCase().includes("gemini"))
    .map(toOption)
    .sort(byNameDesc);
  return [...gemini, ...gemma];
}

let modelCache = { expires: 0, list: null };

// Returns [{ value, label }] of allowed models. Cached in module scope:
// 24h after a successful fetch, 5min after a fallback so it retries soon.
async function getAllowedModels() {
  if (modelCache.list && Date.now() < modelCache.expires) {
    return modelCache.list;
  }
  let list;
  let ttl;
  try {
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY, apiVersion: "v1beta" });
    const pager = await ai.models.list({});
    const raw = [];
    for await (const model of pager) {
      raw.push(model);
      if (raw.length >= 500) break;
    }
    list = filterModels(raw);
    if (list.length === 0) {
      console.warn("models.list returned no matching models, using fallback");
      list = FALLBACK_MODELS;
      ttl = MODEL_CACHE_FALLBACK_TTL_MS;
    } else {
      ttl = MODEL_CACHE_SUCCESS_TTL_MS;
    }
  } catch (err) {
    console.error("models.list failed, using fallback", err);
    list = FALLBACK_MODELS;
    ttl = MODEL_CACHE_FALLBACK_TTL_MS;
  }
  modelCache = { expires: Date.now() + ttl, list };
  return list;
}

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
  const videoId = extractVideoId(url);
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

async function listSummaries() {
  const result = await ddb.send(new ScanCommand({ TableName: TABLE, Limit: 100 }));
  const summaries = (result.Items || [])
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 50)
    .map(({ url, title, date, createdAt, markdown, model, videoTitle, channelTitle, speakers }) => ({
      url, title, date, createdAt, model,
      videoTitle: videoTitle || null,
      channelTitle: channelTitle || null,
      speakers: speakers || [],
      summary: (markdown || '').slice(0, 8000),
    }));

  return {
    statusCode: 200,
    headers: JSON_HEADERS,
    body: JSON.stringify({ summaries }),
  };
}

export async function handler(event, context) {
  if (event && event.__personJob) {
    const allowed = await getAllowedModels();
    await runPersonJob(event.person, allowed.map((m) => m.value), context);
    return { statusCode: 200, body: "ok" };
  }

  if (event && event.__backfill) {
    const result = await runBackfill(event, context);
    console.log("runBackfill", JSON.stringify(result));
    return { statusCode: 200, body: JSON.stringify(result) };
  }

  if (event && event.__resumeJobs) {
    const result = await resumeStalledJobs();
    console.log("resumeStalledJobs", JSON.stringify(result));
    return { statusCode: 200, body: JSON.stringify(result) };
  }

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
      if (!body.url || typeof body.url !== "string" || !YOUTUBE_URL_RE.test(body.url)) {
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
      return await summarise(body.url, model);
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
