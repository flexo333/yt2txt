// Smoke tests for the pure speaker-tag helpers. Run with plain node:
//   node backend/summarise/tags.test.mjs

import assert from "node:assert/strict";
import {
  parseSpeakerTrailer,
  stripSpeakerTrailer,
  parseSpeakerList,
  normaliseSpeakers,
  MAX_SPEAKERS,
} from "./tags.js";

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`ok - ${name}`);
}

check("parseSpeakerTrailer reads the plain trailer line", () => {
  const md = "# Title\n\nSome body text.\n\nSpeakers: Jane Doe, John Smith";
  assert.equal(parseSpeakerTrailer(md), "Jane Doe, John Smith");
});

check("parseSpeakerTrailer tolerates bold and HTML-comment forms", () => {
  assert.equal(parseSpeakerTrailer("body\n**Speakers:** Jane Doe"), "Jane Doe");
  assert.equal(parseSpeakerTrailer("body\n<!-- speakers: Jane Doe -->"), "Jane Doe");
  assert.equal(parseSpeakerTrailer("body\nSPEAKER: Jane Doe"), "Jane Doe");
});

check("parseSpeakerTrailer ignores a Speakers heading buried in the body", () => {
  const md = "Speakers: Jane Doe\n\n" + Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n");
  assert.equal(parseSpeakerTrailer(md), null);
});

check("parseSpeakerTrailer returns null when absent or empty", () => {
  assert.equal(parseSpeakerTrailer("# Title\n\nNo trailer here."), null);
  assert.equal(parseSpeakerTrailer(""), null);
  assert.equal(parseSpeakerTrailer(undefined), null);
});

check("stripSpeakerTrailer removes only the trailer line", () => {
  const md = "# Title\n\nBody text.\n\nSpeakers: Jane Doe";
  assert.equal(stripSpeakerTrailer(md), "# Title\n\nBody text.");
});

check("stripSpeakerTrailer leaves untrailered markdown intact", () => {
  assert.equal(stripSpeakerTrailer("# Title\n\nBody."), "# Title\n\nBody.");
  assert.equal(stripSpeakerTrailer(""), "");
});

check("parseSpeakerList splits on commas, semicolons, slashes and 'and'", () => {
  assert.deepEqual(parseSpeakerList("Jane Doe, John Smith; Ada Lovelace and Alan Turing"),
    ["Jane Doe", "John Smith", "Ada Lovelace", "Alan Turing"]);
});

check("normaliseSpeakers cleans decoration off names", () => {
  assert.deepEqual(
    normaliseSpeakers("**Jane Doe**, Dr. John Smith (host), - Ada Lovelace."),
    ["Jane Doe", "John Smith", "Ada Lovelace"],
  );
});

check("normaliseSpeakers keeps apostrophes and hyphens", () => {
  assert.deepEqual(normaliseSpeakers("Conor O'Brien, Marie-Claire Dubois"),
    ["Conor O'Brien", "Marie-Claire Dubois"]);
});

check("normaliseSpeakers drops generic labels and non-names", () => {
  assert.deepEqual(normaliseSpeakers("none"), []);
  assert.deepEqual(normaliseSpeakers("Host, Narrator, Unknown Speaker, N/A"), []);
  assert.deepEqual(normaliseSpeakers("https://youtu.be/abc, 12345"), []);
  assert.deepEqual(
    normaliseSpeakers("a very long sentence that is clearly not a person's name at all"),
    [],
  );
});

check("normaliseSpeakers dedupes case-insensitively, keeping first casing", () => {
  assert.deepEqual(normaliseSpeakers("Jane Doe, jane doe, JANE DOE"), ["Jane Doe"]);
});

check("normaliseSpeakers caps the list and accepts arrays", () => {
  const many = Array.from({ length: 20 }, (_, i) => `Person Number${i}`);
  assert.equal(normaliseSpeakers(many).length, MAX_SPEAKERS);
  assert.deepEqual(normaliseSpeakers(["Jane Doe"]), ["Jane Doe"]);
  assert.deepEqual(normaliseSpeakers([]), []);
  assert.deepEqual(normaliseSpeakers(null), []);
});

console.log(`\n${passed} checks passed`);
