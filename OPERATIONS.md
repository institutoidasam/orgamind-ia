# Operations Manual

## Quick start (production VPS)

```bash
git clone <repo>
cd orgamind
cp .env.example .env
# Edit .env: set DOMAIN, ACME_EMAIL, JWT_SECRET, EVOLUTION_*, BULL_BOARD_*
docker compose up -d --build
# Caddy obtains TLS cert automatically; first start may take ~30s
```

## Daily monitoring

- **Logs**: `docker compose logs -f api worker webhook`
- **Bull Board**: `https://<domain>/admin/queues` (basic auth)
- **Health**: `https://<domain>/health/ready` (200 = OK)
- **API docs (Scalar)**: `https://<domain>/docs`
- **Backups**: `docker compose run --rm backup ls -la /backups/daily`

## Common tasks

### Apply pending migrations

Migrations run automatically via the `migrate` compose service (gates `api` and `worker` startup). To force a re-run:

```bash
docker compose run --rm migrate
```

### Manual webhook replay

If you suspect an Evolution webhook was missed, re-process the original payload (saved in Sentry/logs) by re-POSTing it to `/webhooks/whatsapp` with the `apikey` header set to `EVOLUTION_API_KEY` (the same header the worker arms on the instance; see "Evolution: versão fixa e troca de versão"). A wrong key is rejected and audited as `webhook.apikey_invalid`.

### Clear stuck BullMQ jobs

Open Bull Board, navigate to the queue, retry/discard via UI. Or programmatically via a one-off node script inside the api container that imports `bullmq` and calls `q.drain()` on the queue (e.g. `whatsapp.send-message`).

### Recover from a bad migration

```bash
# 1. Stop api + worker
docker compose stop api worker

# 2. Restore latest backup
docker compose run --rm backup ls /backups/daily            # find filename
docker compose exec -T postgres pg_restore -U $POSTGRES_USER -d $POSTGRES_DB --clean --if-exists < /var/lib/docker/volumes/picoa_pg_backups/_data/daily/<latest>

# 3. Roll back the bad migration in code (revert commit, redeploy)
git revert <bad-migration-commit>
docker compose up -d --build
```

### Rotate JWT secret

```bash
# Generate new secret
openssl rand -hex 32

# Update .env, restart
docker compose restart api worker
# All current sessions are invalidated; users must re-login
```

### Rotate Meta token

Desligado em 2026-11; código inativo no repositório.

### Webhook do GoZap: tirar o segredo da URL

Desligado em 2026-11; código inativo no repositório. O webhook do GoZap responde 404 e nenhuma env dele é encaminhada ao contêiner. A `location /api/webhooks/` do `frontend/nginx.conf` continua, porque também serve o `POST /webhooks/whatsapp` da Evolution.

### Scale workers

```bash
docker compose up -d --scale worker=3
```

Each worker independently consumes from the BullMQ queue; jobs are distributed.

### Debug a specific message

Open a node shell inside the api container and query Prisma:

```bash
docker compose exec api node -e "
  const { PrismaClient } = require('@prisma/client');
  const p = new PrismaClient();
  p.message.findMany({
    where: { contact: { phoneE164: '+5592987654321' } },
    orderBy: { queuedAt: 'desc' },
    take: 10,
    include: { campaign: { select: { name: true } } }
  }).then(console.log).finally(() => p.\$disconnect());
"
```

## Dify console API (listagem de apps)

O orgamind autentica na **console API do Dify** para listar os apps de chat disponíveis e buscar (ou gerar) a chave `app-…` de cada app. Isso permite que a UI mostre uma lista viva de apps ao configurar cada número, sem precisar cadastrar bots manualmente.

### Variáveis de ambiente (serviço `api` apenas)

| Variável | Valor esperado |
|---|---|
| `DIFY_CONSOLE_URL` | URL base da console API, **incluindo o sufixo `/console/api`** — ex.: `https://dify.example.com/console/api` |
| `DIFY_CONSOLE_EMAIL` | E-mail da conta admin/owner do workspace que contém os apps |
| `DIFY_CONSOLE_PASSWORD` | Senha da conta (texto puro — o client a converte para Base64 antes de enviar ao Dify) |

Todas as três são opcionais. Sem elas, o endpoint `GET /bots/dify-apps` devolve `503 Service Unavailable`; o restante do sistema (respostas automáticas) continua funcionando via `DIFY_BASE_URL` + chave já gravada no banco.

O worker **não** precisa de `DIFY_CONSOLE_*`.

### Segurança e dívida conhecida

- A senha é convertida para Base64 pelo `DifyConsoleClient` (requisito do Dify — senha em texto puro devolve 401 `"Invalid encrypted data"`).
- Os tokens da console (HttpOnly cookies + CSRF) são mantidos em memória no processo da API e nunca persistidos.
- As chaves `app-…` obtidas via console são gravadas em **texto puro** no banco de dados (coluna `Bot.difyApiKey`). Isso é uma dívida conhecida — criptografia em repouso está no backlog.

### Configurar no Dokploy

No painel do Dokploy, na aba **Environment** do serviço `api`, adicione:

```
DIFY_CONSOLE_URL=https://seu-dify.example.com/console/api
DIFY_CONSOLE_EMAIL=admin@example.com
DIFY_CONSOLE_PASSWORD=sua_senha_aqui
```

## Chatbot (Dify) diagnostics

### Inspect the bot.reply queue

Bot auto-replies are processed by the `bot.reply` BullMQ queue. Monitor it from Bull Board:

```
https://<domain>/admin/queues
```

Look for the `bot.reply` queue. Stuck or failed jobs appear there and can be retried or discarded via the UI.

### Audit failures

Every bot reply failure is recorded as a `bot.reply_failed` audit event. Query the audit log in Postgres:

```sql
SELECT * FROM "AuditEvent"
WHERE event = 'bot.reply_failed'
ORDER BY "createdAt" DESC
LIMIT 50;
```

When a failure is recorded, the bot is **automatically paused** for that conversation to prevent looping. Resolve the root cause (bad Dify API key, `DIFY_BASE_URL` unreachable, model quota exceeded, etc.), then re-enable the bot from the inbox ("Reativar bot").

### Common failure causes

| Symptom | Likely cause |
|---|---|
| `bot.reply_failed` events with 401 | Wrong/rotated Dify app API key — re-pick the bot in the per-number bot selector (connection drawer) to re-sync the key, and edit the app itself in the Dify console. |
| `bot.reply_failed` events with network error | `DIFY_BASE_URL` is wrong or Dify app is down — verify `https://<dify-host>/v1/health`. |
| No replies and queue is empty | The number's channel isn't an EVOLUTION provider (bots only work on Evolution channels), or no bot is assigned to the number. |
| Bot replies then goes silent | Handoff triggered (operator replied or conversation was assigned) — click **Reativar bot** in the inbox. |

### Bot handoff behaviour

The bot auto-pauses for a conversation when an operator sends a manual reply or the conversation is assigned to an agent. This is intentional — it prevents the bot from interrupting a human conversation. Resume auto-reply by clicking **Reativar bot** in the inbox thread.

## Subida da trava "uma linha viva por (campanha, contato)" (migration 20260819010000)

Este deploy é diferente dos outros: ele cria um **índice único parcial** em `Message`
que passa a proibir, no BANCO, uma segunda linha viva do mesmo par (campanha, contato)
— e, no mesmo job, roda o **reparo de contatos duplicados**, que APAGA linha de
`Contact`. Os dois já foram feitos para conviver (a fusão neutraliza a colisão com a
mesma régua da migration, e a migration trava a tabela para não ser atropelada pelo
código velho), mas a subida ainda é a hora de olhar antes de pisar.

**Regra dura deste projeto: `/health` é servido pelo nginx e NÃO PROVA NADA.** Toda
verificação abaixo ATRAVESSA o proxy até a aplicação.

### PASSO 0 — snapshot do Postgres

```bash
docker compose run --rm backup ls -la /backups/daily   # confirme que há um backup de HOJE
```
Se o mais recente não for de hoje, tire um snapshot do volume do Postgres pelo painel
do Dokploy antes de seguir.
O `UPDATE` do PASSO 1 da migration não tem volta automática (a tabela de socorro
descrita abaixo cobre `Message`, não o resto). Sem snapshot não há rollback de dado.

### PASSO 1 — sondar o tamanho do estrago ANTES de escrever

No painel do Dokploy, serviço `postgres` → **Open Terminal** →
`psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"`.

```sql
-- (a) quantas linhas a migration vai NEUTRALIZAR (duplicatas do MESMO contato)
SELECT count(*) FROM (
  SELECT row_number() OVER (PARTITION BY "campaignId","contactId"
                            ORDER BY "createdAt") AS rn
  FROM "Message"
  WHERE "campaignId" IS NOT NULL AND "contactId" IS NOT NULL
    AND direction='OUTBOUND'
    AND status IN ('QUEUED','WAITING_INSTANCE','SENDING','SENT','DELIVERED','READ')
) x WHERE rn > 1;

-- (b) quantos pares de GÊMEOS do 9º dígito colidem na mesma campanha
--     (é o caso que fazia o reparo explodir antes desta correção; agora ele
--     neutraliza sozinho, mas o número diz quantas linhas vão virar CANCELLED)
WITH pares AS (
  SELECT a.id nine_id, b.id eight_id
  FROM "Contact" a JOIN "Contact" b
    ON b."phoneE164" = '+55' || substring(a."phoneE164" from 4 for 2)
                             || substring(a."phoneE164" from 7)
  WHERE a."phoneE164" ~ '^\+55[0-9]{2}9[6-9][0-9]{7}$'
), vivas AS (
  SELECT p.nine_id, p.eight_id, m."campaignId", m."contactId"
  FROM pares p JOIN "Message" m ON m."contactId" IN (p.nine_id, p.eight_id)
  WHERE m.direction='OUTBOUND' AND m."campaignId" IS NOT NULL
    AND m.status IN ('QUEUED','WAITING_INSTANCE','SENDING','SENT','DELIVERED','READ')
)
SELECT count(*) FROM (
  SELECT nine_id, eight_id, "campaignId"
  FROM vivas GROUP BY 1,2,3 HAVING count(DISTINCT "contactId") > 1
) y;

-- (c) tamanho da tabela, para estimar o bloqueio de escrita do CREATE INDEX
SELECT reltuples::bigint FROM pg_class WHERE relname='Message';
```
Anote (a) e (b): são os números que a verificação do PASSO 5 tem de bater.
Ordem de grandeza medida: 280 mil linhas ⇒ ~0,7 s de bloqueio; 3 milhões ⇒ ~9,5 s.

### PASSO 2 — dry-run do reparo de contatos, e LER o relatório

O escopo da fusão MUDOU (ela funde também os pares antes classificados como
"ambíguos", que eram a maioria) — o dry-run antigo citado no compose não descreve
mais o que o script faz. Rode um novo, a partir da imagem NOVA:

```bash
docker compose run --rm --entrypoint sh migrate -c \
  'npx tsx prisma/merge-duplicate-phone-contacts.ts'      # sem --apply: escrita zero
```
O relatório sai com o telefone **mascarado** (`+5592*****4677`) e o `Contact.id` ao
lado — o stdout deste contêiner é o que a API do Dokploy expõe. Para conferir um caso
específico use o `Contact.id` no `psql`; só se for indispensável, `--verbose` mostra o
número inteiro (não use em log compartilhado).

O que olhar: `pares encontrados`, `linhas vivas neutralizadas` (tem de bater com o
item (b) do PASSO 1), e a lista `FUNDIRIA` — nenhum par pode ser de duas PESSOAS
diferentes. Se aparecer par decidido só por `formato` de alguém que você sabe que
responde, confira a grafia antes de seguir.

### PASSO 3 — acionar o deploy

Não é mais preciso parar `api`/`worker`: a migration trava a tabela (`LOCK TABLE
"Message" IN EXCLUSIVE MODE`) no início da própria transação, então PASSO 1 e PASSO 2
dela são atômicos por construção mesmo com o código velho escrevendo — comprovado
reproduzindo a corrida contra um Postgres real. Parar os serviços continua sendo
válido se você quiser encurtar a janela de versões mistas (os backfills do job levam
minutos numa base grande), mas não é mais requisito de segurança.

Verificação no log do serviço `migrate`, nesta ordem:
1. `All migrations have been successfully applied.`
2. as linhas dos três backfills, sem `non-fatal failure`;
3. `=== MERGE APLICADO ===` com `pares que FALHARAM ......... 0`.

Se o job terminar VERMELHO, `api` e `worker` **não** são recriados e prod continua no
código anterior — é o estado seguro. Vá para as seções de falha abaixo.

### PASSO 4 — verificar a aplicação ATRAVESSANDO o proxy

```bash
# (a) nginx → api → postgres (o /health puro não prova isto)
curl -s https://<domain>/api/health/ready            # 200 + "database":"up"

# (b) o artefato NOVO está no ar? A rota usada aqui no deploy de 2026-08 era a do
# Zernio, que está desligada desde 2026-11 (404 em qualquer versão) e não prova
# mais nada. Confira a versão pelo SHA da imagem no Dokploy → Deployments.
```

### PASSO 5 — conferir o dado depois

```sql
-- o índice existe?
SELECT indexname FROM pg_indexes WHERE indexname='Message_campaign_contact_live_key';

-- as neutralizações batem com o medido no PASSO 1?
SELECT source, count(*) FROM "_message_dup_neutralized_20260819" GROUP BY source;
--   source='migration' deve bater com (a); source='merge' com (b).
```
Se `migration` vier MAIOR que (a), alguma coisa escreveu entre a sondagem e o deploy —
investigue antes de liberar disparo novo. Nos 15 min seguintes, acompanhe o log do
`worker` por `paradas:` (a varredura de 5 min) e por `[K4]` (recusas por duplicata).

---

## Desfazer a neutralização de linhas duplicadas

A migration e o reparo **não apagam nada**: antes de escrever `CANCELLED`, os quatro
campos que o `UPDATE` sobrescreve vão para `_message_dup_neutralized_20260819`
(`id`, `status`, `errorCode`, `errorMessage`, `neutralizedAt`, `source`). Sem essa
tabela seria irreversível — `QUEUED` e `WAITING_INSTANCE` ficam indistinguíveis depois
do fato, e a prova de falha que o F2 preserva de propósito (`errorCode`) some.

```sql
-- ATENÇÃO: restaurar linhas vivas pode violar o índice único parcial. Restaure
-- caso a caso, e só depois de decidir qual linha do par deve ficar viva.
UPDATE "Message" m
SET status = b.status::"MessageStatus",
    "errorCode" = b."errorCode",
    "errorMessage" = b."errorMessage"
FROM "_message_dup_neutralized_20260819" b
WHERE m.id = b.id AND b.id = '<id da mensagem>';
```

---

## Reparo de contatos duplicados falhou (`pares que FALHARAM > 0`)

O script funde cada par numa transação própria: o par que falha **não deixa estado
parcial** e o laço segue para os outros. No fim ele sai com código ≠ 0 — de propósito,
porque é o único script destrutivo do job (apaga linha de `Contact`) e um deploy verde
em cima de fusão pela metade foi exatamente o defeito que a auditoria achou.

1. Leia as linhas `❌` no log: elas trazem `Contact.id` dos dois lados e o código do
   erro (`P2002` etc.). Os telefones vêm mascarados; use os ids no `psql`.
2. Resolva o par na mão (ou decida que ele não deve ser fundido).
3. Reacione o deploy.

**Se precisar destravar a subida antes de resolver o par**: no Dokploy, no serviço
`migrate`, defina `MERGE_DUPLICATE_CONTACTS=skip` e redeploie. O reparo não roda e o
log diz isso em voz alta. Enquanto essa env estiver ligada, gêmeos do 9º dígito voltam
a se acumular e a mesma pessoa pode receber a mesma campanha duas vezes — **desligue
assim que o par estiver resolvido.**

---

## Migration falhou / P3009 (deploys travados)

Sintoma: `migrate deploy` recusa rodar com
`P3009 — migrate found failed migrations in the target database`. Acontece quando uma
migration abortou no meio (ex.: `lock_timeout` estourou porque um `psql` ficou aberto
segurando `Message`): a linha fica em `_prisma_migrations` com `finished_at IS NULL` e
**todo deploy seguinte é recusado** até alguém intervir.

Não há perda de dado — a transação inteira faz ROLLBACK, então o banco está no estado
de ANTES:

```sql
SELECT migration_name, started_at, finished_at, rolled_back_at
FROM "_prisma_migrations" ORDER BY started_at DESC LIMIT 5;
```

```bash
# marca a migration falhada como revertida e libera o histórico
docker compose run --rm --entrypoint sh migrate -c \
  'npx prisma migrate resolve --rolled-back 20260819010000_message_one_live_row_per_campaign_contact'
```
Depois descubra QUEM estava segurando a tabela (`SELECT pid, query, state FROM
pg_stat_activity WHERE query ILIKE '%Message%';`), encerre, e redeploie.

---

## Rollback deste deploy (o índice NÃO some sozinho)

Prisma **não gera migration de volta**. Redeployar a tag anterior deixa o banco com o
índice `Message_campaign_contact_live_key` de pé — e o código velho não sabe conviver
com ele: `createMessage` e `resetForRedispatch` antigos não tratam P2002, então o
disparo passa a dar **500 no botão principal do produto**. Rollback só de código PIORA
a situação. Os três passos, na ordem:

```bash
# 1. redeploy da tag/commit anterior (Dokploy → Deployments → Redeploy)

# 2. tirar o índice — CONCURRENTLY porque é comando avulso, fora de transação,
#    e assim não bloqueia escrita nenhuma
docker compose exec postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -c 'DROP INDEX CONCURRENTLY "Message_campaign_contact_live_key";'

# 3. desregistrar a migration, senão o próximo deploy trava com P3009
docker compose run --rm --entrypoint sh migrate -c \
  'npx prisma migrate resolve --rolled-back 20260819010000_message_one_live_row_per_campaign_contact'
```

O que **não** volta com isso: o `UPDATE` do PASSO 1 (linhas que viraram `CANCELLED`) e
a fusão de contatos (linhas de `Contact` apagadas). Para o primeiro há a tabela
`_message_dup_neutralized_20260819` (ver acima). Para o segundo, só o snapshot do
PASSO 0.

## Evolution: versão fixa e troca de versão

Só a Evolution está ligada (`ENABLED_CHANNEL_PROVIDERS`). A imagem, o teto de memória, o webhook e a remoção de conexão têm as regras abaixo.

### Versão fixa (troca de digest)

- `docker-compose.prod.yml` e `docker-compose.dev.yml` usam a mesma imagem, fixa por digest e sem nenhum `latest`: `evoapicloud/evolution-api@sha256:966625532d9076a2381e973a271307d107e6f070450de3abeeea8bd18be07252`.
- É a Evolution 2.3.7 (Baileys 7.0.0-rc.9, Node 24.15), build de 2026-05-06. Trocar pela 2.3.8 quando publicada (correção de segurança #2435). Não usar a 2.4.0-rc: exige licença.
- Para trocar:
  1. Descobrir o digest da tag nova: `docker buildx imagetools inspect evoapicloud/evolution-api:<tag>` (campo `Digest`).
  2. Trocar o `@sha256:...` nos DOIS composes e atualizar o comentário ao lado (versão, Baileys, data do build).
  3. Antes do deploy, só leitura: memória livre do host (≥ 2,5 GB), versão atual (`GET /` da Evolution devolve a versão) e instâncias existentes. A Evolution aplica as migrations do banco `evolution` no boot: tire um `pg_dump` desse banco antes, porque voltar a um digest mais antigo depois de uma migration nova pode não subir.
  4. Deploy do compose. As sessões ficam no volume `evolution_instances` e no banco `evolution`; depois do deploy, conferir que cada conexão volta a "Conectado" e que o log do worker mostra, no máximo, `warn` "Evolution: webhook re-armado" (seção abaixo).
  5. Reverter = voltar o digest anterior nos dois composes e redeployar.

### Memória (`mem_limit` e `NODE_OPTIONS`)

- Só no serviço `evolution-api` de produção: `mem_limit: 1g` e `NODE_OPTIONS: --max-old-space-size=768`. Nenhum outro serviço recebe `NODE_OPTIONS`.
- Por quê: o host tem 8 GB sem swap, dividido com outros serviços, e o Baileys 7.0.0-rc.9 vaza memória. O heap de 768 MB fica abaixo do teto de 1 GB para o GC agir antes de o kernel matar o contêiner.
- Sinal de que o teto foi atingido: o contêiner reinicia (`docker inspect -f '{{.State.OOMKilled}}' <contêiner>` devolve `true`) e as conexões caem e voltam. Não suba o teto sem conferir a memória livre do host; o build da stack exige ≥ 2,5 GB livres.
- A Evolution continua sem porta e sem domínio público: só os contêineres do compose falam com ela (`http://evolution-api:8080`).

### Webhook sempre armado

- O worker confere o webhook de cada canal Evolution ativo no boot (primeiro ciclo do reconciliador de conexão) e a cada ciclo, no máximo uma vez a cada 10 min por canal.
- A conferência faz `GET /webhook/find/{instância}`. Se `enabled`, `url`, a lista de `events` ou `headers.apikey` divergirem do esperado, faz `POST /webhook/set/{instância}` e loga um `warn` "Evolution: webhook re-armado" com a instância e os campos divergentes, nunca a chave.
- Falha da Evolution nessa conferência só é logada ("Evolution: falha ao conferir o webhook") e não derruba o ciclo nem o reconcile de estado.
- Se o `warn` de re-arme aparecer a cada 10 min para a mesma instância, o `find` não está devolvendo o que o `set` grava (re-arme em laço): não é preciso mexer na instância; abra um chamado com a resposta de `GET /webhook/find/{instância}` (sem a chave).

### Remover uma conexão apaga a instância

- `DELETE /whatsapp/instances/:id` faz o logout e depois `DELETE /instance/delete/{instância}` na Evolution, em best-effort. Isso libera a sessão pareada.
- Se a chamada à Evolution falhar, o log traz `warn` "Evolution: instance/delete falhou; conexão removida só no OrgaMind" e o soft-delete acontece do mesmo jeito; a auditoria `instance.delete` registra `evolutionDeleted: false`. A instância sobra na Evolution: apague-a à mão pela API da Evolution (`DELETE /instance/delete/{instância}` com o header `apikey`).

### Virada em produção (só com pedido explícito)

Roteiro da spec `docs/superpowers/specs/2026-11-10-orgamind-somente-evolution.md` §7. **Não executar sem pedido explícito do usuário.**

1. Antes, só leitura:
   - memória do host ≥ 2,5 GB livres;
   - versão da Evolution do GBR (`GET /` da Evolution devolve a versão);
   - instâncias existentes na Evolution do GBR;
   - canais e áreas: `SELECT s.name, w.name, w.provider FROM "Sector" s LEFT JOIN "WhatsappInstance" w ON w.id = s."channelId" WHERE s."isActive";`
   - contagem de mensagens `WAITING_INSTANCE` por canal (`groupBy instanceId`): a varredura não desperta paradas de canal GoZap que já estava inativo antes da virada; se houver, levar ao backlog.
2. Deploy do compose inteiro.
3. A partir daqui, o envio da equipe para áreas ligadas ao GoZap fica bloqueado e o webhook do GoZap passa a responder 404. Fazer em horário sem escala.
4. ADMIN em Conexões → nova conexão Evolution com as áreas → QR ou código no celular. O mesmo número do GoZap pode ser pareado como mais um aparelho conectado. Aguardar "Conectado".
5. Conferir: aviso de áreas vazio; envio de teste para uma pessoa da equipe com status "Entregue".
6. Esperar uma volta da varredura de mensagens paradas (5 min): o log `paradas:` do GBR zerado. A varredura falha as paradas pelo processor e adota as de canais GoZap inativos do mesmo número. Se "GBR" era a conexão padrão, marcar a conexão Evolution como padrão **antes** de remover "GBR" em "Números desligados". Só depois remover "GBR" ali: as mensagens paradas nele viram falha com `channel.provider_disabled`.
7. Fora do OrgaMind, por decisão do usuário: apagar a instância "GBR" no painel do GoZap (devolve a vaga ao Picoa).

## Incident response

### Sends failing for all channels (Evolution)

1. Check the Evolution container: `docker compose logs --tail 100 evolution-api`; a container reiniciado por falta de memória (`docker inspect -f '{{.State.OOMKilled}}' <container>`) aponta para o teto de `mem_limit` (ver "Evolution: versão fixa e troca de versão").
2. Open Bull Board → confirm jobs are queued, not running
3. Tail worker logs: `docker compose logs -f worker`
4. Failed jobs are retried with backoff by BullMQ. If the outage is prolonged, manually pause the queue from a node shell:
   ```js
   const { Queue } = require('bullmq');
   const q = new Queue('whatsapp.send-message', { connection: { host: 'redis' } });
   await q.pause();   // resume with q.resume()
   await q.close();
   ```

### Meta returns 5xx for all sends

Desligado em 2026-11; código inativo no repositório.

### Webhook apikey failures spike

The Evolution webhook is authenticated by the `apikey` header (`webhook.apikey_invalid` audit events). Verify `EVOLUTION_API_KEY` is the same in the `api`, `worker` and `evolution-api` services. The worker re-arms the webhook headers on the instance at most every 10 min when they diverge (log `warn` "Evolution: webhook re-armado").

### Webhook signature failures spike

Desligado em 2026-11; código inativo no repositório (era a assinatura HMAC da Meta).

### Database disk full

Backups in `pg_backups` may fill the volume. Adjust retention via `BACKUP_KEEP_*` env vars on the `backup` service.

## Useful queries

```sql
-- Recent failed messages
SELECT m."providerMessageId", m."errorCode", m."errorMessage", c."phoneE164"
FROM "Message" m JOIN "Contact" c ON c.id = m."contactId"
WHERE m.status = 'FAILED' AND m."failedAt" > now() - interval '24 hours'
ORDER BY m."failedAt" DESC LIMIT 50;

-- Opt-out rate by template
SELECT t."metaName",
       count(*) FILTER (WHERE c."optedOut") AS opted_out,
       count(*) AS total
FROM "Message" m
JOIN "Contact" c ON c.id = m."contactId"
JOIN "Campaign" cp ON cp.id = m."campaignId"
JOIN "Template" t ON t.id = cp."templateId"
GROUP BY t."metaName" ORDER BY opted_out DESC;

-- Audit trail for a contact
SELECT * FROM "AuditEvent"
WHERE entity = 'Contact' AND "entityId" = '<id>'
ORDER BY "createdAt" DESC;
```

## Validação ativa de números (spec B.5)

A validação ativa consulta o WhatsApp número a número (o `/chat/check` era o do
GoZap, desligado em 2026-11; código inativo no repositório) para descobrir
quem não tem WhatsApp. **Consulta de existência em massa por um cliente NÃO
OFICIAL é sinal conhecido de bloqueio** — este cliente já perdeu um
número por isso. Por decisão de produto, o caminho normal é EXPLÍCITO: o
operador clica em **"Validar não validados (N)"** depois de ler o aviso de
risco na tela. Nada valida sozinho.

### Variáveis de ambiente (serviços `api` **e** `worker`)

`GOZAP_CHECK_RATE_PER_MIN` e `GOZAP_MAX_INSTANCES`: desligados em 2026-11 junto
com o GoZap; o compose não as encaminha mais. O ritmo de 40 consultas por minuto
era só do GoZap: na Evolution a validação **não tem ritmo próprio** (o adapter não
lê essa variável). Por isso o clique em "Validar não validados" deve ser usado com
parcimônia, em lotes pequenos, até existir um limite de ritmo para a Evolution.

A que resta precisa estar nos DOIS serviços. Quem executa a validação é o
`worker`; o `api` valida o mesmo schema no boot, e uma env presente num serviço
e ausente no outro produz dois processos com crenças diferentes sobre a mesma
coisa.

| Variável | Padrão | O que faz |
| --- | --- | --- |
| `CONTACT_SYNC_CRON_ENABLED` | `false` | **Validação automática diária — desligada por padrão.** Ligar só com decisão explícita de quem responde pelo número. |

Valores que LIGAM o cron: `true` ou `1`. Qualquer outra coisa (incluindo vazio,
`false`, `0`, `no`) deixa desligado.

### O que o cron faz quando está ligado

Roda uma vez por dia (13:00 UTC = 09:00 em Manaus), seleciona contatos com
validação vencida (até 5000 por execução), e os enfileira em lotes de 50, **sem limite de ritmo na Evolution** — **só dentro da janela de envio do canal**.
Fora da janela — ou com a sessão do canal offline — ele PULA em silêncio
(eventos de auditoria `contact.sync_skipped_outside_window` e
`contact.sync_skipped_channel_offline`) em vez de encher o Bull Board de jobs
vermelhos. O clique do operador, esse sim, recusa alto: um pedido explícito que
não fez nada merece um erro visível.

Antes da Fase B esse cron era um no-op em produção **por acidente** (só sabia
validar por canal EVOLUTION, e a produção só tinha GoZap). Ao fazer a validação
funcionar por canal de sessão, ele passaria a varrer a base inteira toda noite
sem ninguém pedir — daí o opt-in.

### Desligar depois de ter ligado

Basta pôr `CONTACT_SYNC_CRON_ENABLED=false` (ou vazio) e **redeployar o
worker**. O boot do worker apaga as chaves de repetível já gravadas no Redis
(`0 6 * * *` e `0 13 * * *`) — parar de agendar não bastaria, porque cada job
repetível do BullMQ se re-arma sozinho ao ser processado. O log do boot
confirma: `cron de validação desligado (CONTACT_SYNC_CRON_ENABLED)`.
