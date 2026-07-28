# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`yt2txt` (yt2txt.willbright.link) — a Vite + React SPA that summarises YouTube videos by calling a single AWS Lambda backed by Google Gemini. Summaries are persisted in DynamoDB and listed as history. There is no test framework and no linter configured.

## Commands

Everything runs via `docker compose` services invoked through the `Makefile` — you don't need Node or Python locally. `.env` is auto-loaded by `make` and forwarded into the Docker services.

- `make install` — install frontend npm deps (via the `node` service)
- `make icons` — regenerate `public/icons/*.png` from `scripts/generate-icons.mjs` (only needed if `public/yt2txt.svg` changes)
- `make dev` — Vite dev server on `http://localhost:5173` (needs `VITE_LAMBDA_URL` in `.env` to hit a real Lambda)
- `make build` — Vite production build into `dist/`
- `make build-lambda` — install `backend/summarise/node_modules/` under `linux/amd64` so the deps work inside Lambda; **must run before any `infra-*` command that packages the Lambda**
- `make infra-preview` / `make infra-up` / `make infra-destroy` / `make infra-outputs`
- `make infra-refresh` — resyncs Pulumi state from AWS; use this when `api_url` drifts (see "Function URL gotcha" below)
- `make deploy` — rebuilds with live `VITE_LAMBDA_URL` from Pulumi outputs, syncs `dist/` to S3, invalidates CloudFront

There is no `make test` / `make lint` — don't invent one.

## Architecture

Three layers, each with one source of truth:

**Frontend (`src/`, `index.html`)** — single `App.jsx` component (no router, just `page` state). On mount it `GET`s `VITE_LAMBDA_URL` to hydrate history and `GET`s `?models=1` to populate the model dropdown; "Generate" `POST`s `{ url, model }`. The dropdown is populated dynamically — `FALLBACK_MODEL_OPTIONS` in `App.jsx` is only rendered if that fetch fails.

**PWA (`public/manifest.json`, `public/sw.js`, `src/share.js`)** — installable app + Android share target:
- `manifest.json` declares `display: standalone`, the icon set, shortcuts, and a **`share_target`** posting to `/share` via **GET** (no server round-trip needed — the SPA reads the query string). `launch_handler.client_mode: navigate-existing` reuses an already-open window.
- `/share?url=&text=&title=` is a route in `App.jsx`. `shareTargetUrl()` scans `url` → `text` → `title` for the first YouTube link (Android apps put it in different fields and often wrap it in prose), then auto-summarises with `SHARE_MODEL` (= `models/gemini-flash-latest`) and `navigate(..., { replace: true })`s to the summary so Back doesn't re-fire the share.
- `canonicalYoutubeUrl()` rewrites shorts/live/embed/`m.`/`music.` links into `https://www.youtube.com/watch?v=<id>` — the Lambda's `YOUTUBE_URL_RE` only accepts `watch?v=` and `youtu.be`, so a raw shorts link would 400. It also strips `?si=` share tracking so one video is one DynamoDB row. Applied to both the share flow and the manual Generate button.
- `src/share.js` is dependency-free and pure; `node src/share.test.mjs` smoke-tests it (same convention as `people-pure.test.mjs`).
- `public/sw.js` is hand-written — no `vite-plugin-pwa`, no precache manifest to keep in sync. Navigations are network-first with the cached `/` shell as the offline fallback; `/assets/*` (content-hashed) is cache-first; cross-origin requests (the Lambda) and all non-GETs are never intercepted. Bump `VERSION` in it to invalidate every client's cache.
- Registered by `src/registerServiceWorker.js`, **production only** — in `make dev` a service worker would sit in front of Vite HMR.
- iOS has no Web Share Target support; the `apple-*` meta tags in `index.html` still give a standalone home-screen app there.
- **Share Target is Android/ChromeOS/Windows only** — on macOS and Linux an installed PWA can never appear in a share menu, because those OSes expose no share mechanism to Chrome. The desktop path is the bookmarklet in the `<details className="desktop-share">` block on Home: it opens the same `/share?url=` route from any browser. Its `javascript:` href is applied with `setAttribute` in an effect because React sanitises such URLs out of JSX `href`. Nothing about the share flow is desktop-specific — `/share?url=` is a plain GET route, so a Chrome custom site-search (`…/share?url=%s`) works too.

**Backend (`backend/summarise/handler.js`)** — one Lambda, one handler, dispatched by HTTP method:
- `POST` → summarise + persist to DynamoDB. On a quota/rate-limit error the summariser falls back through the allowed-model list (chosen model + up to 3 more) and records on the item which model actually produced the summary.
- `POST { action: "research", person }` → kick off async "person research" job (see `people.js`). Lambda self-invokes with `{ __personJob: true }` payload.
- `GET` → list last 50 summaries (DynamoDB `Scan`, sorted by `createdAt`)
- `GET ?models=1` → list allowed models as `[{ value, label }]` (Flash-family Gemini + Gemma); consumed by the frontend dropdown
- `GET ?people=1` → list tracked people
- `GET ?person=NAME` → job status + per-video summaries + meta-summary for that person

Person-research modules:
- `backend/summarise/youtube.js` — YouTube Data API v3 search + metadata (needs `YOUTUBE_API_KEY`).
- `backend/summarise/people-pure.js` — dependency-free pure helpers (timing constants, model-chain building, job-state predicates); smoke-tested by `people-pure.test.mjs` under plain `node`.
- `backend/summarise/people.js` — synchronous, resumable job runner. Searches the last 6 months, then summarises up to 8 videos one at a time with `ai.models.generateContent`, persisting each per-video row as it completes.
- `runPersonJob` is idempotent and chunked: before each video it checks `context.getRemainingTimeInMillis()`, and when Lambda time is low it self-invokes a continuation (`{ __personJob: true, person }`) and returns. Any number of videos can be processed without hitting the 900 s Lambda timeout.
- Three triggers call `runPersonJob`: the initial research request, its own time-budget continuations, and the safety-net resumer.
- Person status progresses: `queued → running (searching / summarising) → finalising → done | error`. Per-video rows carry `status: pending | done | error`.
- Persisted in two tables: `yt2txt-people` (hash `person`, job state + `continuationCount` + `lastProgressAt` + meta), `yt2txt-people-videos` (hash `person`, sort `videoId`). Per-video summaries are reused across runs — only new/unfinished videos are summarised.
- Self-invoke (via `InvokeCommand`) uses `AWS_LAMBDA_FUNCTION_NAME` (injected by the Lambda runtime) — do not hardcode or pass as Pulumi config, that creates a circular dep.
- **Safety-net resumer**: an EventBridge rule (`summarise-poll-rule`, every 3 min) invokes the Lambda with `{__resumeJobs: true}`. `resumeStalledJobs()` scans `yt2txt-people` for active jobs idle past the stall threshold (`lastProgressAt` older than 10 min) and self-invokes a continuation — recovering jobs whose Lambda was killed mid-run.

The Lambda uses `@google/genai` with `apiVersion: "v1beta"` and passes the YouTube URL as a `fileData` part — Gemini fetches the transcript itself. The system prompt lives at the top of `handler.js`.

**Infra (`infra/pulumi/__main__.py`, Python Pulumi)** — provisions:
- Static site (S3 + CloudFront + ACM + Route53 record) via the `pulumi_static_site` component
- DynamoDB table `yt2txt-summaries` (hash key `url`, PAY_PER_REQUEST)
- Lambda + IAM role (DDB PutItem/Scan only) + **Lambda Function URL** (no API Gateway, to avoid the 29s timeout)
- `StackReference("flexo333/flexo333-ingress/prod")` for the shared Route53 `zone_id`, OIDC deploy/infra roles

Exported outputs (`bucket`, `distribution_id`, `api_url`, `lambda_function_name`, `dynamodb_table`) are consumed by the Makefile and GitHub Actions.

## Things that will bite you

- **Function URL auth caching**: `aws.lambda_.Permission` with `function_url_auth_type="NONE"` **must exist before** the `FunctionUrl` is created, otherwise AWS caches a "no public access" authz state that survives later policy edits. The `depends_on` in `__main__.py` enforces this — don't remove it.
- **`api_url` drift**: If the Function URL is ever recreated out-of-band, Pulumi's `api_url` output goes stale and the deployed site will point at a dead URL. Run `make infra-refresh` to resync (it diffs Pulumi state vs. the live `get-function-url-config` before refreshing).
- **Lambda arch**: `backend/summarise/node_modules/` must be built on `linux/amd64`. Use `make build-lambda` (the `node-lambda` compose service pins the platform). Don't `npm install` there from host macOS.
- **CORS**: `allow_origins` in the Function URL is hardcoded to `https://yt2txt.willbright.link` and `http://localhost:5173`. Any other origin (preview deploys, alternate dev ports) needs to be added in `__main__.py` and re-applied.
- **`GEMINI_API_KEY`** is baked into the Lambda's environment variables by Pulumi at deploy time, read from `os.environ` — it must be present in the shell running `make infra-up` (and is passed via `.env` → `docker-compose.yml` → the `pulumi` service).
- **`YOUTUBE_API_KEY`** follows the same pattern — required for the "People" research flow. Needs `YOUTUBE_API_KEY` in `.env` locally and as a GitHub Actions secret for CI.
- **Allowed-model list is dynamic**: `handler.js` derives it from `ai.models.list()` via `filterModels()` (Flash-family Gemini + Gemma), cached 24h. The same list backs both `?models=1` and `isAllowedModel()`, so the dropdown and the request allow-list cannot drift. To change which models appear, edit the `isWantedModel()` filter — not a hand-kept list. `FALLBACK_MODELS` (backend) and `FALLBACK_MODEL_OPTIONS` (frontend) are only used when the live fetch fails; keep them roughly current but they are not load-bearing.
- **People research uses the synchronous Gemini API, not the Batch API**: the Batch API is paid-tier only and the project key is free tier — `ai.batches.create()` fails `400 FAILED_PRECONDITION`. `people.js` deliberately calls `ai.models.generateContent` per video. Do not "optimise" it back onto the Batch API without first enabling billing on the Gemini project.
- **A stuck person job self-heals**: the `summarise-poll-rule` tick (`resumeStalledJobs`) resumes any job idle past the 10-min stall threshold. The `researchPerson` busy-guard blocks new runs while a person is `queued | running | finalising`; pass `force: true` to override.
- **The manifest is `manifest.json`, not `manifest.webmanifest`**: `make deploy` uses `aws s3 sync`, which picks Content-Type from the file extension. `.webmanifest` is not in the AWS CLI's mime map and would be uploaded as `application/octet-stream`; `.json` gets `application/json`, which browsers accept for manifests. Don't rename it without adding an explicit `--content-type` sync step.
- **`sw.js` must stay at the site root**: its scope is `/`, which a service worker can only claim from the root path. Vite copies `public/` verbatim, so it lands correctly — don't move it into `src/` or an assets folder.
- **Client-side routing depends on `spa_mode`**: `App.jsx` uses the History API (`src/useLocation.js`) for `/`, `/history`, `/people`, `/share`, and `/summary/<videoId>`. `/share` in particular relies on CloudFront's 403/404 → `index.html` mapping preserving the query string. Refreshing a non-root path works only because `StaticSite(spa_mode=True)` maps CloudFront 403/404 → `index.html`, **and** Vite emits absolute asset paths. Never set `base: './'` in the Vite config — it would make assets resolve relative to the route and break every non-root URL.

## CI

- `.github/workflows/deploy-site.yml` — on `main` push touching frontend/backend/infra paths: rebuilds with live `VITE_LAMBDA_URL` pulled from `pulumi stack output api_url`, syncs S3, invalidates CloudFront. Uses OIDC to assume the `deploy_role_arn` from the ingress stack.
- `.github/workflows/deploy-infra.yml` — previews on PR, applies on `main` push. Assumes `infra_role_arn` from the ingress stack. Needs `GEMINI_API_KEY` as a repo secret so the applied Lambda has it.
