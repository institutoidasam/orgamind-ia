-- C1 (twilio-platform): núcleo do consentimento por finalidade.
--
-- Substitui o modelo que FABRICAVA consentimento (qualquer inbound setava
-- Contact.optInAt) por um modelo comprovável:
--   ConsentPurpose  — finalidades (art. 8º §4º: autorização genérica é nula)
--   ConsentEvent    — histórico APPEND-ONLY, com evidência e texto por valor
--   ContactConsent  — estado denormalizado por (contato, finalidade) = o gate
--   SuppressionList — revogação DURÁVEL, desacoplada de Contact
--   ConsentText     — texto canônico versionado (o corpo é a prova)
--
-- Migração ADITIVA: nenhuma coluna existente é removida ou reescrita.
-- Contact.optInAt/optInSource/optedOut permanecem, mas viram CACHE derivado
-- escrito exclusivamente por ConsentService.record().

-- ── Enums ────────────────────────────────────────────────────────────────────
CREATE TYPE "ConsentAction" AS ENUM ('GRANT', 'REVOKE');
CREATE TYPE "ConsentState" AS ENUM ('GRANTED', 'REVOKED');
CREATE TYPE "ConsentSource" AS ENUM (
  'WA_BUTTON', 'WA_KEYWORD', 'WA_LINK', 'QR_CODE', 'CTWA_AD',
  'WEB_FORM', 'PAPER_FORM', 'MANUAL_ADMIN', 'IMPORT_LEGACY'
);

-- ── ConsentPurpose ───────────────────────────────────────────────────────────
CREATE TABLE "ConsentPurpose" (
  "key"         TEXT NOT NULL,
  "label"       TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "isSensitive" BOOLEAN NOT NULL DEFAULT false,
  "active"      BOOLEAN NOT NULL DEFAULT true,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ConsentPurpose_pkey" PRIMARY KEY ("key")
);

-- ── ConsentEvent (append-only) ───────────────────────────────────────────────
-- `contactId` NÃO tem foreign key, de propósito:
--   (a) o evento precisa sobreviver à exclusão/recriação do contato — a chave
--       durável é o phoneHash;
--   (b) uma FK ON DELETE SET NULL emitiria um UPDATE nesta tabela, que o
--       trigger append-only abaixo rejeitaria — tornando IMPOSSÍVEL apagar um
--       Contact. Regra e integridade referencial não convivem aqui.
CREATE TABLE "ConsentEvent" (
  "id"                 TEXT NOT NULL,
  "contactId"          TEXT,
  "phoneHash"          TEXT NOT NULL,
  "purposeKey"         TEXT NOT NULL,
  "action"             "ConsentAction" NOT NULL,
  "source"             "ConsentSource" NOT NULL,
  "channelId"          TEXT,
  "senderE164"         TEXT,
  "evidenceText"       TEXT NOT NULL,
  "consentTextVersion" TEXT,
  "evidence"           JSONB,
  "occurredAt"         TIMESTAMP(3) NOT NULL,
  "recordedAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "actorUserId"        TEXT,
  "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ConsentEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ConsentEvent_contactId_purposeKey_occurredAt_idx"
  ON "ConsentEvent" ("contactId", "purposeKey", "occurredAt");
CREATE INDEX "ConsentEvent_phoneHash_occurredAt_idx"
  ON "ConsentEvent" ("phoneHash", "occurredAt");
CREATE INDEX "ConsentEvent_source_occurredAt_idx"
  ON "ConsentEvent" ("source", "occurredAt");

-- Append-only DE VERDADE, não por convenção. Sem isto, "append-only" é uma
-- promessa de code review — e a trilha de consentimento é justamente a prova
-- que o controlador tem de produzir (LGPD art. 8º §2º).
--
-- Eliminação sob o art. 18, VI (pedido do titular) é uma rotina administrativa
-- auditada: `ALTER TABLE "ConsentEvent" DISABLE TRIGGER "ConsentEvent_append_only";`
-- dentro de uma migração dedicada, nunca da aplicação.
CREATE OR REPLACE FUNCTION "consent_event_append_only"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION
    'ConsentEvent e append-only: % negado (LGPD art. 8 par. 2 — a trilha de consentimento e prova).',
    TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ConsentEvent_append_only"
  BEFORE UPDATE OR DELETE ON "ConsentEvent"
  FOR EACH ROW EXECUTE FUNCTION "consent_event_append_only"();

-- ── ContactConsent (estado denormalizado — o gate rápido) ────────────────────
CREATE TABLE "ContactConsent" (
  "contactId"   TEXT NOT NULL,
  "purposeKey"  TEXT NOT NULL,
  "state"       "ConsentState" NOT NULL,
  "lastEventId" TEXT NOT NULL,
  "grantedAt"   TIMESTAMP(3),
  "revokedAt"   TIMESTAMP(3),
  "source"      "ConsentSource",
  "updatedAt"   TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ContactConsent_pkey" PRIMARY KEY ("contactId", "purposeKey")
);

CREATE INDEX "ContactConsent_purposeKey_state_idx"
  ON "ContactConsent" ("purposeKey", "state");
CREATE INDEX "ContactConsent_lastEventId_idx"
  ON "ContactConsent" ("lastEventId");

ALTER TABLE "ContactConsent"
  ADD CONSTRAINT "ContactConsent_contactId_fkey"
  FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ContactConsent"
  ADD CONSTRAINT "ContactConsent_purposeKey_fkey"
  FOREIGN KEY ("purposeKey") REFERENCES "ConsentPurpose"("key") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── SuppressionList (revogação durável, desacoplada de Contact) ──────────────
CREATE TABLE "SuppressionList" (
  "phoneHash"    TEXT NOT NULL,
  "phoneE164"    TEXT,
  "suppressedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reason"       TEXT NOT NULL,
  "scope"        TEXT NOT NULL DEFAULT 'ALL',
  "lastEventId"  TEXT,
  CONSTRAINT "SuppressionList_pkey" PRIMARY KEY ("phoneHash")
);

CREATE UNIQUE INDEX "SuppressionList_phoneE164_key" ON "SuppressionList" ("phoneE164");

-- ── ConsentText (texto canônico versionado) ──────────────────────────────────
CREATE TABLE "ConsentText" (
  "id"         TEXT NOT NULL,
  "version"    TEXT NOT NULL,
  "purposeKey" TEXT NOT NULL,
  "body"       TEXT NOT NULL,
  "activeFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ConsentText_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ConsentText_version_purposeKey_key"
  ON "ConsentText" ("version", "purposeKey");
CREATE INDEX "ConsentText_purposeKey_activeFrom_idx"
  ON "ConsentText" ("purposeKey", "activeFrom");

ALTER TABLE "ConsentText"
  ADD CONSTRAINT "ConsentText_purposeKey_fkey"
  FOREIGN KEY ("purposeKey") REFERENCES "ConsentPurpose"("key") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── Campaign: finalidade + justificativa do override ─────────────────────────
ALTER TABLE "Campaign"
  ADD COLUMN "purposeKey" TEXT,
  ADD COLUMN "overrideJustification" TEXT;

CREATE INDEX "Campaign_purposeKey_idx" ON "Campaign" ("purposeKey");

ALTER TABLE "Campaign"
  ADD CONSTRAINT "Campaign_purposeKey_fkey"
  FOREIGN KEY ("purposeKey") REFERENCES "ConsentPurpose"("key") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── MessageStatus: novos terminais do gate ───────────────────────────────────
-- SKIPPED_NO_OPTIN permanece (linhas históricas do T8); deixa de ser escrito.
-- Nota: ADD VALUE dentro de transação é permitido no Postgres >= 12 desde que o
-- novo valor não seja USADO na mesma transação — esta migração não os grava.
ALTER TYPE "MessageStatus" ADD VALUE IF NOT EXISTS 'SKIPPED_NO_CONSENT';
ALTER TYPE "MessageStatus" ADD VALUE IF NOT EXISTS 'SKIPPED_SUPPRESSED';

-- ── Dados de referência: as 5 finalidades + o texto canônico v1 ──────────────
-- Reference data vive AQUI (e não no seed.ts) porque o gate depende dela: as
-- finalidades têm de existir no instante em que a aplicação sobe, mesmo que o
-- job de seed falhe. Idempotente (ON CONFLICT DO NOTHING) — a migração roda em
-- todo deploy e um `migrate reset` local reconstrói a referência sozinho.
INSERT INTO "ConsentPurpose" ("key", "label", "description", "isSensitive", "active", "updatedAt") VALUES
  ('comunicacao_institucional', 'Notícias e avisos do IDASAM',
   'Comunicados gerais do instituto.', false, true, CURRENT_TIMESTAMP),
  ('convite_atividades', 'Convites para cursos, oficinas e eventos',
   'Inscrições, chamadas e mutirões.', false, true, CURRENT_TIMESTAMP),
  ('pesquisa_avaliacao', 'Pesquisas e avaliações',
   'Monitoramento de projeto e pesquisas de satisfação.', false, true, CURRENT_TIMESTAMP),
  ('captacao_recursos', 'Campanhas de doação e apoio',
   'Arrecadação de recursos.', false, true, CURRENT_TIMESTAMP),
  ('servico_projeto', 'Avisos operacionais do projeto em que participo',
   'Utility: data, local e mudanças das atividades do projeto.', false, true, CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO NOTHING;

-- Texto canônico v1 (spec §3.0). `{url}` é resolvido no ponto de coleta; o corpo
-- RENDERIZADO é copiado por valor para ConsentEvent.evidenceText.
--
-- A 3ª linha ("não afeta em nada seu acesso") não é enfeito: a LGPD exige
-- consentimento LIVRE (art. 5º XII) e a ANPD rejeita base legal em relação
-- assimétrica quando a parte vulnerável não tem meios efetivos de oposição.
-- Instituto ↔ beneficiário é a mesma assimetria — a frase a converte em
-- salvaguarda documentada.
--
-- LACUNA CONHECIDA (spec §9): a razão social por extenso do IDASAM não foi
-- confirmada contra o CNPJ. Confirmar antes do go-live e publicar como
-- 'optin-v2' — é correção de DADO, e a versão errada fica no histórico, como deve.
INSERT INTO "ConsentText" ("id", "version", "purposeKey", "body") VALUES
  ('ctxt_v1_comunicacao_institucional', 'optin-v1', 'comunicacao_institucional',
   E'Autorizo o IDASAM (Instituto de Desenvolvimento Agropecuário e Florestal Sustentável do Amazonas) a me enviar mensagens no WhatsApp sobre notícias e avisos do IDASAM.\nSão no máximo 2 mensagens por mês. Posso sair quando quiser respondendo PARAR.\nMinha resposta não afeta em nada meu acesso aos projetos e serviços do IDASAM.\nPolítica de privacidade: {url}'),
  ('ctxt_v1_convite_atividades', 'optin-v1', 'convite_atividades',
   E'Autorizo o IDASAM (Instituto de Desenvolvimento Agropecuário e Florestal Sustentável do Amazonas) a me enviar mensagens no WhatsApp com convites para cursos, oficinas e eventos.\nSão no máximo 2 mensagens por mês. Posso sair quando quiser respondendo PARAR.\nMinha resposta não afeta em nada meu acesso aos projetos e serviços do IDASAM.\nPolítica de privacidade: {url}'),
  ('ctxt_v1_pesquisa_avaliacao', 'optin-v1', 'pesquisa_avaliacao',
   E'Autorizo o IDASAM (Instituto de Desenvolvimento Agropecuário e Florestal Sustentável do Amazonas) a me enviar mensagens no WhatsApp sobre pesquisas e avaliações.\nSão no máximo 2 mensagens por mês. Posso sair quando quiser respondendo PARAR.\nMinha resposta não afeta em nada meu acesso aos projetos e serviços do IDASAM.\nPolítica de privacidade: {url}'),
  ('ctxt_v1_captacao_recursos', 'optin-v1', 'captacao_recursos',
   E'Autorizo o IDASAM (Instituto de Desenvolvimento Agropecuário e Florestal Sustentável do Amazonas) a me enviar mensagens no WhatsApp sobre campanhas de doação e apoio.\nSão no máximo 2 mensagens por mês. Posso sair quando quiser respondendo PARAR.\nMinha resposta não afeta em nada meu acesso aos projetos e serviços do IDASAM.\nPolítica de privacidade: {url}'),
  ('ctxt_v1_servico_projeto', 'optin-v1', 'servico_projeto',
   E'Autorizo o IDASAM (Instituto de Desenvolvimento Agropecuário e Florestal Sustentável do Amazonas) a me enviar mensagens no WhatsApp com avisos operacionais do projeto em que participo.\nPosso sair quando quiser respondendo PARAR.\nMinha resposta não afeta em nada meu acesso aos projetos e serviços do IDASAM.\nPolítica de privacidade: {url}')
ON CONFLICT ("version", "purposeKey") DO NOTHING;
