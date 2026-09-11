"use strict";
// Streaming Lambda (deployed behind a Lambda Function URL with InvokeMode=RESPONSE_STREAM).
// It invokes a Bedrock AgentCore runtime, relays the agent's output to the browser as NDJSON,
// and records each Q&A turn as ITS OWN small item (PK=SESSION#<id>, SK=MSG#<messageId>) under
// the session partition — the same item the per-message thumbs update. Item-per-message keeps
// any one item well under DynamoDB's 400 KB limit while a whole session stays one Query away.
//
// NDJSON events written to the client (one JSON object per line, "\n"-separated):
//   {"type":"start"}
//   {"type":"token","text":"..."}          (many)
//   {"type":"done","escalation":false,"endSession":false}
//   {"type":"error","message":"..."}
//
// End-of-session is the LLM's decision: if the agent emits a structured event carrying
// boolean `endSession` / `escalation` fields, we forward them on the `done` event. If it
// never does, they default to false and the user can still end via the "End chat" button.

const { BedrockAgentCoreClient, InvokeAgentRuntimeCommand } = require("@aws-sdk/client-bedrock-agentcore");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, UpdateCommand } = require("@aws-sdk/lib-dynamodb");

const REGION = process.env.AWS_REGION || "us-east-2";
const AGENT_RUNTIME_ARN = process.env.AGENT_RUNTIME_ARN;
const TABLE_NAME = process.env.TABLE_NAME || "RBPOCTable";

const agentClient = new BedrockAgentCoreClient({ region: REGION });
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
  marshallOptions: { removeUndefinedValues: true }
});

// Persists a Q&A turn as its own item (SK = MSG#<messageId>). A single UpdateItem that sets only
// the Q&A fields, so it merges with (never clobbers) any feedbackRating the api-lambda wrote for
// the same message. Best-effort — a failure must never break the stream.
async function logMessage({ sessionId, messageId, question, answer, escalation, endSession }) {
  const now = new Date().toISOString();
  const ts = Date.now();
  try {
    await ddb.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { PK: `SESSION#${sessionId}`, SK: `MSG#${messageId}` },
      UpdateExpression:
        "SET #t = :type, sessionId = :sid, messageId = :mid, question = :q, answer = :a, " +
        "ts = :ts, escalation = :esc, endSession = :end, " +
        "createdAt = if_not_exists(createdAt, :now), updatedAt = :now",
      ExpressionAttributeNames: { "#t": "type" },
      ExpressionAttributeValues: {
        ":type": "MESSAGE", ":sid": sessionId, ":mid": messageId,
        ":q": question, ":a": answer, ":ts": ts,
        ":esc": escalation, ":end": endSession, ":now": now
      }
    }));
  } catch (e) {
    console.error("Failed to persist message to DynamoDB:", e);
  }
}

exports.handler = awslambda.streamifyResponse(async (event, responseStream) => {
  const httpResponse = awslambda.HttpResponseStream.from(responseStream, {
    statusCode: 200,
    headers: {
      // CORS (including the OPTIONS preflight) is handled by the Function URL's own
      // CORS config (template.yaml FunctionUrlConfig.Cors / DEPLOYMENT.md §12.4).
      // Do NOT set Access-Control-* here as well — Lambda would append them to the
      // URL-config headers and the browser would see duplicate "Access-Control-Allow-Origin"
      // values ("*, *") and reject the response with a CORS error.
      "Content-Type": "application/x-ndjson"
    }
  });

  let sessionId;
  let text;
  let messageId;
  let fullAnswer = "";
  let escalation = false;
  let endSession = false;

  try {
    const body = JSON.parse(event.body || "{}");
    sessionId = body.sessionId || body.session_id;
    text = body.text || body.prompt || "";
    // The frontend sends its message id so this turn is stored under the same key the
    // per-message thumbs use. Fall back to a generated id if an older client omits it.
    messageId = body.messageId || ("m" + Date.now().toString(36));

    if (!sessionId || !text) {
      httpResponse.write(JSON.stringify({ type: "error", message: "sessionId and text are required" }) + "\n");
      httpResponse.end();
      return;
    }
    if (!AGENT_RUNTIME_ARN) {
      httpResponse.write(JSON.stringify({ type: "error", message: "AGENT_RUNTIME_ARN is not configured." }) + "\n");
      httpResponse.end();
      return;
    }

    const cmd = new InvokeAgentRuntimeCommand({
      agentRuntimeArn: AGENT_RUNTIME_ARN,
      runtimeSessionId: sessionId,
      payload: Buffer.from(JSON.stringify({ prompt: text, session_id: sessionId, actor_id: "default-user" }))
    });

    const agentResponse = await agentClient.send(cmd);

    httpResponse.write(JSON.stringify({ type: "start" }) + "\n");

    const decoder = new TextDecoder();
    let buffer = "";

    for await (const chunk of agentResponse.response) {
      buffer += decoder.decode(chunk, { stream: true });
      let idx;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(line.indexOf(":") + 1).trim();
        if (!payload || payload === "[DONE]") continue;

        let tokenText = null;
        try {
          const obj = JSON.parse(payload);
          tokenText =
            obj?.event?.contentBlockDelta?.delta?.text ??
            obj?.delta?.text ??
            obj?.text ??
            (typeof obj === "string" ? obj : null);

          // The agent (LLM) may signal end-of-session / escalation via structured fields.
          if (typeof obj?.endSession === "boolean") endSession = obj.endSession;
          if (typeof obj?.escalation === "boolean") escalation = obj.escalation;
          if (obj?.metadata) {
            if (typeof obj.metadata.endSession === "boolean") endSession = obj.metadata.endSession;
            if (typeof obj.metadata.escalation === "boolean") escalation = obj.metadata.escalation;
          }
        } catch {
          tokenText = payload;
        }

        if (tokenText) {
          fullAnswer += tokenText;
          httpResponse.write(JSON.stringify({ type: "token", text: tokenText }) + "\n");
        }
      }
    }

    httpResponse.write(JSON.stringify({ type: "done", escalation, endSession }) + "\n");

    await logMessage({ sessionId, messageId, question: text, answer: fullAnswer, escalation, endSession });
  } catch (e) {
    console.error("StreamLambda error:", e);
    httpResponse.write(JSON.stringify({ type: "error", message: e.message || "Something went wrong." }) + "\n");
  }

  httpResponse.end();
});
