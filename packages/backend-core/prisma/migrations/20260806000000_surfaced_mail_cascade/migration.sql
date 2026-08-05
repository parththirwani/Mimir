-- Deleting a user now cascades to their dedup rows; otherwise SurfacedMail
-- (ON DELETE RESTRICT) blocks user deletion.
ALTER TABLE "SurfacedMail" DROP CONSTRAINT "SurfacedMail_userId_fkey";

-- AddForeignKey
ALTER TABLE "SurfacedMail" ADD CONSTRAINT "SurfacedMail_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
