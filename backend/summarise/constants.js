// The model used when a request does not specify one. Must appear in
// handler.js's FALLBACK_MODELS and pass its isWantedModel() filter.
export const DEFAULT_MODEL = "models/gemini-flash-latest";

// Gemini bills video at 258 frame tokens per sampled frame (66 at low media
// resolution) plus 32 audio tokens per second. At the default 1 fps a 25-minute
// video costs ~450k tokens, which alone blows the 250k free-tier TPM limit.
// Frames carry almost nothing for talking-head content, so sample them more
// sparsely the longer the video is. Audio stays at 1-second granularity either
// way, which is what timestamp links are actually anchored to.
export const MEDIA_RESOLUTION_LOW = "MEDIA_RESOLUTION_LOW";

// fps used when a video's duration is unknown (a YouTube API failure, or no
// YOUTUBE_API_KEY) — the middle of the ladder, safe for a typical-length video.
export const DEFAULT_FPS = 0.2;

// ── yt2txt-summaries recency index ───────────────────────────────────────────
// The summaries table is keyed by `url`, which says nothing about recency, so
// "the newest 50" cannot come from the table itself — a Scan returns items in
// internal hash order and its Limit caps what is *evaluated*, not what matches.
// The GSI carries one constant partition key (every summary shares a partition,
// which is fine at this scale) sorted by `createdAt`, so a backwards Query is
// exactly the feed. Shared by the write path and the read path in handler.js
// and by the backfill that stamps the key onto pre-index rows.
export const SUMMARY_INDEX = "byCreatedAt";
export const SUMMARY_INDEX_PK = "gsi1pk";
export const SUMMARY_INDEX_PK_VALUE = "SUMMARY";

// Pure: frames-per-second to sample for a video of `seconds` length.
export function fpsForDuration(seconds) {
  const s = Number(seconds);
  if (!Number.isFinite(s) || s <= 0) return DEFAULT_FPS;
  if (s <= 5 * 60) return 1.0;
  if (s <= 15 * 60) return 0.5;
  if (s <= 45 * 60) return 0.2;
  return 0.1;
}
