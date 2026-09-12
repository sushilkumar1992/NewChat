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
//   {"type":"done","escalation":false,"endSession":false,"images":null,"imageMode":null}
//   {"type":"error","message":"..."}
//
// End-of-session is the LLM's decision: if the agent emits a structured event carrying
// boolean `endSession` / `escalation` fields, we forward them on the `done` event. If it
// never does, they default to false and the user can still end via the "End chat" button.
//
// Chunk handling: the agent response arrives as bytes, so a chunk can split a line mid-way and
// the last line can arrive with no trailing "\n". We (1) buffer until a full "\n" to reassemble
// split lines, (2) flush the decoder and process the final partial line so the last event is
// never lost, and (3) preserve each token's whitespace (only a trailing CR and one SSE leading
// space are stripped) so words are never glued together at chunk boundaries.

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
  let images = null;      // [{ url, caption? }, ...] from the agent, relayed on `done`
  let imageMode = null;   // "single" | "stepper" | "stack"

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

    console.log("AGENTCORE_REQUEST", event);

    const cmd = new InvokeAgentRuntimeCommand({
      agentRuntimeArn: AGENT_RUNTIME_ARN,
      runtimeSessionId: sessionId,
      payload: Buffer.from(JSON.stringify({ prompt: text, session_id: sessionId, actor_id: "default-user" }))
    });

    const agentResponse = await agentClient.send(cmd);

    httpResponse.write(JSON.stringify({ type: "start" }) + "\n");

    const decoder = new TextDecoder();
    let buffer = "";

    console.log("AGENTCORE_RESPONSE", agentResponse.response);

    // Process one COMPLETE line (already reassembled across chunk boundaries). We preserve the
    // token's own whitespace: only a trailing CR and, per SSE, one leading space are removed.
    const processLine = (rawLine) => {
      const line = rawLine.replace(/\r$/, "");
      if (!line.startsWith("data:")) return;
      let payload = line.slice(5);                              // everything after "data:"
      if (payload.startsWith(" ")) payload = payload.slice(1);  // SSE: drop exactly ONE leading space
      if (payload === "") return;                               // empty data line / keep-alive
      if (payload.trim() === "[DONE]") return;

      let tokenText = null;
      try {
        const obj = JSON.parse(payload);                        // JSON.parse tolerates surrounding whitespace
        tokenText =
          obj?.event?.contentBlockDelta?.delta?.text ??
          obj?.delta?.text ??
          obj?.text ??
          (typeof obj === "string" ? obj : null);

        // The agent (LLM) may signal end-of-session / escalation and attach images via
        // structured fields — at the top level or under `metadata`. Latest value wins.
        const src = [obj, obj && obj.metadata];
        for (const o of src) {
          if (!o || typeof o !== "object") continue;
          if (typeof o.endSession === "boolean") endSession = o.endSession;
          if (typeof o.escalation === "boolean") escalation = o.escalation;
          if (Array.isArray(o.images)) images = o.images;
          if (typeof o.imageMode === "string") imageMode = o.imageMode;
        }
      } catch {
        tokenText = payload;                                    // raw text token — whitespace preserved
      }

      if (tokenText) {
        fullAnswer += tokenText;
        httpResponse.write(JSON.stringify({ type: "token", text: tokenText }) + "\n");
      }
    };

    for await (const chunk of agentResponse.response) {
      console.log("AGENTCORE_RESPONSE_CHUNK", chunk);

      buffer += decoder.decode(chunk, { stream: true });        // a chunk may split a line mid-way
      let idx;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        processLine(buffer.slice(0, idx));
        buffer = buffer.slice(idx + 1);
      }
    }
    // Flush the decoder and process the final line, which may arrive WITHOUT a trailing "\n"
    // (otherwise the last event — e.g. the images/endSession signal — would be lost).
    buffer += decoder.decode();
    if (buffer.trim()) processLine(buffer);

    httpResponse.write(JSON.stringify({ type: "done", escalation, endSession, images, imageMode }) + "\n");

    await logMessage({ sessionId, messageId, question: text, answer: fullAnswer, escalation, endSession });
  } catch (e) {
    console.error("StreamLambda error:", e);
    httpResponse.write(JSON.stringify({ type: "error", message: e.message || "Something went wrong." }) + "\n");
  }

  httpResponse.end();
});
