-- ZD — espelho dos disparos (broadcasts) e do volume diário do Zernio.
--
-- ADITIVA: só cria duas tabelas novas. Não toca coluna nem tabela existente, então
-- é segura de aplicar em produção com a versão anterior do código no ar (as tabelas
-- ficam vazias até o worker novo subir e rodar o primeiro tick).
--
-- Nota de FK: o model `Channel` do Prisma tem `@@map("WhatsappInstance")` — a
-- tabela REAL se chama WhatsappInstance. Referenciar "Channel" aqui quebraria a
-- migração (foi exatamente o erro corrigido em 9a6397b).

-- CreateTable
CREATE TABLE "ZernioBroadcast" (
    "id" TEXT NOT NULL,
    "zernioId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "campaignId" TEXT,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "messagePreview" TEXT,
    "templateName" TEXT,
    "scheduledAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "recipientCount" INTEGER NOT NULL DEFAULT 0,
    "sentCount" INTEGER NOT NULL DEFAULT 0,
    "deliveredCount" INTEGER NOT NULL DEFAULT 0,
    "readCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "skippedCount" INTEGER NOT NULL DEFAULT 0,
    "zernioCreatedAt" TIMESTAMP(3),
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ZernioBroadcast_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ZernioAnalyticsSnapshot" (
    "id" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "day" TIMESTAMP(3) NOT NULL,
    "sent" INTEGER NOT NULL DEFAULT 0,
    "received" INTEGER NOT NULL DEFAULT 0,
    "read" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ZernioAnalyticsSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ZernioBroadcast_zernioId_key" ON "ZernioBroadcast"("zernioId");

-- CreateIndex
CREATE INDEX "ZernioBroadcast_channelId_zernioCreatedAt_idx" ON "ZernioBroadcast"("channelId", "zernioCreatedAt");

-- CreateIndex
CREATE INDEX "ZernioBroadcast_campaignId_idx" ON "ZernioBroadcast"("campaignId");

-- CreateIndex
CREATE INDEX "ZernioAnalyticsSnapshot_day_idx" ON "ZernioAnalyticsSnapshot"("day");

-- CreateIndex
CREATE UNIQUE INDEX "ZernioAnalyticsSnapshot_channelId_day_key" ON "ZernioAnalyticsSnapshot"("channelId", "day");

-- AddForeignKey
ALTER TABLE "ZernioBroadcast" ADD CONSTRAINT "ZernioBroadcast_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "WhatsappInstance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ZernioBroadcast" ADD CONSTRAINT "ZernioBroadcast_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ZernioAnalyticsSnapshot" ADD CONSTRAINT "ZernioAnalyticsSnapshot_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "WhatsappInstance"("id") ON DELETE CASCADE ON UPDATE CASCADE;
