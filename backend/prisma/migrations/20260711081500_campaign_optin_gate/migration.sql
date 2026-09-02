-- T8 (twilio-platform): gate de opt-in em campanha TWILIO.
--
-- 1. Campaign.override: persiste a flag existente do create (reconhecimento
--    de risco anti-ban pelo operador). O gate de opt-in do dispatch TWILIO a
--    consulta: campanha com override=true envia mesmo para contato sem
--    optInAt (o operador assumiu o risco); sem override, o contato é pulado.
ALTER TABLE "Campaign" ADD COLUMN "override" BOOLEAN NOT NULL DEFAULT false;

-- 2. SKIPPED_NO_OPTIN no enum MessageStatus: contabiliza destinatários
--    pulados pelo gate (linha Message terminal, sem job BullMQ) — aparece nos
--    statusCounts da campanha como os demais status.
--    Nota: ADD VALUE dentro de transação é permitido no Postgres >= 12 desde
--    que o novo valor não seja USADO na mesma transação — esta migração não
--    grava 'SKIPPED_NO_OPTIN'.
ALTER TYPE "MessageStatus" ADD VALUE IF NOT EXISTS 'SKIPPED_NO_OPTIN';
