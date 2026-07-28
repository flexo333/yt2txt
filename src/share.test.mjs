// Smoke tests for the pure share-target helpers. Run with plain node:
//   node src/share.test.mjs

import assert from 'node:assert/strict';
import { videoIdFrom, canonicalYoutubeUrl, findYoutubeUrl, shareTargetUrl } from './share.js';

const CANONICAL = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`ok - ${name}`);
}

check('videoIdFrom handles every YouTube URL shape', () => {
  const id = 'dQw4w9WgXcQ';
  assert.equal(videoIdFrom('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), id);
  assert.equal(videoIdFrom('https://youtube.com/watch?v=dQw4w9WgXcQ&list=PLabc'), id);
  assert.equal(videoIdFrom('https://m.youtube.com/watch?v=dQw4w9WgXcQ'), id);
  assert.equal(videoIdFrom('https://music.youtube.com/watch?v=dQw4w9WgXcQ'), id);
  assert.equal(videoIdFrom('https://youtu.be/dQw4w9WgXcQ?si=trackingParam'), id);
  assert.equal(videoIdFrom('https://www.youtube.com/shorts/dQw4w9WgXcQ'), id);
  assert.equal(videoIdFrom('https://www.youtube.com/live/dQw4w9WgXcQ?feature=share'), id);
  assert.equal(videoIdFrom('https://www.youtube.com/embed/dQw4w9WgXcQ'), id);
  assert.equal(videoIdFrom('  youtu.be/dQw4w9WgXcQ  '), id);
});

check('videoIdFrom rejects non-YouTube and malformed input', () => {
  assert.equal(videoIdFrom('https://vimeo.com/12345'), null);
  assert.equal(videoIdFrom('https://notyoutube.com/watch?v=dQw4w9WgXcQ'), null);
  assert.equal(videoIdFrom('https://www.youtube.com/watch?v=tooshort'), null);
  assert.equal(videoIdFrom('https://www.youtube.com/@somechannel'), null);
  assert.equal(videoIdFrom('javascript:alert(1)'), null);
  assert.equal(videoIdFrom(''), null);
  assert.equal(videoIdFrom(null), null);
  assert.equal(videoIdFrom(undefined), null);
  assert.equal(videoIdFrom(42), null);
});

check('canonicalYoutubeUrl normalises to the form the Lambda accepts', () => {
  assert.equal(canonicalYoutubeUrl('https://youtu.be/dQw4w9WgXcQ?si=abc'), CANONICAL);
  assert.equal(canonicalYoutubeUrl('https://www.youtube.com/shorts/dQw4w9WgXcQ'), CANONICAL);
  assert.equal(canonicalYoutubeUrl('https://vimeo.com/12345'), null);
});

check('findYoutubeUrl digs a link out of shared free text', () => {
  assert.equal(
    findYoutubeUrl('Check this out https://youtu.be/dQw4w9WgXcQ?si=xyz it is great'),
    CANONICAL,
  );
  assert.equal(findYoutubeUrl('Watch: (https://youtu.be/dQw4w9WgXcQ).'), CANONICAL);
  assert.equal(findYoutubeUrl('some title\nyoutu.be/dQw4w9WgXcQ'), CANONICAL);
  assert.equal(findYoutubeUrl('no links here'), null);
  assert.equal(findYoutubeUrl('https://example.com/a https://youtu.be/dQw4w9WgXcQ'), CANONICAL);
});

check('shareTargetUrl prefers url, then text, then title', () => {
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

console.log(`\n${passed} checks passed`);
