-- C3 — OptInLink: os pontos de coleta wa.me/QR (spec §3.1).
--
-- Aditiva: só cria tabela nova. Nenhuma coluna existente é tocada, nenhum dado
-- é reescrito — a migração é segura em prod com a versão antiga do app no ar.
--
-- Por que `expectedText` é uma coluna, e não algo recomputado do ConsentText na
-- hora do casamento: o corpo é a PROVA (spec §2.1.3). Um cartaz impresso carrega
-- para sempre o texto que estava vigente no dia em que foi gerado; publicar o
-- `optin-v2` (por exemplo, para corrigir a razão social do IDASAM contra o CNPJ)
-- não pode fazer o QR do cartaz parar de casar. Cada link guarda o seu texto e a
-- sua versão, e cada GRANT cita ambos.
CREATE TABLE "OptInLink" (
  "id"                 TEXT NOT NULL,
  "token"              TEXT NOT NULL,
  "purposeKey"         TEXT NOT NULL,
  "consentTextVersion" TEXT NOT NULL,
  "expectedText"       TEXT NOT NULL,
  "senderDigits"       TEXT NOT NULL,
  "channelId"          TEXT,
  "description"        TEXT,
  "active"             BOOLEAN NOT NULL DEFAULT true,
  "createdById"        TEXT,
  "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"          TIMESTAMP(3) NOT NULL,

  CONSTRAINT "OptInLink_pkey" PRIMARY KEY ("id")
);

-- O token é a chave do casamento do inbound: dois cartazes com o mesmo token
-- seriam duas finalidades possíveis para a mesma mensagem, e a resolução seria
-- arbitrária. Unicidade no BANCO, não na aplicação.
CREATE UNIQUE INDEX "OptInLink_token_key" ON "OptInLink" ("token");
CREATE INDEX "OptInLink_active_createdAt_idx" ON "OptInLink" ("active", "createdAt");
CREATE INDEX "OptInLink_purposeKey_idx" ON "OptInLink" ("purposeKey");
CREATE INDEX "OptInLink_channelId_idx" ON "OptInLink" ("channelId");
CREATE INDEX "OptInLink_createdById_idx" ON "OptInLink" ("createdById");

-- RESTRICT na finalidade: um link vivo é a razão de o GRANT ter a finalidade que
-- tem — apagar a finalidade por baixo dele deixaria a trilha órfã.
ALTER TABLE "OptInLink" ADD CONSTRAINT "OptInLink_purposeKey_fkey"
  FOREIGN KEY ("purposeKey") REFERENCES "ConsentPurpose"("key") ON DELETE RESTRICT ON UPDATE CASCADE;

-- SET NULL no canal e no autor: descomissionar um número (ou desligar o usuário
-- que criou o cartaz) não pode apagar o ponto de coleta que já produziu
-- consentimentos — o funil e a evidência têm de sobreviver a ambos.
ALTER TABLE "OptInLink" ADD CONSTRAINT "OptInLink_channelId_fkey"
  FOREIGN KEY ("channelId") REFERENCES "WhatsappInstance"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "OptInLink" ADD CONSTRAINT "OptInLink_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
