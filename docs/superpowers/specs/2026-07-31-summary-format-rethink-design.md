# Summary format rethink: replace watching — design

**Date:** 2026-07-31 (amended same day by the structured-output spec)
**Companion specs:** `2026-07-31-merge-person-video-analysis-design.md` — its section 1 ("Enriched prompt") is superseded by this document's prompt text; its slicing contract is preserved unchanged. `2026-07-31-gemini-only-structured-output-design.md` — reframes this prompt's output contract as a JSON envelope `{ title, markdown, speakers[] }`; the Speakers-trailer instruction originally in this spec is gone, and the prompt text below is the amended, trailer-free version.

## Problem

`SYSTEM_PROMPT` (`backend/summarise/handler.js`) is optimised for triage — deciding whether a video deserves watching: hard word caps everywhere, Signal-to-Noise and Clickbait ratings, a compressed "Key Insights" body. But the summaries are read *instead of* watching. A triage summary flattens a dense hour-long interview into a few hundred words and drops the reasoning, numbers, and caveats a replacement summary needs.

## Decisions (made in design review)

1. **The summary's job is to replace watching**, not to filter. A reader should finish it knowing every substantive thing said.
2. **Depth scales with content.** No fixed cap: a dense hour deserves a long summary, a thin 8-minute video a short one. Fluff stays banned.
3. **Keep:** `# Title`, The Bottom Line (≤100 words, up top — it is the history feed's 300-char preview), the 3 "Aha!" bullets (they surface the surprising bits a neutral synthesis flattens), timestamp links (spot-checking and jump-in).
4. **Drop:** Signal-to-Noise and Clickbait Factor — they answer a triage question ("should I watch?") the reader no longer asks.
5. **Body becomes a claim ledger**: a numbered `## Claims` list of every substantive claim, chosen over thematic sections (most like today, most robust on weak models) and a narrative brief (best read, least skimmable, fallback models drift). The ledger maximises spot-checkability and searchability.
6. **Designed together with the person-research merge**: the prompt includes the companion spec's `## What each speaker argues` section verbatim in spirit — same heading, same ≤25-word bullets, same name-consistency rule its slicer relies on. The chronological attributed ledger and the sliceable per-person view are complementary, not redundant.

## Design

### The new `SYSTEM_PROMPT`

Replaces the current string in `backend/summarise/handler.js` (the companion spec later moves it to the shared core — the text is the same either way):

```
Role: You are a no-nonsense Content Analyst. Your summary must fully replace
watching the video: a reader should finish it knowing every substantive thing
said, in plain English. Cut ads, fluff, repetition, and AI-sounding filler.

Task: Analyze the YouTube video at the provided URL. Use the YouTube tool to
get the transcript.

Reply with a single JSON object: { "title", "markdown", "speakers" }.

title: A simple, clear title that says exactly what the video is about.
No buzzwords.

speakers: Every person who actually speaks in the video — the host and any
guests. Real names only. Skip anyone who is merely mentioned but never
speaks, and skip generic labels like "host" or "narrator". An empty list if
you cannot name anyone.

markdown: The summary as plain Markdown, in exactly this order:
1. The title again, as a Markdown heading: '# <title>'.
2. The Bottom Line: In 100 words or less, the main point and why it matters.
   Simple language.
3. Aha!: 3 bullets, each under 15 words — the most useful or surprising
   things said.
4. Claims: A '## Claims' section — a numbered list of every substantive
   claim, argument, prediction, or recommendation made in the video, in the
   order it comes up. Each entry: a bold one-line statement of the claim,
   then the reasoning or evidence given (keep specific numbers, names, and
   examples), any caveat or pushback raised, and a timestamp link. When more
   than one person speaks, name who makes each claim. Scale the list to the
   content — a dense hour deserves many entries, a thin video few. Do not
   pad, and do not merge distinct claims to save space.
5. What each speaker argues — only when two or more people speak:
   '## What each speaker argues', then a '### <Name>' subsection per named
   speaker with 2–4 bullets of their distinctive viewpoints (≤25 words each)
   and up to 2 short verbatim-ish quotes with timestamp links. Use exactly
   the same names here as in the speakers field. If only one person speaks,
   emit instead '## Notable quotes': up to 3 short verbatim-ish quotes with
   timestamp links, no per-speaker subsections.

Timestamps: link like [HH:MM:SS](https://youtu.be/VIDEO_ID?t=SECONDS). Use
exactly the Video ID provided below. Do not infer it from the content.
Tone: Clear, direct, and brief. Plain Markdown. No fancy jargon.
```

The enforcement side of the envelope — `responseSchema`, parse-or-retry
semantics, `normaliseSpeakers` over the returned array — is the
structured-output spec's; this spec owns only the text above.

### Contracts preserved

- `# Title` stays the markdown's first heading — the Summary page renders only the markdown, and the history snippet strips heading lines assuming one is there. The stored `title` now comes from the JSON `title` field; `extractTitle()` is deleted (structured-output spec).
- The Bottom Line leads (after the heading), so the history feed's 300-char preview stays meaningful.
- Speaker names arrive as the JSON `speakers` field, still normalised by `tags.js` — the trailer line no longer exists (structured-output spec supersedes the original trailer instruction here).
- Timestamp links keep the exact-Video-ID rule.
- `## What each speaker argues` / `### <Name>` match the companion spec's slicer (`speaker-section.js`) exactly.
- Nothing parses `## Claims` — it is rendered markdown only.

### Scope of change

1. `backend/summarise/handler.js` — replace the `SYSTEM_PROMPT` string (landing together with the structured-output envelope; the companion merge spec later moves it to the shared core).
2. `docs/superpowers/specs/2026-07-31-merge-person-video-analysis-design.md` section 1 — rewritten to reference this spec instead of describing an insertion into the old format. The hint block (channel/video title in the per-request text) and everything else in that spec stay as written.
3. `constants.js` `PROMPT_VERSION` (introduced by the companion spec) is born as 2 describing *this* text — there will be no version-1-enriched interlude.

Deploying the new prompt before the companion spec's shared-core work is harmless: the web path starts writing richer rows immediately; old rows are only re-watched/upgraded when that spec lands.

## Edge cases

- **A model drifts on the numbered ledger**: acceptable — nothing parses `## Claims`. The `responseSchema` enforces only the JSON envelope, not the markdown's internal structure; the whole-summary slice fallback in the merge spec covers a flubbed per-speaker section. (Gemma, the original drift suspect, is no longer an allowed model — structured-output spec.)
- **Solo videos**: attribution inside Claims switches off, and the per-speaker section is replaced by `## Notable quotes` (a follow-up interview decision on the companion spec — the claim ledger does not guarantee verbatim quotes); the summary is the person's views by construction, and the companion spec's whole-summary fallback carries the quotes along.
- **Very long dense videos**: output grows by design; output tokens are minor next to video-ingestion tokens, and `mediaResolution`/fps throttling is untouched.

## Testing

This spec changes no parsing contract of its own — the trailer cases leaving `tags.test.mjs` belong to the structured-output spec; the other pure suites (`share`, `youtube-url`, `people-pure`, `backfill-pure`) are unaffected, and `make test` must still pass. Format quality is judged by eye on the next few real summaries — there is no automated check on prompt output shape.

## Out of scope

- Implementing the companion spec (shared core, hint block, `promptVersion` plumbing, slicer module, People-page link).
- Re-summarising existing rows under the new format (that is the companion spec's upgrade-on-touch policy).

## Bookkeeping on completion

- `docs/DECISIONS.md` entry: triage format → replace-watching claim ledger; metrics dropped; ledger chosen over thematic sections and narrative brief.
- `docs/BACKLOG.md` / `docs/CHANGELOG.md` per repo convention when the prompt change ships.
