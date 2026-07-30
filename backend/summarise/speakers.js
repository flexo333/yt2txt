import { normaliseSpeakers, parseSpeakerTrailer, parseSpeakerList } from "./tags.js";
import { withTimeout } from "./people-pure.js";

// Fallback path for speaker tags. The summarise prompt asks for a trailer line
// naming the speakers; when a model ignores it (the chain falls back to Gemma,
// which is the least reliable at format compliance) this re-reads the finished
// summary. Text-only — no video part, so it costs a few hundred tokens and
// never touches the video-token budget.

const EXTRACT_PROMPT = `From the video summary below, list every person who actually speaks in the video — the host and any guests.

Rules:
- Real names only. Skip anyone merely mentioned or quoted who does not speak.
- Skip generic labels like "host", "narrator" or "unknown speaker".
- If you cannot name anyone, answer exactly: Speakers: none

Answer with a single line and nothing else, in exactly this form:
Speakers: Jane Doe, John Smith`;

// Enough summary to name the speakers without paying for the whole thing.
const MAX_MARKDOWN_CHARS = 12000;

// Guards the request path: a hung extraction must not hold up the response,
// since an empty tag list is an acceptable outcome.
const EXTRACT_TIMEOUT_MS = 20000;

// Never throws. Returns a (possibly empty) name list when the call succeeded,
// and null when the call itself failed — a timeout, a rate limit, a dead model.
// The two are kept distinct because "the model named nobody" is a final answer
// worth persisting, while a failure must stay eligible for a retry.
export async function extractSpeakersFromMarkdown(ai, model, markdown, { timeoutMs = EXTRACT_TIMEOUT_MS } = {}) {
  const text = String(markdown || "").trim();
  if (!text) return [];

  try {
    const response = await withTimeout(
      ai.models.generateContent({
        model,
        contents: [{
          parts: [{ text: `${EXTRACT_PROMPT}\n\n---\n${text.slice(0, MAX_MARKDOWN_CHARS)}` }],
        }],
      }),
      timeoutMs,
      `speaker extraction timed out after ${timeoutMs}ms`,
    );
    const raw = String(response.text || "").trim();
    // Prefer the requested `Speakers: …` form; a bare list is accepted too, but
    // only when the reply is short enough to plausibly be one.
    const trailer = parseSpeakerTrailer(raw);
    if (trailer !== null) return normaliseSpeakers(trailer);
    if (raw.length <= 200 && !raw.includes("\n")) return normaliseSpeakers(parseSpeakerList(raw));
    return [];
  } catch (err) {
    console.warn("speaker extraction failed", err?.message || err);
    return null;
  }
}
