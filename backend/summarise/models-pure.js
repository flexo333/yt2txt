import { DEFAULT_MODEL } from "./constants.js";

// Dependency-free half of models.js: which models are allowed, and the list to
// fall back on when ai.models.list() cannot be reached. Split out so it runs
// under bare `node --test` — models.js itself imports @google/genai and can
// only run inside the Lambda bundle.

// Used when ai.models.list() fails or returns nothing usable, so summarising
// and request validation never hard-fail on a Google API hiccup. Refreshed
// against the AI Studio catalog on 2026-11-25. The two `-latest` aliases lead
// deliberately: Google repoints them at the current Flash/Flash-Lite release,
// so they cannot go stale the way a pinned version can. The pinned ids behind
// them are the newest of each tier in that catalog, then the 2.5 pair as a
// long-lived anchor. Not load-bearing — the live fetch backs the dropdown and
// the allow-list in normal operation — but keep it roughly current.
export const FALLBACK_MODELS = [
  { value: DEFAULT_MODEL, label: "Gemini Flash Latest" },
  { value: "models/gemini-flash-lite-latest", label: "Gemini Flash Lite Latest" },
  { value: "models/gemini-3.8-flash", label: "Gemini 3.8 Flash" },
  { value: "models/gemini-3.5-flash-lite", label: "Gemini 3.5 Flash Lite" },
  { value: "models/gemini-2.5-flash", label: "Gemini 2.5 Flash" },
  { value: "models/gemini-2.5-flash-lite", label: "Gemini 2.5 Flash Lite" },
];

// Gemini Flash family only — the text-out tier, which is what this app does.
//
// Excluded by substring: the TTS, image, native-audio and Live variants of a
// Flash release, which carry "flash" in their ids but cannot return a text
// summary; and "omni", because the AI Studio catalog's Gemini Omni releases
// (`Gemini Omni 1.1/1.2 Flash`, listed as multi-modal *generative* models)
// otherwise match gemini+flash and would reach the dropdown.
//
// Excluded by not matching: Pro, Gemma (dropped 2026-07-31 — it could never be
// reached as a fallback and its missing responseSchema support was all that
// kept the speaker-trailer machinery alive), embeddings, Transcribe, Robotics,
// Computer Use, and the Gemini 4 element-codename releases (Neon, Hydrogen,
// Carbon, Argon), which carry no tier word for a name filter to go on.
const EXCLUDED_SUBSTRINGS = ["tts", "image", "audio", "live", "omni"];

export function isWantedModel(name) {
  const n = String(name || "").toLowerCase();
  if (EXCLUDED_SUBSTRINGS.some((bad) => n.includes(bad))) return false;
  return n.includes("gemini") && n.includes("flash");
}

// Pure: maps raw @google/genai Model objects to sorted [{ value, label }].
export function filterModels(rawModels) {
  return (rawModels || [])
    .filter(
      (m) =>
        m &&
        typeof m.name === "string" &&
        (m.supportedActions || []).includes("generateContent") &&
        isWantedModel(m.name),
    )
    .map((m) => ({ value: m.name, label: m.displayName || m.name }))
    .sort((a, b) => b.value.localeCompare(a.value));
}
