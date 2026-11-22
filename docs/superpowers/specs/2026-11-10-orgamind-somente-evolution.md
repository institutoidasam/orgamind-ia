# OrgaMind — somente Evolution API (desligar GoZap, Zernio, Twilio e Meta)

Data: 2026-11-10. Branch: `feat/somente-evolution` (empilhado sobre `feat/numero-por-area`, PR #11).
Pedido do usuário: "desabilite as outras integrações e deixe somente o evolution api na versão mais recente, pesquise a documentação para saber se podemos fazer uma integração melhor. planeje e implemente tudo de forma autônoma".

Material de apoio (workspace `.superpowers/sdd/2026-11-10-orgamind-somente-evolution/`):
`mapa-back-nao-evolution.md`, `mapa-back-evolution.md`, `mapa-front-infra.md`, `pesquisa-versao.md`, `pesquisa-api.md`.

## 1. Contexto

- Hoje o backend monta um adaptador por provedor (EVOLUTION, TWILIO, ZERNIO, META, GOZAP) conforme os grupos de env configurados (`configuredProviderGroups`, `whatsapp-providers.module.ts:90-106`). Cada provedor tem crons no worker, rotas de webhook, rotas de API e telas próprias.
- Produção GBR: o número em uso é a conexão GoZap "GBR" (conta GoZap do Picoa, plano de 1 vaga). O compose já tem o serviço `evolution-api` com imagem `evoapicloud/evolution-api:latest`, sem limite de memória.
- Evolution: a versão estável mais nova é a **2.3.7**. A tag `latest` (build de 2026-05-06, digest `sha256:966625532d9076a2381e973a271307d107e6f070450de3abeeea8bd18be07252`) é essa versão com Node 24.15. A tag `v2.3.7` é o build de 2025-12, com Node 24.11. Nos dois, Baileys 7.0.0-rc.9 e as mesmas migrações.
  - A 2.4.0 só existe como pré-release (rc2), exige licença (sem ativação, 503 `LICENSE_REQUIRED`) e traz o aviso "do not deploy to production".
  - A 2.3.8 (correção de isolamento entre instâncias, issue #2435) está pronta numa branch, mas não foi publicada.
- A integração Evolution já cobre: envio de texto e mídia, recibos (MESSAGES_UPDATE → `Message` → `TeamWhatsappRecipient`), conversa de entrada, QR e código de pareamento, estado ao vivo, reconciliador de conexão, proxy de saída e mapeamento de erros (`evolution-error-mapper.ts`).
  - Lacuna 1: o webhook só é configurado na criação da instância. Se a configuração some depois (restart, troca de URL, instância recriada por fora), os recibos e as mensagens de entrada param de chegar sem nenhum aviso.
  - Lacuna 2: a instância é criada sem ajustes de carga, recebendo grupos e histórico.
  - Lacuna 3: ao remover uma conexão, a sessão continua viva na Evolution (só logout, sem delete).

## 2. Objetivo

O OrgaMind passa a operar só com a Evolution API:
- nenhuma tela, rota, fila, cron ou webhook dos outros provedores fica ativo;
- os dados históricos continuam legíveis;
- a Evolution fica fixa na versão estável mais nova;
- a integração ganha webhook sempre armado, instância criada com menos carga e remoção que libera a sessão.

## 3. Fora de escopo

- Apagar dados, colunas, tabelas ou valores de enum dos outros provedores. Não há migração destrutiva.
- Apagar do backend o código dos adaptadores e serviços desligados. Ele fica no repositório, sem ser montado nem agendado; a remoção definitiva vai para o backlog.
  - No frontend, componentes e hooks exclusivos dos provedores desligados são removidos (§4.4).
- Usar a 2.4.0-rc ou uma imagem própria com Baileys ≥ rc10.
- Merge, deploy e qualquer ação em produção (dependem de pedido explícito; ver §7).
- Apagar a instância "GBR" no painel do GoZap, que devolve a vaga ao Picoa. Isso é decisão do usuário, fora do OrgaMind.

## 4. Requisitos

### 4.1 Um provedor só (backend)

- R1. Uma constante única, `ENABLED_CHANNEL_PROVIDERS = ['EVOLUTION'] as const`, num arquivo de config compartilhado do backend, é a fonte de verdade. O `ProviderRegistry` e o `MESSAGE_PROVIDER` legado só montam a Evolution, mesmo que existam env de outros provedores.
- R2. Boot: a validação de env exige o grupo Evolution completo (`EVOLUTION_BASE_URL`, `EVOLUTION_API_KEY`, `EVOLUTION_INSTANCE_NAME`).
  - Chaves de provedores desligados, completas ou parciais, não derrubam o boot. Viram um aviso único no log com os **nomes** das chaves ignoradas, nunca os valores.
  - Faltar o grupo Evolution derruba o boot com uma mensagem que diz isso.
- R3. `GET /whatsapp/providers` só devolve EVOLUTION (com os canais Evolution).
  - Os canais de provedor desligado vêm num campo novo, `disabledChannels: Array<{ id, name, provider, phoneE164, sectorNames: string[] }>`, só para ADMIN; outros papéis recebem `[]`.
- R4. Criar canal ou conexão com provider ≠ EVOLUTION (`POST /whatsapp/channels` e equivalentes) → 422 `channel.provider_disabled`.
- R5. Rotas dos provedores desligados deixam de existir (404):
  - `POST /webhooks/twilio`, `POST /webhooks/zernio`, `POST /webhooks/gozap`, `GET /webhooks/whatsapp` (handshake Meta);
  - `GET /whatsapp/zernio/accounts`, `POST /whatsapp/channels/:id/sync-inbox`, `GET /whatsapp/channels/:id/sync-inbox/status`, `POST /whatsapp/zernio/sync-broadcasts`, `GET /whatsapp/zernio/indeterminate-deliveries`, `GET /metrics/zernio`, `GET /whatsapp/channels/:id/qr` (GoZap);
  - as rotas de criar, sincronizar ou enviar templates Twilio e Zernio.
  - `POST /webhooks/whatsapp` passa a aceitar só payload Evolution; payload Meta → 404.
- R6. `DELETE /whatsapp/channels/:id` (só ADMIN) remove canal de provedor desligado: soft-delete local, desassocia as áreas e não chama nenhuma API externa. Para canal Evolution vale o fluxo de `DELETE /whatsapp/instances/:id` (§4.5 E3).

### 4.2 Nada dos desligados roda (worker)

- R7. O worker não agenda mais estes jobs: `gozap-connection-reconciler-tick`, `twilio.tier-sync`, `zernio.tier-sync`, `templates.zernio-sync`, `zernio.inbox-sync`, `zernio.broadcast-sync`, `zernio-analytics-sync-tick`, `token-expiry-check` (Meta) e o `template-approval-sync` (Twilio Content).
  - Os repetíveis já gravados no Redis por versões anteriores são removidos no boot do worker, de forma idempotente, seguindo o padrão `removeRepeatable` já usado em `worker.ts:87-130`.
- R8. Não há consumidores (`@Processor`) registrados para as filas exclusivas dos desligados (`zernio.*`, `gozap.connection-reconciler`, `twilio.tier-sync`, `whatsapp.check-token-expiry`, `templates.zernio-sync`).
  - Se um serviço exclusivo ainda for injetado em código compartilhado, ele pode continuar como provider Nest, desde que não seja processor nem controller.

### 4.3 Canais existentes de provedor desligado

- R9. Ficam no banco como estão. São tratados como **desligados**: nada envia por eles (chat, campanha, envio da equipe, bot).
  - Tentativa síncrona → erro `channel.provider_disabled` (HTTP 409).
  - Mensagem já enfileirada nesses canais → FAILED com `errorCode = 'channel.provider_disabled'`, sem nova tentativa.
  - No envio da equipe, esse código não é repetível (entra em `NOT_REPEATABLE_CODES`).
- R10. Área cujo `channelId` aponta para canal desligado conta como **área sem número**:
  - entra no aviso "Áreas sem número" de Conexões;
  - aparece sem número em Setores;
  - bloqueia o envio da equipe com o 422 que já existe para área sem número.
  - Área só pode ser ligada a canal EVOLUTION ativo; ligar a outro → 422 `sector.channel_provider_disabled`.
- R11. Conversas de canal desligado continuam legíveis no chat. O campo de resposta fica bloqueado com o aviso "Este número usa uma integração desligada (<Provedor>). Para responder, conecte um número Evolution em Conexões."
- R12. Campanhas e templates só oferecem canais e templates Evolution. Uma campanha já agendada num canal desligado falha no disparo com `channel.provider_disabled`, e o motivo aparece no resultado. Templates de provedores desligados saem da lista e ficam só no banco.

### 4.4 Frontend sem os outros provedores

- R13. Conexões (`/connect`) mostra só a seção Evolution e, quando `disabledChannels` não está vazio (só ADMIN), o bloco **"Números desligados"**.
  - O bloco lista nome, telefone, integração ("GoZap", "Zernio", "Twilio", "Meta") e as áreas ligadas, com a ação **Remover**.
  - A confirmação diz: "Remover <nome>? As áreas <lista> ficam sem número até serem ligadas a um número Evolution. A conexão no <Provedor> não é apagada por aqui."
- R14. Saem do front:
  - seção e diálogos GoZap (criar, QR, remover), seção e formulário cloud (Twilio, Zernio, Meta), lista cloud;
  - seletor de escopo de provedor no topo e abas de provedor no chat;
  - hooks e telas Zernio (`features/zernio-metrics`, contas, broadcast, inbox sync);
  - diálogos e ações de template Twilio e Zernio;
  - o default de aba GoZap no chat.
  - Os rótulos e as mensagens de erro de códigos antigos (`gozap.*` etc.) **ficam**, porque o histórico de envios ainda exibe esses motivos.
- R15. Nenhuma escolha de provedor aparece na UI. A criação de conexão é a da Evolution (QR ou código de pareamento), com escolha de áreas (já existe).
- R16. Nota de versão nova em `release-notes.ts`, em linguagem de usuário: "O WhatsApp agora funciona só pela Evolution. Números de outras integrações aparecem em Conexões como desligados; ligue as áreas a um número Evolution."

### 4.5 Evolution: versão e integração melhor

- V1. A imagem fica fixa por digest em `docker-compose.prod.yml` e `docker-compose.dev.yml`, sem nenhum `latest`: `evoapicloud/evolution-api@sha256:966625532d9076a2381e973a271307d107e6f070450de3abeeea8bd18be07252`.
  - O comentário ao lado registra: "Evolution 2.3.7 (Baileys 7.0.0-rc.9, Node 24.15), build de 2026-05-06; trocar pela 2.3.8 quando publicada (correção de segurança #2435); não usar 2.4.0-rc (exige licença)".
- V2. Em produção, o `evolution-api` ganha `mem_limit: 1g` e `NODE_OPTIONS: --max-old-space-size=768`. Os demais env da Evolution não mudam. O serviço continua sem porta ou domínio público.
- E1. **Webhook sempre armado.** O worker confere a configuração no boot e a cada ciclo do reconciliador de conexão Evolution que já existe (`whatsapp-instances/connection-reconciler.service.ts`), no máximo uma vez a cada 10 min por canal.
  - Para cada canal Evolution ativo, chama `GET /webhook/find/{instance}`. Se `enabled`, `url`, a lista de `events` ou `headers.apikey` divergirem do esperado, chama `POST /webhook/set/{instance}` com o corpo no formato da 2.3.7: `{ webhook: { enabled: true, url, headers: { apikey }, byEvents: false, base64: false, events: ['MESSAGES_UPSERT','MESSAGES_UPDATE','CONNECTION_UPDATE','QRCODE_UPDATED'] } }`.
  - O mesmo corpo vale para o `ensureWebhookConfigured` atual, cujos campos `webhookByEvents`/`webhookBase64` a 2.3.7 ignora.
  - Cada re-arme gera um log `warn` com instância e campos divergentes, nunca a chave. A falha da Evolution é só logada e não derruba o ciclo.
- E2. **Instância nova com menos carga.** O `POST /instance/create` passa a enviar `alwaysOnline: false, readMessages: false, readStatus: false, syncFullHistory: false` e mantém o que o adapter já envia (`rejectCall: true`, `groupsIgnore: true`; adapter :785-786, :1015-1016 — o chat já ignora grupos).
  - Motivo: grupos e histórico aumentam as mensagens recebidas e o vazamento do Baileys rc.9.
  - O chat ignora grupos hoje? Confirmar em `chat-history-sync.service.ts:60` e no parse de entrada. Se algum fluxo do produto usa grupo, `groupsIgnore` fica `false` e isso vira ruling no ledger.
  - Instâncias existentes não são alteradas; o ADMIN já ajusta pelo PATCH.
- E3. **Remover libera a sessão.** `DELETE /whatsapp/instances/:id` faz o logout (como hoje) e depois `DELETE /instance/delete/{instance}` na Evolution, em best-effort. Se a chamada falhar, isso é logado e o soft-delete acontece do mesmo jeito.

### 4.6 Infra, CI e docs

- I1. Saem os env GOZAP_*, ZERNIO_*, TWILIO_* e META_* de:
  - `docker-compose.prod.yml` (api, worker, migrate);
  - `.env.example` e `.env.prod.example`;
  - `.github/workflows/ci.yml` e `e2e.yml`.
  - Os dummies EVOLUTION_* do CI ficam.
- I2. `README.md`, `DEPLOY.md` e `OPERATIONS.md`: as seções de GoZap, Meta, Zernio e Twilio viram uma nota curta ("desligado em 2026-11; código inativo no repositório"). `OPERATIONS.md` ganha a seção "Evolution: versão fixa e troca de versão" (V1, V2, E1). `frontend/nginx.conf` sai do caminho do webhook GoZap só se a regra for exclusiva dele; os comentários são atualizados.

## 5. Cenários (BDD)

1. Dado que o env tem os grupos GOZAP e EVOLUTION completos, quando a api sobe, então o registry só tem EVOLUTION, o log avisa "chaves de provedores desligados ignoradas: GOZAP_BASE_URL, …" e `GET /whatsapp/providers` lista só EVOLUTION.
2. Dado um env sem EVOLUTION_API_KEY, quando a api sobe, então o boot falha dizendo que o grupo Evolution é obrigatório.
3. Dado que o Redis tem o repetível `gozap-connection-reconciler-tick` de uma versão anterior, quando o worker sobe, então o repetível some e nenhum job GoZap, Zernio, Twilio ou Meta é agendado.
4. Dado a área "Produção" ligada ao canal GoZap "GBR", quando o ADMIN abre Conexões, então "Produção" aparece em "Áreas sem número", "GBR" aparece em "Números desligados" com a área "Produção", e o envio da equipe para Produção é bloqueado com a mensagem de área sem número.
5. Dado o canal GoZap "GBR" desligado, quando o ADMIN clica Remover e confirma, então o canal sai da lista, "Produção" fica com `channelId` nulo e nenhuma chamada ao GoZap acontece.
6. Dado um canal Evolution conectado, quando o ADMIN liga "Produção" a ele em Conexões, então a área sai do aviso e o envio da equipe para Produção usa esse número.
7. Dado uma mensagem QUEUED num canal GoZap, quando o processor a pega, então ela vira FAILED com `channel.provider_disabled` e não é reenfileirada.
8. Dado que a Evolution responde ao `GET /webhook/find/x` com `enabled: false`, quando o reconciliador roda, então chama `POST /webhook/set/x` com o corpo de E1 e loga o re-arme. Dado que a configuração já confere, nenhum `set` é chamado.
9. Dado uma conexão Evolution, quando o ADMIN a remove, então o backend chama logout e `DELETE /instance/delete/x`. Se o delete falhar, a conexão some do OrgaMind do mesmo jeito.
10. Dado um usuário não ADMIN, quando chama `GET /whatsapp/providers`, então `disabledChannels` é `[]`.
11. Dado `POST /webhooks/gozap`, então 404. Dado `POST /webhooks/whatsapp` com payload Evolution válido, então segue funcionando como hoje.
12. Dado a conversa de um contato pelo canal GoZap, quando o usuário a abre no chat, então vê o histórico e o campo de resposta bloqueado com o aviso de R11.

## 6. Foco de revisão (riscos sem teste óbvio)

- Repetíveis antigos no Redis continuando a disparar processors que não existem mais. Os jobs ficariam presos e a fila cresceria (R7).
- DI do Nest quebrando no boot ao tirar providers ou processors de módulos que injetam serviços exclusivos. O boot real da api e do worker é critério de aceite, não só os testes unitários.
- Envio da equipe ou campanha agendada caindo num canal desligado e virando "Situação incerta" em vez de falha clara (R9).
- Autorização: `disabledChannels` e Remover são só ADMIN, e ligar área a canal desligado é recusado (R3, R6, R10).
- Re-arme do webhook em laço, chamando `set` a cada ciclo, por comparação errada da resposta do `find` (formato real da 2.3.7: conferir no teste de integração com a imagem fixada).

## 7. Virada em produção (roteiro, só com pedido explícito do usuário)

1. Antes, só leitura:
   - memória do host ≥ 2,5 GB livres;
   - versão da Evolution do GBR (`GET /` da Evolution devolve a versão);
   - instâncias existentes na Evolution do GBR;
   - canais e áreas: `SELECT s.name, w.name, w.provider FROM "Sector" s LEFT JOIN "WhatsappInstance" w ON w.id = s."channelId" WHERE s."isActive";`
2. Deploy do compose inteiro.
3. A partir daqui, o envio da equipe para áreas ligadas ao GoZap fica bloqueado e o webhook do GoZap passa a responder 404. Fazer em horário sem escala.
4. ADMIN em Conexões → nova conexão Evolution com as áreas → QR ou código no celular. O mesmo número do GoZap pode ser pareado como mais um aparelho conectado. Aguardar "Conectado".
5. Conferir: aviso de áreas vazio; envio de teste para uma pessoa da equipe com status "Entregue".
6. Esperar uma volta da varredura de mensagens paradas (5 min; log `paradas:` do GBR zerado). Se "GBR" era a conexão padrão, marcar a conexão Evolution como padrão. Depois, remover "GBR" em "Números desligados" (as mensagens paradas nele viram falha com `channel.provider_disabled`).
7. Fora do OrgaMind, por decisão do usuário: apagar a instância "GBR" no painel do GoZap (devolve a vaga ao Picoa).

## 8. Critérios de aceite

- `gate --changed --base origin/main` PASS no backend e no frontend, sem regressão de complexidade, lint ou sonar.
- Gate completo uma vez no fim, sem regressão sobre a base.
- Typecheck do CI limpo (`npm run build` no back; `tsc -b` no front).
- Boot real da api e do worker numa stack local com env só Evolution e com env GoZap de sobra, sem erro de DI.
- Teste de integração do adaptador contra a imagem Evolution fixada (testcontainers ou stack local), cobrindo `instance/create` com settings, `webhook/find` e `webhook/set` no formato da 2.3.7 e `instance/delete`.
- QA visual em Conexões, com bloco "Números desligados" e aviso de áreas, e no chat, com conversa de canal desligado bloqueada.
