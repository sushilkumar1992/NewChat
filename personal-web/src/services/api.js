// Buffered HTTP API calls (config, suggestions, session feedback, per-message feedback).
const BASE = (import.meta.env.VITE_API_BASE_URL || "").replace(/\/$/, "");
if (!BASE) {
  console.warn(
    "[Personal] VITE_API_BASE_URL is not set — API calls fall back to the frontend origin. " +
    "Create personal-web/.env from .env.example with your deployed SAM ApiUrl, then RESTART `npm run dev`."
  );
}

async function req(path, opts = {}) {
  // Only send content-type when there is a JSON body. A GET that sets
  // "content-type: application/json" is NOT a CORS "simple request", so it would
  // trigger an extra preflight OPTIONS on every /config and /suggestions call.
  // Header-less GETs stay simple and skip the preflight entirely.
  const headers = {};
  if (opts.body) headers["content-type"] = "application/json";
  const res = await fetch(BASE + path, {
    method: opts.method || "GET",
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  if (!res.ok) throw new Error("API " + res.status + " for " + path);
  return res.status === 204 ? null : res.json();
}

export const api = {
  getConfig: () => req("/config"),
  getSuggestions: () => req("/suggestions"),
  // Session feedback + summary, sent once when the user submits feedback — which is
  // also the moment the session ends. The client owns and sends the whole record:
  // rating/reasons/other plus startedAt, endedAt, durationMs, messageCount and
  // questionCount. The backend only consumes these and persists them (DynamoDB); it
  // must NOT recompute or override the duration. (Session ids are client-generated, so
  // there is no createSession/endSession call — the backend consumes the id lazily on
  // /messages and on this feedback write.)
  postFeedback: (sessionId, payload) =>
    req(`/sessions/${encodeURIComponent(sessionId)}/feedback`, { method: "POST", body: payload }),
  // Per-message thumbs up/down on an individual bot answer (independent of session end).
  postMessageFeedback: (sessionId, payload) =>
    req(`/sessions/${encodeURIComponent(sessionId)}/messages/feedback`, { method: "POST", body: payload })
};
