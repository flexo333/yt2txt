# Decisions

Non-obvious technical choices — a dependency, a schema, a pattern, or an alternative that
was rejected — newest first. Each entry is date, context, options, choice, consequences,
in under ten lines. If a choice is obvious from reading the code, it does not belong here.

The five entries below were reconstructed on 2026-07-30 from the code and from CLAUDE.md,
and dated to the commit that shipped each choice rather than to the day it was argued.

## 2026-07-30 — Two Lambdas over one code bundle

**Context:** A single function served both the public Function URL and three internally-invoked job types, so the public endpoint carried the worker's 900 s timeout and its write-everything IAM role.
**Options:** Leave it as one function; split into two functions sharing one archive; move the job types to Step Functions.
**Choice:** Two `aws.lambda_.Function` resources over the same archive — `web.handler` (300 s, read-mostly DynamoDB, may invoke only the worker) and `worker.handler` (900 s, full table access including `DeleteItem`, self-invoke).
**Consequences:** The magic-key branch leaves the request path entirely. Internal invokes must now resolve the worker by name: `WORKER_FUNCTION_NAME`, set by Pulumi on the web function, falling back to the runtime-injected `AWS_LAMBDA_FUNCTION_NAME` for the worker's own continuations. Never pass a function its own name via Pulumi — that is a circular dependency. Step Functions was left on the table (see `docs/BACKLOG.md` `## Won't do`).

## 2026-07-29 — The canonical `watch?v=` URL is the table key

**Context:** The table's hash key was the raw submitted URL, so `youtu.be/<id>`, a Shorts link and `watch?v=<id>&si=…` opened three rows for one video. `backfill.js` already grouped rows by extracted video id to work around it.
**Options:** Re-key the table on the bare 11-character video id; keep `url` as the key but canonicalise before every access; deduplicate on read.
**Choice:** Keep `url` as the key and canonicalise to `https://www.youtube.com/watch?v=<id>` before the dedupe `GetItem`, the item build and the race-loser re-read. DynamoDB cannot change a key schema, and the canonical URL bijects with the video id, so it carries the same uniqueness without a table migration.
**Consequences:** The canonicaliser and id extractor exist exactly once, in `backend/summarise/youtube-url.js` — dependency-free so the Lambda, the browser bundle and bare `node` all import it. Because the Lambda bundle is `backend/summarise/` alone, `src/` imports *up* into it and never the reverse. Existing rows needed the one-shot backfill; `findByVideoId()` is now a bare `GetItem` with no `Scan` fallback, so every row must sit at its canonical key.

## 2026-07-29 — Speaker tags ride on a prompt contract, not a response schema

**Context:** Summaries needed structured speaker names alongside free markdown.
**Options:** Gemini structured output via `responseSchema`; a trailing `Speakers: A, B` line in the prompt contract, parsed and stripped; a second text-only call per summary.
**Choice:** The prompt contract. The model chain falls back to Gemma when Flash models are rate-limited, and Gemma does not support `responseSchema` — a schema would fail exactly when the fallback is most needed.
**Consequences:** `handler.js` parses the trailer and strips it before storing, so tags are metadata and never rendered markdown. When a model ignores the contract entirely, a cheap text-only call re-reads the finished summary (`speakers.js`); it carries no video part, so `mediaResolution`/`videoMetadata` must stay off it. Every layer is best-effort — an empty `speakers` list is a valid outcome, not an error.

## 2026-07-29 — Throttle video tokens with LOW resolution and an fps ladder

**Context:** Gemini defaults to 1 fps at full resolution, roughly 300 tokens per second of video. A single 25-minute video therefore exceeds the 250k free-tier tokens-per-minute limit on its own.
**Options:** Pay for a higher tier; cap video length; reduce the tokens each video costs.
**Choice:** Every `generateContent` call carrying a video passes `mediaResolution: "MEDIA_RESOLUTION_LOW"` (258 → 66 tokens per frame) and a `videoMetadata: { fps }` picked by `fpsForDuration()` — ≤5 min → 1.0, ≤15 → 0.5, ≤45 → 0.2, else 0.1.
**Consequences:** Duration comes from `getVideoMetadata()`, best-effort — any failure, including a missing `YOUTUBE_API_KEY`, falls back to `DEFAULT_FPS`. Audio is still sampled at 1-second granularity whatever the fps, so if timestamp links start drifting the fix is to raise the ladder a step, not to abandon it.

## 2026-05-21 — People research on the synchronous Gemini API, not the Batch API

**Context:** A person's job summarises up to eight videos, each a real `generateContent` call, which can easily outlive even a 900 s Lambda.
**Options:** The Batch API, which is built for exactly this shape of work; synchronous calls in a chunked, resumable runner; a queue with one video per invocation.
**Choice:** Synchronous `ai.models.generateContent` per video, inside a runner that checks `context.getRemainingTimeInMillis()` before each video and self-invokes a continuation when time is short. The Batch API is paid-tier only and this project's key is free tier — `ai.batches.create()` fails `400 FAILED_PRECONDITION`.
**Consequences:** Per-video rows persist as they complete, so a resumed run only picks up what is still pending, and an EventBridge tick restarts jobs idle past a 10-minute stall threshold. Do not "optimise" this back onto the Batch API without first enabling billing on the Gemini project.
