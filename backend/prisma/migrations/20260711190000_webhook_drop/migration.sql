-- Aditiva: contador de webhooks AUTENTICADOS que chegaram e não puderam ser
-- processados porque nenhum canal ativo corresponde à conta/número remetente.
-- Antes disto o caso era só um logger.warn + HTTP 200 — invisível na interface,
-- e foi assim que um disparo real de ~100 mensagens foi perdido em silêncio.
CREATE TABLE "WebhookDrop" (
    "id" TEXT NOT NULL,
    "provider" "ChannelProvider" NOT NULL,
    "accountRef" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 1,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookDrop_pkey" PRIMARY KEY ("id")
);

-- Um contador por (provedor, conta, evento) — o upsert do WebhookDropsService
-- depende deste índice único.
CREATE UNIQUE INDEX "WebhookDrop_provider_accountRef_event_key" ON "WebhookDrop"("provider", "accountRef", "event");

CREATE INDEX "WebhookDrop_lastSeenAt_idx" ON "WebhookDrop"("lastSeenAt");
