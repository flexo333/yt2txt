# Gemini-only models, structured output for `{ title, markdown, speakers[] }` — design

**Date:** 2026-07-31
**Backlog item:** "Gemma can never be reached as a fallback — `buildModelChain` caps chains at 4 and the allowed list is Gemini-first, so Gemma only runs when hand-picked — yet its missing `responseSchema` support is what forces the speaker-trailer parse/strip/re-extract machinery; go Gemini-only and replace the trailer contract with structured output `{ title, markdown, speakers[] }`, deleting `speakers.js`, `extractTitle` and the trailer rule."
**Companion specs:** `2026-07-31-summary-format-rethink-design.md` (owns the prompt text — this spec reframes it as a JSON envelope), `2026-07-31-merge-person-video-analysis-design.md` (owns the shared core — this spec changes what the core parses).

## Problem

The `Speakers:` trailer contract exists for exactly one reason, recorded in the 2026-07-29 DECISIONS entry: the model chain could fall back to Gemma, and Gemma does not support `responseSchema`. But the fallback can never happen — `FALLBACK_MODELS` and the live filter both put five Gemini models ahead of Gemma, and `buildModelChain` truncates at `MAX_MODEL_ATTEMPTS = 4`, so a chain from any Gemini request never contains a Gemma model. Gemma runs only when hand-picked from the dropdown.

The machinery that dead branch pays for: trailer parse/strip in `tags.js`, a text-only re-extraction Lambda call (`speakers.js`), a fourth backfill pass (and the backfill's whole Gemini client, which exists solely for it), and title-scraping via `extractTitle`. Every one is best-effort patching over a contract the model can simply be forced to honour.

## Decisions

1. **Allowed models are Gemini Flash-family only.** `isWantedModel()` drops its Gemma admission; the two Gemma entries leave `FALLBACK_MODELS` and the frontend's `FALLBACK_MODEL_OPTIONS`. Loses only the manual free-tier quota escape hatch — accepted.
2. **Every summarise call requests structured output**: `responseMimeType: "application/json"` + `responseSchema` for `{ title: string, markdown: string, speakers: string[] }` (`propertyOrdering: ["title", "markdown", "speakers"]`). All models in every chain now support it.
3. **`markdown` keeps its leading `# Title` heading.** The Summary page renders only the markdown, and the history feed's snippet builder strips heading lines assuming one is there — old and new rows must render identically. The `title` field replaces `extractTitle()` scraping (empty → `"Untitled"`); it stays a card-label convenience.
4. **The trailer contract and everything serving it is deleted**: the prompt's Speakers-trailer instruction, `parseSpeakerTrailer`/`stripSpeakerTrailer` (and private trailer helpers) in `tags.js`, all of `speakers.js`, `extractTitle`, and the backfill's speakers pass. The speakers semantics (real names of people who actually speak, no generic labels, empty when unnameable) move into the schema's `speakers` description. `normaliseSpeakers` is still applied to the returned array; an empty `speakers` list remains a valid outcome.
5. **A response that fails JSON parsing or shape validation is treated as an empty response** — retryable, advancing attempts/chain via `generateWithFallback`'s existing `extractText`/`requireText` semantics. No new error channel.
6. **`@google/genai` is pinned to 1.50.1** (the version the lockfile already resolves; its `GenerateContentConfig` carries the structured-output surface). A caret range that could silently move that surface under a future `make build-lambda` is not worth keeping.

Declined: keeping Gemma reachable by raising `MAX_MODEL_ATTEMPTS` (the quota problem it solved is better handled by the Gemini Flash-lite tiers already in the list); schema-validating `callMeta`'s JSON in `people.js` (works today with regex extraction; goes to `## Later`).

## Design

### Model filter — `models.js`

`isWantedModel()` loses the `if (n.includes("gemma")) return true` line: a wanted model is now `gemini` ∧ `flash` ∧ not `tts|image|audio|live`. `filterModels()` drops its gemini/non-gemini partition — one list, one reverse-alpha sort. `FALLBACK_MODELS` shrinks to its five Gemini entries. `FALLBACK_MODEL_OPTIONS` in `App.jsx` mirrors it. `buildModelChain` is untouched.

### Response schema and parsing

A new dependency-free pure module `backend/summarise/summary-schema.js` (smoke-tested by `summary-schema.test.mjs`) owns:

- `SUMMARY_RESPONSE_SCHEMA` — the `responseSchema` object literal (plain JSON-schema-style object; the SDK accepts it), `required: ["title", "markdown", "speakers"]`, with the speakers semantics in the property description.
- `parseSummaryResponse(text)` → `{ title, markdown, speakers } | null`: `JSON.parse`, shape-check (non-empty string `markdown`, string `title`, array `speakers`), `title || "Untitled"`, `speakers` through `normaliseSpeakers` (pure-to-pure import from `tags.js`, same precedent as `backfill-pure.js` → `youtube-url.js`). Returns `null` on any failure — never throws.

The summarise call passes `extractText: (response) => parseSummaryResponse(response.text) ? response.text : ""` with `requireText: true`, so an invalid payload advances the retry/fallback machinery exactly like an empty response. The caller re-parses the winning text once (trivial cost, no plumbing change to `generateWithFallback`'s string-shaped return).

### Deletions and their blast radius (verified by import audit)

- `speakers.js` — importers are exactly `handler.js` (the `speakers.length === 0 && trailer === null` fallback, now meaningless) and `backfill.js` (pass 4). Both go.
- `tags.js` — `parseSpeakerTrailer`, `stripSpeakerTrailer`, `TRAILER_RE`, `findTrailer`, `TRAILER_SEARCH_LINES` deleted; `normaliseSpeakers`, `parseSpeakerList`, `MAX_SPEAKERS` and the name-cleaning internals stay (the merge spec's slicer reuses the name helpers). `tags.test.mjs` drops the trailer cases, keeps the name cases.
- `extractTitle` — module-private in `handler.js`, no other references.
- `backfill.js` — pass 4 (`needsSpeakers`, `backfillSpeakers`, the `speakersUpdated` counter), the `model` option, and the Gemini client it alone used are removed; passes 1–3 (canonical key, index key, video meta) are untouched and remain DynamoDB + YouTube only. Historical rows with empty `speakers[]` stay as they are — re-tagging them was already declined in the merge spec's design review.

### Prompt

The full prompt text lives in `2026-07-31-summary-format-rethink-design.md`, amended in the same review cycle: the output contract is now the JSON envelope (`title`, `speakers`, and a `markdown` field whose internal section order the prompt still prescribes, starting with the `# Title` heading), and the Speakers-trailer instruction is gone. `PROMPT_VERSION = 2` (introduced by the merge spec) describes that final text — there is no trailer-era interlude version.

## Edge cases

- **A model ignores the schema despite enforcement**: `parseSummaryResponse` returns `null`, the attempt reads as empty, the chain advances; exhaustion still returns the existing 503. No partial rows are ever written.
- **`markdown` arrives without a leading heading**: accepted as-is — the history snippet's heading-strip is a no-op then, and the Summary page renders what there is. Same best-effort ethos as before; nothing downstream parses the heading any more (`title` no longer comes from it).
- **A hand-picked Gemma request after deploy**: `isAllowedModel()` now rejects it with the existing 400 `model not supported` — same path as any other unknown model. Stored rows whose `model` names Gemma still render fine (it is a display string).

## Testing

- New: `summary-schema.test.mjs` — schema shape constants, `parseSummaryResponse` on valid payloads, junk JSON, wrong-typed fields, missing fields, empty markdown, speaker normalisation pass-through.
- Changed: `tags.test.mjs` loses its trailer cases.
- Unchanged: `gemini.test.mjs` (the `extractText`/`requireText` semantics it pins are exactly what decision 5 leans on), `people-pure`, `backfill-pure`, `dispatch-pure`, `media-pure`, `youtube-url`, `share`.
- `make test` stays bare `node --test`.

## Out of scope

- Structured output for `callMeta` in `people.js` (its regex JSON extraction works; `## Later` item).
- Any change to `buildModelChain` mechanics or `MAX_MODEL_ATTEMPTS`.
- Re-tagging historical rows with empty `speakers[]`.

## Bookkeeping on completion

- `docs/DECISIONS.md`: new entry superseding "2026-07-29 — Speaker tags ride on a prompt contract, not a response schema" (and a superseded-by pointer on that entry).
- Backlog line → `docs/CHANGELOG.md` `## Unreleased`; `## Later` gains the `callMeta` structured-output idea.
- CLAUDE.md: speaker-tag bite rewritten, model-machinery pointer corrected to `models.js`, backfill described as three passes, test list refreshed.
