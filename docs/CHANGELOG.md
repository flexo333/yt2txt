# Changelog

Changes worth noticing, newest first. Finished backlog items land in `## Unreleased`,
rewritten as something a person using yt2txt would observe rather than as a commit subject.

There are no version numbers: a merge to `main` deploys to production, so shipped work is
grouped by the date it went out. Everything under `## Shipped` was reconstructed from git
history on 2026-07-30, when this file was created.

## Unreleased

- A summary page now embeds the video: clicking a timestamp in the summary seeks the on-page player instead of opening a new tab. Scroll past the player and it sticks to a corner as a mini-player until dismissed.
- A summary page now has a Regenerate button: when a summary came out thin, wrong or stale, one click re-watches the video and replaces the stored summary in place. The old text stays until the new one succeeds, and the entry keeps its position in History.
- The summarise endpoint's public-access policy now carries both permissions AWS has required since October 2025. Nothing changes in normal use; it removes a trap where recreating the endpoint would have made every request fail with a 403 for no visible reason.
- Summaries now replace watching instead of triaging: a numbered claim ledger with reasoning, numbers and timestamps, per-speaker sections (or notable quotes for solo videos), and no more Signal-to-Noise/Clickbait scores.
- Person research and regular summaries now share one summary per video: researched videos appear in History with speaker tags, already-summarised videos are reused instead of paid for twice, and People video cards link to the full summary.
- Gemma models are gone from the model list; titles and speaker tags now come from structured model output, which makes them reliable instead of best-effort scraping.

## Shipped

### 2026-07-30

- The public endpoint and the background job runner are now separate functions. A stuck web request gives up after 5 minutes instead of 15, and the function answering public traffic can no longer write to or delete from any table.
- History and permalinks read straight from their keys — the last full-table scans are gone, so both stay fast as the archive grows.

### 2026-07-29

- One video is now one summary. Paste it as a `youtu.be` link, a Short, an embed or a `?si=` share URL and it lands in the same place, so the history stops showing the same video several times over.
- History loads newest-first and stays correct past 100 summaries. Before this, a brand-new summary could be missing from the list entirely depending on where its URL happened to hash.
- Opening the app no longer downloads the whole archive first: the list ships a short preview and the full text arrives when you open a summary. Permalinks to summaries older than the newest 50 work again instead of reporting "not found".
- Summaries now carry the video's real YouTube title, its channel, and the speakers heard in it.
- Long videos cost a fraction of what they did. Frame sampling scales with duration, so a 25-minute video no longer blows straight through the free-tier rate limit and fails.
- `make test` runs the pure-module smoke tests, and both deploy workflows gate on them.
- Added `docs/explainer.html` — a written tour of the architecture and the limits each decision bends around.

### 2026-07-28

- yt2txt installs as an app, and registers itself as an Android share target: share a YouTube link from any app and it summarises immediately, no copy-paste. Desktop browsers, which have no share menu to hook into, get a bookmarklet that opens the same route.
- Works offline enough to load: the shell is cached, so opening the app without a connection shows the app rather than a browser error.
- Defaults to `gemini-flash-latest`.

### 2026-05-21

- Person research survives Lambda timeouts. The job checkpoints after each video and picks up where it left off, and one that stalls restarts itself within 10 minutes instead of sitting dead.
- The current view is reflected in the URL bar, so Back, Forward, refresh and link-sharing work across the app.

### 2026-05-20

- The model dropdown is populated from the live Gemini catalogue, so newly released Flash models appear without a deploy.
- A rate-limited model no longer fails the request — the summariser falls back through the remaining models — and each summary records which model actually produced it.
