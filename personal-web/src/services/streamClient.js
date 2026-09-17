// Consumes the streaming Lambda Function URL (POST /messages) and dispatches
// NDJSON events: {type:"start"} {type:"token",text} {type:"image",images,imageMode}
//                {type:"done",escalation?,endSession?} {type:"error",message}.
// `image` events arrive IN STREAM ORDER; the caller renders each at the position it arrives.
//
// The Function URL is PRIVATE (AuthType AWS_IAM), so every request is SigV4-signed with the
// temporary AWS credentials the signed-in user gets from the Cognito Identity Pool. Unsigned /
// unauthenticated calls are rejected by AWS with 403 before the Lambda runs.
import { AwsClient } from "aws4fetch";
import { fetchAuthSession } from "aws-amplify/auth";
import { AWS_REGION } from "./auth.js";

const STREAM_URL = (import.meta.env.VITE_STREAM_URL || "").replace(/\/$/, "") + "/";
if (!import.meta.env.VITE_STREAM_URL) {
  console.warn(
    "[Personal] VITE_STREAM_URL is not set — streaming falls back to the frontend origin. " +
    "Create personal-web/.env from .env.example with your deployed SAM StreamFunctionUrl, then RESTART `npm run dev`."
  );
}

export async function streamMessage({ sessionId, text, messageId }, handlers = {}) {
  const { onStart, onToken, onImage, onDone, onError } = handlers;

  let res;
  try {
    // Temp AWS creds from the Cognito Identity Pool (populated once the user is signed in).
    const { credentials } = await fetchAuthSession();
    if (!credentials || !credentials.accessKeyId) {
      onError && onError("Your session has expired — please sign in again.");
      return;
    }
    const aws = new AwsClient({
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      sessionToken: credentials.sessionToken,
      region: AWS_REGION,
      service: "lambda"                     // Function URL invocation is SigV4 for the "lambda" service
    });
    res = await aws.fetch(STREAM_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId, text, messageId })
    });
  } catch (e) {
    onError && onError("Network error — please try again.");
    return;
  }
  if (!res.ok || !res.body) {
    const msg = res.status === 403
      ? "Not authorized — please sign in again."
      : "The assistant is unavailable right now (" + res.status + ").";
    onError && onError(msg);
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const dispatch = (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let evt;
    try { evt = JSON.parse(trimmed); } catch (e) { return; }
    if (evt.type === "start") onStart && onStart(evt);
    else if (evt.type === "token") onToken && onToken(evt.text || "");
    else if (evt.type === "image") onImage && onImage(evt);
    else if (evt.type === "done") onDone && onDone(evt);
    else if (evt.type === "error") onError && onError(evt.message || "Something went wrong.");
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      dispatch(buffer.slice(0, idx));
      buffer = buffer.slice(idx + 1);
    }
  }
  if (buffer) dispatch(buffer); // trailing line without newline
}
