import { test } from "node:test";
import assert from "node:assert/strict";

import { FALLBACK_MODELS, filterModels, isWantedModel } from "./models-pure.js";
import { DEFAULT_MODEL } from "./constants.js";

const model = (name, extra = {}) => ({
  name,
  displayName: name,
  supportedActions: ["generateContent"],
  ...extra,
});

test("isWantedModel keeps the text-out Gemini Flash family", () => {
  for (const name of [
    "models/gemini-flash-latest",
    "models/gemini-flash-lite-latest",
    "models/gemini-3.8-flash",
    "models/gemini-3.5-flash-lite",
    "models/gemini-2.5-flash",
    "models/gemini-2.5-flash-lite",
  ]) {
    assert.equal(isWantedModel(name), true, name);
  }
});

test("isWantedModel drops the non-text variants of a Flash release", () => {
  for (const name of [
    "models/gemini-3.8-flash-tts",
    "models/gemini-3.8-flash-lite-tts",
    "models/gemini-3.1-flash-lite-image",
    "models/gemini-2.5-flash-native-audio-dialog",
    "models/gemini-3.8-flash-live",
    // Gemini Omni is a multi-modal *generative* tier that would otherwise
    // match gemini+flash and reach the dropdown.
    "models/gemini-omni-1.2-flash",
    "models/gemini-omni-1.1-flash",
  ]) {
    assert.equal(isWantedModel(name), false, name);
  }
});

test("isWantedModel drops non-Flash tiers, Gemma, and the Gemini 4 codenames", () => {
  for (const name of [
    "models/gemini-3.1-pro",
    "models/gemini-2.5-pro",
    "models/gemma-4-31b-it",
    "models/gemini-embedding-2",
    "models/gemini-3.5-transcribe",
    "models/gemini-robotics-er-2-preview",
    "models/gemini-4-neon",
    "models/gemini-4-hydrogen",
    "models/gemini-4-carbon",
    "models/gemini-4-argon",
  ]) {
    assert.equal(isWantedModel(name), false, name);
  }
});

test("isWantedModel tolerates junk input", () => {
  assert.equal(isWantedModel(undefined), false);
  assert.equal(isWantedModel(null), false);
  assert.equal(isWantedModel(""), false);
});

test("filterModels keeps only generateContent models, newest id first", () => {
  const out = filterModels([
    model("models/gemini-2.5-flash", { displayName: "Gemini 2.5 Flash" }),
    model("models/gemini-3.8-flash", { displayName: "Gemini 3.8 Flash" }),
    model("models/gemini-3.5-flash-lite", { displayName: "Gemini 3.5 Flash Lite" }),
    model("models/gemini-3.1-pro", { displayName: "Gemini 3.1 Pro" }),
    model("models/gemini-omni-1.2-flash", { displayName: "Gemini Omni 1.2 Flash" }),
    model("models/gemini-3.8-flash-tts", { displayName: "Gemini 3.8 Flash TTS" }),
    model("models/gemini-3.6-flash", {
      displayName: "Gemini 3.6 Flash",
      supportedActions: ["embedContent"],
    }),
  ]);
  assert.deepEqual(
    out.map((m) => m.value),
    ["models/gemini-3.8-flash", "models/gemini-3.5-flash-lite", "models/gemini-2.5-flash"],
  );
  assert.deepEqual(
    out.map((m) => m.label),
    ["Gemini 3.8 Flash", "Gemini 3.5 Flash Lite", "Gemini 2.5 Flash"],
  );
});

test("filterModels falls back to the id when a model has no displayName", () => {
  const out = filterModels([model("models/gemini-3.8-flash", { displayName: undefined })]);
  assert.deepEqual(out, [
    { value: "models/gemini-3.8-flash", label: "models/gemini-3.8-flash" },
  ]);
});

test("filterModels tolerates junk input", () => {
  assert.deepEqual(filterModels(undefined), []);
  assert.deepEqual(filterModels([null, {}, { name: 42 }]), []);
});

test("the default model is in the fallback list and passes the filter", () => {
  assert.equal(isWantedModel(DEFAULT_MODEL), true);
  assert.ok(FALLBACK_MODELS.some((m) => m.value === DEFAULT_MODEL));
});

test("every fallback model passes the filter and is listed once", () => {
  const values = FALLBACK_MODELS.map((m) => m.value);
  assert.equal(new Set(values).size, values.length);
  for (const m of FALLBACK_MODELS) {
    assert.equal(isWantedModel(m.value), true, m.value);
    assert.ok(m.label && m.label.length > 0, m.value);
  }
});
