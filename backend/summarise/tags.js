// Pure helpers for the speaker tags attached to a summary. Dependency-free and
// import-free so `node tags.test.mjs` runs without node_modules, same as
// people-pure.js and src/share.js.

export const MAX_SPEAKERS = 8;

// 2 chars minimum: splitting "N/A" on the slash leaves single letters, which
// are never names.
const MIN_NAME_LENGTH = 2;
const MAX_NAME_LENGTH = 60;
const MAX_NAME_WORDS = 6;

// How far back from the end of a summary to look for the trailer line.
const TRAILER_SEARCH_LINES = 5;

// The prompt asks for a bare `Speakers: a, b` final line. The bold and
// HTML-comment forms are accepted too because models decide on their own that
// metadata "should" be emphasised or hidden.
const TRAILER_RE = /^\s*(?:<!--\s*)?\**\s*speakers?\s*\**\s*:\s*\**\s*(.+?)\s*(?:-->)?\s*$/i;

const HONORIFIC_RE = /^(?:dr|mr|mrs|ms|miss|prof|professor|sir|dame|rev|fr|sen|senator|rep|gov|pres|gen|capt|lt|col|sgt)\.?\s+/i;

// Generic labels a model reaches for when it has no name. Never a tag.
const JUNK = new Set([
  "none", "n/a", "na", "nil", "no one", "noone", "nobody", "unknown",
  "not specified", "unspecified", "not stated", "not named", "unnamed",
  "anonymous", "host", "the host", "hosts", "co-host", "guest", "guests",
  "the guest", "speaker", "speakers", "the speaker", "unknown speaker",
  "various", "various speakers", "multiple", "multiple speakers", "panel",
  "panellists", "panelists", "narrator", "the narrator", "voiceover",
  "voice over", "presenter", "moderator", "interviewer", "interviewee",
  "audience", "caller", "callers", "ai voice", "text to speech", "n a",
]);

function findTrailer(markdown) {
  const lines = String(markdown || "").split("\n");
  let checked = 0;
  for (let i = lines.length - 1; i >= 0 && checked < TRAILER_SEARCH_LINES; i--) {
    if (!lines[i].trim()) continue;
    checked++;
    const match = lines[i].match(TRAILER_RE);
    if (match) return { index: i, list: match[1] };
  }
  return null;
}

// The raw, uncleaned speaker list from a summary's trailer line, or null.
export function parseSpeakerTrailer(markdown) {
  const found = findTrailer(markdown);
  return found ? found.list : null;
}

// The summary with its trailer line removed — the trailer is metadata, so it
// is stripped before the markdown is stored and rendered.
export function stripSpeakerTrailer(markdown) {
  const text = String(markdown || "");
  const found = findTrailer(text);
  if (!found) return text.trimEnd();
  const lines = text.split("\n");
  lines.splice(found.index, 1);
  return lines.join("\n").trimEnd();
}

// Split one written-out list into candidate names. URLs are dropped whole
// first — the slash separator would otherwise shred one into fake names.
export function parseSpeakerList(text) {
  return String(text || "")
    .replace(/https?:\/\/\S+|www\.\S+/gi, " ")
    .split(/\s*(?:,|;|\/|\n|\s&\s|\sand\s)\s*/i)
    .filter(Boolean);
}

function cleanName(value) {
  let name = String(value == null ? "" : value)
    .replace(/\([^)]*\)/g, " ")      // "Jane Doe (host)"
    .replace(/[[\]]/g, " ")          // link syntax leftovers
    .replace(/[*_`"“”]/g, " ")       // markdown emphasis, quotes (apostrophes kept)
    .replace(/^\s*[-–—•\d.]+\s*/, "") // bullet or numbered-list markers
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.,;:]+$/, "")
    .trim();
  name = name.replace(HONORIFIC_RE, "").trim();

  if (name.length < MIN_NAME_LENGTH || name.length > MAX_NAME_LENGTH) return null;
  if (!/\p{L}/u.test(name)) return null;
  if (/https?:|www\./i.test(name)) return null;
  if (name.split(" ").length > MAX_NAME_WORDS) return null;
  if (JUNK.has(name.toLowerCase())) return null;
  return name;
}

// Accepts either an array of raw names or one comma-separated string. Returns
// cleaned, case-insensitively deduped names, capped at MAX_SPEAKERS.
export function normaliseSpeakers(input) {
  const candidates = Array.isArray(input) ? input : parseSpeakerList(input);
  const seen = new Set();
  const out = [];
  for (const candidate of candidates) {
    const name = cleanName(candidate);
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
    if (out.length >= MAX_SPEAKERS) break;
  }
  return out;
}
