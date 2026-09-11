// Export one session (its META item + every MSG#<messageId> item) from DynamoDB to a clean
// JSON file. Everything for a session shares PK = SESSION#<sessionId>, so this is one Query
// (paginated). Messages are unmarshalled, stripped of key/type attrs, and ordered by `ts`.
//
// Usage:
//   cd personal-web-backend/scripts
//   npm install
//   AWS_PROFILE=<yourProfile> AWS_REGION=us-east-2 node export-session.mjs <sessionId> [outfile]
//
// Env: AWS_REGION (default us-east-2), TABLE_NAME (default RBPOCTable), plus your AWS creds
// (AWS_PROFILE / access keys) exactly as the AWS CLI uses them.

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { writeFileSync } from "node:fs";

const REGION = process.env.AWS_REGION || "us-east-2";
const TABLE = process.env.TABLE_NAME || "RBPOCTable";

const sessionId = process.argv[2];
if (!sessionId) {
  console.error("usage: node export-session.mjs <sessionId> [outfile]");
  process.exit(1);
}
const outfile = process.argv[3] || `session-${sessionId}.json`;

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

// Query the whole session partition, following pagination.
const items = [];
let ExclusiveStartKey;
do {
  const res = await ddb.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: "PK = :p",
    ExpressionAttributeValues: { ":p": `SESSION#${sessionId}` },
    ExclusiveStartKey
  }));
  items.push(...(res.Items || []));
  ExclusiveStartKey = res.LastEvaluatedKey;
} while (ExclusiveStartKey);

if (items.length === 0) {
  console.error(`No items found for SESSION#${sessionId} in ${TABLE} (${REGION}).`);
  process.exit(2);
}

const strip = ({ PK, SK, type, ...rest }) => rest; // drop internal key/type attributes

const metaItem = items.find((i) => i.SK === "META");
const messages = items
  .filter((i) => typeof i.SK === "string" && i.SK.startsWith("MSG#"))
  .sort((a, b) => (Number(a.ts) || 0) - (Number(b.ts) || 0))
  .map(strip);

const out = {
  sessionId,
  exportedAt: new Date().toISOString(),
  meta: metaItem ? strip(metaItem) : null,
  messageCount: messages.length,
  messages
};

writeFileSync(outfile, JSON.stringify(out, null, 2));
console.log(`Exported ${messages.length} message(s)${metaItem ? " + meta" : " (no meta item yet)"} to ${outfile}`);
