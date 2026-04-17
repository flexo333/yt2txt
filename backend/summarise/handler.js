import { GoogleGenAI } from "@google/genai";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";

const SYSTEM_PROMPT = `Role: You are a no-nonsense Content Analyst. Your goal is to give me the "meat" of the video in plain English. Cut all fluff, repetitive points, and AI-sounding filler.

Task: Analyze the YouTube video at the provided URL. Use the YouTube tool to get the transcript.
Instructions:
1. Title: Give me a simple, clear title that explains exactly what the video is about. No buzzwords. Use Markdown Heading format '# Title'
2. The Bottom Line (Synthesis): In 100 words or less, explain the main point and why it matters. Use simple language.
3. 3 Quick "Aha!" Moments: Give me 3 bullet points. Each must be under 15 words. Focus on the most useful or surprising things said. Put these below "The Bottom Line."
4. The Metrics (Numbers Only):
  Signal-to-Noise: (x/5)
  Clickbait Factor: (x/5)
5. Key Insights: Use headers for main topics.
 Constraint: Skip the ads and random filler conversation.
 Output: Distill the insights and a timestamp link like this: [HH:MM:SS](https://youtu.be/VIDEO_ID?t=SECONDS).
 Get the video ID from the URL and use it in the timestamp link.
Tone: Clear, direct, and brief. Use plain Markdown. No fancy jargon.`;
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE = process.env.DYNAMODB_TABLE;

const ALLOWED_MODELS = {
  "Gemma 4 26B": "models/gemma-4-26b-a4b-it",
  "Gemma 4 31B": "models/gemma-4-31b-it",
  "Gemini 2.5 Flash": "models/gemini-2.5-flash",
  "Gemini 3 Flash": "models/gemini-3-flash-preview",
  "Gemini 3.1 Flash Lite": "models/gemini-flash-lite-latest",
  "Gemini 2.5 Flash Lite": "models/gemini-2.5-flash-lite",
};

const DEFAULT_MODEL = ALLOWED_MODELS["Gemini 3 Flash"];

function extractTitle(markdown) {
  const match = markdown.match(/^#{1,2}\s+(.+)/m);
  return match ? match[1].trim() : "Untitled";
}

const JSON_HEADERS = { "Content-Type": "application/json" };

function isAllowedModel(model) {
  return Object.values(ALLOWED_MODELS).includes(model);
}

async function summarise(url, model = DEFAULT_MODEL) {
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY, apiVersion: "v1beta" });
  const response = await ai.models.generateContent({
    model,
    contents: [{
      parts: [
        { fileData: { fileUri: url } },
        { text: SYSTEM_PROMPT },
      ],
    }],
  });
  const markdown = response.text;
  const title = extractTitle(markdown);
  const date = new Date().toISOString().split("T")[0];
  const createdAt = Date.now();

  await ddb.send(new PutCommand({
    TableName: TABLE,
    Item: { url, title, markdown, date, createdAt },
  }));

  return {
    statusCode: 200,
    headers: JSON_HEADERS,
    body: JSON.stringify({ markdown, title, url, date }),
  };
}

async function listModels() {
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY, apiVersion: "v1beta" });
  const pager = await ai.models.list({});
  const names = [];
  for await (const model of pager) {
    if (model?.name) names.push(model.name);
    if (names.length >= 200) break;
  }

  return {
    statusCode: 200,
    headers: JSON_HEADERS,
    body: JSON.stringify({ models: names }),
  };
}

async function listSummaries() {
  const result = await ddb.send(new ScanCommand({ TableName: TABLE, Limit: 100 }));
  const summaries = (result.Items || [])
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 50)
    .map(({ url, title, date, createdAt, markdown }) => ({
      url, title, date, createdAt,
      summary: (markdown || '').slice(0, 8000),
    }));

  return {
    statusCode: 200,
    headers: JSON_HEADERS,
    body: JSON.stringify({ summaries }),
  };
}

export async function handler(event) {
  const method = event.requestContext?.http?.method || event.httpMethod || "GET";

  try {
    if (method === "POST") {
      const body = JSON.parse(event.body || "{}");
      if (!body.url) {
        return {
          statusCode: 400,
          headers: JSON_HEADERS,
          body: JSON.stringify({ error: "url is required" }),
        };
      }
      const model = body.model || DEFAULT_MODEL;
      if (!isAllowedModel(model)) {
        return {
          statusCode: 400,
          headers: JSON_HEADERS,
          body: JSON.stringify({
            error: "model is not supported",
            allowedModels: ALLOWED_MODELS,
          }),
        };
      }
      return await summarise(body.url, model);
    }

    if (method === "GET") {
      const shouldListModels = event.queryStringParameters?.models === "1";
      if (shouldListModels) {
        return await listModels();
      }
      return await listSummaries();
    }

    return { statusCode: 405, body: "Method Not Allowed" };
  } catch (err) {
    console.error(err);
    return {
      statusCode: 500,
      headers: JSON_HEADERS,
      body: JSON.stringify({ error: err.message }),
    };
  }
}
