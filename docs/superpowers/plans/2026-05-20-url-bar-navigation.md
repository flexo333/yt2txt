# URL-bar Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Chrome address bar reflect the current view (`/`, `/history`, `/people`, `/summary/<videoId>`) as the user navigates yt2txt.

**Architecture:** A ~18-line custom hook (`useLocation`) over the History API, built on React 18's `useSyncExternalStore`. The URL path is the single source of truth: `App.jsx` *derives* `page`, `summaryId`, and `detailItem` from the path instead of holding them in `useState`. No routing library, no infra change.

**Tech Stack:** React 18.3, Vite 5, plain CSS. Everything runs through `docker compose` via the `Makefile`.

---

## Context for the implementer

- The full design spec is at `docs/superpowers/specs/2026-05-20-url-bar-navigation-design.md`. Read it first.
- **There is no test framework and no linter, and CLAUDE.md forbids adding one.** "Verify" steps in this plan mean `make build` (catches syntax/import errors) and manual checks in a browser via `make dev` — not automated tests.
- Commands run via the `Makefile` (Docker); you do not need Node locally.
- The app is a single `App.jsx` component with no router today; `page` is a `useState` string, `detailItem` is a `useState` object, and `People.jsx` manages its own internal detail state.

## Prerequisites (run once before Task 1)

- [ ] **Confirm an isolated workspace.** The repo is on `main`. If not already in a dedicated branch/worktree, create one (the executing skill handles this via superpowers:using-git-worktrees). Do not commit directly to `main`.
- [ ] **Install frontend deps** so `make build` works:

  Run: `make install`
  Expected: completes without error; `node_modules/` populated.

## File structure

| File | Responsibility |
|------|----------------|
| `src/useLocation.js` | **New.** The `useLocation()` hook + `navigate()` function — the entire routing primitive. |
| `src/App.jsx` | **Rewritten.** Derives `page`/`summaryId`/`detailItem` from the path; nav and summary cards become `<a>`; Generate navigates to `/summary/<id>`. |
| `src/index.css` | **Modified.** Three rules gain `text-decoration: none;` (and `color: inherit;`) so `<a>` elements styled as nav links / cards look unchanged. |
| `CLAUDE.md` | **Modified.** One bullet documenting the `spa_mode` + Vite `base` dependency. |
| `src/pages/People.jsx` | **Untouched.** |

---

### Task 1: The `useLocation` routing hook

**Files:**
- Create: `src/useLocation.js`

- [ ] **Step 1: Create `src/useLocation.js`**

```js
import { useSyncExternalStore } from 'react';

// Register the popstate listener inside subscribe (the function React calls),
// not at module scope, so Vite HMR cannot stack duplicate listeners.
const subscribe = (callback) => {
  window.addEventListener('popstate', callback);
  return () => window.removeEventListener('popstate', callback);
};

// Must return a primitive. Returning a fresh object each call would make
// useSyncExternalStore re-render infinitely.
const getSnapshot = () => window.location.pathname;

// Subscribe to the current URL path. Re-renders the component on every
// browser Back/Forward and on every navigate() call.
export function useLocation() {
  return useSyncExternalStore(subscribe, getSnapshot);
}

// Programmatic navigation. pushState/replaceState do NOT emit popstate, so a
// synthetic one is dispatched — that way browser navigation and navigate()
// notify useLocation subscribers through a single code path.
export function navigate(path, { replace = false } = {}) {
  if (path === window.location.pathname) return;
  window.history[replace ? 'replaceState' : 'pushState']({}, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}
```

- [ ] **Step 2: Verify the build still succeeds**

Run: `make build`
Expected: build completes, `dist/` produced, no errors. (The new file is not imported yet, so this only confirms it is syntactically valid once bundled in Task 2 — a clean build here means nothing is broken.)

- [ ] **Step 3: Commit**

```bash
git add src/useLocation.js
git commit -m "$(cat <<'EOF'
feat: add useLocation hook for History-API routing

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Route-driven `App.jsx` + card link styling

This task rewrites `App.jsx` wholesale (the routing change is pervasive and partial edits would leave the file broken) and adds three CSS rules.

**Files:**
- Modify: `src/App.jsx` (full replacement)
- Modify: `src/index.css` (three edits)

- [ ] **Step 1: Replace the entire contents of `src/App.jsx` with:**

```jsx
import React, { useState, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import People from './pages/People.jsx';
import { useLocation, navigate } from './useLocation.js';

const LAMBDA_URL = import.meta.env.VITE_LAMBDA_URL;
const YT2TXT_KEY = import.meta.env.VITE_YT2TXT_KEY || '';

const authHeaders = () => (YT2TXT_KEY ? { 'x-yt2txt-key': YT2TXT_KEY } : {});

const MARKDOWN_URL_TRANSFORM = (url) => {
  try {
    const u = new URL(url, window.location.href);
    return ['http:', 'https:', 'mailto:'].includes(u.protocol) ? url : '';
  } catch {
    return '';
  }
};

const MARKDOWN_COMPONENTS = {
  a: ({ node, ...props }) => (
    <a {...props} target="_blank" rel="noopener noreferrer nofollow ugc" />
  ),
};

const PREFERRED_DEFAULT = 'models/gemini-3-flash-preview';

// Rendered while the ?models=1 fetch is pending or if it fails.
const FALLBACK_MODEL_OPTIONS = [
  { label: 'Gemini 3 Flash', value: 'models/gemini-3-flash-preview' },
  { label: 'Gemini 3.1 Flash Lite', value: 'models/gemini-flash-lite-latest' },
  { label: 'Gemini 2.5 Flash', value: 'models/gemini-2.5-flash' },
  { label: 'Gemini 2.5 Flash Lite', value: 'models/gemini-2.5-flash-lite' },
  { label: 'Gemma 4 31B', value: 'models/gemma-4-31b-it' },
  { label: 'Gemma 4 26B', value: 'models/gemma-4-26b-a4b-it' },
];

const KNOWN_PATHS = ['/', '/history', '/people'];

// Extract a stable id from a stored YouTube URL (DynamoDB hash key is the full
// url). Falls back to the raw url for unrecognised forms, so building a summary
// path and resolving it always use the same value.
const videoIdFromUrl = (raw) => {
  try {
    const u = new URL(raw);
    if (u.hostname.endsWith('youtu.be')) return u.pathname.slice(1) || raw;
    const v = u.searchParams.get('v');
    if (v) return v;
    const m = u.pathname.match(/\/(shorts|live|embed)\/([^/]+)/);
    if (m) return m[2];
    return raw;
  } catch {
    return raw;
  }
};

const summaryPath = (item) => `/summary/${encodeURIComponent(videoIdFromUrl(item.url))}`;

// decodeURIComponent throws on a malformed % sequence — never crash the render.
const decodeId = (s) => {
  try { return decodeURIComponent(s); } catch { return s; }
};

const BrightBlogApp = () => {
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [history, setHistory] = useState([]);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [model, setModel] = useState(PREFERRED_DEFAULT);
  const [modelOptions, setModelOptions] = useState(FALLBACK_MODEL_OPTIONS);

  const path = useLocation();
  const normalized = path.replace(/\/+$/, '') || '/';
  const summaryId = normalized.startsWith('/summary/')
    ? decodeId(normalized.slice('/summary/'.length))
    : null;
  const page = summaryId ? 'history'
             : normalized === '/people' ? 'people'
             : normalized === '/history' ? 'history'
             : 'home';

  const detailItem = summaryId
    ? history.find((h) => videoIdFromUrl(h.url) === summaryId) || null
    : null;

  useEffect(() => {
    if (!LAMBDA_URL) { setHistoryLoaded(true); return; }
    fetch(LAMBDA_URL, { headers: authHeaders() })
      .then(r => r.json())
      .then(({ summaries }) => setHistory(summaries || []))
      .catch(console.error)
      .finally(() => setHistoryLoaded(true));
  }, []);

  useEffect(() => {
    if (!LAMBDA_URL) return;
    fetch(`${LAMBDA_URL}?models=1`, { headers: authHeaders() })
      .then(r => r.json())
      .then(({ models }) => {
        if (!Array.isArray(models) || models.length === 0) return;
        setModelOptions(models);
        setModel(prev => (models.some(m => m.value === prev) ? prev : models[0].value));
      })
      .catch(console.error);
  }, []);

  // Reset scroll position whenever the route changes.
  useEffect(() => { window.scrollTo(0, 0); }, [path]);

  // Send unknown top-level paths back to Home.
  useEffect(() => {
    if (!summaryId && !KNOWN_PATHS.includes(normalized)) {
      navigate('/', { replace: true });
    }
  }, [normalized, summaryId]);

  const generatePost = async () => {
    if (!url) return;
    setLoading(true);
    try {
      const res = await fetch(LAMBDA_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ url, model }),
      });
      if (!res.ok) throw new Error(await res.text());
      const { markdown, title, date, model: usedModel } = await res.json();
      const item = { url, title, date, summary: markdown, model: usedModel };
      setHistory(prev => [item, ...prev]);
      navigate(summaryPath(item));
    } catch (error) {
      alert('Error generating summary. Check the URL and try again.');
      console.error(error);
    } finally {
      setLoading(false);
    }
  };

  const downloadMarkdown = (text) => {
    const blob = new Blob([text], { type: 'text/markdown' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `summary-${Date.now()}.md`;
    link.click();
  };

  const onKeyDown = (e) => {
    if (e.key === 'Enter') generatePost();
  };

  // Intercept plain left-clicks on in-app links; let modified clicks
  // (new tab, etc.) fall through to native browser handling.
  const linkClick = (e, href) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    navigate(href);
  };

  const modelLabel = (value) => {
    if (!value) return '';
    const found = modelOptions.find((o) => o.value === value);
    return found ? found.label : value.replace(/^models\//, '');
  };

  const Header = () => (
    <header className="site-header">
      <div className="site-brand">
        <img src="/yt2txt.svg" alt="" className="site-logo" width="40" height="40" />
        <h1>yt2txt</h1>
      </div>
      <p>Converting visual noise into structured wisdom.</p>
      <nav className="site-nav">
        <a
          href="/"
          className={`nav-link ${page === 'home' ? 'nav-link--active' : ''}`}
          onClick={(e) => linkClick(e, '/')}
        >
          Home
        </a>
        <a
          href="/history"
          className={`nav-link ${page === 'history' ? 'nav-link--active' : ''}`}
          onClick={(e) => linkClick(e, '/history')}
        >
          History {history.length > 0 && <span className="nav-badge">{history.length}</span>}
        </a>
        <a
          href="/people"
          className={`nav-link ${page === 'people' ? 'nav-link--active' : ''}`}
          onClick={(e) => linkClick(e, '/people')}
        >
          People
        </a>
      </nav>
    </header>
  );

  // ── Summary detail (derived from /summary/<videoId>) ──────────────────────
  if (summaryId) {
    return (
      <div className="page-shell">
        <div className="container">
          <Header />
          {!historyLoaded ? (
            <div className="empty-state">Loading…</div>
          ) : detailItem ? (
            <>
              <div className="article-actions">
                <button className="btn btn--secondary" onClick={() => navigate('/history')}>
                  ← Back to History
                </button>
                <button className="btn btn--secondary" onClick={() => downloadMarkdown(detailItem.summary)}>
                  Download .md
                </button>
              </div>
              {detailItem.model && (
                <div className="summary-meta">
                  <span className="model-tag">{modelLabel(detailItem.model)}</span>
                </div>
              )}
              <article className="prose">
                <ReactMarkdown urlTransform={MARKDOWN_URL_TRANSFORM} components={MARKDOWN_COMPONENTS}>{detailItem.summary}</ReactMarkdown>
              </article>
            </>
          ) : (
            <div className="empty-state">
              Summary not found.{' '}
              <a href="/history" onClick={(e) => linkClick(e, '/history')}>Back to History</a>
            </div>
          )}
        </div>
      </div>
    );
  }

  // ── People ────────────────────────────────────────────────────────────────
  if (page === 'people') {
    return (
      <div className="page-shell">
        <div className="container">
          <Header />
          <People />
        </div>
      </div>
    );
  }

  // ── History list ──────────────────────────────────────────────────────────
  if (page === 'history') {
    return (
      <div className="page-shell">
        <div className="container">
          <Header />
          {history.length === 0 ? (
            <div className="empty-state">No summaries yet. Generate one from the Home page.</div>
          ) : (
            <div className="history-list">
              {history.map((item, i) => {
                const href = summaryPath(item);
                return (
                  <a
                    key={i}
                    href={href}
                    className="history-list-card"
                    onClick={(e) => linkClick(e, href)}
                  >
                    <div className="history-list-meta">
                      <span className="history-date">{item.date}</span>
                      {item.model && <span className="model-tag">{modelLabel(item.model)}</span>}
                    </div>
                    <h3 className="history-list-title">{item.title || item.url}</h3>
                    {item.summary && (
                      <p className="history-list-snippet">
                        {item.summary.replace(/^#+\s.+\n?/gm, '').replace(/[*_`#]/g, '').trim().slice(0, 200)}…
                      </p>
                    )}
                    <span className="history-list-url">{item.url}</span>
                  </a>
                );
              })}
            </div>
          )}
        </div>
      </div>
    );
  }

  // ── Home ──────────────────────────────────────────────────────────────────
  return (
    <div className="page-shell">
      <div className="container">
        <Header />

        <div className="input-card">
          <select
            value={model}
            onChange={(e) => setModel(e.target.value)}
            disabled={loading}
            aria-label="Model"
          >
            {modelOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <input
            type="text"
            placeholder="Paste YouTube URL..."
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={onKeyDown}
          />
          <button
            className="btn btn--primary"
            onClick={generatePost}
            disabled={loading}
          >
            {loading ? 'Analysing…' : 'Generate'}
          </button>
        </div>

        {history.length > 0 ? (
          <section className="history-section">
            <h2>Past Summaries</h2>
            <div className="history-grid">
              {history.map((item, i) => {
                const href = summaryPath(item);
                return (
                  <a
                    key={i}
                    href={href}
                    className="history-card"
                    onClick={(e) => linkClick(e, href)}
                  >
                    <div className="history-date">{item.date}</div>
                    <span className="history-title">{item.title || item.url}</span>
                    <span className="history-url">{item.url}</span>
                    {item.model && <span className="model-tag">{modelLabel(item.model)}</span>}
                  </a>
                );
              })}
            </div>
          </section>
        ) : (
          <div className="empty-state">
            No summaries yet. Paste a YouTube URL above to generate one.
          </div>
        )}
      </div>
    </div>
  );
};

export default BrightBlogApp;
```

- [ ] **Step 2: Add `text-decoration: none;` to `.nav-link` in `src/index.css`**

Find this rule (currently around line 310):

```css
.nav-link {
  background: none;
  border: none;
  font-family: var(--font-body);
```

Replace it with (add the `text-decoration` line):

```css
.nav-link {
  background: none;
  border: none;
  text-decoration: none;
  font-family: var(--font-body);
```

- [ ] **Step 3: Add `text-decoration` + `color` to `.history-list-card` in `src/index.css`**

Find this rule (currently around line 349):

```css
.history-list-card {
  display: block;
  width: 100%;
  text-align: left;
  background: var(--surface);
```

Replace it with:

```css
.history-list-card {
  display: block;
  width: 100%;
  text-align: left;
  text-decoration: none;
  color: inherit;
  background: var(--surface);
```

- [ ] **Step 4: Add `text-decoration` + `color` to `.history-card` in `src/index.css`**

Find this rule (currently around line 419):

```css
.history-card {
  display: block;
  width: 100%;
  text-align: left;
  background: var(--surface);
```

Replace it with:

```css
.history-card {
  display: block;
  width: 100%;
  text-align: left;
  text-decoration: none;
  color: inherit;
  background: var(--surface);
```

- [ ] **Step 5: Verify the build succeeds**

Run: `make build`
Expected: build completes with no errors, `dist/` produced. A JSX or import error fails here.

- [ ] **Step 6: Smoke-check in the browser**

Run: `make dev`, open `http://localhost:5173`.
Expected:
- Page loads on `/`; the three nav links (Home/History/People) look visually identical to before (no underline, correct colours).
- Clicking **History** changes the address bar to `/history`; clicking **People** → `/people`; clicking **Home** → `/`.
- The People page still works (its list and a person detail open as before — `People.jsx` was not changed).

Stop `make dev` (Ctrl-C) when done.

- [ ] **Step 7: Commit**

```bash
git add src/App.jsx src/index.css
git commit -m "$(cat <<'EOF'
feat: reflect the current view in the URL bar

Derive page/summaryId/detailItem from the path via useLocation. Nav
items and summary cards become real <a> links; Generate navigates to
the new summary's /summary/<videoId> page.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Document the infra dependency in CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add a routing bullet to the "Things that will bite you" section**

In `CLAUDE.md`, find the `## CI` heading and insert a new bullet immediately before it. Replace:

```
## CI
```

with:

```
- **Client-side routing depends on `spa_mode`**: `App.jsx` uses the History API (`src/useLocation.js`) for `/`, `/history`, `/people`, and `/summary/<videoId>`. Refreshing a non-root path works only because `StaticSite(spa_mode=True)` maps CloudFront 403/404 → `index.html`, **and** Vite emits absolute asset paths. Never set `base: './'` in the Vite config — it would make assets resolve relative to the route and break every non-root URL.

## CI
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "$(cat <<'EOF'
docs: note client-side routing depends on spa_mode

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Full manual verification

No code changes — this is the acceptance gate. It needs a real backend, so ensure `VITE_LAMBDA_URL` is set in `.env` (steps 3–8 depend on it; steps 1–2 and 9 work without it).

**Files:** none.

- [ ] **Step 1: Start the dev server**

Run: `make dev`, open `http://localhost:5173`.

- [ ] **Step 2: Top-level navigation**

Click each nav item. Expected: address bar shows `/`, `/history`, `/people`; the active nav link is highlighted for each.

- [ ] **Step 3: Open a summary**

On Home or History, click a past-summary card. Expected: address bar becomes `/summary/<videoId>`; the correct summary renders; the **History** nav link is highlighted.

- [ ] **Step 4: Generate a summary**

On Home, paste a YouTube URL and click Generate. Expected: on success the address bar becomes `/summary/<videoId>` and the full summary renders on its own page (not truncated).

- [ ] **Step 5: Browser Back/Forward**

Using the browser Back and Forward buttons, move across Home → History → a summary → People. Expected: the on-screen view always matches the address bar — no stale or wrong content.

- [ ] **Step 6: Refresh on each URL shape**

Refresh the page while on `/`, `/history`, `/people`, and `/summary/<videoId>` in turn. Expected: each restores its view. `/summary/<id>` shows a brief "Loading…" then the summary.

- [ ] **Step 7: New tab**

Middle-click (or Cmd/Ctrl-click) a nav link and a summary card. Expected: each opens that view in a new tab.

- [ ] **Step 8: Not-found summary**

In the address bar, enter `/summary/nonexistent-id` and load it. Expected: "Summary not found." with a working "Back to History" link.

- [ ] **Step 9: Unknown route**

In the address bar, enter `/xyz` and load it. Expected: redirected to `/` (Home).

- [ ] **Step 10: People regression check**

Go to `/people`, open a person, let it poll, then click a nav link away. Expected: the People page and its detail behave exactly as before this change.

Stop `make dev` (Ctrl-C) when done. If every step passed, the feature is complete.

---

## Plan self-review

- **Spec coverage:** `useLocation.js` hook (Task 1) ✓; four-URL mapping + derived `page`/`summaryId`/`detailItem` (Task 2) ✓; `videoIdFromUrl` with fallback (Task 2) ✓; `historyLoaded` loading / not-found states (Task 2) ✓; Generate → `/summary/<id>` with full markdown, `content`/`contentModel` removed (Task 2) ✓; nav + cards as `<a>` (Task 2) ✓; scroll reset + unknown-route redirect (Task 2) ✓; CSS for `<a>` styling (Task 2) ✓; `People.jsx` untouched ✓; CLAUDE.md note (Task 3) ✓; manual verification incl. the spec's 8-point checklist (Task 4) ✓.
- **Placeholder scan:** none — every step contains exact file content or exact commands.
- **Type consistency:** `useLocation`/`navigate` signatures match between `useLocation.js` and `App.jsx`; `videoIdFromUrl`, `summaryPath`, `decodeId`, `linkClick`, `KNOWN_PATHS` are each defined once and used consistently.
