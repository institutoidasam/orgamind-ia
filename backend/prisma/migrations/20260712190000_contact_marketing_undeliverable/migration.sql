-- ZE — Contato INALCANÇÁVEL PARA MARKETING.
--
-- Medido ao vivo num broadcast real de 120 destinatários: 37 falhas (30% da
-- base), sendo 36x Meta 131026 ("the recipient has likely TURNED OFF MARKETING
-- MESSAGES") e 1x Meta 130472 ("marketing-message experiment ... UTILITY
-- TEMPLATES ARE NOT AFFECTED").
--
-- É estado do DESTINATÁRIO (vale para todas as campanhas), não da mensagem:
-- sem isto, cada nova campanha recomeça do zero e queima de novo os mesmos 30%
-- da cota do tier sem entregar nada.
--
-- Migração ADITIVA: colunas nullable, sem default, sem backfill. Linhas
-- existentes ficam com NULL = "alcançável (nunca falhou assim)", que é o
-- comportamento atual — nenhuma campanha muda de resultado ao aplicar isto.

ALTER TABLE "Contact" ADD COLUMN "marketingUndeliverableAt" TIMESTAMP(3);
ALTER TABLE "Contact" ADD COLUMN "marketingUndeliverableCode" TEXT;
ALTER TABLE "Contact" ADD COLUMN "marketingUndeliverableReason" TEXT;

-- Todo lote de campanha MARKETING filtra por esta coluna e a tela conta os
-- inalcançáveis da audiência.
CREATE INDEX "Contact_marketingUndeliverableAt_idx" ON "Contact"("marketingUndeliverableAt");
