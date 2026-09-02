-- C5 — coortes de procedência da base (spec §6.2) + última interação real.
--
-- ADITIVA: só cria um enum novo e adiciona 4 colunas NULLABLE a Contact. Nenhuma
-- linha é reescrita, nenhum default é backfillado — a migração é segura em prod
-- com a versão antiga do app no ar (ela simplesmente ignora as colunas).
--
-- `sourceOrigin` NULL = "ainda não classificado", e é um estado legítimo, não um
-- erro: a classificação é um passo AUDITADO que roda por comando/serviço
-- (SourceOriginService) e reescreve a coluna a partir dos sinais que já existem
-- no banco. Nunca é entrada manual do operador — se fosse, a coorte viraria
-- opinião, e o §6 existe justamente para substituir opinião por prova.
CREATE TYPE "ContactSourceOrigin" AS ENUM (
  'INTERAGIU',
  'DOCUMENTADA_COM_DECLARACAO',
  'DOCUMENTADA_SEM_DECLARACAO',
  'DESCONHECIDA',
  'INVALIDO_NAO_WHATSAPP'
);

ALTER TABLE "Contact" ADD COLUMN "sourceOrigin"      "ContactSourceOrigin";
ALTER TABLE "Contact" ADD COLUMN "sourceOriginNote"  TEXT;
ALTER TABLE "Contact" ADD COLUMN "sourceOriginAt"    TIMESTAMP(3);
ALTER TABLE "Contact" ADD COLUMN "lastInteractionAt" TIMESTAMP(3);

-- O painel de opt-in (§7) conta a base POR COORTE a cada carregamento, e a
-- pergunta que ele responde ("quanto da base está inutilizável") é um filtro por
-- esta coluna sobre 13k linhas.
CREATE INDEX "Contact_sourceOrigin_idx" ON "Contact" ("sourceOrigin");
