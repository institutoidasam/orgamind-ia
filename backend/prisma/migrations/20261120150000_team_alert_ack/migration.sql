-- Ciência, lembrete e motivo ACKED do alerta urgente (Lote I, CI1/DI1).
-- Migração só aditiva: um enum novo ("TeamAlertAckKind"), um valor novo no enum
-- "TeamWhatsappSkipReason" (ACKED), quatro colunas em "TeamWhatsappDispatch"
-- ("ackDeadlineMinutes", "parentDispatchId", "reminderCount", "lastReminderAt"),
-- oito colunas em "TeamWhatsappRecipient" (ackAt, ackKind, ackByUserId,
-- ackNote, ackMessageId, ackMessageAt, lastReplyMessageId,
-- parentRecipientId), duas chaves estrangeiras com ON DELETE SET NULL
-- (lembrete -> alerta e destinatário de lembrete -> destinatário do alerta) e
-- dois índices nas colunas dessas chaves. Nenhuma linha existente é alterada,
-- nenhuma coluna, valor ou índice é removido ou movido, nenhuma "RolePermission"
-- é criada; envio e destinatário criados antes desta versão ficam com as
-- colunas novas nulas e "reminderCount" 0 (null = não é alerta / pendente; o
-- padrão do alerta continua desligado, nada é semeado). O DDL abaixo é o que o
-- `prisma migrate diff` gera para os campos novos; esta migração não usa o
-- valor novo do enum.
--
-- ALTER TYPE ... ADD VALUE exige Postgres >= 12 para rodar dentro de
-- transação (o compose de dev/prod e o testcontainers usam postgres:16) e o
-- valor novo não pode ser usado na mesma transação (aqui não é).
--
-- O ADD COLUMN pega ACCESS EXCLUSIVE nas duas tabelas e espera as transações
-- abertas nelas (leitura ou escrita). O lock em si é curto: colunas nulas e
-- "reminderCount" com default constante (Postgres >= 11 grava só no catálogo,
-- sem reescrever a tabela). O CREATE INDEX (sem CONCURRENTLY, pois roda dentro
-- da transação da migração) e o ADD CONSTRAINT FOREIGN KEY (varre a coluna nova,
-- toda nula, e pega SHARE ROW EXCLUSIVE na tabela referenciada, que é a própria)
-- bloqueiam escrita em "TeamWhatsappDispatch" e "TeamWhatsappRecipient" por
-- instantes; "TeamWhatsappRecipient" tem uma linha por pessoa por envio (a maior
-- das duas): aplicar fora do horário de envio. O timeout evita que o deploy
-- fique em fila atrás de uma transação longa (e, atrás do lock pendente,
-- bloqueie as demais consultas das tabelas). Se estourar, a migração inteira se
-- desfaz (nada escrito): rode `prisma migrate resolve --rolled-back` e aplique
-- de novo.
-- SET LOCAL: vale só nesta transação.
SET LOCAL lock_timeout = '15s';

-- CreateEnum
CREATE TYPE "TeamAlertAckKind" AS ENUM ('KEYWORD', 'MANUAL');

-- AlterEnum
ALTER TYPE "TeamWhatsappSkipReason" ADD VALUE 'ACKED';

-- AlterTable
ALTER TABLE "TeamWhatsappDispatch" ADD COLUMN     "ackDeadlineMinutes" INTEGER,
ADD COLUMN     "lastReminderAt" TIMESTAMP(3),
ADD COLUMN     "parentDispatchId" TEXT,
ADD COLUMN     "reminderCount" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "TeamWhatsappRecipient" ADD COLUMN     "ackAt" TIMESTAMP(3),
ADD COLUMN     "ackByUserId" TEXT,
ADD COLUMN     "ackKind" "TeamAlertAckKind",
ADD COLUMN     "ackMessageAt" TIMESTAMP(3),
ADD COLUMN     "ackMessageId" TEXT,
ADD COLUMN     "ackNote" VARCHAR(200),
ADD COLUMN     "lastReplyMessageId" TEXT,
ADD COLUMN     "parentRecipientId" TEXT;

-- CreateIndex
CREATE INDEX "TeamWhatsappDispatch_parentDispatchId_idx" ON "TeamWhatsappDispatch"("parentDispatchId");

-- CreateIndex
CREATE INDEX "TeamWhatsappRecipient_parentRecipientId_idx" ON "TeamWhatsappRecipient"("parentRecipientId");

-- AddForeignKey
ALTER TABLE "TeamWhatsappDispatch" ADD CONSTRAINT "TeamWhatsappDispatch_parentDispatchId_fkey" FOREIGN KEY ("parentDispatchId") REFERENCES "TeamWhatsappDispatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamWhatsappRecipient" ADD CONSTRAINT "TeamWhatsappRecipient_parentRecipientId_fkey" FOREIGN KEY ("parentRecipientId") REFERENCES "TeamWhatsappRecipient"("id") ON DELETE SET NULL ON UPDATE CASCADE;
