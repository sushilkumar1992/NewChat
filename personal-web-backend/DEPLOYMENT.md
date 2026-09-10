# Personal Virtual Assistant — Backend Setup & Deployment

Everything below targets **AWS region `us-east-2`**, **Node.js 22**, and **AWS SAM** for deployment. Two Lambdas ship from this one project but stay independently deployable.

- **api-lambda** → API Gateway **HTTP API** → `GET /config`, `GET /suggestions`, `POST /sessions/{sessionId}/feedback`, `POST /sessions/{sessionId}/messages/feedback`
- **streaming-lambda** → Lambda **Function URL** (`RESPONSE_STREAM`) → invokes your Bedrock AgentCore runtime and streams NDJSON tokens
- **DynamoDB** → all persisted data (created via the console, referenced by SAM)

---

## 0. Prerequisites

Install and configure these once:

1. **AWS CLI v2** — `aws --version`. Configure credentials/region:
   ```bash
   aws configure
   # Default region name: us-east-2
   ```
2. **AWS SAM CLI** — `sam --version`.
   - macOS: `brew install aws-sam-cli`
   - Windows: download the MSI installer from AWS, or `pip install aws-sam-cli`
   - Linux: `pip install aws-sam-cli`
3. **Node.js 22** — `node --version` (SAM uses it to build the functions locally).
4. **Your Bedrock AgentCore runtime ARN** — the streaming Lambda needs it. It looks like:
   ```
   arn:aws:bedrock-agentcore:us-east-2:<ACCOUNT_ID>:runtime/<runtime-id>
   ```
   The agent runtime must live in **us-east-2** (same region as this stack). Make sure your AWS account has access to Bedrock AgentCore in that region.

> Throughout this doc, replace `<ACCOUNT_ID>` and `<...>` placeholders with your real values.

---

## 1. Create the DynamoDB tables (AWS Console UI)

Create **five** tables. For every table: **DynamoDB console → Tables → Create table**, fill in the keys below, under **Table settings** choose **Customize settings → Capacity mode → On-demand**, then **Create table**. Leave everything else default.

| # | Table name | Partition key (type) | Sort key (type) | Written / read by |
|---|---|---|---|---|
| 1 | `pva_sessions` | `sessionId` (String) | — | Session feedback + summary (api-lambda) |
| 2 | `pva_messages` | `sessionId` (String) | `ts` (Number) | Every Q&A turn (streaming-lambda) |
| 3 | `pva_message_feedback` | `sessionId` (String) | `messageId` (String) | Per-message thumbs (api-lambda) |
| 4 | `pva_config` | `configKey` (String) | — | Bot copy/config (api-lambda reads) |
| 5 | `pva_suggestions` | `id` (String) | — | Suggested questions (api-lambda reads) |

**Step-by-step for one table (repeat for all five):**

1. Open the **DynamoDB** console in **us-east-2** (region selector, top-right).
2. Click **Create table**.
3. **Table name**: e.g. `pva_sessions`.
4. **Partition key**: e.g. `sessionId`, type **String**.
5. If the table has a sort key (tables 2 and 3), tick/enter the **Sort key**: `ts` (Number) for `pva_messages`, `messageId` (String) for `pva_message_feedback`.
6. **Table settings** → **Customize settings**.
7. **Read/write capacity settings** → **On-demand** (no capacity planning, pay-per-request).
8. **Create table**. Wait until status = **Active**.

You do **not** need to define any other attributes — DynamoDB is schemaless beyond the keys, and the Lambdas write the rest.

> The table names above are the SAM defaults. If you name them differently, pass the new names as SAM parameters in step 3.

---

## 2. (One-time) Confirm the Bedrock AgentCore runtime

The streaming Lambda calls `bedrock-agentcore:InvokeAgentRuntime` against your agent. Have the **runtime ARN** ready (from the Bedrock AgentCore console or your agent deployment output). You'll pass it to SAM in the next step. No changes to the agent are required, **except**: for the chat to auto-close, your agent should emit a structured field `endSession: true` (and optionally `escalation: true`) in its streamed output — see §8.

---

## 3. Build & deploy with SAM

From the `personal-web-backend/` folder:

```bash
cd personal-web-backend

# Installs each function's npm deps and stages the build
sam build

# First deploy — interactive; it saves your answers into samconfig.toml
sam deploy --guided
```

`sam deploy --guided` will prompt:

- **Stack Name**: `personal-web-backend`
- **AWS Region**: `us-east-2`
- **Parameter AgentRuntimeArn**: paste your `arn:aws:bedrock-agentcore:us-east-2:...` ARN
- **Parameter TableSessions / TableMessages / TableMessageFeedback / TableConfig / TableSuggestions**: press Enter to accept the defaults (or type your names)
- **Confirm changes before deploy**: `Y`
- **Allow SAM CLI IAM role creation**: `Y` (this creates the execution roles)
- **Disable rollback**: `N`
- **Save arguments to configuration file**: `Y`

Every later deploy is just:

```bash
sam build && sam deploy
```

Or non-interactively:

```bash
sam build
sam deploy \
  --stack-name personal-web-backend \
  --region us-east-2 \
  --capabilities CAPABILITY_IAM \
  --resolve-s3 \
  --parameter-overrides AgentRuntimeArn=arn:aws:bedrock-agentcore:us-east-2:<ACCOUNT_ID>:runtime/<runtime-id>
```

---

## 4. Capture the two URLs (stack outputs)

After deploy, SAM prints **Outputs**. You can also read them any time:

```bash
aws cloudformation describe-stacks \
  --stack-name personal-web-backend \
  --region us-east-2 \
  --query "Stacks[0].Outputs" --output table
```

You need:

- **HttpApiBaseUrl** → e.g. `https://abc123.execute-api.us-east-2.amazonaws.com`
- **StreamFunctionUrl** → e.g. `https://xxxxxxxx.lambda-url.us-east-2.on.aws/`

---

## 5. Seed `pva_config` and `pva_suggestions`

The Lambda falls back to sensible defaults if these rows are missing, but seed them so you can edit copy without redeploying.

**Config row** (one item; edit the text as you like):

```bash
aws dynamodb put-item --region us-east-2 --table-name pva_config --item '{
  "configKey": {"S": "default"},
  "botName": {"S": "Personal"},
  "greeting": {"S": "Hi, I am Personal, your Virtual Assistant. How can I help you today?"},
  "closing": {"S": "Thank you for using Personal. We value your trust in us. Please share your valuable feedback (thumbs up/thumbs down) to help us improve the experience."},
  "followUp": {"S": "Is there anything else I can help you with?"},
  "maxQuestionWords": {"N": "150"},
  "csrPhone": {"S": "1-800-555-0142"},
  "feedbackReasons": {"L": [
    {"S": "Incorrect answer"}, {"S": "Not relevant"}, {"S": "Missing information"}, {"S": "Other"}
  ]}
}'
```

**Suggestion rows** (repeat for each; `count` drives the top-5 ordering, highest first):

```bash
aws dynamodb put-item --region us-east-2 --table-name pva_suggestions --item '{
  "id": {"S": "q1"}, "question": {"S": "How do I reset my password?"}, "count": {"N": "50"}
}'
aws dynamodb put-item --region us-east-2 --table-name pva_suggestions --item '{
  "id": {"S": "q2"}, "question": {"S": "Where can I view my statements?"}, "count": {"N": "35"}
}'
```

> You can also create these items in the console: **DynamoDB → Tables → (table) → Explore items → Create item → JSON view**.

---

## 6. Wire the frontend

Create `personal-web/.env` (from `.env.example`) with the two URLs from step 4:

```
VITE_API_BASE_URL=https://abc123.execute-api.us-east-2.amazonaws.com
VITE_STREAM_URL=https://xxxxxxxx.lambda-url.us-east-2.on.aws/
VITE_ENABLE_MESSAGE_FEEDBACK=yes
```

Then **restart** the dev server:

```bash
cd personal-web
npm install   # first time only
npm run dev
```

---

## 7. Test the endpoints

Set shell variables first:

```bash
API="https://abc123.execute-api.us-east-2.amazonaws.com"
STREAM="https://xxxxxxxx.lambda-url.us-east-2.on.aws/"
SID="11111111-1111-4111-8111-111111111111"   # any client-style UUID
```

**Config / suggestions:**

```bash
curl -s "$API/config"       | jq .
curl -s "$API/suggestions"  | jq .
```

**Session feedback (also the session-end write):**

```bash
curl -s -X POST "$API/sessions/$SID/feedback" \
  -H "content-type: application/json" \
  -d '{"rating":"up","reasons":[],"other":"","startedAt":"2026-09-10T10:00:00.000Z","endedAt":"2026-09-10T10:03:20.000Z","durationMs":200000,"messageCount":6,"questionCount":3}' | jq .
```

**Per-message feedback:**

```bash
curl -s -X POST "$API/sessions/$SID/messages/feedback" \
  -H "content-type: application/json" \
  -d '{"messageId":"m1","rating":"up","query":"How do I reset my password?","answer":"Open Settings > Security."}' | jq .
```

**Streaming (NDJSON; `-N` disables buffering so you see tokens arrive):**

```bash
curl -N -X POST "$STREAM" \
  -H "content-type: application/json" \
  -d "{\"sessionId\":\"$SID\",\"text\":\"How do I reset my password?\"}"
```

You should see lines like `{"type":"start"}`, several `{"type":"token","text":"..."}`, then `{"type":"done","escalation":false,"endSession":false}`.

Verify writes landed in DynamoDB (console → Explore items, or):

```bash
aws dynamodb get-item --region us-east-2 --table-name pva_sessions \
  --key "{\"sessionId\":{\"S\":\"$SID\"}}"
```

---

## 8. How end-of-session works (backend responsibility)

The frontend does **no** keyword matching — it relies on the streaming `done` event:

- Normal turn → `{"type":"done","endSession":false}` → the UI shows the "anything else?" prompt.
- User is finished → `{"type":"done","endSession":true}` → the UI shows the closing message + feedback panel.

The streaming Lambda forwards `endSession` / `escalation` if it sees them as booleans in the agent's streamed JSON (either top-level, e.g. `{"endSession":true}`, or under a `metadata` object). **So your Bedrock agent must set `endSession: true` when the user signals they are done** (e.g. "no thanks", "that's all"), and treat a bare "yes" as a normal turn. If the agent never emits it, sessions won't auto-close, but the manual "End chat" button still works.

---

## 9. Redeploy a single Lambda (independent deploys)

Because each function has its own folder, you can push just one.

**Fastest — SAM code sync (no full CloudFormation change set):**

```bash
# API Lambda only
sam build ApiFunction && sam sync --stack-name personal-web-backend --region us-east-2 --code --resource-id ApiFunction

# Streaming Lambda only
sam build StreamFunction && sam sync --stack-name personal-web-backend --region us-east-2 --code --resource-id StreamFunction
```

**Alternative — raw AWS CLI** (find the physical function name, then update code):

```bash
# Physical names for the two functions in the stack
aws cloudformation describe-stack-resources \
  --stack-name personal-web-backend --region us-east-2 \
  --query "StackResources[?ResourceType=='AWS::Lambda::Function'].[LogicalResourceId,PhysicalResourceId]" \
  --output table

# Zip and push one function (example for the API Lambda)
cd api-lambda && npm install --omit=dev && zip -r ../api.zip . && cd ..
aws lambda update-function-code --region us-east-2 \
  --function-name <PhysicalNameOfApiFunction> \
  --zip-file fileb://api.zip
```

A full stack change (new route, IAM, env var, Function URL settings) still goes through `sam build && sam deploy`.

---

## 10. Data model reference

| Table | Key(s) | Item fields |
|---|---|---|
| `pva_sessions` | `sessionId` | `rating`, `reasons`, `other`, `startedAt`, `endedAt`, `durationMs`, `messageCount`, `questionCount`, `createdAt`, `updatedAt` |
| `pva_messages` | `sessionId` + `ts` | `question`, `answer`, `escalation`, `endSession`, `createdAt` |
| `pva_message_feedback` | `sessionId` + `messageId` | `rating`, `query`, `answer`, `createdAt` |
| `pva_config` | `configKey` (`"default"`) | `botName`, `greeting`, `closing`, `followUp`, `maxQuestionWords`, `csrPhone`, `feedbackReasons` |
| `pva_suggestions` | `id` | `question`, `count` |

The frontend owns `startedAt` / `endedAt` / `durationMs` / `messageCount` / `questionCount`; the backend stores them verbatim and never recomputes the duration.

---

## 11. Notes & troubleshooting

- **Region:** everything is us-east-2. If you change it, update `samconfig.toml`, the DynamoDB tables' region, and the agent runtime region, and redeploy.
- **CORS:** the HTTP API and the Function URL are configured with `AllowOrigins: *` for development. For production, restrict to your site's origin (edit `CorsConfiguration` and `FunctionUrlConfig.Cors` in `template.yaml`, then redeploy).
- **Streaming needs a Function URL**, not API Gateway — API Gateway does not support Lambda response streaming. That's why the two Lambdas use different front doors.
- **`awslambda` is undefined locally:** that global only exists in the Lambda Node runtime; the streaming code runs on AWS, not locally.
- **`AGENT_RUNTIME_ARN is not configured`** in the stream response → the parameter wasn't passed; redeploy with `--parameter-overrides AgentRuntimeArn=...`.
- **AccessDenied on InvokeAgentRuntime** → the ARN passed at deploy doesn't match the agent, or the agent is in another region. Confirm the ARN and region.
- **Empty `/suggestions`** → seed `pva_suggestions` (step 5). Empty is returned (and the UI hides the section) rather than erroring.
