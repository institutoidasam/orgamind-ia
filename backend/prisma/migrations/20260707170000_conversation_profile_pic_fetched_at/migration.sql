-- AlterTable: stamp of the last avatar fetch attempt (U2 — 24h TTL refresh)
ALTER TABLE "Conversation" ADD COLUMN "profilePicFetchedAt" TIMESTAMP(3);
