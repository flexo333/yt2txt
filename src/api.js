// Every network call the app makes lives here.
//
// The backend is a single Lambda behind a Function URL (no API Gateway), and
// the "routing" is HTTP method + query string — see backend/summarise/handler.js.
// There are two ways in, split by verb: GETs go through the site's own
// CloudFront distribution at /api/*, POSTs go direct to the Function URL (see
// READ_BASE and LAMBDA_URL below for why). Keeping both addresses, the auth
// header and the response shapes in one module means a change to any of them is
// a change to one file, and no component has to know how the Lambda is reached.

// GETs ride the site's own CloudFront distribution at /api/* — the same origin
// as the page, so the request reuses an open connection and costs no handshake
// and no CORS preflight. `vite dev` proxies /api to the same Lambda.
//
// The trailing slash is load-bearing: CloudFront's `/api/*` pattern does not
// match a bare `/api`.
const READ_BASE = '/api/';

// POSTs still go direct to the Function URL. CloudFront caps an origin response
// at 30 s and a summarise legitimately runs for minutes — dodging that ceiling
// is why the Function URL exists instead of API Gateway.
const LAMBDA_URL = import.meta.env.VITE_LAMBDA_URL;
const YT2TXT_KEY = import.meta.env.VITE_YT2TXT_KEY || '';

// Optional shared secret. Absent in local dev when the key is not configured,
// in which case the Lambda is expected to be open.
const authHeaders = () => (YT2TXT_KEY ? { 'x-yt2txt-key': YT2TXT_KEY } : {});

const jsonHeaders = () => ({ 'Content-Type': 'application/json', ...authHeaders() });

// False when the build was never given a backend (e.g. `vite dev` without
// VITE_LAMBDA_URL). Callers use this to skip fetches instead of firing a
// request at `undefined`.
export const hasBackend = Boolean(LAMBDA_URL);

// GET / → the 50 most recent summaries, newest first. Each row's `summary` is
// a 200-character plain-text snippet, already stripped of markdown server-side,
// and `truncated` is always true — a list row can never carry renderable
// markdown. The full markdown always comes from getSummary() (`?video=`).
export async function listSummaries() {
  const res = await fetch(READ_BASE, { headers: authHeaders() });
  const { summaries } = await res.json();
  return summaries || [];
}

// GET /?video=<id> → one summary with its full markdown, whatever its age.
// Resolves to null rather than throwing on 404 (never summarised) and on any
// other failure, including a Lambda predating this endpoint — callers then keep
// showing whatever the list gave them.
export async function getSummary(id) {
  try {
    const res = await fetch(
      `${READ_BASE}?video=${encodeURIComponent(id)}`,
      { headers: authHeaders() },
    );
    if (!res.ok) return null;
    const {
      url, markdown, title, date, model, videoTitle, channelTitle, speakers,
    } = await res.json();
    if (!markdown) return null;
    return {
      url,
      title,
      date,
      summary: markdown,
      model,
      videoTitle: videoTitle || null,
      channelTitle: channelTitle || null,
      speakers: speakers || [],
    };
  } catch (err) {
    console.error(err);
    return null;
  }
}

// POST / → summarise a video and persist it. The Lambda dedupes on url, so an
// already-summarised video comes back from cache — unless `regenerate` is set,
// which makes the Lambda re-watch the video and overwrite the stored row.
// Throws the response body on any non-2xx. Returns the history-item shape the
// UI stores (the Lambda calls the summary body `markdown`).
export async function createSummary(url, model, { regenerate = false } = {}) {
  const res = await fetch(LAMBDA_URL, {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify(regenerate ? { url, model, regenerate: true } : { url, model }),
  });
  if (!res.ok) throw new Error(await res.text());
  const {
    markdown, title, date, model: usedModel, videoTitle, channelTitle, speakers,
  } = await res.json();
  return {
    url,
    title,
    date,
    summary: markdown,
    model: usedModel,
    videoTitle: videoTitle || null,
    channelTitle: channelTitle || null,
    speakers: speakers || [],
  };
}

// GET /?models=1 → [{ value, label }] for the model dropdown. The Lambda
// derives this list live and validates POSTs against the same list, so the
// dropdown cannot drift from what the backend accepts. An empty array means
// "nothing usable came back" — callers keep whatever they were showing.
export async function listModels() {
  const res = await fetch(`${READ_BASE}?models=1`, { headers: authHeaders() });
  const { models } = await res.json();
  return Array.isArray(models) ? models : [];
}

// GET /?people=1 → every tracked person with their job status.
export async function listPeople() {
  const res = await fetch(`${READ_BASE}?people=1`, { headers: authHeaders() });
  const { people } = await res.json();
  return people || [];
}

// GET /?person=NAME → job status + per-video summaries + meta-summary.
// Resolves to null (rather than throwing) when the person is not found, which
// is the normal answer for a name that has never been researched.
export async function getPerson(person) {
  const res = await fetch(
    `${READ_BASE}?person=${encodeURIComponent(person)}`,
    { headers: authHeaders() },
  );
  if (!res.ok) return null;
  const data = await res.json();
  // Unknown person: the Lambda answers 200 + { found: false } (never a 404 —
  // see handler.js), so the "not found" case is spelled out here.
  return data.found === false ? null : data;
}

// POST { action: 'research' } → start a person-research job. The Lambda
// refuses while a job for that person is already active unless `force` is set,
// which is what the Retry button sends. Throws the response body on non-2xx.
export async function researchPerson(person, { force = false } = {}) {
  const payload = force
    ? { action: 'research', person, force: true }
    : { action: 'research', person };
  const res = await fetch(LAMBDA_URL, {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}
