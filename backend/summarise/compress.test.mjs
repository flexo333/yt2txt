import test from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import { MIN_GZIP_BYTES, acceptsGzip, gzipResult } from "./compress.js";

const BIG = JSON.stringify({ text: "hello world ".repeat(400) });
const mk = (extra = {}) => ({
  statusCode: 200,
  headers: { "Content-Type": "application/json" },
  body: BIG,
  ...extra,
});

test("acceptsGzip handles the header shapes browsers send", () => {
  assert.equal(acceptsGzip(undefined), false);
  assert.equal(acceptsGzip(""), false);
  assert.equal(acceptsGzip("gzip"), true);
  assert.equal(acceptsGzip("gzip, deflate, br"), true);
  assert.equal(acceptsGzip("GZIP"), true);
  assert.equal(acceptsGzip("gzip;q=0"), false);
  assert.equal(acceptsGzip("gzip;q=0.5"), true);
  assert.equal(acceptsGzip("br"), false);
  assert.equal(acceptsGzip("*"), true);
});

test("gzipResult skips bodies under the minimum", () => {
  const r = mk({ body: "x".repeat(MIN_GZIP_BYTES - 1) });
  assert.equal(gzipResult(r, "gzip"), r);
});

test("gzipResult skips already-base64 bodies", () => {
  const r = mk({ isBase64Encoded: true });
  assert.equal(gzipResult(r, "gzip"), r);
});

test("gzipResult skips responses that already carry Content-Encoding", () => {
  const r = mk({ headers: { "content-encoding": "br" } });
  assert.equal(gzipResult(r, "gzip"), r);
});

test("gzipResult skips when the client did not offer gzip", () => {
  const r = mk();
  assert.equal(gzipResult(r, "br"), r);
  assert.equal(gzipResult(r, undefined), r);
});

test("gzipResult round-trips and does not mutate its input", () => {
  const r = mk();
  const snapshot = structuredClone(r);
  const out = gzipResult(r, "gzip, deflate");
  assert.notEqual(out, r);
  assert.equal(zlib.gunzipSync(Buffer.from(out.body, "base64")).toString(), BIG);
  assert.equal(out.isBase64Encoded, true);
  assert.equal(out.headers["Content-Encoding"], "gzip");
  assert.equal(out.headers.Vary, "Accept-Encoding");
  assert.equal(out.headers["Content-Type"], "application/json");
  assert.equal(out.statusCode, 200);
  assert.deepEqual(r, snapshot);
});
