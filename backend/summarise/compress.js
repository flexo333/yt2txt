// Lambda Function URLs do not compress responses, so every byte of JSON goes
// over the wire as-is. Measured on the history list: 32 KB raw -> ~10.6 KB
// gzipped. web.js applies gzipResult() to every response it returns.
//
// Builtins only (node:zlib) so this stays unit-testable under bare `node`.
import { gzipSync } from "node:zlib";

// Below this, gzip framing overhead plus CPU is not worth it.
export const MIN_GZIP_BYTES = 1024;

// True when the Accept-Encoding header offers gzip (or `*`) with a non-zero q.
export function acceptsGzip(acceptEncoding) {
  if (typeof acceptEncoding !== "string" || !acceptEncoding) return false;
  for (const part of acceptEncoding.split(",")) {
    const [coding, ...params] = part.trim().toLowerCase().split(";");
    if (coding.trim() !== "gzip" && coding.trim() !== "*") continue;
    let q = 1;
    for (const p of params) {
      const [k, v] = p.trim().split("=");
      if (k.trim() === "q") q = Number(v);
    }
    if (q > 0) return true;
  }
  return false;
}

// Returns a new Lambda response with the body gzipped + base64-encoded, or
// `result` itself when compression does not apply.
export function gzipResult(result, acceptEncoding) {
  if (!result) return result;
  const { body, headers } = result;
  if (typeof body !== "string" || body.length === 0) return result;
  if (result.isBase64Encoded) return result;
  if (headers && Object.keys(headers).some((k) => k.toLowerCase() === "content-encoding")) {
    return result;
  }
  if (Buffer.byteLength(body) < MIN_GZIP_BYTES) return result;
  if (!acceptsGzip(acceptEncoding)) return result;
  return {
    ...result,
    body: gzipSync(body).toString("base64"),
    isBase64Encoded: true,
    // Vary is mandatory: a shared cache (CloudFront) must not serve gzip to a
    // client that did not ask for it.
    headers: { ...headers, "Content-Encoding": "gzip", Vary: "Accept-Encoding" },
  };
}
