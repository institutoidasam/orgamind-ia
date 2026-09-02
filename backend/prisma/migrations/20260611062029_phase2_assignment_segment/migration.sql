-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN     "segmentId" TEXT;

-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "assignedAt" TIMESTAMP(3),
ADD COLUMN     "assignedUserId" TEXT;

-- CreateTable
CREATE TABLE "Segment" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "filters" JSONB NOT NULL,
    "createdById" TEXT,
    "lastCount" INTEGER,
    "lastCountedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Segment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Segment_name_key" ON "Segment"("name");

-- CreateIndex
CREATE INDEX "Segment_createdById_idx" ON "Segment"("createdById");

-- CreateIndex
CREATE INDEX "Campaign_segmentId_idx" ON "Campaign"("segmentId");

-- CreateIndex
CREATE INDEX "Conversation_assignedUserId_idx" ON "Conversation"("assignedUserId");

-- AddForeignKey
ALTER TABLE "Segment" ADD CONSTRAINT "Segment_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_segmentId_fkey" FOREIGN KEY ("segmentId") REFERENCES "Segment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_assignedUserId_fkey" FOREIGN KEY ("assignedUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
