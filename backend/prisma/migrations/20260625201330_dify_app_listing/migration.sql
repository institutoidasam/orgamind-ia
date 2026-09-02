-- AlterTable: add difyAppId, mode, lastSyncedAt columns and drop the unique constraint on name
ALTER TABLE "Bot" ADD COLUMN "difyAppId" TEXT;
ALTER TABLE "Bot" ADD COLUMN "mode" TEXT;
ALTER TABLE "Bot" ADD COLUMN "lastSyncedAt" TIMESTAMP(3);

-- DropIndex: remove uniqueness from Bot.name (name is now a synced label, not identity)
DROP INDEX "Bot_name_key";

-- CreateIndex: new unique constraint on difyAppId
CREATE UNIQUE INDEX "Bot_difyAppId_key" ON "Bot"("difyAppId");
