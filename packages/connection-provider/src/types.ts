// The ConnectionProvider abstraction. api and worker both consume it, so the
// interface pays for itself — but keep it minimal: no provider-specific knobs
// leak out, only the five auth operations the routes/worker need.

export interface ConnectionProvider {
  initiateOAuth(userId: string): Promise<{ sessionToken: string; authorizationUrl: string }>;
  handleCallback(userId: string): Promise<void>;
  getConnection(userId: string): Promise<{ status: string } | null>;
  getAccessToken(userId: string): Promise<string>;
  revoke(userId: string): Promise<void>;
}

// A connection that exists but can't serve tokens — worker treats this as
// fail-fast (surface "reconnect", never retry-loop), NOT as retriable.
export type ConnectionErrorKind = "not_connected" | "expired" | "refresh_failed" | "revoked";

export class ConnectionError extends Error {
  readonly kind: ConnectionErrorKind;
  constructor(kind: ConnectionErrorKind, message?: string) {
    super(message ?? kind);
    this.name = "ConnectionError";
    this.kind = kind;
  }
}

// A provider outage or bad request — worker rethrows so BullMQ retries.
export type ProviderErrorKind = "rate_limited" | "provider_down" | "validation_failed" | "malformed_response";

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  constructor(kind: ProviderErrorKind, message?: string) {
    super(message ?? kind);
    this.name = "ProviderError";
    this.kind = kind;
  }
}

// No NANGO_SECRET_KEY configured — api routes 503, worker jobs hit the DLQ.
export class NotConfiguredError extends Error {
  constructor(message = "Integration provider is not configured") {
    super(message);
    this.name = "NotConfiguredError";
  }
}

// The subset of the Prisma IntegrationConnection client the provider touches,
// declared structurally so this package never depends on @mimir/backend-core
// or @prisma/client. Consumers pass `prisma.integrationConnection`.
export interface IntegrationConnectionStore {
  findFirst(args: {
    where: { userId: string; provider: string };
  }): Promise<{ id: string; nangoConnectionId: string; status: string } | null>;
  create(args: {
    data: { userId: string; provider: string; nangoConnectionId: string; status: string };
  }): Promise<unknown>;
  update(args: { where: { id: string }; data: { nangoConnectionId: string; status: string } }): Promise<unknown>;
  delete(args: { where: { id: string } }): Promise<unknown>;
}
