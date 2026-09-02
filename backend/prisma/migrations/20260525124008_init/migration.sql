-- CreateEnum
CREATE TYPE "Role" AS ENUM ('ADMIN', 'OPERATOR');

-- CreateEnum
CREATE TYPE "ImportItemStatus" AS ENUM ('CREATED', 'UPDATED', 'INVALID', 'DUPLICATE');

-- CreateEnum
CREATE TYPE "TemplateKind" AS ENUM ('TEXT', 'LIST', 'BUTTONS', 'POLL');

-- CreateEnum
CREATE TYPE "ScheduleType" AS ENUM ('IMMEDIATE', 'ONCE_AT', 'DAILY_AT', 'WEEKLY', 'INTERVAL');

-- CreateEnum
CREATE TYPE "TemplateStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "TemplateCategory" AS ENUM ('MARKETING', 'UTILITY', 'AUTHENTICATION');

-- CreateEnum
CREATE TYPE "CampaignStatus" AS ENUM ('DRAFT', 'QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "MessageStatus" AS ENUM ('QUEUED', 'WAITING_INSTANCE', 'SENT', 'DELIVERED', 'READ', 'FAILED', 'CANCELLED');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "name" TEXT,
    "role" "Role" NOT NULL DEFAULT 'OPERATOR',
    "mustChangePassword" BOOLEAN NOT NULL DEFAULT true,
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Contact" (
    "id" TEXT NOT NULL,
    "phoneE164" TEXT NOT NULL,
    "name" TEXT,
    "city" TEXT,
    "group" TEXT,
    "tags" TEXT[],
    "customFields" JSONB,
    "optedOut" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "whatsappValid" BOOLEAN,
    "whatsappCheckedAt" TIMESTAMP(3),
    "profilePictureUrl" TEXT,
    "waLabels" TEXT[],

    CONSTRAINT "Contact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImportBatch" (
    "id" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "totalRows" INTEGER NOT NULL,
    "importedRows" INTEGER NOT NULL DEFAULT 0,
    "errors" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ImportBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImportItem" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "contactId" TEXT,
    "rawRow" JSONB NOT NULL,
    "status" "ImportItemStatus" NOT NULL,

    CONSTRAINT "ImportItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Template" (
    "id" TEXT NOT NULL,
    "metaName" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "variables" TEXT[],
    "status" "TemplateStatus" NOT NULL,
    "category" "TemplateCategory" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "kind" "TemplateKind" NOT NULL DEFAULT 'TEXT',
    "interactiveConfig" JSONB,

    CONSTRAINT "Template_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Campaign" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "filters" JSONB NOT NULL,
    "variableMap" JSONB NOT NULL,
    "totalRecipients" INTEGER NOT NULL,
    "status" "CampaignStatus" NOT NULL DEFAULT 'DRAFT',
    "scheduledAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "scheduleType" "ScheduleType" NOT NULL DEFAULT 'IMMEDIATE',
    "scheduleConfig" JSONB,
    "scheduleEnabled" BOOLEAN NOT NULL DEFAULT true,
    "nextRunAt" TIMESTAMP(3),
    "lastRunAt" TIMESTAMP(3),
    "runCount" INTEGER NOT NULL DEFAULT 0,
    "timezone" TEXT NOT NULL DEFAULT 'America/Sao_Paulo',
    "defaultInstanceId" TEXT NOT NULL,
    "presenceDelayMs" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Campaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "providerMessageId" TEXT,
    "status" "MessageStatus" NOT NULL DEFAULT 'QUEUED',
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "variables" JSONB NOT NULL,
    "queuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "readAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "instanceId" TEXT NOT NULL,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" TEXT NOT NULL,
    "actorId" TEXT,
    "action" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" TEXT,
    "metadata" JSONB,
    "ip" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WhatsappConnectionEvent" (
    "id" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "reasonCode" INTEGER,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WhatsappConnectionEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WhatsappInstance" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "evolutionInstanceName" TEXT NOT NULL,
    "apiKey" TEXT NOT NULL,
    "phoneE164" TEXT,
    "profileName" TEXT,
    "profilePictureUrl" TEXT,
    "ownerUserId" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "rejectCall" BOOLEAN NOT NULL DEFAULT true,
    "msgCall" TEXT NOT NULL DEFAULT 'Não atendemos chamadas. Mande uma mensagem.',
    "groupsIgnore" BOOLEAN NOT NULL DEFAULT true,
    "alwaysOnline" BOOLEAN NOT NULL DEFAULT false,
    "readMessages" BOOLEAN NOT NULL DEFAULT false,
    "readStatus" BOOLEAN NOT NULL DEFAULT false,
    "syncFullHistory" BOOLEAN NOT NULL DEFAULT false,
    "globalPresenceDelayMs" INTEGER NOT NULL DEFAULT 4000,
    "globalJitterMaxMs" INTEGER NOT NULL DEFAULT 5000,
    "dailySendLimit" INTEGER NOT NULL DEFAULT 500,
    "sendWindowStartHour" INTEGER NOT NULL DEFAULT 8,
    "sendWindowEndHour" INTEGER NOT NULL DEFAULT 20,
    "sendWindowEnabled" BOOLEAN NOT NULL DEFAULT true,
    "sentToday" INTEGER NOT NULL DEFAULT 0,
    "sentTodayResetAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WhatsappInstance_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Contact_phoneE164_key" ON "Contact"("phoneE164");

-- CreateIndex
CREATE INDEX "Contact_city_group_idx" ON "Contact"("city", "group");

-- CreateIndex
CREATE INDEX "Contact_optedOut_idx" ON "Contact"("optedOut");

-- CreateIndex
CREATE INDEX "Contact_whatsappValid_idx" ON "Contact"("whatsappValid");

-- CreateIndex
CREATE UNIQUE INDEX "Template_metaName_key" ON "Template"("metaName");

-- CreateIndex
CREATE INDEX "Campaign_scheduleEnabled_nextRunAt_idx" ON "Campaign"("scheduleEnabled", "nextRunAt");

-- CreateIndex
CREATE UNIQUE INDEX "Message_providerMessageId_key" ON "Message"("providerMessageId");

-- CreateIndex
CREATE INDEX "Message_campaignId_status_idx" ON "Message"("campaignId", "status");

-- CreateIndex
CREATE INDEX "Message_contactId_idx" ON "Message"("contactId");

-- CreateIndex
CREATE INDEX "Message_contactId_sentAt_idx" ON "Message"("contactId", "sentAt");

-- CreateIndex
CREATE INDEX "Message_instanceId_status_idx" ON "Message"("instanceId", "status");

-- CreateIndex
CREATE INDEX "AuditEvent_entity_entityId_createdAt_idx" ON "AuditEvent"("entity", "entityId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditEvent_actorId_createdAt_idx" ON "AuditEvent"("actorId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditEvent_action_createdAt_idx" ON "AuditEvent"("action", "createdAt");

-- CreateIndex
CREATE INDEX "WhatsappConnectionEvent_instanceId_occurredAt_idx" ON "WhatsappConnectionEvent"("instanceId", "occurredAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "WhatsappInstance_evolutionInstanceName_key" ON "WhatsappInstance"("evolutionInstanceName");

-- CreateIndex
CREATE INDEX "WhatsappInstance_ownerUserId_isActive_idx" ON "WhatsappInstance"("ownerUserId", "isActive");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportItem" ADD CONSTRAINT "ImportItem_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "ImportBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportItem" ADD CONSTRAINT "ImportItem_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "Template"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_defaultInstanceId_fkey" FOREIGN KEY ("defaultInstanceId") REFERENCES "WhatsappInstance"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "WhatsappInstance"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WhatsappConnectionEvent" ADD CONSTRAINT "WhatsappConnectionEvent_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "WhatsappInstance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WhatsappInstance" ADD CONSTRAINT "WhatsappInstance_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Garante apenas UMA instância marcada como default por vez.
CREATE UNIQUE INDEX "WhatsappInstance_isDefault_unique"
  ON "WhatsappInstance"("isDefault")
  WHERE "isDefault" = true;
