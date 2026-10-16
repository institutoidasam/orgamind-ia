-- CreateEnum
CREATE TYPE "TeamWhatsappTargetType" AS ENUM ('USER', 'SECTOR');

-- CreateEnum
CREATE TYPE "TeamWhatsappRecipientStatus" AS ENUM ('QUEUED', 'SENT', 'FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "TeamWhatsappSkipReason" AS ENUM ('NO_PHONE', 'SUPPRESSED');

-- CreateTable
CREATE TABLE "TeamWhatsappDispatch" (
    "id" TEXT NOT NULL,
    "authorId" TEXT,
    "targetType" "TeamWhatsappTargetType" NOT NULL,
    "targetId" TEXT NOT NULL,
    "targetLabel" TEXT NOT NULL,
    "channelId" TEXT,
    "text" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TeamWhatsappDispatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeamWhatsappRecipient" (
    "id" TEXT NOT NULL,
    "dispatchId" TEXT NOT NULL,
    "userId" TEXT,
    "userName" TEXT NOT NULL,
    "status" "TeamWhatsappRecipientStatus" NOT NULL DEFAULT 'QUEUED',
    "skipReason" "TeamWhatsappSkipReason",
    "messageId" TEXT,
    "errorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TeamWhatsappRecipient_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TeamWhatsappDispatch_createdAt_idx" ON "TeamWhatsappDispatch"("createdAt");

-- CreateIndex
CREATE INDEX "TeamWhatsappDispatch_authorId_createdAt_idx" ON "TeamWhatsappDispatch"("authorId", "createdAt");

-- CreateIndex
CREATE INDEX "TeamWhatsappRecipient_dispatchId_status_idx" ON "TeamWhatsappRecipient"("dispatchId", "status");

-- AddForeignKey
ALTER TABLE "TeamWhatsappDispatch" ADD CONSTRAINT "TeamWhatsappDispatch_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamWhatsappDispatch" ADD CONSTRAINT "TeamWhatsappDispatch_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "WhatsappInstance"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamWhatsappRecipient" ADD CONSTRAINT "TeamWhatsappRecipient_dispatchId_fkey" FOREIGN KEY ("dispatchId") REFERENCES "TeamWhatsappDispatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamWhatsappRecipient" ADD CONSTRAINT "TeamWhatsappRecipient_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

