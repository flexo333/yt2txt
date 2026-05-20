# Dynamic Model Dropdown Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Populate the model picker dropdown dynamically from Google's live model catalogue, eliminating the hand-maintained `MODEL_OPTIONS` / `ALLOWED_MODELS` duplication.

**Architecture:** The Lambda gains a `getAllowedModels()` helper that calls `ai.models.list()`, filters to Flash-family Gemini + Gemma models via a pure `filterModels()` function, caches the result in module scope (24h on success, 5min on fallback), and falls back to a static list on error. The same filtered list backs both the `?models=1` endpoint (consumed by the frontend dropdown) and the `isAllowedModel()` request validator — so the dropdown and the allow-list are identical by construction. The frontend fetches `?models=1` on mount and renders a static fallback while the fetch is pending or if it fails.

**Tech Stack:** Node.js ESM Lambda (`@google/genai` v1.x), Vite + React SPA, no test framework (verification is local smoke tests + manual browser checks).

**Reference spec:** `docs/superpowers/specs/2026-05-20-dynamic-model-dropdown-design.md`

**Important environment notes:**
- This repo has **no test framework and no linter** (`CLAUDE.md`). Do not invent `make test` / `make lint`. Verification is done with `node` smoke tests, `make build`, and manual checks.
- Backend smoke tests that hit the Gemini API need `GEMINI_API_KEY`. The repo-root `.env` has it. Load it with `set -a; . ../../.env; set +a` from inside `backend/summarise/`.
- The Lambda `node_modules/` (built by `make build-lambda`) is present and the packages are pure JS, so importing `handler.js` with host `node` works.

---

## File Structure

- **Modify** `backend/summarise/handler.js` — add model filtering/caching, rewrite `listModels()` and `isAllowedModel()`, remove the static `ALLOWED_MODELS` map. All model logic stays in this file per the approved spec.
- **Modify** `src/App.jsx` — fetch `?models=1` on mount, keep a static fallback constant, derive the default selection.
- **Modify** `CLAUDE.md` — replace the now-obsolete "edit both lists" warnings with a description of the dynamic mechanism.

---

## Task 1: Backend — pure model filter + static fallback list

Adds the pure `filterModels()` function, its `isWantedModel()` helper, the `FALLBACK_MODELS` constant, and the cache-TTL constants. This task is **non-breaking** — it only adds code; the existing `ALLOWED_MODELS` map and all current behaviour stay intact.

**Files:**
- Modify: `backend/summarise/handler.js`

- [ ] **Step 1: Add the filter, fallback, and TTL constants**

In `backend/summarise/handler.js`, insert the following block immediately **after** the line `const DEFAULT_MODEL = ALLOWED_MODELS["Gemini 3 Flash"];` (around line 37) and before `function extractTitle(markdown) {`:

```javascript

const MODEL_CACHE_SUCCESS_TTL_MS = 24 * 60 * 60 * 1000;
const MODEL_CACHE_FALLBACK_TTL_MS = 5 * 60 * 1000;

// Used when ai.models.list() fails or returns nothing usable, so summarising
// and request validation never hard-fail on a Google API hiccup.
const FALLBACK_MODELS = [
  { value: "models/gemini-3-flash-preview", label: "Gemini 3 Flash" },
  { value: "models/gemini-flash-lite-latest", label: "Gemini 3.1 Flash Lite" },
  { value: "models/gemini-2.5-flash", label: "Gemini 2.5 Flash" },
  { value: "models/gemini-2.5-flash-lite", label: "Gemini 2.5 Flash Lite" },
  { value: "models/gemma-4-31b-it", label: "Gemma 4 31B" },
  { value: "models/gemma-4-26b-a4b-it", label: "Gemma 4 26B" },
];

function isWantedModel(name) {
  const n = name.toLowerCase();
  if (n.includes("gemma")) return true;
  if (n.includes("gemini") && n.includes("flash")) {
    return !["tts", "image", "audio", "live"].some((bad) => n.includes(bad));
  }
  return false;
}

// Pure: maps raw @google/genai Model objects to sorted [{ value, label }].
// Exported so it can be smoke-tested without a network call.
export function filterModels(rawModels) {
  const wanted = (rawModels || []).filter(
    (m) =>
      m &&
      typeof m.name === "string" &&
      (m.supportedActions || []).includes("generateContent") &&
      isWantedModel(m.name),
  );
  const toOption = (m) => ({ value: m.name, label: m.displayName || m.name });
  const byNameDesc = (a, b) => b.value.localeCompare(a.value);
  const gemini = wanted
    .filter((m) => m.name.toLowerCase().includes("gemini"))
    .map(toOption)
    .sort(byNameDesc);
  const gemma = wanted
    .filter((m) => !m.name.toLowerCase().includes("gemini"))
    .map(toOption)
    .sort(byNameDesc);
  return [...gemini, ...gemma];
}
```

- [ ] **Step 2: Syntax-check the file**

Run:
```bash
cd backend/summarise && node --check handler.js
```
Expected: no output, exit code 0 (a syntax error would print a stack trace).

- [ ] **Step 3: Smoke-test `filterModels` with sample data**

Run from `backend/summarise/`:
```bash
node --input-type=module -e '
import { filterModels } from "./handler.js";
const sample = [
  { name: "models/gemini-2.5-flash", displayName: "Gemini 2.5 Flash", supportedActions: ["generateContent"] },
  { name: "models/gemini-3-flash-preview", displayName: "Gemini 3 Flash", supportedActions: ["generateContent"] },
  { name: "models/gemini-2.5-pro", displayName: "Gemini 2.5 Pro", supportedActions: ["generateContent"] },
  { name: "models/gemini-2.5-flash-preview-tts", displayName: "TTS", supportedActions: ["generateContent"] },
  { name: "models/gemini-2.5-flash-image", displayName: "Image", supportedActions: ["generateContent"] },
  { name: "models/gemma-4-31b-it", displayName: "Gemma 4 31B", supportedActions: ["generateContent"] },
  { name: "models/text-embedding-004", displayName: "Embed", supportedActions: ["embedContent"] },
];
console.log(JSON.stringify(filterModels(sample), null, 2));
'
```
Expected output: a JSON array with exactly **three** entries — `models/gemini-3-flash-preview`, `models/gemini-2.5-flash` (Gemini, name-descending), then `models/gemma-4-31b-it`. The Pro, TTS, image, and embedding models are excluded.

- [ ] **Step 4: Commit**

```bash
git add backend/summarise/handler.js
git commit -m "$(cat <<'EOF'
feat: add pure model filter and static fallback list

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Backend — `getAllowedModels()` with caching and fallback

Adds the cached, network-backed `getAllowedModels()` helper. Still **non-breaking** — nothing calls it yet.

**Files:**
- Modify: `backend/summarise/handler.js`

- [ ] **Step 1: Add the cache and `getAllowedModels()`**

In `backend/summarise/handler.js`, insert the following block immediately **after** the `filterModels` function added in Task 1 and before `function extractTitle(markdown) {`:

```javascript

let modelCache = { expires: 0, list: null };

// Returns [{ value, label }] of allowed models. Cached in module scope:
// 24h after a successful fetch, 5min after a fallback so it retries soon.
async function getAllowedModels() {
  if (modelCache.list && Date.now() < modelCache.expires) {
    return modelCache.list;
  }
  let list;
  let ttl;
  try {
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY, apiVersion: "v1beta" });
    const pager = await ai.models.list({});
    const raw = [];
    for await (const model of pager) {
      raw.push(model);
      if (raw.length >= 500) break;
    }
    list = filterModels(raw);
    if (list.length === 0) {
      console.warn("models.list returned no matching models, using fallback");
      list = FALLBACK_MODELS;
      ttl = MODEL_CACHE_FALLBACK_TTL_MS;
    } else {
      ttl = MODEL_CACHE_SUCCESS_TTL_MS;
    }
  } catch (err) {
    console.error("models.list failed, using fallback", err);
    list = FALLBACK_MODELS;
    ttl = MODEL_CACHE_FALLBACK_TTL_MS;
  }
  modelCache = { expires: Date.now() + ttl, list };
  return list;
}
```

- [ ] **Step 2: Syntax-check the file**

Run:
```bash
cd backend/summarise && node --check handler.js
```
Expected: no output, exit code 0.

- [ ] **Step 3: Smoke-test `getAllowedModels()` against the live API**

Run from `backend/summarise/`:
`getAllowedModels()` is module-internal (not exported); it is exercised end-to-end via the `?models=1` path in Task 3. Here, confirm the live `models.list()` call plus `filterModels()` produce Flash/Gemma models. Run from `backend/summarise/`:
```bash
set -a; . ../../.env; set +a
node --input-type=module -e '
import { filterModels } from "./handler.js";
import { GoogleGenAI } from "@google/genai";
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY, apiVersion: "v1beta" });
const raw = [];
for await (const m of await ai.models.list({})) { raw.push(m); }
console.log("raw models from API:", raw.length);
console.log(JSON.stringify(filterModels(raw), null, 2));
'
```
Expected: prints a non-zero raw count, then a JSON array containing Flash-family Gemini and Gemma models only (no Pro, no embedding/TTS/image). If the array is non-empty, the filter works against real API data.

- [ ] **Step 4: Commit**

```bash
git add backend/summarise/handler.js
git commit -m "$(cat <<'EOF'
feat: add cached getAllowedModels helper

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Backend — wire dynamic list into the handler

Removes the static `ALLOWED_MODELS` map and rewires `DEFAULT_MODEL`, `isAllowedModel()`, `listModels()`, and the two `POST` validation sites to use `getAllowedModels()`. This is the **behaviour-changing** task.

**Files:**
- Modify: `backend/summarise/handler.js`

- [ ] **Step 1: Remove `ALLOWED_MODELS` and make `DEFAULT_MODEL` a literal**

Replace this block (around lines 28-37):

```javascript
const ALLOWED_MODELS = {
  "Gemma 4 26B": "models/gemma-4-26b-a4b-it",
  "Gemma 4 31B": "models/gemma-4-31b-it",
  "Gemini 2.5 Flash": "models/gemini-2.5-flash",
  "Gemini 3 Flash": "models/gemini-3-flash-preview",
  "Gemini 3.1 Flash Lite": "models/gemini-flash-lite-latest",
  "Gemini 2.5 Flash Lite": "models/gemini-2.5-flash-lite",
};

const DEFAULT_MODEL = ALLOWED_MODELS["Gemini 3 Flash"];
```

with:

```javascript
const DEFAULT_MODEL = "models/gemini-3-flash-preview";
```

- [ ] **Step 2: Rewrite `isAllowedModel`**

Replace the existing function:

```javascript
function isAllowedModel(model) {
  return Object.values(ALLOWED_MODELS).includes(model);
}
```

with:

```javascript
async function isAllowedModel(model) {
  const models = await getAllowedModels();
  return models.some((m) => m.value === model);
}
```

- [ ] **Step 3: Rewrite `listModels`**

Replace the entire existing `listModels` function:

```javascript
async function listModels() {
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY, apiVersion: "v1beta" });
  const pager = await ai.models.list({});
  const names = [];
  for await (const model of pager) {
    if (model?.name) names.push(model.name);
    if (names.length >= 200) break;
  }

  return {
    statusCode: 200,
    headers: JSON_HEADERS,
    body: JSON.stringify({ models: names }),
  };
}
```

with:

```javascript
async function listModels() {
  const models = await getAllowedModels();
  return {
    statusCode: 200,
    headers: JSON_HEADERS,
    body: JSON.stringify({ models }),
  };
}
```

- [ ] **Step 4: `await` the research-path validation**

In the `handler` function, in the `body.action === "research"` branch, replace:

```javascript
        const model = body.model || DEFAULT_MODEL;
        if (!isAllowedModel(model)) {
          return { statusCode: 400, headers: JSON_HEADERS, body: JSON.stringify({ error: "model not supported" }) };
        }
```

with:

```javascript
        const model = body.model || DEFAULT_MODEL;
        if (!(await isAllowedModel(model))) {
          return { statusCode: 400, headers: JSON_HEADERS, body: JSON.stringify({ error: "model not supported" }) };
        }
```

- [ ] **Step 5: `await` the summarise-path validation and drop the removed `ALLOWED_MODELS` reference**

In the `handler` function, in the summarise `POST` path, replace:

```javascript
      const model = body.model || DEFAULT_MODEL;
      if (!isAllowedModel(model)) {
        return {
          statusCode: 400,
          headers: JSON_HEADERS,
          body: JSON.stringify({
            error: "model is not supported",
            allowedModels: ALLOWED_MODELS,
          }),
        };
      }
```

with:

```javascript
      const model = body.model || DEFAULT_MODEL;
      if (!(await isAllowedModel(model))) {
        return {
          statusCode: 400,
          headers: JSON_HEADERS,
          body: JSON.stringify({ error: "model is not supported" }),
        };
      }
```

- [ ] **Step 6: Syntax-check and confirm `ALLOWED_MODELS` is fully gone**

Run:
```bash
cd backend/summarise && node --check handler.js && grep -n "ALLOWED_MODELS" handler.js
```
Expected: `node --check` produces no output; `grep` produces **no output** (exit code 1) — there must be zero remaining references to `ALLOWED_MODELS`.

- [ ] **Step 7: Smoke-test the `?models=1` endpoint locally**

Run from `backend/summarise/`:
```bash
set -a; . ../../.env; set +a
node --input-type=module -e '
import { handler } from "./handler.js";
const auth = process.env.SHARED_SECRET ? { "x-yt2txt-key": process.env.SHARED_SECRET } : {};
const res = await handler({ httpMethod: "GET", headers: auth, queryStringParameters: { models: "1" } });
console.log("status:", res.statusCode);
console.log(res.body);
'
```
Expected: `status: 200` and a body `{"models":[{"value":...,"label":...}, ...]}` containing only Flash-family Gemini and Gemma models.

- [ ] **Step 8: Smoke-test that an off-list model is rejected**

Run from `backend/summarise/`:
```bash
set -a; . ../../.env; set +a
node --input-type=module -e '
import { handler } from "./handler.js";
const auth = process.env.SHARED_SECRET ? { "x-yt2txt-key": process.env.SHARED_SECRET } : {};
const res = await handler({
  httpMethod: "POST",
  headers: auth,
  body: JSON.stringify({ url: "https://youtu.be/dQw4w9WgXcQ", model: "models/gemini-2.5-pro" }),
});
console.log("status:", res.statusCode);
console.log(res.body);
'
```
Expected: `status: 400` and body `{"error":"model is not supported"}` (Pro is not in the filtered list).

- [ ] **Step 9: Commit**

```bash
git add backend/summarise/handler.js
git commit -m "$(cat <<'EOF'
feat: validate and list models from live Gemini catalogue

Removes the hand-maintained ALLOWED_MODELS map. isAllowedModel and the
?models=1 endpoint now both derive from getAllowedModels(), so the
request allow-list and the dropdown can never drift.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Frontend — populate the dropdown from `?models=1`

Makes `src/App.jsx` fetch the model list on mount, with the current six entries as a static fallback.

**Files:**
- Modify: `src/App.jsx`

- [ ] **Step 1: Replace `MODEL_OPTIONS` with a fallback constant + preferred default**

In `src/App.jsx`, replace this block (around lines 25-32):

```javascript
const MODEL_OPTIONS = [
  { label: 'Gemma 4 26B', value: 'models/gemma-4-26b-a4b-it' },
  { label: 'Gemma 4 31B', value: 'models/gemma-4-31b-it' },
  { label: 'Gemini 2.5 Flash', value: 'models/gemini-2.5-flash' },
  { label: 'Gemini 3 Flash', value: 'models/gemini-3-flash-preview' },
  { label: 'Gemini 3.1 Flash Lite', value: 'models/gemini-flash-lite-latest' },
  { label: 'Gemini 2.5 Flash Lite', value: 'models/gemini-2.5-flash-lite' },
];
```

with:

```javascript
const PREFERRED_DEFAULT = 'models/gemini-3-flash-preview';

// Rendered while the ?models=1 fetch is pending or if it fails.
const FALLBACK_MODEL_OPTIONS = [
  { label: 'Gemini 3 Flash', value: 'models/gemini-3-flash-preview' },
  { label: 'Gemini 3.1 Flash Lite', value: 'models/gemini-flash-lite-latest' },
  { label: 'Gemini 2.5 Flash', value: 'models/gemini-2.5-flash' },
  { label: 'Gemini 2.5 Flash Lite', value: 'models/gemini-2.5-flash-lite' },
  { label: 'Gemma 4 31B', value: 'models/gemma-4-31b-it' },
  { label: 'Gemma 4 26B', value: 'models/gemma-4-26b-a4b-it' },
];
```

- [ ] **Step 2: Update the `model` state and add `modelOptions` state**

Replace this line (around line 41):

```javascript
  const [model, setModel] = useState('models/gemini-3-flash-preview');
```

with:

```javascript
  const [model, setModel] = useState(PREFERRED_DEFAULT);
  const [modelOptions, setModelOptions] = useState(FALLBACK_MODEL_OPTIONS);
```

- [ ] **Step 3: Add a `useEffect` that fetches the model list**

Immediately **after** the existing history-fetching `useEffect` (the one ending with `}, []);` around line 49), add:

```javascript

  useEffect(() => {
    if (!LAMBDA_URL) return;
    fetch(`${LAMBDA_URL}?models=1`, { headers: authHeaders() })
      .then(r => r.json())
      .then(({ models }) => {
        if (!Array.isArray(models) || models.length === 0) return;
        setModelOptions(models);
        setModel(prev => (models.some(m => m.value === prev) ? prev : models[0].value));
      })
      .catch(console.error);
  }, []);
```

- [ ] **Step 4: Render the dropdown from `modelOptions`**

In the `<select>` element (around line 201), replace:

```javascript
            {MODEL_OPTIONS.map((option) => (
```

with:

```javascript
            {modelOptions.map((option) => (
```

- [ ] **Step 5: Confirm no stale `MODEL_OPTIONS` references and build**

Run from the repo root:
```bash
grep -n "MODEL_OPTIONS" src/App.jsx
make build
```
Expected: `grep` prints only the two `FALLBACK_MODEL_OPTIONS` lines (the constant definition and its use in `useState`) — **no bare `MODEL_OPTIONS`**. `make build` completes with a successful Vite production build and no errors.

- [ ] **Step 6: Manual browser check**

Run `make dev`, open `http://localhost:5173`.
- Expected with a live `VITE_LAMBDA_URL` in `.env`: the model dropdown populates from the backend (open the dropdown, confirm Flash/Gemma entries).
- Expected without `VITE_LAMBDA_URL` or if the fetch fails: the dropdown still renders the six `FALLBACK_MODEL_OPTIONS` entries (the app never shows an empty dropdown).
Stop the dev server when done.

- [ ] **Step 7: Commit**

```bash
git add src/App.jsx
git commit -m "$(cat <<'EOF'
feat: populate model dropdown from the live ?models=1 endpoint

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Docs — update `CLAUDE.md`

The "edit both lists" warnings are now obsolete and must be replaced.

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update the Frontend architecture paragraph**

In `CLAUDE.md`, replace:

```
**Frontend (`src/`, `index.html`)** — single `App.jsx` component (no router, just `page` state). On mount it `GET`s `VITE_LAMBDA_URL` to hydrate history; "Generate" `POST`s `{ url, model }`. `MODEL_OPTIONS` in `App.jsx` **must stay in sync with `ALLOWED_MODELS` in `backend/summarise/handler.js`** — the Lambda rejects anything not in its allow-list.
```

with:

```
**Frontend (`src/`, `index.html`)** — single `App.jsx` component (no router, just `page` state). On mount it `GET`s `VITE_LAMBDA_URL` to hydrate history and `GET`s `?models=1` to populate the model dropdown; "Generate" `POST`s `{ url, model }`. The dropdown is populated dynamically — `FALLBACK_MODEL_OPTIONS` in `App.jsx` is only rendered if that fetch fails.
```

- [ ] **Step 2: Update the `?models=1` endpoint description**

In `CLAUDE.md`, replace:

```
- `GET ?models=1` → list available Gemini models (for debugging)
```

with:

```
- `GET ?models=1` → list allowed models as `[{ value, label }]` (Flash-family Gemini + Gemma); consumed by the frontend dropdown
```

- [ ] **Step 3: Replace the duplication warning in "Things that will bite you"**

In `CLAUDE.md`, replace:

```
- **Allowed-model list** is duplicated between frontend (`MODEL_OPTIONS` in `App.jsx`) and backend (`ALLOWED_MODELS` in `handler.js`). When adding/removing a model, edit both.
```

with:

```
- **Allowed-model list is dynamic**: `handler.js` derives it from `ai.models.list()` via `filterModels()` (Flash-family Gemini + Gemma), cached 24h. The same list backs both `?models=1` and `isAllowedModel()`, so the dropdown and the request allow-list cannot drift. To change which models appear, edit the `isWantedModel()` filter — not a hand-kept list. `FALLBACK_MODELS` (backend) and `FALLBACK_MODEL_OPTIONS` (frontend) are only used when the live fetch fails; keep them roughly current but they are not load-bearing.
```

- [ ] **Step 4: Verify the edits landed**

Run from the repo root:
```bash
grep -n "MODEL_OPTIONS\|ALLOWED_MODELS\|dynamic" CLAUDE.md
```
Expected: no mention of `ALLOWED_MODELS`; the `?models=1` and "dynamic" lines are present.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md
git commit -m "$(cat <<'EOF'
docs: describe the dynamic model list in CLAUDE.md

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Deploy and verify in production

⚠️ **This task deploys to production AWS.** Run it only with explicit user go-ahead — do not run the deploy commands autonomously.

**Files:** none (deploy only)

- [ ] **Step 1: Rebuild the Lambda dependencies**

Run from the repo root:
```bash
make build-lambda
```
Expected: `backend/summarise/node_modules/` is (re)installed for `linux/amd64`.

- [ ] **Step 2: Deploy the Lambda**

Run from the repo root:
```bash
make infra-up
```
Expected: Pulumi applies; the Lambda code is updated with the new handler.

- [ ] **Step 3: Verify the `?models=1` endpoint in production**

Get the API URL with `make infra-outputs`, then:
```bash
curl -s '<api_url>?models=1' -H 'x-yt2txt-key: <SHARED_SECRET from .env>'
```
Expected: `{"models":[{"value":...,"label":...}, ...]}` listing Flash-family Gemini + Gemma models.

- [ ] **Step 4: Deploy the frontend**

Run from the repo root:
```bash
make deploy
```
Expected: `dist/` is rebuilt with the live `VITE_LAMBDA_URL`, synced to S3, CloudFront invalidated.

- [ ] **Step 5: Verify in the live site**

Open `https://yt2txt.willbright.link`. Confirm the model dropdown is populated from the live endpoint, generate a summary with a listed model, and confirm it succeeds.

---

## Self-Review Notes

- **Spec coverage:** filtering policy → Task 1; `getAllowedModels` + 24h cache + fallback → Tasks 1-2; `listModels` rewrite + async `isAllowedModel` + `FALLBACK_MODELS` + `ALLOWED_MODELS` removal → Task 3; frontend fetch + fallback + default → Task 4; `CLAUDE.md` → Task 5; verification (`curl`, browser, 400 for `gemini-2.5-pro`) → Tasks 3 & 6.
- **Out of scope (per spec non-goals):** quota-aware model fallback / output tagging — tracked as Feature 2, separate cycle.
- **Type consistency:** model options are `{ value, label }` everywhere — `FALLBACK_MODELS`, `filterModels()` output, `?models=1` body, `FALLBACK_MODEL_OPTIONS`, and the `<select>` render. `getAllowedModels()` returns that array; `isAllowedModel()` checks `m.value`.
- **Fallback TTL refinement:** the spec says "24h TTL"; this plan caches successful fetches 24h and fallback results 5min so an outage self-heals quickly. This is an error-handling detail consistent with the spec's "never hard-fail" intent.
