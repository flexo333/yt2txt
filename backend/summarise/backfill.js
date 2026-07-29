import { GoogleGenAI } from "@google/genai";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient, DeleteCommand, GetCommand, PutCommand, ScanCommand, UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { getVideoMetadata } from "./youtube.js";
import { canonicalYoutubeUrl, videoIdFrom } from "./youtube-url.js";
import { mergeFill, needsCanonicalUrl } from "./backfill-pure.js";
import { extractSpeakersFromMarkdown } from "./speakers.js";
import { DEFAULT_MODEL, SUMMARY_INDEX_PK, SUMMARY_INDEX_PK_VALUE } from "./constants.js";

// One-shot repair of summaries written before the current write path existed.
// Invoke the Lambda directly with { "__backfill": true }; add "dryRun": true to
// see what would change without writing.
//
// Four independent passes per row, each skipped if the row is already right:
//   - canonical key: move rows stored under a non-canonical URL onto the
//                    canonical `watch?v=<id>` key, folding duplicates together,
//                    so one video really is one row
//   - index key:     the byCreatedAt partition key (+ a createdAt for rows old
//                    enough to predate it), so the row appears in the feed
//   - channel/title: YouTube API, batched 50 ids per call (1 quota unit each)
//   - speakers:      the same text-only extraction the request path falls back
//                    to, run over the summary markdown already in the row
//
// Idempotent: a row is "migrated" once it has the attribute (or, for the
// canonical pass, once it is at the canonical key), so re-running only picks up
// whatever failed last time. A failed extraction writes nothing, so it is
// retried on the next run; a successful one that found nobody writes [] and is
// not revisited.

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE = process.env.DYNAMODB_TABLE;

// YouTube's videos.list accepts at most 50 ids per call.
const ID_BATCH_SIZE = 50;

// Stop and report a resume key rather than being killed mid-write.
const TIME_RESERVE_MS = 60 * 1000;

const DEFAULT_ROW_LIMIT = 500;

// A GSI is sparse: a row missing either index key is simply absent from it.
// Both keys are checked, since a row written before `createdAt` existed would
// otherwise be stamped and still never appear in the feed.
function needsIndexKey(row) {
  return row[SUMMARY_INDEX_PK] !== SUMMARY_INDEX_PK_VALUE || typeof row.createdAt !== "number";
}

// `date` is the YYYY-MM-DD the row was written; midnight on that day is close
// enough to order a pre-createdAt row against its neighbours. 0 (epoch) sorts
// such a row to the very bottom of the feed, which is where an undateable row
// belongs.
function createdAtFor(row) {
  if (typeof row.createdAt === "number") return row.createdAt;
  const parsed = Date.parse(row.date || "");
  return Number.isNaN(parsed) ? 0 : parsed;
}

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

// ── pass 1: canonical key ────────────────────────────────────────────────────
// One video, one row. The table is keyed by `url` and DynamoDB cannot change a
// key schema, so the canonical `https://www.youtube.com/watch?v=<id>` URL *is*
// the key; the POST handler now canonicalises before it reads or writes, and
// this pass moves the rows that predate that.

// Gap-fill the surviving canonical row from the duplicate about to be deleted,
// and stamp the index key while we are writing anyway (the copy path stamps it
// too). Only fills what the canonical row lacks — it is the row the app has
// been reading and writing, so it wins every collision.
async function fillCanonical(target, source, canonical) {
  const fill = mergeFill(target, source);
  fill[SUMMARY_INDEX_PK] = SUMMARY_INDEX_PK_VALUE;
  if (typeof (fill.createdAt ?? target.createdAt) !== "number") fill.createdAt = createdAtFor(source);

  const names = {};
  const values = {};
  const sets = Object.keys(fill).map((key, i) => {
    names[`#a${i}`] = key;
    values[`:a${i}`] = fill[key];
    return `#a${i} = :a${i}`;
  });
  await ddb.send(new UpdateCommand({
    TableName: TABLE,
    Key: { url: canonical },
    UpdateExpression: `SET ${sets.join(", ")}`,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  }));
}

// Get `row`'s content to the canonical key, without deleting anything.
// Returns "migrated" (the key was free, the row was copied there) or "merged"
// (a row was already there and kept, topped up from this one).
async function foldIntoCanonical(row, canonical, dryRun) {
  const existing = await ddb.send(new GetCommand({ TableName: TABLE, Key: { url: canonical } }));

  if (!existing.Item) {
    if (dryRun) return "migrated";
    const copy = { ...row, url: canonical, [SUMMARY_INDEX_PK]: SUMMARY_INDEX_PK_VALUE };
    if (typeof copy.createdAt !== "number") copy.createdAt = createdAtFor(row);
    try {
      await ddb.send(new PutCommand({
        TableName: TABLE,
        Item: copy,
        ConditionExpression: "attribute_not_exists(#u)",
        ExpressionAttributeNames: { "#u": "url" },
      }));
      return "migrated";
    } catch (err) {
      if (err.name !== "ConditionalCheckFailedException") throw err;
      // A live POST (or a concurrent backfill) claimed the key between the read
      // and the write. That row wins, exactly as if it had been there all along.
      const again = await ddb.send(new GetCommand({ TableName: TABLE, Key: { url: canonical } }));
      if (again.Item) await fillCanonical(again.Item, row, canonical);
      return "merged";
    }
  }

  if (!dryRun) await fillCanonical(existing.Item, row, canonical);
  return "merged";
}

// Move every non-canonical row onto its canonical key and delete the original.
//
// Crash-safe by ordering: the content is at the canonical key *before* the
// source row is deleted, never the other way round. A run killed between the
// two leaves both rows, and the next run finds the target already present,
// fills nothing (it is complete), and deletes the source — so a rerun after a
// partial failure converges and no row is ever lost. A rerun after a *complete*
// migration sees no non-canonical rows at all and does nothing.
//
// Returns the urls it removed (in a dry run, the ones it would remove) so the
// later passes can skip them: an UpdateCommand against a deleted key recreates
// the row it just deleted.
async function migrateCanonicalUrls(rows, { dryRun }, result) {
  const removed = new Set();
  for (const row of rows) {
    const canonical = canonicalYoutubeUrl(row.url);
    try {
      const outcome = await foldIntoCanonical(row, canonical, dryRun);
      if (outcome === "migrated") result.urlMigrated++;
      else result.urlMerged++;

      if (!dryRun) {
        await ddb.send(new DeleteCommand({ TableName: TABLE, Key: { url: row.url } }));
      }
      result.urlDeleted++;
      removed.add(row.url);
    } catch (err) {
      // Leave the source row alone and count it as outstanding: the next run
      // retries it from wherever this one got to.
      console.warn(`backfill: canonical migration failed for ${row.url}`, err?.message || err);
      result.nonCanonicalRemaining++;
    }
  }
  // A dry run wrote and deleted nothing, so every row it counted is still
  // sitting under its non-canonical key.
  if (dryRun) result.nonCanonicalRemaining += removed.size;
  return removed;
}

// Put every row into the byCreatedAt index. Pure DynamoDB — no API quota and no
// tokens — so it runs over the whole page in one go rather than being metered
// like the speaker pass. Idempotent: the write leaves both index keys present,
// so needsIndexKey() skips the row on every later run.
async function backfillIndexKeys(rows, { dryRun }) {
  let updated = 0;
  for (const row of rows) {
    updated++;
    if (dryRun) continue;
    await ddb.send(new UpdateCommand({
      TableName: TABLE,
      Key: { url: row.url },
      UpdateExpression: "SET #pk = :pk, #ca = :ca",
      ExpressionAttributeNames: { "#pk": SUMMARY_INDEX_PK, "#ca": "createdAt" },
      ExpressionAttributeValues: { ":pk": SUMMARY_INDEX_PK_VALUE, ":ca": createdAtFor(row) },
    }));
  }
  return updated;
}

// Fill channelTitle/videoTitle/channelId for a batch of rows in one API call.
// Rows are still grouped by video id rather than assumed unique: the canonical
// pass runs first and collapses duplicates, but a row it could not move (or a
// page it has not reached on this run) can still share a video with another.
async function backfillVideoMeta(rows, { dryRun }) {
  const byId = new Map();
  for (const row of rows) {
    const videoId = videoIdFrom(row.url);
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

  // urlDeleted should equal urlMigrated + urlMerged on a clean run; a gap means
  // rows were folded but not removed. nonCanonicalRemaining is the number this
  // run left behind — zero on a `done: true` run means the ?video= Scan
  // fallback in handler.js has nothing left to find and can be deleted.
  const result = {
    scanned: 0,
    urlMigrated: 0, urlMerged: 0, urlDeleted: 0, nonCanonicalRemaining: 0,
    indexUpdated: 0, metaUpdated: 0, speakersUpdated: 0,
    dryRun, done: true,
  };
  let startKey = event.startKey;

  do {
    const pageStartKey = startKey;
    const page = await scanPage(startKey);
    const rows = page.Items || [];
    result.scanned += rows.length;

    // Canonical keys first, and not only because it is cheap: it deletes rows,
    // and an UpdateCommand from a later pass would recreate whatever it deleted
    // (DynamoDB updates are upserts). `live` is the page minus those rows.
    const removed = await migrateCanonicalUrls(rows.filter(needsCanonicalUrl), { dryRun }, result);
    const live = removed.size ? rows.filter((row) => !removed.has(row.url)) : rows;

    // Cheapest pass next: if a later one runs out of time mid-page, the rows
    // it already visited are at least in the feed.
    result.indexUpdated += await backfillIndexKeys(live.filter(needsIndexKey), { dryRun });

    result.metaUpdated += await backfillVideoMeta(live.filter(needsVideoMeta), { dryRun });

    const speakerRows = live.filter(needsSpeakers);
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
