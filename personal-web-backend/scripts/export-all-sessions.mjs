// Export EVERY session (each session's META item + all its MSG#<messageId> items) from
// DynamoDB to one JSON file. Sessions don't share a partition key, so this Scans the whole
// table (paginated) and groups items by session. Config/suggestions rows are skipped.
//
// NOTE: Scan reads the entire table (consumes read capacity proportional to table size).
// Fine for a POC; for a large production table prefer a PITR export to S3 instead.
//
// Usage:
//   cd personal-web-backend/scripts
//   npm install
//   AWS_PROFILE=<yourProfile> AWS_REGION=us-east-2 node export-all-sessions.mjs [outfile]
//
// Env: AWS_REGION (default us-east-2), TABLE_NAME (default RBPOCTable), plus your AWS creds.

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { writeFileSync } from "node:fs";

const REGION = process.env.AWS_REGION || "us-east-2";
const TABLE = process.env.TABLE_NAME || "RBPOCTable";
const outfile = process.argv[2] || "all-sessions.json";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

// Scan the whole table, following pagination.
const items = [];
let ExclusiveStartKey;
do {
  const res = await ddb.send(new ScanCommand({ TableName: TABLE, ExclusiveStartKey }));
  items.push(...(res.Items || []));
  ExclusiveStartKey = res.LastEvaluatedKey;
} while (ExclusiveStartKey);

const strip = ({ PK, SK, type, ...rest }) => rest; // drop internal key/type attributes

// Group only SESSION#<id> items; ignore CONFIG / SUGGESTIONS.
const sessions = new Map();
for (const it of items) {
  if (typeof it.PK !== "string" || !it.PK.startsWith("SESSION#")) continue;
  const sid = it.PK.slice("SESSION#".length);
  if (!sessions.has(sid)) sessions.set(sid, { sessionId: sid, meta: null, messages: [] });
  const bucket = sessions.get(sid);
  if (it.SK === "META") bucket.meta = strip(it);
  else if (typeof it.SK === "string" && it.SK.startsWith("MSG#")) bucket.messages.push(strip(it));
}

const all = [...sessions.values()].map((s) => {
  s.messages.sort((a, b) => (Number(a.ts) || 0) - (Number(b.ts) || 0));
  return { sessionId: s.sessionId, meta: s.meta, messageCount: s.messages.length, messages: s.messages };
});

// Newest sessions first (by meta.startedAt when present, else first message ts).
const sortKey = (s) => s.meta?.startedAt || (s.messages[0]?.ts ?? 0);
all.sort((a, b) => String(sortKey(b)).localeCompare(String(sortKey(a))));

const out = { exportedAt: new Date().toISOString(), sessionCount: all.length, sessions: all };
writeFileSync(outfile, JSON.stringify(out, null, 2));
console.log(`Exported ${all.length} session(s) to ${outfile}`);
