-- Aditiva: qualidade do número na Meta (GREEN | YELLOW | RED | FLAGGED |
-- UNKNOWN), lida pelo tier-sync do provedor (zernio-tier-sync / twilio-tier-sync).
-- Guardamos o ESTADO ANTERIOR porque o que importa não é o valor e sim a
-- TRANSIÇÃO: sair de GREEN é o sinal de que a conta caminha para a restrição, e
-- é ele que pausa as campanhas do canal. NULL = nunca lido.
ALTER TABLE "WhatsappInstance" ADD COLUMN "qualityRating" TEXT;
