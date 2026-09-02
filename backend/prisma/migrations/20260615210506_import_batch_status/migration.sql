-- CreateEnum
CREATE TYPE "ImportBatchStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED');

-- AlterTable
ALTER TABLE "ImportBatch" ADD COLUMN     "status" "ImportBatchStatus" NOT NULL DEFAULT 'PENDING',
ADD COLUMN     "summary" JSONB,
ALTER COLUMN "totalRows" SET DEFAULT 0;

-- Backfill: every ImportBatch that already exists was imported synchronously and
-- has already finished, so mark them COMPLETED rather than leaving them PENDING
-- (the default for new async batches), which would render as "stuck" in history.
UPDATE "ImportBatch" SET "status" = 'COMPLETED';
