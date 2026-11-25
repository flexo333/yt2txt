# Backlog

One line per item, each pointing at the code it came from.

- `## Next` is what gets picked up, worked through the superpowers flow (brainstorm → spec → plan).
- `## Later` is where ideas and defects land when they surface mid-task. Append and move on; don't act on them.
- Finished work leaves this file for `docs/CHANGELOG.md` `## Unreleased`, rewritten as a user-facing change.
- Abandoned work moves to `## Won't do` with a half-line reason, rather than being deleted.

## Next

- `navigate()` ignores the query string, so `/share?url=A` → `/share?url=B` is a silent no-op — `src/useLocation.js` snapshots `pathname` only and early-returns when it matches
- A cache hit returns the stored summary whatever model was asked for, labelled with the old model — either say so in the UI or key the cache on `(videoId, model)` (`backend/summarise/handler.js:109`)
- The selected person lives in `useState`, not the URL, so it is the only view in the app you cannot link to or refresh — `/people/<name>` would finish the History-API migration (`src/pages/People.jsx:12`)

## Later

- The AI Studio catalog lists `Gemini 4 Hydrogen` with the same free-tier limits as the Flash tiers (5 RPM / 250K TPM / 20 RPD) while Neon, Carbon and Argon sit at 0/0, which reads like the Gemini 4 tier this key can reach — but the Gemini 4 names carry no tier word, so `isWantedModel()` cannot admit it without naming it explicitly, and its video+`responseSchema` support is unverified (`backend/summarise/models-pure.js`)
- `callMeta` in `people.js` still extracts its meta-summary JSON with a regex — now that every allowed model is Gemini, it could use `responseSchema` like the summarise path (`backend/summarise/people.js:200`)
- Suggest one "catch-up" video per tracked person — the single best thing to watch to absorb their current point of view, instead of reading eight summaries
- People detail polls through two effects sharing one mutable `pollRef`; a single effect keyed on "is the status terminal" would be easier to reason about, and pausing the 3-second poll on a hidden tab is free (`src/pages/People.jsx:35`)
- The 4,096-byte body check runs on the raw string and never consults `isBase64Encoded` — harmless with a JSON content-type today, latent otherwise (`backend/summarise/handler.js:326`)
- `filterModels` sorts reverse-alphabetically by model id, which puts newer models first by coincidence of naming rather than by design — give it an explicit rank, or a comment admitting the accident (`backend/summarise/models.js:44`)
- `SHARED_SECRET` is checked server-side but shipped to the browser as `VITE_YT2TXT_KEY` and baked into the bundle, so it deters drive-by traffic and nothing more — describe it honestly
- pulumi-aws 7.x deprecates what the stack still uses: `hash_key`/`range_key` → `key_schema` on the `summaries` table and its GSI (`infra/pulumi/__main__.py`), and `s3.BucketV2` → `s3.Bucket` inside the `pulumi-static-site` fork. Warnings only today, so they will bite whenever 8.x lands — the table half is ours, the bucket half belongs in `flexo333/pulumi-static-site`
- Route POSTs through `/api/*` too if the CloudFront origin-response timeout is ever raised to 180 s by a quota increase — that would delete the CORS origin list and stop exposing the Function URL directly
- Edge-cache the history list (`s-maxage` + `stale-while-revalidate` on `GET /`), which would make a repeat visit an edge hit instead of a Lambda round trip; needs the `x-yt2txt-key` header in the cache key or moved to a cookie
- Replace the component's `spa_mode` 403/404 custom error responses with a viewer-request rewrite of extensionless paths to `/index.html`, so S3 never 404s and `/api/*` could use real 404 statuses again (`flexo333/pulumi-static-site`)

## Won't do

- Move the person-job continuation loop to Step Functions — it would delete the self-invoke plumbing, continuation budget and stall-detection tick, but it is a genuine rewrite of `people.js`; revisit only if the current machinery starts failing in ways the logs cannot explain
- Channel-name hints in the text-only speaker extractor, a known-person hint during research, and a backfill re-tagging empty historical `speakers[]` — declined in the merge-spec design review (prompt hints only); the extractor itself was deleted with the trailer contract
