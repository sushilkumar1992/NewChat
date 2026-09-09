# Personal Virtual Assistant — Frontend ↔ Backend API Contracts

This document specifies every HTTP contract the **`personal-web`** frontend (React + Vite) depends on. It is the source of truth for the backend implementation (AWS serverless: API Gateway + Lambda + DynamoDB, plus one streaming Lambda Function URL).

> **Golden rule — session ownership:** The **frontend generates the `sessionId`** (a v4 UUID) and owns the entire session record (start time, end time, duration, message counts). The **backend only consumes** these values and persists them. The backend **must not** generate a session id and **must not** recompute or override the duration or timestamps.

---

## 1. Environment & base URLs

The frontend reads two base URLs from environment variables (`personal-web/.env`, see `.env.example`):

| Variable | Purpose | Used by |
|---|---|---|
| `VITE_API_BASE_URL` | HTTP API base (API Gateway) | `/config`, `/suggestions`, session feedback, per-message feedback |
| `VITE_STREAM_URL` | Streaming Lambda **Function URL** (RESPONSE_STREAM) | `POST` message → streamed answer |

Two distinct origins are expected: the buffered JSON API on `VITE_API_BASE_URL`, and the streaming endpoint on `VITE_STREAM_URL` (a Lambda Function URL configured with `InvokeMode: RESPONSE_STREAM`).

### Conventions

- **Content type:** All requests send `Content-Type: application/json`. Buffered responses are JSON.
- **Auth:** None currently. No `Authorization` header is sent. (If you add auth later, coordinate — the frontend must be updated.)
- **CORS:** All endpoints are called from the browser. Every endpoint **must** return permissive CORS headers and handle the `OPTIONS` preflight (the JSON content type triggers a preflight). At minimum: `Access-Control-Allow-Origin`, `Access-Control-Allow-Methods`, `Access-Control-Allow-Headers: content-type`.
- **Status codes:** Return `2xx` on success. The frontend treats any non-`2xx` as a failure. `204 No Content` is acceptable where noted. `GET /config` and `GET /suggestions` failures are non-fatal (the UI degrades gracefully), but the write endpoints should return `2xx` so data is captured.
- **`sessionId` format:** RFC 4122 **v4 UUID**, e.g. `f47ac10b-58cc-4372-a567-0e02b2c3d479`. It is URL-encoded when placed in a path.

---

## 2. Endpoint summary

| # | Method | Path / URL | Purpose | Blocking? |
|---|---|---|---|---|
| 1 | `GET`  | `{API}/config` | Bot copy & UI config | On load (non-fatal) |
| 2 | `GET`  | `{API}/suggestions` | Top suggested questions | On load (non-fatal) |
| 3 | `POST` | `{STREAM_URL}` | Ask a question → streamed answer | Yes (streamed) |
| 4 | `POST` | `{API}/sessions/{sessionId}/feedback` | Session feedback **+ full session summary** (also = session end) | Best-effort |
| 5 | `POST` | `{API}/sessions/{sessionId}/messages/feedback` | Per-message thumbs up/down | Non-blocking |

There is **no** `POST /sessions` (create) and **no** `POST /sessions/{id}/end`. The backend sees a `sessionId` for the first time on endpoint 3 or 4 and should **upsert** (create-if-absent).

---

## 3. `GET /config`

Returns bot display copy and UI configuration. Called once on app load. If it fails or is slow, the frontend renders with built-in fallback values, so all fields are **optional** — but returning them lets you control copy centrally.

**Request**

```
GET {API}/config
```

No body.

**Response** — `200 OK`

```json
{
  "botName": "Personal",
  "greeting": "Hi, I am Personal, your Virtual Assistant. How can I help you today?",
  "closing": "Thank you for using Personal. We value your trust in us. Please share your valuable feedback (thumbs up/thumbs down) to help us improve the experience.",
  "followUp": "Is there anything else I can help you with?",
  "followUpYes": "Sure! Go ahead and type your question below.",
  "maxQuestionWords": 150,
  "csrPhone": "1-800-555-0142",
  "feedbackReasons": ["Incorrect answer", "Not relevant", "Missing information", "Other"]
}
```

| Field | Type | Notes |
|---|---|---|
| `botName` | string | Shown in the chat header. |
| `greeting` | string | First bot message when the chat opens. |
| `closing` | string | Bot message shown when the user ends the chat. |
| `followUp` | string | Prompt shown after each answer ("anything else?"). |
| `followUpYes` | string | Reply if the user answers "yes" to the follow-up. |
| `maxQuestionWords` | number | Hard word cap enforced in the composer (default 150). |
| `csrPhone` | string | Support phone (reserved for escalation display). |
| `feedbackReasons` | string[] | Reason chips shown on a thumbs-**down** session rating. Include `"Other"` to enable the free-text box. |

> **Note:** Per-message feedback on/off is controlled by a **frontend** env flag (`VITE_ENABLE_MESSAGE_FEEDBACK`), not by `/config`. Any `messageFeedback` value returned here is ignored by the client.

---

## 4. `GET /suggestions`

Returns the top suggested questions shown as clickable chips. Called once on load. If it fails or returns an empty list, the suggestions UI is **hidden entirely**.

**Request**

```
GET {API}/suggestions
```

No body.

**Response** — `200 OK`

```json
{
  "suggestions": [
    { "id": "q1", "question": "How do I reset my password?" },
    { "id": "q2", "question": "Where can I view my statements?" }
  ]
}
```

| Field | Type | Notes |
|---|---|---|
| `suggestions` | array | May be empty or omitted → UI hidden. |
| `suggestions[].id` | string | Stable unique key. |
| `suggestions[].question` | string | The chip label; sent as the question when clicked. |

---

## 5. `POST {STREAM_URL}` — ask a question (streaming)

The core Q&A call. The frontend POSTs the user's question and reads a **streamed** response as newline-delimited JSON (NDJSON). This must be a Lambda **Function URL** with `InvokeMode: RESPONSE_STREAM`.

**Request**

```
POST {STREAM_URL}
Content-Type: application/json
```

```json
{
  "sessionId": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
  "text": "How do I reset my password?"
}
```

| Field | Type | Notes |
|---|---|---|
| `sessionId` | string (UUID) | Client-generated. **Upsert** the session on first sight. |
| `text` | string | The user's question (already word-capped client-side). |

**Response** — streamed body

Emit **newline-delimited JSON objects** (one JSON object per line, separated by `\n`). The client parses each line as it arrives. Recommended `Content-Type: application/x-ndjson` (the client reads the raw stream and does not depend on the header).

Event types (the `type` field discriminates each line):

| `type` | Shape | Meaning |
|---|---|---|
| `start` | `{ "type": "start" }` | Optional. Signals the stream opened. |
| `token` | `{ "type": "token", "text": "partial " }` | A chunk of the answer. Sent many times. **The typing indicator hides on the first `token`.** |
| `done` | `{ "type": "done", "images": [...], "imageMode": "single", "escalation": false }` | Terminal success event. Carries optional attachments. |
| `error` | `{ "type": "error", "message": "…" }` | Terminal failure event. The client shows `message` in the bubble. |

**Example stream**

```
{"type":"start"}
{"type":"token","text":"To reset "}
{"type":"token","text":"your password, "}
{"type":"token","text":"open Settings → Security."}
{"type":"done","images":[{"url":"https://cdn.example.com/step1.png","caption":"Open Settings"}],"imageMode":"stepper","escalation":false}
```

**`done` event fields**

| Field | Type | Notes |
|---|---|---|
| `images` | array \| null | Optional attachments. Each: `{ "url": string, "caption"?: string }`. |
| `imageMode` | string \| null | How to render images: `"single"`, `"stepper"`, or `"stack"`. Defaults to `single`. |
| `escalation` | boolean | Optional. Marks an answer that should suggest human support. (Plumbed through; not yet surfaced in the UI.) |

**Image render modes**

- `single` — one or more images shown plainly (click to enlarge).
- `stepper` — a guided step-by-step viewer (Prev/Next, completion ticks). Use for ordered instructions with 2+ images.
- `stack` — multiple images stacked vertically, each labeled "Step N of M".

**Behavior notes for the backend**

- The client shows a typing indicator from send until the **first `token`** — server-driven loading. Send `token` events as soon as content is ready.
- After a `done` event the frontend appends the "anything else?" follow-up automatically. Do **not** send it as a token.
- On any network/HTTP error the client shows a generic retry message; prefer an explicit `error` event with a friendly `message` when you can.

---

## 6. `POST /sessions/{sessionId}/feedback` — session feedback + summary (session end)

Sent **once**, when the user submits end-of-session feedback. **This is the moment the session ends.** The frontend sends the complete, client-owned session record here; persist it to DynamoDB as-is.

> The backend **must not** recompute `durationMs`, `startedAt`, or `endedAt`. These are authoritative from the client.

**Request**

```
POST {API}/sessions/{sessionId}/feedback
Content-Type: application/json
```

`{sessionId}` is the URL-encoded client UUID.

```json
{
  "rating": "up",
  "reasons": [],
  "other": "",
  "startedAt": "2026-09-09T12:00:00.000Z",
  "endedAt": "2026-09-09T12:03:20.000Z",
  "durationMs": 200000,
  "messageCount": 6,
  "questionCount": 3
}
```

Example of a thumbs-down with a reason:

```json
{
  "rating": "down",
  "reasons": ["Not relevant"],
  "other": "",
  "startedAt": "2026-09-09T12:00:00.000Z",
  "endedAt": "2026-09-09T12:04:10.000Z",
  "durationMs": 250000,
  "messageCount": 8,
  "questionCount": 4
}
```

Example of "Other" free-text:

```json
{
  "rating": "down",
  "reasons": ["Other"],
  "other": "The steps were out of order.",
  "startedAt": "2026-09-09T12:00:00.000Z",
  "endedAt": "2026-09-09T12:05:00.000Z",
  "durationMs": 300000,
  "messageCount": 5,
  "questionCount": 2
}
```

| Field | Type | Notes |
|---|---|---|
| `rating` | `"up"` \| `"down"` | The session rating. |
| `reasons` | string[] | Reasons chosen (from `feedbackReasons`). Empty `[]` for a thumbs-up. |
| `other` | string | Free text when the reason is `"Other"`; otherwise `""`. |
| `startedAt` | string (ISO 8601) \| null | When the chat was opened. Store verbatim. |
| `endedAt` | string (ISO 8601) | When feedback was submitted (= session end). Store verbatim. |
| `durationMs` | number \| null | `endedAt − startedAt`, computed on the client. **Do not override.** |
| `messageCount` | number | Real conversation volume: user messages **+** bot answers. Excludes greeting, closing, and "anything else?" follow-ups. |
| `questionCount` | number | Number of answered questions in the session. |

**Response** — `200 OK` (body ignored by the client) or `204 No Content`.

> **Upsert semantics:** the session row may not exist yet (there is no create call). Create it if absent, keyed by `sessionId`.

---

## 7. `POST /sessions/{sessionId}/messages/feedback` — per-message thumbs

Sent immediately when a user taps 👍/👎 on an **individual bot answer**. Independent of session end. Non-blocking (the UI updates regardless of the response).

**Request**

```
POST {API}/sessions/{sessionId}/messages/feedback
Content-Type: application/json
```

```json
{
  "messageId": "m1a2b3c_4",
  "rating": "up",
  "query": "How do I reset my password?",
  "answer": "To reset your password, open Settings → Security."
}
```

| Field | Type | Notes |
|---|---|---|
| `messageId` | string | Client-side id of the rated bot message (unique within the session). |
| `rating` | `"up"` \| `"down"` | The vote. One-time per message (client enforces). |
| `query` | string \| null | The user question that produced this answer. |
| `answer` | string \| null | The bot answer text that was rated. |

**Response** — `200 OK` (body ignored) or `204 No Content`.

---

## 8. Suggested DynamoDB shape (informative)

Not prescriptive — one possible layout:

**Sessions table** (partition key `sessionId`)

```
sessionId (S)      — client UUID
startedAt (S)      — ISO 8601, from feedback payload
endedAt (S)        — ISO 8601, from feedback payload
durationMs (N)     — from feedback payload (never recomputed)
messageCount (N)   — from feedback payload
questionCount (N)  — from feedback payload
rating (S)         — "up" | "down"
reasons (SS/L)     — reasons list
other (S)          — free text
createdAt (S)      — server-side write time (your own audit field)
```

Session rows are first written (upsert) when a `sessionId` appears on the streaming or feedback call.

**Message feedback** — either a child collection keyed by `sessionId` + `messageId`, or a separate table:

```
sessionId (S), messageId (S)  — composite key
rating (S)                    — "up" | "down"
query (S), answer (S)         — context
createdAt (S)                 — server-side write time
```

---

## 9. Checklist for the backend developer

- [ ] `GET /config` returns the copy/config object (all fields optional; frontend has fallbacks).
- [ ] `GET /suggestions` returns `{ suggestions: [{ id, question }] }` (empty → UI hidden).
- [ ] Streaming Lambda Function URL (`RESPONSE_STREAM`) accepts `{ sessionId, text }` and emits NDJSON `start`/`token`/`done`/`error` events; **first `token` clears the loading state**.
- [ ] `POST /sessions/{id}/feedback` persists the full session summary **verbatim**; duration/timestamps are **not** recomputed.
- [ ] `POST /sessions/{id}/messages/feedback` records per-answer votes.
- [ ] Sessions are **upserted** by the client-supplied `sessionId`; the backend never generates a session id.
- [ ] CORS + `OPTIONS` preflight handled on every endpoint.
- [ ] Non-`2xx` is treated as failure by the client; return `2xx`/`204` on success.
