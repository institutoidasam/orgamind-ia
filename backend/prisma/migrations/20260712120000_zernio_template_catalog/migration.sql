-- ZC — catálogo de templates do Zernio. Migração ADITIVA: nenhuma coluna some,
-- nenhuma linha é reescrita, nenhum backfill é necessário.
--
-- O ponto central é a UNICIDADE do template. Até aqui, `Template.metaName` era
-- @unique GLOBAL — e isso é incompatível com a realidade do WhatsApp: o catálogo
-- de templates é POR WABA. As duas contas do cliente têm catálogos distintos, e
-- nada impede que ambas tenham um `boas_vindas` cada, com corpos e ids da Meta
-- diferentes. Com o unique global, o sync do 2º canal COLIDIRIA ou
-- SOBRESCREVERIA o template do 1º — perda silenciosa de catálogo.
--
-- Segurança nos dados existentes:
--  * derrubar um UNIQUE nunca falha por dados (só relaxa a restrição);
--  * o novo unique composto inclui `channelId`, que é NULL em TODAS as linhas
--    atuais (EVOLUTION/TWILIO/META nunca tiveram canal). No Postgres, NULLs são
--    DISTINCT num índice único (NULLS DISTINCT é o default), então nenhuma linha
--    existente pode violá-lo — a criação do índice não pode falhar.
--  * consequência aceita: templates sem canal (channelId NULL) deixam de ter
--    unicidade garantida pelo banco. Quem cria por nome (`TemplatesService.create`)
--    já checa duplicidade em código antes de inserir.

-- 1. Unicidade real: (provider, channelId, metaName, language).
DROP INDEX "Template_metaName_key";

-- 2. De qual WABA/canal veio este template. NULL = template sem canal
-- (EVOLUTION manual, catálogo da organização) — o comportamento de hoje.
ALTER TABLE "Template" ADD COLUMN "channelId" TEXT;

-- 3. O `message_template_id` da META (numérico) — a chave por onde o webhook
-- `whatsapp.template.status_updated` casa o evento com a row.
ALTER TABLE "Template" ADD COLUMN "zernioTemplateId" TEXT;

-- 4. Os components crus da Meta (HEADER/BODY/FOOTER/BUTTONS). `body` +
-- `variables[]` perdem a ESTRUTURA, e sem ela não dá para montar o array
-- posicional de `templateParams` (header de texto consome a 1ª posição, header
-- de mídia não consome nenhuma, botão URL dinâmico consome uma no fim).
ALTER TABLE "Template" ADD COLUMN "components" JSONB;

-- 5. Espelho do trio da Twilio: o enum `status` é um mapeamento COM PERDA
-- (DISABLED/PENDING_DELETION viram PAUSED); o raw preserva o diagnóstico e
-- sobrevive a qualquer status que a Meta invente amanhã.
ALTER TABLE "Template" ADD COLUMN "zernioStatusRaw" TEXT;
ALTER TABLE "Template" ADD COLUMN "zernioRejectionReason" TEXT;
ALTER TABLE "Template" ADD COLUMN "lastZernioSyncAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "Template_provider_channelId_metaName_language_key"
  ON "Template"("provider", "channelId", "metaName", "language");
CREATE INDEX "Template_zernioTemplateId_idx" ON "Template"("zernioTemplateId");

ALTER TABLE "Template"
  ADD CONSTRAINT "Template_channelId_fkey"
  FOREIGN KEY ("channelId") REFERENCES "WhatsappInstance"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- 6. O `profileId._id` da conta no Zernio (capturado de `GET /accounts`). É
-- campo OBRIGATÓRIO do `POST /broadcasts` — sem ele a campanha nativa do Zernio
-- não sai. NULL nos canais criados antes disto; o tier-sync preenche na próxima
-- rodada.
ALTER TABLE "WhatsappInstance" ADD COLUMN "zernioProfileId" TEXT;
