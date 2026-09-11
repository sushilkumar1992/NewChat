# Scripts

Utility scripts for the backend. Run from this folder after `npm install`.

## Export one session (+ all its messages)

Everything for a session lives under `PK = SESSION#<sessionId>`, so a session is exported with a single (paginated) `Query` — the `META` item plus every `MSG#<messageId>` item, ordered by `ts`.

```bash
cd personal-web-backend/scripts
npm install
AWS_PROFILE=<yourProfile> AWS_REGION=us-east-2 node export-session.mjs <sessionId>
# → writes session-<sessionId>.json (or pass a second arg for a custom path)
```

Output shape:

```json
{
  "sessionId": "…",
  "exportedAt": "2026-…Z",
  "meta": { "rating": "up", "durationMs": 200000, "messageCount": 6, "questionCount": 3, "…": "…" },
  "messageCount": 4,
  "messages": [
    { "messageId": "m1", "question": "…", "answer": "…", "ts": 1789…, "escalation": false, "endSession": false, "feedbackRating": "up", "feedbackAt": "…" }
  ]
}
```

Credentials/region are read the same way the AWS CLI reads them (`AWS_PROFILE`, `AWS_REGION`, or ambient credentials).

## Export ALL sessions

`export-session.mjs` exports **one** session. To export **every** session, use `export-all-sessions.mjs` — it `Scan`s the whole table and groups items by session (config/suggestions rows are skipped):

```bash
cd personal-web-backend/scripts
npm install
AWS_PROFILE=<yourProfile> AWS_REGION=us-east-2 node export-all-sessions.mjs
# → writes all-sessions.json (or pass a filename as the first arg)
```

Output shape:

```json
{
  "exportedAt": "2026-…Z",
  "sessionCount": 12,
  "sessions": [
    { "sessionId": "…", "meta": { "…": "…" }, "messageCount": 4, "messages": [ { "…": "…" } ] }
  ]
}
```

**Note:** `Scan` reads the entire table (consumes read capacity proportional to table size). Fine for a POC. For a large production table, prefer DynamoDB's **point-in-time export to S3** instead of scanning.

## View the export in a browser

`../viewer/index.html` is a standalone, offline HTML viewer for the dump. Open it in a browser, then **drag `all-sessions.json` onto it** (or click *Load JSON…*). It lists every session with its messages and lets you filter by session feedback, message feedback (👍/👎/none), escalation, `endSession`, date range, and free-text search — with live counts. Single-session exports (`session-<id>.json`) work too. Everything runs locally; nothing is uploaded.

Tip: if you serve the folder over http and place `all-sessions.json` next to `index.html`, it auto-loads on open.
