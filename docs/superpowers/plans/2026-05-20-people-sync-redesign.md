# People Research Synchronous Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the broken Gemini Batch API person-research flow with a synchronous, resumable, chunked job runner that cannot hit the 900 s Lambda timeout.

**Architecture:** A single idempotent worker `runPersonJob` summarises videos one at a time with `ai.models.generateContent`, persisting each as it completes. Before each video it checks remaining Lambda time and self-invokes a continuation when low. An EventBridge tick is repurposed as a safety-net resumer for crashed jobs. See the design spec: `docs/superpowers/specs/2026-05-20-people-sync-redesign-design.md`.

**Tech Stack:** Node.js 20 ESM Lambda, `@google/genai`, AWS SDK v3 (DynamoDB, Lambda), Python Pulumi, Docker Compose tooling. No test framework exists — pure helpers are smoke-tested with a plain `node` script; impure code is verified by `node --check` and a deploy-time integration run.

**Branch:** `people-sync-redesign` (already checked out; the design spec is already committed here).

---

## File structure

- **Create** `backend/summarise/people-pure.js` — dependency-free pure helpers (timing constants, `pickPendingVideos`, `canStartVideo`, `canStartMeta`, `isStalled`, `buildModelChain`, `isRetryableModelError`, `backoffDelayMs`). No AWS SDK / no `@google/genai` imports, so it is importable under local `node`.
- **Create** `backend/summarise/people-pure.test.mjs` — a plain-`node` smoke test for `people-pure.js`.
- **Rewrite** `backend/summarise/people.js` — the synchronous chunked worker, `summariseVideo`, `resumeStalledJobs`; all batch code removed.
- **Modify** `backend/summarise/handler.js` — `handler(event, context)`; `__resumeJobs` dispatch; pass `context` + allowed models into `runPersonJob`.
- **Modify** `infra/pulumi/__main__.py` — EventBridge target input `{"__pollBatches": true}` → `{"__resumeJobs": true}`.
- **Modify** `CLAUDE.md` — replace the Batch API description with the synchronous design.

`src/pages/People.jsx` needs **no change** — it never references `batch_pending` and already renders `progress` during `running`.

---

## Task 1: Pure helpers module + smoke test

**Files:**
- Create: `backend/summarise/people-pure.js`
- Test: `backend/summarise/people-pure.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `backend/summarise/people-pure.test.mjs`:

```js
import assert from "node:assert/strict";
import {
  pickPendingVideos,
  canStartVideo,
  canStartMeta,
  isStalled,
  buildModelChain,
  isRetryableModelError,
  backoffDelayMs,
  VIDEO_TIME_RESERVE_MS,
  META_TIME_RESERVE_MS,
  STALL_THRESHOLD_MS,
  MAX_MODEL_ATTEMPTS,
} from "./people-pure.js";

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`ok - ${name}`);
}

check("pickPendingVideos keeps only pending rows", () => {
  const rows = [
    { videoId: "a", status: "pending" },
    { videoId: "b", status: "done" },
    { videoId: "c", status: "error" },
    { videoId: "d", status: "pending" },
  ];
  assert.deepEqual(pickPendingVideos(rows).map((v) => v.videoId), ["a", "d"]);
  assert.deepEqual(pickPendingVideos(null), []);
});

check("canStartVideo / canStartMeta respect their reserves", () => {
  assert.equal(canStartVideo(VIDEO_TIME_RESERVE_MS + 1), true);
  assert.equal(canStartVideo(VIDEO_TIME_RESERVE_MS), false);
  assert.equal(canStartVideo(1000), false);
  assert.equal(canStartMeta(META_TIME_RESERVE_MS + 1), true);
  assert.equal(canStartMeta(META_TIME_RESERVE_MS), false);
});

check("isStalled flags only idle active jobs", () => {
  const now = 1_000_000_000_000;
  assert.equal(isStalled({ status: "running", lastProgressAt: now - STALL_THRESHOLD_MS - 1 }, now), true);
  assert.equal(isStalled({ status: "running", lastProgressAt: now - 1000 }, now), false);
  assert.equal(isStalled({ status: "done", lastProgressAt: 0 }, now), false);
  assert.equal(isStalled({ status: "queued", queuedAt: now - STALL_THRESHOLD_MS - 1 }, now), true);
  assert.equal(isStalled(null, now), false);
});

check("buildModelChain puts requested first, dedupes, caps at MAX_MODEL_ATTEMPTS", () => {
  const allowed = ["m/a", "m/b", "m/c", "m/d", "m/e"];
  assert.deepEqual(buildModelChain("m/c", allowed), ["m/c", "m/a", "m/b", "m/d"]);
  assert.equal(buildModelChain("m/c", allowed).length, MAX_MODEL_ATTEMPTS);
  assert.deepEqual(buildModelChain("m/x", ["m/x"]), ["m/x"]);
  assert.deepEqual(buildModelChain("m/a", []), ["m/a"]);
});

check("isRetryableModelError classifies quota / 5xx / timeout as retryable", () => {
  assert.equal(isRetryableModelError({ status: 429 }), true);
  assert.equal(isRetryableModelError({ status: 503 }), true);
  assert.equal(isRetryableModelError({ message: "RESOURCE_EXHAUSTED" }), true);
  assert.equal(isRetryableModelError({ message: "request timed out" }), true);
  assert.equal(isRetryableModelError({ status: 400, message: "FAILED_PRECONDITION" }), false);
  assert.equal(isRetryableModelError({ status: 404 }), false);
});

check("backoffDelayMs grows exponentially", () => {
  assert.equal(backoffDelayMs(0), 2000);
  assert.equal(backoffDelayMs(1), 4000);
  assert.equal(backoffDelayMs(2), 8000);
});

console.log(`\n${passed} checks passed`);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `docker compose run --rm node node backend/summarise/people-pure.test.mjs`
Expected: FAIL — `Cannot find module '.../people-pure.js'`.

- [ ] **Step 3: Write the implementation**

Create `backend/summarise/people-pure.js`:

```js
// Pure, dependency-free helpers for the People research worker. No AWS SDK and
// no @google/genai imports, so this module can be imported and smoke-tested
// under local `node` (see people-pure.test.mjs).

// ── Timing / sizing constants ────────────────────────────────────────────────
export const MAX_VIDEOS = 8;                  // videos summarised per run
export const VIDEO_CALL_TIMEOUT_MS = 180_000; // per-video generateContent ceiling
export const VIDEO_TIME_RESERVE_MS = 210_000; // min Lambda time left to start a video
export const META_TIME_RESERVE_MS = 120_000;  // min Lambda time left to start meta
export const MAX_CONTINUATIONS = 12;          // self-invoke loop guard
export const STALL_THRESHOLD_MS = 600_000;    // job considered stalled after this idle
export const MAX_RETRIES_PER_MODEL = 3;       // per-model attempts in summariseVideo
export const MAX_MODEL_ATTEMPTS = 4;          // models tried per video

// ── Job-state predicates ─────────────────────────────────────────────────────

// Video rows still needing a summary.
export function pickPendingVideos(videoRows) {
  return (videoRows || []).filter((v) => v && v.status === "pending");
}

// True when there is enough Lambda time left to start another video summary.
export function canStartVideo(remainingMs) {
  return remainingMs > VIDEO_TIME_RESERVE_MS;
}

// True when there is enough Lambda time left to start the meta-summary call.
export function canStartMeta(remainingMs) {
  return remainingMs > META_TIME_RESERVE_MS;
}

// True when an active person job has made no progress past the stall threshold
// and should be resumed by the safety-net tick.
export function isStalled(personRow, now) {
  if (!personRow) return false;
  if (!["queued", "running", "finalising"].includes(personRow.status)) return false;
  const last = personRow.lastProgressAt || personRow.startedAt || personRow.queuedAt || 0;
  return now - last > STALL_THRESHOLD_MS;
}

// ── Model-chain helpers ──────────────────────────────────────────────────────

// Ordered list of models to try for one video: the requested model first, then
// the rest of the allowed list, deduped, capped at MAX_MODEL_ATTEMPTS.
export function buildModelChain(requested, allowedModelValues) {
  const values = (allowedModelValues || []).filter(Boolean);
  const ordered = [requested, ...values.filter((v) => v !== requested)].filter(Boolean);
  return ordered.slice(0, MAX_MODEL_ATTEMPTS);
}

// True for errors where retrying (after backoff) or advancing to another model
// may help. Mirrors handler.js's predicate of the same name, plus call-timeouts.
export function isRetryableModelError(err) {
  const status = err?.status ?? err?.response?.status;
  if (status === 429 || status === 503 || status === 500) return true;
  const msg = String(err?.message || "").toLowerCase();
  return msg.includes("resource_exhausted")
    || msg.includes("quota")
    || msg.includes("rate limit")
    || msg.includes("unavailable")
    || msg.includes("overloaded")
    || msg.includes("high demand")
    || msg.includes("timed out")
    || msg.includes("timeout");
}

// Exponential backoff (ms) for retry attempt N (0-based), before jitter.
export function backoffDelayMs(attempt) {
  return 2000 * Math.pow(2, attempt);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `docker compose run --rm node node backend/summarise/people-pure.test.mjs`
Expected: PASS — `6 checks passed`.

- [ ] **Step 5: Commit**

```bash
git add backend/summarise/people-pure.js backend/summarise/people-pure.test.mjs
git commit -m "feat: add people-pure.js with smoke tests for the sync worker"
```

---

## Task 2: Rewrite people.js as a synchronous chunked worker

**Files:**
- Rewrite: `backend/summarise/people.js`

- [ ] **Step 1: Replace the entire file**

Overwrite `backend/summarise/people.js` with exactly this content:

```js
import { GoogleGenAI } from "@google/genai";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, QueryCommand, ScanCommand, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { searchVideosByPerson, getVideoMetadata, extractVideoId } from "./youtube.js";
import { DEFAULT_MODEL } from "./constants.js";
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
  isRetryableModelError,
  backoffDelayMs,
} from "./people-pure.js";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const lambda = new LambdaClient({});

const PEOPLE_TABLE = process.env.PEOPLE_TABLE;
const PEOPLE_VIDEOS_TABLE = process.env.PEOPLE_VIDEOS_TABLE;
const SELF_FUNCTION_NAME = process.env.AWS_LAMBDA_FUNCTION_NAME;

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

// ── small async utilities ────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Reject with a retryable "timed out" error if `promise` does not settle in time.
function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`generateContent timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function selfInvoke(payload) {
  await lambda.send(new InvokeCommand({
    FunctionName: SELF_FUNCTION_NAME,
    InvocationType: "Event",
    Payload: Buffer.from(JSON.stringify(payload)),
  }));
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

  await selfInvoke({ __personJob: true, person });

  return {
    statusCode: 202,
    headers: JSON_HEADERS,
    body: JSON.stringify({ person, status: "queued" }),
  };
}

// ── per-video summarisation ──────────────────────────────────────────────────

function buildVideoContents(video, displayName) {
  const videoId = video.videoId || extractVideoId(video.url);
  return [{
    parts: [
      { fileData: { fileUri: video.url } },
      { text: `Speaker to focus on: ${displayName}\nVideo URL: ${video.url}\nVideo ID: ${videoId}\n\n${VIDEO_PROMPT}` },
    ],
  }];
}

// Summarise one video, walking the model chain; each model retried with backoff
// on a retryable error. Returns { markdown, model }. Throws when all exhausted.
async function summariseVideo(ai, video, displayName, modelChain) {
  const contents = buildVideoContents(video, displayName);
  let lastErr;
  for (const model of modelChain) {
    for (let attempt = 0; attempt < MAX_RETRIES_PER_MODEL; attempt++) {
      try {
        const response = await withTimeout(
          ai.models.generateContent({ model, contents }),
          VIDEO_CALL_TIMEOUT_MS,
        );
        const markdown = response.text
          || response.candidates?.[0]?.content?.parts?.map((p) => p.text).filter(Boolean).join("\n")
          || "";
        if (!markdown) throw new Error("empty response");
        return { markdown, model };
      } catch (err) {
        lastErr = err;
        if (!isRetryableModelError(err)) break;
        if (attempt < MAX_RETRIES_PER_MODEL - 1) {
          await sleep(backoffDelayMs(attempt) + Math.floor(Math.random() * 1000));
        }
      }
    }
  }
  throw lastErr || new Error("summariseVideo: all models exhausted");
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

// Idempotent and resumable. Called by one of three triggers: the initial
// research request, a self-invoked continuation, or the safety-net resumer.
// `allowedModels` is a string[] of model values; `context` is the Lambda
// context object (used for remaining-time checks).
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
        await selfInvoke({ __personJob: true, person });
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
      await selfInvoke({ __personJob: true, person });
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
    await selfInvoke({ __personJob: true, person: row.person });
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
```

- [ ] **Step 2: Syntax-check the file**

Run: `docker compose run --rm node node --check backend/summarise/people.js`
Expected: no output, exit 0.

- [ ] **Step 3: Re-run the pure smoke test (still green)**

Run: `docker compose run --rm node node backend/summarise/people-pure.test.mjs`
Expected: PASS — `6 checks passed`.

- [ ] **Step 4: Commit**

```bash
git add backend/summarise/people.js
git commit -m "feat: rewrite people.js as a synchronous chunked job runner"
```

---

## Task 3: Wire handler.js to the synchronous worker

**Files:**
- Modify: `backend/summarise/handler.js`

- [ ] **Step 1: Update the people.js import**

In `backend/summarise/handler.js`, change line 4 from:

```js
import { researchPerson, runPersonJob, getPerson, listPeople, pollPendingBatches } from "./people.js";
```

to:

```js
import { researchPerson, runPersonJob, getPerson, listPeople, resumeStalledJobs } from "./people.js";
```

- [ ] **Step 2: Update the handler signature and the internal-event branches**

In `backend/summarise/handler.js`, replace this block:

```js
export async function handler(event) {
  if (event && event.__personJob) {
    await runPersonJob(event);
    return { statusCode: 200, body: "ok" };
  }

  if (event && event.__pollBatches) {
    const result = await pollPendingBatches();
    return { statusCode: 200, body: JSON.stringify(result) };
  }
```

with:

```js
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
```

`getAllowedModels()` is already defined in `handler.js` and returns `[{ value, label }]`. The `console.log` makes each scheduled safety-net tick observable in CloudWatch (an idle scan is otherwise silent).

- [ ] **Step 3: Syntax-check the file**

Run: `docker compose run --rm node node --check backend/summarise/handler.js`
Expected: no output, exit 0.

- [ ] **Step 4: Commit**

```bash
git add backend/summarise/handler.js
git commit -m "feat: wire handler to the synchronous person worker and resumer"
```

---

## Task 4: Repoint the EventBridge rule at the resumer

**Files:**
- Modify: `infra/pulumi/__main__.py:166-182`

- [ ] **Step 1: Update the schedule comment and target input**

In `infra/pulumi/__main__.py`, replace this block:

```python
# ── Batch-poll schedule ───────────────────────────────────────────────────────
# Person research submits a Gemini Batch job and returns; this rule wakes the
# Lambda every 3 min to poll for completion and write results. See people.js
# `pollPendingBatches`. Short cadence is cheap — scan only filters by
# status=batch_pending, and the batch itself is free to poll.
poll_rule = aws.cloudwatch.EventRule(
    "summarise-poll-rule",
    schedule_expression="rate(3 minutes)",
    description="Poll Gemini batch jobs for yt2txt person research",
)

aws.cloudwatch.EventTarget(
    "summarise-poll-target",
    rule=poll_rule.name,
    arn=summarise_fn.arn,
    input=json.dumps({"__pollBatches": True}),
)
```

with:

```python
# ── Person-job resumer schedule ───────────────────────────────────────────────
# Person research runs synchronously and self-invokes its own continuations;
# this rule is a safety net. It wakes the Lambda every 3 min so people.js
# `resumeStalledJobs` can restart any job whose Lambda was killed mid-run.
poll_rule = aws.cloudwatch.EventRule(
    "summarise-poll-rule",
    schedule_expression="rate(3 minutes)",
    description="Resume stalled yt2txt person-research jobs",
)

aws.cloudwatch.EventTarget(
    "summarise-poll-target",
    rule=poll_rule.name,
    arn=summarise_fn.arn,
    input=json.dumps({"__resumeJobs": True}),
)
```

The Pulumi resource names (`summarise-poll-rule`, `summarise-poll-target`, `summarise-poll-permission`) are kept unchanged so the rule is updated in place, not replaced.

- [ ] **Step 2: Validate the Pulumi program**

Run: `make infra-preview`
Expected: preview succeeds; the diff shows the `summarise-poll-target` input and the rule description changing, with no resource replacement.

- [ ] **Step 3: Commit**

```bash
git add infra/pulumi/__main__.py
git commit -m "feat: point the EventBridge rule at the job resumer"
```

---

## Task 5: Update CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Replace the "Person-research modules" block**

In `CLAUDE.md`, replace this block:

```
Person-research modules:
- `backend/summarise/youtube.js` — YouTube Data API v3 search + metadata (needs `YOUTUBE_API_KEY`).
- `backend/summarise/people.js` — async job runner using the **Gemini Batch API**. Searches last 6 months, submits up to 8 per-video summarisation requests as a single inline batch (separate / higher quota than sync, 50% cheaper), returns immediately. Completion is handled by `pollPendingBatches()`, which is invoked on a schedule.
- Person status progresses: `queued → running (searching) → batch_pending → finalising → done | error`. Per-video rows carry `status: batch_pending | done | error`.
- Persisted in two tables: `yt2txt-people` (hash `person`, job state + `batchName` + `batchKeys` + meta), `yt2txt-people-videos` (hash `person`, sort `videoId`). Per-video summaries are reused across runs — only new videos are summarised.
- Self-invoke (via `InvokeCommand`) uses `AWS_LAMBDA_FUNCTION_NAME` (injected by the Lambda runtime) — do not hardcode or pass as Pulumi config, that creates a circular dep.
- **Batch poller**: an EventBridge rule (`summarise-poll-rule`, every 3 min) invokes the Lambda with `{__pollBatches: true}`. The handler scans `yt2txt-people` for `batch_pending`, calls `ai.batches.get`, writes results to per-video rows, then runs a single sync meta-summary call and marks the person `done`. Terminal batch states: `SUCCEEDED | PARTIALLY_SUCCEEDED | FAILED | CANCELLED | EXPIRED`.
```

with:

```
Person-research modules:
- `backend/summarise/youtube.js` — YouTube Data API v3 search + metadata (needs `YOUTUBE_API_KEY`).
- `backend/summarise/people-pure.js` — dependency-free pure helpers (timing constants, model-chain building, job-state predicates); smoke-tested by `people-pure.test.mjs` under plain `node`.
- `backend/summarise/people.js` — synchronous, resumable job runner. Searches the last 6 months, then summarises up to 8 videos one at a time with `ai.models.generateContent`, persisting each per-video row as it completes.
- `runPersonJob` is idempotent and chunked: before each video it checks `context.getRemainingTimeInMillis()`, and when Lambda time is low it self-invokes a continuation (`{ __personJob: true, person }`) and returns. Any number of videos can be processed without hitting the 900 s Lambda timeout.
- Three triggers call `runPersonJob`: the initial research request, its own time-budget continuations, and the safety-net resumer.
- Person status progresses: `queued → running (searching / summarising) → finalising → done | error`. Per-video rows carry `status: pending | done | error`.
- Persisted in two tables: `yt2txt-people` (hash `person`, job state + `continuationCount` + `lastProgressAt` + meta), `yt2txt-people-videos` (hash `person`, sort `videoId`). Per-video summaries are reused across runs — only new/unfinished videos are summarised.
- Self-invoke (via `InvokeCommand`) uses `AWS_LAMBDA_FUNCTION_NAME` (injected by the Lambda runtime) — do not hardcode or pass as Pulumi config, that creates a circular dep.
- **Safety-net resumer**: an EventBridge rule (`summarise-poll-rule`, every 3 min) invokes the Lambda with `{__resumeJobs: true}`. `resumeStalledJobs()` scans `yt2txt-people` for active jobs idle past the stall threshold (`lastProgressAt` older than 10 min) and self-invokes a continuation — recovering jobs whose Lambda was killed mid-run.
```

- [ ] **Step 2: Replace the two batch-specific "things that will bite you" bullets**

In `CLAUDE.md`, replace this block:

```
- **Batch SLO is 24h**: the Gemini Batch API guarantees completion within 24h but is usually much faster. Person research is no longer "wait ~5 min and it's done" — the UI should reflect `batch_pending` as a legitimate state, not stuck. The poller runs every 3 min so post-completion lag is small.
- **Stale `running` rows from pre-batch runs** will block new `researchPerson` calls (the alreadyRunning guard checks `running | queued | batch_pending`). Manually update or delete the DDB row if a person is stuck from before this refactor.
```

with:

```
- **People research uses the synchronous Gemini API, not the Batch API**: the Batch API is paid-tier only and the project key is free tier — `ai.batches.create()` fails `400 FAILED_PRECONDITION`. `people.js` deliberately calls `ai.models.generateContent` per video. Do not "optimise" it back onto the Batch API without first enabling billing on the Gemini project.
- **A stuck person job self-heals**: the `summarise-poll-rule` tick (`resumeStalledJobs`) resumes any job idle past the 10-min stall threshold. The `researchPerson` busy-guard blocks new runs while a person is `queued | running | finalising`; pass `force: true` to override.
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md for the synchronous People redesign"
```

---

## Task 6: Deploy and verify end-to-end

**Files:** none (deploy + integration verification).

- [ ] **Step 1: Build the Lambda dependencies for linux/amd64**

Run: `make build-lambda`
Expected: `backend/summarise/node_modules/` is (re)installed under `linux/amd64`.

- [ ] **Step 2: Deploy the Lambda and infra**

Run: `make infra-up`
Expected: apply succeeds; the `summarise-poll-target` input changes to `{"__resumeJobs": true}` and the Lambda code updates. No resource is replaced.

- [ ] **Step 3: Deploy the frontend**

Run: `make deploy`
Expected: `dist/` syncs to S3, CloudFront invalidated. (No frontend code changed; this rebuilds for completeness.)

- [ ] **Step 4: Integration test — research a fresh person**

In the deployed site's People page, research **Andrej Karpathy** (or `POST { action: "research", person: "Andrej Karpathy", force: true }`).
Expected, over ~3-10 min:
- Status moves `queued → running` and the page shows `summarising N/total` with the in-flight video title.
- Video cards gain `Summary` `<details>` one by one.
- Status reaches `done` with a meta-summary rendered, and a `★ Best pick` badge on one video.

- [ ] **Step 5: Integration test — recover Demis Hassabis**

Research **Demis Hassabis** with `force: true`. This person has ~8 video rows orphaned at the old `batch_pending` status; `searchAndQueueVideos`'s retry-stale logic resets every non-`done` row to `pending`, so no manual DynamoDB migration is needed. Start this while the Karpathy job from Step 4 may still be running — it confirms per-person jobs do not block each other (the busy-guard is keyed on `person`).
Expected: the job runs to `done` exactly as in Step 4; the previously-stuck person now completes.

- [ ] **Step 6: Verify the resumer tick fires and is harmless when idle**

Wait a few minutes for at least one EventBridge tick, then run:
`make logs SINCE=15m FILTER=resumeStalledJobs`
Expected: at least one `resumeStalledJobs {"scanned":N,"resumed":0}` line — the tick ran and resumed nothing (an in-flight job younger than the 10-min stall threshold is correctly left alone).

- [ ] **Step 7: Final commit (if any uncommitted changes remain)**

```bash
git status
# if make build-lambda or build produced tracked changes, review and commit them;
# otherwise nothing to do.
```

---

## Verification checklist

- `people-pure.test.mjs` passes (`6 checks passed`).
- `node --check` passes for `people.js` and `handler.js`.
- `make infra-preview` shows the EventBridge target updated in place, no replacement.
- A real person research fills the page progressively and reaches `done` with a meta-summary.
- Demis Hassabis — previously stuck — completes.
- A resumer tick over an idle table reports `resumed: 0`.

## Notes for the implementer

- **No test framework / no linter** exists in this repo (per `CLAUDE.md`) — do not add one. Pure logic is smoke-tested via the `node` script in Task 1; impure Lambda code (`people.js`, `handler.js`) cannot be imported under local `node` because it statically imports the runtime-provided AWS SDK, so it is verified by `node --check` plus the deploy-time run.
- **Commit after every task.** Work stays on the `people-sync-redesign` branch.
- `people-pure.test.mjs` ships inside the Lambda zip — it is inert (never imported) and ~2 KB; leaving it there is fine.
- Do not touch `src/pages/People.jsx` — it already handles the `queued/running/finalising/done/error` states and never referenced `batch_pending`.
