-- ZernioSyncRun — progresso e retomada do sync do inbox do Zernio.
--
-- ADITIVA: cria um enum e uma tabela novos. Não toca em nada existente, então é
-- segura de aplicar em produção com a versão anterior do código no ar (a tabela
-- simplesmente fica vazia até o deploy novo subir).

-- CreateEnum
CREATE TYPE "ZernioSyncRunStatus" AS ENUM ('PENDING', 'RUNNING', 'PAUSED', 'SUCCEEDED', 'FAILED');

-- CreateTable
CREATE TABLE "ZernioSyncRun" (
    "id" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "status" "ZernioSyncRunStatus" NOT NULL DEFAULT 'PENDING',
    "totalConversations" INTEGER NOT NULL DEFAULT 0,
    "processedConversations" INTEGER NOT NULL DEFAULT 0,
    "importedMessages" INTEGER NOT NULL DEFAULT 0,
    "failedConversations" INTEGER NOT NULL DEFAULT 0,
    "cursor" TEXT,
    "error" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ZernioSyncRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ZernioSyncRun_channelId_createdAt_idx" ON "ZernioSyncRun"("channelId", "createdAt");

-- AddForeignKey
ALTER TABLE "ZernioSyncRun" ADD CONSTRAINT "ZernioSyncRun_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "WhatsappInstance"("id") ON DELETE CASCADE ON UPDATE CASCADE;
