"use strict";
// Streaming Lambda (deployed behind a Lambda Function URL with InvokeMode=RESPONSE_STREAM).
// It invokes a Bedrock AgentCore runtime, relays the agent's output to the browser as NDJSON,
// and records each Q&A turn as ITS OWN small item (PK=SESSION#<id>, SK=MSG#<messageId>) under
// the session partition — the same item the per-message thumbs update. Item-per-message keeps
// any one item well under DynamoDB's 400 KB limit while a whole session stays one Query away.
//
// NDJSON events written to the client (one JSON object per line, "\n"-separated):
//   {"type":"start"}
//   {"type":"token","text":"..."}                           (many)
//   {"type":"image","images":[{url,caption?}],"imageMode":"single|stepper|stack"}  (0..n, IN ORDER)
//   {"type":"done","escalation":false,"endSession":false,"inputTokens":123,"outputTokens":456}
//   {"type":"error","message":"..."}
//
// Token usage: the agent may report `input_token` / `output_token` for the turn (same way it
// sends endSession — top level, or under `metadata` / `usage`). We store them on this turn's
// item (inputTokens / outputTokens) and forward them on `done`; the frontend sums them across
// the session and saves the totals with the session feedback.
//
// Images are streamed INLINE: the moment a line yields an image payload we emit an `image`
// event at that position in the stream, so the UI renders it exactly where it arrived —
// between text, or at the end. (Previously images were deferred to a single `done` event and
// always rendered at the bottom.) A payload may be a clean standalone line
// (`data: {"images":[...],"imageMode":"stepper"}`) OR a JSON object glued onto a text line
// (`data: Here's your statement. {"images":[...],"imageMode":"single"}`); both are handled —
// in the glued case the text part is emitted as a token and the image part as an `image` event.
// Identical consecutive image payloads are de-duplicated, so an agent that repeats the same
// block mid-stream and again at the end renders it only once.
//
// End-of-session is the LLM's decision: booleans `endSession` / `escalation` (top level or under
// `metadata`) are captured wherever they appear and forwarded on the `done` event.
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
async function logMessage({ sessionId, messageId, question, answer, escalation, endSession, inputTokens, outputTokens }) {
  const now = new Date().toISOString();
  const ts = Date.now();
  // Base fields always written. Token counts are appended only when the agent reported them for
  // this turn (a number), so a turn with no usage report doesn't overwrite anything with null.
  let setExpr =
    "SET #t = :type, sessionId = :sid, messageId = :mid, question = :q, answer = :a, " +
    "ts = :ts, escalation = :esc, endSession = :end, " +
    "createdAt = if_not_exists(createdAt, :now), updatedAt = :now";
  const vals = {
    ":type": "MESSAGE", ":sid": sessionId, ":mid": messageId,
    ":q": question, ":a": answer, ":ts": ts,
    ":esc": escalation, ":end": endSession, ":now": now
  };
  if (typeof inputTokens === "number") { setExpr += ", inputTokens = :it"; vals[":it"] = inputTokens; }
  if (typeof outputTokens === "number") { setExpr += ", outputTokens = :ot"; vals[":ot"] = outputTokens; }
  try {
    await ddb.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { PK: `SESSION#${sessionId}`, SK: `MSG#${messageId}` },
      UpdateExpression: setExpr,
      ExpressionAttributeNames: { "#t": "type" },
      ExpressionAttributeValues: vals
    }));
  } catch (e) {
    console.error("Failed to persist message to DynamoDB:", e);
  }
}

// Reads the first present numeric value among the given keys on an object (tolerates the various
// names the agent might use). Returns null if none is a finite number.
function firstNum(o, keys) {
  for (const k of keys) {
    if (o[k] == null) continue;
    const n = Number(o[k]);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

// Scans a string for the FIRST balanced {...} substring that parses as JSON AND looks like an
// agent signal (carries images / imageMode / endSession / escalation / metadata). Used to peel an
// image (or flags) object off a line that also contains answer text. Brace-matching is
// string-literal aware so a "}" inside a caption doesn't end the object early.
function findEmbeddedSignal(str) {
  for (let i = 0; i < str.length; i++) {
    if (str[i] !== "{") continue;
    let depth = 0, inStr = false, esc = false;
    for (let j = i; j < str.length; j++) {
      const c = str[j];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
      } else if (c === '"') {
        inStr = true;
      } else if (c === "{") {
        depth++;
      } else if (c === "}") {
        depth--;
        if (depth === 0) {
          const cand = str.slice(i, j + 1);
          try {
            const obj = JSON.parse(cand);
            if (obj && typeof obj === "object" && (
              "images" in obj || "imageMode" in obj ||
              "endSession" in obj || "escalation" in obj ||
              (obj.metadata && typeof obj.metadata === "object")
            )) {
              return { before: str.slice(0, i), obj, after: str.slice(j + 1) };
            }
          } catch (e) { /* not JSON — fall through and keep scanning from the next "{" */ }
          break; // this "{" didn't yield a signal object; advance outer scan
        }
      }
    }
  }
  return null;
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
  let inputTokens = null;     // token usage for THIS turn (from the agent's signal) — forwarded + stored
  let outputTokens = null;
  let lastImagesKey = null;   // JSON of the last image payload emitted — dedupes exact repeats

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

    // --- emitters -----------------------------------------------------------
    const emitToken = (t) => {
      if (t == null || t === "") return;
      fullAnswer += t;
      httpResponse.write(JSON.stringify({ type: "token", text: t }) + "\n");
    };
    const emitImages = (imgs, mode) => {
      if (!Array.isArray(imgs) || imgs.length === 0) return;
      const m = (typeof mode === "string" && mode) ? mode : "single";
      const key = JSON.stringify({ i: imgs, m });
      if (key === lastImagesKey) return;          // identical to the previous payload — skip (mid + end repeat)
      lastImagesKey = key;
      httpResponse.write(JSON.stringify({ type: "image", images: imgs, imageMode: m }) + "\n");
    };

    // Consumes a parsed object: emit its token text (if any), capture flags, and emit any images
    // INLINE at this stream position. Handles top-level and `metadata`-nested fields.
    const handleObject = (obj) => {
      const t =
        obj?.event?.contentBlockDelta?.delta?.text ??
        obj?.delta?.text ??
        obj?.text ??
        null;
      if (typeof t === "string") emitToken(t);

      // Look for signal fields at the top level, under `metadata`, and under a `usage` object
      // (covers "input_token" sent like endSession, and the Bedrock usage.inputTokens shape).
      const src = [obj, obj && obj.metadata, obj && obj.usage, obj && obj.metadata && obj.metadata.usage];
      for (const o of src) {
        if (!o || typeof o !== "object") continue;
        if (typeof o.endSession === "boolean") endSession = o.endSession;
        if (typeof o.escalation === "boolean") escalation = o.escalation;
        if (Array.isArray(o.images)) emitImages(o.images, o.imageMode);
        // Token usage for this turn (latest report wins). Accept snake_case / camelCase / plural.
        const inT = firstNum(o, ["input_token", "input_tokens", "inputTokens", "inputToken"]);
        if (inT != null) inputTokens = inT;
        const outT = firstNum(o, ["output_token", "output_tokens", "outputTokens", "outputToken"]);
        if (outT != null) outputTokens = outT;
      }
    };

    // Process one COMPLETE line (already reassembled across chunk boundaries).
    const processLine = (rawLine) => {
      const line = rawLine.replace(/\r$/, "");
      if (!line.startsWith("data:")) return;
      let payload = line.slice(5);                              // everything after "data:"
      if (payload.startsWith(" ")) payload = payload.slice(1);  // SSE: drop exactly ONE leading space
      if (payload === "") return;                               // empty data line / keep-alive
      if (payload.trim() === "[DONE]") return;

      // 1) The clean/standard shape: the whole payload is one JSON value.
      let obj;
      let parsed = true;
      try { obj = JSON.parse(payload); } catch (e) { parsed = false; }
      if (parsed) {
        if (obj && typeof obj === "object") { handleObject(obj); return; }
        if (typeof obj === "string") { emitToken(obj); return; }  // data: "quoted text"
        // number/boolean/null as a bare token — stringify defensively
        emitToken(String(payload));
        return;
      }

      // 2) Not clean JSON — it may be raw text, OR answer text with an image/flags object glued on.
      const found = findEmbeddedSignal(payload);
      if (found) {
        if (found.before && found.before.trim() !== "") emitToken(found.before);
        handleObject(found.obj);                               // emits the inline image event here
        if (found.after && found.after.trim() !== "") emitToken(found.after);
        return;
      }

      // 3) Pure raw text token — whitespace preserved.
      emitToken(payload);
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
    // (otherwise the last event — e.g. a trailing images/endSession signal — would be lost).
    buffer += decoder.decode();
    if (buffer.trim()) processLine(buffer);

    httpResponse.write(JSON.stringify({ type: "done", escalation, endSession, inputTokens, outputTokens }) + "\n");

    await logMessage({ sessionId, messageId, question: text, answer: fullAnswer, escalation, endSession, inputTokens, outputTokens });
  } catch (e) {
    console.error("StreamLambda error:", e);
    httpResponse.write(JSON.stringify({ type: "error", message: e.message || "Something went wrong." }) + "\n");
  }

  httpResponse.end();
});
