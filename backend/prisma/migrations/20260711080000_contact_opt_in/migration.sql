-- T8 (twilio-platform): opt-in comprovável (política Meta/LGPD).
--
-- A Meta exige opt-in EXPLÍCITO e comprovável antes de qualquer mensagem
-- business-initiated. O orgamind captura automaticamente:
--   - qualquer INBOUND de chat de um contato → optInAt = recebimento,
--     optInSource = 'inbound_message' (só quando optInAt ainda é null);
--   - botão de opt-in (ButtonPayload 'optin_yes') → optInSource = 'button'
--     (sobrescreve o source; seta optInAt se null);
--   - keyword VOLTAR (reversão de opt-out) → optInSource = 'keyword_voltar'.
-- NULL = nunca comprovou opt-in → campanhas TWILIO pulam o contato
-- (SKIPPED_NO_OPTIN), a menos que a campanha use override.
ALTER TABLE "Contact"
  ADD COLUMN "optInAt" TIMESTAMP(3),
  ADD COLUMN "optInSource" TEXT;
