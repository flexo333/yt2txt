// Slice one speaker's subsection out of a summary's '## What each speaker
// argues' section (the prompt contract in the format-rethink spec). Pure and
// dependency-free apart from tags.js (also pure) — runs under bare `node`.
// Returns null rather than guessing: the caller falls back to the whole
// summary, which is the right answer for solo videos and flubbed sections.

import { normaliseSpeakers } from "./tags.js";

const SECTION_HEADING_RE = /^##\s+what each speaker argues\s*$/i;
const SUBSECTION_RE = /^###\s+(.+?)\s*$/;
const ANY_H2_RE = /^##\s/;

// Lowercased word tokens of a cleaned name. normaliseSpeakers strips
// honorifics and markdown junk; a name it rejects outright (rare) falls back
// to its raw tokens so matching still has something to work with.
function tokensOf(name) {
  const cleaned = normaliseSpeakers([name])[0] || String(name || "");
  return cleaned.toLowerCase().split(/\s+/).filter(Boolean);
}

// "Andrej" matches "Andrej Karpathy" and vice versa: one side's tokens must
// all appear in the other's.
function namesMatch(a, b) {
  const ta = tokensOf(a);
  const tb = tokensOf(b);
  if (ta.length === 0 || tb.length === 0) return false;
  const setA = new Set(ta);
  const setB = new Set(tb);
  return ta.every((t) => setB.has(t)) || tb.every((t) => setA.has(t));
}

export function sliceForSpeaker(markdown, name) {
  const lines = String(markdown || "").split("\n");
  const start = lines.findIndex((line) => SECTION_HEADING_RE.test(line));
  if (start === -1) return null;

  // The section runs to the next '## ' heading (or EOF).
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (ANY_H2_RE.test(lines[i])) { end = i; break; }
  }

  // Split the section into ### subsections and return the matching one.
  let matchFrom = -1;
  for (let i = start + 1; i <= end; i++) {
    const heading = i < end ? lines[i].match(SUBSECTION_RE) : null;
    if (matchFrom !== -1 && (i === end || heading)) {
      return lines.slice(matchFrom, i).join("\n").trim();
    }
    if (heading && namesMatch(heading[1], name)) matchFrom = i;
  }
  return null;
}
