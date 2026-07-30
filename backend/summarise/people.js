import { GoogleGenAI } from "@google/genai";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, QueryCommand, ScanCommand, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { invokeWorker } from "./invoke.js";
import { searchVideosByPerson, getVideoMetadata } from "./youtube.js";
import { videoIdFrom } from "./youtube-url.js";
import { DEFAULT_MODEL, MEDIA_RESOLUTION_LOW, fpsForDuration } from "./constants.js";
import {
  MAX_VIDEOS,
  VIDEO_CALL_TIMEOUT_MS,
  MAX_CONTINUATIONS,
  MAX_RETRIES_PER_MODEL,
  pickPendingVideos,
  canStartVideo,
  canStartMeta,
  isStalled,
  buildModelChain,
  backoffDelayMs,
} from "./people-pure.js";
import { generateWithFallback } from "./gemini.js";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const PEOPLE_TABLE = process.env.PEOPLE_TABLE;
const PEOPLE_VIDEOS_TABLE = process.env.PEOPLE_VIDEOS_TABLE;

const JSON_HEADERS = { "Content-Type": "application/json" };

const VIDEO_PROMPT = `Role: You are a no-nonsense Content Analyst extracting what a specific named person says in a YouTube video.

Task: Analyze the video at the provided URL. Focus on what the named person expresses — their viewpoints, arguments, predictions, and advice. Ignore filler, ads, and content from other participants unless it provides essential context.

Output (plain Markdown):
1. '# Title' — the video's title.
2. 'Speaker focus: <name>' — the person we're tracking.
3. 'Key viewpoints' — 3–6 bullets capturing this person's distinctive points. Each bullet ≤ 25 words.
4. 'Notable quotes' — up to 3 short verbatim-ish quotes with timestamp links like [MM:SS](https://youtu.be/VIDEO_ID?t=SECONDS).
5. 'Topics covered' — comma-separated short tags.

Use exactly the Video ID provided below in timestamp links. Do not infer it from the content.

Keep it tight. No preamble, no recap, no filler.`;

const META_PROMPT = (displayName) => `Role: Synthesis analyst. You are given multiple summaries of videos featuring ${displayName}. Produce a single overview of their recurring viewpoints across these videos.

Output strictly as JSON with this shape:
{
  "markdown": "<markdown overview>",
  "bestVideoId": "<videoId of the single most worthwhile video to watch>",
  "bestVideoReason": "<one sentence, under 25 words>"
}

The markdown should contain:
- '# ${displayName} — overview'
- 'Recurring themes' (3–6 bullets; after each bullet, cite supporting videos as [title](url))
- 'Distinctive views' (what makes this person's perspective notable)
- 'Evolution / changes of mind' (if any, else omit)
- 'Best video to watch' (one line, naming the chosen video)

Respond with JSON only — no prose before or after.`;

export function normalisePerson(name) {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

// ── DynamoDB helpers ─────────────────────────────────────────────────────────

async function loadPerson(person) {
  const res = await ddb.send(new GetCommand({ TableName: PEOPLE_TABLE, Key: { person } }));
  return res.Item || null;
}

async function loadPersonVideos(person) {
  const res = await ddb.send(new QueryCommand({
    TableName: PEOPLE_VIDEOS_TABLE,
    KeyConditionExpression: "#p = :p",
    ExpressionAttributeNames: { "#p": "person" },
    ExpressionAttributeValues: { ":p": person },
  }));
  return res.Items || [];
}

async function updatePerson(person, attrs) {
  const names = {};
  const values = {};
  const sets = [];
  for (const [k, v] of Object.entries(attrs)) {
    names[`#${k}`] = k;
    values[`:${k}`] = v;
    sets.push(`#${k} = :${k}`);
  }
  await ddb.send(new UpdateCommand({
    TableName: PEOPLE_TABLE,
    Key: { person },
    UpdateExpression: `SET ${sets.join(", ")}`,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  }));
}

async function updateVideoRow(person, videoId, attrs) {
  const names = {};
  const values = {};
  const sets = [];
  for (const [k, v] of Object.entries(attrs)) {
    names[`#${k}`] = k;
    values[`:${k}`] = v;
    sets.push(`#${k} = :${k}`);
  }
  await ddb.send(new UpdateCommand({
    TableName: PEOPLE_VIDEOS_TABLE,
    Key: { person, videoId },
    UpdateExpression: `SET ${sets.join(", ")}`,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  }));
}

// ── request entry point ──────────────────────────────────────────────────────

// Runs on the *web* function (POST { action: "research" }): it writes the
// queued job row and hands the work to the worker. Everything below this — the
// job runner and the resumer — runs on the worker instead.
export async function researchPerson(displayName, model, { force = false } = {}) {
  const person = normalisePerson(displayName);
  if (!person) {
    return { statusCode: 400, headers: JSON_HEADERS, body: JSON.stringify({ error: "person name required" }) };
  }

  const existing = await loadPerson(person);
  const busy = existing && ["queued", "running", "finalising"].includes(existing.status);
  if (busy && !force) {
    return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ person, status: existing.status, alreadyRunning: true }) };
  }

  const now = Date.now();
  await ddb.send(new PutCommand({
    TableName: PEOPLE_TABLE,
    Item: {
      person,
      displayName,
      status: "queued",
      progress: { current: 0, total: 0, phase: "queued" },
      continuationCount: 0,
      queuedAt: now,
      lastProgressAt: now,
      model: model || null,
    },
  }));

  await invokeWorker({ __personJob: true, person });

  return {
    statusCode: 202,
    headers: JSON_HEADERS,
    body: JSON.stringify({ person, status: "queued" }),
  };
}

// ── per-video summarisation ──────────────────────────────────────────────────

function buildVideoContents(video, displayName, fps) {
  const videoId = video.videoId || videoIdFrom(video.url);
  return [{
    parts: [
      { fileData: { fileUri: video.url }, videoMetadata: { fps } },
      { text: `Speaker to focus on: ${displayName}\nVideo URL: ${video.url}\nVideo ID: ${videoId}\n\n${VIDEO_PROMPT}` },
    ],
  }];
}

// Summarise one video, walking the model chain; each model retried with backoff
// on a retryable error. Returns { markdown, model }. Throws when all exhausted.
// Nobody is waiting on this call, so unlike the request path it is patient:
// several tries per model, a timeout so a hung call cannot eat the run, and a
// non-retryable error only costs this model, not the whole video.
async function summariseVideo(ai, video, displayName, modelChain) {
  // durationSeconds is written by searchAndQueueVideos, so no extra API call.
  const fps = fpsForDuration(video.durationSeconds);
  const outcome = await generateWithFallback(ai, {
    chain: modelChain,
    contents: buildVideoContents(video, displayName, fps),
    config: { mediaResolution: MEDIA_RESOLUTION_LOW },
    attempts: MAX_RETRIES_PER_MODEL,
    backoffMs: (attempt) => backoffDelayMs(attempt) + Math.floor(Math.random() * 1000),
    timeoutMs: VIDEO_CALL_TIMEOUT_MS,
    extractText: (response) => response.text
      || response.candidates?.[0]?.content?.parts?.map((p) => p.text).filter(Boolean).join("\n")
      || "",
    requireText: true,
    onResponse: (response, model) =>
      console.log(`summariseVideo tokens: ${video.videoId} model=${model} fps=${fps} total=${response.usageMetadata?.totalTokenCount ?? "?"}`),
  });
  if (!outcome.ok) throw outcome.error || new Error("summariseVideo: all models exhausted");
  return { markdown: outcome.text, model: outcome.model };
}

// ── meta synthesis ───────────────────────────────────────────────────────────

async function callMeta(ai, model, displayName, context) {
  const response = await ai.models.generateContent({
    model,
    contents: [{
      parts: [
        { text: META_PROMPT(displayName) },
        { text: `\n\nVideo summaries:\n\n${context}` },
      ],
    }],
  });
  const raw = response.text || "";
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("meta response did not contain JSON");
  return JSON.parse(jsonMatch[0]);
}

// Walk the model chain once; the first model to return parseable JSON wins.
async function generateMeta(ai, modelChain, displayName, videos) {
  const context = videos.map((v) =>
    `--- Video: ${v.title} (${v.url}) videoId=${v.videoId} ---\n${v.markdown}\n`
  ).join("\n");

  let lastErr;
  for (const model of modelChain) {
    try {
      return await callMeta(ai, model, displayName, context);
    } catch (err) {
      lastErr = err;
      console.warn(`meta-summary failed on ${model}: ${err?.message || err}`);
    }
  }
  throw lastErr || new Error("generateMeta: all models exhausted");
}

// ── job phases ───────────────────────────────────────────────────────────────

// Search YouTube and write fresh `pending` video rows. Done-with-markdown rows
// are kept; every other existing row is reset to `pending` for a retry.
async function searchAndQueueVideos(person, displayName) {
  await updatePerson(person, {
    status: "running",
    startedAt: Date.now(),
    progress: { phase: "searching", current: 0, total: 0 },
    lastProgressAt: Date.now(),
  });

  const candidates = await searchVideosByPerson(displayName, { max: MAX_VIDEOS, months: 6 });
  const existing = await loadPersonVideos(person);
  const doneIds = new Set(existing.filter((v) => v.status === "done" && v.markdown).map((v) => v.videoId));

  const fromSearch = candidates.filter((c) => !doneIds.has(c.videoId));
  const searchIds = new Set(fromSearch.map((c) => c.videoId));
  const retryStale = existing
    .filter((v) => !doneIds.has(v.videoId) && !searchIds.has(v.videoId) && v.url)
    .map((v) => ({
      videoId: v.videoId,
      url: v.url,
      title: v.title || "",
      channelTitle: v.channelTitle || "",
      publishedAt: v.publishedAt || "",
    }));

  const fresh = [...fromSearch, ...retryStale].slice(0, MAX_VIDEOS);
  if (fresh.length === 0) return;

  const metaMap = await getVideoMetadata(fresh.map((c) => c.videoId));

  for (const v of fresh) {
    const m = metaMap[v.videoId] || {};
    await ddb.send(new PutCommand({
      TableName: PEOPLE_VIDEOS_TABLE,
      Item: {
        person,
        videoId: v.videoId,
        url: v.url,
        title: v.title,
        channelTitle: v.channelTitle,
        publishedAt: v.publishedAt,
        durationSeconds: m.durationSeconds || 0,
        viewCount: m.viewCount || 0,
        markdown: "",
        model: null,
        status: "pending",
        queuedAt: Date.now(),
      },
    }));
  }
}

// Run the meta-summary and mark the person done. A meta failure is non-fatal:
// the person is still marked done, with an empty meta and a metaError note.
async function finalisePerson(ai, modelChain, person, displayName) {
  await updatePerson(person, {
    status: "finalising",
    progress: { phase: "finalising" },
    lastProgressAt: Date.now(),
  });

  const summarised = (await loadPersonVideos(person)).filter((v) => v.markdown);
  let meta = { markdown: "", bestVideoId: null, bestVideoReason: "" };
  let metaError = null;

  if (summarised.length > 0) {
    try {
      meta = await generateMeta(ai, modelChain, displayName, summarised);
    } catch (err) {
      console.error("generateMeta failed", person, err);
      metaError = String(err?.message || err).slice(0, 500);
    }
  }

  await updatePerson(person, {
    status: "done",
    meta,
    metaError,
    lastRunAt: Date.now(),
    lastProgressAt: Date.now(),
    progress: { phase: "done", current: summarised.length, total: summarised.length },
  });
}

// ── the worker ───────────────────────────────────────────────────────────────

// Idempotent and resumable. Called by one of three triggers, all of them
// arriving as `{ __personJob: true }` on the worker function: the initial
// research request (from the web function), a self-invoked continuation, or the
// safety-net resumer. `allowedModels` is a string[] of model values; `context`
// is the Lambda context object (used for remaining-time checks).
export async function runPersonJob(person, allowedModels = [], context) {
  const remaining = () => (context?.getRemainingTimeInMillis?.() ?? Number.MAX_SAFE_INTEGER);

  try {
    const personRow = await loadPerson(person);
    if (!personRow) {
      console.warn(`runPersonJob: no row for "${person}"`);
      return;
    }
    if (personRow.status === "done" || personRow.status === "error") {
      return; // already finished — a stale continuation/resume
    }

    // continuation budget guard
    const continuationCount = (personRow.continuationCount || 0) + 1;
    if (continuationCount > MAX_CONTINUATIONS) {
      await updatePerson(person, {
        status: "error",
        errorMessage: "exceeded continuation budget",
        lastProgressAt: Date.now(),
      });
      return;
    }
    await updatePerson(person, { continuationCount, lastProgressAt: Date.now() });

    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY, apiVersion: "v1beta" });
    const displayName = personRow.displayName || person;
    const modelChain = buildModelChain(personRow.model || DEFAULT_MODEL, allowedModels);

    // search phase — only on the first invocation
    if (personRow.status === "queued") {
      await searchAndQueueVideos(person, displayName);
    }

    // summarise phase
    const videos = await loadPersonVideos(person);
    const total = videos.length;
    let doneCount = videos.filter((v) => v.status === "done" && v.markdown).length;
    let failures = videos.filter((v) => v.status === "error").length;

    for (const video of pickPendingVideos(videos)) {
      if (!canStartVideo(remaining())) {
        await updatePerson(person, {
          progress: { phase: "summarising", current: doneCount, total, failures },
          lastProgressAt: Date.now(),
        });
        await invokeWorker({ __personJob: true, person });
        return;
      }
      await updatePerson(person, {
        progress: { phase: "summarising", current: doneCount, total, failures, currentTitle: video.title || "" },
        lastProgressAt: Date.now(),
      });
      try {
        const { markdown, model } = await summariseVideo(ai, video, displayName, modelChain);
        await updateVideoRow(person, video.videoId, {
          status: "done", markdown, model, summarisedAt: Date.now(),
        });
        doneCount++;
      } catch (err) {
        console.error(`summariseVideo failed: ${person}/${video.videoId}`, err);
        await updateVideoRow(person, video.videoId, {
          status: "error",
          errorMessage: String(err?.message || err).slice(0, 500),
        });
        failures++;
      }
      await updatePerson(person, {
        progress: { phase: "summarising", current: doneCount, total, failures },
        lastProgressAt: Date.now(),
      });
    }

    // finalise phase
    if (!canStartMeta(remaining())) {
      await updatePerson(person, { lastProgressAt: Date.now() });
      await invokeWorker({ __personJob: true, person });
      return;
    }
    await finalisePerson(ai, modelChain, person, displayName);
  } catch (err) {
    console.error("runPersonJob failed", person, err);
    await updatePerson(person, {
      status: "error",
      errorMessage: String(err?.message || err).slice(0, 500),
      lastProgressAt: Date.now(),
    });
  }
}

// ── safety-net resumer (EventBridge tick) ────────────────────────────────────

// Scans for active jobs idle past the stall threshold and self-invokes a
// continuation for each. Recovers jobs whose Lambda was killed mid-run.
//
// The Scan is deliberate, unlike the one listSummaries() replaced with a Query:
// yt2txt-people holds one row per tracked person (tens, not thousands), there
// is no Limit truncating the result, and the filter is on `status` rather than
// on recency — an index would buy nothing at this size.
export async function resumeStalledJobs() {
  const res = await ddb.send(new ScanCommand({
    TableName: PEOPLE_TABLE,
    FilterExpression: "#s IN (:q, :r, :f)",
    ExpressionAttributeNames: { "#s": "status" },
    ExpressionAttributeValues: { ":q": "queued", ":r": "running", ":f": "finalising" },
  }));
  const rows = res.Items || [];
  const now = Date.now();
  let resumed = 0;
  for (const row of rows) {
    if (!isStalled(row, now)) continue;
    console.warn(`resuming stalled job: "${row.person}" (status=${row.status})`);
    await invokeWorker({ __personJob: true, person: row.person });
    resumed++;
  }
  return { scanned: rows.length, resumed };
}

// ── read endpoints ───────────────────────────────────────────────────────────

export async function getPerson(displayName) {
  const person = normalisePerson(displayName);
  const [record, videos] = await Promise.all([loadPerson(person), loadPersonVideos(person)]);
  if (!record) {
    return { statusCode: 404, headers: JSON_HEADERS, body: JSON.stringify({ error: "not found" }) };
  }
  videos.sort((a, b) => (b.publishedAt || "").localeCompare(a.publishedAt || ""));
  return {
    statusCode: 200,
    headers: JSON_HEADERS,
    body: JSON.stringify({ ...record, videos }),
  };
}

// Also a deliberate Scan: one row per tracked person, so the Limit of 100 is a
// guard rail rather than a window, and the whole table is the answer. If the
// people list ever outgrows a page it needs the same treatment as the summaries
// feed — a constant-key index sorted by lastRunAt — not a bigger Limit.
export async function listPeople() {
  const res = await ddb.send(new ScanCommand({ TableName: PEOPLE_TABLE, Limit: 100 }));
  const items = (res.Items || []).map(({ person, displayName, status, lastRunAt, progress }) => ({
    person, displayName, status, lastRunAt, progress,
  }));
  items.sort((a, b) => (b.lastRunAt || 0) - (a.lastRunAt || 0));
  return {
    statusCode: 200,
    headers: JSON_HEADERS,
    body: JSON.stringify({ people: items }),
  };
}
