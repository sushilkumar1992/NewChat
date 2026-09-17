# Cognito login + private streaming — setup & deploy

Replaces the earlier CloudFront/WAF approach. The streaming Function URL is now **private**
(`AuthType: AWS_IAM`); users **log in via Cognito**, the app exchanges that login for temporary
AWS credentials through a **Cognito Identity Pool**, and **SigV4-signs** each streaming request.
Unsigned / unauthenticated calls get **403** from AWS before the Lambda runs.

```
Login (Cognito User Pool)
      │  id/access tokens
      ▼
Identity Pool  ──►  temp AWS creds (authenticated role: invoke stream URL only)
      │
      ▼
Browser SigV4-signs POST ──►  Function URL (AWS_IAM)  ──►  AgentCore stream
```

The `/config`, `/suggestions` and feedback endpoints (HTTP API) are unchanged and keep working;
only a login now gates the app.

---

## 1. Deploy the backend

From `personal-web-backend/`:

```bash
sam build
sam deploy --parameter-overrides \
    AgentRuntimeArn=arn:aws:bedrock-agentcore:us-east-2:<acct>:runtime/<id> \
    FrontendOrigin=https://app.example.com
```

- `FrontendOrigin` = the exact origin your frontend is served from (locks CORS on both the API
  and the streaming URL). For local dev use `http://localhost:5173`.
- Capabilities: `CAPABILITY_IAM` (already in `samconfig.toml`).

Copy these **stack outputs** — you'll need them for the frontend `.env`:

| Output | Frontend env var |
|---|---|
| `HttpApiBaseUrl` | `VITE_API_BASE_URL` |
| `StreamFunctionUrl` | `VITE_STREAM_URL` |
| `UserPoolId` | `VITE_COGNITO_USER_POOL_ID` |
| `UserPoolClientId` | `VITE_COGNITO_CLIENT_ID` |
| `IdentityPoolId` | `VITE_COGNITO_IDENTITY_POOL_ID` |
| `AwsRegion` | `VITE_AWS_REGION` |

## 2. Create a user (admin-only — no public sign-up)

Public sign-up is disabled. Create each user with the CLI (or the Cognito console → Users → Create user):

```bash
# grab the pool id from the stack output
POOL_ID=$(aws cloudformation describe-stacks --region us-east-2 \
  --stack-name personal-web-backend \
  --query "Stacks[0].Outputs[?OutputKey=='UserPoolId'].OutputValue" --output text)

aws cognito-idp admin-create-user \
  --region us-east-2 \
  --user-pool-id "$POOL_ID" \
  --username user@example.com \
  --user-attributes Name=email,Value=user@example.com Name=email_verified,Value=true \
  --temporary-password 'Temp#1234'
```

The user is created in **FORCE_CHANGE_PASSWORD** state: on first login the app shows a
"set a new password" step (handled by `LoginPage.jsx`), then signs them in.

To set a permanent password directly instead (skips the change-password step):

```bash
aws cognito-idp admin-set-user-password --region us-east-2 \
  --user-pool-id "$POOL_ID" --username user@example.com \
  --password 'Perm#5678' --permanent
```

## 3. Configure & run the frontend

```bash
cd personal-web
npm install                 # pulls in aws-amplify + aws4fetch (added to package.json)
cp .env.example .env        # then paste the stack outputs from step 1
npm run dev
```

Open the app → you get the **login page** → sign in → the chatbot loads and streams as before.
A **Sign out** button is in the chat header.

## 4. Verify

- Signed out: only the login page renders; no streaming call is possible.
- Signed in: chat streams normally (tokens, images, feedback, tokens/cost — all unchanged).
- `curl -X POST <StreamFunctionUrl> -d '{}'` → **403** (private; unsigned request rejected by AWS).

---

## Notes / gotchas

- **What changed in code:** `streamClient.js` now SigV4-signs the streaming request with
  Identity-Pool creds (via `aws4fetch` + Amplify `fetchAuthSession`). Everything downstream
  (`onToken`/`onImage`/`onDone`, rendering, per-message feedback, tokens/cost, KPIs) is unchanged.
- **CORS:** the Function URL `Cors.AllowHeaders` includes the SigV4 headers
  (`authorization`, `x-amz-date`, `x-amz-security-token`, `x-amz-content-sha256`) so the browser
  preflight passes. `AllowOrigins` is locked to `FrontendOrigin`.
- **Credential refresh:** Amplify refreshes the Identity-Pool creds automatically; `fetchAuthSession`
  returns fresh creds per stream call.
- **Local dev origin:** set `FrontendOrigin=http://localhost:5173` (and the same value in the
  frontend origin) or you'll get a CORS error while developing.
- **Discarded:** the CloudFront distribution, OAC, WAF Web ACL and IP allow-list are removed
  (`waf-us-east-1.yaml` and `docs/streaming-security-cloudfront.md` deleted).
- **Optional next step:** the HTTP API (`/config`, `/suggestions`, feedback) is still open (CORS-locked
  but unauthenticated). To also require login there, add a Cognito JWT authorizer to the HTTP API —
  ask and I'll wire it in.
```
