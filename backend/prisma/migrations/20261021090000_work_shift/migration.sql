-- CreateEnum
CREATE TYPE "WorkShift" AS ENUM ('FIRST', 'SECOND');

-- AlterTable
ALTER TABLE "TeamWhatsappDispatch" ADD COLUMN     "shift" "WorkShift";

-- AlterTable
ALTER TABLE "TeamWhatsappRecipient" ADD COLUMN     "shift" "WorkShift";

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "shift" "WorkShift";
