import test from "node:test";
import assert from "node:assert/strict";
import { JOB_KINDS, jobKindFor, isHttpEvent } from "./dispatch-pure.js";

// The split between the two Lambda entries is only as good as this
// classification: web.js serves what isHttpEvent() accepts, worker.js runs what
// jobKindFor() names, and nothing may be both.

const HTTP_GET = {
  requestContext: { http: { method: "GET" } },
  queryStringParameters: { models: "1" },
};

const HTTP_POST = {
  requestContext: { http: { method: "POST" } },
  body: JSON.stringify({ url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" }),
};

test("jobKindFor names each internally-invoked job", () => {
  assert.equal(jobKindFor({ __personJob: true, person: "jane doe" }), "person");
  assert.equal(jobKindFor({ __backfill: true, dryRun: true }), "backfill");
  assert.equal(jobKindFor({ __resumeJobs: true }), "resume");
});

test("jobKindFor returns null for anything that is not a job", () => {
  assert.equal(jobKindFor(HTTP_GET), null);
  assert.equal(jobKindFor(HTTP_POST), null);
  assert.equal(jobKindFor({}), null);
  assert.equal(jobKindFor(null), null);
  assert.equal(jobKindFor(undefined), null);
  assert.equal(jobKindFor("__personJob"), null);
  // Present but falsy is not a job — the invokers always send `true`.
  assert.equal(jobKindFor({ __personJob: false }), null);
});

test("isHttpEvent accepts Function URL and proxy request events", () => {
  assert.equal(isHttpEvent(HTTP_GET), true);
  assert.equal(isHttpEvent(HTTP_POST), true);
  // API Gateway v1 shape, which handleHttpRequest still reads.
  assert.equal(isHttpEvent({ httpMethod: "GET" }), true);
});

test("isHttpEvent rejects every job event — the web entry must not run jobs", () => {
  for (const key of Object.keys(JOB_KINDS)) {
    assert.equal(isHttpEvent({ [key]: true }), false, key);
    // Not even when dressed up as a request.
    assert.equal(isHttpEvent({ ...HTTP_POST, [key]: true }), false, key);
  }
});

test("isHttpEvent rejects an empty or malformed invoke", () => {
  assert.equal(isHttpEvent({}), false);
  assert.equal(isHttpEvent(null), false);
  assert.equal(isHttpEvent(undefined), false);
  assert.equal(isHttpEvent("GET /"), false);
});
