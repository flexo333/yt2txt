import test from "node:test";
import assert from "node:assert/strict";
import { sliceForSpeaker } from "./speaker-section.js";

const MD = `# Big AI debate

The Bottom Line: things happened.

## Claims

1. **AGI is near.** Because scaling. [00:01:00](https://youtu.be/abc?t=60)

## What each speaker argues

### Dr. Jane Doe

- Scaling laws hold for another decade
- "We are not close to a wall" [00:12:04](https://youtu.be/abc?t=724)

### John Smith

- Compute is the bottleneck, not data

## Notable quotes

- stray section that must not leak into a slice
`;

test("returns the matching subsection, heading included", () => {
  const slice = sliceForSpeaker(MD, "Jane Doe");
  assert.match(slice, /^### Dr\. Jane Doe/);
  assert.match(slice, /not close to a wall/);
  assert.doesNotMatch(slice, /John Smith/);
  assert.doesNotMatch(slice, /stray section/);
});

test("last subsection ends at the next ## heading", () => {
  const slice = sliceForSpeaker(MD, "John Smith");
  assert.match(slice, /Compute is the bottleneck/);
  assert.doesNotMatch(slice, /Notable quotes/);
});

test("matching is case-insensitive, honorific-stripped, token-subset both ways", () => {
  assert.ok(sliceForSpeaker(MD, "jane doe"));
  assert.ok(sliceForSpeaker(MD, "Jane"));                 // tracked subset of heading
  assert.ok(sliceForSpeaker(MD, "Dr. Jane Doe"));
  const shortHeading = MD.replace("### Dr. Jane Doe", "### Jane");
  assert.ok(sliceForSpeaker(shortHeading, "Jane Doe"));   // heading subset of tracked
});

test("null when no section, no match, or junk input", () => {
  assert.equal(sliceForSpeaker("# Solo video\n\n## Notable quotes\n- hi", "Jane Doe"), null);
  assert.equal(sliceForSpeaker(MD, "Nobody Here"), null);
  assert.equal(sliceForSpeaker("", "Jane"), null);
  assert.equal(sliceForSpeaker(null, "Jane"), null);
  assert.equal(sliceForSpeaker(MD, ""), null);
});
