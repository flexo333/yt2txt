// Dependency-free location helpers behind src/useLocation.js, kept apart from
// React so they can be smoke-tested under bare `node --test`.
//
// A "location key" is pathname + search as one string (e.g. '/share?url=A').
// It is what useLocation snapshots: a primitive, so useSyncExternalStore can
// compare snapshots with Object.is, but one that still changes when only the
// query string does — '/share?url=A' → '/share?url=B' must re-render.

export function locationKey({ pathname, search }) {
  return pathname + search;
}

// Inverse of locationKey: '/share?url=A' → { pathname: '/share', search: '?url=A' }.
export function splitLocation(key) {
  const q = key.indexOf('?');
  return q === -1
    ? { pathname: key, search: '' }
    : { pathname: key.slice(0, q), search: key.slice(q) };
}

// True when navigating to `target` (any href navigate() accepts — absolute
// path, relative, or full same-origin URL) would land on the location already
// shown at `currentHref`. The hash is ignored: the router never reads it.
export function isSameLocation(target, currentHref) {
  const current = new URL(currentHref);
  const next = new URL(target, current);
  return next.origin === current.origin
    && locationKey(next) === locationKey(current);
}
