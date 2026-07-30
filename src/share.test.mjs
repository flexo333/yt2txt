// Smoke tests for the pure share-target helpers. Run with the node test runner:
//   node --test
//
// The URL shapes themselves are covered once, in
// backend/summarise/youtube-url.test.mjs — the module this one re-exports.
// What is tested here is the share-sheet layer on top of it.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { videoIdFrom, canonicalYoutubeUrl, findYoutubeUrl, shareTargetUrl } from './share.js';
import * as shared from '../backend/summarise/youtube-url.js';

const CANONICAL = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

test('share.js re-exports the shared canonicaliser, not a copy of it', () => {
  // The frontend and the Lambda must canonicalise identically or one video
  // ends up holding two DynamoDB rows again.
  assert.equal(videoIdFrom, shared.videoIdFrom);
  assert.equal(canonicalYoutubeUrl, shared.canonicalYoutubeUrl);
  assert.equal(canonicalYoutubeUrl('https://youtu.be/dQw4w9WgXcQ?si=abc'), CANONICAL);
});

test('findYoutubeUrl digs a link out of shared free text', () => {
  assert.equal(
    findYoutubeUrl('Check this out https://youtu.be/dQw4w9WgXcQ?si=xyz it is great'),
    CANONICAL,
  );
  assert.equal(findYoutubeUrl('Watch: (https://youtu.be/dQw4w9WgXcQ).'), CANONICAL);
  assert.equal(findYoutubeUrl('some title\nyoutu.be/dQw4w9WgXcQ'), CANONICAL);
  assert.equal(findYoutubeUrl('no links here'), null);
  assert.equal(findYoutubeUrl('https://example.com/a https://youtu.be/dQw4w9WgXcQ'), CANONICAL);
});

test('shareTargetUrl prefers url, then text, then title', () => {
  const params = (obj) => new URLSearchParams(obj);
  assert.equal(
    shareTargetUrl(params({ url: 'https://youtu.be/dQw4w9WgXcQ', text: 'https://youtu.be/aaaaaaaaaaa' })),
    CANONICAL,
  );
  // YouTube for Android sends the link in `text` and leaves `url` empty.
  assert.equal(
    shareTargetUrl(params({ title: 'Some shared video', text: 'https://youtu.be/dQw4w9WgXcQ?si=x' })),
    CANONICAL,
  );
  // A non-YouTube `url` must not shadow a YouTube link found in `text`.
  assert.equal(
    shareTargetUrl(params({ url: 'https://example.com/x', text: 'https://youtu.be/dQw4w9WgXcQ' })),
    CANONICAL,
  );
  assert.equal(shareTargetUrl(params({ title: 'https://youtu.be/dQw4w9WgXcQ' })), CANONICAL);
  assert.equal(shareTargetUrl(params({ text: 'nothing useful' })), null);
  assert.equal(shareTargetUrl(params({})), null);
  assert.equal(shareTargetUrl(null), null);
});