-- Rastreio do envio da equipe: hora da conferência e índice do verificador
-- (Lote H, DH1). Migração só aditiva: uma coluna nula ("channelCheckedAt") e um
-- índice ("status", "updatedAt") em "TeamWhatsappRecipient". Nenhuma linha é
-- alterada, nenhuma coluna, valor ou índice é removido ou movido; nenhum enum
-- muda; destinatário criado antes desta versão fica com a coluna nula
-- (null = anterior a esta versão, pulado ou falho antes da conferência, ou sem
-- conexão `open`). O DDL abaixo é o que o `prisma migrate diff` gera para os
-- campos novos.
--
-- O ADD COLUMN pega ACCESS EXCLUSIVE em "TeamWhatsappRecipient" e espera as
-- transações abertas nela (leitura ou escrita). O lock em si é curto: coluna
-- nula, sem default, só troca o catálogo e não reescreve a tabela. O CREATE
-- INDEX (sem CONCURRENTLY, pois roda dentro da transação da migração, e
-- CREATE INDEX CONCURRENTLY não roda em transação) bloqueia escrita em
-- "TeamWhatsappRecipient" enquanto o índice é criado; a tabela tem uma linha
-- por pessoa por envio, maior que a de envios: estimar o tamanho no banco de
-- QA no Fechamento e aplicar fora do horário de envio. O timeout evita que o
-- deploy fique em fila atrás de uma transação longa (e, atrás do lock
-- pendente, bloqueie as demais consultas da tabela). Se estourar, a migração
-- inteira se desfaz (nada escrito): rode `prisma migrate resolve --rolled-back`
-- e aplique de novo.
-- SET LOCAL: vale só nesta transação.
SET LOCAL lock_timeout = '15s';

-- AlterTable
ALTER TABLE "TeamWhatsappRecipient" ADD COLUMN     "channelCheckedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "TeamWhatsappRecipient_status_updatedAt_idx" ON "TeamWhatsappRecipient"("status", "updatedAt");
