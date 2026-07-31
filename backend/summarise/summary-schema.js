// The structured-output contract for a summary: the responseSchema every
// summarise call sends, and the parse/validate of what comes back. Replaced
// the Speakers-trailer prompt contract on 2026-07-31 (see the structured-output
// spec) — all allowed models are Gemini now, and every one supports
// responseSchema. Dependency-free apart from tags.js (also pure), so it runs
// under bare `node` — keep it that way.

import { normaliseSpeakers } from "./tags.js";

// Gemini Schema format (uppercase type strings — the SDK's native Schema type,
// which supports propertyOrdering; raw lowercase JSON Schema would be routed to
// responseJsonSchema instead, which does not). Field semantics live in the
// descriptions; the ordering makes the model settle title and body before the
// speaker list, mirroring where the old trailer sat.
export const SUMMARY_RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    title: {
      type: "STRING",
      description: "Simple, clear title stating exactly what the video is about. No buzzwords.",
    },
    markdown: {
      type: "STRING",
      description: "The full summary as plain Markdown, starting with the title as a '# ' heading.",
    },
    speakers: {
      type: "ARRAY",
      items: { type: "STRING" },
      description:
        "Every person who actually speaks in the video, real names only. Skip anyone merely " +
        "mentioned, and generic labels like 'host' or 'narrator'. Empty if none can be named.",
    },
  },
  required: ["title", "markdown", "speakers"],
  propertyOrdering: ["title", "markdown", "speakers"],
};

// The model's JSON reply → { title, markdown, speakers }, or null on anything
// malformed. Null (not a throw) so the call loop can treat a bad payload
// exactly like an empty response — retryable. Speakers are normalised here so
// no caller ever stores a raw model-provided name list.
export function parseSummaryResponse(text) {
  let parsed;
  try {
    parsed = JSON.parse(String(text ?? ""));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const { title, markdown, speakers } = parsed;
  if (typeof title !== "string") return null;
  if (typeof markdown !== "string" || !markdown.trim()) return null;
  if (!Array.isArray(speakers)) return null;
  return {
    title: title.trim() || "Untitled",
    markdown: markdown.trim(),
    speakers: normaliseSpeakers(speakers.filter((s) => typeof s === "string")),
  };
}
