// One-off ops script: create a CUSTOM gmail auth config (our own Google OAuth
// creds) so Composio's OAuth screen isn't the blocked managed app. Prints the
// new id and verifies it. Run: bun scripts/create-gmail-auth-config.ts
import { Composio } from "@composio/core";

const apiKey = process.env.COMPOSIO_API_KEY;
const clientId = process.env.GOOGLE_CLIENT_ID;
const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
if (!apiKey || !clientId || !clientSecret) {
  throw new Error("COMPOSIO_API_KEY, GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set");
}

const composio = new Composio({ apiKey });

// oauth_redirect_uri must match an authorized redirect URI in the Google Cloud
// OAuth client, else Google rejects the login with redirect_uri_mismatch.
// Composio's default callback is /api/v1/auth-apps/add; we override it to the
// v3.1 toolkit callback that's already authorized in the console.
const OAUTH_REDIRECT_URI = "https://backend.composio.dev/api/v3.1/toolkits/auth/callback";

const created = await composio.authConfigs.create("gmail", {
  type: "use_custom_auth",
  name: "mimir_gmail_custom",
  authScheme: "OAUTH2",
  credentials: { client_id: clientId, client_secret: clientSecret, oauth_redirect_uri: OAUTH_REDIRECT_URI },
});
console.log(`created auth config ${created.id} (authScheme=${created.authScheme}, isComposioManaged=${created.isComposioManaged})`);

const verified = await composio.authConfigs.get(created.id);
console.log(
  JSON.stringify(
    {
      id: verified.id,
      name: verified.name,
      isComposioManaged: verified.isComposioManaged,
      credentials: verified.credentials,
    },
    null,
    2
  )
);
if (verified.isComposioManaged || !verified.credentials) {
  throw new Error(`verification failed for ${created.id}: expected custom auth with credentials`);
}
if (verified.credentials.oauth_redirect_uri !== OAUTH_REDIRECT_URI) {
  throw new Error(`verification failed for ${created.id}: unexpected oauth_redirect_uri ${String(verified.credentials.oauth_redirect_uri)}`);
}
