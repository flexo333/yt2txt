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
    ExclusiveStartKey: startKey,
  }));
}

// Fill channelTitle/videoTitle/channelId for a batch of rows in one API call.
async function backfillVideoMeta(rows, { dryRun }) {
  const byId = new Map();
  for (const row of rows) {
    const videoId = extractVideoId(row.url);
    if (videoId) byId.set(videoId, row);
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
      const row = byId.get(videoId);
      // A deleted or private video returns nothing — leave the row alone.
      if (!info || (!info.channelTitle && !info.title)) continue;
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
  return updated;
}

async function backfillSpeakers(ai, model, row, { dryRun }) {
  if (!row.markdown) return null;
  const speakers = await extractSpeakersFromMarkdown(ai, model, row.markdown);
  // extractSpeakersFromMarkdown swallows its errors and returns [], which is
  // also what "no one named" looks like. Both are worth persisting: the row
  // then stops being rescanned, and a re-run can be forced by hand if needed.
  if (dryRun) return speakers;
  await ddb.send(new UpdateCommand({
    TableName: TABLE,
    Key: { url: row.url },
    UpdateExpression: "SET #s = :s",
    ExpressionAttributeNames: { "#s": "speakers" },
    ExpressionAttributeValues: { ":s": speakers },
  }));
  return speakers;
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

    for (const row of rows.filter(needsSpeakers)) {
      if (remaining() < TIME_RESERVE_MS) {
        // Resume from this page, not the next one — its remaining rows are
        // still untouched. Rows already written this run are skipped on the
        // rescan because they now have the attribute.
        result.done = false;
        result.nextStartKey = pageStartKey || null;
        return result;
      }
      const speakers = await backfillSpeakers(ai, model, row, { dryRun });
      if (speakers) result.speakersUpdated++;
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
