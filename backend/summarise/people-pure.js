// Pure, dependency-free helpers shared by the People research worker, the
// request path and the Gemini call loop (gemini.js). No AWS SDK and no
// @google/genai imports, so this module can be imported and smoke-tested under
// local `node` (see people-pure.test.mjs) — keep it that way.

import { PROMPT_VERSION } from "./constants.js";

// ── Timing / sizing constants ────────────────────────────────────────────────
export const MAX_VIDEOS = 8;                  // videos summarised per run
export const VIDEO_CALL_TIMEOUT_MS = 180_000; // per-video generateContent ceiling
export const VIDEO_TIME_RESERVE_MS = 210_000; // min Lambda time left to start a video
export const META_TIME_RESERVE_MS = 120_000;  // min Lambda time left to start meta
export const MAX_CONTINUATIONS = 12;          // self-invoke loop guard
export const STALL_THRESHOLD_MS = 600_000;    // job considered stalled after this idle
export const MAX_RETRIES_PER_MODEL = 3;       // per-model attempts in summariseVideo
export const MAX_MODEL_ATTEMPTS = 4;          // models tried per generateContent

// ── Job-state predicates ─────────────────────────────────────────────────────

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

// The single ordered list of models to try for one generateContent call: the
// requested model first, then the rest of the allowed list, deduped, capped at
// MAX_MODEL_ATTEMPTS. Used by both the request path and the People worker.
export function buildModelChain(requested, allowedModelValues) {
  const values = (allowedModelValues || []).filter(Boolean);
  const ordered = [requested, ...values.filter((v) => v !== requested)].filter(Boolean);
  return ordered.slice(0, MAX_MODEL_ATTEMPTS);
}

// True for errors where retrying (after backoff) or advancing to another model
// may help. The only copy — gemini.js classifies every failed call with it, on
// the request path and the People path alike.
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
    || msg.includes("timeout")
    // gemini.js throws this when requireText finds nothing usable — including a
    // structured-output payload that failed to parse. A model that returned
    // junk once may return valid JSON on the next attempt, and on the request
    // path (throwOnNonRetryable) this must advance the chain, not 500.
    || msg.includes("empty response");
}

// Exponential backoff (ms) for retry attempt N (0-based), before jitter.
export function backoffDelayMs(attempt) {
  return 2000 * Math.pow(2, attempt);
}

// ── Async helpers ────────────────────────────────────────────────────────────

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Reject if `promise` does not settle in time. The default message says "timed
// out", which isRetryableModelError treats as retryable — a hung model call is
// worth another attempt. Callers outside that loop can pass their own.
export function withTimeout(promise, ms, message = `generateContent timed out after ${ms}ms`) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
