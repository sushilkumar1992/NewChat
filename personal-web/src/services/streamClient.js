// Consumes the streaming Lambda Function URL (POST /messages) and dispatches
// NDJSON events: {type:"start"} {type:"token",text} {type:"done",...} {type:"error",message}.
// Loading is server-driven: the caller shows the typing indicator until the first `token`.
const STREAM_URL = (import.meta.env.VITE_STREAM_URL || "").replace(/\/$/, "") + "/";
if (!import.meta.env.VITE_STREAM_URL) {
  console.warn(
    "[Personal] VITE_STREAM_URL is not set — streaming falls back to the frontend origin. " +
    "Create personal-web/.env from .env.example with your deployed SAM StreamUrl, then RESTART `npm run dev`."
  );
}

export async function streamMessage({ sessionId, text }, handlers = {}) {
  const { onStart, onToken, onDone, onError } = handlers;
  let res;
  try {
    res = await fetch(STREAM_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId, text })
    });
  } catch (e) {
    onError && onError("Network error — please try again.");
    return;
  }
  if (!res.ok || !res.body) {
    onError && onError("The assistant is unavailable right now (" + res.status + ").");
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
