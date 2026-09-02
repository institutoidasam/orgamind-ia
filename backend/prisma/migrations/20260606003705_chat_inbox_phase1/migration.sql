-- CreateEnum
CREATE TYPE "MessageDirection" AS ENUM ('INBOUND', 'OUTBOUND');

-- CreateEnum
CREATE TYPE "MessageKind" AS ENUM ('TEXT', 'IMAGE', 'VIDEO', 'AUDIO', 'DOCUMENT', 'STICKER', 'LOCATION', 'CONTACT', 'UNSUPPORTED');

-- CreateEnum
CREATE TYPE "MediaStatus" AS ENUM ('PENDING', 'READY', 'FAILED');

-- AlterEnum
ALTER TYPE "MessageStatus" ADD VALUE 'RECEIVED';

-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "authorUserId" TEXT,
ADD COLUMN     "content" TEXT,
ADD COLUMN     "conversationId" TEXT,
ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "direction" "MessageDirection" NOT NULL DEFAULT 'OUTBOUND',
ADD COLUMN     "kind" "MessageKind" NOT NULL DEFAULT 'TEXT',
ADD COLUMN     "quotedPreview" TEXT,
ADD COLUMN     "quotedWaMessageId" TEXT,
ADD COLUMN     "receivedAt" TIMESTAMP(3),
ALTER COLUMN "campaignId" DROP NOT NULL,
ALTER COLUMN "contactId" DROP NOT NULL,
ALTER COLUMN "variables" DROP NOT NULL;

-- CreateTable
CREATE TABLE "Conversation" (
    "id" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "remoteJid" TEXT NOT NULL,
    "phoneE164" TEXT NOT NULL,
    "contactId" TEXT,
    "waName" TEXT,
    "profilePicUrl" TEXT,
    "lastMessageAt" TIMESTAMP(3),
    "lastMessagePreview" TEXT,
    "lastMessageDirection" "MessageDirection",
    "unreadCount" INTEGER NOT NULL DEFAULT 0,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MessageMedia" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "kind" "MessageKind" NOT NULL,
    "status" "MediaStatus" NOT NULL DEFAULT 'PENDING',
    "mimeType" TEXT,
    "fileName" TEXT,
    "sizeBytes" INTEGER,
    "durationSec" INTEGER,
    "width" INTEGER,
    "height" INTEGER,
    "storageKey" TEXT,
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MessageMedia_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Conversation_instanceId_archivedAt_lastMessageAt_idx" ON "Conversation"("instanceId", "archivedAt", "lastMessageAt" DESC);

-- CreateIndex
CREATE INDEX "Conversation_contactId_idx" ON "Conversation"("contactId");

-- CreateIndex
CREATE INDEX "Conversation_phoneE164_idx" ON "Conversation"("phoneE164");

-- CreateIndex
CREATE UNIQUE INDEX "Conversation_instanceId_remoteJid_key" ON "Conversation"("instanceId", "remoteJid");

-- CreateIndex
CREATE UNIQUE INDEX "MessageMedia_messageId_key" ON "MessageMedia"("messageId");

-- CreateIndex
CREATE INDEX "Message_conversationId_createdAt_idx" ON "Message"("conversationId", "createdAt");

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "WhatsappInstance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageMedia" ADD CONSTRAINT "MessageMedia_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
