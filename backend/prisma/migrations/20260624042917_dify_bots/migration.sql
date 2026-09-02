-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "botPausedAt" TIMESTAMP(3),
ADD COLUMN     "difyConversationId" TEXT;

-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "botId" TEXT;

-- AlterTable
ALTER TABLE "WhatsappInstance" ADD COLUMN     "botId" TEXT;

-- CreateTable
CREATE TABLE "Bot" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "difyApiKey" TEXT NOT NULL,
    "difyBaseUrl" TEXT,
    "fallbackMessage" TEXT,
    "inputs" JSONB,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Bot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Bot_name_key" ON "Bot"("name");

-- CreateIndex
CREATE INDEX "Message_botId_idx" ON "Message"("botId");

-- CreateIndex
CREATE INDEX "WhatsappInstance_botId_idx" ON "WhatsappInstance"("botId");

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_botId_fkey" FOREIGN KEY ("botId") REFERENCES "Bot"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WhatsappInstance" ADD CONSTRAINT "WhatsappInstance_botId_fkey" FOREIGN KEY ("botId") REFERENCES "Bot"("id") ON DELETE SET NULL ON UPDATE CASCADE;
