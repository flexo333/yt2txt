import { useMemo, useSyncExternalStore } from 'react';
import { locationKey, splitLocation, isSameLocation } from './location.js';

// Register the popstate listener inside subscribe (the function React calls),
// not at module scope, so Vite HMR cannot stack duplicate listeners.
const subscribe = (callback) => {
  window.addEventListener('popstate', callback);
  return () => window.removeEventListener('popstate', callback);
};

// Must return a primitive. Returning a fresh object each call would make
// useSyncExternalStore re-render infinitely. pathname + search, not pathname
// alone, so a query-only change ('/share?url=A' → '/share?url=B') re-renders.
const getSnapshot = () => locationKey(window.location);

// Subscribe to the current URL. Returns { pathname, search } and re-renders
// the component on every browser Back/Forward and on every navigate() call
// that changes either. The object is memoised on the snapshot string, so it
// is referentially stable across re-renders until the URL actually changes —
// safe to key effects on `pathname` or `search`.
export function useLocation() {
  const key = useSyncExternalStore(subscribe, getSnapshot);
  return useMemo(() => splitLocation(key), [key]);
}

// Programmatic navigation. pushState/replaceState do NOT emit popstate, so a
// synthetic one is dispatched — that way browser navigation and navigate()
// notify useLocation subscribers through a single code path. A no-op only
// when both path and query string already match.
export function navigate(path, { replace = false } = {}) {
  if (isSameLocation(path, window.location.href)) return;
  window.history[replace ? 'replaceState' : 'pushState']({}, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

// True only for an unmodified primary click — the one case where hijacking a
// link is safe. A Cmd/Ctrl/Shift-click or a middle-click is the user asking
// the browser for a new tab or window, and must reach it. Exported because
// every handler that calls preventDefault() on a link needs the same rule
// (Summary.jsx's timestamp links do), and a second copy of it would drift.
export function isPlainClick(e) {
  return !(e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0);
}

// Click handler for in-app <a href> links: intercept plain left-clicks so they
// route client-side, and let modified clicks (new tab, new window, download)
// fall through to native browser handling.
export function linkClick(e, href) {
  if (!isPlainClick(e)) return;
  e.preventDefault();
  navigate(href);
}
