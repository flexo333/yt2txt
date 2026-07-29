// Smoke tests for the canonical-key migration's decision logic.
//   node --test

import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeFill, needsCanonicalUrl, MERGEABLE_ATTRS } from "./backfill-pure.js";

const ID = "dQw4w9WgXcQ";
const CANONICAL = `https://www.youtube.com/watch?v=${ID}`;

test("needsCanonicalUrl flags exactly the movable rows", () => {
  assert.equal(needsCanonicalUrl({ url: `https://youtu.be/${ID}` }), true);
  assert.equal(needsCanonicalUrl({ url: `https://youtu.be/${ID}?si=abc` }), true);
  assert.equal(needsCanonicalUrl({ url: `https://www.youtube.com/shorts/${ID}` }), true);
  assert.equal(needsCanonicalUrl({ url: `https://www.youtube.com/watch?v=${ID}&list=PL` }), true);
  // Already there — a rerun after a complete migration must do nothing.
  assert.equal(needsCanonicalUrl({ url: CANONICAL }), false);
});

test("needsCanonicalUrl leaves rows with no extractable video id alone", () => {
  // There is no key to move them to, so counting them would leave the
  // migration permanently unfinished.
  assert.equal(needsCanonicalUrl({ url: "https://vimeo.com/12345" }), false);
  assert.equal(needsCanonicalUrl({ url: "" }), false);
  assert.equal(needsCanonicalUrl({}), false);
  assert.equal(needsCanonicalUrl(null), false);
});

test("mergeFill only fills gaps in the surviving row", () => {
  const target = { url: CANONICAL, title: "Kept", videoTitle: null, speakers: [] };
  const source = { url: `https://youtu.be/${ID}`, title: "Dropped", videoTitle: "Real Title", speakers: ["Jane Doe"] };
  assert.deepEqual(mergeFill(target, source), {
    videoTitle: "Real Title",
    speakers: ["Jane Doe"],
  });
});

test("mergeFill returns nothing when the canonical row is already complete", () => {
  const complete = Object.fromEntries(MERGEABLE_ATTRS.map((k) => [k, "x"]));
  assert.deepEqual(mergeFill(complete, { title: "other", videoTitle: "other" }), {});
  // ...and nothing when the duplicate has nothing to give.
  assert.deepEqual(mergeFill({}, { videoTitle: null, speakers: [], channelTitle: "" }), {});
  assert.deepEqual(mergeFill({}, {}), {});
});

test("mergeFill copies falsy-but-real values and ignores unknown attributes", () => {
  const filled = mergeFill({}, { createdAt: 0, channelTitle: "Chan", secret: "nope" });
  assert.equal(filled.createdAt, 0);
  assert.equal(filled.channelTitle, "Chan");
  assert.equal("secret" in filled, false);
  // The key itself is never merged — it is the thing being merged onto.
  assert.equal("url" in mergeFill({}, { url: "https://example.com" }), false);
});
