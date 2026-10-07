# Video categories and category browsing

Date: 2026-09-02

## Problem

Summaries can only be browsed as one flat reverse-chronological list, or narrowed
to a single speaker. There is no way to ask "show me everything about AI". Adding
a small, fixed category to each summary gives the library a second axis, and a
browsable index of what is in it.

## Decisions taken during design

1. **Fixed taxonomy, not free-form tags.** Free-form model output fragments
   ("AI" / "A.I." / "Artificial Intelligence"), which turns a category page into a
   long tail of one-video buckets. A closed list is enforceable in the Gemini
   response schema (`enum`) and validated again on parse.
2. **The taxonomy is personalised to the existing library.** A scan of the 50 most
   recent summaries showed ~20 AI videos, 8 basketball, and zero for
   Environment/Education — and revealed two buckets the generic list missed
   (Careers, Money). AI is split from Software Engineering because a single AI
   bucket would hold 40% of the library and narrow nothing.
3. **Filtering is client-side over the 50 rows `GET /` already returns.** Correct
   "all videos in a category" needs a `byCategory` GSI and a `?category=` query;
   that is deferred (backlog), and when it lands it should cover the speaker
   filter too. The route and the row shape are chosen so that change is a
   read-path swap, not a rewrite.
4. **A real `/category/<slug>` route, not just a filter.** A fixed taxonomy's value
   is that the buckets are known up front; discovery must not depend on spotting a
   card that happens to carry the tag. Category URLs are shareable.
5. **No backfill of existing rows.** Categories can only come from the model, so
   re-tagging means re-watching every video. Old rows read back as `[]` and render
   no chips. `PROMPT_VERSION` is bumped, so person-research jobs upgrade rows they
   touch anyway, and the Regenerate button re-tags one row on demand.

## The taxonomy

15 entries, first-listed is the primary category:

| Name | Slug |
|---|---|
| AI | `ai` |
| Software Engineering | `software-engineering` |
| Technology | `technology` |
| Science | `science` |
| Business | `business` |
| Careers | `careers` |
| Money & Economics | `money-economics` |
| Health & Fitness | `health-fitness` |
| Psychology | `psychology` |
| Philosophy | `philosophy` |
| Culture | `culture` |
| Politics | `politics` |
| History | `history` |
| Sport | `sport` |
| Other | `other` |

Slugs are explicit per entry, not derived — the names contain spaces and `&`, and
a stored slug must never shift because a derivation rule changed. `Other` is the
escape hatch and the sensor: a growing Other pile is the signal to add a category.

Each summary carries **1–2** categories. The first is the primary one (the future
GSI key); a second is optional.

## Architecture

### New shared module: `backend/summarise/categories.js`

The single source of truth for the taxonomy, following the `youtube-url.js`
precedent exactly: it lives in the Lambda bundle (the only thing Pulumi zips) and
the frontend imports *up* into it. Dependency-free so it runs in Lambda, in the
browser bundle and under bare `node`.

Exports:
- `CATEGORIES` — ordered array of `{ name, slug }`.
- `MAX_CATEGORIES = 2`.
- `CATEGORY_NAMES` — the names, for the response schema's `enum`.
- `normaliseCategories(input)` — array in, cleaned array out: trims, matches names
  case-insensitively, drops anything not in the taxonomy, dedupes, caps at
  `MAX_CATEGORIES`, preserves the model's ordering (so index 0 stays primary).
  Never throws; returns `[]` for junk.
- `categoryBySlug(slug)` / `slugForCategory(name)` — the URL bijection; both
  return `null`/`undefined` for unknown input so a bad URL degrades to a
  not-found state rather than crashing.

Smoke-tested by a new `categories.test.mjs` under `make test` (bringing the count
to eleven files).

### Backend changes

- **`summary-schema.js`** — add `categories` to `SUMMARY_RESPONSE_SCHEMA` as an
  `ARRAY` of `STRING` with `enum: CATEGORY_NAMES`, in `required` and last in
  `propertyOrdering` (settle title/body first, same reasoning as speakers).
  `parseSummaryResponse()` requires an array (a non-array payload is malformed →
  `null` → retryable, consistent with speakers) and runs it through
  `normaliseCategories()`, so no caller ever stores a raw model value. An empty
  result is a valid outcome, not an error.
- **`summarise-core.js`** — add a `categories` paragraph to `SYSTEM_PROMPT`
  instructing 1–2 picks, most specific first, from the listed names, and `Other`
  only when nothing fits. Persist `categories` on the summary item.
- **`constants.js`** — `PROMPT_VERSION` 2 → 3 (the prompt text changed, which is
  the rule; it also makes person jobs treat existing rows as stale and upgrade
  them into the taxonomy for free).
- **`handler.js`** — add `categories` to *both* `listRow()` and `summaryPayload()`,
  defaulting to `[]` for rows that predate the field. Missing either one silently
  drops the attribute from a response.

No infra change: no new index, no IAM change, no Pulumi edit.

### Frontend changes

- **`src/paths.js`** — `categoryPath(name)` → `/category/<slug>`, built from
  `slugForCategory` so links and the route resolver cannot disagree (same
  contract as `summaryPath`).
- **`src/api.js`** — destructure `categories` in `getSummary()` and
  `createSummary()`, defaulting to `[]`.
- **`src/components/CategoryTags.jsx`** — category chips for a card. Unlike
  `SpeakerTags` these are real `<a href>` links (with `linkClick`), visually
  distinct from speaker chips: speakers are people, categories are topics. Renders
  nothing when a row has no categories, so pre-taxonomy rows are unaffected.
  Because cards are themselves links, the chip's click handler stops propagation
  before navigating.
- **`src/pages/Category.jsx`** — one category: its name, the matching cards from
  loaded history, and an empty state. Cards are the same shape History renders.
- **`src/pages/Categories.jsx`** — every taxonomy entry with its count in loaded
  history, in taxonomy order. Zero-count entries render dimmed but remain
  linkable, so the full taxonomy is always visible.
- **`src/pages/History.jsx`** — a chip row above the list for the **top 5**
  categories by count in loaded history (ties broken by taxonomy order), each
  linking to its category page. Categories with no summaries never appear there.
- **`src/components/Header.jsx`** — a `Categories` nav link between History and
  People; active for both `/categories` and `/category/<slug>`.
- **`src/App.jsx`** — route `/category/<slug>` alongside the existing
  `/summary/<id>` prefix parsing, `/categories` added to `KNOWN_PATHS`, both
  reporting page `'categories'` for nav highlighting. An unknown slug renders a
  "no such category" empty state rather than redirecting. `CategoryTags` is passed
  to the Home, History, Category and Summary card/detail renders. No new App
  state — the category filter is the route, unlike the speaker filter.
- **`src/index.css`** (where `.speaker-tag` already lives) — `.category-tag` styles
  plus the chip row and the categories grid.

## Data flow

```
Gemini structured output { title, markdown, speakers, categories }
  → parseSummaryResponse()  (drops anything off-taxonomy, caps at 2)
  → summary row { …, categories: ["AI", "Politics"] }
  → GET /            → listRow()        → history[].categories
  → GET /?video=<id> → summaryPayload() → detail.categories
  → CategoryTags chips → /category/<slug> → client-side filter over history
```

## Error handling

- Model returns an off-taxonomy value → dropped at parse; the row keeps whatever
  valid picks remain, possibly none.
- Model returns no `categories` key or a non-array → payload treated as malformed,
  the model chain advances (existing retry behaviour).
- Row predates the field → `[]` everywhere; no chips, counted in no category.
- Unknown slug in the URL → "no such category" empty state.
- History not yet loaded → the category page shows the same loading affordance the
  other list pages use.

## Testing

- `backend/summarise/categories.test.mjs` (new) — normalisation drops
  off-taxonomy values, is case-insensitive, dedupes, caps at 2, preserves order,
  survives junk; slug/name round-trips both ways; unknown slug returns null; every
  taxonomy slug is unique and URL-safe.
- `backend/summarise/summary-schema.test.mjs` (extend) — a payload with valid
  categories parses; off-taxonomy values are dropped; a non-array `categories` is
  malformed (`null`); the schema's enum matches `CATEGORY_NAMES`.
- All via bare `node --test` (`make test`), no path arguments.
- Manual: `make dev`, generate one summary, confirm chips render and link, the
  top-5 row reflects counts, `/categories` lists all 15, an old row renders no
  chips, and a direct load of `/category/ai` works (SPA fallback).

## Out of scope

- Index-backed filtering (`byCategory` GSI + `GET ?category=`) — backlogged, and
  when done should convert the speaker filter too.
- Bulk re-tagging of existing rows — would mean re-watching every video.
- Editing a category by hand in the UI.
- Any second tagging axis (format: interview/talk/documentary).

## Repo bookkeeping

- `docs/BACKLOG.md` **Later**: index-backed category and speaker filtering.
- `docs/CHANGELOG.md` **Unreleased**: the user-facing change.
- `docs/DECISIONS.md`: fixed taxonomy over free-form tags; client-side filtering
  first.
- `CLAUDE.md`: the row shape, the new module, the new routes, and the
  "categories.js is the only taxonomy" rule alongside the youtube-url.js one.
