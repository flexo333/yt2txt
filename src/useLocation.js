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
