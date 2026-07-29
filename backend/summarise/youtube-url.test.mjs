// Smoke tests for the shared link canonicaliser. This module is the single
// source of truth for both the browser and the Lambda, so every URL shape the
// app can receive is pinned here rather than in src/share.test.mjs.
//   node --test

import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalUrlForId, canonicalYoutubeUrl, isVideoId, videoIdFrom } from "./youtube-url.js";

const ID = "dQw4w9WgXcQ";
const CANONICAL = `https://www.youtube.com/watch?v=${ID}`;

test("videoIdFrom handles every YouTube URL shape", () => {
  assert.equal(videoIdFrom(`https://www.youtube.com/watch?v=${ID}`), ID);
  assert.equal(videoIdFrom(`https://youtube.com/watch?v=${ID}&list=PLabc`), ID);
  assert.equal(videoIdFrom(`https://m.youtube.com/watch?v=${ID}`), ID);
  assert.equal(videoIdFrom(`https://music.youtube.com/watch?v=${ID}`), ID);
  assert.equal(videoIdFrom(`https://www.youtube-nocookie.com/embed/${ID}`), ID);
  assert.equal(videoIdFrom(`https://youtu.be/${ID}?si=trackingParam`), ID);
  assert.equal(videoIdFrom(`https://www.youtube.com/shorts/${ID}`), ID);
  assert.equal(videoIdFrom(`https://www.youtube.com/live/${ID}?feature=share`), ID);
  assert.equal(videoIdFrom(`https://www.youtube.com/embed/${ID}`), ID);
  assert.equal(videoIdFrom(`https://www.youtube.com/v/${ID}`), ID);
  assert.equal(videoIdFrom(`http://youtube.com/watch?v=${ID}`), ID);
  assert.equal(videoIdFrom(`  youtu.be/${ID}  `), ID);
});

test("videoIdFrom rejects non-YouTube and malformed input", () => {
  assert.equal(videoIdFrom("https://vimeo.com/12345"), null);
  assert.equal(videoIdFrom(`https://notyoutube.com/watch?v=${ID}`), null);
  assert.equal(videoIdFrom("https://www.youtube.com/watch?v=tooshort"), null);
  assert.equal(videoIdFrom(`https://www.youtube.com/watch?v=${ID}extra`), null);
  assert.equal(videoIdFrom("https://www.youtube.com/@somechannel"), null);
  assert.equal(videoIdFrom("javascript:alert(1)"), null);
  assert.equal(videoIdFrom(""), null);
  assert.equal(videoIdFrom(null), null);
  assert.equal(videoIdFrom(undefined), null);
  assert.equal(videoIdFrom(42), null);
});

test("isVideoId accepts only a bare 11-character id", () => {
  assert.equal(isVideoId(ID), true);
  assert.equal(isVideoId("-_aBcDeFgH1"), true);
  assert.equal(isVideoId("tooshort"), false);
  assert.equal(isVideoId(`${ID}X`), false);
  assert.equal(isVideoId(CANONICAL), false);
  assert.equal(isVideoId(null), false);
  assert.equal(isVideoId(undefined), false);
});

test("canonicalUrlForId is the one place the stored key is spelled", () => {
  assert.equal(canonicalUrlForId(ID), CANONICAL);
  assert.equal(canonicalUrlForId("nope"), null);
  assert.equal(canonicalUrlForId(null), null);
});

test("canonicalYoutubeUrl collapses every form onto one key", () => {
  const forms = [
    CANONICAL,
    `https://youtube.com/watch?v=${ID}`,
    `https://youtu.be/${ID}`,
    `https://youtu.be/${ID}?si=abc123`,
    `https://m.youtube.com/watch?v=${ID}`,
    `https://music.youtube.com/watch?v=${ID}`,
    `https://www.youtube.com/shorts/${ID}`,
    `https://www.youtube.com/live/${ID}`,
    `https://www.youtube.com/embed/${ID}`,
    `https://www.youtube.com/watch?v=${ID}&list=PLabc&index=2`,
    `youtu.be/${ID}`,
  ];
  for (const form of forms) {
    assert.equal(canonicalYoutubeUrl(form), CANONICAL, form);
  }
});

test("canonicalYoutubeUrl is idempotent", () => {
  // The browser canonicalises before the POST and the Lambda canonicalises
  // again — if this ever stopped holding, one video would hold two rows.
  for (const raw of [CANONICAL, `https://youtu.be/${ID}?si=x`, `https://www.youtube.com/shorts/${ID}`]) {
    const once = canonicalYoutubeUrl(raw);
    assert.equal(canonicalYoutubeUrl(once), once);
  }
});

test("canonicalYoutubeUrl rejects what videoIdFrom rejects", () => {
  assert.equal(canonicalYoutubeUrl("https://vimeo.com/12345"), null);
  assert.equal(canonicalYoutubeUrl("https://www.youtube.com/@somechannel"), null);
  assert.equal(canonicalYoutubeUrl("not a url at all"), null);
  assert.equal(canonicalYoutubeUrl(null), null);
});
