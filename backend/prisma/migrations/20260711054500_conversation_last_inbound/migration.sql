-- T6 (twilio-platform): janela de 24h do WhatsApp (customer service window).
--
-- A Twilio NÃO expõe API para consultar a janela; a detecção canônica é
-- persistir o timestamp da ÚLTIMA mensagem INBOUND por conversa (o par
-- contato↔canal — Conversation é única por [instanceId, remoteJid]) e
-- comparar com now() no envio. O ingest preenche para todos os providers;
-- apenas canais TWILIO usam no guard de envio e no countdown do inbox.
ALTER TABLE "Conversation" ADD COLUMN "lastInboundAt" TIMESTAMP(3);

-- Backfill a partir do histórico já persistido: sem isso, TODA conversa
-- Twilio existente ficaria com a janela "fechada" após o deploy, mesmo com
-- um inbound de minutos atrás.
UPDATE "Conversation" c
SET "lastInboundAt" = m."maxReceivedAt"
FROM (
  SELECT "conversationId", MAX("receivedAt") AS "maxReceivedAt"
  FROM "Message"
  WHERE "direction" = 'INBOUND' AND "receivedAt" IS NOT NULL
  GROUP BY "conversationId"
) m
WHERE m."conversationId" = c."id";
