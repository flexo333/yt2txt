# Quota-aware Model Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the chosen Gemini model is rate-limited, the sync summariser falls back through the allowed-model list instead of failing; every summary records which model produced it.

**Architecture:** `summarise()` in `handler.js` walks an ordered, capped chain of models (chosen first, then the rest of `getAllowedModels()`), advancing on retryable errors. The actually-used model is persisted on the DynamoDB item and surfaced in the API and UI. A shared `constants.js` removes a duplicated default-model literal. A stale `CLAUDE.md` line is removed.

**Tech Stack:** Node.js ESM Lambda (`@google/genai` v1.x), Vite + React SPA, no test framework (verification is `node` smoke tests, `make build`, and deploy checks).

**Reference spec:** `docs/superpowers/specs/2026-05-20-quota-aware-fallback-design.md`

**Important environment notes:**
- This repo has **no test framework and no linter** (`CLAUDE.md`). Do not invent `make test` / `make lint`.
- `handler.js` and `people.js` **cannot** be imported by local `node` — they statically import the AWS SDK, which is provided by the Lambda runtime and is not in `node_modules` (only `@google/genai` is). Local smoke tests run **verbatim copies** of pure logic; full handler behaviour is verified at deploy.
- `node --check <file>` works fine for syntax-checking any of these files.

---

## File Structure

- **Create** `backend/summarise/constants.js` — a leaf module (imports nothing) exporting the shared `DEFAULT_MODEL`.
- **Modify** `backend/summarise/handler.js` — import `DEFAULT_MODEL`; add `isRetryableModelError`, `buildModelChain`, `MAX_MODEL_ATTEMPTS`; rewrite `summarise()`; add `model` to `listSummaries()`.
- **Modify** `backend/summarise/people.js` — import `DEFAULT_MODEL`, replace two inline literals.
- **Modify** `src/App.jsx` — capture and display the generating model.
- **Modify** `src/index.css` — styling for the model tag.
- **Modify** `CLAUDE.md` — remove the stale `?models=2` line; note the fallback behaviour.

---

## Task 1: Shared `constants.js` (cleanup B)

Extracts the duplicated `"models/gemini-3-flash-preview"` literal into one shared module. Non-breaking refactor.

**Files:**
- Create: `backend/summarise/constants.js`
- Modify: `backend/summarise/handler.js`, `backend/summarise/people.js`

- [ ] **Step 1: Create `constants.js`**

Create `backend/summarise/constants.js` with exactly:

```javascript
// The model used when a request does not specify one. Must appear in
// handler.js's FALLBACK_MODELS and pass its isWantedModel() filter.
export const DEFAULT_MODEL = "models/gemini-3-flash-preview";
```

- [ ] **Step 2: Import `DEFAULT_MODEL` into `handler.js` and drop its local copy**

In `backend/summarise/handler.js`, add this import immediately after the existing
`import { extractVideoId } from "./youtube.js";` line:

```javascript
import { DEFAULT_MODEL } from "./constants.js";
```

Then remove the local definition — replace this block:

```javascript

// Must appear in FALLBACK_MODELS and pass isWantedModel().
const DEFAULT_MODEL = "models/gemini-3-flash-preview";

const MODEL_CACHE_SUCCESS_TTL_MS = 24 * 60 * 60 * 1000;
```

with:

```javascript

const MODEL_CACHE_SUCCESS_TTL_MS = 24 * 60 * 60 * 1000;
```

- [ ] **Step 3: Import `DEFAULT_MODEL` into `people.js` and replace the literals**

In `backend/summarise/people.js`, add this import immediately after the existing
`import { searchVideosByPerson, getVideoMetadata, extractVideoId } from "./youtube.js";` line:

```javascript
import { DEFAULT_MODEL } from "./constants.js";
```

Then replace **both** occurrences of this line:

```javascript
  const chosenModel = model || "models/gemini-3-flash-preview";
```

with:

```javascript
  const chosenModel = model || DEFAULT_MODEL;
```

(The identical line appears twice — in `runPersonJob` and in `handleBatchResult`. Replace both.)

- [ ] **Step 4: Syntax-check and confirm the literal is gone from `people.js`**

Run:
```bash
cd /Users/neo/code/yt2txt/backend/summarise && node --check constants.js && node --check handler.js && node --check people.js && grep -n '"models/gemini-3-flash-preview"' people.js
```
Expected: the three `node --check` calls produce no output; `grep` produces **no output** (exit non-zero) — zero literal occurrences left in `people.js`. (The literal still legitimately appears in `handler.js`'s `FALLBACK_MODELS` and in `constants.js` — that is correct.)

- [ ] **Step 5: Commit**

```bash
cd /Users/neo/code/yt2txt
git add backend/summarise/constants.js backend/summarise/handler.js backend/summarise/people.js
git commit -m "$(cat <<'EOF'
refactor: extract shared DEFAULT_MODEL into constants.js

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Fallback helpers — `isRetryableModelError` + `buildModelChain`

Adds the pure fallback helpers. Non-breaking — nothing calls them yet.

**Files:**
- Modify: `backend/summarise/handler.js`

- [ ] **Step 1: Add the helpers**

In `backend/summarise/handler.js`, insert the following block immediately **after** the
`getAllowedModels` function (the line `}` that closes it) and before `function extractTitle(markdown) {`:

```javascript

const MAX_MODEL_ATTEMPTS = 4;

// Copy of people.js's predicate (kept separate so people.js's own fallback
// stays untouched). True for errors where trying a different model may help.
function isRetryableModelError(err) {
  const status = err?.status ?? err?.response?.status;
  if (status === 429 || status === 503 || status === 500) return true;
  const msg = String(err?.message || "").toLowerCase();
  return msg.includes("resource_exhausted")
    || msg.includes("quota")
    || msg.includes("rate limit")
    || msg.includes("unavailable")
    || msg.includes("overloaded")
    || msg.includes("high demand");
}

// Pure: ordered models to try — the requested model first, then the rest of
// the allowed list, capped at MAX_MODEL_ATTEMPTS. Exported for smoke-testing.
export function buildModelChain(requested, allowedModels) {
  const values = (allowedModels || []).map((m) => m.value);
  const ordered = [requested, ...values.filter((v) => v !== requested)];
  return ordered.slice(0, MAX_MODEL_ATTEMPTS);
}
```

- [ ] **Step 2: Syntax-check**

Run:
```bash
cd /Users/neo/code/yt2txt/backend/summarise && node --check handler.js
```
Expected: no output, exit 0.

- [ ] **Step 3: Smoke-test `buildModelChain`**

`handler.js` cannot be imported by local `node`. Run a **verbatim copy** of `MAX_MODEL_ATTEMPTS`
and `buildModelChain` (copied character-for-character from `handler.js`) against sample data.
Run from `backend/summarise/`:
```bash
node --input-type=module -e '
const MAX_MODEL_ATTEMPTS = 4;
export function buildModelChain(requested, allowedModels) {
  const values = (allowedModels || []).map((m) => m.value);
  const ordered = [requested, ...values.filter((v) => v !== requested)];
  return ordered.slice(0, MAX_MODEL_ATTEMPTS);
}
const allowed = [{value:"a"},{value:"b"},{value:"c"},{value:"d"},{value:"e"},{value:"f"}];
console.log("chosen mid-list:", JSON.stringify(buildModelChain("c", allowed)));
console.log("chosen first:   ", JSON.stringify(buildModelChain("a", allowed)));
console.log("chosen absent:  ", JSON.stringify(buildModelChain("z", allowed)));
'
```
Expected output:
```
chosen mid-list: ["c","a","b","d"]
chosen first:    ["a","b","c","d"]
chosen absent:   ["z","a","b","c"]
```
Each result has the chosen model first, never repeats it, and is capped at 4 entries. Confirm the
copied functions are character-for-character identical to those in `handler.js`.

- [ ] **Step 4: Commit**

```bash
cd /Users/neo/code/yt2txt
git add backend/summarise/handler.js
git commit -m "$(cat <<'EOF'
feat: add model fallback-chain helpers

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Rewrite `summarise()` with the fallback chain + model tagging

The behaviour-changing task. `summarise()` walks the chain; the used model is persisted and returned; `listSummaries()` carries it.

**Files:**
- Modify: `backend/summarise/handler.js`

- [ ] **Step 1: Replace the `summarise` function**

In `backend/summarise/handler.js`, replace the **entire** existing `summarise` function:

```javascript
async function summarise(url, model = DEFAULT_MODEL) {
  const existing = await ddb.send(new GetCommand({ TableName: TABLE, Key: { url } }));
  if (existing.Item) {
    const { markdown, title, date } = existing.Item;
    return {
      statusCode: 200,
      headers: JSON_HEADERS,
      body: JSON.stringify({ markdown, title, url, date, model, cached: true }),
    };
  }

  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY, apiVersion: "v1beta" });
  const videoId = extractVideoId(url);
  const promptText = `${SYSTEM_PROMPT}\n\nVideo URL: ${url}\nVideo ID: ${videoId}`;
  const response = await ai.models.generateContent({
    model,
    contents: [{
      parts: [
        { fileData: { fileUri: url } },
        { text: promptText },
      ],
    }],
  });
  const markdown = response.text;
  const title = extractTitle(markdown);
  const date = new Date().toISOString().split("T")[0];
  const createdAt = Date.now();

  try {
    await ddb.send(new PutCommand({
      TableName: TABLE,
      Item: { url, title, markdown, date, createdAt },
      ConditionExpression: "attribute_not_exists(#u)",
      ExpressionAttributeNames: { "#u": "url" },
    }));
  } catch (err) {
    if (err.name !== "ConditionalCheckFailedException") throw err;
    const again = await ddb.send(new GetCommand({ TableName: TABLE, Key: { url } }));
    if (again.Item) {
      return {
        statusCode: 200,
        headers: JSON_HEADERS,
        body: JSON.stringify({
          markdown: again.Item.markdown,
          title: again.Item.title,
          url,
          date: again.Item.date,
          model,
          cached: true,
        }),
      };
    }
  }

  return {
    statusCode: 200,
    headers: JSON_HEADERS,
    body: JSON.stringify({ markdown, title, url, date, model }),
  };
}
```

with:

```javascript
async function summarise(url, requestedModel = DEFAULT_MODEL) {
  const existing = await ddb.send(new GetCommand({ TableName: TABLE, Key: { url } }));
  if (existing.Item) {
    const { markdown, title, date, model } = existing.Item;
    return {
      statusCode: 200,
      headers: JSON_HEADERS,
      body: JSON.stringify({ markdown, title, url, date, model, cached: true }),
    };
  }

  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY, apiVersion: "v1beta" });
  const videoId = extractVideoId(url);
  const promptText = `${SYSTEM_PROMPT}\n\nVideo URL: ${url}\nVideo ID: ${videoId}`;
  const chain = buildModelChain(requestedModel, await getAllowedModels());

  let markdown;
  let usedModel;
  let lastErr;
  for (const candidate of chain) {
    try {
      const response = await ai.models.generateContent({
        model: candidate,
        contents: [{
          parts: [
            { fileData: { fileUri: url } },
            { text: promptText },
          ],
        }],
      });
      markdown = response.text;
      usedModel = candidate;
      break;
    } catch (err) {
      lastErr = err;
      if (!isRetryableModelError(err)) throw err;
      console.warn(`model ${candidate} failed (${err?.status || ""} ${err?.message || ""}), trying next`);
    }
  }

  if (!usedModel) {
    console.error("all models exhausted for summarise", lastErr);
    return {
      statusCode: 503,
      headers: JSON_HEADERS,
      body: JSON.stringify({ error: "all models are currently rate-limited — try again shortly" }),
    };
  }

  const title = extractTitle(markdown);
  const date = new Date().toISOString().split("T")[0];
  const createdAt = Date.now();

  try {
    await ddb.send(new PutCommand({
      TableName: TABLE,
      Item: { url, title, markdown, date, createdAt, model: usedModel },
      ConditionExpression: "attribute_not_exists(#u)",
      ExpressionAttributeNames: { "#u": "url" },
    }));
  } catch (err) {
    if (err.name !== "ConditionalCheckFailedException") throw err;
    const again = await ddb.send(new GetCommand({ TableName: TABLE, Key: { url } }));
    if (again.Item) {
      return {
        statusCode: 200,
        headers: JSON_HEADERS,
        body: JSON.stringify({
          markdown: again.Item.markdown,
          title: again.Item.title,
          url,
          date: again.Item.date,
          model: again.Item.model,
          cached: true,
        }),
      };
    }
  }

  return {
    statusCode: 200,
    headers: JSON_HEADERS,
    body: JSON.stringify({ markdown, title, url, date, model: usedModel }),
  };
}
```

- [ ] **Step 2: Add `model` to the `listSummaries` projection**

In `backend/summarise/handler.js`, inside `listSummaries`, replace:

```javascript
    .map(({ url, title, date, createdAt, markdown }) => ({
      url, title, date, createdAt,
      summary: (markdown || '').slice(0, 8000),
    }));
```

with:

```javascript
    .map(({ url, title, date, createdAt, markdown, model }) => ({
      url, title, date, createdAt, model,
      summary: (markdown || '').slice(0, 8000),
    }));
```

- [ ] **Step 3: Syntax-check**

Run:
```bash
cd /Users/neo/code/yt2txt/backend/summarise && node --check handler.js
```
Expected: no output, exit 0.

- [ ] **Step 4: Functional verification is deferred to deploy**

`handler.js` cannot be imported by local `node`. The end-to-end behaviour — a generated summary
records and returns its `model`, and the chain advances on retryable errors — is verified against
the deployed Lambda in Task 6. For this task, Step 3's syntax check is the local gate.

- [ ] **Step 5: Commit**

```bash
cd /Users/neo/code/yt2txt
git add backend/summarise/handler.js
git commit -m "$(cat <<'EOF'
feat: model fallback chain + record the generating model

summarise() now walks the chosen model then the rest of the allowed
list, advancing past quota/rate-limit errors, and persists which model
actually produced each summary. Returns 503 if the whole chain fails.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Frontend — display the generating model

`src/App.jsx` captures the model from responses and renders a tag; `src/index.css` styles it.

**Files:**
- Modify: `src/App.jsx`, `src/index.css`

- [ ] **Step 1: Add `contentModel` state**

In `src/App.jsx`, replace this line:

```javascript
  const [modelOptions, setModelOptions] = useState(FALLBACK_MODEL_OPTIONS);
```

with:

```javascript
  const [modelOptions, setModelOptions] = useState(FALLBACK_MODEL_OPTIONS);
  const [contentModel, setContentModel] = useState('');
```

- [ ] **Step 2: Capture the used model in `generatePost`**

In `src/App.jsx`, inside `generatePost`, replace:

```javascript
      const { markdown, title, date } = await res.json();
      setContent(markdown);
      setHistory(prev => [{ url, title, date, summary: markdown.slice(0, 8000) }, ...prev]);
```

with:

```javascript
      const { markdown, title, date, model: usedModel } = await res.json();
      setContent(markdown);
      setContentModel(usedModel || '');
      setHistory(prev => [{ url, title, date, summary: markdown.slice(0, 8000), model: usedModel }, ...prev]);
```

- [ ] **Step 3: Add the `modelLabel` helper**

In `src/App.jsx`, immediately **after** the `closeDetail` function and before the `Header`
component definition, add:

```javascript

  const modelLabel = (value) => {
    if (!value) return '';
    const found = modelOptions.find((o) => o.value === value);
    return found ? found.label : value.replace(/^models\//, '');
  };
```

- [ ] **Step 4: Show the tag in the detail view**

In `src/App.jsx`, in the `if (detailItem)` block, replace:

```javascript
          <article className="prose">
            <ReactMarkdown urlTransform={MARKDOWN_URL_TRANSFORM} components={MARKDOWN_COMPONENTS}>{detailItem.summary}</ReactMarkdown>
          </article>
```

with:

```javascript
          {detailItem.model && (
            <div className="summary-meta">
              <span className="model-tag">{modelLabel(detailItem.model)}</span>
            </div>
          )}
          <article className="prose">
            <ReactMarkdown urlTransform={MARKDOWN_URL_TRANSFORM} components={MARKDOWN_COMPONENTS}>{detailItem.summary}</ReactMarkdown>
          </article>
```

- [ ] **Step 5: Show the tag on the freshly-generated summary**

In `src/App.jsx`, in the home view, replace:

```javascript
        {content ? (
          <>
            <div className="article-actions">
              <button className="btn btn--secondary" onClick={() => downloadMarkdown(content)}>
                Download .md
              </button>
            </div>
```

with:

```javascript
        {content ? (
          <>
            {contentModel && (
              <div className="summary-meta">
                <span className="model-tag">{modelLabel(contentModel)}</span>
              </div>
            )}
            <div className="article-actions">
              <button className="btn btn--secondary" onClick={() => downloadMarkdown(content)}>
                Download .md
              </button>
            </div>
```

- [ ] **Step 6: Show the tag on the history-page list cards**

In `src/App.jsx`, in the `if (page === 'history')` block, replace:

```javascript
                  <div className="history-list-meta">
                    <span className="history-date">{item.date}</span>
                  </div>
```

with:

```javascript
                  <div className="history-list-meta">
                    <span className="history-date">{item.date}</span>
                    {item.model && <span className="model-tag">{modelLabel(item.model)}</span>}
                  </div>
```

- [ ] **Step 7: Show the tag on the home-page grid cards**

In `src/App.jsx`, in the `history-grid` section, replace:

```javascript
                <button
                  key={i}
                  className="history-card"
                  onClick={() => openDetail(item)}
                >
                  <div className="history-date">{item.date}</div>
                  <span className="history-title">{item.title || item.url}</span>
                  <span className="history-url">{item.url}</span>
                </button>
```

with:

```javascript
                <button
                  key={i}
                  className="history-card"
                  onClick={() => openDetail(item)}
                >
                  <div className="history-date">{item.date}</div>
                  <span className="history-title">{item.title || item.url}</span>
                  <span className="history-url">{item.url}</span>
                  {item.model && <span className="model-tag">{modelLabel(item.model)}</span>}
                </button>
```

- [ ] **Step 8: Add the model-tag styles**

In `src/index.css`, append the following at the end of the file:

```css

/* ── Model tag ───────────────────────────────────────────────────────────── */
.model-tag {
  display: inline-block;
  background: var(--sage-pale);
  color: var(--sage);
  border-radius: 99px;
  font-size: 0.72rem;
  font-weight: 600;
  padding: 0.12rem 0.6rem;
}

.summary-meta {
  margin-bottom: 0.75rem;
}

.history-card .model-tag {
  margin-top: 0.5rem;
}
```

- [ ] **Step 9: Make the history-list meta row lay out date + tag side by side**

In `src/index.css`, replace:

```css
.history-list-meta {
  margin-bottom: 0.3rem;
}
```

with:

```css
.history-list-meta {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 0.3rem;
}
```

- [ ] **Step 10: Build**

Run from the repo root `/Users/neo/code/yt2txt`:
```bash
make build
```
Expected: a successful Vite production build with no errors.

- [ ] **Step 11: Commit**

```bash
cd /Users/neo/code/yt2txt
git add src/App.jsx src/index.css
git commit -m "$(cat <<'EOF'
feat: show which model generated each summary

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: `CLAUDE.md` — remove stale endpoint, note fallback (cleanup A)

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Remove the stale `?models=2` line**

In `CLAUDE.md`, delete this line entirely (it documents an endpoint the handler does not have):

```
- `GET ?models=2&url=…&prompt=…` → one-off summary preview without persisting
```

- [ ] **Step 2: Note the fallback behaviour**

In `CLAUDE.md`, replace this line:

```
- `POST` → summarise + persist to DynamoDB
```

with:

```
- `POST` → summarise + persist to DynamoDB. On a quota/rate-limit error the summariser falls back through the allowed-model list (chosen model + up to 3 more) and records on the item which model actually produced the summary.
```

- [ ] **Step 3: Verify the edits**

Run from the repo root:
```bash
grep -n "models=2\|falls back through" CLAUDE.md
```
Expected: **no** match for `models=2`; one match for `falls back through`.

- [ ] **Step 4: Commit**

```bash
cd /Users/neo/code/yt2txt
git add CLAUDE.md
git commit -m "$(cat <<'EOF'
docs: drop stale ?models=2 endpoint, note summariser fallback

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Deploy and verify in production

⚠️ **This task deploys to production.** Pushing the branch to `main` triggers CI auto-deploy of the
site and the Lambda. Run only with explicit user go-ahead — do not push autonomously.

**Files:** none (deploy only)

- [ ] **Step 1: Merge to `main` and push** (after user go-ahead)

```bash
cd /Users/neo/code/yt2txt
git checkout main && git pull --ff-only
git merge feature/quota-aware-fallback
git push origin main
```

- [ ] **Step 2: Watch the CI deploy**

```bash
gh run list --limit 2
gh run watch <Deploy Infrastructure run id>
gh run watch <Deploy Site run id>
```
Expected: both `Deploy Site` and `Deploy Infrastructure` complete with `success`.

- [ ] **Step 3: Verify summary tagging on the live site**

Open `https://yt2txt.willbright.link`, generate a summary, and confirm:
- the summary view shows a model tag (e.g. "Gemini 3 Flash");
- the new entry in the history grid shows the same tag.

This confirms the happy path: the `model` field flows from `summarise()` → API response →
DynamoDB → `listSummaries()` → UI tag.

- [ ] **Step 4: Note on the fallback branch**

The fallback retry loop cannot be triggered on demand (it needs a genuine quota error). It is
covered by the Task 2 smoke test (chain construction) and code review of the deterministic loop
in `summarise()`. No production action is required for this step.

---

## Self-Review Notes

- **Spec coverage:** shared `constants.js` → Task 1; `isRetryableModelError` + `buildModelChain` +
  `MAX_MODEL_ATTEMPTS` (cap 4) → Task 2; chain walk + 503-on-exhaustion + `model` persisted/returned
  + `listSummaries` carries `model` → Task 3; UI tag on summary view + both card styles → Task 4;
  stale `?models=2` removed + fallback note → Task 5; deploy verification → Task 6.
- **Out of scope (per spec):** `people.js`'s own fallback logic is untouched (only its literal is
  cleaned in Task 1); the frontend error alert stays generic on a 503.
- **Type consistency:** `buildModelChain(requested, allowedModels)` takes the `[{value,label}]`
  array from `getAllowedModels()` and returns an array of `value` strings; `summarise()` feeds those
  strings to `ai.models.generateContent({ model })`. The `model` field is a model `value` string
  everywhere — DynamoDB item, API response, history entry, and `modelLabel()` input.
- **Deliberate duplication:** `isRetryableModelError` is copied from `people.js` rather than shared,
  to honour the scope decision that `people.js`'s fallback stays untouched.
