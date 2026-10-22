-- Entidade Turno (contract): apaga as colunas enum "shift" e o tipo "WorkShift".
-- Destrutiva, mas sem perda de informação: a migração 20261021100000_shift_entity
-- já copiou FIRST/SECOND para "shiftId" (shift_first/shift_second) e o nome do
-- turno para "shiftName", e nenhum código lê ou grava mais a coluna enum. Sobe no
-- mesmo deploy da 20261021100000_shift_entity (as duas aplicadas em sequência).
-- As colunas saem antes do tipo (DROP TYPE falha enquanto houver coluna usando).

-- AlterTable
ALTER TABLE "User" DROP COLUMN "shift";

-- AlterTable
ALTER TABLE "TeamWhatsappDispatch" DROP COLUMN "shift";

-- AlterTable
ALTER TABLE "TeamWhatsappRecipient" DROP COLUMN "shift";

-- DropEnum
DROP TYPE "WorkShift";
