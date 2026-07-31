import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import { getVideoMetadata } from "./youtube.js";
import { videoIdFrom } from "./youtube-url.js";
import {
  DEFAULT_FPS, MEDIA_RESOLUTION_LOW, fpsForDuration, PROMPT_VERSION,
  SUMMARY_INDEX_PK, SUMMARY_INDEX_PK_VALUE,
} from "./constants.js";
import { generateWithFallback } from "./gemini.js";
import { SUMMARY_RESPONSE_SCHEMA, parseSummaryResponse } from "./summary-schema.js";

// The one summarise pipeline: prompt → Gemini (structured output) → summary
// item → summaries-table writes. Both entry points call it with their own
// patience — the web POST path (handler.js: 1 attempt per model, no timeout,
// throwOnNonRetryable) and person jobs (people.js: retries, backoff, per-call
// timeout). One prompt version for all videos means a video is watched at most
// once per PROMPT_VERSION, whichever path gets there first.

const SYSTEM_PROMPT = `Role: You are a no-nonsense Content Analyst. Your summary must fully replace watching the video: a reader should finish it knowing every substantive thing said, in plain English. Cut ads, fluff, repetition, and AI-sounding filler.

Task: Analyze the YouTube video at the provided URL. Use the YouTube tool to get the transcript.

Reply with a single JSON object: { "title", "markdown", "speakers" }.

title: A simple, clear title that says exactly what the video is about. No buzzwords.

speakers: Every person who actually speaks in the video — the host and any guests. Real names only. Skip anyone who is merely mentioned but never speaks, and skip generic labels like "host" or "narrator". An empty list if you cannot name anyone.

markdown: The summary as plain Markdown, in exactly this order:
1. The title again, as a Markdown heading: '# <title>'.
2. The Bottom Line: In 100 words or less, the main point and why it matters. Simple language.
3. Aha!: 3 bullets, each under 15 words — the most useful or surprising things said.
4. Claims: A '## Claims' section — a numbered list of every substantive claim, argument, prediction, or recommendation made in the video, in the order it comes up. Each entry: a bold one-line statement of the claim, then the reasoning or evidence given (keep specific numbers, names, and examples), any caveat or pushback raised, and a timestamp link. When more than one person speaks, name who makes each claim. Scale the list to the content — a dense hour deserves many entries, a thin video few. Do not pad, and do not merge distinct claims to save space.
5. What each speaker argues — only when two or more people speak: '## What each speaker argues', then a '### <Name>' subsection per named speaker with 2–4 bullets of their distinctive viewpoints (each 25 words or less) and up to 2 short verbatim-ish quotes with timestamp links. Use exactly the same names here as in the speakers field. If only one person speaks, emit instead '## Notable quotes': up to 3 short verbatim-ish quotes with timestamp links, no per-speaker subsections.

Timestamps: link like [HH:MM:SS](https://youtu.be/VIDEO_ID?t=SECONDS). Use exactly the Video ID provided below. Do not infer it from the content.
Tone: Clear, direct, and brief. Plain Markdown. No fancy jargon.`;

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE = process.env.DYNAMODB_TABLE;

const NO_VIDEO_META = { fps: DEFAULT_FPS, videoTitle: null, channelTitle: null, channelId: null };

// Frame sample rate plus the video's own title and channel, from one YouTube
// API call. Best-effort: the YouTube API is not required for summarising, so
// any failure (including a missing YOUTUBE_API_KEY) falls back to DEFAULT_FPS
// and no channel metadata rather than erroring.
async function lookupVideoMeta(videoId) {
  if (!videoId) return NO_VIDEO_META;
  try {
    const meta = await getVideoMetadata([videoId]);
    const info = meta?.[videoId];
    if (!info) return NO_VIDEO_META;
    return {
      fps: fpsForDuration(info.durationSeconds),
      videoTitle: info.title || null,
      channelTitle: info.channelTitle || null,
      channelId: info.channelId || null,
    };
  } catch (err) {
    console.warn(`metadata lookup failed for ${videoId}, using defaults`, err?.message || err);
    return NO_VIDEO_META;
  }
}

export async function getSummaryByUrl(url) {
  const res = await ddb.send(new GetCommand({ TableName: TABLE, Key: { url } }));
  return res.Item || null;
}

// Watch the video and build (but not write) a complete summaries-table item.
// `url` must already be canonical — it becomes the item's key.
export async function generateSummaryItem(ai, url, modelChain, {
  attempts = 1,
  backoffMs,
  timeoutMs = 0,
  throwOnNonRetryable = false,
  logLabel = "summarise",
} = {}) {
  const videoId = videoIdFrom(url);
  const { fps, videoTitle, channelTitle, channelId } = await lookupVideoMeta(videoId);

  // A solo speaker often never says their own name; the channel name usually
  // carries it. Included only when the metadata lookup succeeded.
  const hint = (videoTitle || channelTitle)
    ? `\nChannel: ${channelTitle || "unknown"} / Video title: ${videoTitle || "unknown"}.` +
      `\nIf a speaker never states their name, the channel name may identify them — use it only if it plausibly names a person; never invent a name.`
    : "";
  const promptText = `${SYSTEM_PROMPT}\n\nVideo URL: ${url}\nVideo ID: ${videoId}${hint}`;

  const outcome = await generateWithFallback(ai, {
    chain: modelChain,
    contents: [{
      parts: [
        { fileData: { fileUri: url }, videoMetadata: { fps } },
        { text: promptText },
      ],
    }],
    config: {
      mediaResolution: MEDIA_RESOLUTION_LOW,
      responseMimeType: "application/json",
      responseSchema: SUMMARY_RESPONSE_SCHEMA,
    },
    attempts,
    backoffMs,
    timeoutMs,
    throwOnNonRetryable,
    // A payload that fails to parse reads as an empty response — retryable, so
    // the loop advances instead of persisting junk.
    extractText: (response) => {
      const text = response.text
        || response.candidates?.[0]?.content?.parts?.map((p) => p.text).filter(Boolean).join("\n")
        || "";
      return parseSummaryResponse(text) ? text : "";
    },
    requireText: true,
    onResponse: (response, model) =>
      console.log(`${logLabel} tokens: model=${model} fps=${fps} total=${response.usageMetadata?.totalTokenCount ?? "?"}`),
    onRetryableError: (err, model, attempt) =>
      console.warn(`${logLabel}: model ${model} attempt ${attempt} failed (${err?.status || ""} ${err?.message || ""}), continuing`),
  });
  if (!outcome.ok) return { ok: false, error: outcome.error };

  const { title, markdown, speakers } = parseSummaryResponse(outcome.text);
  return {
    ok: true,
    item: {
      url,
      title,
      markdown,
      date: new Date().toISOString().split("T")[0],
      createdAt: Date.now(),
      model: outcome.model,
      videoTitle,
      channelTitle,
      channelId,
      speakers,
      // Internal, like the index key below: stamped so person jobs can tell a
      // current row from one written by an older prompt. Deliberately absent
      // from listRow() and summaryPayload().
      promptVersion: PROMPT_VERSION,
      // Constant partition key of the byCreatedAt index — this is the only
      // place new rows get it, which is what makes the index a complete feed.
      [SUMMARY_INDEX_PK]: SUMMARY_INDEX_PK_VALUE,
    },
  };
}

// First writer wins: the conditional Put keeps one row per canonical url, and
// a loser adopts the winner's row — post-deploy, any concurrent writer
// produced an equally current one. `adopted` tells the web path to mark the
// response `cached`.
export async function putFreshSummary(item) {
  try {
    await ddb.send(new PutCommand({
      TableName: TABLE,
      Item: item,
      ConditionExpression: "attribute_not_exists(#u)",
      ExpressionAttributeNames: { "#u": "url" },
    }));
    return { adopted: false, item };
  } catch (err) {
    if (err.name !== "ConditionalCheckFailedException") throw err;
    const again = await ddb.send(new GetCommand({ TableName: TABLE, Key: { url: item.url } }));
    if (again.Item) return { adopted: true, item: again.Item };
    return { adopted: false, item };
  }
}

// Upgrade of a stale row: unconditional, but preserving the old createdAt and
// date so the upgrade is invisible to the history feed's order and dates.
export async function putUpgradedSummary(item, existing) {
  const upgraded = {
    ...item,
    createdAt: typeof existing?.createdAt === "number" ? existing.createdAt : item.createdAt,
    date: existing?.date || item.date,
  };
  await ddb.send(new PutCommand({ TableName: TABLE, Item: upgraded }));
  return upgraded;
}
