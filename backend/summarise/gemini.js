import { isRetryableModelError, sleep, withTimeout } from "./people-pure.js";

// The one Gemini call loop. Both callers walk the same model chain — try a
// model, classify the error, advance — and used to keep private copies of that
// walk. They differ only in tuning, so every difference is an option here
// rather than a second copy of the loop:
//
//   handler.js (request path)  attempts 1, no backoff, no timeout, and a
//                              non-retryable error is rethrown so the request
//                              fails fast with a 500.
//   people.js  (worker path)   attempts MAX_RETRIES_PER_MODEL with exponential
//                              backoff, a per-call timeout, and a non-retryable
//                              error advances to the next model instead of
//                              killing the whole job.
//
// Takes `ai` as an argument and imports nothing but people-pure.js, so it stays
// importable without @google/genai or the AWS SDK.

const defaultExtractText = (response) => response.text;

/**
 * Walk `chain`, returning the first model that produced a response.
 *
 * @param ai                     a GoogleGenAI instance
 * @param chain                  model ids to try in order (see buildModelChain)
 * @param contents               generateContent `contents`
 * @param config                 generateContent `config` (omitted when absent)
 * @param attempts               tries per model before advancing (1 = one try)
 * @param backoffMs              (attempt) => ms to wait before retrying the
 *                               same model; omit for no wait
 * @param timeoutMs              per-call ceiling; 0 disables the timeout
 * @param extractText            (response) => string, defaults to response.text
 * @param requireText            treat empty text as a failed attempt
 * @param throwOnNonRetryable    rethrow instead of advancing to the next model
 * @param onResponse             (response, model) => void, on a resolved call
 * @param onRetryableError       (err, model, attempt) => void
 *
 * @returns { ok: true, model, text, response } — `model` is the one that
 *          actually produced the summary, which callers persist.
 *          { ok: false, error } when the chain is exhausted; `error` is the
 *          last error seen (undefined only if `chain` was empty). Exhaustion is
 *          returned rather than thrown because the two callers report it
 *          differently — a 503 body vs. a rethrow onto the video row.
 */
export async function generateWithFallback(ai, {
  chain,
  contents,
  config,
  attempts = 1,
  backoffMs,
  timeoutMs = 0,
  extractText = defaultExtractText,
  requireText = false,
  throwOnNonRetryable = false,
  onResponse,
  onRetryableError,
} = {}) {
  let lastErr;

  for (const model of chain || []) {
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const call = ai.models.generateContent({
          model,
          contents,
          ...(config ? { config } : {}),
        });
        const response = timeoutMs > 0 ? await withTimeout(call, timeoutMs) : await call;
        onResponse?.(response, model);
        const text = extractText(response);
        if (requireText && !text) throw new Error("empty response");
        return { ok: true, model, text, response };
      } catch (err) {
        lastErr = err;
        if (!isRetryableModelError(err)) {
          if (throwOnNonRetryable) throw err;
          break; // another attempt at this model cannot help — next model
        }
        onRetryableError?.(err, model, attempt);
        if (backoffMs && attempt < attempts - 1) await sleep(backoffMs(attempt));
      }
    }
  }

  return { ok: false, error: lastErr };
}
