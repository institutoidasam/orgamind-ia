/*
  Warnings:

  - A unique constraint covering the columns `[gozapInstanceId]` on the table `WhatsappInstance` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterEnum
ALTER TYPE "ChannelProvider" ADD VALUE 'GOZAP';

-- AlterTable
ALTER TABLE "WhatsappInstance" ADD COLUMN     "gozapInstanceId" TEXT,
ADD COLUMN     "gozapInstanceToken" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "WhatsappInstance_gozapInstanceId_key" ON "WhatsappInstance"("gozapInstanceId");
