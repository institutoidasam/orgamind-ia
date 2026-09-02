-- T2 (twilio-platform): sync do catálogo de templates da Twilio Content API.
--
-- 1. `PAUSED` no enum TemplateStatus — a Meta pode pausar (feedback negativo)
--    ou desabilitar um template aprovado; ambos mapeiam para PAUSED no orgamind
--    (paused|disabled → PAUSED) e ficam FORA do gate de campanha (que só
--    aceita APPROVED).
--    Nota: ADD VALUE dentro de transação é permitido no Postgres >= 12 desde
--    que o novo valor não seja USADO na mesma transação — esta migração só
--    adiciona colunas, não grava 'PAUSED'.
ALTER TYPE "TemplateStatus" ADD VALUE IF NOT EXISTS 'PAUSED';

-- 2. Campos de sincronização com a Twilio (job template-approval-sync):
--    - twilioApprovalStatus: status BRUTO reportado pela Twilio (received,
--      pending, approved, rejected, paused, disabled, in_appeal, ...) — o
--      enum local é um mapeamento com perda; o raw preserva o diagnóstico.
--    - twilioRejectionReason: rejection_reason da Meta (genérico, mas útil).
--    - lastTwilioSyncAt: quando o sync tocou a row pela última vez (a UI
--      mostra "sincronizado há X min").
ALTER TABLE "Template"
  ADD COLUMN "twilioApprovalStatus" TEXT,
  ADD COLUMN "twilioRejectionReason" TEXT,
  ADD COLUMN "lastTwilioSyncAt" TIMESTAMP(3);
