-- Agendamento com reconferência e telefone do destinatário (Lote G, CG5/DG1).
-- Migração só aditiva: acrescenta 1 valor ao enum "TeamWhatsappDispatchState"
-- (EXPIRED), 5 ao "TeamWhatsappSkipReason" (VACATION, DAY_OFF, LEFT_SECTOR,
-- PHONE_CHANGED, EXPIRED), duas colunas nulas em "TeamWhatsappDispatch"
-- ("recheckedAt", "audienceLateJoined"), uma coluna nula em
-- "TeamWhatsappRecipient" ("phoneE164") e dois índices em
-- "TeamWhatsappDispatch". Nenhuma linha existente é alterada, nenhuma coluna,
-- valor ou índice é removido ou movido; envio e destinatário criados antes
-- desta versão ficam com as colunas novas nulas (null = envio antigo ou não
-- reconferido). O DDL abaixo é o que o `prisma migrate diff` gera para os
-- campos novos; esta migração não usa os valores novos dos enums.
--
-- ALTER TYPE ... ADD VALUE exige Postgres >= 12 para rodar dentro de
-- transação (o compose de dev/prod e o testcontainers usam postgres:16) e o
-- valor novo não pode ser usado na mesma transação (aqui não é).
--
-- O ADD COLUMN pega ACCESS EXCLUSIVE nas duas tabelas e espera as transações
-- abertas nelas (leitura ou escrita). O lock em si é curto: coluna nula, sem
-- default, só troca o catálogo e não reescreve a tabela. O CREATE INDEX (sem
-- CONCURRENTLY, pois roda dentro da transação da migração) bloqueia escrita em
-- "TeamWhatsappDispatch" enquanto o índice é criado; a tabela é pequena
-- (um envio por clique) e o tempo é de milissegundos. O timeout evita que o
-- deploy fique em fila atrás de uma transação longa (e, atrás do lock
-- pendente, bloqueie as demais consultas da tabela). Se estourar, a migração
-- inteira se desfaz (nada escrito): rode `prisma migrate resolve --rolled-back`
-- e aplique de novo.
-- SET LOCAL: vale só nesta transação.
SET LOCAL lock_timeout = '15s';

-- AlterEnum
ALTER TYPE "TeamWhatsappDispatchState" ADD VALUE 'EXPIRED';

-- AlterEnum
ALTER TYPE "TeamWhatsappSkipReason" ADD VALUE 'VACATION';
ALTER TYPE "TeamWhatsappSkipReason" ADD VALUE 'DAY_OFF';
ALTER TYPE "TeamWhatsappSkipReason" ADD VALUE 'LEFT_SECTOR';
ALTER TYPE "TeamWhatsappSkipReason" ADD VALUE 'PHONE_CHANGED';
ALTER TYPE "TeamWhatsappSkipReason" ADD VALUE 'EXPIRED';

-- AlterTable
ALTER TABLE "TeamWhatsappDispatch" ADD COLUMN     "audienceLateJoined" JSONB,
ADD COLUMN     "recheckedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "TeamWhatsappRecipient" ADD COLUMN     "phoneE164" TEXT;

-- CreateIndex
CREATE INDEX "TeamWhatsappDispatch_state_createdAt_idx" ON "TeamWhatsappDispatch"("state", "createdAt");

-- CreateIndex
CREATE INDEX "TeamWhatsappDispatch_purpose_createdAt_idx" ON "TeamWhatsappDispatch"("purpose", "createdAt");
