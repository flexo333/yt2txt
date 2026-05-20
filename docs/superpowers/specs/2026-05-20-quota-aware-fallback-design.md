# Quota-aware model fallback + cleanups — design

- **Date:** 2026-05-20
- **Status:** Approved
- **Builds on:** the dynamic model dropdown (`docs/superpowers/specs/2026-05-20-dynamic-model-dropdown-design.md`), already shipped.

## Problem

The interactive `summarise()` path in `backend/summarise/handler.js` makes a single
`ai.models.generateContent()` call. If the chosen model is rate-limited or quota-exhausted,
the request fails outright with a generic 500 — even though other allowed models would have
worked. Summaries also don't record which model produced them.

Two pre-existing doc/code papercuts are bundled in:
- `CLAUDE.md` documents a `GET ?models=2&url=…&prompt=…` endpoint that does not exist.
- `people.js` repeats the literal `"models/gemini-3-flash-preview"` as a job default.

## Decisions taken during brainstorming

- **Stateless** per-request fallback — no persistence, no "exhausted for today" tracking.
  Each request independently walks the chain. (Stateful exhaustion tracking was explicitly
  considered and rejected as more complexity than wanted.)
- **Scope:** the fallback chain applies only to the sync `summarise()` path. `people.js`'s
  existing single-level fallback (`submitBatchWithFallback`, `generateMeta`) is left
  untouched; it only gets its hardcoded literal cleaned up.
- **Output tag:** always display the generating model.
- **Cleanup B:** introduce a shared `constants.js` module.

## Feature 2 — stateless fallback chain

In `handler.js`, `summarise(url, model)` replaces its single `generateContent` call with a
walk over an ordered chain of models:

- **Chain:** `[chosenModel, ...getAllowedModels() in dropdown order, excluding chosenModel]`.
  `getAllowedModels()` already returns models in the dropdown's order (latest → older Gemini,
  then Gemma), so the fallback follows that same order.
- **Walk:** try each model's `generateContent` in turn. On a **retryable** error, advance to
  the next model. On success, stop and use that result.
- **Retryable classification:** a `isRetryableModelError(err)` helper in `handler.js` — a copy
  of the logic in `people.js` (HTTP 429 / 503 / 500, or a message containing
  `resource_exhausted`, `quota`, `rate limit`, `unavailable`, `overloaded`, `high demand`).
  It is a deliberate ~10-line duplication: sharing it would require refactoring `people.js`'s
  fallback internals, which the agreed scope rules out.
- **Non-retryable error** (e.g. a 400, bad request, malformed input) → fail immediately
  without fallback; another model would fail identically.
- **Attempt cap:** `MAX_MODEL_ATTEMPTS = 4` — the chosen model plus up to 3 fallbacks. This
  bounds worst-case latency against the Lambda timeout. The chain is truncated to this many
  entries.
- **Chain exhausted** (all attempts hit retryable errors) → `summarise()` returns
  `503 { error: "all models are currently rate-limited — try again shortly" }` rather than a
  generic 500.

The fallback models all come from `getAllowedModels()`, so they are valid by construction —
no re-validation needed. `getAllowedModels()` is already called in the `POST` path, and is
cached, so the chain adds no extra model-list API calls.

## Feature 2 — output tagging

- `summarise()` persists `model` (the model that **actually** generated the summary) on the
  DynamoDB item. Today the item stores no model at all.
- The response body returns the **actually-used** model (today it echoes the *requested*
  model). The cached-hit path returns the stored `model` from the existing item (absent on
  items written before this feature).
- `listSummaries()` includes `model` in each history entry.
- `App.jsx` renders a small tag (the model's human label) on the summary view and on the
  history cards. The label is resolved from the model `value` via the existing `modelOptions`
  state; an unknown/missing value renders nothing (covers pre-feature summaries).

## Cleanup A — `?models=2` doc

Remove the stale bullet from `CLAUDE.md`:
`- `GET ?models=2&url=…&prompt=…` → one-off summary preview without persisting`

## Cleanup B — shared `constants.js`

New leaf file `backend/summarise/constants.js`:

```js
export const DEFAULT_MODEL = "models/gemini-3-flash-preview";
```

It imports nothing, so neither `handler.js` nor `people.js` importing it creates a circular
dependency.

- `handler.js` — replaces its local `const DEFAULT_MODEL` with an import from `constants.js`.
- `people.js` — imports `DEFAULT_MODEL` and uses it in place of the two inline
  `"models/gemini-3-flash-preview"` literals (the `model || ...` defaults in `runPersonJob`
  and `handleBatchResult`).
- `people.js`'s `FALLBACK_MODEL` constant stays in `people.js` — it is that module's own
  batch-fallback concern.

## Error handling summary

| Situation | Behaviour |
|---|---|
| Chosen model retryable error | Advance to next model in the chain |
| A fallback model succeeds | Use it; record it as the actual model |
| Non-retryable error from any model | Fail immediately, no further fallback |
| All `MAX_MODEL_ATTEMPTS` exhausted | `503 { error: "all models are currently rate-limited — try again shortly" }` |
| Cached summary exists for the URL | Returned directly; no model call, no fallback |

## Files

- **Create:** `backend/summarise/constants.js`
- **Modify:** `backend/summarise/handler.js` (chain, tagging, import `DEFAULT_MODEL`),
  `backend/summarise/people.js` (import `DEFAULT_MODEL`), `src/App.jsx` (model tag),
  `CLAUDE.md` (remove stale line; note the fallback behaviour).

## Verification

No test framework (per `CLAUDE.md`). `handler.js` cannot be imported by local `node` (it
statically imports the runtime-provided AWS SDK). Verification:

1. `node --check` on every modified `.js` file.
2. Verbatim-copy smoke test of the pure chain-building function: chosen model first, then the
   rest of the list in order with the chosen model excluded, truncated to 4 entries.
3. `make build` for the frontend.
4. Deploy-time check: generate a real summary and confirm the response and history record
   carry the `model` field and the UI shows the tag (the happy path + tagging).
5. The fallback retry loop itself is verified by code review — it is a deterministic loop and
   forcing a genuine quota error on demand is not practical.
