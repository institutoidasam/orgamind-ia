-- Finalidade e público do envio à equipe (Lote F, CF8/DF1).
-- Migração só aditiva: cria três enums e nove colunas nulas em
-- "TeamWhatsappDispatch". Nenhuma linha existente é alterada, nenhuma coluna ou
-- valor é removido ou movido; envio criado antes desta versão fica com tudo
-- nulo (null = envio antigo). O DDL abaixo é o que o `prisma migrate diff`
-- gera para os campos novos de `TeamWhatsappDispatch`. "schedulePolicy" fica sem
-- uso no Lote F (o G passa a escrevê-la).
--
-- O ADD COLUMN pega ACCESS EXCLUSIVE em "TeamWhatsappDispatch" e espera as
-- transações abertas nela (leitura ou escrita). O lock em si é curto: coluna
-- nula, sem default, só troca o catálogo e não reescreve a tabela. O timeout
-- evita que o deploy fique em fila atrás de uma transação longa (e, atrás do
-- lock pendente, bloqueie as demais consultas da tabela). Se estourar, a
-- migração inteira se desfaz (nada escrito): rode
-- `prisma migrate resolve --rolled-back` e aplique de novo.
-- SET LOCAL: vale só nesta transação.
SET LOCAL lock_timeout = '15s';

-- CreateEnum
CREATE TYPE "TeamDispatchPurpose" AS ENUM ('SHIFT_NOTICE', 'MEETING', 'ALIGNMENT', 'LECTURE', 'OVERTIME', 'URGENCY');

-- CreateEnum
CREATE TYPE "TeamAudienceBase" AS ENUM ('ON_DUTY', 'ASSIGNED');

-- CreateEnum
CREATE TYPE "TeamSchedulePolicy" AS ENUM ('IMMEDIATE', 'FROZEN_RECHECK');

-- AlterTable
ALTER TABLE "TeamWhatsappDispatch" ADD COLUMN     "activityDate" DATE,
ADD COLUMN     "activityPlace" TEXT,
ADD COLUMN     "activityTime" TEXT,
ADD COLUMN     "audienceBase" "TeamAudienceBase",
ADD COLUMN     "audienceExcluded" JSONB,
ADD COLUMN     "audienceRule" JSONB,
ADD COLUMN     "purpose" "TeamDispatchPurpose",
ADD COLUMN     "schedulePolicy" "TeamSchedulePolicy",
ADD COLUMN     "urgencyReason" TEXT;
