import { ComposioConnectionProvider } from "./composio-provider.js";
import { NangoConnectionProvider, GMAIL_INTEGRATION } from "./nango-provider.js";
import type { ConnectionProvider, IntegrationConnectionStore } from "./types.js";

// The single seam that decides which backend drives Gmail. Setting
// COMPOSIO_API_KEY opts into Composio; dropping it flips back to Nango.
// A switch here is the whole rollback story — nothing above calls either
// provider directly (integrations routes, email-action, worker gmail all go
// through this factory).
export interface ProviderEnv {
  COMPOSIO_API_KEY?: string;
  COMPOSIO_BASE_URL?: string;
  COMPOSIO_GMAIL_AUTH_CONFIG?: string;
  NANGO_SECRET_KEY?: string;
  NANGO_BASE_URL?: string;
}

export function gmailProvider(env: ProviderEnv, store: IntegrationConnectionStore, callbackUrl?: string): ConnectionProvider {
  // Composio needs both an API key AND a configured Gmail auth config to link
  // users; without the auth config, fall back to Nango (the rollback path) so a
  // half-configured switch never hard-fails email.
  if (env.COMPOSIO_API_KEY && env.COMPOSIO_GMAIL_AUTH_CONFIG) {
    return new ComposioConnectionProvider({
      apiKey: env.COMPOSIO_API_KEY,
      baseUrl: env.COMPOSIO_BASE_URL,
      authConfigId: env.COMPOSIO_GMAIL_AUTH_CONFIG,
      callbackUrl,
      store,
    });
  }
  return new NangoConnectionProvider({
    secretKey: env.NANGO_SECRET_KEY,
    host: env.NANGO_BASE_URL,
    store,
    providerKey: GMAIL_INTEGRATION,
  });
}