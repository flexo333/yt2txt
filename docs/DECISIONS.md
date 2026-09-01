# Decisions

Non-obvious technical choices — a dependency, a schema, a pattern, or an alternative that
was rejected — newest first. Each entry is date, context, options, choice, consequences,
in under ten lines. If a choice is obvious from reading the code, it does not belong here.

The five entries below were reconstructed on 2026-07-30 from the code and from CLAUDE.md,
and dated to the commit that shipped each choice rather than to the day it was argued.

## 2026-09-01 — Timestamp links seek an embedded player via bare postMessage

**Context:** Timestamp links (`[HH:MM:SS](…?t=SECONDS)`) previously opened YouTube in a new tab, leaving the summary.
**Options:** Load YouTube's IFrame Player API script (adds a third-party script + async ready callback); postMessage directly to an `enablejsapi=1` `youtube-nocookie.com` iframe (no extra dependency, hand-roll the `listening`/`onReady`/`seekTo` handshake); no embed at all.
**Choice:** Facade-first embed (thumbnail only until clicked — no player, scripts or cookies; the `i.ytimg.com` request itself stays, sent with `no-referrer`) + bare postMessage. First click mounts the iframe with `start=` baked in (no round-trip); later timestamp clicks need the `onReady` handshake first, so seeks before that are queued.
**Consequences:** No new dependency, but the handshake is hand-maintained if YouTube changes its message contract. If a video has embedding disabled by the uploader, the iframe shows YouTube's own "watch on YouTube" fallback inside the frame — clicking a timestamp still posts to it (silently a no-op) rather than falling back to opening a new tab; not handled specially here.

## 2026-08-01 — Regenerate is a flag on POST, written as an upgrade

**Context:** A stored summary is occasionally bad or stale, and the URL-keyed dedupe means re-submitting the video returns the cached row forever.
**Options:** A `regenerate: true` flag on the existing `POST { url, model }`; a new dispatch action; delete the row then re-POST.
**Choice:** The flag. It reuses canonicalisation, model validation and the model chain, and writes through the pre-existing `putUpgradedSummary()` — so a regenerated row keeps its `createdAt`/`date` (history order undisturbed) and keeps known-good metadata when the fresh lookup fails. Delete-then-POST would have needed `DeleteItem` on the web role and left a window with no row.
**Consequences:** The old summary is only ever replaced by a successful generation — a failed retry costs nothing. Regeneration uses the app's currently selected model, not the row's stored one; the frontend replaces the history row in place instead of moving it to the top.

## 2026-07-31 — Gemini-only, structured output instead of the speaker trailer

**Context:** The trailer contract existed solely because the model chain could in theory fall back to Gemma, which lacks `responseSchema` — but five Gemini models fill the 4-slot chain, so Gemma was unreachable except hand-picked.
**Options:** Keep the trailer; keep Gemma reachable by raising `MAX_MODEL_ATTEMPTS`; go Gemini-only with `responseSchema`.
**Choice:** Gemini-only. Every summarise call requests `{ title, markdown, speakers[] }` via `responseSchema` (`summary-schema.js`); a payload that fails to parse is classified retryable ("empty response") and advances the chain. Deleted: `speakers.js`, `extractTitle`, the trailer parse/strip, the backfill's speakers pass. `@google/genai` pinned to 1.50.1.
**Consequences:** Loses the hand-picked free-tier quota escape hatch. `markdown` keeps its `# Title` heading (the UI renders only markdown). Supersedes the 2026-07-29 "Speaker tags ride on a prompt contract" entry.

## 2026-07-31 — Summaries replace watching: the claim ledger format

**Context:** `SYSTEM_PROMPT` was optimised for triage (word caps, Signal-to-Noise, Clickbait scores) but the summaries are read instead of watching.
**Options:** Thematic sections (closest to today); a narrative brief (best read, least skimmable); a numbered claim ledger.
**Choice:** The ledger — `## Claims`, every substantive claim with reasoning, numbers, caveats and a timestamp link, scaled to content with no fixed cap. Kept: `# Title`, The Bottom Line (≤100 words, feeds the 300-char preview), 3 Aha! bullets. Dropped: the metrics. Multi-speaker videos add `## What each speaker argues`; solo videos add `## Notable quotes`.
**Consequences:** Output length scales with density (minor next to video-ingestion tokens). Nothing parses `## Claims`. `PROMPT_VERSION = 2` describes this text; any prompt edit bumps it.

## 2026-07-31 — One summary per video across both pipelines

**Context:** Person research watched videos into its own `yt2txt-people-videos` rows — invisible to history, untagged, and paying video-ingestion tokens even when a summary already existed.
**Options:** Keep two pipelines; person-specific prompt with a summaries-table write; one shared prompt/core with per-person slices.
**Choice:** Shared core (`summarise-core.js`) + cached slices: person jobs reuse a current summaries row for free, upgrade a stale one in place (createdAt/date preserved, invisible to the feed), and store `sliceForSpeaker(markdown) ?? whole markdown` per person. Done rows with no summaries row self-heal on the next run; a `PROMPT_VERSION` bump alone never triggers set-wide re-watches. Races cost a duplicate watch — accepted, no locks.
**Consequences:** Researched videos appear in history with tags; a video is watched at most once per prompt version per path-winner. The web cache-hit path never upgrades.

## 2026-07-30 — Fork `pulumi-static-site` to unblock pulumi-aws 7.x

**Context:** An `AuthType: NONE` Function URL needs a second policy statement, `lambda:InvokeFunction` conditioned on `lambda:InvokedViaFunctionUrl`. Expressing it needs `invoked_via_function_url` on `aws.lambda_.Permission`, which landed in pulumi-aws **7.16.0** — absent from 6.x (which ended at 6.83.4) and from 7.0–7.15. `pulumi-static-site` v0.1.0 pins `pulumi-aws<7.0.0`, so pip could not resolve the bump.
**Options:** Add the statement out-of-band via `pulumi_command.local.Command` wrapping `aws lambda add-permission`; grant `lambda:InvokeFunction` with `principal="*"` and no condition, which works on 6.x; fork `pulumi-static-site` and widen its pin.
**Choice:** Fork it — [`flexo333/pulumi-static-site@v0.2.0`](https://github.com/flexo333/pulumi-static-site) widens the pin to `pulumi-aws>=6.0.0,<8.0.0` and changes nothing else — then move this repo to `pulumi-aws>=7.16.0,<8.0.0`. The unconditioned grant was rejected outright: it would give the whole internet direct Invoke-API access, bypassing the Function URL, which is a materially wider grant than the one being fixed.
**Consequences:** The static-site component is now ours to keep current against upstream. The provider moves a major version across the whole stack — the v7 diffs are cosmetic (`+region`, `+tagsAll`) and the 7.0 migration guide lists no breaking changes for IAM, Route53, ACM, CloudFront or Lambda, but they touch every resource, so the apply wants a real preview rather than a rubber stamp. Note `>=7.0` is *not* a sufficient floor, and pulumi/pulumi-aws#5930 is still open despite the feature having shipped — trust the wheel, not the tracker.

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

## 2026-07-29 — Speaker tags ride on a prompt contract, not a response schema (superseded 2026-07-31)

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
