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

const VIDEO_GAP_MS = 60_000;
const MAX_VIDEOS = 6;

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

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

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
  if (existing && existing.status === "running") {
    return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ person, status: "running", alreadyRunning: true }) };
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

async function summariseVideo(ai, model, url, displayName) {
  const response = await ai.models.generateContent({
    model,
    contents: [{
      parts: [
        { fileData: { fileUri: url } },
        { text: `Speaker to focus on: ${displayName}\n\n${VIDEO_PROMPT}` },
      ],
    }],
  });
  return response.text;
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
    const metaMap = await getVideoMetadata(fresh.map(c => c.videoId));

    await updatePerson(person, {
      progress: { current: 0, total: fresh.length, phase: "summarising" },
    });

    for (let i = 0; i < fresh.length; i++) {
      const v = fresh[i];
      await updatePerson(person, {
        progress: {
          current: i,
          total: fresh.length,
          phase: "summarising",
          currentTitle: v.title,
        },
      });

      if (i > 0) await sleep(VIDEO_GAP_MS);

      const markdown = await summariseVideo(ai, chosenModel, v.url, displayName);
      const meta = metaMap[v.videoId] || {};

      await ddb.send(new PutCommand({
        TableName: PEOPLE_VIDEOS_TABLE,
        Item: {
          person,
          videoId: v.videoId,
          url: v.url,
          title: v.title,
          channelTitle: v.channelTitle,
          publishedAt: v.publishedAt,
          durationSeconds: meta.durationSeconds || 0,
          viewCount: meta.viewCount || 0,
          markdown,
          model: chosenModel,
          summarisedAt: Date.now(),
        },
      }));
    }

    await updatePerson(person, {
      progress: { current: fresh.length, total: fresh.length, phase: "meta" },
    });

    const allVideos = await loadPersonVideos(person);
    let metaResult = { markdown: "", bestVideoId: null, bestVideoReason: "" };
    if (allVideos.length > 0) {
      metaResult = await generateMeta(ai, chosenModel, displayName, allVideos);
    }

    await updatePerson(person, {
      status: "done",
      meta: metaResult,
      lastRunAt: Date.now(),
      progress: { current: allVideos.length, total: allVideos.length, phase: "done" },
    });
  } catch (err) {
    console.error("person job failed", err);
    await updatePerson(person, {
      status: "error",
      errorMessage: String(err?.message || err),
    });
  }
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
