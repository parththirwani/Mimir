-- Add SurfacedMail (durable Postgres-claimed dedup for surfaced mail)
CREATE TABLE "SurfacedMail" (
    "messageId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SurfacedMail_pkey" PRIMARY KEY ("messageId")
);

CREATE INDEX "SurfacedMail_userId_idx" ON "SurfacedMail"("userId");

-- AddForeignKey
ALTER TABLE "SurfacedMail" ADD CONSTRAINT "SurfacedMail_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
