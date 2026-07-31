// Smoke tests for the pure speaker-tag helpers. Run with the node test runner:
//   node --test

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseSpeakerList,
  normaliseSpeakers,
  MAX_SPEAKERS,
} from "./tags.js";

test("parseSpeakerList splits on commas, semicolons, slashes and 'and'", () => {
  assert.deepEqual(parseSpeakerList("Jane Doe, John Smith; Ada Lovelace and Alan Turing"),
    ["Jane Doe", "John Smith", "Ada Lovelace", "Alan Turing"]);
});

test("normaliseSpeakers cleans decoration off names", () => {
  assert.deepEqual(
    normaliseSpeakers("**Jane Doe**, Dr. John Smith (host), - Ada Lovelace."),
    ["Jane Doe", "John Smith", "Ada Lovelace"],
  );
});

test("normaliseSpeakers keeps apostrophes and hyphens", () => {
  assert.deepEqual(normaliseSpeakers("Conor O'Brien, Marie-Claire Dubois"),
    ["Conor O'Brien", "Marie-Claire Dubois"]);
});

test("normaliseSpeakers drops generic labels and non-names", () => {
  assert.deepEqual(normaliseSpeakers("none"), []);
  assert.deepEqual(normaliseSpeakers("Host, Narrator, Unknown Speaker, N/A"), []);
  assert.deepEqual(normaliseSpeakers("https://youtu.be/abc, 12345"), []);
  assert.deepEqual(
    normaliseSpeakers("a very long sentence that is clearly not a person's name at all"),
    [],
  );
});

test("normaliseSpeakers dedupes case-insensitively, keeping first casing", () => {
  assert.deepEqual(normaliseSpeakers("Jane Doe, jane doe, JANE DOE"), ["Jane Doe"]);
});

test("normaliseSpeakers caps the list and accepts arrays", () => {
  const many = Array.from({ length: 20 }, (_, i) => `Person Number${i}`);
  assert.equal(normaliseSpeakers(many).length, MAX_SPEAKERS);
  assert.deepEqual(normaliseSpeakers(["Jane Doe"]), ["Jane Doe"]);
  assert.deepEqual(normaliseSpeakers([]), []);
  assert.deepEqual(normaliseSpeakers(null), []);
});