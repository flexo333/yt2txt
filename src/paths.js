// Helpers that translate between stored summaries and the URLs that address
// them. Both the router (App.jsx) and every card that links into it go through
// these, so a link and the route that resolves it can never disagree.

import { videoIdFrom } from '../backend/summarise/youtube-url.js';

// The /summary/<id> segment for a stored row. `videoIdFrom` is the shared
// extractor — the same one the Lambda's `GET ?video=` lookup uses — so a link
// built here resolves server-side too. Rows are keyed by their canonical URL,
// so it only ever returns null for a legacy row whose url is not a recognisable
// YouTube link; that falls back to the raw url, which is unaddressable either
// way but at least keeps link-building and link-resolving in agreement.
export const summaryIdFor = (url) => videoIdFrom(url) || url;

export const summaryPath = (item) => `/summary/${encodeURIComponent(summaryIdFor(item.url))}`;

// decodeURIComponent throws on a malformed % sequence — never crash the render.
export const decodeId = (s) => {
  try { return decodeURIComponent(s); } catch { return s; }
};
