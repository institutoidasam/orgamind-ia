-- F1: additive foundation for internal sector communication. Existing users
-- remain valid through nullable membership and safe defaults.

ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'SUPERVISOR';
ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'VIEWER';

CREATE TYPE "InternalCommunicationKind" AS ENUM ('DEMAND', 'ANNOUNCEMENT');
CREATE TYPE "InternalPriority" AS ENUM ('NORMAL', 'HIGH', 'URGENT');
CREATE TYPE "InternalDemandStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'WAITING', 'COMPLETED');
CREATE TYPE "InternalEventKind" AS ENUM (
  'CREATED', 'COMMENTED', 'STATUS_CHANGED', 'ASSIGNED', 'UNASSIGNED',
  'PRIORITY_CHANGED', 'DUE_DATE_CHANGED'
);
CREATE TYPE "SectorNumberProvider" AS ENUM ('META', 'EVOLUTION', 'OTHER');

ALTER TABLE "User"
  ADD COLUMN "sectorId" TEXT,
  ADD COLUMN "isActive" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "sessionVersion" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "Sector" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "description" TEXT,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "managerId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Sector_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "InternalCommunication" (
  "id" TEXT NOT NULL,
  "sequence" SERIAL NOT NULL,
  "reference" TEXT NOT NULL,
  "clientRequestId" TEXT NOT NULL,
  "kind" "InternalCommunicationKind" NOT NULL,
  "subject" TEXT NOT NULL,
  "message" TEXT NOT NULL,
  "authorId" TEXT,
  "authorSnapshot" JSONB,
  "originSectorId" TEXT NOT NULL,
  "destinationSectorId" TEXT NOT NULL,
  "assigneeId" TEXT,
  "priority" "InternalPriority",
  "dueDate" DATE,
  "status" "InternalDemandStatus",
  "version" INTEGER NOT NULL DEFAULT 0,
  "notifyTeam" BOOLEAN NOT NULL DEFAULT true,
  "notifyAssignee" BOOLEAN NOT NULL DEFAULT true,
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "InternalCommunication_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "InternalRecipient" (
  "communicationId" TEXT NOT NULL,
  "sectorId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "InternalRecipient_pkey" PRIMARY KEY ("communicationId", "sectorId")
);

CREATE TABLE "InternalEvent" (
  "id" TEXT NOT NULL,
  "communicationId" TEXT NOT NULL,
  "kind" "InternalEventKind" NOT NULL,
  "message" TEXT,
  "actorId" TEXT,
  "actorSnapshot" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "InternalEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "InternalRead" (
  "communicationId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "readAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "InternalRead_pkey" PRIMARY KEY ("communicationId", "userId")
);

CREATE TABLE "SectorNumber" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "phone" TEXT NOT NULL,
  "provider" "SectorNumberProvider" NOT NULL,
  "sectorId" TEXT,
  "routeToSector" BOOLEAN NOT NULL DEFAULT false,
  "channelId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SectorNumber_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Sector_name_key" ON "Sector"("name");
CREATE UNIQUE INDEX "Sector_code_key" ON "Sector"("code");
CREATE INDEX "Sector_isActive_name_idx" ON "Sector"("isActive", "name");
CREATE INDEX "Sector_managerId_idx" ON "Sector"("managerId");
CREATE UNIQUE INDEX "InternalCommunication_sequence_key" ON "InternalCommunication"("sequence");
CREATE UNIQUE INDEX "InternalCommunication_reference_key" ON "InternalCommunication"("reference");
CREATE UNIQUE INDEX "InternalCommunication_clientRequestId_key" ON "InternalCommunication"("clientRequestId");
CREATE INDEX "InternalCommunication_originSectorId_status_updatedAt_idx" ON "InternalCommunication"("originSectorId", "status", "updatedAt");
CREATE INDEX "InternalCommunication_destinationSectorId_status_dueDate_idx" ON "InternalCommunication"("destinationSectorId", "status", "dueDate");
CREATE INDEX "InternalCommunication_assigneeId_status_idx" ON "InternalCommunication"("assigneeId", "status");
CREATE INDEX "InternalRecipient_sectorId_idx" ON "InternalRecipient"("sectorId");
CREATE INDEX "InternalEvent_communicationId_createdAt_idx" ON "InternalEvent"("communicationId", "createdAt");
CREATE INDEX "InternalRead_userId_readAt_idx" ON "InternalRead"("userId", "readAt");
CREATE UNIQUE INDEX "SectorNumber_channelId_key" ON "SectorNumber"("channelId");
CREATE INDEX "SectorNumber_sectorId_idx" ON "SectorNumber"("sectorId");

ALTER TABLE "User" ADD CONSTRAINT "User_sectorId_fkey"
  FOREIGN KEY ("sectorId") REFERENCES "Sector"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Sector" ADD CONSTRAINT "Sector_managerId_fkey"
  FOREIGN KEY ("managerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "InternalCommunication" ADD CONSTRAINT "InternalCommunication_authorId_fkey"
  FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "InternalCommunication" ADD CONSTRAINT "InternalCommunication_originSectorId_fkey"
  FOREIGN KEY ("originSectorId") REFERENCES "Sector"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InternalCommunication" ADD CONSTRAINT "InternalCommunication_destinationSectorId_fkey"
  FOREIGN KEY ("destinationSectorId") REFERENCES "Sector"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InternalCommunication" ADD CONSTRAINT "InternalCommunication_assigneeId_fkey"
  FOREIGN KEY ("assigneeId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "InternalRecipient" ADD CONSTRAINT "InternalRecipient_communicationId_fkey"
  FOREIGN KEY ("communicationId") REFERENCES "InternalCommunication"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "InternalRecipient" ADD CONSTRAINT "InternalRecipient_sectorId_fkey"
  FOREIGN KEY ("sectorId") REFERENCES "Sector"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InternalEvent" ADD CONSTRAINT "InternalEvent_communicationId_fkey"
  FOREIGN KEY ("communicationId") REFERENCES "InternalCommunication"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "InternalEvent" ADD CONSTRAINT "InternalEvent_actorId_fkey"
  FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "InternalRead" ADD CONSTRAINT "InternalRead_communicationId_fkey"
  FOREIGN KEY ("communicationId") REFERENCES "InternalCommunication"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "InternalRead" ADD CONSTRAINT "InternalRead_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SectorNumber" ADD CONSTRAINT "SectorNumber_sectorId_fkey"
  FOREIGN KEY ("sectorId") REFERENCES "Sector"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SectorNumber" ADD CONSTRAINT "SectorNumber_channelId_fkey"
  FOREIGN KEY ("channelId") REFERENCES "WhatsappInstance"("id") ON DELETE SET NULL ON UPDATE CASCADE;
