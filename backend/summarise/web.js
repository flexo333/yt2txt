import { isHttpEvent } from "./dispatch-pure.js";
import { handleHttpRequest } from "./handler.js";
import { gzipResult } from "./compress.js";

// The public Lambda entry: everything behind the Function URL, and nothing
// else. Internally-invoked jobs (person research, the backfill, the resumer
// tick) run on the worker function over the same bundle — see worker.js — so
// this entry has no job branch, a 300 s timeout instead of 900, and a role that
// can neither delete a row nor invoke anything but the worker.
//
// `context` is deliberately not forwarded: the only callers that ever used it
// were the job branches, checking their remaining Lambda time.

const JSON_HEADERS = { "Content-Type": "application/json" };

export async function handler(event) {
  if (!isHttpEvent(event)) {
    // Reached only by a direct `aws lambda invoke` with the wrong payload —
    // a job event aimed at the wrong function, most likely. Say so loudly
    // rather than falling through to a default GET.
    console.error("web: unrecognised event, expected an HTTP request:", JSON.stringify(event ?? null));
    return {
      statusCode: 400,
      headers: JSON_HEADERS,
      body: JSON.stringify({ error: "unsupported event" }),
    };
  }
  // Compression lives here, not in handler.js: this is the single entry behind
  // the Function URL (which does not compress), so one call covers every
  // response and handler.js stays a plain request core.
  const headers = event.headers || {};
  const key = Object.keys(headers).find((k) => k.toLowerCase() === "accept-encoding");
  return gzipResult(await handleHttpRequest(event), key && headers[key]);
}
