-- ★ UMA LINHA VIVA POR (CAMPANHA, CONTATO) — a invariante no BANCO.
--
-- Tudo o que impede uma pessoa de receber a mesma campanha duas vezes morava em
-- código: o recorte da audiência, o gate, a rede do mesmo template, o claim
-- atômico. A auditoria de 2026-08-19 mostrou cinco caminhos que furavam esse
-- conjunto e criavam uma SEGUNDA `Message` para o mesmo par (campanha, contato)
-- — e o banco aceitava todas. Este índice faz a duplicata virar ERRO DE BANCO
-- em vez de propaganda eleitoral entregue duas vezes.
--
-- ── POR QUE PARCIAL, E NÃO UM @@unique NORMAL ────────────────────────────────
-- Um único global sobre (campaignId, contactId) proibiria coisas que o produto
-- faz DE PROPÓSITO:
--   • o lote seguinte recria a linha de quem teve falha TRANSITÓRIA (é o coração
--     da retomada: "repita o lote sem caçar quem faltou");
--   • os SKIPPED_* e os CANCELLED são histórico, e o mesmo contato pode ter um
--     pulo antigo e um envio novo;
--   • e — decisivo — a LIMPEZA desta migration precisa NEUTRALIZAR as duplicatas
--     de produção sem APAGAR nenhuma (a mensagem é prova de entrega). Uma linha
--     neutralizada continua ocupando o par num único global.
-- O predicado abaixo cobre exatamente os estados em que uma segunda linha vira
-- uma segunda ENTREGA: em voo (QUEUED/WAITING_INSTANCE/SENDING) ou já no
-- provedor (SENT/DELIVERED/READ). É o mesmo conjunto que
-- `REACHED_OR_IN_FLIGHT_STATUSES` (batch-audience.ts) usa no código.
--
-- `campaignId` e `contactId` são NULLABLE e o índice os exige NOT NULL: mensagem
-- de CHAT (campaignId NULL) não é afetada de forma alguma — nem pelo predicado,
-- nem pela regra de NULLs distintos do Postgres.
--
-- Prisma não modela índice único PARCIAL, então ele vive só aqui — mesmo padrão
-- (e mesmo motivo) de "WhatsappInstance_provider_default_key", em
-- 20260709120000_multi_provider_channel.

-- ── PASSO 0: CONGELAR A TABELA ──────────────────────────────────────────────
-- SEM ISTO A MIGRATION NÃO SOBREVIVE AO CÓDIGO VELHO.
--
-- `prisma migrate deploy` roda o arquivo inteiro numa transação, mas em READ
-- COMMITTED cada comando tira um SNAPSHOT NOVO. O PASSO 1 limpa as duplicatas
-- que existiam no instante em que ELE rodou; o PASSO 2 enxerga o banco de novo.
-- Qualquer linha viva criada e COMMITADA nesse intervalo entra no CREATE INDEX e
-- o derruba com 23505 — e quem cria essa linha é justamente a api/worker VELHOS,
-- que o docker-compose mantém de pé até o serviço `migrate` terminar (é o defeito
-- que este índice vem fechar). Reproduzido de forma determinística.
--
-- O estrago de uma corrida de milissegundos não é só "a migration falhou": a
-- linha fica em `_prisma_migrations` com `finished_at IS NULL` e TODO deploy
-- seguinte recusa rodar com P3009, até alguém intervir na mão no banco de
-- produção — num cliente que é campanha eleitoral em disparo.
--
-- A trava explícita torna PASSO 1 e PASSO 2 atômicos POR CONSTRUÇÃO, em vez de
-- depender de um humano lembrar de parar api e worker antes de todo deploy.
-- EXCLUSIVE e não SHARE por dois motivos: (a) SHARE é compatível consigo mesmo,
-- então dois processos poderiam segurá-lo e se travar mutuamente ao tentar
-- escrever (o UPDATE do PASSO 1 precisa de ROW EXCLUSIVE); EXCLUSIVE serializa e
-- não tem esse deadlock. (b) O custo é o MESMO que já se paga: o CREATE INDEX do
-- PASSO 2 já pega SHARE e já bloqueia toda escrita na tabela; antecipar a trava
-- só estende esse bloqueio pelo tempo do UPDATE do PASSO 1 (medido: 0,5 s a 280
-- mil linhas, 5,3 s a 3 milhões). SELECT continua passando: EXCLUSIVE só não
-- convive com ACCESS EXCLUSIVE.
--
-- `lock_timeout` porque a trava ENTRA NA FILA atrás de qualquer escritor em
-- andamento e, enquanto espera, todo escritor novo enfileira atrás dela. Sem
-- limite, um `psql` esquecido aberto congela a tabela mais quente do banco por
-- tempo indeterminado. Falhar em 15 s é limpo (rollback total, nada escrito) e o
-- destravamento está no OPERATIONS.md ("Migration falhou / P3009").
-- SET LOCAL: vale só nesta transação.
SET LOCAL lock_timeout = '15s';
LOCK TABLE "Message" IN EXCLUSIVE MODE;

-- ── PASSO 0.5: A REDE DE SEGURANÇA DA LIMPEZA ───────────────────────────────
-- O PASSO 1 promete que "nada é apagado" — e é verdade para sentAt/deliveredAt/
-- providerMessageId. Mas o `status` ANTERIOR não sobrevive ao UPDATE, e depois do
-- fato QUEUED e WAITING_INSTANCE são INDISTINGUÍVEIS (os dois só têm queuedAt).
-- O `errorCode`/`errorMessage` também são sobrescritos — e o F2 preserva esses
-- dois de propósito numa linha que voltou para QUEUED, como prova da tentativa
-- anterior ("zernio.timeout" etc.).
--
-- Esta tabela custa quatro colunas por linha neutralizada e transforma
-- "irreversível" em `UPDATE "Message" m SET status = b.status::"MessageStatus",
-- "errorCode" = b."errorCode", "errorMessage" = b."errorMessage"
-- FROM "_message_dup_neutralized_20260819" b WHERE m.id = b.id;`.
-- O script de fusão de contatos grava aqui também, com source='merge'.
CREATE TABLE IF NOT EXISTS "_message_dup_neutralized_20260819" (
  "id"            TEXT PRIMARY KEY,
  "status"        TEXT NOT NULL,
  "errorCode"     TEXT,
  "errorMessage"  TEXT,
  "neutralizedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "source"        TEXT NOT NULL DEFAULT 'migration'
);

-- ── PASSO 1: LIMPAR ANTES DE TRAVAR ─────────────────────────────────────────
-- A base de PRODUÇÃO JÁ TEM duplicatas — é o que a auditoria provou. Sem esta
-- limpeza o CREATE UNIQUE INDEX estoura, a migration falha e, como o deploy roda
-- `migrate deploy` na subida (docker-compose.prod.yml), a aplicação não sobe.
--
-- Sobrevive a linha MAIS AVANÇADA no funil (READ > DELIVERED > SENT > SENDING >
-- QUEUED > WAITING_INSTANCE), desempatando pela MAIS ANTIGA — a que de fato
-- carrega a entrega. As outras viram CANCELLED com um errorCode que diz o
-- motivo: nada é apagado, e `sentAt`/`deliveredAt`/`providerMessageId` ficam
-- intactos como prova do que aconteceu.
WITH ranked AS (
  SELECT
    "id",
    row_number() OVER (
      PARTITION BY "campaignId", "contactId"
      ORDER BY
        CASE "status"
          WHEN 'READ' THEN 1
          WHEN 'DELIVERED' THEN 2
          WHEN 'SENT' THEN 3
          WHEN 'SENDING' THEN 4
          WHEN 'QUEUED' THEN 5
          WHEN 'WAITING_INSTANCE' THEN 6
          ELSE 7
        END,
        "createdAt" ASC,
        "id" ASC
    ) AS rn
  FROM "Message"
  WHERE "campaignId" IS NOT NULL
    AND "contactId" IS NOT NULL
    AND "direction" = 'OUTBOUND'
    AND "status" IN ('QUEUED', 'WAITING_INSTANCE', 'SENDING', 'SENT', 'DELIVERED', 'READ')
)
-- Guardar o ANTES. Idempotente (PK + DO NOTHING) e, por ser a fonte da lista de
-- ids, garante que backup e UPDATE tratem EXATAMENTE as mesmas linhas.
INSERT INTO "_message_dup_neutralized_20260819"
  ("id", "status", "errorCode", "errorMessage", "source")
SELECT m."id", m."status"::text, m."errorCode", m."errorMessage", 'migration'
FROM "Message" AS m
JOIN ranked AS r ON r."id" = m."id"
WHERE r.rn > 1
ON CONFLICT ("id") DO NOTHING;

UPDATE "Message" AS m
SET
  "status" = 'CANCELLED',
  "errorCode" = 'duplicate_row_neutralized',
  "errorMessage" = 'Linha duplicada do mesmo contato nesta campanha, neutralizada em 2026-08-19 para permitir a trava de banco "uma linha viva por (campanha, contato)". A linha que sobreviveu é a mais avançada no funil. Nada foi apagado: sentAt/deliveredAt/providerMessageId desta linha continuam aqui como prova do que aconteceu, e o status/errorCode/errorMessage ANTERIORES estão em "_message_dup_neutralized_20260819" (source=''migration'').'
FROM "_message_dup_neutralized_20260819" AS b
WHERE m."id" = b."id"
  AND b."source" = 'migration';

-- ── PASSO 2: TRAVAR ─────────────────────────────────────────────────────────
-- Sem CONCURRENTLY de propósito: `prisma migrate deploy` roda cada migration
-- numa transação, e CREATE INDEX CONCURRENTLY não pode rodar em transação —
-- forçá-lo deixaria índices INVÁLIDOS numa falha. O índice é sobre um subconjunto
-- pequeno da tabela (só os estados vivos) e o bloqueio de escrita dura segundos.
CREATE UNIQUE INDEX "Message_campaign_contact_live_key"
  ON "Message" ("campaignId", "contactId")
  WHERE "campaignId" IS NOT NULL
    AND "contactId" IS NOT NULL
    AND "direction" = 'OUTBOUND'
    AND "status" IN ('QUEUED', 'WAITING_INSTANCE', 'SENDING', 'SENT', 'DELIVERED', 'READ');
