-- Tabelas do lote de importação de pessoas e das linhas lidas (Lote E, EX5).
-- Só cria quatro enums e duas tabelas novas; nenhuma tabela existente é
-- alterada, nenhum dado é apagado ou movido. O DDL abaixo é o que o
-- `prisma migrate diff` gera para os modelos `PeopleImportBatch` e
-- `PeopleImportRow` (sem o DROP da quarentena
-- `_message_dup_neutralized_20260819`, que o drift do CI tolera).
--
-- Sem `SET LOCAL lock_timeout`: nada aqui toca tabela existente (a única FK
-- liga a tabela nova a outra tabela nova), então não há fila de lock a esperar.
--
-- Ids de pessoa e de quem agiu (`createdById`, `confirmedById`, `closedById`,
-- `personId`) ficam sem FK, como "UserAssignment"."recordedById": apagar uma
-- pessoa nunca trava nem apaga o registro do lote. `cells` é jsonb
-- ({ "<índice da coluna>": "texto" }) para a limpeza tirar colunas com
-- `cells - ARRAY[...]::text[]` num UPDATE só.

-- CreateEnum
CREATE TYPE "PeopleImportStatus" AS ENUM ('PREVIEW', 'WRITING', 'COMPLETED', 'CLOSED');

-- CreateEnum
CREATE TYPE "PeopleImportRowClass" AS ENUM ('CREATE', 'UPDATE', 'UNCHANGED', 'INVALID', 'DUPLICATE', 'CONFLICT', 'IGNORED');

-- CreateEnum
CREATE TYPE "PeopleImportWriteState" AS ENUM ('PENDING', 'RESERVED', 'DONE');

-- CreateEnum
CREATE TYPE "PeopleImportOutcome" AS ENUM ('CREATED', 'UPDATED', 'UNCHANGED', 'FAILED', 'NOT_WRITTEN');

-- CreateTable
CREATE TABLE "PeopleImportBatch" (
    "id" TEXT NOT NULL,
    "fileName" VARCHAR(255) NOT NULL,
    "fileSize" INTEGER NOT NULL,
    "fileSha256" CHAR(64) NOT NULL,
    "format" VARCHAR(4) NOT NULL,
    "headers" JSONB NOT NULL,
    "mapping" JSONB NOT NULL,
    "previewCounts" JSONB,
    "status" "PeopleImportStatus" NOT NULL DEFAULT 'PREVIEW',
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedById" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "lastBlockAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "closedById" TEXT,
    "result" JSONB,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PeopleImportBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PeopleImportRow" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "rowNumber" INTEGER NOT NULL,
    "cells" JSONB,
    "classification" "PeopleImportRowClass",
    "reasons" JSONB NOT NULL DEFAULT '[]',
    "warnings" JSONB NOT NULL DEFAULT '[]',
    "preview" JSONB,
    "plan" JSONB,
    "personId" TEXT,
    "writeState" "PeopleImportWriteState",
    "reservedUntil" TIMESTAMP(3),
    "reservationToken" VARCHAR(36),
    "outcome" "PeopleImportOutcome",
    "outcomeReason" VARCHAR(200),
    "writtenAt" TIMESTAMP(3),

    CONSTRAINT "PeopleImportRow_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PeopleImportBatch_createdById_createdAt_idx" ON "PeopleImportBatch"("createdById", "createdAt");

-- CreateIndex
CREATE INDEX "PeopleImportBatch_status_createdAt_idx" ON "PeopleImportBatch"("status", "createdAt");

-- CreateIndex
CREATE INDEX "PeopleImportRow_batchId_classification_rowNumber_idx" ON "PeopleImportRow"("batchId", "classification", "rowNumber");

-- CreateIndex
CREATE INDEX "PeopleImportRow_batchId_writeState_rowNumber_idx" ON "PeopleImportRow"("batchId", "writeState", "rowNumber");

-- CreateIndex
CREATE UNIQUE INDEX "PeopleImportRow_batchId_rowNumber_key" ON "PeopleImportRow"("batchId", "rowNumber");

-- AddForeignKey
ALTER TABLE "PeopleImportRow" ADD CONSTRAINT "PeopleImportRow_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "PeopleImportBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
