-- Situação e histórico da conversa (Lote K1, DK1). Só acrescenta: uma coluna nula
-- em "Conversation" (marca de resolução) e a tabela de histórico, só de inclusão.
-- Nenhuma linha existente muda, nada é apagado, não há backfill e nenhum índice
-- novo é criado em "Conversation". O DDL abaixo é o que o `prisma migrate diff`
-- gera para os modelos `ConversationHistoryAction` e `ConversationHistoryEntry` e
-- para `Conversation.resolvedAt` (sem o DROP da quarentena
-- `_message_dup_neutralized_20260819`, que o drift do CI tolera).

-- O ALTER TABLE e o ADD CONSTRAINT ... FOREIGN KEY abaixo travam "Conversation" e
-- entram na fila atrás de qualquer transação aberta nela; sem limite o deploy
-- ficaria pendurado. O lock_timeout limita só a espera pelo bloqueio, não a
-- construção de índice: por isso nenhum índice entra em "Conversation" (e
-- CREATE INDEX CONCURRENTLY não roda dentro do SET LOCAL). Se estourar, a
-- migração inteira se desfaz (nada escrito): rode
-- `prisma migrate resolve --rolled-back` e aplique de novo.
-- SET LOCAL: vale só nesta transação.
SET LOCAL lock_timeout = '15s';

-- CreateEnum
CREATE TYPE "ConversationHistoryAction" AS ENUM ('ASSUMED', 'ASSUMED_ON_REPLY', 'TRANSFERRED', 'UNASSIGNED', 'RESOLVED', 'REOPENED', 'SHIFT_HANDOVER');

-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "resolvedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "ConversationHistoryEntry" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "action" "ConversationHistoryAction" NOT NULL,
    "actorId" TEXT,
    "fromUserId" TEXT,
    "toUserId" TEXT,
    "note" VARCHAR(200),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConversationHistoryEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ConversationHistoryEntry_conversationId_createdAt_idx" ON "ConversationHistoryEntry"("conversationId", "createdAt");

-- AddForeignKey
ALTER TABLE "ConversationHistoryEntry" ADD CONSTRAINT "ConversationHistoryEntry_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
