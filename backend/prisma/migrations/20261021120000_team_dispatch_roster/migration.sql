-- AlterTable
ALTER TABLE "TeamWhatsappDispatch" ADD COLUMN     "includeOff" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "roster" JSONB,
ADD COLUMN     "rosterDate" DATE;

