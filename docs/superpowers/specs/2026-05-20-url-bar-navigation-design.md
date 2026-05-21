# URL-bar navigation for yt2txt

**Date:** 2026-05-20
**Status:** Approved design — ready for implementation plan

## Goal

Make the Chrome address bar reflect where the user is as they navigate the app,
including individual video summaries, so locations are visible, shareable, and
survive a refresh.

## Scope

The URL reflects four views:

| View | URL |
|------|-----|
| Home (input + past summaries) | `/` |
| History list | `/history` |
| People list | `/people` |
| A single summary | `/summary/<videoId>` |

A single **person** is deliberately *not* URL-backed — People keeps its current
internal list↔detail state. Adding person URLs would require reworking
`People.jsx` (its `selected` state and polling interval) and is out of scope.

### Out of scope

- Person deep-linking / `/people/<name>` URLs.
- A routing library (`react-router-dom`). A ~18-line custom hook suffices.
- Per-page `document.title` updates (offered, declined).
- A backend fetch-by-URL endpoint. See "Known limitations".
- Any test framework (the project has none; CLAUDE.md forbids adding one).

## Core principle

**The URL path is the single source of truth for which view renders.** `page`
and `detailItem` stop being independent `useState` and become *derived* from the
path. This is what makes summary URLs correct: there is no second copy of "which
summary is open" to drift out of sync with the address bar on browser
Back/Forward. `useState` is used only for fetched data (`history`), never for
"which view".

## URL → view mapping

```js
const path       = useLocation();
const normalized = path.replace(/\/+$/, '') || '/';   // tolerate trailing slash
const summaryId  = normalized.startsWith('/summary/')
  ? decodeURIComponent(normalized.slice('/summary/'.length))
  : null;
const page = summaryId             ? 'history'        // nav highlight only
           : normalized === '/people'  ? 'people'
           : normalized === '/history' ? 'history'
           : 'home';
```

A summary detail is shown whenever `summaryId` is set; `page` is used only to
drive the nav-link highlight (a summary belongs conceptually under History).

## Components

### 1. New file: `src/useLocation.js` (~18 lines)

A minimal hook over the History API, built on React 18's `useSyncExternalStore`.

```js
import { useSyncExternalStore } from 'react';

// Subscribe inside the function React calls, so listener registration is tied
// to component lifecycle. A module-scope addEventListener would be duplicated
// on every Vite HMR update.
const subscribe = (callback) => {
  window.addEventListener('popstate', callback);
  return () => window.removeEventListener('popstate', callback);
};

// MUST return a primitive. Returning a fresh object each call would make
// useSyncExternalStore re-render infinitely.
const getSnapshot = () => window.location.pathname;

export function useLocation() {
  return useSyncExternalStore(subscribe, getSnapshot);
}

export function navigate(path, { replace = false } = {}) {
  if (path === window.location.pathname) return;
  window.history[replace ? 'replaceState' : 'pushState']({}, '', path);
  // pushState / replaceState do NOT emit popstate. Dispatch one so programmatic
  // navigation and real browser Back/Forward notify subscribers through a
  // single code path.
  window.dispatchEvent(new PopStateEvent('popstate'));
}
```

`getServerSnapshot` is omitted intentionally — client-only Vite SPA, no SSR.

### 2. New helper: `videoIdFromUrl(url)`

Extracts a stable id from a stored YouTube `url` (the DynamoDB hash key).

```js
function videoIdFromUrl(raw) {
  try {
    const u = new URL(raw);
    if (u.hostname.endsWith('youtu.be')) return u.pathname.slice(1) || raw;
    const v = u.searchParams.get('v');
    if (v) return v;
    const m = u.pathname.match(/\/(shorts|live|embed)\/([^/]+)/);
    if (m) return m[2];
    return raw;                       // deterministic fallback: the url itself
  } catch {
    return raw;
  }
}
```

- Handles `watch?v=`, `youtu.be/`, `shorts/`, `live/`, `embed/`, `m.youtube.com`,
  and extra query params.
- On any unrecognised form it returns the raw `url` — still deterministic, so
  building and matching stay consistent (just a longer, encoded path segment).
- It is used both to **build** a summary URL and to **resolve** one, so the two
  sides cannot disagree.

### 3. `App.jsx` changes

- **Derive `page` and `summaryId`** from the path (see mapping above); delete the
  `page` `useState`.

- **Derive `detailItem`** instead of storing it — delete the `detailItem`
  `useState`:

  ```js
  const detailItem = summaryId
    ? history.find(h => videoIdFromUrl(h.url) === summaryId) || null
    : null;
  ```

- **Add a `historyLoaded` flag** (`useState(false)`, set `true` in the history
  fetch's `.finally`). On a cold load of `/summary/<id>` the history fetch is
  still in flight, so the detail render has three states:
  - `summaryId && !historyLoaded` → "Loading…"
  - `summaryId && historyLoaded && detailItem` → the summary
  - `summaryId && historyLoaded && !detailItem` → "Summary not found" with a
    link back to `/history`.

- **`openDetail(item)`** → `navigate('/summary/' + encodeURIComponent(videoIdFromUrl(item.url)))`.
  No `setState`.

- **`closeDetail`** / the detail "← Back to History" button →
  `navigate('/history')`.

- **`generatePost`**: on success, prepend the new item to `history` carrying the
  **full** markdown, then navigate to its page:

  ```js
  setHistory(prev => [{ url, title, date, summary: markdown, model: usedModel }, ...prev]);
  navigate('/summary/' + encodeURIComponent(videoIdFromUrl(url)));
  ```

  The current `.slice(0, 8000)` on the optimistic entry is dropped — it would
  truncate the just-generated summary now that the summary's page renders from
  the `history` entry. Remove the now-dead `setPage('home')`.

- **Delete `content` and `contentModel` state** and the inline result block on
  Home. The summary always renders on its own `/summary/<id>` page. Home becomes
  the input card + the past-summaries grid (+ an empty state when history is
  empty). `downloadMarkdown` is now only ever called with `detailItem.summary`.

- **Path-change effect**: `useEffect(() => window.scrollTo(0, 0), [path])`.
  (No `detailItem` clearing is needed — it is derived.)

- **Unknown-route effect**: if `normalized` is not `/`, `/history`, `/people`,
  and the path is not `/summary/...`, `navigate('/', { replace: true })`.

### 4. Navigation and summary cards rendered as real links

The three nav items become `<a href>` (currently `<button>`), and each
history-list card and Home-grid card becomes an `<a href="/summary/...">`. This
makes middle-click, Cmd/Ctrl-click, "open in new tab", and "copy link address"
work now that the targets are real URLs.

```js
const linkClick = (e, href) => {
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; // native
  e.preventDefault();
  navigate(href);
};
```

CSS: `.nav-link` in `src/index.css` needs `text-decoration: none;` added. The
history-card classes already style `<button>`; applied to `<a>` they need
`text-decoration: none;` and `display:block` is already implied by their use as
flex/grid items — verify visually during implementation and add `color: inherit`
if the card text picks up the link colour.

### 5. `People.jsx` — no changes

People's list↔person navigation lives entirely under `/people` and never touches
the URL. When the user leaves the People page, `App` stops rendering `<People />`,
React unmounts it, and its polling `setInterval` is disposed by the existing
`useEffect` cleanup.

### 6. Infra

No infrastructure change. `infra/pulumi/__main__.py` already sets
`StaticSite(..., spa_mode=True)`, which maps CloudFront 403 and 404 responses to
`/index.html` (200, `error_caching_min_ttl=0`). Combined with Vite's default
absolute asset paths, a refresh on `/history`, `/people`, or `/summary/<id>`
loads correctly.

A one-line warning will be added to CLAUDE.md's "Things that will bite you":

> Routing depends on `spa_mode` (403/404 → `index.html`) **and** Vite's absolute
> asset paths. Never set `base: './'` in the Vite config — it would make assets
> resolve relative to the route and break every non-root URL.

## Behaviors and tradeoffs

- **Browser Back/Forward** moves between all four view types; the view always
  re-derives from the path, so content and URL cannot disagree.
- **Refresh** on any of the four URLs restores that view. For `/summary/<id>`,
  the summary appears once the history fetch resolves (a brief "Loading…").
- **Generate** lands the user on the new summary's `/summary/<id>` page.
- **Open in new tab** on any nav link or summary card boots the app fresh at
  that path and restores the correct view.
- **In-app "← Back to History"** always returns to `/history`; browser Back is
  the context-aware path (e.g. back to Home after generating).

## Error handling

- Unknown / malformed top-level path → redirected to `/`.
- `/summary/<id>` not in loaded history → "Summary not found" + link to History.
- `navigate` to the current path is a no-op (no duplicate history entries).

## Known limitations

- **videoId is not unique across stored rows.** Two stored URLs for the same
  video (`youtu.be/X`, `youtube.com/watch?v=X&t=30s`) share a videoId, so
  `/summary/X` resolves to whichever the `history.find` hits first. Because the
  view is derived from the path this is consistent (no desync) — just an
  occasional "the other near-identical row". Accepted.
- **Only the last ~50 summaries are deep-linkable on a cold load**, since the
  app hydrates from `GET` (last 50). Older summaries show "Summary not found" on
  a fresh load. A `GET ?summary=<url>` backend endpoint would lift this; it is
  out of scope.

## Testing

No test framework exists and none will be added. Verification is manual via
`make dev` (`http://localhost:5173`):

1. Click each nav item — confirm the bar shows `/`, `/history`, `/people`.
2. Click a summary card — confirm `/summary/<videoId>` and the right content.
3. Generate a summary — confirm it lands on `/summary/<videoId>` with the full
   (untruncated) markdown.
4. Browser Back/Forward across pages and summaries — confirm view always matches
   URL.
5. Refresh on each of the four URL shapes — confirm restore (and the brief
   "Loading…" for `/summary/<id>`).
6. Middle-click / Cmd-click a nav link and a summary card — confirm new tab.
7. Enter a garbage path (`/xyz`) — confirm redirect to `/`.
8. Enter `/summary/nonexistent` — confirm "Summary not found".

## Files touched

| File | Change |
|------|--------|
| `src/useLocation.js` | New — `useLocation` hook + `navigate`. |
| `src/App.jsx` | Derive `page`/`summaryId`/`detailItem` from path; `historyLoaded` + loading/not-found states; `videoIdFromUrl`; nav and summary cards as `<a>`; Generate navigates to `/summary/<id>`; remove `content`/`contentModel` and the inline Home result. |
| `src/index.css` | `text-decoration: none;` on `.nav-link` and summary cards; verify card colours. |
| `CLAUDE.md` | One-line warning about `spa_mode` + Vite `base`. |
| `src/pages/People.jsx` | None. |

## Provenance

An adversarial review rejected an earlier "restore top-level page only, with
`/summary/<videoId>` URLs but `detailItem` kept as independent state" approach —
that half-sync caused browser Back/Forward to render the wrong summary. This
design resolves it by making `detailItem` *derived from the path*, so the URL is
the single source of truth. The review's other findings are folded in: `popstate`
listener registered inside `subscribe` (no HMR leak), `getSnapshot` returns a
primitive, unknown-route fallback, scroll reset, and the `spa_mode`/`base`
infra caveat.
