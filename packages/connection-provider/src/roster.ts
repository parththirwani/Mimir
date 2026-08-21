import { NangoConnectionProvider, type NangoProviderOptions } from "./nango-provider.js";

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
