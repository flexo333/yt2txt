# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`yt2txt` (yt2txt.willbright.link) — a Vite + React SPA that summarises YouTube videos by calling a single AWS Lambda backed by Google Gemini. Summaries are persisted in DynamoDB and listed as history. There is no test framework and no linter configured.

## Commands

Everything runs via `docker compose` services invoked through the `Makefile` — you don't need Node or Python locally. `.env` is auto-loaded by `make` and forwarded into the Docker services.

- `make install` — install frontend npm deps (via the `node` service)
- `make dev` — Vite dev server on `http://localhost:5173` (needs `VITE_LAMBDA_URL` in `.env` to hit a real Lambda)
- `make build` — Vite production build into `dist/`
- `make build-lambda` — install `backend/summarise/node_modules/` under `linux/amd64` so the deps work inside Lambda; **must run before any `infra-*` command that packages the Lambda**
- `make infra-preview` / `make infra-up` / `make infra-destroy` / `make infra-outputs`
- `make infra-refresh` — resyncs Pulumi state from AWS; use this when `api_url` drifts (see "Function URL gotcha" below)
- `make deploy` — rebuilds with live `VITE_LAMBDA_URL` from Pulumi outputs, syncs `dist/` to S3, invalidates CloudFront

There is no `make test` / `make lint` — don't invent one.

## Architecture

Three layers, each with one source of truth:

**Frontend (`src/`, `index.html`)** — single `App.jsx` component (no router, just `page` state). On mount it `GET`s `VITE_LAMBDA_URL` to hydrate history; "Generate" `POST`s `{ url, model }`. `MODEL_OPTIONS` in `App.jsx` **must stay in sync with `ALLOWED_MODELS` in `backend/summarise/handler.js`** — the Lambda rejects anything not in its allow-list.

**Backend (`backend/summarise/handler.js`)** — one Lambda, one handler, dispatched by HTTP method:
- `POST` → summarise + persist to DynamoDB
- `POST { action: "research", person }` → kick off async "person research" job (see `people.js`). Lambda self-invokes with `{ __personJob: true }` payload.
- `GET` → list last 50 summaries (DynamoDB `Scan`, sorted by `createdAt`)
- `GET ?models=1` → list available Gemini models (for debugging)
- `GET ?models=2&url=…&prompt=…` → one-off summary preview without persisting
- `GET ?people=1` → list tracked people
- `GET ?person=NAME` → job status + per-video summaries + meta-summary for that person

Person-research modules:
- `backend/summarise/youtube.js` — YouTube Data API v3 search + metadata (needs `YOUTUBE_API_KEY`).
- `backend/summarise/people.js` — async job runner using the **Gemini Batch API**. Searches last 6 months, submits up to 8 per-video summarisation requests as a single inline batch (separate / higher quota than sync, 50% cheaper), returns immediately. Completion is handled by `pollPendingBatches()`, which is invoked on a schedule.
- Person status progresses: `queued → running (searching) → batch_pending → finalising → done | error`. Per-video rows carry `status: batch_pending | done | error`.
- Persisted in two tables: `yt2txt-people` (hash `person`, job state + `batchName` + `batchKeys` + meta), `yt2txt-people-videos` (hash `person`, sort `videoId`). Per-video summaries are reused across runs — only new videos are summarised.
- Self-invoke (via `InvokeCommand`) uses `AWS_LAMBDA_FUNCTION_NAME` (injected by the Lambda runtime) — do not hardcode or pass as Pulumi config, that creates a circular dep.
- **Batch poller**: an EventBridge rule (`summarise-poll-rule`, every 3 min) invokes the Lambda with `{__pollBatches: true}`. The handler scans `yt2txt-people` for `batch_pending`, calls `ai.batches.get`, writes results to per-video rows, then runs a single sync meta-summary call and marks the person `done`. Terminal batch states: `SUCCEEDED | PARTIALLY_SUCCEEDED | FAILED | CANCELLED | EXPIRED`.

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
- **Allowed-model list** is duplicated between frontend (`MODEL_OPTIONS` in `App.jsx`) and backend (`ALLOWED_MODELS` in `handler.js`). When adding/removing a model, edit both.
- **Batch SLO is 24h**: the Gemini Batch API guarantees completion within 24h but is usually much faster. Person research is no longer "wait ~5 min and it's done" — the UI should reflect `batch_pending` as a legitimate state, not stuck. The poller runs every 3 min so post-completion lag is small.
- **Stale `running` rows from pre-batch runs** will block new `researchPerson` calls (the alreadyRunning guard checks `running | queued | batch_pending`). Manually update or delete the DDB row if a person is stuck from before this refactor.

## CI

- `.github/workflows/deploy-site.yml` — on `main` push touching frontend/backend/infra paths: rebuilds with live `VITE_LAMBDA_URL` pulled from `pulumi stack output api_url`, syncs S3, invalidates CloudFront. Uses OIDC to assume the `deploy_role_arn` from the ingress stack.
- `.github/workflows/deploy-infra.yml` — previews on PR, applies on `main` push. Assumes `infra_role_arn` from the ingress stack. Needs `GEMINI_API_KEY` as a repo secret so the applied Lambda has it.
