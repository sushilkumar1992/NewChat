"use strict";
// API Lambda (behind API Gateway HTTP API). Handles the buffered JSON endpoints:
//   GET  /config
//   GET  /suggestions
//   POST /sessions/{sessionId}/feedback              (session feedback + summary; = session end)
//   POST /sessions/{sessionId}/messages/feedback     (per-message thumbs)
//
// CORS is handled by the HTTP API (CorsConfiguration in template.yaml), so the responses
// here carry no CORS headers. The client generates the sessionId; this Lambda only consumes
// it (upsert-by-id) and never allocates one, and never recomputes the session duration.

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, GetCommand, PutCommand, ScanCommand } = require("@aws-sdk/lib-dynamodb");

const REGION = process.env.AWS_REGION || "us-east-2";
const TABLE_SESSIONS = process.env.TABLE_SESSIONS || "pva_sessions";
const TABLE_MESSAGE_FEEDBACK = process.env.TABLE_MESSAGE_FEEDBACK || "pva_message_feedback";
const TABLE_CONFIG = process.env.TABLE_CONFIG || "pva_config";
const TABLE_SUGGESTIONS = process.env.TABLE_SUGGESTIONS || "pva_suggestions";
const CONFIG_KEY = process.env.CONFIG_KEY || "default";
const SUGGESTIONS_LIMIT = Number(process.env.SUGGESTIONS_LIMIT || 5);

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
  marshallOptions: { removeUndefinedValues: true }
});

// Mirrors the frontend fallback so the UI is correct even before the config row is seeded.
const DEFAULT_CONFIG = {
  botName: "Personal",
  greeting: "Hi, I am Personal, your Virtual Assistant. How can I help you today?",
  closing:
    "Thank you for using Personal. We value your trust in us. Please share your valuable feedback (thumbs up/thumbs down) to help us improve the experience.",
  followUp: "Is there anything else I can help you with?",
  maxQuestionWords: 150,
  csrPhone: "1-800-555-0142",
  feedbackReasons: ["Incorrect answer", "Not relevant", "Missing information", "Other"]
};

const json = (statusCode, obj) => ({
  statusCode,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(obj)
});

function parseBody(event) {
  if (!event.body) return {};
  const raw = event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
  try { return JSON.parse(raw); } catch { return {}; }
}

async function getConfig() {
  let stored = {};
  try {
    const res = await ddb.send(new GetCommand({ TableName: TABLE_CONFIG, Key: { configKey: CONFIG_KEY } }));
    if (res.Item) {
      stored = { ...res.Item };
      delete stored.configKey;
    }
  } catch (e) {
    console.error("getConfig read failed, using defaults:", e);
  }
  return json(200, { ...DEFAULT_CONFIG, ...stored });
}

async function getSuggestions() {
  try {
    const res = await ddb.send(new ScanCommand({ TableName: TABLE_SUGGESTIONS }));
    const items = (res.Items || [])
      .filter((s) => s && s.question)
      .sort((a, b) => (Number(b.count) || 0) - (Number(a.count) || 0))
      .slice(0, SUGGESTIONS_LIMIT)
      .map((s) => ({ id: String(s.id), question: String(s.question) }));
    return json(200, { suggestions: items });
  } catch (e) {
    console.error("getSuggestions failed:", e);
    return json(200, { suggestions: [] });
  }
}

async function postSessionFeedback(sessionId, body) {
  const now = new Date().toISOString();
  // The frontend owns the record; store the values verbatim (no duration recompute).
  const item = {
    sessionId,
    rating: body.rating ?? null,
    reasons: Array.isArray(body.reasons) ? body.reasons : [],
    other: typeof body.other === "string" ? body.other : "",
    startedAt: body.startedAt ?? null,
    endedAt: body.endedAt ?? null,
    durationMs: body.durationMs ?? null,
    messageCount: body.messageCount ?? null,
    questionCount: body.questionCount ?? null,
    createdAt: now,
    updatedAt: now
  };
  await ddb.send(new PutCommand({ TableName: TABLE_SESSIONS, Item: item }));
  return json(200, { ok: true });
}

async function postMessageFeedback(sessionId, body) {
  if (!body.messageId) return json(400, { error: "messageId is required" });
  const item = {
    sessionId,
    messageId: String(body.messageId),
    rating: body.rating ?? null,
    query: body.query ?? null,
    answer: body.answer ?? null,
    createdAt: new Date().toISOString()
  };
  await ddb.send(new PutCommand({ TableName: TABLE_MESSAGE_FEEDBACK, Item: item }));
  return json(200, { ok: true });
}

exports.handler = async (event) => {
  const routeKey = event.routeKey || `${event.requestContext?.http?.method} ${event.rawPath}`;
  const sessionId = event.pathParameters?.sessionId ? decodeURIComponent(event.pathParameters.sessionId) : null;

  try {
    switch (routeKey) {
      case "GET /config":
        return await getConfig();
      case "GET /suggestions":
        return await getSuggestions();
      case "POST /sessions/{sessionId}/feedback":
        if (!sessionId) return json(400, { error: "sessionId is required" });
        return await postSessionFeedback(sessionId, parseBody(event));
      case "POST /sessions/{sessionId}/messages/feedback":
        if (!sessionId) return json(400, { error: "sessionId is required" });
        return await postMessageFeedback(sessionId, parseBody(event));
      default:
        return json(404, { error: "Not found", routeKey });
    }
  } catch (e) {
    console.error("API error:", e);
    return json(500, { error: "Internal error" });
  }
};
