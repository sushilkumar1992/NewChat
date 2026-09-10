"use strict";
// Streaming Lambda (deployed behind a Lambda Function URL with InvokeMode=RESPONSE_STREAM).
// It invokes a Bedrock AgentCore runtime, relays the agent's output to the browser as NDJSON,
// and logs each Q&A turn to DynamoDB.
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
const { DynamoDBDocumentClient, PutCommand } = require("@aws-sdk/lib-dynamodb");

const REGION = process.env.AWS_REGION || "us-east-2";
const AGENT_RUNTIME_ARN = process.env.AGENT_RUNTIME_ARN;
const TABLE_MESSAGES = process.env.TABLE_MESSAGES || "pva_messages";

const agentClient = new BedrockAgentCoreClient({ region: REGION });
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
  marshallOptions: { removeUndefinedValues: true }
});

async function logMessage(record) {
  try {
    await ddb.send(new PutCommand({ TableName: TABLE_MESSAGES, Item: record }));
  } catch (e) {
    // Logging is best-effort and must never break the stream.
    console.error("Failed to persist message to DynamoDB:", e);
  }
}

exports.handler = awslambda.streamifyResponse(async (event, responseStream) => {
  const httpResponse = awslambda.HttpResponseStream.from(responseStream, {
    statusCode: 200,
    headers: {
      "Content-Type": "application/x-ndjson",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type,Authorization",
      "Access-Control-Allow-Methods": "POST,OPTIONS"
    }
  });

  let sessionId;
  let text;
  let fullAnswer = "";
  let escalation = false;
  let endSession = false;

  try {
    const body = JSON.parse(event.body || "{}");
    sessionId = body.sessionId || body.session_id;
    text = body.text || body.prompt || "";

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

    await logMessage({
      sessionId,
      ts: Date.now(),
      question: text,
      answer: fullAnswer,
      escalation,
      endSession,
      createdAt: new Date().toISOString()
    });
  } catch (e) {
    console.error("StreamLambda error:", e);
    httpResponse.write(JSON.stringify({ type: "error", message: e.message || "Something went wrong." }) + "\n");
  }

  httpResponse.end();
});
