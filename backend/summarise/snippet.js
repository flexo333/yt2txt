// Turns summary markdown into the plain-text snippet a history card shows.
// Deliberately the same transformation src/pages/History.jsx used to do in the
// browser — the point is that the bytes it discarded are now never sent.
export const SNIPPET_CHARS = 200;

export function plainSnippet(markdown, limit = SNIPPET_CHARS) {
  if (!markdown || typeof markdown !== "string") return "";
  return markdown
    .replace(/^#+\s.+$/gm, "")
    .replace(/[*_`#]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}
