# Merge person research onto one summary per video — design

**Date:** 2026-07-31
**Backlog item:** "Person research summarises videos into its own `yt2txt-people-videos` rows and never touches the summaries table, so those videos get no history row and no `speakers[]` tags, and a video already summarised is paid for twice" (`backend/summarise/people.js`, `backend/summarise/handler.js`).

## Problem

Two pipelines watch the same videos with different prompts and write to different tables:

- The regular POST path (`handler.js`) produces a general summary with `speakers[]` tags in `yt2txt-summaries`, feeding history and `/summary/<id>` permalinks.
- Person research (`people.js`) produces a person-focused analysis per `(person, videoId)` in `yt2txt-people-videos`, invisible to history, untagged, and paying video-ingestion tokens even when the video already has a summary.

Video ingestion is the dominant cost (free-tier TPM throttling is why `mediaResolution`/fps are already tuned); text-only calls over stored markdown are nearly free. Separately, `speakers[]` extraction fails when a solo speaker never says their own name — the model never sees the channel name, which usually identifies them.

## Decisions (made in design review)

1. **Per-video person notes keep verbatim-ish quotes with clickable timestamps.** Timestamps can only be captured while the model watches the video, so the video-ingesting call must extract them per speaker.
2. **One enriched prompt for all videos, both paths.** Every summary carries per-speaker material, so researching a person whose video is already summarised costs only a text parse — a video is watched at most once, ever.
3. **The per-speaker section is visible summary content**, not stripped metadata. No new parse-and-strip contract; the People page slices by heading.
4. **Stale rows are re-watched once and upgraded** when a person job touches them (detected via `promptVersion`), preserving `createdAt`. The web cache-hit path never upgrades — someone is waiting, and a stale row is still a fine general summary.
5. **Speaker-naming fix is prompt hints only**: channel/video title in the video prompt. Declined: hints in the text-only fallback extractor, a known-person hint during research, a backfill for empty historical tags (see Out of scope).
6. **Structure: shared summarise core + cached slices** (approach A). One prompt/call/parse/write pipeline; `yt2txt-people-videos.markdown` holds the person's slice so the UI and meta-synthesis are unchanged.

## Design

### 1. Enriched prompt

`SYSTEM_PROMPT` moves to the shared core. Its full text — including the `## What each speaker argues` section this spec's slicer depends on — is defined in `2026-07-31-summary-format-rethink-design.md`, which supersedes the insertion originally described here (the format was redesigned around a replace-watching claim ledger in the same review cycle; the per-speaker section, its heading, its ≤25-word bullets, and its name-consistency rule are unchanged).

The Speakers trailer keeps its slot as the final line, still parsed and stripped into `speakers[]` by `tags.js`.

The per-request text gains a hint block, included only when the YouTube metadata lookup succeeded:

> Channel: `<channelTitle>` / Video title: `<videoTitle>`. If a speaker never states their name, the channel name may identify them — use it only if it plausibly names a person; never invent a name.

`VIDEO_PROMPT`, `buildVideoContents`, and `summariseVideo` in `people.js` are deleted.

Cost: video ingestion unchanged; output growth under the new format is covered by the format-rethink spec (minor next to ingestion).

### 2. Shared core — `backend/summarise/summarise-core.js`

The middle of `handler.js`'s `summarise()` — build contents (fps ladder, hints), `generateWithFallback`, trailer parse/strip, speakers text-only fallback (`speakers.js`, unchanged), title extraction, item build — moves to a module both entry points call with their own patience:

- **Web POST** (`handler.js`): 1 attempt per model, no timeout, `throwOnNonRetryable` — as today. Keeps its dedupe `GetItem` → conditional `Put` → race re-read around the core call.
- **Person job** (`people.js`): `MAX_RETRIES_PER_MODEL`, backoff, `VIDEO_CALL_TIMEOUT_MS` — as today.

Writes to `yt2txt-summaries`:

- Fresh row: conditional `Put` (`attribute_not_exists(url)`); on `ConditionalCheckFailedException` re-read and adopt the winner's row (post-deploy, any concurrent writer produced an equally current row).
- Upgrade of a stale row: unconditional `Put`, preserving the old `createdAt` (history order holds); `markdown`, `title`, `date`, `model`, `speakers`, metadata fields refresh.

The worker Lambda already has `PutItem`/`GetItem` on the summaries table and the `DYNAMODB_TABLE` env var — no infra change.

### 3. Data model and staleness

- Summary rows gain `promptVersion` (constant `PROMPT_VERSION = 2` in `constants.js`; absent = version 1). Internal like `gsi1pk`: deliberately not added to `listRow()` or `summaryPayload()`.
- Stale predicate (pure, tested): `promptVersion` missing or `< PROMPT_VERSION`. Only person jobs act on it.
- `yt2txt-people-videos` keeps its exact shape. `markdown` now holds the person's slice; `model` records the model that produced the underlying summary (from the row when reused); `summarisedAt` set as today.

### 4. Slice parser — `backend/summarise/speaker-section.js`

Dependency-free pure module, smoke-tested by `speaker-section.test.mjs` under `make test`:

- `sliceForSpeaker(markdown, name)`: locate `## What each speaker argues`, split into `### <Name>` subsections, return the match.
- Tolerant matching: case-insensitive, honorifics stripped (reusing `tags.js` helpers — pure-to-pure import), token-subset matching in both directions ("Andrej" heading matches tracked "Andrej Karpathy" and vice versa).
- Returns `null` when no section exists (solo video) or no heading matches.

The person job stores `sliceForSpeaker(...) ?? whole summary markdown`. The single fallback covers solo videos (the whole summary is that person's views, by prompt design) and section-flubbing models (best-effort, same ethos as `speakers[]`).

### 5. Person job flow — `people.js`

Per pending video: `canonicalUrlForId(videoId)` (search rows store `youtu.be/` URLs) → `GetItem` on `yt2txt-summaries` → if current, reuse without any Gemini call; else one patient call through the core and write → slice → `updateVideoRow({ status: "done", markdown: slice, model, summarisedAt })`.

Untouched: `searchAndQueueVideos`, the continuation/time-budget machinery (`canStartVideo`, `canStartMeta`, `pickPendingVideos`), stall resumer, progress reporting, `finalisePerson`, error rows (`status: "error"`, `errorMessage`).

`META_PROMPT` gains one sentence: summaries may include other speakers' content; only attribute to the person what they themselves say. (Needed because whole-summary fallback slices can contain other people.)

### 6. Frontend

One change: each video card on the People page links to `/summary/<videoId>` via `src/paths.js`. History and permalinks pick up person-researched videos automatically — that is the fix.

## Edge cases

- Search false positive (video *about* the person who never speaks): slice misses → whole-summary fallback; the meta-prompt sentence prevents mis-attribution.
- Two person jobs racing the same fresh video: conditional put; the loser adopts the winner's row.
- Model omits the section on a multi-speaker video (Gemma is the usual suspect): whole-summary fallback, no retry.
- A person job dumping up to 8 new rows into the history feed at once: intended behaviour.

## Testing

- New pure smoke tests: `speaker-section.test.mjs` (section present/absent/solo, tolerant name matching), staleness predicate test beside the other pure suites.
- `make test` stays bare `node --test` (auto-discovers `*.test.mjs`; no path arguments).
- Existing suites (`tags`, `people-pure`, `backfill-pure`, `share`, `youtube-url`) unaffected.

## Out of scope (declined in design review)

- Channel-name hints in the text-only fallback extractor (`speakers.js`).
- A known-person hint when a research job summarises a video.
- A backfill pass re-tagging historical rows with empty `speakers[]`.

These go to `docs/BACKLOG.md` `## Won't do`: "declined in design review — prompt hints only".

## Bookkeeping on completion

- Move the backlog line to `docs/CHANGELOG.md` `## Unreleased` as a user-facing change.
- `docs/DECISIONS.md` entries: enriched shared prompt vs. two pipelines; visible section vs. stripped metadata; re-watch-once upgrade policy.
