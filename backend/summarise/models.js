import { GoogleGenAI } from "@google/genai";
import { DEFAULT_MODEL } from "./constants.js";

// The allowed-model list, shared by both Lambda entries: the web path uses it
// for `?models=1`, for validating a requested model, and to build the summarise
// fallback chain; the worker uses it to build the same chain for a person job.
// Derived from ai.models.list() so the dropdown and the request allow-list
// cannot drift — to change which models appear, edit isWantedModel().

const MODEL_CACHE_SUCCESS_TTL_MS = 24 * 60 * 60 * 1000;
const MODEL_CACHE_FALLBACK_TTL_MS = 5 * 60 * 1000;

// Used when ai.models.list() fails or returns nothing usable, so summarising
// and request validation never hard-fail on a Google API hiccup.
const FALLBACK_MODELS = [
  { value: DEFAULT_MODEL, label: "Gemini Flash Latest" },
  { value: "models/gemini-3-flash-preview", label: "Gemini 3 Flash" },
  { value: "models/gemini-flash-lite-latest", label: "Gemini 3.1 Flash Lite" },
  { value: "models/gemini-2.5-flash", label: "Gemini 2.5 Flash" },
  { value: "models/gemini-2.5-flash-lite", label: "Gemini 2.5 Flash Lite" },
  { value: "models/gemma-4-31b-it", label: "Gemma 4 31B" },
  { value: "models/gemma-4-26b-a4b-it", label: "Gemma 4 26B" },
];

function isWantedModel(name) {
  const n = name.toLowerCase();
  if (["tts", "image", "audio", "live"].some((bad) => n.includes(bad))) return false;
  if (n.includes("gemma")) return true;
  if (n.includes("gemini") && n.includes("flash")) return true;
  return false;
}

// Pure: maps raw @google/genai Model objects to sorted [{ value, label }].
// Exported so it can be smoke-tested without a network call.
export function filterModels(rawModels) {
  const wanted = (rawModels || []).filter(
    (m) =>
      m &&
      typeof m.name === "string" &&
      (m.supportedActions || []).includes("generateContent") &&
      isWantedModel(m.name),
  );
  const toOption = (m) => ({ value: m.name, label: m.displayName || m.name });
  const byNameDesc = (a, b) => b.value.localeCompare(a.value);
  const gemini = wanted
    .filter((m) => m.name.toLowerCase().includes("gemini"))
    .map(toOption)
    .sort(byNameDesc);
  const gemma = wanted
    .filter((m) => !m.name.toLowerCase().includes("gemini"))
    .map(toOption)
    .sort(byNameDesc);
  return [...gemini, ...gemma];
}

let modelCache = { expires: 0, list: null };

// Returns [{ value, label }] of allowed models. Cached in module scope:
// 24h after a successful fetch, 5min after a fallback so it retries soon.
export async function getAllowedModels() {
  if (modelCache.list && Date.now() < modelCache.expires) {
    return modelCache.list;
  }
  let list;
  let ttl;
  try {
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY, apiVersion: "v1beta" });
    const pager = await ai.models.list({});
    const raw = [];
    for await (const model of pager) {
      raw.push(model);
      if (raw.length >= 500) break;
    }
    list = filterModels(raw);
    if (list.length === 0) {
      console.warn("models.list returned no matching models, using fallback");
      list = FALLBACK_MODELS;
      ttl = MODEL_CACHE_FALLBACK_TTL_MS;
    } else {
      ttl = MODEL_CACHE_SUCCESS_TTL_MS;
    }
  } catch (err) {
    console.error("models.list failed, using fallback", err);
    list = FALLBACK_MODELS;
    ttl = MODEL_CACHE_FALLBACK_TTL_MS;
  }
  modelCache = { expires: Date.now() + ttl, list };
  return list;
}

// The values-only view both callers actually want for buildModelChain().
export async function allowedModelValues() {
  return (await getAllowedModels()).map((m) => m.value);
}
