# Regenerate a summary on demand

**Date:** 2026-08-01
**Status:** Approved (autonomous session — decisions recorded below, assumptions flagged)

## Problem

Occasionally a stored summary is bad: the model produced thin or wrong content, or
the row predates the current prompt and reads stale. Today the only way out is
manual — the table dedupes on canonical URL, so re-submitting the video returns
the cached row forever. Person jobs upgrade stale rows automatically, but the
web path has no user-facing equivalent.

## Goal

A "Regenerate" action on the summary page that re-watches the video and
replaces the stored summary, without disturbing the row's place in history and
without ever losing the old summary to a failed attempt.

## Approaches considered

1. **`regenerate: true` flag on the existing `POST { url, model }`** — chosen.
   Reuses canonicalisation, model validation, the model chain, and the
   existing write primitives. Smallest new surface.
2. New dispatch action (`POST { action: "regenerate", video }`) — a parallel
   code path for what is just "summarise, skipping the cache hit". More
   surface, no benefit.
3. Delete row, then re-POST — two round trips, a window with no row, and the
   web role would need `DeleteItem` (today reserved for the worker's backfill).
   Worse failure mode and worse IAM posture.

## Design

### Backend (`backend/summarise/handler.js`)

- The POST handler reads `regenerate: !!body.regenerate` and passes it to
  `summarise(url, model, { regenerate })`. Everything upstream — body size cap,
  canonicalisation-as-validation, `isAllowedModel` — is unchanged.
- `summarise()` already `GetItem`s the existing row. With `regenerate` set it
  skips the cached return and proceeds to `generateSummaryItem()` with the
  web path's existing patience (1 attempt per model, `throwOnNonRetryable`).
- Write path after a successful generation:
  - existing row → `putUpgradedSummary(item, existing)` — the pre-existing
    primitive from the person-job stale-upgrade path. It preserves
    `createdAt`/`date` (the regeneration is invisible to history ordering) and
    keeps known-good `videoTitle`/`channelTitle`/`channelId` if the fresh
    metadata lookup failed.
  - no existing row → `putFreshSummary()` as today (regenerating a
    never-summarised video is just a normal summarise).
- Failure path is unchanged (503 when all models are exhausted) and the old
  row is never touched before a successful write — a failed retry costs
  nothing.
- Response is `summaryPayload(item, url)` with no `cached` flag. No new
  response fields.

### Frontend

- `src/api.js` — `createSummary(url, model, { regenerate = false } = {})`
  adds `regenerate: true` to the body when set. Still the only place the
  fetch lives.
- `src/App.jsx` — new `regenerateSummary(targetUrl)` beside `requestSummary`:
  calls `createSummary(targetUrl, model, { regenerate: true })` with the
  app's currently selected model, then replaces the matching history row **in
  place** (the backend preserved `createdAt`, so no move-to-top) and clears
  its `truncated` flag. Passed to the Summary route as `onRegenerate`.
- `src/pages/Summary.jsx` — a "Regenerate" button in `.article-actions`,
  rendered only when the backend is configured and a row is shown. It owns a
  busy flag ("Regenerating…", button disabled) and an inline error line. On
  success it stores the returned row in its local `fetched` state so the fresh
  markdown renders immediately (the `item` prop alone would lose to the stale
  `fetched` row).

### Assumptions (made autonomously)

- **Model choice:** regenerate uses the app's currently selected model (the
  Home dropdown, default Flash Latest), not the row's stored model — same
  semantics as the Generate button, and the model-chain fallback still
  applies. If the stored model produced the bad summary, retrying with it
  pinned would be the worst default.
- **History position:** preserved, consistent with the existing "upgrade"
  semantics. A regenerated summary is not new content arriving.
- **Placement:** summary page only. No regenerate on history cards (YAGNI).

## Error handling

- All-models-exhausted → 503, surfaced as an inline error on the summary
  page; the old summary stays on screen and in the table.
- Invalid model / URL → the existing 400s, unreachable from this UI.

## Testing

No new test module: the feature is thin glue over primitives that already
exist and are already exercised (`putUpgradedSummary`, `generateSummaryItem`,
the model chain). The repo's convention (CLAUDE.md) tests dependency-free pure
modules only, and this change introduces no new pure logic. Verification is
the full existing suite (`node --test`, 62 tests) plus a production build.
