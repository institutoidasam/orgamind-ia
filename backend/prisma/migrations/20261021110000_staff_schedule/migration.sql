-- CreateEnum
CREATE TYPE "StaffScheduleTemplate" AS ENUM ('WEEKLY', 'WEEKLY_ROTATION', 'TWELVE_36', 'CUSTOM');

-- CreateEnum
CREATE TYPE "StaffExceptionKind" AS ENUM ('DAY_OFF', 'VACATION', 'SHIFT_SWAP', 'OTHER_SECTOR');

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "jobTitle" VARCHAR(80);

-- CreateTable
CREATE TABLE "StaffSchedule" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "template" "StaffScheduleTemplate" NOT NULL,
    "startDate" DATE NOT NULL,
    "cycleLength" INTEGER NOT NULL,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StaffSchedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StaffScheduleDay" (
    "scheduleId" TEXT NOT NULL,
    "dayIndex" INTEGER NOT NULL,
    "shiftId" TEXT,

    CONSTRAINT "StaffScheduleDay_pkey" PRIMARY KEY ("scheduleId","dayIndex")
);

-- CreateTable
CREATE TABLE "StaffScheduleException" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" "StaffExceptionKind" NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "shiftId" TEXT,
    "sectorId" TEXT,
    "note" VARCHAR(200),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StaffScheduleException_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StaffSchedule_userId_key" ON "StaffSchedule"("userId");

-- CreateIndex
CREATE INDEX "StaffScheduleDay_shiftId_idx" ON "StaffScheduleDay"("shiftId");

-- CreateIndex
CREATE INDEX "StaffScheduleException_userId_startDate_idx" ON "StaffScheduleException"("userId", "startDate");

-- CreateIndex
CREATE INDEX "StaffScheduleException_sectorId_startDate_idx" ON "StaffScheduleException"("sectorId", "startDate");

-- CreateIndex
CREATE INDEX "StaffScheduleException_shiftId_endDate_idx" ON "StaffScheduleException"("shiftId", "endDate");

-- AddForeignKey
ALTER TABLE "StaffSchedule" ADD CONSTRAINT "StaffSchedule_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffScheduleDay" ADD CONSTRAINT "StaffScheduleDay_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "StaffSchedule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffScheduleDay" ADD CONSTRAINT "StaffScheduleDay_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "Shift"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffScheduleException" ADD CONSTRAINT "StaffScheduleException_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffScheduleException" ADD CONSTRAINT "StaffScheduleException_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "Shift"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffScheduleException" ADD CONSTRAINT "StaffScheduleException_sectorId_fkey" FOREIGN KEY ("sectorId") REFERENCES "Sector"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

