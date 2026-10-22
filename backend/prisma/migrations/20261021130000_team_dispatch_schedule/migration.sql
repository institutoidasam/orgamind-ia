-- CreateEnum
CREATE TYPE "TeamWhatsappDispatchState" AS ENUM ('DISPATCHED', 'SCHEDULED', 'CANCELLED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "TeamWhatsappRecipientStatus" ADD VALUE 'SCHEDULED';
ALTER TYPE "TeamWhatsappRecipientStatus" ADD VALUE 'CANCELLED';

-- AlterEnum
ALTER TYPE "TeamWhatsappSkipReason" ADD VALUE 'INACTIVE';

-- AlterTable
ALTER TABLE "TeamWhatsappDispatch" ADD COLUMN     "cancelledAt" TIMESTAMP(3),
ADD COLUMN     "cancelledById" TEXT,
ADD COLUMN     "firedAt" TIMESTAMP(3),
ADD COLUMN     "scheduledFor" TIMESTAMP(3),
ADD COLUMN     "state" "TeamWhatsappDispatchState" NOT NULL DEFAULT 'DISPATCHED';

-- CreateIndex
CREATE INDEX "TeamWhatsappDispatch_state_scheduledFor_idx" ON "TeamWhatsappDispatch"("state", "scheduledFor");

