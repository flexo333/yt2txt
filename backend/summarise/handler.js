import { GoogleGenAI } from "@google/genai";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";

const ALLOWED_ORIGINS = [
  "https://yt2txt.willbright.link",
  "http://localhost:5173",
];

const SYSTEM_PROMPT = `You are a professional content editor. I will provide a YouTube URL.
Use the YouTube tool to extract the transcript and key visuals.
Transform the content into a high-quality blog post with the following:
1. A compelling title.
2. A 'Stoic Summary' (reflecting on the core wisdom of the content).
3. Detailed thematic sections with H3 headers.
4. A 'Bright Perspective' section (professional/therapeutic application).
Maintain a clean, sophisticated, and insightful tone. Use Markdown.`;

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE = process.env.DYNAMODB_TABLE;

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type",
  };
}

function extractTitle(markdown) {
  const match = markdown.match(/^#{1,2}\s+(.+)/m);
  return match ? match[1].trim() : "Untitled";
}

async function summarise(url, origin) {
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash",
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
    headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
    body: JSON.stringify({ markdown, title, url, date }),
  };
}

async function listSummaries(origin) {
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
    headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
    body: JSON.stringify({ summaries }),
  };
}

export async function handler(event) {
  const origin = event.headers?.origin || event.headers?.Origin || "";
  const method = event.requestContext?.http?.method || event.httpMethod || "GET";

  if (method === "OPTIONS") {
    return { statusCode: 200, headers: corsHeaders(origin), body: "" };
  }

  try {
    if (method === "POST") {
      const body = JSON.parse(event.body || "{}");
      if (!body.url) {
        return {
          statusCode: 400,
          headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
          body: JSON.stringify({ error: "url is required" }),
        };
      }
      return await summarise(body.url, origin);
    }

    if (method === "GET") {
      return await listSummaries(origin);
    }

    return { statusCode: 405, headers: corsHeaders(origin), body: "Method Not Allowed" };
  } catch (err) {
    console.error(err);
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
      body: JSON.stringify({ error: err.message }),
    };
  }
}
