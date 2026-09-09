// Buffered HTTP API calls (sessions, feedback, end, config, suggestions).
const BASE = (import.meta.env.VITE_API_BASE_URL || "").replace(/\/$/, "");
if (!BASE) {
  console.warn(
    "[Personal] VITE_API_BASE_URL is not set — API calls fall back to the frontend origin. " +
    "Create personal-web/.env from .env.example with your deployed SAM ApiUrl, then RESTART `npm run dev`."
  );
}

async function req(path, opts = {}) {
  const res = await fetch(BASE + path, {
    method: opts.method || "GET",
    headers: { "content-type": "application/json" },
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  if (!res.ok) throw new Error("API " + res.status + " for " + path);
  return res.status === 204 ? null : res.json();
}

export const api = {
  getConfig: () => req("/config"),
  getSuggestions: () => req("/suggestions"),
  createSession: (payload) => req("/sessions", { method: "POST", body: payload }),
  postFeedback: (sessionId, payload) =>
    req(`/sessions/${encodeURIComponent(sessionId)}/feedback`, { method: "POST", body: payload }),
  postMessageFeedback: (sessionId, payload) =>
    req(`/sessions/${encodeURIComponent(sessionId)}/messages/feedback`, { method: "POST", body: payload }),
  endSession: (sessionId) =>
    req(`/sessions/${encodeURIComponent(sessionId)}/end`, { method: "POST", body: {} })
};
