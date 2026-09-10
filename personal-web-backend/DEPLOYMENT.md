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

## 1. Create the DynamoDB table (AWS Console UI)

Create **one** table with a generic composite key. Everything — config, suggestions, sessions, Q&A turns and feedback — lives in it, separated by key prefixes.

1. Open the **DynamoDB** console in **us-east-2** (region selector, top-right).
2. Click **Create table**.
3. **Table name**: `RBPOCTable`.
4. **Partition key**: `PK`, type **String**.
5. **Sort key**: `SK`, type **String**.
6. **Table settings** → **Customize settings**.
7. **Read/write capacity settings** → **On-demand** (no capacity planning, pay-per-request).
8. **Create table**. Wait until status = **Active**.

You do **not** define any other attributes — DynamoDB is schemaless beyond `PK`/`SK`, and the Lambdas write the rest. The item layout (which key prefixes hold what) is:

| Entity | PK | SK | Written by |
|---|---|---|---|
| Config singleton | `CONFIG` | `default` | seeded / api-lambda reads |
| Suggestion | `SUGGESTIONS` | `SUGG#<id>` | seeded / api-lambda reads |
| Session feedback + summary | `SESSION#<sessionId>` | `SESSION` | api-lambda |
| Per-message feedback | `SESSION#<sessionId>` | `MSGFB#<messageId>` | api-lambda (update-in-place) |
| Q&A turn | `SESSION#<sessionId>` | `MSG#<ts>` | streaming-lambda |

> The table name `RBPOCTable` is the SAM default (the `TableName` parameter). If you name it differently, pass `--parameter-overrides TableName=<yourname>` at deploy.

---

## 2. (One-time) Confirm the Bedrock AgentCore runtime

The streaming Lambda calls `bedrock-agentcore:InvokeAgentRuntime` against your agent. Have the **runtime ARN** ready (from the Bedrock AgentCore console or your agent deployment output). You'll pass it to SAM in the next step. No changes to the agent are required, **except**: for the chat to auto-close, your agent should emit a structured field `endSession: true` (and optionally `escalation: true`) in its streamed output — see §8.

---

## 3. Build & deploy with SAM

> SAM provisions the **API Gateway HTTP API** (for the api-lambda) and the streaming **Lambda Function URL** (for the streaming-lambda) for you from `template.yaml` — no manual console clicks in the happy path. **Appendix A (§12)** documents exactly what SAM configures for each, plus the equivalent **manual console and CLI steps** if you ever need to build or verify them by hand.

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
- **Parameter TableName**: press Enter to accept the default `RBPOCTable` (or type your table name)
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

## 5. Seed the config and suggestions rows

The Lambda falls back to sensible defaults if these rows are missing, but seed them so you can edit copy without redeploying.

**Config row** (one item; edit the text as you like):

```bash
aws dynamodb put-item --region us-east-2 --table-name RBPOCTable --item '{
  "PK": {"S": "CONFIG"},
  "SK": {"S": "default"},
  "type": {"S": "CONFIG"},
  "botName": {"S": "Personal"},
  "greeting": {"S": "Hi, I am Personal, your Virtual Assistant. How can I help you today?"},
  "closing": {"S": "Thank you for using Personal. We value your trust in us. Please share your valuable feedback (thumbs up/thumbs down) to help us improve the experience."},
  "followUp": {"S": "Is there anything else I can help you with?"},
  "maxQuestionWords": {"N": "150"},
  "feedbackReasons": {"L": [
    {"S": "Incorrect answer"}, {"S": "Not relevant"}, {"S": "Missing information"}, {"S": "Other"}
  ]}
}'
```

**Suggestion rows** (repeat for each; `count` drives the top-5 ordering, highest first):

```bash
aws dynamodb put-item --region us-east-2 --table-name RBPOCTable --item '{
  "PK": {"S": "SUGGESTIONS"}, "SK": {"S": "SUGG#q1"}, "type": {"S": "SUGGESTION"},
  "id": {"S": "q1"}, "question": {"S": "How do I reset my password?"}, "count": {"N": "50"}
}'
aws dynamodb put-item --region us-east-2 --table-name RBPOCTable --item '{
  "PK": {"S": "SUGGESTIONS"}, "SK": {"S": "SUGG#q2"}, "type": {"S": "SUGGESTION"},
  "id": {"S": "q2"}, "question": {"S": "Where can I view my statements?"}, "count": {"N": "35"}
}'
```

> You can also create these items in the console: **DynamoDB → Tables → `RBPOCTable` → Explore items → Create item → JSON view**.

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
aws dynamodb get-item --region us-east-2 --table-name RBPOCTable \
  --key "{\"PK\":{\"S\":\"SESSION#$SID\"},\"SK\":{\"S\":\"SESSION\"}}"
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

One table (`RBPOCTable`), keyed by `PK` / `SK`. Every item also carries a `type` attribute.

| Item | PK | SK | Fields |
|---|---|---|---|
| Config | `CONFIG` | `default` | `botName`, `greeting`, `closing`, `followUp`, `maxQuestionWords`, `feedbackReasons` |
| Suggestion | `SUGGESTIONS` | `SUGG#<id>` | `id`, `question`, `count` |
| Session | `SESSION#<sessionId>` | `SESSION` | `rating`, `reasons`, `other`, `startedAt`, `endedAt`, `durationMs`, `messageCount`, `questionCount`, `createdAt`, `updatedAt` |
| Per-message feedback | `SESSION#<sessionId>` | `MSGFB#<messageId>` | `rating`, `query`, `answer`, `createdAt`, `updatedAt` — a repeat vote updates this same item |
| Q&A turn | `SESSION#<sessionId>` | `MSG#<ts>` | `question`, `answer`, `escalation`, `endSession`, `createdAt` |

The frontend owns `startedAt` / `endedAt` / `durationMs` / `messageCount` / `questionCount`; the backend stores them verbatim and never recomputes the duration.

---

## 11. Notes & troubleshooting

- **Region:** everything is us-east-2. If you change it, update `samconfig.toml`, the DynamoDB tables' region, and the agent runtime region, and redeploy.
- **CORS & preflight:** the frontend sends `content-type: application/json`, which makes the POST calls (and, unless optimized, the GETs) **non-simple**, so the browser fires an `OPTIONS` preflight first. Both front doors answer preflight automatically: the HTTP API via `CorsConfiguration`, the Function URL via `FunctionUrlConfig.Cors` (both allow the `content-type` header and the needed methods). **CORS headers are set in exactly one place per door** — the api-lambda and the streaming-lambda return **no** `Access-Control-*` headers themselves; the gateway / Function URL add them. Setting them in code as well produces duplicate `Access-Control-Allow-Origin` values (`*, *`) that browsers reject. All are `AllowOrigins: *` for development — restrict to your site's origin for production (edit `CorsConfiguration` and `FunctionUrlConfig.Cors` in `template.yaml`, then redeploy). The frontend also omits `content-type` on GETs so `/config` and `/suggestions` skip the preflight entirely.
- **Streaming needs a Function URL**, not API Gateway — API Gateway does not support Lambda response streaming. That's why the two Lambdas use different front doors.
- **`awslambda` is undefined locally:** that global only exists in the Lambda Node runtime; the streaming code runs on AWS, not locally.
- **`AGENT_RUNTIME_ARN is not configured`** in the stream response → the parameter wasn't passed; redeploy with `--parameter-overrides AgentRuntimeArn=...`.
- **AccessDenied on InvokeAgentRuntime** → the ARN passed at deploy doesn't match the agent, or the agent is in another region. Confirm the ARN and region.
- **Empty `/suggestions`** → seed the `SUGGESTIONS` items (step 5). Empty is returned (and the UI hides the section) rather than erroring.

---

## 12. Appendix A — API Gateway & Function URL (what SAM does + manual setup)

If you deploy with SAM (§3), **skip this** — it's already done. This appendix is the reference for what SAM built, how to verify it, and how to set both up **by hand** (console or CLI) if you're not using SAM.

### 12.1 What SAM creates

**API Gateway HTTP API** (front door for **api-lambda**):
- Protocol **HTTP**, Lambda **proxy** integration (payload format **2.0**) to `ApiFunction`.
- Four routes → the same integration:
  - `GET /config`
  - `GET /suggestions`
  - `POST /sessions/{sessionId}/feedback`
  - `POST /sessions/{sessionId}/messages/feedback`
- **CORS**: AllowOrigins `*`, AllowMethods `GET,POST,OPTIONS`, AllowHeaders `content-type` (API Gateway answers `OPTIONS` preflight itself).
- **Stage** `$default` with **auto-deploy** — served at the API root with **no stage path**, so the base URL is exactly `https://<api-id>.execute-api.us-east-2.amazonaws.com`.
- Lambda invoke permission for API Gateway (added automatically).

**Lambda Function URL** (front door for **streaming-lambda**):
- **AuthType** `NONE`, **InvokeMode** `RESPONSE_STREAM` (streaming is only possible this way — not via API Gateway).
- **CORS**: AllowOrigins `*`, AllowMethods `POST`, AllowHeaders `content-type`.
- Public invoke permission (`lambda:InvokeFunctionUrl`) added automatically.

**Verify after deploy:**
```bash
# HTTP API + its routes
aws apigatewayv2 get-apis --region us-east-2 \
  --query "Items[?Name=='personal-web-backend'].[ApiId,ApiEndpoint]" --output table
aws apigatewayv2 get-routes --region us-east-2 --api-id <API_ID> \
  --query "Items[].RouteKey" --output table

# Streaming Function URL config (note InvokeMode + AuthType)
aws lambda get-function-url-config --region us-east-2 \
  --function-name <StreamFunctionPhysicalName>
```
(Get `<...PhysicalName>` from `aws cloudformation describe-stack-resources` — see §9.) In the console: **API Gateway → APIs → (your API) → Routes / CORS / Stages**, and **Lambda → (stream function) → Configuration → Function URL**.

### 12.2 Manual — API Gateway HTTP API (console)

Only if you are **not** using SAM.

1. **API Gateway** console (region **us-east-2**) → **Create API** → **HTTP API** → **Build**.
2. **Add integration** → **Lambda** → region `us-east-2` → select your api-lambda function. **API name**: `personal-web-api`. **Next**.
3. **Configure routes** — add all four (Method + Path), each with the Lambda integration you just added:
   - `GET` `/config`
   - `GET` `/suggestions`
   - `POST` `/sessions/{sessionId}/feedback`
   - `POST` `/sessions/{sessionId}/messages/feedback`

   **Next**.
4. **Configure stages**: keep the auto-created **`$default`** stage with **Auto-deploy** on. **Next** → **Create**.
5. **CORS**: open the API → **CORS** → **Configure**:
   - Access-Control-Allow-Origin: `*` (use your site origin in production)
   - Access-Control-Allow-Methods: `GET, POST, OPTIONS`
   - Access-Control-Allow-Headers: `content-type`

   **Save**.
6. Copy the **Invoke URL / default endpoint** (`https://<api-id>.execute-api.us-east-2.amazonaws.com`) → this is `VITE_API_BASE_URL`.
7. Adding the Lambda integration in the console **auto-adds** the resource-based invoke permission. (If you built the integration another way, add it — see the `add-permission` command in §12.3.)

### 12.3 Manual — API Gateway HTTP API (CLI)

```bash
ACCT=<ACCOUNT_ID>
FN=<ApiFunctionPhysicalName>

# 1) Create the HTTP API with CORS
API_ID=$(aws apigatewayv2 create-api --region us-east-2 \
  --name personal-web-api --protocol-type HTTP \
  --cors-configuration AllowOrigins="*",AllowMethods="GET,POST,OPTIONS",AllowHeaders="content-type" \
  --query ApiId --output text)

# 2) Lambda proxy integration (payload v2.0)
INT_ID=$(aws apigatewayv2 create-integration --region us-east-2 --api-id "$API_ID" \
  --integration-type AWS_PROXY \
  --integration-uri "arn:aws:lambda:us-east-2:${ACCT}:function:${FN}" \
  --integration-method POST --payload-format-version 2.0 \
  --query IntegrationId --output text)

# 3) The four routes
for R in "GET /config" "GET /suggestions" \
         "POST /sessions/{sessionId}/feedback" \
         "POST /sessions/{sessionId}/messages/feedback"; do
  aws apigatewayv2 create-route --region us-east-2 --api-id "$API_ID" \
    --route-key "$R" --target "integrations/${INT_ID}"
done

# 4) Auto-deploy $default stage
aws apigatewayv2 create-stage --region us-east-2 --api-id "$API_ID" \
  --stage-name '$default' --auto-deploy

# 5) Let API Gateway invoke the Lambda
aws lambda add-permission --region us-east-2 --function-name "$FN" \
  --statement-id apigw-invoke --action lambda:InvokeFunction \
  --principal apigateway.amazonaws.com \
  --source-arn "arn:aws:execute-api:us-east-2:${ACCT}:${API_ID}/*/*"

echo "Base URL: https://${API_ID}.execute-api.us-east-2.amazonaws.com"
```

### 12.4 Manual — streaming Lambda Function URL (console)

1. **Lambda** console → your streaming function → **Configuration** tab → **Function URL** → **Create function URL**.
2. **Auth type**: **NONE**.
3. **Invoke mode**: **RESPONSE_STREAM** (this is what enables token streaming — the default `BUFFERED` will not stream).
4. **Configure cross-origin resource sharing (CORS)**: enable, then
   - Allow origin: `*`
   - Allow methods: `POST`
   - Allow headers: `content-type`
5. **Save**. Copy the **Function URL** (`https://<id>.lambda-url.us-east-2.on.aws/`) → this is `VITE_STREAM_URL`.
6. Also set the function's **environment variables** (Configuration → Environment variables): `AGENT_RUNTIME_ARN`, `TABLE_NAME`, and confirm its **execution role** allows `bedrock-agentcore:InvokeAgentRuntime` and DynamoDB writes to `RBPOCTable`.

### 12.5 Manual — streaming Lambda Function URL (CLI)

```bash
FN=<StreamFunctionPhysicalName>

aws lambda create-function-url-config --region us-east-2 \
  --function-name "$FN" \
  --auth-type NONE \
  --invoke-mode RESPONSE_STREAM \
  --cors '{"AllowOrigins":["*"],"AllowMethods":["POST"],"AllowHeaders":["content-type"]}'

# Public invoke permission for the URL
aws lambda add-permission --region us-east-2 \
  --function-name "$FN" \
  --statement-id FunctionURLAllowPublicAccess \
  --action lambda:InvokeFunctionUrl \
  --principal "*" \
  --function-url-auth-type NONE

# Read back the URL
aws lambda get-function-url-config --region us-east-2 --function-name "$FN" \
  --query FunctionUrl --output text
```

### 12.6 Verify both

Use the `curl` calls in **§7** against the two URLs. A successful `GET /config` and a streaming response (`{"type":"start"}` … `{"type":"done",...}`) confirm the API Gateway routes and the Function URL streaming mode are wired correctly.

---

## 13. Test a Lambda directly (without the UI)

You don't need the frontend to exercise either Lambda. Ready-made API Gateway event payloads for all four routes live in `docs/events/`.

**A. Local invoke with a sample event — api-lambda (needs Docker):**
```bash
sam build
sam local invoke ApiFunction -e docs/events/get-config.json
sam local invoke ApiFunction -e docs/events/get-suggestions.json
sam local invoke ApiFunction -e docs/events/post-session-feedback.json
sam local invoke ApiFunction -e docs/events/post-message-feedback.json
```
Local invoke still uses your AWS credentials to reach the **real** `RBPOCTable`, so create and seed it first (§1, §5) or the reads/writes will fail.

**B. Local HTTP server — api-lambda (needs Docker):**
```bash
sam local start-api
# in another shell:
curl -s http://127.0.0.1:3000/config | jq .
curl -s -X POST http://127.0.0.1:3000/sessions/$SID/feedback \
  -H "content-type: application/json" \
  -d '{"rating":"up","reasons":[],"other":"","messageCount":3,"questionCount":2}' | jq .
```

**C. Invoke the deployed function by name (either Lambda):**
```bash
aws lambda invoke --region us-east-2 \
  --function-name <ApiFunctionPhysicalName> \
  --cli-binary-format raw-in-base64-out \
  --payload file://docs/events/get-config.json \
  out.json && cat out.json
```
Get `<ApiFunctionPhysicalName>` from `aws cloudformation describe-stack-resources` (see §9).

**D. Console Test tab:** Lambda console → the function → **Test** → paste one of `docs/events/*.json` → **Test**.

### 13.1 Streaming Lambda — real test (deployed, no SAM)

`sam local` can't emulate response streaming, and the `awslambda` global only exists on AWS, so the streaming Lambda is tested against the **deployed** function. Prereqs: the stack is deployed, `RBPOCTable` exists (§1), and (for a real answer) a valid `AGENT_RUNTIME_ARN` with Bedrock access. Set a session id first:

```bash
SID="11111111-1111-4111-8111-111111111111"   # any UUID
```

**Option 1 — through the Function URL (the exact path the frontend uses).** The URL is public (`AuthType NONE`), so this needs no credentials:

```bash
STREAM="https://xxxxxxxx.lambda-url.us-east-2.on.aws/"
curl -N -X POST "$STREAM" -H "content-type: application/json" \
  -d "{\"sessionId\":\"$SID\",\"text\":\"How do I reset my password?\"}"
```
Expect `{"type":"start"}`, streamed `{"type":"token","text":"..."}` lines, then `{"type":"done",...}`.

**Option 2 — invoke the function directly with the AWS CLI (uses your `aws configure` credentials).**

First find the deployed function's name:
```bash
aws lambda list-functions --region us-east-2 \
  --query "Functions[?contains(FunctionName,'StreamFunction')].FunctionName" --output text
```
(or `aws cloudformation describe-stack-resources --stack-name personal-web-backend --region us-east-2` — see §9.)

The handler reads `event.body`, so a **direct** invoke must wrap the request JSON inside a `body` string (mimicking a Function URL event). Put it in a file to avoid shell-quoting issues — this also works on Windows PowerShell/CMD:

`stream-payload.json`:
```json
{ "body": "{\"sessionId\":\"11111111-1111-4111-8111-111111111111\",\"text\":\"How do I reset my password?\"}" }
```

Then stream the response into a file:
```bash
aws lambda invoke-with-response-stream --region us-east-2 \
  --function-name <StreamFunctionName> \
  --cli-binary-format raw-in-base64-out \
  --payload file://stream-payload.json \
  out.txt
# view the NDJSON events:
cat out.txt        # Windows:  type out.txt
```

**Notes:**
- The `body`-wrapping matters **only** for the direct invoke (Option 2). The Function URL (Option 1) already delivers the event with `body` populated.
- Input validation is testable **without** the agent — an empty `text` returns `{"type":"error","message":"sessionId and text are required"}`. A real streamed answer needs the agent.
- `AccessDenied` on `InvokeAgentRuntime` → the `AGENT_RUNTIME_ARN` is wrong or in another region.
- `aws lambda invoke` (buffered, no `-with-response-stream`) also works but returns the whole response at once instead of streaming.
