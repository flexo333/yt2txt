import test from "node:test";
import assert from "node:assert/strict";
import { SUMMARY_RESPONSE_SCHEMA, parseSummaryResponse } from "./summary-schema.js";

const good = JSON.stringify({
  title: "How transformers work",
  markdown: "# How transformers work\n\nThe Bottom Line: ...",
  speakers: ["Dr. Jane Doe", "John Smith"],
});

test("schema names the three fields and requires them all", () => {
  assert.deepEqual(Object.keys(SUMMARY_RESPONSE_SCHEMA.properties).sort(), ["markdown", "speakers", "title"]);
  assert.deepEqual([...SUMMARY_RESPONSE_SCHEMA.required].sort(), ["markdown", "speakers", "title"]);
  assert.equal(SUMMARY_RESPONSE_SCHEMA.type, "OBJECT");
});

test("a valid payload parses, with speakers normalised", () => {
  const parsed = parseSummaryResponse(good);
  assert.equal(parsed.title, "How transformers work");
  assert.match(parsed.markdown, /^# How transformers work/);
  // normaliseSpeakers strips honorifics
  assert.deepEqual(parsed.speakers, ["Jane Doe", "John Smith"]);
});

test("junk input returns null, never throws", () => {
  assert.equal(parseSummaryResponse("not json"), null);
  assert.equal(parseSummaryResponse(""), null);
  assert.equal(parseSummaryResponse(null), null);
  assert.equal(parseSummaryResponse("[1,2]"), null);
  assert.equal(parseSummaryResponse('"just a string"'), null);
});

test("wrong-typed or missing fields return null", () => {
  assert.equal(parseSummaryResponse(JSON.stringify({ title: 1, markdown: "x", speakers: [] })), null);
  assert.equal(parseSummaryResponse(JSON.stringify({ title: "t", markdown: "", speakers: [] })), null);
  assert.equal(parseSummaryResponse(JSON.stringify({ title: "t", markdown: "   ", speakers: [] })), null);
  assert.equal(parseSummaryResponse(JSON.stringify({ title: "t", markdown: "x" })), null);
  assert.equal(parseSummaryResponse(JSON.stringify({ title: "t", markdown: "x", speakers: "Jane" })), null);
});

test("empty title falls back to Untitled; non-string speaker entries are dropped", () => {
  const parsed = parseSummaryResponse(JSON.stringify({
    title: "  ",
    markdown: "# T\n\nbody",
    speakers: ["Jane Doe", 42, { name: "x" }, null],
  }));
  assert.equal(parsed.title, "Untitled");
  assert.deepEqual(parsed.speakers, ["Jane Doe"]);
});
