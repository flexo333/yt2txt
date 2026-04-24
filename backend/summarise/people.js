import { GoogleGenAI } from "@google/genai";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, QueryCommand, ScanCommand, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { searchVideosByPerson, getVideoMetadata } from "./youtube.js";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const lambda = new LambdaClient({});

const PEOPLE_TABLE = process.env.PEOPLE_TABLE;
const PEOPLE_VIDEOS_TABLE = process.env.PEOPLE_VIDEOS_TABLE;
const SELF_FUNCTION_NAME = process.env.AWS_LAMBDA_FUNCTION_NAME;

const MAX_VIDEOS = 8;

const TERMINAL_STATES = new Set([
  "JOB_STATE_SUCCEEDED",
  "JOB_STATE_FAILED",
  "JOB_STATE_CANCELLED",
  "JOB_STATE_EXPIRED",
  "JOB_STATE_PARTIALLY_SUCCEEDED",
]);

const VIDEO_PROMPT = `Role: You are a no-nonsense Content Analyst extracting what a specific named person says in a YouTube video.

Task: Analyze the video at the provided URL. Focus on what the named person expresses — their viewpoints, arguments, predictions, and advice. Ignore filler, ads, and content from other participants unless it provides essential context.

Output (plain Markdown):
1. '# Title' — the video's title.
2. 'Speaker focus: <name>' — the person we're tracking.
3. 'Key viewpoints' — 3–6 bullets capturing this person's distinctive points. Each bullet ≤ 25 words.
4. 'Notable quotes' — up to 3 short verbatim-ish quotes with timestamp links like [MM:SS](https://youtu.be/VIDEO_ID?t=SECONDS).
5. 'Topics covered' — comma-separated short tags.

Keep it tight. No preamble, no recap, no filler.`;

const META_PROMPT = (displayName) => `Role: Synthesis analyst. You are given multiple summaries of videos featuring ${displayName}. Produce a single overview of their recurring viewpoints across these videos.

Output strictly as JSON with this shape:
{
  "markdown": "<markdown overview>",
  "bestVideoId": "<videoId of the single most worthwhile video to watch>",
  "bestVideoReason": "<one sentence, under 25 words>"
}

The markdown should contain:
- '# ${displayName} — overview'
- 'Recurring themes' (3–6 bullets; after each bullet, cite supporting videos as [title](url))
- 'Distinctive views' (what makes this person's perspective notable)
- 'Evolution / changes of mind' (if any, else omit)
- 'Best video to watch' (one line, naming the chosen video)

Respond with JSON only — no prose before or after.`;

export function normalisePerson(name) {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

const JSON_HEADERS = { "Content-Type": "application/json" };

async function loadPerson(person) {
  const res = await ddb.send(new GetCommand({ TableName: PEOPLE_TABLE, Key: { person } }));
  return res.Item || null;
}

async function loadPersonVideos(person) {
  const res = await ddb.send(new QueryCommand({
    TableName: PEOPLE_VIDEOS_TABLE,
    KeyConditionExpression: "#p = :p",
    ExpressionAttributeNames: { "#p": "person" },
    ExpressionAttributeValues: { ":p": person },
  }));
  return res.Items || [];
}

export async function researchPerson(displayName, model) {
  const person = normalisePerson(displayName);
  if (!person) {
    return { statusCode: 400, headers: JSON_HEADERS, body: JSON.stringify({ error: "person name required" }) };
  }

  const existing = await loadPerson(person);
  if (existing && (existing.status === "running" || existing.status === "batch_pending" || existing.status === "queued")) {
    return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ person, status: existing.status, alreadyRunning: true }) };
  }

  await ddb.send(new PutCommand({
    TableName: PEOPLE_TABLE,
    Item: {
      person,
      displayName,
      status: "queued",
      progress: { current: 0, total: 0 },
      queuedAt: Date.now(),
      model: model || null,
    },
  }));

  await lambda.send(new InvokeCommand({
    FunctionName: SELF_FUNCTION_NAME,
    InvocationType: "Event",
    Payload: Buffer.from(JSON.stringify({
      __personJob: true,
      person,
      displayName,
      model: model || null,
    })),
  }));

  return {
    statusCode: 202,
    headers: JSON_HEADERS,
    body: JSON.stringify({ person, status: "queued" }),
  };
}

async function updatePerson(person, attrs) {
  const names = {};
  const values = {};
  const sets = [];
  for (const [k, v] of Object.entries(attrs)) {
    names[`#${k}`] = k;
    values[`:${k}`] = v;
    sets.push(`#${k} = :${k}`);
  }
  await ddb.send(new UpdateCommand({
    TableName: PEOPLE_TABLE,
    Key: { person },
    UpdateExpression: `SET ${sets.join(", ")}`,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  }));
}

function buildInlinedRequest(url, displayName) {
  return {
    contents: [{
      parts: [
        { fileData: { fileUri: url } },
        { text: `Speaker to focus on: ${displayName}\n\n${VIDEO_PROMPT}` },
      ],
    }],
  };
}

export async function runPersonJob({ person, displayName, model }) {
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY, apiVersion: "v1beta" });
  const chosenModel = model || "models/gemini-3-flash-preview";

  try {
    await updatePerson(person, {
      status: "running",
      progress: { current: 0, total: 0, phase: "searching" },
      startedAt: Date.now(),
    });

    const candidates = await searchVideosByPerson(displayName, { max: MAX_VIDEOS, months: 6 });
    const existing = await loadPersonVideos(person);
    const existingIds = new Set(existing.map(v => v.videoId));
    const fresh = candidates.filter(c => !existingIds.has(c.videoId));

    if (fresh.length === 0) {
      await finalisePerson(ai, chosenModel, person, displayName);
      return;
    }

    const metaMap = await getVideoMetadata(fresh.map(c => c.videoId));

    for (const v of fresh) {
      const m = metaMap[v.videoId] || {};
      await ddb.send(new PutCommand({
        TableName: PEOPLE_VIDEOS_TABLE,
        Item: {
          person,
          videoId: v.videoId,
          url: v.url,
          title: v.title,
          channelTitle: v.channelTitle,
          publishedAt: v.publishedAt,
          durationSeconds: m.durationSeconds || 0,
          viewCount: m.viewCount || 0,
          markdown: "",
          model: chosenModel,
          status: "batch_pending",
          queuedAt: Date.now(),
        },
      }));
    }

    const inlinedRequests = fresh.map(v => buildInlinedRequest(v.url, displayName));
    const batchKeys = fresh.map(v => v.videoId);

    const batch = await ai.batches.create({
      model: chosenModel,
      src: inlinedRequests,
      config: { displayName: `yt2txt-${person}-${Date.now()}` },
    });

    await updatePerson(person, {
      status: "batch_pending",
      progress: { current: 0, total: fresh.length, phase: "batch_pending" },
      batchName: batch.name,
      batchKeys,
      batchSubmittedAt: Date.now(),
    });
  } catch (err) {
    console.error("person job submit failed", err);
    await updatePerson(person, {
      status: "error",
      errorMessage: String(err?.message || err),
    });
  }
}

async function generateMeta(ai, model, displayName, videos) {
  const context = videos.map(v =>
    `--- Video: ${v.title} (${v.url}) videoId=${v.videoId} ---\n${v.markdown}\n`
  ).join("\n");

  const response = await ai.models.generateContent({
    model,
    contents: [{
      parts: [
        { text: META_PROMPT(displayName) },
        { text: `\n\nVideo summaries:\n\n${context}` },
      ],
    }],
  });

  const raw = response.text || "";
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("meta response did not contain JSON");
  return JSON.parse(jsonMatch[0]);
}

async function finalisePerson(ai, model, person, displayName) {
  await updatePerson(person, {
    status: "finalising",
    progress: { phase: "meta" },
  });

  const allVideos = (await loadPersonVideos(person)).filter(v => v.markdown);
  let metaResult = { markdown: "", bestVideoId: null, bestVideoReason: "" };
  if (allVideos.length > 0) {
    metaResult = await generateMeta(ai, model, displayName, allVideos);
  }

  await updatePerson(person, {
    status: "done",
    meta: metaResult,
    lastRunAt: Date.now(),
    progress: { current: allVideos.length, total: allVideos.length, phase: "done" },
  });
}

async function handleBatchResult(ai, personRow, batch) {
  const { person, displayName, model, batchKeys = [] } = personRow;
  const chosenModel = model || "models/gemini-3-flash-preview";

  const responses = batch?.dest?.inlinedResponses || [];
  let successes = 0;
  let failures = 0;

  for (let i = 0; i < batchKeys.length; i++) {
    const videoId = batchKeys[i];
    const entry = responses[i];
    if (!entry) {
      failures++;
      continue;
    }
    if (entry.error) {
      failures++;
      await ddb.send(new UpdateCommand({
        TableName: PEOPLE_VIDEOS_TABLE,
        Key: { person, videoId },
        UpdateExpression: "SET #s = :s, errorMessage = :e",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":s": "error",
          ":e": String(entry.error?.message || entry.error?.code || "batch error"),
        },
      }));
      continue;
    }
    const markdown = entry.response?.text
      || entry.response?.candidates?.[0]?.content?.parts?.map(p => p.text).filter(Boolean).join("\n")
      || "";
    if (!markdown) {
      failures++;
      await ddb.send(new UpdateCommand({
        TableName: PEOPLE_VIDEOS_TABLE,
        Key: { person, videoId },
        UpdateExpression: "SET #s = :s, errorMessage = :e",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: { ":s": "error", ":e": "empty response" },
      }));
      continue;
    }
    successes++;
    await ddb.send(new UpdateCommand({
      TableName: PEOPLE_VIDEOS_TABLE,
      Key: { person, videoId },
      UpdateExpression: "SET markdown = :m, #s = :s, summarisedAt = :t",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: {
        ":m": markdown,
        ":s": "done",
        ":t": Date.now(),
      },
    }));
  }

  await updatePerson(person, {
    progress: { current: successes, total: batchKeys.length, phase: "meta", failures },
  });

  await finalisePerson(ai, chosenModel, person, displayName);
}

export async function pollPendingBatches() {
  const res = await ddb.send(new ScanCommand({
    TableName: PEOPLE_TABLE,
    FilterExpression: "#s = :s",
    ExpressionAttributeNames: { "#s": "status" },
    ExpressionAttributeValues: { ":s": "batch_pending" },
  }));
  const rows = res.Items || [];
  if (rows.length === 0) return { polled: 0, completed: 0 };

  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY, apiVersion: "v1beta" });
  let completed = 0;

  for (const row of rows) {
    if (!row.batchName) continue;
    try {
      const batch = await ai.batches.get({ name: row.batchName });
      const state = batch?.state;
      if (!state || !TERMINAL_STATES.has(state)) {
        await updatePerson(row.person, { lastPolledAt: Date.now() });
        continue;
      }
      if (state === "JOB_STATE_SUCCEEDED" || state === "JOB_STATE_PARTIALLY_SUCCEEDED") {
        await handleBatchResult(ai, row, batch);
        completed++;
      } else {
        await updatePerson(row.person, {
          status: "error",
          errorMessage: `batch ${state}: ${batch?.error?.message || "no detail"}`,
        });
      }
    } catch (err) {
      console.error("poll error for", row.person, err);
      await updatePerson(row.person, { lastPolledAt: Date.now(), lastPollError: String(err?.message || err) });
    }
  }

  return { polled: rows.length, completed };
}

export async function getPerson(displayName) {
  const person = normalisePerson(displayName);
  const [record, videos] = await Promise.all([loadPerson(person), loadPersonVideos(person)]);
  if (!record) {
    return { statusCode: 404, headers: JSON_HEADERS, body: JSON.stringify({ error: "not found" }) };
  }
  videos.sort((a, b) => (b.publishedAt || "").localeCompare(a.publishedAt || ""));
  return {
    statusCode: 200,
    headers: JSON_HEADERS,
    body: JSON.stringify({ ...record, videos }),
  };
}

export async function listPeople() {
  const res = await ddb.send(new ScanCommand({ TableName: PEOPLE_TABLE, Limit: 100 }));
  const items = (res.Items || []).map(({ person, displayName, status, lastRunAt, progress }) => ({
    person, displayName, status, lastRunAt, progress,
  }));
  items.sort((a, b) => (b.lastRunAt || 0) - (a.lastRunAt || 0));
  return {
    statusCode: 200,
    headers: JSON_HEADERS,
    body: JSON.stringify({ people: items }),
  };
}
