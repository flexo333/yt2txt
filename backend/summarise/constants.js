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

// Pure: frames-per-second to sample for a video of `seconds` length.
export function fpsForDuration(seconds) {
  const s = Number(seconds);
  if (!Number.isFinite(s) || s <= 0) return DEFAULT_FPS;
  if (s <= 5 * 60) return 1.0;
  if (s <= 15 * 60) return 0.5;
  if (s <= 45 * 60) return 0.2;
  return 0.1;
}
