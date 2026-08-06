-- RenameTable the provider-specific column to a provider-agnostic one. It is a
-- rename (not add/drop) so the existing row's id and its unique index survive.
ALTER TABLE "IntegrationConnection" RENAME COLUMN "nangoConnectionId" TO "connectionId";
ALTER INDEX "IntegrationConnection_nangoConnectionId_key" RENAME TO "IntegrationConnection_connectionId_key";
