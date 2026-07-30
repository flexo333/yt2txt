// Pure, dependency-free event classification for the two Lambda entries.
//
// One code bundle, two functions: `web.js` sits behind the Function URL,
// `worker.js` behind EventBridge and the self-invokes. This module is the only
// place that says which event belongs to which, so the split cannot drift — and
// it imports nothing, so `dispatch-pure.test.mjs` can pin it under bare `node`.

// The internally-invoked job types, keyed by the magic event attribute that
// selects them. Only worker.js dispatches on these; the request path must never
// see one, which is exactly what isHttpEvent() below enforces.
export const JOB_KINDS = Object.freeze({
  __personJob: "person",
  __backfill: "backfill",
  __resumeJobs: "resume",
});

// The job an internal invoke is asking for, or null when the event names none.
export function jobKindFor(event) {
  if (!event || typeof event !== "object") return null;
  for (const [key, kind] of Object.entries(JOB_KINDS)) {
    if (event[key]) return kind;
  }
  return null;
}

// True for a Lambda Function URL (or API Gateway proxy) request event. A job
// event is rejected outright rather than falling through to the default "GET":
// the web function is reachable from the internet, so "not an HTTP request" has
// to be an error, not a shrug.
export function isHttpEvent(event) {
  if (!event || typeof event !== "object") return false;
  if (jobKindFor(event)) return false;
  return !!(event.requestContext || event.httpMethod);
}
