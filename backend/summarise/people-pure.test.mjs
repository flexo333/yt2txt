import assert from "node:assert/strict";
import { test } from "node:test";
import {
  pickVideosToProcess,
  isStaleSummary,
  canStartVideo,
  canStartMeta,
  isStalled,
  buildModelChain,
  isRetryableModelError,
  backoffDelayMs,
  withTimeout,
  VIDEO_TIME_RESERVE_MS,
  META_TIME_RESERVE_MS,
  STALL_THRESHOLD_MS,
  MAX_MODEL_ATTEMPTS,
} from "./people-pure.js";
import { PROMPT_VERSION } from "./constants.js";

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

test("canStartVideo / canStartMeta respect their reserves", () => {
  assert.equal(canStartVideo(VIDEO_TIME_RESERVE_MS + 1), true);
  assert.equal(canStartVideo(VIDEO_TIME_RESERVE_MS), false);
  assert.equal(canStartVideo(1000), false);
  assert.equal(canStartMeta(META_TIME_RESERVE_MS + 1), true);
  assert.equal(canStartMeta(META_TIME_RESERVE_MS), false);
});

test("isStalled flags only idle active jobs", () => {
  const now = 1_000_000_000_000;
  assert.equal(isStalled({ status: "running", lastProgressAt: now - STALL_THRESHOLD_MS - 1 }, now), true);
  assert.equal(isStalled({ status: "running", lastProgressAt: now - 1000 }, now), false);
  assert.equal(isStalled({ status: "done", lastProgressAt: 0 }, now), false);
  assert.equal(isStalled({ status: "queued", queuedAt: now - STALL_THRESHOLD_MS - 1 }, now), true);
  assert.equal(isStalled(null, now), false);
});

test("buildModelChain puts requested first, dedupes, caps at MAX_MODEL_ATTEMPTS", () => {
  const allowed = ["m/a", "m/b", "m/c", "m/d", "m/e"];
  assert.deepEqual(buildModelChain("m/c", allowed), ["m/c", "m/a", "m/b", "m/d"]);
  assert.equal(buildModelChain("m/c", allowed).length, MAX_MODEL_ATTEMPTS);
  assert.deepEqual(buildModelChain("m/x", ["m/x"]), ["m/x"]);
  assert.deepEqual(buildModelChain("m/a", []), ["m/a"]);
});

test("isRetryableModelError classifies quota / 5xx / timeout as retryable", () => {
  assert.equal(isRetryableModelError({ status: 429 }), true);
  assert.equal(isRetryableModelError({ status: 503 }), true);
  assert.equal(isRetryableModelError({ message: "RESOURCE_EXHAUSTED" }), true);
  assert.equal(isRetryableModelError({ message: "request timed out" }), true);
  assert.equal(isRetryableModelError(new Error("empty response")), true);
  assert.equal(isRetryableModelError({ status: 400, message: "FAILED_PRECONDITION" }), false);
  assert.equal(isRetryableModelError({ status: 404 }), false);
});

test("backoffDelayMs grows exponentially", () => {
  assert.equal(backoffDelayMs(0), 2000);
  assert.equal(backoffDelayMs(1), 4000);
  assert.equal(backoffDelayMs(2), 8000);
});

test("withTimeout passes a settled promise straight through", async () => {
  assert.equal(await withTimeout(Promise.resolve("ok"), 5000), "ok");
  await assert.rejects(withTimeout(Promise.reject(new Error("boom")), 5000), /boom/);
});

test("withTimeout rejects a hung call with a retryable error", async () => {
  const hung = new Promise(() => {});
  await assert.rejects(withTimeout(hung, 1), (err) => {
    // The default message must stay retryable — the model chain relies on a
    // timeout being worth another attempt.
    assert.match(err.message, /generateContent timed out after 1ms/);
    assert.equal(isRetryableModelError(err), true);
    return true;
  });
  await assert.rejects(withTimeout(new Promise(() => {}), 1, "custom timeout"), /custom timeout/);
});