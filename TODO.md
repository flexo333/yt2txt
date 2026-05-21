# TODO

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
