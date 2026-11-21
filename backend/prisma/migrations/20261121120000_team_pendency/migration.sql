-- Pendência da equipe (Lote K2, DK1/DK2). Só acrescenta: seis colunas nulas em
-- "TeamWhatsappRecipient" (responsável, quando assumiu, prazo, encerramento) e a
-- tabela de anotações, só de inclusão. Nenhuma linha existente muda (nem
-- "updatedAt"), nada é apagado, não há backfill e nenhum índice novo é criado em
-- "TeamWhatsappRecipient" nem em "TeamWhatsappDispatch". Sem FK nos usuários
-- ("pendencyHandlerId", "pendencyClosedById" e "authorId" sobrevivem à exclusão,
-- como "ackByUserId"). O DDL abaixo é o que o `prisma migrate diff` gera para o
-- enum "TeamPendencyNoteKind", o modelo "TeamPendencyNote" e as seis colunas
-- "pendency*" (sem DROP de deriva).

-- O ALTER TABLE e o ADD CONSTRAINT ... FOREIGN KEY abaixo travam
-- "TeamWhatsappRecipient" e entram na fila atrás de qualquer transação aberta
-- nela; sem limite o deploy ficaria pendurado. O lock_timeout limita só a espera
-- pelo bloqueio. Se estourar, a migração inteira se desfaz (nada escrito): rode
-- `prisma migrate resolve --rolled-back` e aplique de novo.
-- SET LOCAL: vale só nesta transação.
SET LOCAL lock_timeout = '15s';

-- CreateEnum
CREATE TYPE "TeamPendencyNoteKind" AS ENUM ('CONTACT', 'ASSUME', 'CLOSE', 'HANDOVER');

-- AlterTable
ALTER TABLE "TeamWhatsappRecipient" ADD COLUMN     "pendencyAssignedAt" TIMESTAMP(3),
ADD COLUMN     "pendencyCloseReason" VARCHAR(200),
ADD COLUMN     "pendencyClosedAt" TIMESTAMP(3),
ADD COLUMN     "pendencyClosedById" TEXT,
ADD COLUMN     "pendencyDueAt" TIMESTAMP(3),
ADD COLUMN     "pendencyHandlerId" TEXT;

-- CreateTable
CREATE TABLE "TeamPendencyNote" (
    "id" TEXT NOT NULL,
    "recipientId" TEXT NOT NULL,
    "kind" "TeamPendencyNoteKind" NOT NULL,
    "authorId" TEXT NOT NULL,
    "text" VARCHAR(200) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TeamPendencyNote_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TeamPendencyNote_recipientId_createdAt_idx" ON "TeamPendencyNote"("recipientId", "createdAt");

-- AddForeignKey
ALTER TABLE "TeamPendencyNote" ADD CONSTRAINT "TeamPendencyNote_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "TeamWhatsappRecipient"("id") ON DELETE CASCADE ON UPDATE CASCADE;
