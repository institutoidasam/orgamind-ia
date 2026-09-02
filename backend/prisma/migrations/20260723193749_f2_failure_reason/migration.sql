-- CreateEnum
CREATE TYPE "FailureReason" AS ENUM ('SEM_WHATSAPP', 'OPT_OUT', 'MARKETING_DESLIGADO', 'SEM_CONSENTIMENTO', 'FORA_DA_JANELA', 'LIMITE_DIARIO', 'TELEFONE_INVALIDO', 'TEMPLATE_INDISPONIVEL', 'CANAL_FORA', 'INDETERMINADO', 'OUTRO');

-- AlterTable
ALTER TABLE "Contact" ADD COLUMN     "failureCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "lastFailureAt" TIMESTAMP(3),
ADD COLUMN     "lastFailureCode" TEXT,
ADD COLUMN     "lastFailureReason" "FailureReason";

-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "failureReason" "FailureReason";

-- CreateIndex
CREATE INDEX "Contact_lastFailureReason_idx" ON "Contact"("lastFailureReason");

-- CreateIndex
CREATE INDEX "Message_contactId_status_idx" ON "Message"("contactId", "status");

-- CreateIndex
CREATE INDEX "Message_campaignId_failureReason_idx" ON "Message"("campaignId", "failureReason");

