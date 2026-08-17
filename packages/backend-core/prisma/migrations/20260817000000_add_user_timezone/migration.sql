-- IANA timezone reported by the user's browser; used to localize surfaced timestamps.
ALTER TABLE "User" ADD COLUMN "timezone" TEXT;