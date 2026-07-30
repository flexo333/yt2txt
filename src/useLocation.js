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

// Click handler for in-app <a href> links: intercept plain left-clicks so they
// route client-side, and let modified clicks (new tab, new window, download)
// fall through to native browser handling.
export function linkClick(e, href) {
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
  e.preventDefault();
  navigate(href);
}
