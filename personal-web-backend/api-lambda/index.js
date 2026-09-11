"use strict";
// API Lambda (behind API Gateway HTTP API). Single-table DynamoDB, item-per-message design.
// Endpoints:
//   GET  /config
//   GET  /suggestions
//   POST /sessions/{sessionId}/feedback              (session feedback + summary; = session end)
//   POST /sessions/{sessionId}/messages/feedback     (per-message thumbs; re-submittable — updates same item)
//
// CORS is handled by the HTTP API (CorsConfiguration in template.yaml), so responses here
// carry no CORS headers. The client generates the sessionId; this Lambda only consumes it
// (upsert-by-id) and never allocates one, and never recomputes the session duration.
//
// One DynamoDB table (TABLE_NAME) keyed by PK / SK. Everything for a session shares one
// partition (PK = SESSION#<sessionId>); the sort key splits it into small items so no single
// item can hit the 400 KB limit, and one Query on the PK returns the whole session:
//   PK = "CONFIG"               SK = <configKey>        -> config singleton
//   PK = "SUGGESTIONS"          SK = "ALL"              -> ALL suggestions in one item: { items: [{id,question,count}] }
//   PK = "SESSION#<sessionId>"  SK = "META"             -> session summary/feedback (tiny item)
//   PK = "SESSION#<sessionId>"  SK = "MSG#<messageId>"  -> ONE Q&A turn: question, answer, ts,
//        escalation, endSession, feedbackRating, feedbackAt (Q&A written by streaming-lambda,
//        thumbs written here). Every writer uses UpdateItem, so the two never clobber each other.

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient, GetCommand, UpdateCommand
} = require("@aws-sdk/lib-dynamodb");

const REGION = process.env.AWS_REGION || "us-east-2";
const TABLE = process.env.TABLE_NAME || "RBPOCTable";
const CONFIG_KEY = process.env.CONFIG_KEY || "default";
const SUGGESTIONS_SK = process.env.SUGGESTIONS_SK || "ALL";
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
    const res = await ddb.send(new GetCommand({ TableName: TABLE, Key: { PK: "CONFIG", SK: CONFIG_KEY } }));
    if (res.Item) {
      stored = { ...res.Item };
      delete stored.PK; delete stored.SK; delete stored.type;
    }
  } catch (e) {
    console.error("getConfig read failed, using defaults:", e);
  }
  return json(200, { ...DEFAULT_CONFIG, ...stored });
}

async function getSuggestions() {
  try {
    // All suggestions live in ONE item ({ items: [{id, question, count}] }).
    const res = await ddb.send(new GetCommand({ TableName: TABLE, Key: { PK: "SUGGESTIONS", SK: SUGGESTIONS_SK } }));
    const list = res.Item && Array.isArray(res.Item.items) ? res.Item.items : [];
    const items = list
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
  // UpdateItem on the tiny META item (its own row under the session partition), so the summary
  // never competes with the message items for the 400 KB budget. Values stored verbatim.
  await ddb.send(new UpdateCommand({
    TableName: TABLE,
    Key: { PK: `SESSION#${sessionId}`, SK: "META" },
    UpdateExpression:
      "SET #t = :type, sessionId = :sid, rating = :rating, reasons = :reasons, #o = :other, " +
      "startedAt = :startedAt, endedAt = :endedAt, durationMs = :durationMs, " +
      "messageCount = :messageCount, questionCount = :questionCount, " +
      "createdAt = if_not_exists(createdAt, :now), updatedAt = :now",
    ExpressionAttributeNames: { "#t": "type", "#o": "other" },
    ExpressionAttributeValues: {
      ":type": "SESSION_META",
      ":sid": sessionId,
      ":rating": body.rating ?? null,
      ":reasons": Array.isArray(body.reasons) ? body.reasons : [],
      ":other": typeof body.other === "string" ? body.other : "",
      ":startedAt": body.startedAt ?? null,
      ":endedAt": body.endedAt ?? null,
      ":durationMs": body.durationMs ?? null,
      ":messageCount": body.messageCount ?? null,
      ":questionCount": body.questionCount ?? null,
      ":now": now
    }
  }));
  return json(200, { ok: true });
}

async function postMessageFeedback(sessionId, body) {
  if (!body.messageId) return json(400, { error: "messageId is required" });
  const now = new Date().toISOString();
  // The thumbs live on the SAME per-message item the streaming-lambda writes (SK = MSG#<id>).
  // One UpdateItem: it sets only feedback fields (+ seeds question/answer if the turn wasn't
  // logged yet), so it merges with the Q&A without clobbering it. Re-vote updates in place.
  await ddb.send(new UpdateCommand({
    TableName: TABLE,
    Key: { PK: `SESSION#${sessionId}`, SK: `MSG#${String(body.messageId)}` },
    UpdateExpression:
      "SET #t = if_not_exists(#t, :type), sessionId = if_not_exists(sessionId, :sid), " +
      "messageId = if_not_exists(messageId, :mid), question = if_not_exists(question, :query), " +
      "answer = if_not_exists(answer, :answer), feedbackRating = :rating, feedbackAt = :now, " +
      "createdAt = if_not_exists(createdAt, :now), updatedAt = :now",
    ExpressionAttributeNames: { "#t": "type" },
    ExpressionAttributeValues: {
      ":type": "MESSAGE",
      ":sid": sessionId,
      ":mid": String(body.messageId),
      ":query": body.query ?? null,
      ":answer": body.answer ?? null,
      ":rating": body.rating ?? null,
      ":now": now
    }
  }));
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
