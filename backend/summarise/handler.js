import { GoogleGenAI } from "@google/genai";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, ScanCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import { researchPerson, runPersonJob, getPerson, listPeople, resumeStalledJobs } from "./people.js";
import { extractVideoId } from "./youtube.js";
import { DEFAULT_MODEL } from "./constants.js";

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
  { value: DEFAULT_MODEL, label: "Gemini 3 Flash" },
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

const MAX_MODEL_ATTEMPTS = 4;

// Copy of people.js's predicate (kept separate so people.js's own fallback
// stays untouched). True for errors where trying a different model may help.
function isRetryableModelError(err) {
  const status = err?.status ?? err?.response?.status;
  if (status === 429 || status === 503 || status === 500) return true;
  const msg = String(err?.message || "").toLowerCase();
  return msg.includes("resource_exhausted")
    || msg.includes("quota")
    || msg.includes("rate limit")
    || msg.includes("unavailable")
    || msg.includes("overloaded")
    || msg.includes("high demand");
}

// Pure: ordered models to try — the requested model first, then the rest of
// the allowed list, capped at MAX_MODEL_ATTEMPTS. Exported for smoke-testing.
export function buildModelChain(requested, allowedModels) {
  const values = (allowedModels || []).map((m) => m.value);
  const ordered = [requested, ...values.filter((v) => v !== requested)];
  return ordered.slice(0, MAX_MODEL_ATTEMPTS);
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

async function summarise(url, requestedModel = DEFAULT_MODEL) {
  const existing = await ddb.send(new GetCommand({ TableName: TABLE, Key: { url } }));
  if (existing.Item) {
    const { markdown, title, date, model } = existing.Item;
    return {
      statusCode: 200,
      headers: JSON_HEADERS,
      body: JSON.stringify({ markdown, title, url, date, model, cached: true }),
    };
  }

  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY, apiVersion: "v1beta" });
  const videoId = extractVideoId(url);
  const promptText = `${SYSTEM_PROMPT}\n\nVideo URL: ${url}\nVideo ID: ${videoId}`;
  const chain = buildModelChain(requestedModel, await getAllowedModels());

  let markdown;
  let usedModel;
  let lastErr;
  for (const candidate of chain) {
    try {
      const response = await ai.models.generateContent({
        model: candidate,
        contents: [{
          parts: [
            { fileData: { fileUri: url } },
            { text: promptText },
          ],
        }],
      });
      markdown = response.text;
      usedModel = candidate;
      break;
    } catch (err) {
      lastErr = err;
      if (!isRetryableModelError(err)) throw err;
      console.warn(`model ${candidate} failed (${err?.status || ""} ${err?.message || ""}), trying next`);
    }
  }

  if (!usedModel) {
    console.error("all models exhausted for summarise", lastErr);
    return {
      statusCode: 503,
      headers: JSON_HEADERS,
      body: JSON.stringify({ error: "all models are currently rate-limited — try again shortly" }),
    };
  }

  const title = extractTitle(markdown);
  const date = new Date().toISOString().split("T")[0];
  const createdAt = Date.now();

  try {
    await ddb.send(new PutCommand({
      TableName: TABLE,
      Item: { url, title, markdown, date, createdAt, model: usedModel },
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
        body: JSON.stringify({
          markdown: again.Item.markdown,
          title: again.Item.title,
          url,
          date: again.Item.date,
          model: again.Item.model,
          cached: true,
        }),
      };
    }
  }

  return {
    statusCode: 200,
    headers: JSON_HEADERS,
    body: JSON.stringify({ markdown, title, url, date, model: usedModel }),
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
    .map(({ url, title, date, createdAt, markdown, model }) => ({
      url, title, date, createdAt, model,
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
