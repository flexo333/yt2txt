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
