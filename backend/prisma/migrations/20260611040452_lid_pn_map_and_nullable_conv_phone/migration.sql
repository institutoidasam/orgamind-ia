-- AlterTable
ALTER TABLE "Conversation" ALTER COLUMN "phoneE164" DROP NOT NULL;

-- CreateTable
CREATE TABLE "LidPnMap" (
    "id" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "lid" TEXT NOT NULL,
    "phoneE164" TEXT NOT NULL,
    "name" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LidPnMap_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LidPnMap_instanceId_phoneE164_idx" ON "LidPnMap"("instanceId", "phoneE164");

-- CreateIndex
CREATE UNIQUE INDEX "LidPnMap_instanceId_lid_key" ON "LidPnMap"("instanceId", "lid");
