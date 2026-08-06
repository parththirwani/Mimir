import { NangoConnectionProvider, type NangoProviderOptions } from "./nango-provider.js";

// 5.7.1 — the rest of the planned roster, all of which ride the same Nango
// OAuth shape as Gmail/Notion. ponytail: instead of a provider file per
// integration, one generic factory + a key constant per integration (5.7.2 —
// additive, no architectural change). Each integrates end-to-end the moment its
// Nango app is configured with the matching provider key.

export const LINEAR_INTEGRATION = "linear";
export const VERCEL_INTEGRATION = "vercel";
export const INTERCOM_INTEGRATION = "intercom";
export const SENTRY_INTEGRATION = "sentry";

export function providerFor(key: string): (opts: Omit<NangoProviderOptions, "providerKey" | "connectScopes">) => NangoConnectionProvider {
  return (opts) =>
    new NangoConnectionProvider({
      ...opts,
      providerKey: key,
      connectScopes: "",
    });
}
