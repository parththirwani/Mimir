import { NangoConnectionProvider, type NangoProviderOptions } from "./nango-provider.js";

// Nango's provider config key for the Notion API. Notion uses its own OAuth
// token as the bearer token for its REST API — no extra refresh dance beyond
// Nango's standard OAUTH2 credentials.
export const NOTION_INTEGRATION = "notion";

export function notionProvider(opts: Omit<NangoProviderOptions, "providerKey" | "connectScopes">): NangoConnectionProvider {
  return new NangoConnectionProvider({
    ...opts,
    providerKey: NOTION_INTEGRATION,
    connectScopes: "", // Notion OAuth scopes are app-level (Nango config), not per-user
  });
}
