// Cognito / Amplify configuration. Values come from the SAM stack outputs (see .env.example).
// The User Pool does the login; the Identity Pool federates that login into temporary AWS
// credentials that the streaming client uses to SigV4-sign the private Function URL.
import { Amplify } from "aws-amplify";

export const AWS_REGION = import.meta.env.VITE_AWS_REGION;

let configured = false;
export function configureAuth() {
  if (configured) return;
  const userPoolId = import.meta.env.VITE_COGNITO_USER_POOL_ID;
  const userPoolClientId = import.meta.env.VITE_COGNITO_CLIENT_ID;
  const identityPoolId = import.meta.env.VITE_COGNITO_IDENTITY_POOL_ID;
  if (!userPoolId || !userPoolClientId || !identityPoolId || !AWS_REGION) {
    console.warn(
      "[Personal] Cognito env vars are missing — set VITE_COGNITO_USER_POOL_ID, " +
      "VITE_COGNITO_CLIENT_ID, VITE_COGNITO_IDENTITY_POOL_ID and VITE_AWS_REGION in personal-web/.env " +
      "(from the SAM stack outputs), then restart `npm run dev`."
    );
  }
  Amplify.configure({
    Auth: {
      Cognito: {
        userPoolId,
        userPoolClientId,
        identityPoolId,
        allowGuestAccess: false
      }
    }
  });
  configured = true;
}
