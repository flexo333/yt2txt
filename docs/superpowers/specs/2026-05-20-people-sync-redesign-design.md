# People research — synchronous chunked redesign — design

- **Date:** 2026-05-20
- **Status:** Approved
- **Replaces:** the Gemini Batch API implementation introduced in commit `0d81ec8`
  (`feat: use Gemini Batch API for person research`).

## Problem

The "People" research feature has never worked since commit `0d81ec8` (2026-04-24)
rewrote it from synchronous Gemini calls onto the **Gemini Batch API**. The project's
`GEMINI_API_KEY` is on the **free tier**; the Batch API is **paid-tier only**. Every
`ai.batches.create()` call is rejected — `429 RESOURCE_EXHAUSTED` in April 2026,
`400 FAILED_PRECONDITION` ("Precondition check failed.") as of May 2026. The live
`yt2txt-people` table confirms it: not one record carries a `batchName` — no batch has
ever been accepted. The only successful research ever (Andrej Karpathy, 2026-04-23) ran
on the **pre-batch synchronous** version.

This redesign restores synchronous summarisation, but improves on the original sync
version (`6814b34`) so it no longer risks the two failure modes that motivated the batch
switch: **Lambda timeouts** and **API rate limits**.

The original sync version summarised up to 6 videos in one Lambda invocation with 60s
sleeps between calls. The Karpathy run took ~13 minutes — already close to the 900s
(15-minute) Lambda ceiling. Eight videos would routinely exceed it.

## Decisions taken during brainstorming

- **Approach: chunked self-invoke continuation.** A resumable worker summarises videos
  one at a time and self-invokes a continuation before it runs out of Lambda time.
  Considered and rejected: a tick-driven worker (added latency tied to the 3-min
  schedule) and single-invocation tuning (still races the 900s ceiling — does not
  structurally fix the timeout class of bug).
- **Latency target:** progressive — the person page fills in video by video, whole job
  done in roughly 3-10 minutes. Matches the existing async UX.
- **Coverage:** ~8 videos per run (`MAX_VIDEOS = 8`). With the chunked design the video
  count no longer threatens the timeout.
- **Concurrency:** strictly sequential, one video at a time. No parallelism.
- **Meta-summary failure:** mark the person `done` with an empty `meta` (not `error`).
  The per-video summaries are still valuable on their own. A `metaError` string is
  recorded on the row so the gap is not silent.

## Architecture — one worker, three triggers

A single idempotent, resumable routine — `runPersonJob({ person }, context)` — drives
all person research. It is invoked three ways:

| Trigger | Payload | When |
|---|---|---|
| Initial request | `{ __personJob: true, person }` | `researchPerson` self-invokes after writing the `queued` row |
| Continuation | `{ __personJob: true, person }` | the worker self-invokes when it is low on Lambda time |
| Safety net | `{ __resumeJobs: true }` | the EventBridge tick finds a stalled job and self-invokes a continuation for it |

`handler` becomes `handler(event, context)` — `context` is needed for
`context.getRemainingTimeInMillis()`. The `__pollBatches` dispatch branch is replaced by
a `__resumeJobs` branch.

## The worker routine

`runPersonJob` runs three phases per invocation, skipping any already complete.
Idempotency is keyed on the person `status` and on which video rows are still `pending`,
so any invocation can safely resume a partially-done job.

1. **Increment guard.** Increment `continuationCount` on the person row. If it exceeds
   `MAX_CONTINUATIONS` (12), set status `error` ("exceeded continuation budget") and
   return. This bounds the total Lambda invocations a single job can consume.

2. **Search phase** — runs only when status is `queued`:
   - Set status `running`, `startedAt`, `progress = { phase: "searching" }`.
   - `searchVideosByPerson` → candidates; dedupe against already-`done` videos and
     include stale-row retries (unchanged from current logic).
   - `getVideoMetadata` for the fresh set; write up to `MAX_VIDEOS` new video rows with
     `status: "pending"`.
   - Set `progress = { phase: "summarising", current: <doneCount>, total: <rowCount> }`.
   - Status is now `running`; continuations skip this phase.
   - If there are no videos at all (search empty, nothing pending) → go straight to
     finalise.

3. **Summarise phase** — for each video row with `status: "pending"`:
   - **Before starting**, check `context.getRemainingTimeInMillis()`. If it is below
     `VIDEO_TIME_RESERVE_MS` (210s) and pending videos remain → self-invoke a
     continuation (`{ __personJob, person }`), bump `lastProgressAt`, and return.
   - Otherwise summarise the video via `summariseVideo()` (see below). Persist the row
     as `done` + `markdown` + `model`, or `error` + `errorMessage`.
   - After each video, update the person row: `progress.current`, `progress.currentTitle`
     (the title in flight, cleared when idle), `progress.failures`, and `lastProgressAt`.

4. **Finalise phase** — when no `pending` video rows remain:
   - If `getRemainingTimeInMillis()` is below `META_TIME_RESERVE_MS` (120s) → self-invoke
     a continuation and return (the continuation will skip search, find nothing pending,
     and re-enter finalise).
   - Set status `finalising`.
   - Load all video rows that have `markdown`; if any, run `generateMeta` (with the model
     fallback chain). On success, set status `done` with `meta`, `lastRunAt`, and final
     `progress`. On failure after the chain is exhausted, set status `done` with an empty
     `meta` and a `metaError` string.
   - If there were zero summarised videos, status `done` with empty `meta` (unchanged
     from current behaviour).

## Time budget & loop safety

- Lambda timeout stays 900s, memory 256MB (no Pulumi change).
- `VIDEO_CALL_TIMEOUT_MS = 180_000` — per-video summary calls are bounded by an
  `AbortController` (or a `Promise.race` timeout if the SDK does not surface an abort
  signal cleanly). A call that overruns is treated as a retryable error.
- `VIDEO_TIME_RESERVE_MS = 210_000` — a video is only started if remaining Lambda time
  exceeds this (one worst-case 180s call plus margin to persist and self-invoke).
- `META_TIME_RESERVE_MS = 120_000` — guard before the meta call.
- `MAX_CONTINUATIONS = 12` — a job needs ~1-4 invocations normally; 12 is comfortable
  headroom and a hard stop for a runaway self-invoke loop.
- Sequential calls take 60s+ each, so request-per-minute limits are a non-issue; the 60s
  inter-call sleep from the original sync version is **removed entirely**. Bursts are
  handled by per-call backoff instead.

## Per-video resilience — `summariseVideo()`

Each video summary walks a **model fallback chain**: the person's chosen model first,
then the rest of the allowed-model list, capped at 4 attempts (mirroring `handler.js`'s
`buildModelChain` / `MAX_MODEL_ATTEMPTS`). The allowed-model list is fetched once by
`handler.js` (which already has the cached `getAllowedModels()`) and passed into
`runPersonJob` — avoiding a circular import between `handler.js` and `people.js`.

Per model in the chain: up to `MAX_RETRIES_PER_MODEL` (3) attempts with exponential
backoff plus jitter on a **retryable** error (HTTP 429 / 503 / 500, or a message
containing `resource_exhausted`, `quota`, `rate limit`, `unavailable`, `overloaded`,
`high demand`, or a call-timeout). A non-retryable error advances to the next model
immediately. Chain exhausted → `summariseVideo` throws; the caller marks that one video
`error` and the job continues. **One bad video never fails the whole person.**

## Data model

DynamoDB is schemaless — no table definitions change in Pulumi.

**`yt2txt-people`** (hash `person`):
- **Add:** `lastProgressAt` (number; bumped on every video completion and every
  self-invoke — drives stall detection), `continuationCount` (number; loop guard),
  `metaError` (string; present only when meta synthesis failed on a `done` person).
- **Remove:** `batchName`, `batchKeys`, `batchSubmittedAt`, `lastPolledAt`,
  `lastPollError`.
- **Status enum:** `queued → running → finalising → done | error` (no `batch_pending`).
- **`progress`:** `{ phase: "searching" | "summarising" | "finalising" | "done",
  current, total, currentTitle?, failures? }`.

**`yt2txt-people-videos`** (hash `person`, sort `videoId`):
- **Status enum:** `pending | done | error` (renamed from `batch_pending`).

## The safety-net resumer — `resumeStalledJobs()`

Invoked by the EventBridge tick (`{ __resumeJobs: true }`). Scans `yt2txt-people` for
status in `{ queued, running, finalising }`. For each row, if
`now - (lastProgressAt || startedAt || queuedAt)` exceeds `STALL_THRESHOLD_MS`
(600_000 — 10 minutes), it self-invokes a continuation (`{ __personJob, person }`).

A healthy job bumps `lastProgressAt` at least every ~180s, far inside the 600s
threshold, so the resumer only ever fires for a job whose Lambda genuinely died
(out-of-memory, crash, or a self-invoke `InvokeCommand` that failed to send). Recovery
latency is roughly one tick after the threshold (~10-13 minutes) — acceptable for a rare
crash. AWS's built-in async-invocation retries are a bonus second layer of defence.

The EventBridge rule keeps its 3-minute cadence (cheap — a status-filtered scan).

## Error handling

| Situation | Behaviour |
|---|---|
| YouTube search fails | person → `error` (nothing to summarise) |
| One video fails (model chain exhausted) | that video → `error`; job continues; counted in `progress.failures` |
| Per-video call overruns `VIDEO_CALL_TIMEOUT_MS` | treated as a retryable error (backoff, then next model) |
| Meta-summary fails (model chain exhausted) | person → `done` with empty `meta` + `metaError` string; video summaries kept |
| Lambda dies mid-job | `resumeStalledJobs()` self-invokes a continuation after the stall threshold |
| Continuation loop | `continuationCount > MAX_CONTINUATIONS` → person `error` |
| Two runs race the same person (e.g. `force` during a live run) | not strictly guarded; non-corrupting — writes are keyed on `person`/`videoId`, last-write-wins, worst case one wasted re-summary |

`researchPerson`'s busy-guard changes from `running | queued | batch_pending` to
`running | queued | finalising`. It writes the fresh `queued` row with
`continuationCount: 0`. `force: true` overrides the busy-guard and resets an existing
row the same way (`queued`, `continuationCount: 0`).

## Frontend

`src/pages/People.jsx` needs **no functional change**. It already polls `?person=` every
3s, treats only `done` / `error` as terminal, and renders `progress.phase current/total`
plus `progress.currentTitle` while `status === "running"`. It never references
`batch_pending`, so removing that state breaks nothing — the page fills in progressively
as the chunked worker persists each video.

Optional polish (not required): also render the progress line during `finalising`, and
show `metaError` as a soft note on a `done` person.

## Files

- **Create:** `backend/summarise/people-pure.js` — dependency-free pure helpers
  (`pickPendingVideos`, the time-budget predicate, `isStalled`, model-chain building)
  so the job logic is smoke-testable under local `node` without the runtime-provided
  AWS SDK.
- **Modify:**
  - `backend/summarise/people.js` — remove all batch code (`submitBatchWithFallback`,
    `pollPendingBatches`, `handleBatchResult`, `TERMINAL_STATES`, `FALLBACK_MODEL`,
    batch constants); add the chunked `runPersonJob`, `summariseVideo`,
    `resumeStalledJobs`, and time-budget logic. Keep `searchVideosByPerson` use and its
    dedupe/stale-retry logic, `getVideoMetadata`, `normalisePerson`, `getPerson`,
    `listPeople`, and the `VIDEO_PROMPT` / `META_PROMPT` text.
  - `backend/summarise/handler.js` — `handler(event, context)`; replace the
    `__pollBatches` branch with `__resumeJobs`; pass `context` and the cached
    allowed-model list into `runPersonJob`.
  - `infra/pulumi/__main__.py` — change the EventBridge rule's target `input` from
    `{"__pollBatches": true}` to `{"__resumeJobs": true}` and update its description.
    Resource names and the 3-minute cadence are unchanged.
  - `CLAUDE.md` — rewrite the People-research section: remove the Batch API description
    and the batch-specific "things that will bite you" entries; describe the synchronous
    chunked worker, the three triggers, and the new status enum.

## Migration

- **Orphaned video rows:** Demis Hassabis has ~8 `yt2txt-people-videos` rows stuck at
  `status: "batch_pending"`. One-time cleanup: delete those rows (via `awscli`), then
  re-run Demis. The new worker only acts on `status: "pending"`.
- **Batch-era person rows:** people left at `status: "error"` from the batch era need no
  migration — they are simply re-runnable. No person is currently stuck at
  `batch_pending`.

## Verification

No test framework or linter exists (per `CLAUDE.md`), and `handler.js` / `people.js`
cannot be imported by local `node` (they statically import the runtime-provided AWS SDK).
Verification mirrors the existing repo approach:

1. `node --check` on every modified `.js` file.
2. Smoke-test the pure helpers in `people-pure.js` with a small local `node` script:
   `pickPendingVideos` selects only `pending` rows; the time-budget predicate returns
   "continue" below the reserve and "proceed" above it; `isStalled` respects the
   threshold; the model chain puts the chosen model first and is capped at 4.
3. `make build` for the frontend.
4. **Deploy-time integration check:** after `make build-lambda` → `make infra-up` →
   `make deploy`, run a real person research (re-run Andrej Karpathy or Demis Hassabis)
   and confirm the person page fills in video by video and reaches `done` with a
   meta-summary. Confirm a second person can be researched without the first blocking it.
5. The continuation and resumer paths are verified by code review plus the deploy-time
   run — forcing a genuine mid-job Lambda timeout on demand is not practical.

## Deploy order

`make build-lambda` → `make infra-up` (packages the Lambda and updates the EventBridge
rule together) → `make deploy` (frontend; no functional change, rebuilds for
completeness).
