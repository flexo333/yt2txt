import test from "node:test";
import assert from "node:assert/strict";
import { plainSnippet, SNIPPET_CHARS } from "./snippet.js";

test("falsy or non-string input yields an empty string", () => {
  assert.equal(plainSnippet(undefined), "");
  assert.equal(plainSnippet(null), "");
  assert.equal(plainSnippet(""), "");
  assert.equal(plainSnippet(42), "");
  assert.equal(plainSnippet({}), "");
});

test("heading lines are removed entirely", () => {
  assert.equal(plainSnippet("# Title\nBody text"), "Body text");
  assert.equal(plainSnippet("### The Bottom Line\nIt works."), "It works.");
});

test("emphasis and code markers are stripped", () => {
  assert.equal(plainSnippet("Some **bold** and _it_ and `code`."), "Some bold and it and code.");
});

test("newlines and whitespace runs collapse to single spaces", () => {
  assert.equal(plainSnippet("one\n\ntwo\n  three"), "one two three");
});

test("output never exceeds the limit, and a custom limit is honoured", () => {
  const long = "word ".repeat(200);
  assert.ok(plainSnippet(long).length <= SNIPPET_CHARS);
  assert.equal(plainSnippet(long, 10).length, 10);
});

test("already-plain short text passes through unchanged", () => {
  assert.equal(plainSnippet("Just a short line."), "Just a short line.");
});
