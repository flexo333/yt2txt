# TODO

## Cleanup — in-progress work (as of 2026-07-22)

### 1. Land or close PR #2 (`docs/function-url-invoke-permission`)

Draft PR, branch is the current checkout. Two commits: `b7cd4d1` (design doc)
and `e2d50b0` (the actual infra fix). Infra Preview CI passed on 2026-07-20:
`+1 to create` (`summarise-url-invoke`), `~18 to update`, and **no replacement
of `summarise-url`** — so the authz-caching ordering gotcha is not triggered.
The blocker named in the design doc is resolved: `flexo333/pulumi-static-site`
v0.2.0 exists and resolves.

- [ ] Rewrite the PR body — it still says *"Draft — requirement, not
      implementation. No infra code changes in this PR."* That was true at
      `b7cd4d1` and is now wrong; `e2d50b0` changes `__main__.py` and
      `requirements.txt`.
- [ ] Flag the real blast radius in the PR: `requirements.txt` bumps
      `pulumi-aws` from `>=6.0.0,<7.0.0` to `>=7.16.0,<8.0.0`. That is a
      **provider major upgrade across the whole stack**, not just a new
      permission. The 18 planned updates are mostly cosmetic v7 diffs
      (`+region`, `+tagsAll`) but they touch CloudFront, ACM, S3, DynamoDB
      and the Lambda. Decide whether that lands in this PR or its own.
- [ ] Update `docs/superpowers/specs/2026-07-20-function-url-invoke-permission-design.md`
      — header still reads `**Status:** Proposed — not yet implemented`.
- [ ] Mark the PR ready for review, merge, then run the doc's Verification
      steps (§ Verification) against prod: `aws lambda get-policy` shows both
      statements, `curl` the `api_url` is not 403, and a real summarise on
      https://yt2txt.willbright.link works.

### 2. Unpushed `main` commits

Local `main` is 2 ahead of `origin/main`: `8c3ea08` (these TODO tasks) and
`d911b12` (CLAUDE.md → AGENTS.md rename + CLAUDE.md/GEMINI.md symlinks).

- [ ] Do **not** push `main` directly — that auto-deploys to prod. Both
      commits are already carried on the PR #2 branch, so merging PR #2
      lands them. If PR #2 is instead abandoned, open a small PR for these
      two commits on their own.
- [ ] Note while PR #2 is unmerged: `AGENTS.md` does not exist on
      `origin/main`, so anyone cloning fresh still sees the old `CLAUDE.md`.

### 3. Delete merged branches

- [ ] `people-sync-redesign` (local **and** `origin/`) — fully merged into
      `main`; zero diff, it is an ancestor of `main`.
- [ ] `origin/worktree-url-bar-navigation` — merged via PR #1 on 2026-05-21.

### 4. Untracked `.antigravitycli/`

Contains a single symlink into `~/.gemini/config/projects/<uuid>.json` —
per-machine tool state that points outside the repo. It must never be
committed.

- [ ] Add `.antigravitycli/` to `.gitignore`.

## People page — link video summaries to a full, readable page

On the People detail view, each researched video renders its summary inline
inside a `<details>` collapsible (`src/pages/People.jsx` — the
`<summary>Summary</summary>` block). For a long summary that is cramped and
hard to read.

Each video should instead link out to a full, dedicated page — reusing the
existing video summary page (`/summary/<videoId>` in `src/App.jsx`) so a
person's video opens the same readable article view as a History summary.

- [ ] Replace the inline `<details>` summary in `People.jsx` with a link to
      the video's full summary page.
- [ ] Resolve the cross-table gap: `/summary/<videoId>` builds `detailItem`
      from `history`, a `Scan` of the `yt2txt-summaries` table. Person-research
      summaries live in `yt2txt-people-videos`, so the link currently lands on
      "Summary not found". Pick one:
      (a) also persist person-video summaries into `yt2txt-summaries`;
      (b) have the summary page fall back to a per-person/per-video fetch; or
      (c) add a dedicated route, e.g. `/people/<person>/<videoId>`.
- [ ] Ensure the video id matches: `videoIdFromUrl()` in `App.jsx` and the
      `videoId` hash key in `yt2txt-people-videos` must produce the same id,
      or the link won't resolve.
- [ ] Decide the card UX: the link replaces the `<details>` entirely, or sits
      next to a short snippet like the History list cards.

## People page — make the "Best pick" video easy to act on

The best-pick video (the `history-card--best` card with the `★ Best pick`
badge in `src/pages/People.jsx`) is the one users most likely want to open.
Give it two clear, direct navigation paths:

- [ ] Show its summary inline on the card (expanded, not hidden behind a
      `<details>` toggle), and/or a prominent link straight to its full
      summary page.
- [ ] Add a clear, direct link to the YouTube video itself so users can jump
      to the source in one click — currently only the card title is the
      YouTube link; make it explicit (e.g. a "Watch on YouTube" action).

# Ideas

Ability to track a person who you have interest in and see what they are sayuing. Avoid watching 5-10 podcasts that are ofter highly repetitive. You just want to be able to understand their point of view. Perhaps even suggest a primary podcast to watch to "catch-up" on thier point of view.
