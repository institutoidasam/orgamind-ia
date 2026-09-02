-- ZE — CAMPANHA RETOMÁVEL EM LOTES.
--
-- Pedido do cliente: "Quero enviar 50 agora. Depois, naquela mesma campanha,
-- enviar para mais 100 — só que eu não vou ter a dor de cabeça de saber pra
-- quem eu não enviei; o sistema só vai me listar quem eu ainda não enviei."
--
-- CampaignBatch é o HISTÓRICO de cada execução (quando, quantos pedidos,
-- quantos enfileirados, quantos o gate pulou). O RESULTADO de um lote sai das
-- Messages que ele gerou (Message.campaignBatchId) — não de contadores
-- duplicados que poderiam divergir da verdade.
--
-- Migração ADITIVA: tabela nova + coluna nullable na Message. Campanhas
-- existentes seguem com zero lotes e Message.campaignBatchId = NULL; nada muda
-- de comportamento até alguém disparar um lote.

CREATE TABLE "CampaignBatch" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "requested" INTEGER NOT NULL,
    "queued" INTEGER NOT NULL DEFAULT 0,
    "skipped" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "createdByUserId" TEXT,

    CONSTRAINT "CampaignBatch_pkey" PRIMARY KEY ("id")
);

-- O seq é atribuído sob o lock 'resend' da campanha; este unique é a garantia
-- no banco de que dois lotes concorrentes nunca compartilham o mesmo número.
CREATE UNIQUE INDEX "CampaignBatch_campaignId_seq_key" ON "CampaignBatch"("campaignId", "seq");
CREATE INDEX "CampaignBatch_campaignId_idx" ON "CampaignBatch"("campaignId");

ALTER TABLE "CampaignBatch" ADD CONSTRAINT "CampaignBatch_campaignId_fkey"
    FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Qual lote gerou esta mensagem. NULL = mensagem anterior ao ZE, ou não vinda
-- de um lote (retry avulso, redispatch, mensagem de chat).
ALTER TABLE "Message" ADD COLUMN "campaignBatchId" TEXT;

CREATE INDEX "Message_campaignBatchId_idx" ON "Message"("campaignBatchId");

-- SET NULL (e não CASCADE): apagar o registro de um lote NUNCA pode apagar as
-- mensagens que ele enviou de verdade.
ALTER TABLE "Message" ADD CONSTRAINT "Message_campaignBatchId_fkey"
    FOREIGN KEY ("campaignBatchId") REFERENCES "CampaignBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;
