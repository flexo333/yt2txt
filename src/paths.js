// Helpers that translate between stored summaries and the URLs that address
// them. Both the router (App.jsx) and every card that links into it go through
// these, so a link and the route that resolves it can never disagree.

// Extract a stable id from a stored YouTube URL (the DynamoDB hash key is the
// full url). Falls back to the raw url for unrecognised forms, so building a
// summary path and resolving it always use the same value.
export const videoIdFromUrl = (raw) => {
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

export const summaryPath = (item) => `/summary/${encodeURIComponent(videoIdFromUrl(item.url))}`;

// decodeURIComponent throws on a malformed % sequence — never crash the render.
export const decodeId = (s) => {
  try { return decodeURIComponent(s); } catch { return s; }
};
