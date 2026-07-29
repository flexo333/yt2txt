import { GoogleGenAI } from "@google/genai";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { extractVideoId, getVideoMetadata } from "./youtube.js";
import { extractSpeakersFromMarkdown } from "./speakers.js";
import { DEFAULT_MODEL } from "./constants.js";

// One-shot enrichment of summaries written before channel/speaker metadata
// existed. Invoke the Lambda directly with { "__backfill": true }; add
// "dryRun": true to see what would change without writing.
//
// Two independent passes per row, each skipped if the row already has the data:
//   - channel/title: YouTube API, batched 50 ids per call (1 quota unit each)
//   - speakers:      the same text-only extraction the request path falls back
//                    to, run over the summary markdown already in the row
//
// Idempotent: a row is "migrated" once it has the attribute, so re-running only
// picks up whatever failed last time. A failed extraction writes nothing, so it
// is retried on the next run; a successful one that found nobody writes [] and
// is not revisited.

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE = process.env.DYNAMODB_TABLE;

// YouTube's videos.list accepts at most 50 ids per call.
const ID_BATCH_SIZE = 50;

// Stop and report a resume key rather than being killed mid-write.
const TIME_RESERVE_MS = 60 * 1000;

const DEFAULT_ROW_LIMIT = 500;

function needsVideoMeta(row) {
  return !row.channelTitle && !row.videoTitle;
}

function needsSpeakers(row) {
  return !Array.isArray(row.speakers);
}

async function scanPage(startKey) {
  return ddb.send(new ScanCommand({
    TableName: TABLE,
    Limit: 100,
    // Omitted rather than passed as null — a resumed run that stopped on the
    // first page has no key to hand back and must start from the beginning.
    ...(startKey ? { ExclusiveStartKey: startKey } : {}),
  }));
}

// Fill channelTitle/videoTitle/channelId for a batch of rows in one API call.
// Rows are grouped by video id, not replaced: the table is keyed by the raw
// URL and the Lambda accepts both `watch?v=` and `youtu.be` forms, so the same
// video can legitimately hold several rows that all need the same metadata.
async function backfillVideoMeta(rows, { dryRun }) {
  const byId = new Map();
  for (const row of rows) {
    const videoId = extractVideoId(row.url);
    if (!videoId) continue;
    if (!byId.has(videoId)) byId.set(videoId, []);
    byId.get(videoId).push(row);
  }
  if (byId.size === 0) return 0;

  let updated = 0;
  const ids = [...byId.keys()];
  for (let i = 0; i < ids.length; i += ID_BATCH_SIZE) {
    const chunk = ids.slice(i, i + ID_BATCH_SIZE);
    let meta;
    try {
      meta = await getVideoMetadata(chunk);
    } catch (err) {
      console.warn("backfill: metadata lookup failed for a chunk", err?.message || err);
      continue;
    }
    for (const videoId of chunk) {
      const info = meta[videoId];
      // A deleted or private video returns nothing — leave the rows alone.
      if (!info || (!info.channelTitle && !info.title)) continue;
      for (const row of byId.get(videoId)) {
        updated++;
        if (dryRun) continue;
        await ddb.send(new UpdateCommand({
          TableName: TABLE,
          Key: { url: row.url },
          UpdateExpression: "SET #vt = :vt, #ct = :ct, #ci = :ci",
          ExpressionAttributeNames: { "#vt": "videoTitle", "#ct": "channelTitle", "#ci": "channelId" },
          ExpressionAttributeValues: {
            ":vt": info.title || null,
            ":ct": info.channelTitle || null,
            ":ci": info.channelId || null,
          },
        }));
      }
    }
  }
  return updated;
}

// Returns true when the row was (or would be) written. A failed extraction
// returns null from extractSpeakersFromMarkdown and writes nothing, so the row
// keeps no `speakers` attribute and a later run picks it up again — otherwise a
// rate-limit storm mid-migration would permanently mark rows as tagless.
async function backfillSpeakers(ai, model, row) {
  if (!row.markdown) return false;
  const speakers = await extractSpeakersFromMarkdown(ai, model, row.markdown);
  if (speakers === null) return false;
  await ddb.send(new UpdateCommand({
    TableName: TABLE,
    Key: { url: row.url },
    UpdateExpression: "SET #s = :s",
    ExpressionAttributeNames: { "#s": "speakers" },
    ExpressionAttributeValues: { ":s": speakers },
  }));
  return true;
}

export async function runBackfill(event = {}, context) {
  const dryRun = !!event.dryRun;
  const rowLimit = Number(event.limit) > 0 ? Number(event.limit) : DEFAULT_ROW_LIMIT;
  const model = event.model || DEFAULT_MODEL;
  const remaining = () => (context?.getRemainingTimeInMillis?.() ?? Number.MAX_SAFE_INTEGER);
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY, apiVersion: "v1beta" });

  const result = { scanned: 0, metaUpdated: 0, speakersUpdated: 0, dryRun, done: true };
  let startKey = event.startKey;

  do {
    const pageStartKey = startKey;
    const page = await scanPage(startKey);
    const rows = page.Items || [];
    result.scanned += rows.length;

    result.metaUpdated += await backfillVideoMeta(rows.filter(needsVideoMeta), { dryRun });

    const speakerRows = rows.filter(needsSpeakers);
    if (dryRun) {
      // A dry run only counts. Calling Gemini per row would spend real tokens
      // for a rehearsal, and since it writes nothing there is no attribute to
      // make a resumed run skip rows it already visited — it would replay the
      // same page forever.
      result.speakersUpdated += speakerRows.filter((row) => row.markdown).length;
    } else {
      for (const row of speakerRows) {
        if (remaining() < TIME_RESERVE_MS) {
          // Resume from this page, not the next one — its remaining rows are
          // still untouched. Rows already written this run are skipped on the
          // rescan because they now have the attribute.
          result.done = false;
          result.nextStartKey = pageStartKey || null;
          return result;
        }
        if (await backfillSpeakers(ai, model, row)) result.speakersUpdated++;
      }
    }

    startKey = page.LastEvaluatedKey;
    if (startKey && result.scanned >= rowLimit) {
      result.done = false;
      result.nextStartKey = startKey;
      return result;
    }
  } while (startKey);

  return result;
}
