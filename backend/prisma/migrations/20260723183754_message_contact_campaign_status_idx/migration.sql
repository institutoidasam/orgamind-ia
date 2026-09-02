-- F1 — índice do anti-join do filtro "excluir quem já recebeu": messages:{none:{campaignId:{in},status:{in}}}
-- por contato. Sem ele, o NOT EXISTS cai no @@index([contactId]) puro e filtra campanha em cima.
CREATE INDEX "Message_contactId_campaignId_status_idx" ON "Message"("contactId", "campaignId", "status");
