import { GoogleGenAI } from "@google/genai";
import { FALLBACK_MODELS, filterModels, isWantedModel } from "./models-pure.js";

// The allowed-model list, shared by both Lambda entries: the web path uses it
// for `?models=1`, for validating a requested model, and to build the summarise
// fallback chain; the worker uses it to build the same chain for a person job.
// Derived from ai.models.list() so the dropdown and the request allow-list
// cannot drift — to change which models appear, edit isWantedModel() in
// models-pure.js, which also owns FALLBACK_MODELS.

const MODEL_CACHE_SUCCESS_TTL_MS = 24 * 60 * 60 * 1000;
const MODEL_CACHE_FALLBACK_TTL_MS = 5 * 60 * 1000;

// Re-exported so callers (and the old import sites) need only this module.
export { FALLBACK_MODELS, filterModels, isWantedModel };

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
