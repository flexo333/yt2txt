// The one place a YouTube link is turned into a video id, and the one place a
// video id is turned back into the URL the summaries table is keyed by.
//
// It lives under backend/summarise/ because that directory *is* the Lambda
// bundle (see _lambda_archive in infra/pulumi/__main__.py): the Lambda can
// import nothing from src/, but the frontend can import from here, so this is
// the only place a module shared by both can sit. src/share.js re-exports it
// and src/paths.js imports it; nothing in the repo may reimplement either
// function — one canonicaliser, one extractor, or the browser and the Lambda
// drift and one video ends up holding two rows again.
//
// Dependency-free on purpose (no AWS SDK, no @google/genai, no bundler-only
// syntax) so the same file runs in the browser bundle, inside Lambda, and under
// plain `node` for youtube-url.test.mjs.

const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtube-nocookie.com",
  "www.youtube-nocookie.com",
  "youtu.be",
  "www.youtu.be",
]);

// A YouTube video id is always 11 URL-safe characters.
const VIDEO_ID_RE = /^[\w-]{11}$/;

// Matches /shorts/ID, /live/ID, /embed/ID, /v/ID — the non-watch video paths.
const PATH_VIDEO_RE = /^\/(?:shorts|live|embed|v)\/([^/?#]+)/;

// Bare (protocol-less) links, e.g. "youtu.be/abc" pasted out of a chat app.
const BARE_LINK_RE = /^(?:www\.|m\.|music\.)?(?:youtube\.com|youtube-nocookie\.com|youtu\.be)\//i;

// True for a bare 11-character video id — what `GET ?video=<id>` receives and
// what a /summary/<id> permalink carries.
export function isVideoId(value) {
  return typeof value === "string" && VIDEO_ID_RE.test(value);
}

// Shared groundwork for anything that needs a parsed `URL` off a recognised
// YouTube link — the id extractor below and `timestampSeconds`. Returns null
// for a non-string, unparseable, or non-YouTube input so every caller gets
// the same rejection behaviour without re-deriving it.
function parseYoutubeUrl(raw) {
  if (typeof raw !== "string") return null;
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
  return YOUTUBE_HOSTS.has(u.hostname.toLowerCase()) ? u : null;
}

// Pulls the 11-char video id out of any recognised YouTube URL shape.
// Returns null for anything else, including non-strings.
export function videoIdFrom(raw) {
  const u = parseYoutubeUrl(raw);
  if (!u) return null;

  let id = null;
  if (u.hostname.toLowerCase().endsWith("youtu.be")) {
    id = u.pathname.slice(1).split("/")[0];
  } else if (u.pathname === "/watch") {
    id = u.searchParams.get("v");
  } else {
    const match = u.pathname.match(PATH_VIDEO_RE);
    if (match) id = match[1];
  }

  return isVideoId(id) ? id : null;
}

// Matches YouTube's `?t=1h2m3s` / `?t=1m30s` / `?t=90s` shape (also legal with
// any subset of the three units, in that order). A bare `?t=90` or `?start=90`
// is handled separately below since it's a plain integer, not this pattern.
const HMS_RE = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/;

// The prompt emits `[HH:MM:SS](https://youtu.be/ID?t=SECONDS)` links so the
// summary can drive the on-page player without a second parser: this pulls
// the seconds back out of whichever of YouTube's own timestamp spellings a
// link uses (`t=90`, `t=90s`, `t=1m30s`, or the embed player's `start=90`).
// Returns null for no timestamp, a malformed one, or a non-YouTube URL —
// never throws, so a caller can use it directly as a "should I intercept
// this click" check.
export function timestampSeconds(raw) {
  const u = parseYoutubeUrl(raw);
  if (!u) return null;

  const t = u.searchParams.get("t");
  const start = u.searchParams.get("start");

  if (start !== null) {
    return /^\d+$/.test(start) ? Number(start) : null;
  }
  if (t === null) return null;
  if (/^\d+$/.test(t)) return Number(t);

  const match = t.match(HMS_RE);
  if (!match || t === "") return null;
  const [, h, m, s] = match;
  if (h === undefined && m === undefined && s === undefined) return null;
  return (Number(h) || 0) * 3600 + (Number(m) || 0) * 60 + (Number(s) || 0);
}

// The URL a video id is stored under. Every other form — youtu.be, shorts,
// live, embed, m./music. hosts, `?si=` share tracking, `&list=` playlists —
// collapses onto this one, which is what makes "one video, one row" true and
// makes `GET ?video=<id>` a plain GetItem.
export function canonicalUrlForId(id) {
  return isVideoId(id) ? `https://www.youtube.com/watch?v=${id}` : null;
}

// Canonical form of any recognised YouTube link, or null if no id can be
// extracted (which is also how the Lambda's POST validation rejects a request).
// Idempotent: the output is itself a recognised link that maps to the same id,
// so canonical(canonical(x)) === canonical(x) — the browser canonicalising
// before the POST and the Lambda canonicalising again cannot disagree.
export function canonicalYoutubeUrl(raw) {
  return canonicalUrlForId(videoIdFrom(raw));
}
