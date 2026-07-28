// Helpers for the Web Share Target flow (and for cleaning up pasted links).
//
// Android share sheets are inconsistent: the YouTube app puts the link in
// `text` (often with a "Check this out" prefix), Chrome puts it in `url`, some
// apps only fill `title`. So every field is scanned for the first thing that
// looks like a YouTube link.
//
// Everything here is pure — smoke-tested by share.test.mjs under plain node.

const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtube-nocookie.com',
  'www.youtube-nocookie.com',
  'youtu.be',
  'www.youtu.be',
]);

const VIDEO_ID_RE = /^[\w-]{11}$/;

// Matches /shorts/ID, /live/ID, /embed/ID, /v/ID — the non-watch video paths.
const PATH_VIDEO_RE = /^\/(?:shorts|live|embed|v)\/([^/?#]+)/;

// Bare (protocol-less) links, e.g. "youtu.be/abc" pasted out of a chat app.
const BARE_LINK_RE = /^(?:www\.|m\.|music\.)?(?:youtube\.com|youtube-nocookie\.com|youtu\.be)\//i;

// Any URL-ish token inside free text. Trailing punctuation is trimmed below.
const URL_TOKEN_RE = /(?:https?:\/\/|(?:www\.|m\.)?(?:youtube\.com|youtu\.be)\/)[^\s<>"']+/gi;

const TRAILING_PUNCTUATION_RE = /[.,;:!?)\]}'"]+$/;

// Pulls the 11-char video id out of any recognised YouTube URL shape.
export function videoIdFrom(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const withProtocol = /^https?:\/\//i.test(trimmed)
    ? trimmed
    : BARE_LINK_RE.test(trimmed) ? `https://${trimmed}` : null;
  if (!withProtocol) return null;

  let u;
  try {
    u = new URL(withProtocol);
  } catch {
    return null;
  }
  if (!YOUTUBE_HOSTS.has(u.hostname.toLowerCase())) return null;

  let id = null;
  if (u.hostname.toLowerCase().endsWith('youtu.be')) {
    id = u.pathname.slice(1).split('/')[0];
  } else if (u.pathname === '/watch') {
    id = u.searchParams.get('v');
  } else {
    const match = u.pathname.match(PATH_VIDEO_RE);
    if (match) id = match[1];
  }

  return id && VIDEO_ID_RE.test(id) ? id : null;
}

// Canonical form the Lambda accepts: it validates against
// `youtube.com/watch?v=<11>` or `youtu.be/<11>`, so shorts/live/embed/m. links
// must be rewritten here or the POST comes back 400. Also drops `?si=` share
// tracking params, keeping one DynamoDB row per video.
export function canonicalYoutubeUrl(raw) {
  const id = videoIdFrom(raw);
  return id ? `https://www.youtube.com/watch?v=${id}` : null;
}

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
