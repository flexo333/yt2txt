# Dynamic model dropdown — design

- **Date:** 2026-05-20
- **Status:** Approved
- **Scope:** Feature 1 of 2. Feature 2 (quota-aware model fallback) is tracked separately and out of scope here.

## Problem

The model picker is defined twice — `MODEL_OPTIONS` in `src/App.jsx` and `ALLOWED_MODELS` in
`backend/summarise/handler.js` — and the two must be hand-edited in lockstep whenever Google
ships or retires a model. The list goes stale, and the duplication is a documented footgun in
`CLAUDE.md` ("edit both").

## Goal

Populate the model dropdown dynamically from Google's live model catalogue, so new Flash-family
and Gemma models appear automatically and the frontend/backend lists can never drift.

## Non-goals

- Querying free-tier eligibility. The Gemini API does not expose tier information; `models.list()`
  returns the same catalogue regardless of key tier. Tier only affects rate limits at request time.
- Quota-aware fallback / retry-on-another-model / tagging output with the generating model. That is
  Feature 2, a separate brainstorm → spec → plan → implement cycle.

## Filtering policy

A model is included in the dropdown if it supports the `generateContent` action **and** matches one of:

- **Gemma** — model name contains `gemma`.
- **Gemini Flash** — model name contains both `gemini` and `flash`, and does **not** contain
  `tts`, `image`, `audio`, or `live` (those `-flash-` variants emit audio/images, not text).

This captures `gemini-2.5-flash`, `gemini-3-flash-preview`, `gemini-flash-lite-latest`,
`gemini-2.5-flash-lite`, a future `gemini-3.5-flash`, and the Gemma models. It excludes Pro,
embedding, TTS, and image-generation models. Excluding Pro is intentional — it matches the
project's low-cost posture.

The filter is defined **once** and used for both the dropdown payload and backend request
validation, so the allow-list and the dropdown are identical by construction.

## Backend changes (`backend/summarise/handler.js`)

- **`getAllowedModels()`** — new. Calls `ai.models.list()`, applies the filtering policy, returns
  `[{ value, label }]` where `value` is the model name (e.g. `models/gemini-2.5-flash`) and
  `label` is the API's `displayName`. Result is cached in module scope with a **24-hour TTL**.
  Lambda containers stay warm, so the large majority of invocations skip the network call.
- **`listModels()`** — rewritten to return `{ models: <getAllowedModels()> }` in the new
  `[{ value, label }]` shape. The previous `?models=1` response was a raw array of name strings;
  nothing consumes it yet, so this contract change is safe.
- **`isAllowedModel(model)`** — becomes `async`; validates membership against `getAllowedModels()`
  instead of the static map. Used by both the summarise `POST` path and the `action: "research"`
  path.
- **`FALLBACK_MODELS`** — new static constant holding the current six entries
  (`Gemma 4 26B`, `Gemma 4 31B`, `Gemini 2.5 Flash`, `Gemini 3 Flash`, `Gemini 3.1 Flash Lite`,
  `Gemini 2.5 Flash Lite`). Returned by `getAllowedModels()` if `ai.models.list()` throws, so
  summarising and validation never hard-fail on a Google API hiccup.
- **`ALLOWED_MODELS`** — removed. `DEFAULT_MODEL` stays as a named constant
  (`models/gemini-3-flash-preview`).

Sort order of the returned list: Gemini entries first, then Gemma. Within each group, sort by
model name descending, so higher version numbers surface near the top.

## Frontend changes (`src/App.jsx`)

- On mount, alongside the existing history fetch, issue `GET ?models=1` and populate dropdown
  state from the response.
- `MODEL_OPTIONS` is kept as a **fallback constant** (the current six entries), rendered while
  the fetch is in flight or if it fails.
- Default selection: a `PREFERRED_DEFAULT` constant (`models/gemini-3-flash-preview`). If it is
  absent from the live list, fall back to the first list entry.

## Error handling

| Failure | Behaviour |
|---|---|
| `ai.models.list()` throws (backend) | `getAllowedModels()` returns `FALLBACK_MODELS`; summarise + validation keep working. |
| `GET ?models=1` fails (frontend) | Dropdown renders the `MODEL_OPTIONS` fallback constant. |
| User picks a listed model not usable on the free tier | `generateContent` errors; the existing `catch` in `generatePost` shows the error alert. Cannot be prevented — tier is not queryable. |

## Edge cases

- **Dated preview snapshots** (e.g. `gemini-2.5-flash-preview-09-2025`) pass the filter and may
  add a few extra rows. Decision: show them all, sorted; add de-duplication later only if the
  list is actually noisy (YAGNI).
- The `-latest` alias entries (`gemini-flash-lite-latest`) are returned by `models.list()` as
  their own entries and pass the filter — expected and desired.

## Verification

No test framework exists in this repo. Verification is manual:

1. `curl '<LAMBDA_URL>?models=1'` returns `{ models: [{ value, label }, ...] }` containing only
   Flash-family Gemini and Gemma models.
2. Load the app — the dropdown is populated from the live response.
3. Temporarily simulate a `models.list()` failure — dropdown falls back to the six static entries.
4. `POST` a summary with a listed model → `200`.
5. `POST` a summary with `models/gemini-2.5-pro` (not in the list) → `400 model is not supported`.

## Documentation

`CLAUDE.md` is updated: the "Allowed-model list is duplicated between frontend and backend —
edit both" warning is obsolete and is replaced with a description of the dynamic mechanism.

## Follow-up

Feature 2 — quota-aware model fallback: when a model returns a daily-quota / rate-limit error,
mark it "Usage Full for today", auto-retry the request on the next model down the list
(latest → older), and tag the summary output with the model that actually generated it. Separate
brainstorm and spec.
