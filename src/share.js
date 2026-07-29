// Helpers for the Web Share Target flow (and for cleaning up pasted links).
//
// Android share sheets are inconsistent: the YouTube app puts the link in
// `text` (often with a "Check this out" prefix), Chrome puts it in `url`, some
// apps only fill `title`. So every field is scanned for the first thing that
// looks like a YouTube link.
//
// The link parsing itself is not here: `videoIdFrom`/`canonicalYoutubeUrl` live
// in backend/summarise/youtube-url.js, because the Lambda enforces the same
// canonical form on every POST and can only import from its own directory.
// They are re-exported so this module stays the frontend's single import for
// link handling.
//
// Everything here is pure — smoke-tested by share.test.mjs under plain node.

import { canonicalYoutubeUrl, videoIdFrom } from '../backend/summarise/youtube-url.js';

export { canonicalYoutubeUrl, videoIdFrom };

// Any URL-ish token inside free text. Trailing punctuation is trimmed below.
const URL_TOKEN_RE = /(?:https?:\/\/|(?:www\.|m\.)?(?:youtube\.com|youtu\.be)\/)[^\s<>"']+/gi;

const TRAILING_PUNCTUATION_RE = /[.,;:!?)\]}'"]+$/;

// First canonicalisable YouTube link inside a blob of free text.
export function findYoutubeUrl(text) {
  if (typeof text !== 'string') return null;

  const direct = canonicalYoutubeUrl(text);
  if (direct) return direct;

  const tokens = text.match(URL_TOKEN_RE) || [];
  for (const token of tokens) {
    const cleaned = token.replace(TRAILING_PUNCTUATION_RE, '');
    const url = canonicalYoutubeUrl(cleaned);
    if (url) return url;
  }
  return null;
}

// Resolve what the share sheet handed us into a single YouTube URL.
// `params` is a URLSearchParams (or anything with a compatible .get).
export function shareTargetUrl(params) {
  for (const field of ['url', 'text', 'title']) {
    const value = params && typeof params.get === 'function' ? params.get(field) : null;
    const found = findYoutubeUrl(value);
    if (found) return found;
  }
  return null;
}
