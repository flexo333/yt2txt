// Pure, dependency-free decision logic for backfill.js. No AWS SDK and no
// @google/genai imports, so it can be imported and smoke-tested under local
// `node` (see backfill-pure.test.mjs) — keep it that way, the same deal as
// people-pure.js.

import { canonicalYoutubeUrl } from "./youtube-url.js";

// True for a row stored under a non-canonical URL — the class the canonical-key
// migration exists to collapse. A row whose url yields no video id at all is
// deliberately excluded: there is no key to move it to, and nothing can look it
// up by video id either, so counting it as outstanding work would leave the
// migration permanently "unfinished".
export function needsCanonicalUrl(row) {
  const canonical = canonicalYoutubeUrl(row?.url);
  return Boolean(canonical) && canonical !== row.url;
}

// Attributes a duplicate row may donate to the canonical row it is folded into.
// `url` and `gsi1pk` are absent on purpose: one is the key being merged onto,
// the other is stamped unconditionally by the migration.
export const MERGEABLE_ATTRS = [
  "title", "markdown", "date", "createdAt", "model",
  "videoTitle", "channelTitle", "channelId", "speakers",
];

// An empty array counts as missing: `speakers: []` means "extraction ran and
// named nobody", and the duplicate describes the same video, so a non-empty
// list from it is strictly better data than the gap it fills.
function isMissing(value) {
  return value === undefined
    || value === null
    || value === ""
    || (Array.isArray(value) && value.length === 0);
}

// Attributes to SET on `target` when merging `source` into it. Gap-filling
// only: whatever the canonical row already has wins, because that row is the
// one the app has been reading and writing. Returns {} when there is nothing to
// do, which is the normal answer for a duplicate the canonical row supersedes.
export function mergeFill(target, source, attrs = MERGEABLE_ATTRS) {
  const fill = {};
  for (const key of attrs) {
    if (!isMissing(target?.[key])) continue;
    if (isMissing(source?.[key])) continue;
    fill[key] = source[key];
  }
  return fill;
}
