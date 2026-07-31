// Smoke tests for the shared Gemini call loop. gemini.js takes `ai` as an
// argument and imports only people-pure.js, so the whole walk can be exercised
// against a scripted fake without @google/genai or the AWS SDK. Run with:
//   node --test
//
// The two callers pass different options to the same loop, so the cases below
// are grouped by caller — each group is the exact option set that handler.js
// and people.js use in production.

import assert from "node:assert/strict";
import { test } from "node:test";
import { generateWithFallback } from "./gemini.js";

const CHAIN = ["m/1", "m/2", "m/3", "m/4"];

// A fake `ai` whose per-call behaviour is scripted: each entry either returns a
// response or throws. `requests` captures the raw generateContent argument.
function fakeAi(script) {
  const requests = [];
  const ai = {
    models: {
      generateContent: async (request) => {
        requests.push(request);
        const step = script.shift();
        if (!step) throw new Error("fake ai: script exhausted");
        return step(request.model);
      },
    },
  };
  return { ai, requests, models: () => requests.map((r) => r.model) };
}

const rateLimit = () => {
  const err = new Error("RESOURCE_EXHAUSTED quota");
  err.status = 429;
  throw err;
};

const badRequest = () => {
  const err = new Error("FAILED_PRECONDITION");
  err.status = 400;
  throw err;
};

const respond = (text) => () => ({ text, usageMetadata: { totalTokenCount: 7 } });

// ── the request path (handler.js): one try per model, fail fast ──────────────

const requestPathOpts = (extra = {}) => ({
  chain: CHAIN,
  contents: [{ parts: [{ text: "prompt" }] }],
  config: { mediaResolution: "MEDIA_RESOLUTION_LOW" },
  attempts: 1,
  throwOnNonRetryable: true,
  ...extra,
});

test("request path: the first working model wins", async () => {
  const { ai, requests } = fakeAi([respond("# Title")]);
  const out = await generateWithFallback(ai, requestPathOpts());
  assert.deepEqual(
    { ok: out.ok, model: out.model, text: out.text },
    { ok: true, model: "m/1", text: "# Title" },
  );
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].config, { mediaResolution: "MEDIA_RESOLUTION_LOW" });
});

test("request path: quota errors advance the chain and the winner is reported", async () => {
  const { ai, models } = fakeAi([rateLimit, rateLimit, respond("done")]);
  const warned = [];
  const out = await generateWithFallback(ai, requestPathOpts({
    onRetryableError: (err, model) => warned.push([model, err.status]),
  }));
  assert.equal(out.ok, true);
  // The model actually recorded on the summary is the one that produced it.
  assert.equal(out.model, "m/3");
  assert.deepEqual(models(), ["m/1", "m/2", "m/3"]);
  // onRetryableError fires only after the error is classified as retryable.
  assert.deepEqual(warned, [["m/1", 429], ["m/2", 429]]);
});

test("request path: the chain is capped at its own length", async () => {
  const { ai, requests } = fakeAi(new Array(8).fill(rateLimit));
  const out = await generateWithFallback(ai, requestPathOpts());
  assert.equal(out.ok, false);
  assert.equal(out.error.status, 429);
  assert.equal(requests.length, 4); // chosen model + 3 more, then it gives up
});

test("request path: exhaustion is returned, not thrown", async () => {
  const { ai } = fakeAi([rateLimit, rateLimit, rateLimit, rateLimit]);
  const out = await generateWithFallback(ai, requestPathOpts());
  assert.deepEqual(Object.keys(out).sort(), ["error", "ok"]);
  assert.equal(out.ok, false);
  assert.equal(out.error.message, "RESOURCE_EXHAUSTED quota");
});

test("request path: a non-retryable error is rethrown without advancing", async () => {
  const { ai, requests } = fakeAi([badRequest, respond("never reached")]);
  await assert.rejects(generateWithFallback(ai, requestPathOpts()), /FAILED_PRECONDITION/);
  assert.equal(requests.length, 1);
});

test("request path: an empty response advances the chain instead of throwing a 500", async () => {
  const { ai, models } = fakeAi([respond(""), respond("real text")]);
  const out = await generateWithFallback(ai, requestPathOpts({
    chain: ["m/1", "m/2"],
    requireText: true,
  }));
  assert.equal(out.ok, true);
  assert.equal(out.model, "m/2");
  assert.equal(out.text, "real text");
  assert.deepEqual(models(), ["m/1", "m/2"]);
});

test("request path: onResponse sees the response and the model that answered", async () => {
  const seen = [];
  const { ai } = fakeAi([rateLimit, respond("x")]);
  await generateWithFallback(ai, requestPathOpts({
    onResponse: (response, model) => seen.push([model, response.usageMetadata.totalTokenCount]),
  }));
  assert.deepEqual(seen, [["m/2", 7]]);
});

// ── the worker path (people.js): retries, backoff, timeout, required text ────

const workerPathOpts = (waits, extra = {}) => ({
  chain: CHAIN,
  contents: [{ parts: [{ text: "prompt" }] }],
  config: { mediaResolution: "MEDIA_RESOLUTION_LOW" },
  attempts: 3,
  backoffMs: (attempt) => {
    waits.push(attempt);
    return 1; // the real delay is backoffDelayMs(attempt) + jitter
  },
  timeoutMs: 50,
  extractText: (response) => response.text
    || response.candidates?.[0]?.content?.parts?.map((p) => p.text).filter(Boolean).join("\n")
    || "",
  requireText: true,
  ...extra,
});

test("worker path: retries the same model with backoff before advancing", async () => {
  const waits = [];
  const { ai, models } = fakeAi([rateLimit, rateLimit, rateLimit, respond("second model")]);
  const out = await generateWithFallback(ai, workerPathOpts(waits));
  assert.equal(out.ok, true);
  assert.equal(out.model, "m/2");
  assert.deepEqual(models(), ["m/1", "m/1", "m/1", "m/2"]);
  // Backoff runs between attempts only — never after the last one.
  assert.deepEqual(waits, [0, 1]);
});

test("worker path: an empty response is retried on the same model before advancing", async () => {
  const waits = [];
  const { ai, models } = fakeAi([() => ({ text: "" }), respond("real answer")]);
  const out = await generateWithFallback(ai, workerPathOpts(waits));
  assert.equal(out.text, "real answer");
  // Empty response is now retryable (see isRetryableModelError), so the second
  // attempt lands on the same model rather than advancing the chain.
  assert.equal(out.model, "m/1");
  assert.deepEqual(models(), ["m/1", "m/1"]);
  assert.deepEqual(waits, [0]);
});

test("worker path: text falls back to the candidate parts", async () => {
  const { ai } = fakeAi([
    () => ({ candidates: [{ content: { parts: [{ text: "a" }, {}, { text: "b" }] } }] }),
  ]);
  const out = await generateWithFallback(ai, workerPathOpts([]));
  assert.equal(out.text, "a\nb");
});

test("worker path: a hung call times out and is retried on the same model", async () => {
  const waits = [];
  const { ai, requests } = fakeAi([() => new Promise(() => {}), respond("after the timeout")]);
  const out = await generateWithFallback(ai, workerPathOpts(waits, { timeoutMs: 5 }));
  assert.equal(out.ok, true);
  assert.equal(out.model, "m/1"); // a timeout is retryable, so the model is kept
  assert.equal(requests.length, 2);
  assert.deepEqual(waits, [0]);
});

test("worker path: exhaustion hands back the last error for the caller to throw", async () => {
  const { ai, requests } = fakeAi(new Array(12).fill(rateLimit));
  const out = await generateWithFallback(ai, workerPathOpts([]));
  assert.equal(out.ok, false);
  // people.js rethrows this object, so the message reaches the video row intact.
  assert.equal(out.error.message, "RESOURCE_EXHAUSTED quota");
  assert.equal(requests.length, 12); // 4 models x 3 attempts
});

test("worker path: a non-retryable error costs one model, not the whole call", async () => {
  const waits = [];
  const { ai, models } = fakeAi([badRequest, respond("next model")]);
  const out = await generateWithFallback(ai, workerPathOpts(waits));
  assert.equal(out.model, "m/2");
  assert.deepEqual(models(), ["m/1", "m/2"]); // no second attempt at m/1
  assert.deepEqual(waits, []);
});

// ── edges ────────────────────────────────────────────────────────────────────

test("an empty chain reports exhaustion with no error and makes no call", async () => {
  const { ai, requests } = fakeAi([]);
  const out = await generateWithFallback(ai, { chain: [], contents: [] });
  assert.deepEqual(out, { ok: false, error: undefined });
  assert.equal(requests.length, 0);
});

test("config is left out of the request when the caller omits it", async () => {
  const { ai, requests } = fakeAi([respond("x")]);
  await generateWithFallback(ai, { chain: ["m/1"], contents: [{ parts: [] }] });
  assert.equal("config" in requests[0], false);
});
