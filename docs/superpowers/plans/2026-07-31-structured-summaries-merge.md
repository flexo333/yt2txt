# Structured summaries + person-research merge — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the three reconciled 2026-07-31 specs — Gemini-only structured output `{ title, markdown, speakers[] }`, the replace-watching claim-ledger prompt, and merging person research onto one summary per video — as one branch (`claude/structured-summaries-merge`), one PR, nine delineated commits.

**Architecture:** A new pure module `summary-schema.js` owns the response schema and its parse/validate; a new `summarise-core.js` owns the prompt, the Gemini call, item build, and summary-table writes, consumed by both the web POST path (`handler.js`) and person jobs (`people.js`). The trailer contract and everything serving it is deleted. A pure `speaker-section.js` slices per-speaker sections for the People page.

**Tech Stack:** Node 22 (Lambda) / bare `node --test` for tests, `@google/genai` 1.50.1, AWS SDK v3 (runtime-provided), React/Vite frontend.

## Global Constraints

- Specs of record: `docs/superpowers/specs/2026-07-31-gemini-only-structured-output-design.md`, `…-summary-format-rethink-design.md`, `…-merge-person-video-analysis-design.md`.
- Tests: run `node --test` from the repo root with **no path arguments** (canonical form is `make test` via docker; bare local `node --test` is equivalent — the tested modules are dependency-free). Never name directories.
- Pure modules (`tags.js`, `people-pure.js`, `constants.js`, `summary-schema.js`, `speaker-section.js`, `youtube-url.js`, `dispatch-pure.js`, `backfill-pure.js`) must stay importable under bare `node` — no AWS SDK, no `@google/genai` imports. Pure-to-pure imports are fine (precedent: `backfill-pure.js` → `youtube-url.js`).
- Do NOT `npm install` in `backend/summarise/` from host macOS — the lockfile/node_modules are linux/amd64 (`make build-lambda`).
- `handler.js`/`people.js`/`backfill.js` cannot be imported under local node (AWS SDK is Lambda-runtime-provided) — verification for them is the full test suite staying green plus careful review, not new unit tests.
- Every commit message ends with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Commit after every task; the tree must be green (`node --test` → 0 failures) at every commit.

---

### Task 1: Gemini-only allowed models

**Files:**
- Modify: `backend/summarise/models.js:15-54`
- Modify: `src/App.jsx:16-24`

**Interfaces:**
- Produces: `filterModels(rawModels)` now returns one reverse-alpha-sorted Gemini-Flash-only list; `FALLBACK_MODELS` has 5 entries. No signature changes.

- [ ] **Step 1: Edit `models.js`** — replace `FALLBACK_MODELS`, `isWantedModel`, `filterModels`:

```js
// Used when ai.models.list() fails or returns nothing usable, so summarising
// and request validation never hard-fail on a Google API hiccup.
const FALLBACK_MODELS = [
  { value: DEFAULT_MODEL, label: "Gemini Flash Latest" },
  { value: "models/gemini-3-flash-preview", label: "Gemini 3 Flash" },
  { value: "models/gemini-flash-lite-latest", label: "Gemini 3.1 Flash Lite" },
  { value: "models/gemini-2.5-flash", label: "Gemini 2.5 Flash" },
  { value: "models/gemini-2.5-flash-lite", label: "Gemini 2.5 Flash Lite" },
];

// Gemini Flash family only. Gemma was dropped 2026-07-31: it could never be
// reached as a fallback (buildModelChain caps at 4 and the list is
// Gemini-first), and its missing responseSchema support was all that kept the
// speaker-trailer machinery alive — see the structured-output spec.
function isWantedModel(name) {
  const n = name.toLowerCase();
  if (["tts", "image", "audio", "live"].some((bad) => n.includes(bad))) return false;
  return n.includes("gemini") && n.includes("flash");
}

// Pure: maps raw @google/genai Model objects to sorted [{ value, label }].
// Exported so it can be smoke-tested without a network call.
export function filterModels(rawModels) {
  return (rawModels || [])
    .filter(
      (m) =>
        m &&
        typeof m.name === "string" &&
        (m.supportedActions || []).includes("generateContent") &&
        isWantedModel(m.name),
    )
    .map((m) => ({ value: m.name, label: m.displayName || m.name }))
    .sort((a, b) => b.value.localeCompare(a.value));
}
```

- [ ] **Step 2: Edit `src/App.jsx`** — delete the two Gemma lines from `FALLBACK_MODEL_OPTIONS` (lines 22–23: `models/gemma-4-31b-it`, `models/gemma-4-26b-a4b-it`). The remaining 5 entries mirror the backend list.

- [ ] **Step 3: Run `node --test` from repo root.** Expected: 58 pass, 0 fail (no suite covers models.js).

- [ ] **Step 4: Commit**

```bash
git add backend/summarise/models.js src/App.jsx
git commit -m "feat: drop Gemma — allowed models are Gemini Flash-family only

Gemma could never be reached as a fallback (chains cap at 4, Gemini-first
list) and its missing responseSchema support is what forced the
speaker-trailer contract. Loses only the hand-picked free-tier escape hatch.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: `summary-schema.js` — response schema + parse (TDD)

**Files:**
- Create: `backend/summarise/summary-schema.js`
- Create: `backend/summarise/summary-schema.test.mjs`
- Modify: `backend/summarise/people-pure.js:56-68` (`isRetryableModelError`)
- Modify: `backend/summarise/gemini.test.mjs` (one case's expectations)

**Interfaces:**
- Produces: `SUMMARY_RESPONSE_SCHEMA` (object literal, Gemini Schema format with uppercase type strings — no `@google/genai` import needed, keeps the module pure); `parseSummaryResponse(text) → { title, markdown, speakers } | null` (never throws; `speakers` already normalised).
- Produces: `isRetryableModelError` now also matches `"empty response"`, so `requireText` failures advance the chain instead of 500ing the web path (`throwOnNonRetryable`).

- [ ] **Step 1: Write the failing test** `backend/summarise/summary-schema.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { SUMMARY_RESPONSE_SCHEMA, parseSummaryResponse } from "./summary-schema.js";

const good = JSON.stringify({
  title: "How transformers work",
  markdown: "# How transformers work\n\nThe Bottom Line: ...",
  speakers: ["Dr. Jane Doe", "John Smith"],
});

test("schema names the three fields and requires them all", () => {
  assert.deepEqual(Object.keys(SUMMARY_RESPONSE_SCHEMA.properties).sort(), ["markdown", "speakers", "title"]);
  assert.deepEqual([...SUMMARY_RESPONSE_SCHEMA.required].sort(), ["markdown", "speakers", "title"]);
  assert.equal(SUMMARY_RESPONSE_SCHEMA.type, "OBJECT");
});

test("a valid payload parses, with speakers normalised", () => {
  const parsed = parseSummaryResponse(good);
  assert.equal(parsed.title, "How transformers work");
  assert.match(parsed.markdown, /^# How transformers work/);
  // normaliseSpeakers strips honorifics
  assert.deepEqual(parsed.speakers, ["Jane Doe", "John Smith"]);
});

test("junk input returns null, never throws", () => {
  assert.equal(parseSummaryResponse("not json"), null);
  assert.equal(parseSummaryResponse(""), null);
  assert.equal(parseSummaryResponse(null), null);
  assert.equal(parseSummaryResponse("[1,2]"), null);
  assert.equal(parseSummaryResponse('"just a string"'), null);
});

test("wrong-typed or missing fields return null", () => {
  assert.equal(parseSummaryResponse(JSON.stringify({ title: 1, markdown: "x", speakers: [] })), null);
  assert.equal(parseSummaryResponse(JSON.stringify({ title: "t", markdown: "", speakers: [] })), null);
  assert.equal(parseSummaryResponse(JSON.stringify({ title: "t", markdown: "   ", speakers: [] })), null);
  assert.equal(parseSummaryResponse(JSON.stringify({ title: "t", markdown: "x" })), null);
  assert.equal(parseSummaryResponse(JSON.stringify({ title: "t", markdown: "x", speakers: "Jane" })), null);
});

test("empty title falls back to Untitled; non-string speaker entries are dropped", () => {
  const parsed = parseSummaryResponse(JSON.stringify({
    title: "  ",
    markdown: "# T\n\nbody",
    speakers: ["Jane Doe", 42, { name: "x" }, null],
  }));
  assert.equal(parsed.title, "Untitled");
  assert.deepEqual(parsed.speakers, ["Jane Doe"]);
});
```

- [ ] **Step 2: Run `node --test` from repo root.** Expected: the new file FAILS (cannot find module `./summary-schema.js`); the other 58 pass.

- [ ] **Step 3: Create `backend/summarise/summary-schema.js`:**

```js
// The structured-output contract for a summary: the responseSchema every
// summarise call sends, and the parse/validate of what comes back. Replaced
// the Speakers-trailer prompt contract on 2026-07-31 (see the structured-output
// spec) — all allowed models are Gemini now, and every one supports
// responseSchema. Dependency-free apart from tags.js (also pure), so it runs
// under bare `node` — keep it that way.

import { normaliseSpeakers } from "./tags.js";

// Gemini Schema format (uppercase type strings — the SDK's native Schema type,
// which supports propertyOrdering; raw lowercase JSON Schema would be routed to
// responseJsonSchema instead, which does not). Field semantics live in the
// descriptions; the ordering makes the model settle title and body before the
// speaker list, mirroring where the old trailer sat.
export const SUMMARY_RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    title: {
      type: "STRING",
      description: "Simple, clear title stating exactly what the video is about. No buzzwords.",
    },
    markdown: {
      type: "STRING",
      description: "The full summary as plain Markdown, starting with the title as a '# ' heading.",
    },
    speakers: {
      type: "ARRAY",
      items: { type: "STRING" },
      description:
        "Every person who actually speaks in the video, real names only. Skip anyone merely " +
        "mentioned, and generic labels like 'host' or 'narrator'. Empty if none can be named.",
    },
  },
  required: ["title", "markdown", "speakers"],
  propertyOrdering: ["title", "markdown", "speakers"],
};

// The model's JSON reply → { title, markdown, speakers }, or null on anything
// malformed. Null (not a throw) so the call loop can treat a bad payload
// exactly like an empty response — retryable. Speakers are normalised here so
// no caller ever stores a raw model-provided name list.
export function parseSummaryResponse(text) {
  let parsed;
  try {
    parsed = JSON.parse(String(text ?? ""));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const { title, markdown, speakers } = parsed;
  if (typeof title !== "string") return null;
  if (typeof markdown !== "string" || !markdown.trim()) return null;
  if (!Array.isArray(speakers)) return null;
  return {
    title: title.trim() || "Untitled",
    markdown: markdown.trim(),
    speakers: normaliseSpeakers(speakers.filter((s) => typeof s === "string")),
  };
}
```

- [ ] **Step 4: Run `node --test`.** Expected: all pass (58 + 5 new).

- [ ] **Step 5: Make `"empty response"` retryable.** In `backend/summarise/people-pure.js`, `isRetryableModelError`, add one pattern to the message checks:

```js
  return msg.includes("resource_exhausted")
    || msg.includes("quota")
    || msg.includes("rate limit")
    || msg.includes("unavailable")
    || msg.includes("overloaded")
    || msg.includes("high demand")
    || msg.includes("timed out")
    || msg.includes("timeout")
    // gemini.js throws this when requireText finds nothing usable — including a
    // structured-output payload that failed to parse. A model that returned
    // junk once may return valid JSON on the next attempt, and on the request
    // path (throwOnNonRetryable) this must advance the chain, not 500.
    || msg.includes("empty response");
```

- [ ] **Step 6: Run `node --test`.** Expected: `gemini.test.mjs`'s empty-response case now FAILS (it pinned the old non-retryable classification: one attempt then advance). Read the failing case in `backend/summarise/gemini.test.mjs` and update **only that case** to the new semantics: with `attempts > 1` an empty response is retried on the same model before advancing; with `attempts: 1` it advances immediately. Adjust its stub call-count assertions accordingly (if it also asserted `isRetryableModelError`-adjacent behaviour elsewhere, leave those cases alone). Also extend `people-pure.test.mjs`'s `isRetryableModelError` test with `assert.equal(isRetryableModelError(new Error("empty response")), true)`.

- [ ] **Step 7: Run `node --test`.** Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add backend/summarise/summary-schema.js backend/summarise/summary-schema.test.mjs backend/summarise/people-pure.js backend/summarise/people-pure.test.mjs backend/summarise/gemini.test.mjs
git commit -m "feat: structured-output envelope — response schema, parse, retry classification

parseSummaryResponse returns null on any malformed payload; the call loop
treats that as an empty response, now classified retryable so the request
path advances the model chain instead of failing the request.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: `summarise-core.js` + new prompt; rewire `handler.js`

**Files:**
- Create: `backend/summarise/summarise-core.js`
- Modify: `backend/summarise/constants.js` (add `PROMPT_VERSION`, fix the stale `DEFAULT_MODEL` comment)
- Modify: `backend/summarise/handler.js` (summarise() consumes the core; deletions)
- Modify: `backend/summarise/package.json` (pin `@google/genai` to `1.50.1`)

**Interfaces:**
- Consumes: `SUMMARY_RESPONSE_SCHEMA`, `parseSummaryResponse` (Task 2); `generateWithFallback` (existing); `buildModelChain` (existing).
- Produces (for Task 6): `generateSummaryItem(ai, url, modelChain, { attempts?, backoffMs?, timeoutMs?, throwOnNonRetryable?, logLabel? }) → { ok: true, item } | { ok: false, error }`; `getSummaryByUrl(url) → item | null`; `putFreshSummary(item) → { adopted: boolean, item }`; `putUpgradedSummary(item, existing) → item`.

- [ ] **Step 1: `constants.js`** — append after `DEFAULT_FPS`:

```js
// The revision number of SYSTEM_PROMPT (summarise-core.js) — any edit to the
// prompt text bumps it. Summary rows are stamped with it; a row whose
// promptVersion is absent or lower is "stale". Only person jobs act on
// staleness (re-watch and upgrade rows they touch anyway) — the web cache-hit
// path serves stale rows as-is, because someone is waiting.
export const PROMPT_VERSION = 2;
```

Also fix the stale comment on `DEFAULT_MODEL` (line 1–2): change `handler.js's FALLBACK_MODELS and pass its isWantedModel() filter` to `models.js's FALLBACK_MODELS and pass its isWantedModel() filter`.

- [ ] **Step 2: Create `backend/summarise/summarise-core.js`** — the one summarise pipeline. Exact content:

```js
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import { getVideoMetadata } from "./youtube.js";
import { videoIdFrom } from "./youtube-url.js";
import {
  DEFAULT_FPS, MEDIA_RESOLUTION_LOW, fpsForDuration, PROMPT_VERSION,
  SUMMARY_INDEX_PK, SUMMARY_INDEX_PK_VALUE,
} from "./constants.js";
import { generateWithFallback } from "./gemini.js";
import { SUMMARY_RESPONSE_SCHEMA, parseSummaryResponse } from "./summary-schema.js";

// The one summarise pipeline: prompt → Gemini (structured output) → summary
// item → summaries-table writes. Both entry points call it with their own
// patience — the web POST path (handler.js: 1 attempt per model, no timeout,
// throwOnNonRetryable) and person jobs (people.js: retries, backoff, per-call
// timeout). One prompt version for all videos means a video is watched at most
// once per PROMPT_VERSION, whichever path gets there first.

const SYSTEM_PROMPT = `Role: You are a no-nonsense Content Analyst. Your summary must fully replace watching the video: a reader should finish it knowing every substantive thing said, in plain English. Cut ads, fluff, repetition, and AI-sounding filler.

Task: Analyze the YouTube video at the provided URL. Use the YouTube tool to get the transcript.

Reply with a single JSON object: { "title", "markdown", "speakers" }.

title: A simple, clear title that says exactly what the video is about. No buzzwords.

speakers: Every person who actually speaks in the video — the host and any guests. Real names only. Skip anyone who is merely mentioned but never speaks, and skip generic labels like "host" or "narrator". An empty list if you cannot name anyone.

markdown: The summary as plain Markdown, in exactly this order:
1. The title again, as a Markdown heading: '# <title>'.
2. The Bottom Line: In 100 words or less, the main point and why it matters. Simple language.
3. Aha!: 3 bullets, each under 15 words — the most useful or surprising things said.
4. Claims: A '## Claims' section — a numbered list of every substantive claim, argument, prediction, or recommendation made in the video, in the order it comes up. Each entry: a bold one-line statement of the claim, then the reasoning or evidence given (keep specific numbers, names, and examples), any caveat or pushback raised, and a timestamp link. When more than one person speaks, name who makes each claim. Scale the list to the content — a dense hour deserves many entries, a thin video few. Do not pad, and do not merge distinct claims to save space.
5. What each speaker argues — only when two or more people speak: '## What each speaker argues', then a '### <Name>' subsection per named speaker with 2–4 bullets of their distinctive viewpoints (each 25 words or less) and up to 2 short verbatim-ish quotes with timestamp links. Use exactly the same names here as in the speakers field. If only one person speaks, emit instead '## Notable quotes': up to 3 short verbatim-ish quotes with timestamp links, no per-speaker subsections.

Timestamps: link like [HH:MM:SS](https://youtu.be/VIDEO_ID?t=SECONDS). Use exactly the Video ID provided below. Do not infer it from the content.
Tone: Clear, direct, and brief. Plain Markdown. No fancy jargon.`;

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE = process.env.DYNAMODB_TABLE;

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

export async function getSummaryByUrl(url) {
  const res = await ddb.send(new GetCommand({ TableName: TABLE, Key: { url } }));
  return res.Item || null;
}

// Watch the video and build (but not write) a complete summaries-table item.
// `url` must already be canonical — it becomes the item's key.
export async function generateSummaryItem(ai, url, modelChain, {
  attempts = 1,
  backoffMs,
  timeoutMs = 0,
  throwOnNonRetryable = false,
  logLabel = "summarise",
} = {}) {
  const videoId = videoIdFrom(url);
  const { fps, videoTitle, channelTitle, channelId } = await lookupVideoMeta(videoId);

  // A solo speaker often never says their own name; the channel name usually
  // carries it. Included only when the metadata lookup succeeded.
  const hint = (videoTitle || channelTitle)
    ? `\nChannel: ${channelTitle || "unknown"} / Video title: ${videoTitle || "unknown"}.` +
      `\nIf a speaker never states their name, the channel name may identify them — use it only if it plausibly names a person; never invent a name.`
    : "";
  const promptText = `${SYSTEM_PROMPT}\n\nVideo URL: ${url}\nVideo ID: ${videoId}${hint}`;

  const outcome = await generateWithFallback(ai, {
    chain: modelChain,
    contents: [{
      parts: [
        { fileData: { fileUri: url }, videoMetadata: { fps } },
        { text: promptText },
      ],
    }],
    config: {
      mediaResolution: MEDIA_RESOLUTION_LOW,
      responseMimeType: "application/json",
      responseSchema: SUMMARY_RESPONSE_SCHEMA,
    },
    attempts,
    backoffMs,
    timeoutMs,
    throwOnNonRetryable,
    // A payload that fails to parse reads as an empty response — retryable, so
    // the loop advances instead of persisting junk.
    extractText: (response) => {
      const text = response.text
        || response.candidates?.[0]?.content?.parts?.map((p) => p.text).filter(Boolean).join("\n")
        || "";
      return parseSummaryResponse(text) ? text : "";
    },
    requireText: true,
    onResponse: (response, model) =>
      console.log(`${logLabel} tokens: model=${model} fps=${fps} total=${response.usageMetadata?.totalTokenCount ?? "?"}`),
    onRetryableError: (err, model, attempt) =>
      console.warn(`${logLabel}: model ${model} attempt ${attempt} failed (${err?.status || ""} ${err?.message || ""}), continuing`),
  });
  if (!outcome.ok) return { ok: false, error: outcome.error };

  const { title, markdown, speakers } = parseSummaryResponse(outcome.text);
  return {
    ok: true,
    item: {
      url,
      title,
      markdown,
      date: new Date().toISOString().split("T")[0],
      createdAt: Date.now(),
      model: outcome.model,
      videoTitle,
      channelTitle,
      channelId,
      speakers,
      // Internal, like the index key below: stamped so person jobs can tell a
      // current row from one written by an older prompt. Deliberately absent
      // from listRow() and summaryPayload().
      promptVersion: PROMPT_VERSION,
      // Constant partition key of the byCreatedAt index — this is the only
      // place new rows get it, which is what makes the index a complete feed.
      [SUMMARY_INDEX_PK]: SUMMARY_INDEX_PK_VALUE,
    },
  };
}

// First writer wins: the conditional Put keeps one row per canonical url, and
// a loser adopts the winner's row — post-deploy, any concurrent writer
// produced an equally current one. `adopted` tells the web path to mark the
// response `cached`.
export async function putFreshSummary(item) {
  try {
    await ddb.send(new PutCommand({
      TableName: TABLE,
      Item: item,
      ConditionExpression: "attribute_not_exists(#u)",
      ExpressionAttributeNames: { "#u": "url" },
    }));
    return { adopted: false, item };
  } catch (err) {
    if (err.name !== "ConditionalCheckFailedException") throw err;
    const again = await ddb.send(new GetCommand({ TableName: TABLE, Key: { url: item.url } }));
    if (again.Item) return { adopted: true, item: again.Item };
    return { adopted: false, item };
  }
}

// Upgrade of a stale row: unconditional, but preserving the old createdAt and
// date so the upgrade is invisible to the history feed's order and dates.
export async function putUpgradedSummary(item, existing) {
  const upgraded = {
    ...item,
    createdAt: typeof existing?.createdAt === "number" ? existing.createdAt : item.createdAt,
    date: existing?.date || item.date,
  };
  await ddb.send(new PutCommand({ TableName: TABLE, Item: upgraded }));
  return upgraded;
}
```

- [ ] **Step 3: Rewire `handler.js`.**
  - Delete the `SYSTEM_PROMPT` const (lines 22–39), `extractTitle` (44–47), `NO_VIDEO_META` + `lookupVideoMeta` (65–87).
  - Imports: drop line 5 (`getVideoMetadata`), line 7 (`tags.js`), line 8 (`speakers.js`); drop `videoIdFrom` from the line-6 import (keep `canonicalUrlForId, canonicalYoutubeUrl, isVideoId`); drop `PutCommand` from line 3; trim the constants import (line 9–12) to `DEFAULT_MODEL, SUMMARY_INDEX, SUMMARY_INDEX_PK, SUMMARY_INDEX_PK_VALUE`; add `import { generateSummaryItem, putFreshSummary } from "./summarise-core.js";`.
  - Replace the body of `summarise()` from line 119 (`const ai = …`) through the end of the function (line 213) with:

```js
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

  const { adopted, item } = await putFreshSummary(outcome.item);
  return {
    statusCode: 200,
    headers: JSON_HEADERS,
    body: JSON.stringify(summaryPayload(item, url, adopted ? { cached: true } : {})),
  };
```

  (The dedupe `GetCommand` at the top of `summarise()` and everything else in the file stays. Note `handler.js` still imports `GetCommand`/`QueryCommand` for the read paths.)

- [ ] **Step 4: Pin `@google/genai`.** In `backend/summarise/package.json` change `"^1.0.0"` → `"1.50.1"`. Then sync the lockfile under linux/amd64: `make build-lambda` (requires Docker; if the daemon is not up, `open -a Docker` and wait). Confirm with `git diff backend/summarise/package-lock.json` that only the version-range strings changed (resolution was already 1.50.1).

- [ ] **Step 5: Run `node --test`.** Expected: all pass (nothing imports handler.js in tests).

- [ ] **Step 6: Review the diff** (`git diff`) against the interface block above — especially that `summarise()`'s cache-hit path, 503 body, and race semantics are byte-identical in behaviour.

- [ ] **Step 7: Commit**

```bash
git add backend/summarise/summarise-core.js backend/summarise/constants.js backend/summarise/handler.js backend/summarise/package.json backend/summarise/package-lock.json
git commit -m "feat: replace-watching prompt + structured output via a shared summarise core

SYSTEM_PROMPT v2: claim ledger replacing the triage format, per-speaker
sections, notable quotes for solo videos, channel/title hint block. Output is
the { title, markdown, speakers } envelope — no trailer, no title scraping.
summarise-core.js owns prompt/call/parse/item/writes so person jobs can share
it; handler.js keeps its patience (1 attempt, fail fast) and race semantics.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Delete the trailer machinery

**Files:**
- Delete: `backend/summarise/speakers.js`
- Modify: `backend/summarise/tags.js` (remove trailer exports + helpers)
- Modify: `backend/summarise/tags.test.mjs` (remove trailer cases)
- Modify: `backend/summarise/backfill.js` (remove the speakers pass)

**Interfaces:**
- Produces: `tags.js` exports exactly `MAX_SPEAKERS`, `parseSpeakerList`, `normaliseSpeakers`. `runBackfill(event, context)` no longer accepts `model`, result object loses `speakersUpdated`.

- [ ] **Step 1:** `git rm backend/summarise/speakers.js` (verified importers: only `handler.js` — already unwired in Task 3 — and `backfill.js`, unwired below).

- [ ] **Step 2: Prune `tags.js`:** delete `TRAILER_SEARCH_LINES` (line 13–14), `TRAILER_RE` (16–19), `findTrailer` (35–45), `parseSpeakerTrailer` (47–51), `stripSpeakerTrailer` (53–62). Update the module header comment to say the module cleans speaker-name arrays arriving via structured output (the trailer contract died 2026-07-31). Keep `MAX_SPEAKERS`, `MIN_NAME_LENGTH`…`JUNK`, `parseSpeakerList`, `cleanName`, `normaliseSpeakers`, `HONORIFIC_RE` unchanged.

- [ ] **Step 3: Prune `tags.test.mjs`:** remove the trailer-parse and trailer-strip test cases and the `parseSpeakerTrailer`/`stripSpeakerTrailer` imports; keep every name-cleaning / list-splitting / dedupe / cap case.

- [ ] **Step 4: Prune `backfill.js`:**
  - Imports: drop `GoogleGenAI` (line 1), `extractSpeakersFromMarkdown` (line 9), `DEFAULT_MODEL` from line 10 (keep `SUMMARY_INDEX_PK, SUMMARY_INDEX_PK_VALUE`).
  - Delete `needsSpeakers` (70–72), `backfillSpeakers` (255–271), `TIME_RESERVE_MS` (44–45, only the speakers pass metered on it).
  - In `runBackfill`: delete `const model = …` (276) and `const ai = …` (278) and the `remaining` helper (277, now unused — keep the `context` parameter for signature stability); delete `speakersUpdated: 0` from the result literal; delete the whole speakers-pass block (lines 310–329, from `const speakerRows = …` through its closing brace).
  - Header comment (lines 12–36): the passes list becomes three (drop the speakers bullet); drop the sentence about failed extractions being retried.

- [ ] **Step 5: Run `node --test`.** Expected: all pass, with fewer tags cases. Also `grep -rn "speakers.js\|parseSpeakerTrailer\|stripSpeakerTrailer\|extractSpeakersFromMarkdown" backend/ src/ --include="*.js" --include="*.mjs" --include="*.jsx"` → no hits.

- [ ] **Step 6: Commit**

```bash
git add -A backend/summarise/
git commit -m "chore: delete the speaker-trailer machinery

speakers.js (text-only re-extraction), the trailer parse/strip in tags.js,
and the backfill's speakers pass — all dead once speakers arrive as
structured output. The backfill is DynamoDB + YouTube only now.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: `speaker-section.js` slicer (TDD)

**Files:**
- Create: `backend/summarise/speaker-section.js`
- Create: `backend/summarise/speaker-section.test.mjs`

**Interfaces:**
- Produces: `sliceForSpeaker(markdown, name) → string | null` — the `### <Name>` subsection (heading included, trimmed) of `## What each speaker argues`, or `null` when the section or a matching heading is absent.

- [ ] **Step 1: Write the failing test** `backend/summarise/speaker-section.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { sliceForSpeaker } from "./speaker-section.js";

const MD = `# Big AI debate

The Bottom Line: things happened.

## Claims

1. **AGI is near.** Because scaling. [00:01:00](https://youtu.be/abc?t=60)

## What each speaker argues

### Dr. Jane Doe

- Scaling laws hold for another decade
- "We are not close to a wall" [00:12:04](https://youtu.be/abc?t=724)

### John Smith

- Compute is the bottleneck, not data

## Notable quotes

- stray section that must not leak into a slice
`;

test("returns the matching subsection, heading included", () => {
  const slice = sliceForSpeaker(MD, "Jane Doe");
  assert.match(slice, /^### Dr\. Jane Doe/);
  assert.match(slice, /not close to a wall/);
  assert.doesNotMatch(slice, /John Smith/);
  assert.doesNotMatch(slice, /stray section/);
});

test("last subsection ends at the next ## heading", () => {
  const slice = sliceForSpeaker(MD, "John Smith");
  assert.match(slice, /Compute is the bottleneck/);
  assert.doesNotMatch(slice, /Notable quotes/);
});

test("matching is case-insensitive, honorific-stripped, token-subset both ways", () => {
  assert.ok(sliceForSpeaker(MD, "jane doe"));
  assert.ok(sliceForSpeaker(MD, "Jane"));                 // tracked subset of heading
  assert.ok(sliceForSpeaker(MD, "Dr. Jane Doe"));
  const shortHeading = MD.replace("### Dr. Jane Doe", "### Jane");
  assert.ok(sliceForSpeaker(shortHeading, "Jane Doe"));   // heading subset of tracked
});

test("null when no section, no match, or junk input", () => {
  assert.equal(sliceForSpeaker("# Solo video\n\n## Notable quotes\n- hi", "Jane Doe"), null);
  assert.equal(sliceForSpeaker(MD, "Nobody Here"), null);
  assert.equal(sliceForSpeaker("", "Jane"), null);
  assert.equal(sliceForSpeaker(null, "Jane"), null);
  assert.equal(sliceForSpeaker(MD, ""), null);
});
```

- [ ] **Step 2: Run `node --test`.** Expected: new file FAILS (module not found); rest pass.

- [ ] **Step 3: Create `backend/summarise/speaker-section.js`:**

```js
// Slice one speaker's subsection out of a summary's '## What each speaker
// argues' section (the prompt contract in the format-rethink spec). Pure and
// dependency-free apart from tags.js (also pure) — runs under bare `node`.
// Returns null rather than guessing: the caller falls back to the whole
// summary, which is the right answer for solo videos and flubbed sections.

import { normaliseSpeakers } from "./tags.js";

const SECTION_HEADING_RE = /^##\s+what each speaker argues\s*$/i;
const SUBSECTION_RE = /^###\s+(.+?)\s*$/;
const ANY_H2_RE = /^##\s/;

// Lowercased word tokens of a cleaned name. normaliseSpeakers strips
// honorifics and markdown junk; a name it rejects outright (rare) falls back
// to its raw tokens so matching still has something to work with.
function tokensOf(name) {
  const cleaned = normaliseSpeakers([name])[0] || String(name || "");
  return cleaned.toLowerCase().split(/\s+/).filter(Boolean);
}

// "Andrej" matches "Andrej Karpathy" and vice versa: one side's tokens must
// all appear in the other's.
function namesMatch(a, b) {
  const ta = tokensOf(a);
  const tb = tokensOf(b);
  if (ta.length === 0 || tb.length === 0) return false;
  const setA = new Set(ta);
  const setB = new Set(tb);
  return ta.every((t) => setB.has(t)) || tb.every((t) => setA.has(t));
}

export function sliceForSpeaker(markdown, name) {
  const lines = String(markdown || "").split("\n");
  const start = lines.findIndex((line) => SECTION_HEADING_RE.test(line));
  if (start === -1) return null;

  // The section runs to the next '## ' heading (or EOF).
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (ANY_H2_RE.test(lines[i])) { end = i; break; }
  }

  // Split the section into ### subsections and return the matching one.
  let matchFrom = -1;
  for (let i = start + 1; i <= end; i++) {
    const heading = i < end ? lines[i].match(SUBSECTION_RE) : null;
    if (matchFrom !== -1 && (i === end || heading)) {
      return lines.slice(matchFrom, i).join("\n").trim();
    }
    if (heading && namesMatch(heading[1], name)) matchFrom = i;
  }
  return null;
}
```

- [ ] **Step 4: Run `node --test`.** Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add backend/summarise/speaker-section.js backend/summarise/speaker-section.test.mjs
git commit -m "feat: pure slicer for the per-speaker summary section

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Person research merges onto the summaries table

**Files:**
- Modify: `backend/summarise/people-pure.js` (`pickVideosToProcess`, `isStaleSummary`; delete `pickPendingVideos`)
- Modify: `backend/summarise/people-pure.test.mjs`
- Modify: `backend/summarise/people.js`

**Interfaces:**
- Consumes: `generateSummaryItem`, `getSummaryByUrl`, `putFreshSummary`, `putUpgradedSummary` (Task 3); `sliceForSpeaker` (Task 5); `canonicalUrlForId` (existing).
- Produces: `pickVideosToProcess(videoRows, missingSummaryIds) → row[]`; `isStaleSummary(row) → boolean`.

- [ ] **Step 1: Write the failing tests.** In `people-pure.test.mjs`, replace the `pickPendingVideos` case with:

```js
import { pickVideosToProcess, isStaleSummary } from "./people-pure.js"; // merge into the existing import

test("pickVideosToProcess: pending rows plus done rows missing a summary", () => {
  const rows = [
    { videoId: "a", status: "pending" },
    { videoId: "b", status: "done" },
    { videoId: "c", status: "done" },
    { videoId: "d", status: "error" },
    null,
  ];
  assert.deepEqual(
    pickVideosToProcess(rows, ["c", "zzz"]).map((v) => v.videoId),
    ["a", "c"],
  );
  assert.deepEqual(pickVideosToProcess(rows, []).map((v) => v.videoId), ["a"]);
  assert.deepEqual(pickVideosToProcess(null, null), []);
});

test("isStaleSummary: absent or older promptVersion is stale", () => {
  assert.equal(isStaleSummary(null), true);
  assert.equal(isStaleSummary({}), true);
  assert.equal(isStaleSummary({ promptVersion: 1 }), true);
  assert.equal(isStaleSummary({ promptVersion: PROMPT_VERSION }), false);
  assert.equal(isStaleSummary({ promptVersion: PROMPT_VERSION + 1 }), false);
});
```

(Add `import { PROMPT_VERSION } from "./constants.js";` to the test file.)

- [ ] **Step 2: Run `node --test`.** Expected: people-pure cases FAIL (missing exports).

- [ ] **Step 3: Edit `people-pure.js`.** Replace `pickPendingVideos` with:

```js
import { PROMPT_VERSION } from "./constants.js";

// Video rows a person job still has to process: pending ones, plus done rows
// whose video has no summaries-table row at all (researched under the
// pre-merge pipeline, which never wrote one — they self-heal here). The
// runner looks up which done rows lack a summary and passes the ids in, so
// this stays pure. A stale-but-present summary is NOT in this set: it
// upgrades only when its video is being processed anyway.
export function pickVideosToProcess(videoRows, missingSummaryIds) {
  const missing = new Set(missingSummaryIds || []);
  return (videoRows || []).filter(
    (v) => v && (v.status === "pending" || (v.status === "done" && missing.has(v.videoId))),
  );
}

// A summaries row written by an older SYSTEM_PROMPT revision (or before
// promptVersion existed). Only person jobs act on staleness — the web
// cache-hit path serves stale rows as-is, because someone is waiting.
export function isStaleSummary(row) {
  return !row || !(row.promptVersion >= PROMPT_VERSION);
}
```

(The `import` line goes at the top of the file; the module header comment's "dependency-free" claim stays true — constants.js is equally pure.)

- [ ] **Step 4: Run `node --test`.** Expected: people-pure passes; nothing else imports `pickPendingVideos` except `people.js`, which is next.

- [ ] **Step 5: Rework `people.js`.**
  - Imports: delete `MEDIA_RESOLUTION_LOW, fpsForDuration` from the constants import (keep `DEFAULT_MODEL`); delete the `videoIdFrom` import, replace with `import { canonicalUrlForId } from "./youtube-url.js";`; delete the `generateWithFallback` import; in the people-pure import replace `pickPendingVideos` with `pickVideosToProcess`; add `import { generateSummaryItem, getSummaryByUrl, putFreshSummary, putUpgradedSummary } from "./summarise-core.js";` and `import { sliceForSpeaker } from "./speaker-section.js";` and add `isStaleSummary` to the people-pure import. Keep `getVideoMetadata`/`searchVideosByPerson` (search phase unchanged).
  - Delete `VIDEO_PROMPT` (lines 29–42), `buildVideoContents` (162–170), `summariseVideo` (172–196).
  - Add in their place:

```js
// One summaries-table row for this video, current prompt version: reuse it if
// it is already there and current (no Gemini call at all — the whole point of
// the merge), otherwise watch the video once through the shared core and
// write. A stale row is upgraded in place, preserving its feed position; a
// fresh row races politely with any concurrent writer. Throws when the model
// chain is exhausted — the caller marks the video row as errored.
async function summaryRowForVideo(ai, video, modelChain) {
  const canonicalUrl = canonicalUrlForId(video.videoId);
  const existing = await getSummaryByUrl(canonicalUrl);
  if (existing && !isStaleSummary(existing)) return existing;

  // Nobody is waiting on a person job, so unlike the request path it is
  // patient: several tries per model, backoff with jitter, and a timeout so a
  // hung call cannot eat the run.
  const outcome = await generateSummaryItem(ai, canonicalUrl, modelChain, {
    attempts: MAX_RETRIES_PER_MODEL,
    backoffMs: (attempt) => backoffDelayMs(attempt) + Math.floor(Math.random() * 1000),
    timeoutMs: VIDEO_CALL_TIMEOUT_MS,
    logLabel: `personVideo ${video.videoId}`,
  });
  if (!outcome.ok) throw outcome.error || new Error("summariseVideo: all models exhausted");

  if (existing) return putUpgradedSummary(outcome.item, existing);
  const { item } = await putFreshSummary(outcome.item);
  return item;
}
```

  - In `runPersonJob`, replace the loop header block (lines 363–368). After `const videos = await loadPersonVideos(person);` and the `total`/`doneCount`/`failures` lines, insert the self-heal lookup and switch the loop source:

```js
    // Self-heal set: done rows from the pre-merge pipeline have person-video
    // markdown but no summaries-table row — one GetItem each (≤ MAX_VIDEOS).
    const missingSummaryIds = [];
    for (const v of videos) {
      if (v.status !== "done") continue;
      if (!(await getSummaryByUrl(canonicalUrlForId(v.videoId)))) missingSummaryIds.push(v.videoId);
    }

    for (const video of pickVideosToProcess(videos, missingSummaryIds)) {
```

  - Replace the loop's try block (lines 381–386) with:

```js
      try {
        const row = await summaryRowForVideo(ai, video, modelChain);
        const slice = sliceForSpeaker(row.markdown, displayName) ?? row.markdown;
        await updateVideoRow(person, video.videoId, {
          status: "done", markdown: slice, model: row.model, summarisedAt: Date.now(),
        });
        if (video.status !== "done") doneCount++; // a self-healed row was already counted
      } catch (err) {
```

    (The catch block stays as-is — a failed self-heal flips that row to `error`; the next research run's `retryStale` resets it to pending, same convergence as any failed video.)
  - In `META_PROMPT` (lines 44–60), after the `markdown` bullet list add one line to the prompt text:

```
The summaries may include other speakers' content; attribute to ${displayName} only what they themselves say.
```

    (Place it as its own paragraph before `Respond with JSON only`.)

- [ ] **Step 6: Run `node --test`.** Expected: all pass. Also `grep -n "pickPendingVideos\|VIDEO_PROMPT\|buildVideoContents\|summariseVideo" backend/summarise/*.js` → only the `summariseVideo:` string inside the error message in `summaryRowForVideo`.

- [ ] **Step 7: Commit**

```bash
git add backend/summarise/people.js backend/summarise/people-pure.js backend/summarise/people-pure.test.mjs
git commit -m "feat: person research shares one summary per video with the main table

Per video: reuse a current summaries row for free, upgrade a stale one in
place (feed position preserved), or watch once through the shared core.
Done rows with no summaries row self-heal on the person's next run. The
meta-prompt warns against attributing other speakers' content.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: People cards link to the full summary

**Files:**
- Modify: `src/pages/People.jsx:123-136`

**Interfaces:**
- Consumes: `summaryPath(item)` from `src/paths.js` (works on the row's `youtu.be` url via `videoIdFrom`), `linkClick(e, href)` from `src/useLocation.js`.

- [ ] **Step 1:** Add imports to `People.jsx`:

```js
import { linkClick } from '../useLocation.js';
import { summaryPath } from '../paths.js';
```

- [ ] **Step 2:** In the video-card JSX, insert a "Full summary →" link between the `channelTitle` span (line 128) and the `<details>` block (line 129):

```jsx
              <span className="history-url">{v.channelTitle}</span>
              {v.url && (
                <a
                  className="history-url"
                  href={summaryPath({ url: v.url })}
                  onClick={(e) => linkClick(e, summaryPath({ url: v.url }))}
                >
                  Full summary →
                </a>
              )}
              {v.markdown && (
```

  (The title keeps linking to YouTube; the slice stays in `<details>`. Legacy rows 404 on this link until their person self-heals — accepted as transitional, per the merge spec decision 10.)

- [ ] **Step 3:** Run `node --test` (unchanged, expected green) and `make build` (or `docker compose run --rm node npm run build` — requires Docker) to confirm the JSX compiles. If Docker is unavailable, `npx vite build` from the repo root only if a local node_modules exists — otherwise defer the build check to Task 8's verification.

- [ ] **Step 4: Commit**

```bash
git add src/pages/People.jsx
git commit -m "feat: People video cards link to the shared full summary

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: Bookkeeping docs + CLAUDE.md

**Files:**
- Modify: `docs/BACKLOG.md`, `docs/CHANGELOG.md`, `docs/DECISIONS.md`, `CLAUDE.md`

- [ ] **Step 1: `docs/BACKLOG.md`** — delete the two `## Next` lines (person-research merge; Gemma/structured output). Append to `## Later`:

```
- `callMeta` in `people.js` still extracts its meta-summary JSON with a regex — now that every allowed model is Gemini, it could use `responseSchema` like the summarise path (`backend/summarise/people.js:200`)
```

Append to `## Won't do`:

```
- Channel-name hints in the text-only speaker extractor, a known-person hint during research, and a backfill re-tagging empty historical `speakers[]` — declined in the merge-spec design review (prompt hints only); the extractor itself was deleted with the trailer contract
```

- [ ] **Step 2: `docs/CHANGELOG.md`** — under `## Unreleased` add:

```
- Summaries now replace watching instead of triaging: a numbered claim ledger with reasoning, numbers and timestamps, per-speaker sections (or notable quotes for solo videos), and no more Signal-to-Noise/Clickbait scores.
- Person research and regular summaries now share one summary per video: researched videos appear in History with speaker tags, already-summarised videos are reused instead of paid for twice, and People video cards link to the full summary.
- Gemma models are gone from the model list; titles and speaker tags now come from structured model output, which makes them reliable instead of best-effort scraping.
```

- [ ] **Step 3: `docs/DECISIONS.md`** — prepend three entries (newest first, ≤10 lines each), and mark the superseded one:

Entry A:

```markdown
## 2026-07-31 — Gemini-only, structured output instead of the speaker trailer

**Context:** The trailer contract existed solely because the model chain could in theory fall back to Gemma, which lacks `responseSchema` — but five Gemini models fill the 4-slot chain, so Gemma was unreachable except hand-picked.
**Options:** Keep the trailer; keep Gemma reachable by raising `MAX_MODEL_ATTEMPTS`; go Gemini-only with `responseSchema`.
**Choice:** Gemini-only. Every summarise call requests `{ title, markdown, speakers[] }` via `responseSchema` (`summary-schema.js`); a payload that fails to parse is classified retryable ("empty response") and advances the chain. Deleted: `speakers.js`, `extractTitle`, the trailer parse/strip, the backfill's speakers pass. `@google/genai` pinned to 1.50.1.
**Consequences:** Loses the hand-picked free-tier quota escape hatch. `markdown` keeps its `# Title` heading (the UI renders only markdown). Supersedes the 2026-07-29 "Speaker tags ride on a prompt contract" entry.
```

Entry B:

```markdown
## 2026-07-31 — Summaries replace watching: the claim ledger format

**Context:** `SYSTEM_PROMPT` was optimised for triage (word caps, Signal-to-Noise, Clickbait scores) but the summaries are read instead of watching.
**Options:** Thematic sections (closest to today); a narrative brief (best read, least skimmable); a numbered claim ledger.
**Choice:** The ledger — `## Claims`, every substantive claim with reasoning, numbers, caveats and a timestamp link, scaled to content with no fixed cap. Kept: `# Title`, The Bottom Line (≤100 words, feeds the 300-char preview), 3 Aha! bullets. Dropped: the metrics. Multi-speaker videos add `## What each speaker argues`; solo videos add `## Notable quotes`.
**Consequences:** Output length scales with density (minor next to video-ingestion tokens). Nothing parses `## Claims`. `PROMPT_VERSION = 2` describes this text; any prompt edit bumps it.
```

Entry C:

```markdown
## 2026-07-31 — One summary per video across both pipelines

**Context:** Person research watched videos into its own `yt2txt-people-videos` rows — invisible to history, untagged, and paying video-ingestion tokens even when a summary already existed.
**Options:** Keep two pipelines; person-specific prompt with a summaries-table write; one shared prompt/core with per-person slices.
**Choice:** Shared core (`summarise-core.js`) + cached slices: person jobs reuse a current summaries row for free, upgrade a stale one in place (createdAt/date preserved, invisible to the feed), and store `sliceForSpeaker(markdown) ?? whole markdown` per person. Done rows with no summaries row self-heal on the next run; a `PROMPT_VERSION` bump alone never triggers set-wide re-watches. Races cost a duplicate watch — accepted, no locks.
**Consequences:** Researched videos appear in history with tags; a video is watched at most once per prompt version per path-winner. The web cache-hit path never upgrades.
```

Also edit the 2026-07-29 trailer entry's heading line to:

```markdown
## 2026-07-29 — Speaker tags ride on a prompt contract, not a response schema (superseded 2026-07-31)
```

- [ ] **Step 4: `CLAUDE.md`** — update every statement the branch falsified. Precisely:
  - **Backend section, POST bullet:** now: canonicalise → summarise via the shared core with structured output `{ title, markdown, speakers[] }` + model fallback; mention `summarise-core.js` as the shared pipeline both entries call.
  - **Speaker-tag modules block:** replace with: `tags.js` (name normalisation only), `summary-schema.js` (schema + parse), `speaker-section.js` (slicer); note `speakers.js` and the trailer are gone.
  - **"Speaker tags ride on a prompt contract" bite:** rewrite — speakers/title come from `responseSchema` structured output; a failed parse reads as an empty response and advances the model chain; empty `speakers` is still a valid outcome; the old contract was superseded 2026-07-31 (all allowed models are Gemini now).
  - **"Allowed-model list is dynamic" bite:** the machinery lives in `models.js` (not handler.js); Gemini Flash-family only; `FALLBACK_MODELS`/`FALLBACK_MODEL_OPTIONS` are Gemma-free.
  - **backfill bullets:** three passes (canonical key, index key, video meta); no `model` option; result counts lose `speakersUpdated`; no Gemini client.
  - **People-research bullets:** person jobs reuse/write `yt2txt-summaries` through the shared core (`promptVersion` staleness, upgrade preserves `createdAt`/`date`, missing-only self-heal); `yt2txt-people-videos.markdown` holds the person's slice; People cards link to `/summary/<id>`.
  - **`make test` bullet:** the suite is now nine test files (`share`, `tags`, `people-pure`, `media-pure`, `backfill-pure`, `dispatch-pure`, `gemini`, `youtube-url`, `summary-schema`, `speaker-section` — list them or say "the `*.test.mjs` files"); keep the no-path-arguments warning.
  - **Architecture GET ?video= bullet:** drop the stale "falling back to a filtered Scan" clause (the code has no Scan fallback).
  - **Summary-row shape sentence:** add `promptVersion` to the attribute list, noting it is internal like `gsi1pk`.

- [ ] **Step 5: Run `node --test`** (docs only — expected green), then commit:

```bash
git add docs/BACKLOG.md docs/CHANGELOG.md docs/DECISIONS.md CLAUDE.md
git commit -m "docs: bookkeeping for the structured-output + merge branch

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: Verification + PR

- [ ] **Step 1:** `make test` (Docker must be up) — the canonical run. Expected: 0 failures.
- [ ] **Step 2:** `make build` — Vite production build must succeed (proves the JSX/import graph, including `src/` importing up into `backend/summarise/`).
- [ ] **Step 3:** Re-read the three specs' Design sections against `git diff main --stat`; confirm every spec item maps to a commit (superpowers:verification-before-completion).
- [ ] **Step 4:** Push and open the PR:

```bash
git push -u origin claude/structured-summaries-merge
gh pr create --title "Structured output, replace-watching summaries, person-research merge" --body "<summary of the three specs, commit map, test evidence>

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

---

## Self-review notes

- Spec coverage: models filter (T1), schema/parse/retry (T2), prompt + core + hint + PROMPT_VERSION + pin (T3), deletions incl. backfill (T4), slicer (T5), people merge + self-heal + meta sentence (T6), frontend link (T7), bookkeeping (T8). The merge spec's §2 write semantics live in T3's `putFreshSummary`/`putUpgradedSummary`; its §5 flow in T6.
- Deliberately not done: no new tests for `models.js`/`handler.js`/`people.js`/`backfill.js` (not importable under bare node — see Global Constraints); no `callMeta` schema (backlogged).
- Type consistency spot-checks: `generateSummaryItem` returns `{ ok, item|error }` and is consumed with exactly that shape in T3 Step 3 and T6 Step 5; `pickVideosToProcess(videoRows, missingSummaryIds)` matches T6 Steps 1/3/5; `sliceForSpeaker(markdown, name)` matches T5/T6.
