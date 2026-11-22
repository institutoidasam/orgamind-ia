# OrgaMind — somente Evolution API — Implementation Plan

> **Para os agentes:** executar pela skill `sdd` (TDD, ledger em `.superpowers/sdd/2026-11-10-orgamind-somente-evolution/progress.md`). **Sem commit/push**: nenhuma task commita; a principal integra e só commita ou publica com pedido explícito do usuário. Branch `feat/somente-evolution`, empilhada sobre `feat/numero-por-area` (PR #11), HEAD do início `3a1ceb3`.

**Goal:** o OrgaMind passa a operar só com a Evolution. Nenhuma rota, fila, cron, webhook ou tela dos outros provedores fica ativa, e o histórico continua legível. Canal de provedor desligado vira "desligado": não envia, e a área ligada a ele conta como "sem número". A Evolution fica fixa por digest na 2.3.7. O webhook passa a ser conferido e re-armado pelo reconciliador, e a remoção de uma conexão apaga a instância na Evolution.

**Architecture:** uma constante (`ENABLED_CHANNEL_PROVIDERS`) decide tudo no back: o registry, a regra de "número efetivo" da área, os guards de envio e as listas. O código dos provedores desligados fica no repositório. Saem do Nest só os processors, os controllers e os crons, e os serviços continuam como providers inertes, para não quebrar a DI. Os repetíveis antigos no Redis são removidos no boot do worker. O front remove os componentes e hooks exclusivos e ganha o bloco "Números desligados". A conferência do webhook é uma função pura (`webhookDivergences`) usada pelo reconciliador de conexão que já existe.

**Tech Stack:** NestJS + Prisma + Zod (`createZodDto`) + BullMQ 5.76 + Vitest/testcontainers 11 (`@testcontainers/postgresql`, `@testcontainers/redis`, `testcontainers` `GenericContainer`), no backend. React + TanStack Router/Query + ky 2 + sonner + Vitest/Testing Library, no frontend. Docker Compose, na infra.

**Spec:** `docs/superpowers/specs/2026-11-10-orgamind-somente-evolution.md` (fonte da verdade). Mapas e pesquisas em `.superpowers/sdd/2026-11-10-orgamind-somente-evolution/`: `mapa-back-nao-evolution.md`, `mapa-back-evolution.md`, `mapa-front-infra.md`, `pesquisa-api.md`, `pesquisa-versao.md`.

## Ordem e paralelismo

```
Back:  B1 ─┬─> B2 ─> B3 ──────────────┐
           ├─> B4                      │
           ├─> B5 ─────────────────────┤
           ├─> B6                      ├─> B12 (DI/boot)
           └─> B7                      │
       B8 ─────────────────────────────┤
       B9 ─┬─> B10 ────────────────────┘   (B12 também depende de B4 e B7 — N4)
           └─> B11 (integração com a imagem)
Front: F1 ─> F2        F3        F4        F5
Infra: I1
```

- **Paralelos (ownership disjunto):**
  - B1 ∥ B8 ∥ B9 ∥ I1;
  - depois da B1: B2 ∥ B4 ∥ B5 ∥ B6 ∥ B7;
  - B10 ∥ B11, depois da B9;
  - F1 ∥ F3 ∥ F4 ∥ F5, que podem começar já: o contrato C3 está fixado neste plano.
- **Em série:**
  - B1 → B5: a B5 consome `routesOf` (C2, `backend/test/routes-of.ts`), criado na B1;
  - B2 → B3: as duas mexem em `whatsapp-providers.module.ts`;
  - F1 → F2: a F2 consome `features/whatsapp/disabled-provider.ts`, criado na F1 (a F1 também remove os hooks de sync Zernio de `api.ts`, M11);
  - B12 depois de B2, B3, B5, B6, B8 e B10.
- **Revisão** (SKILL.md do sdd, §Revisão por risco):
  - **Críticas, com revisor `opus`:** B1 (segredo/credencial), B3 (autorização), B5 (entrada de rota pública) e B9 (segredo/credencial).
  - **Alto, com revisor `sonnet` dedicado:** B2, B4, B7, B8, B10, B12 e I1.
  - **Demais:** B6, B11 e F1–F5. A F5 cabe no `mecanico`.
- **Base do `--changed`:** `origin/main`. Se o PR #11 ainda não estiver em `origin/main` (`git merge-base --is-ancestor 3a1ceb3 origin/main` falha), a principal troca a base para `3a1ceb3` no despacho. Sem isso, o diff da feature anterior entra no gate.

## Decisões deste plano (registradas para o ledger)

- **D1 — (a) Área sem número.**
  - A regra está numa função só: `effectiveChannel` (`backend/src/modules/team-whatsapp/sector-channel.ts:33-43`), que chama `isTeamProvider` (`team-whatsapp.policy.ts:4-10`, `TEAM_PROVIDERS = ['GOZAP','EVOLUTION']`).
  - Ela já alimenta:
    - a lista de setores (`internal-sectors/sector-channel-view.ts:14`), de onde vêm o selo "Sem número" (`frontend/src/features/internal-admin/components/sector-number.tsx`) e o aviso "Áreas sem número" de Conexões (`features/whatsapp/components/sectors-without-number-notice.tsx`);
    - a prévia e o POST da equipe (`team-whatsapp.repository.ts:469`, `:501`);
    - o PUT de áreas (`whatsapp-providers/sector-channel.service.ts:171`).
  - Decisão: `TEAM_PROVIDERS` passa a ser `ENABLED_CHANNEL_PROVIDERS` (B4). Com isso, canal GoZap ativo vira "sem número" em todos esses lugares, sem mexer no front de Setores nem no aviso.
  - O enum de contrato `teamProviderSchema` (`schemas/contracts/team-whatsapp.schema.ts:12`, `:171`) **fica** `['GOZAP','EVOLUTION']`, porque os snapshots históricos de destinatário guardam GOZAP.
- **D2 — (b) Envio para canal desligado.**
  - Hoje, `ProviderRegistry.forChannel` lança `channel.provider_not_configured`, 400 (`provider-registry.service.ts:10-19`, `:40-46`).
  - O chat responde com `ChatProviderNoReplyError` (`chat.service.ts:468-469`, via `supportsInboxChatFor`).
  - O team processor grava `team_whatsapp.channel_invalid` (`team-whatsapp-send.processor.ts:271-273`).
  - O processor de envio cai no catch genérico de `DomainError` (`send-message.processor.ts:1401-1411`).
  - O `channel.provider_disabled` entra em quatro pontos:
    1. `forChannel` lança 409 (B2): cobre todo envio síncrono que resolve o adapter, bot incluído;
    2. guard explícito em `send-message.processor` (B7), logo depois do roteador e do re-resolve pós-reset (`:580-672`), com o roteador tratando canal desligado como sempre alcançável (D11): mensagem já na fila vira FAILED, sem lançar e sem retry;
    3. guard na resposta do chat, antes de `:444-469` (B7);
    4. team processor `:271` e `failUnavailable` em `team-whatsapp.repository.ts:874-895` (B4).
  - `failureStatus` passa a devolver sempre `FAILED` para esse código, nunca `UNCERTAIN` (B4).
- **D3 — (c) DI.** Serviços exclusivos injetados em código compartilhado (grep de construtores):
  - `TwilioContentService` e `ZernioTemplateService` → `templates.service.ts:103-104`;
  - `TwilioMediaService` → `chat/chat-media-download.processor.ts:33`;
  - `ZernioAccountsService` → `channel-health.service.ts:49` e controller `:76`;
  - `GozapInstancesService` → `channel-live-state.service.ts:49` e controller `:79`;
  - `WebhookDropsService` e `ChannelHealthService` → controller `:77-78`;
  - fila `ZERNIO_BROADCAST_DISPATCH/CANCEL` → `campaigns.service.ts:240-243`.

  Decisão: **nenhum serviço, client, adapter ou fila sai dos módulos.** Saem só processors e controllers:
  - `WhatsappProvidersModule` (B2): `GozapConnectionReconcilerProcessor`, `TwilioTierSyncProcessor`, `ZernioBroadcastSyncProcessor` e o controller `ZernioBroadcastSyncController`;
  - `TemplatesModule` (B6): `ZernioTemplateSyncProcessor`;
  - `WorkerModule` (B8): `CheckTokenExpiryProcessor`, `ZernioInboxSyncProcessor`, `ZernioTierSyncProcessor`, `ZernioBroadcastSendService`, `ZernioBroadcastPollService` e `ZernioBroadcast{Dispatch,Poll,Cancel}Processor`;
  - `WebhooksModule` (B5): `TwilioWebhooksController`, `ZernioWebhooksController` e `GozapWebhooksController`;
  - `ChatModule` (B5): `ZernioInboxSyncController`.

  O `BullModule.registerQueue` de `ZERNIO_BROADCAST_DISPATCH` e `GOZAP_CONNECTION_RECONCILER` (`whatsapp-providers.module.ts:193-213`) **fica**: o worker precisa da fila para limpar o repetível.
- **D4 — (d) Grupos.**
  - O chat ignora grupo: `chat-ingest.service.ts:383` (`if (m.isGroup) continue`) e `chat-history-sync.service.ts:60`, `:144`. Nenhum fluxo usa grupo, e `groupsIgnore` fica `true`.
  - **Já é `true` hoje** (`evolution-api.adapter.ts:786`, `:1016`).
- **D5 — (e) Formato do `GET /webhook/find`.**
  - `pesquisa-api.md` não traz o formato da resposta, só o do `set` (aninhado). Pelo código da 2.3.7, a resposta deve ser o registro plano do Prisma, com `enabled`, `url`, `events`, `headers`, `webhookByEvents` e `webhookBase64`, ou `null`. **Não verificado.**
  - Decisão: `webhookDivergences` aceita a forma plana e a aninhada (`{ webhook: {...} }`). Quem decide é a B11, contra a imagem fixada: depois do `set`, o `find` tem que dar zero divergências. É esse teste que prende o risco de re-arme em laço.
  - Se o `find` não devolver `headers`, a B11 está autorizada a ajustar só a regra de `headers` ausente em `webhookDivergences` (M10; ver a B11).
- **D6 — (f) Seletor de escopo e abas.**
  - Os dois já somem com menos de 2 provedores (`provider-scope.tsx:163`, `provider-tabs.tsx:31`).
  - Mesmo assim, saem do código (R14): o seletor na F3, as abas na F2.
  - Risco que justifica: o escopo persistido no `localStorage` (`provider-scope.tsx:44-47`) pode valer `GOZAP` de uma sessão antiga, e sem seletor o usuário ficaria preso numa lista vazia. A F3 faz qualquer valor persistido diferente de `all` virar `all`.
- **D7 — Limpeza dos repetíveis (R7).** O padrão de `worker.ts:118-140` exige a tripla exata (`name`, `repeat`, `jobId`).
  - Decisão: em cada fila exclusiva, listar com `getRepeatableJobs()` e remover com `removeRepeatableByKey(key)`. Não depende de copiar triplas e também apaga chaves de versões mais antigas.
  - **Sem `drain`**: jobs avulsos que sobrarem não se re-armam sem consumidor, e apagar jobs do Redis de produção não é pedido pela spec.
  - O teste de integração com Redis (B8) semeia os repetíveis exatamente como o `worker.ts` atual os cria. Se `getRepeatableJobs` não os enxergar, a B8 volta ao `removeRepeatable` com as triplas copiadas.
  - **Depreciação (M8):** `getRepeatableJobs`/`removeRepeatableByKey` estão depreciadas no BullMQ 5.76 em favor dos job schedulers, mas existem e são as que enxergam repetíveis criados no formato legado `add(name, data, { repeat, jobId })`, que é o do `worker.ts`. `upsertJobScheduler`/`removeJobScheduler` não servem. Cada chamada leva supressão pontual de S1874 com essa justificativa no comentário.
- **D8 — "No boot" do E1.** É o primeiro ciclo do `ConnectionReconcilerService` depois que o worker sobe: o mapa de última conferência começa vazio. Não há hook de boot separado.
  - **Dois processos (M7), aceito:** o `ConnectionReconcilerService` também é `@Processor` registrado na api (`app.module.ts:125`), com mapa próprio. Resultado: até **2 conferências por instância a cada 10 min** (uma por processo). Aceito porque o `find` é um GET barato, o `set` é idempotente (mesmo corpo de C5) e restringir ao worker exigiria uma flag `isWorker` nova no módulo compartilhado. Não há laço: depois do primeiro `set`, os dois processos veem zero divergências.
- **D9 — Aviso das chaves ignoradas.**
  - É logado uma vez por processo, na factory do `ProviderRegistry` (api e worker montam o módulo uma vez cada).
  - A lista são as 15 chaves que definem grupo dos desligados (as não-Evolution de `whatsapp-providers.module.ts:47-66`; ver C1). Chaves com default, como `GOZAP_MAX_INSTANCES`, não entram, porque sempre teriam valor.
- **D10 — Rótulos de provedor.**
  - Back: `PROVIDER_DISPLAY_NAME`.
  - Front: `DISABLED_PROVIDER_LABEL`.
  - Valores: `GOZAP` → `GoZap`, `ZERNIO` → `Zernio`, `TWILIO` → `Twilio`, `META` → `Meta`, `EVOLUTION` → `Evolution`.
- **D11 — Mensagem parada em canal desligado (I1 da revisão R1).**
  - Problema: o canal só é conhecido depois do roteador (`send-message.processor.ts:580-606`). O ramo `routed.kind === 'waiting'` (`:585-604`) e o do re-resolve pós-reset (`:653-670`) estacionam em WAITING_INSTANCE e retornam antes de qualquer guard. `isInstanceOnline` (`whatsapp-instance-router.service.ts:105-114`) trata GOZAP como sessão e exige último evento `open`; sem evento novo (reconciliador GoZap fora, webhook 404), a mensagem ficaria parada para sempre. A varredura (`reconnect-replay.service.ts:65-84`) usa a mesma regra e só solta canal online; a adoção exige o mesmo provider (`:108-119`).
  - **Escolha:** canal de provedor desligado **não passa pelo gate de conexão**. Função nova em C1, `skipsConnectionGate(provider)` = `!isSessionProvider(provider) || !isEnabledChannelProvider(provider)`, usada nos dois pontos que hoje chamam `!isSessionProvider`: `isInstanceOnline` (`router :106`) e a varredura (`reconnect-replay.service.ts:65`), que precisam continuar iguais (comentário em `:61-64`). Com isso o roteador devolve `kind: 'send'` para canal desligado e **um** guard no processor, logo depois do bloco de reset/re-resolve (`:672`), cobre `routed.instance` e `freshRouted.instance`.
  - **Por que não o guard no ramo `waiting`:** ali só existe `routed.instanceId`; seriam duas leituras extras do canal (`:585` e `:657`) e dois guards. A escolha muda uma linha em dois arquivos e põe um guard só. `isSessionProvider` (`channel-provider.schema.ts:93`) **não** muda: o anti-ban e outros usos continuam iguais.
  - **WAITING_INSTANCE já existentes** (ex.: GBR): a varredura periódica (`parked-messages-sweeper.processor.ts:34` → `sweepParked`) passa a ver o canal desligado ativo como alcançável e as solta; o processor as falha com `channel.provider_disabled`. Na remoção do canal desligado (C4), as paradas e QUEUED do canal viram FAILED na mesma transação, como `WhatsappInstancesService.delete` faz com `antiban.instance_deleted` (`whatsapp-instances.service.ts:316-325`).

## Divergências da spec (decisão proposta; a principal confirma)

- **DV1 — E2 e §1 "Lacuna 2". Resolvida na spec.**
  - A spec (E2, `:101`) já adota o que este plano propunha: manter `rejectCall: true` e `groupsIgnore: true` (que o adapter já envia em `evolution-api.adapter.ts:781-787`, `:1011-1017`) e acrescentar `alwaysOnline: false, readMessages: false, readStatus: false, syncFullHistory: false`.
  - `EVOLUTION_CREATE_SETTINGS` (C5, B9) segue a spec literal. Nada a confirmar.
- **DV2 — Rotas a mais que R5 não lista**, mas que são exclusivas de desligados (§2: "nenhuma rota… fica ativa"):
  - `POST /templates/sync` chama `syncFromMeta` (`templates.controller.ts:35-37`) e sai na B6;
  - `GET /whatsapp/channels/health` (saúde Zernio/cloud, `whatsapp-providers.controller.ts:344-346`; o único consumidor no front é a seção cloud) sai na B3;
  - `GET /whatsapp/webhook-drops` **fica** no back (leitura de histórico, sem efeito), e o banner sai do front (F1). A remoção da rota vai para o backlog.
- **DV3 — `template-approval-sync`.** R7 tira o cron, mas R8 não lista a fila `templates.approval-sync`. O cron sai e o repetível é removido (B8). O `TemplateApprovalSyncProcessor` **fica** registrado: é o "(quase) exclusivo" do mapa, com ramo em `:190`.
- **DV4 — Restart.** O adapter faz `POST /instance/restart` (`evolution-api.adapter.ts:1042`), mas `pesquisa-api.md:10` diz `PUT`. Fora do escopo da spec, mas a B11 confere contra a imagem. Se der 404, a B11 troca o verbo (fora do teste, a B11 só pode tocar isso e a regra de `headers` ausente de `webhookDivergences`, M10).
- **DV5 — R4.**
  - `POST /whatsapp/channels` já recusa EVOLUTION (`whatsapp-providers.controller.ts:362-364`). Depois desta feature, a rota sempre recusa: 422 `channel.provider_disabled` para os outros provedores e a recusa atual para EVOLUTION.
  - Um corpo que o DTO Zod reprova (ex.: ZERNIO sem conta) continua 400, porque a validação roda antes do handler.

## Global Constraints

- **GC1 — Gate.**
  - Iteração: `timeout 600 gate --test <arquivo>` com cwd `backend/` ou `frontend/`. Spec de integração (testcontainers): `TESTCONTAINERS_ENABLED=1 timeout 600 gate --test <arquivo>`, com Docker.
  - Fechamento de cada task: um único `timeout 600 gate --changed --base origin/main` (ou a base que o despacho der).
  - Typecheck: `npm run build` (back) e `npx tsc -b` (front).
  - Suíte inteira, gate completo, `test:cov`/`--coverage` e e2e ficam com a principal.
  - Em worktree, o gate precisa de `backend/.env` fictício e de `node_modules`.
- **GC2 — Limites de complexidade, inclusive em specs.**
  - Função/callback ≤ 50 linhas (inclusive o callback de `describe`); ≤ 4 parâmetros (mais campos = objeto); ciclomática ≤ 10; cognitiva ≤ 15; profundidade ≤ 4.
  - Duplicação ≤ 3%; cobertura ≥ 80% das linhas novas.
  - O `--changed` não pega `describe` longo nem `max-params` em spec: cada task confere à mão (`describe` novos, `it.each` com tabela).
- **GC3 — Sem migração.** `schema.prisma` não muda. Nenhum dado, coluna, tabela ou valor de enum é apagado. `channelProviderEnum` (`schemas/contracts/channel-provider.schema.ts:10-16`) e `teamProviderSchema` ficam como estão, para o histórico.
- **GC4 — Fonte única.** Ligado ou desligado se decide só por `isEnabledChannelProvider(provider)` ou `ENABLED_CHANNEL_PROVIDERS` (C1). Nunca por comparação nova com `'GOZAP'`, `'ZERNIO'` etc. `isEnabledChannelProvider` **não** é type guard, de propósito: assim não quebra comparações antigas por estreitamento de tipo.
- **GC5 — Código inativo, não apagado (back).**
  - Do backend saem só `@Processor`, `@Controller`/rotas e crons dos desligados. Serviços, clients e adapters ficam como providers Nest (D3).
  - Arquivo de processor ou controller que deixa de ser registrado **não** é apagado.
  - No front, componentes e hooks exclusivos **são** apagados, com as specs deles.
- **GC6 — Segredo em log.**
  - Nenhum log ou auditoria novo ou alterado contém valor de env, `apikey` ou header.
  - Erro de axios é logado só como `{ httpStatus: err.response?.status, code: err.code }`, nunca o objeto `err` (ele carrega `config.headers.apikey`).
  - O aviso de chaves ignoradas leva só **nomes**.
- **GC7 — Códigos de erro (exatos).**

  | Código | HTTP | Quando |
  |---|---|---|
  | `channel.provider_disabled` | 409 | envio síncrono por canal de provedor desligado (registry, chat, campanha) |
  | `channel.provider_disabled` | 422 | `POST /whatsapp/channels` com provider ≠ EVOLUTION |
  | `channel.provider_disabled` | — | `Message.errorCode` / `TeamWhatsappRecipient.errorCode` de mensagem já na fila (FAILED, sem retry) |
  | `sector.channel_provider_disabled` | 422 | `PUT /whatsapp/channels/:id/sectors` em canal ativo de provedor desligado |
  | `channel.not_disabled` | 422 | `DELETE /whatsapp/channels/:id` em canal EVOLUTION |

  Mensagem pt-BR do 409/422 `channel.provider_disabled`: `Este número usa uma integração desligada (<Provedor>).`. Mensagem de `sector.channel_provider_disabled`: `Só um número Evolution pode atender uma área.`. Mensagem de `channel.not_disabled`: `Esta conexão é Evolution: remova pelo menu da conexão.`.
- **GC8 — Autorização.**
  - `disabledChannels` só para `role === 'ADMIN'`; os demais papéis recebem `[]`.
  - `DELETE /whatsapp/channels/:id` e `PUT /whatsapp/channels/:id/sectors` seguem `@Roles('ADMIN')`.
  - Auditoria nova grava só ids e contagens.
- **GC9 — Contratos espelhados.** O back é a fonte (`backend/src/schemas/contracts/*.schema.ts`). O front copia os campos em `frontend/src/features/*/api.ts` ou `schemas.ts`, sem SDK.
- **GC10 — Erros no front.** Código lido só com `readApiErrorBody` (`frontend/src/lib/api-error.ts`). Specs simulam com `new HTTPError(new Response(JSON.stringify({ code, title }), { status }), new Request('https://x'), {} as never)`.
- **GC11 — Textos pt-BR exatos (front).**
  - Bloco: título `Números desligados`; linha `<nome>` · `<telefone>` · `Integração: <Provedor>` · `Áreas: <nomes separados por ", ">` ou `Nenhuma área`; botão `Remover`.
  - Confirmação com áreas: `Remover <nome>? As áreas <lista> ficam sem número até serem ligadas a um número Evolution. A conexão no <Provedor> não é apagada por aqui.`
  - Confirmação sem áreas: `Remover <nome>? A conexão no <Provedor> não é apagada por aqui.`
  - Botões `Remover` e `Cancelar`; toast de sucesso `Número removido`.
  - Chat: `Este número usa uma integração desligada (<Provedor>). Para responder, conecte um número Evolution em Conexões.`
  - Motivo de falha `channel.provider_disabled`: `Número de integração desligada`.
  - Novidade (R16): `O WhatsApp agora funciona só pela Evolution. Números de outras integrações aparecem em Conexões como desligados; ligue as áreas a um número Evolution.`
- **GC12 — Testes enxutos.**
  - Um teste por critério de aceite, mais os riscos do Review Focus.
  - Rota removida se prova com `routesOf(Controller)` (C2), e processor ou controller desregistrado, com `Reflect.getMetadata('providers' | 'controllers', Module)`. Nada de subir app HTTP só para ver 404.
  - Integração (testcontainers) só onde a query, a gravação ou o contrato externo mudam.
  - Front: `vi.mock` dos hooks de `api.ts`, sem msw.
- **GC13 — Sem extras.** Sem dependência npm nova, sem serviço novo no compose, sem componente novo em `frontend/src/components/ui/` e sem rota nova no front.
- **GC14 — Novidades.** Só a F5 mexe em `frontend/src/release-notes.ts`.
- **GC15 — Constantes da Evolution.**
  - Imagem: `evoapicloud/evolution-api@sha256:966625532d9076a2381e973a271307d107e6f070450de3abeeea8bd18be07252`.
  - Eventos do webhook: `['MESSAGES_UPSERT','MESSAGES_UPDATE','CONNECTION_UPDATE','QRCODE_UPDATED']`.
  - Intervalo de conferência do webhook: `10 * 60_000` ms por instância.

## Contratos compartilhados

- **C1 — `backend/src/shared/config/enabled-providers.ts` (B1).**
  ```ts
  export const ENABLED_CHANNEL_PROVIDERS = ['EVOLUTION'] as const satisfies readonly ChannelProvider[];
  export type EnabledChannelProvider = (typeof ENABLED_CHANNEL_PROVIDERS)[number];
  export function isEnabledChannelProvider(provider: ChannelProvider): boolean;
  export function skipsConnectionGate(provider: ChannelProvider): boolean; // D11: !isSessionProvider(provider) || !isEnabledChannelProvider(provider)
  export const PROVIDER_DISPLAY_NAME: Readonly<Record<ChannelProvider, string>>; // D10
  export const DISABLED_PROVIDER_ENV_KEYS: readonly string[]; // as 15 de D9, nesta ordem: META_ACCESS_TOKEN, META_PHONE_NUMBER_ID, META_APP_SECRET, META_WEBHOOK_VERIFY_TOKEN, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_WHATSAPP_FROM, TWILIO_MESSAGING_SERVICE_SID, ZERNIO_API_KEY, ZERNIO_BASE_URL, ZERNIO_WEBHOOK_SECRET, GOZAP_BASE_URL, GOZAP_ADMIN_TOKEN, GOZAP_WEBHOOK_TOKEN, GOZAP_TOKEN_ENCRYPTION_KEY
  export function ignoredProviderEnvKeys(env: Readonly<Record<string, unknown>>): string[]; // chaves com valor não vazio, na ordem acima
  export function ignoredProviderEnvMessage(keys: readonly string[]): string | null; // null se vazio; senão 'chaves de provedores desligados ignoradas: A, B'
  ```
  `backend/src/shared/errors/channel-provider-disabled.error.ts` (B1):
  ```ts
  export const PROVIDER_DISABLED_CODE = 'channel.provider_disabled';
  export class ChannelProviderDisabledError extends DomainError {
    constructor(provider: ChannelProvider, status: 409 | 422 = 409); // code PROVIDER_DISABLED_CODE, message GC7, detail `provider=${provider}`
  }
  ```
- **C2 — `backend/test/routes-of.ts` (B1).** `export function routesOf(controller: Type<unknown>): string[]` devolve `'<MÉTODO> /<path do handler>'`, sem o prefixo do controller (ex.: `'GET /zernio/accounts'`, `'DELETE /channels/:id'`), lendo `PATH_METADATA` e `METHOD_METADATA` de `@nestjs/common/constants`.
- **C3 — `GET /whatsapp/providers` (B3; o front espelha na F1).**
  - Resposta: `{ providers: ProviderGroup[]; disabledChannels: DisabledChannel[] }`.
    - `providers` só tem EVOLUTION.
    - `DisabledChannel = { id: string; name: string; provider: ChannelProvider; phoneE164: string | null; sectorNames: string[] }`, com canais `isActive` de provedor desligado ordenados por nome e áreas ativas ordenadas por nome.
  - Não-ADMIN recebe `disabledChannels: []`.
  - Front: `disabledChannels: z.array(disabledChannelSchema).default([])` (tolera a api antiga durante o deploy).
- **C4 — `DELETE /whatsapp/channels/:id` (B3), `@Roles('ADMIN')`, `@HttpCode(204)`** (hoje a rota responde 200, `controller:628-631`, sem `@HttpCode`).
  - Canal ativo de provedor desligado, tudo **na mesma transação**:
    - `isActive=false, isDefault=false`;
    - `Sector.channelId=null` das áreas ligadas;
    - `Message` com `instanceId = channelId` e `status in ['WAITING_INSTANCE','QUEUED']` → `status: 'FAILED'`, `errorCode: PROVIDER_DISABLED_CODE`, `errorMessage` = mensagem de GC7 com o nome de exibição. Mesmo padrão de `WhatsappInstancesService.delete` com `antiban.instance_deleted` (`whatsapp-instances.service.ts:316-325`: `updateMany` com `where { instanceId, status }` e `data { status, errorCode, errorMessage }`). Mensagem QUEUED ainda sem `instanceId` não é pega aqui; depois do remove o canal fica inativo e sem `isDefault`, então o roteador lança `campaign.default_instance_inactive` (router:74-79) e o `onFailed` grava FAILED com esse código (terminal, sem laço) — idem para QUEUED em voo cujo `errorCode` é sobrescrito (N1 da re-revisão; aceito e documentado).
    - Depois da transação, para cada `campaignId` distinto das mensagens falhadas, chamar `maybeCompleteCampaign` em best-effort (log em falha), para a campanha não ficar RUNNING (N2). Se injetar o serviço de campanhas criar ciclo de DI, usar a mesma função/serviço que o processor usa (`send-message.processor.ts:481-486`, `:553-557`) ou devolver BLOCKED com a evidência; teste: remove com a última WAITING_INSTANCE de uma campanha RUNNING → campanha avaliada.
  - Auditoria `channel.disabled_remove` com `{ channelId, provider, detachedSectorIds, failedMessages }` (`failedMessages` = contagem). Nenhuma chamada externa.
  - Inexistente ou inativo → 404 (`InstanceNotFoundError`, como hoje). EVOLUTION → 422 `channel.not_disabled`.
- **C5 — Webhook Evolution (B9),** em `backend/src/modules/whatsapp-providers/adapters/evolution-webhook-config.ts`:
  ```ts
  export const EVOLUTION_WEBHOOK_EVENTS = ['MESSAGES_UPSERT','MESSAGES_UPDATE','CONNECTION_UPDATE','QRCODE_UPDATED'] as const;
  export const EVOLUTION_CREATE_SETTINGS = { rejectCall: true, groupsIgnore: true, alwaysOnline: false, readMessages: false, readStatus: false, syncFullHistory: false } as const; // DV1
  export type ExpectedWebhook = { url: string; apikey: string | undefined };
  export type WebhookSetBody = { webhook: { enabled: true; url: string; headers?: { apikey: string }; byEvents: false; base64: false; events: string[] } };
  export type WebhookField = 'enabled' | 'url' | 'events' | 'headers.apikey';
  export function buildWebhookSetBody(expected: ExpectedWebhook): WebhookSetBody; // sem `headers` quando apikey undefined
  export function webhookDivergences(found: unknown, expected: ExpectedWebhook): WebhookField[];
  ```
  Regras de `webhookDivergences`:
  - aceita a forma plana ou `{ webhook: {...} }`; `null` ou não-objeto → os 4 campos;
  - `enabled !== true` diverge;
  - `url` diferente diverge;
  - `events` é comparado como conjunto (ordem não importa); não-array ou `[]` diverge;
  - `headers` pode vir objeto ou string JSON, e `headers.apikey` tem que ser igual a `expected.apikey` (ausente = ausente).

  Adapter: `ensureWebhookArmed(instanceName: string): Promise<{ status: 'ok' | 'rearmed' | 'failed'; fields: WebhookField[] }>` (nunca lança) e `adminDeleteInstance(instanceName: string): Promise<void>` (`DELETE /instance/delete/{name}`).
- **C6 — `EvolutionAdminClient` (B10)** (`whatsapp-instances.service.ts:31-35`) ganha `deleteInstance(instanceName: string): Promise<void>`.

## Review Focus

- **Repetíveis antigos no Redis** continuando a disparar sem consumidor (B8, teste com Redis real).
- **DI quebrando no boot** ao desregistrar processors e controllers (B12, mais o boot real no Fechamento).
- **Canal desligado virando "Situação incerta"** em vez de FAILED claro (B4 `failureStatus`, B7 processor e campanha).
- **Mensagem presa em WAITING_INSTANCE** num canal desligado sem evento de conexão novo (D11: B7 roteador, varredura e guard; B3 remoção falha as paradas).
- **Autorização:** `disabledChannels` e Remover só para ADMIN; ligar área a canal desligado recusado (B3, B4).
- **Re-arme em laço** por comparação errada do `find` (B9 tabela, B11 contra a imagem).
- **`apikey` em log** pelo objeto de erro do axios ou pelo diff do webhook (B9, B10, B1).
- **Escopo persistido `GOZAP`** deixando listas vazias depois que o seletor sai (F3).

---

## Task B1 — Constante única, erro e validação de env (back)

**Files:**
- Create: `backend/src/shared/config/enabled-providers.ts`, `enabled-providers.spec.ts`; `backend/src/shared/errors/channel-provider-disabled.error.ts`; `backend/test/routes-of.ts`.
- Modify: `backend/src/shared/config/env.schema.ts` (superRefine `:528-550`; validadores das chaves desligadas), `env.schema.spec.ts`.

**Interfaces:**
- Consumes: `DomainError` (`backend/src/shared/errors/domain.error.ts`, construtor `{ code, message, status, detail }`, como `ProviderNotConfiguredError` em `provider-registry.service.ts:10-19`).
- Produces: C1 e C2.

**Contexto vinculado:**
- R2: o grupo Evolution completo (`EVOLUTION_BASE_URL`, `EVOLUTION_API_KEY`, `EVOLUTION_INSTANCE_NAME`) é obrigatório. Chaves de desligados, completas ou parciais, não derrubam o boot e viram um aviso com os nomes, nunca os valores.
- GC6: nenhum log contém valor de env; o aviso leva só nomes.
- D9: o aviso usa só as 15 chaves que definem grupo (lista exata em C1) e é logado pela B2, não aqui.
- D11: `skipsConnectionGate(provider)` = `!isSessionProvider(provider) || !isEnabledChannelProvider(provider)` (`isSessionProvider` de `schemas/contracts/channel-provider.schema.ts:93`); canal desligado não passa pelo gate de conexão, para não ficar parado em WAITING_INSTANCE. Consumida pela B7.
- GC4: `isEnabledChannelProvider` não é type guard.

**Steps:**
1. RED `enabled-providers.spec.ts`:
   - `it('ENABLED_CHANNEL_PROVIDERS é só EVOLUTION')`.
   - `it.each` de `isEnabledChannelProvider`: EVOLUTION true; GOZAP, ZERNIO, TWILIO e META false.
   - `it.each` de `skipsConnectionGate`: EVOLUTION false; GOZAP true (sessão, mas desligado); ZERNIO, TWILIO e META true.
   - `it('ignoredProviderEnvKeys lista só chaves desligadas com valor, na ordem fixa')`: entrada com `GOZAP_BASE_URL`, `ZERNIO_API_KEY: ''` e `EVOLUTION_API_KEY` → `['GOZAP_BASE_URL']`.
   - `it('ignoredProviderEnvMessage não contém valores')`: monta com chaves cujos valores são `'segredo-x'` e espera que a mensagem não contenha `segredo-x`; com `[]` → `null`.
   - `it('ChannelProviderDisabledError: 409 por padrão, 422 quando pedido, code channel.provider_disabled, mensagem com o nome de exibição')`: `new ChannelProviderDisabledError('GOZAP')` → mensagem `Este número usa uma integração desligada (GoZap).`.
2. RED `env.schema.spec.ts` (`describe` novo, `'grupo Evolution obrigatório (R2)'`):
   - sem `EVOLUTION_API_KEY`, o parse falha com mensagem contendo `grupo Evolution é obrigatório`;
   - Evolution completo + GOZAP completo + ZERNIO parcial passa;
   - Evolution completo + `GOZAP_TOKEN_ENCRYPTION_KEY` malformada passa e a chave vira `undefined`.
   - Os casos antigos de "partially configured" e "At least one WhatsApp provider group" dos desligados são removidos ou ajustados.
3. GREEN:
   - Mensagem da issue: `O grupo Evolution é obrigatório: defina EVOLUTION_BASE_URL, EVOLUTION_API_KEY e EVOLUTION_INSTANCE_NAME`.
   - Os validadores de formato das chaves desligadas ganham `.catch(undefined)` (o tipo continua `string | undefined`).
   - `configuredProviderGroups` continua exportado, sem mudança.
4. `routesOf`, sem spec própria: é coberto pelos usos em B3, B5 e B6.
5. Verificação: `timeout 600 gate --test src/shared/config/enabled-providers.spec.ts`, `timeout 600 gate --test src/shared/config/env.schema.spec.ts`, `npm run build`, `timeout 600 gate --changed --base origin/main`.

**Risco: crítico (segredo/credencial)**: mexe na validação das chaves de credencial e define o texto do aviso que vai a log; o valor nunca pode vazar.

## Task B2 — Registry e módulo só com Evolution (back)

**Depends on:** B1.

**Files:**
- Modify: `backend/src/modules/whatsapp-providers/provider-registry.service.ts` (+ spec), `whatsapp-providers.module.ts` (+ spec do módulo, se existir; senão `whatsapp-providers.module.spec.ts` novo). Também `campaigns/campaigns.module.queues.spec.ts`, só se quebrar.

**Interfaces:**
- Consumes: C1 (`ENABLED_CHANNEL_PROVIDERS`, `ignoredProviderEnvKeys`, `ignoredProviderEnvMessage`, `ChannelProviderDisabledError`).
- Produces:
  - `ProviderRegistry.forChannel(ch: Pick<Channel,'provider'>): MessageProvider`. Provider desligado lança `ChannelProviderDisabledError(ch.provider)` (409). Ligado e sem adapter lança `ProviderNotConfiguredError`, como hoje.
  - `forProvider(desligado)` → `null`.
  - `configured()` → `['EVOLUTION']`.
  - `registryProvider`: `inject: [ConfigService, EvolutionApiAdapter]`, `new ProviderRegistry(new Map([['EVOLUTION', evolution]]))`, e chama `new Logger('ProviderRegistry').warn(msg)` uma vez quando `ignoredProviderEnvMessage(ignoredProviderEnvKeys(envSnapshot(config)))` não é `null`.
  - `legacyProvider` (`MESSAGE_PROVIDER`): `inject: [EvolutionApiAdapter]` → evolution.
  - O módulo **deixa de registrar** `GozapConnectionReconcilerProcessor`, `TwilioTierSyncProcessor`, `ZernioBroadcastSyncProcessor` (providers) e `ZernioBroadcastSyncController` (controllers). Os adapters Meta/Twilio/Zernio/GoZap, os serviços e os dois `registerQueue` ficam (D3).

**Contexto vinculado:**
- R1: o `ProviderRegistry` e o `MESSAGE_PROVIDER` só montam a Evolution, mesmo com env de outros provedores.
- R8: nenhum `@Processor` das filas `zernio.*`, `gozap.connection-reconciler` e `twilio.tier-sync`. Serviço exclusivo injetado em código compartilhado pode continuar como provider, desde que não seja processor nem controller.
- D2: o `forChannel` desligado → 409 `channel.provider_disabled` cobre todo envio síncrono.
- GC6: o aviso leva só nomes.
- GC5: os arquivos desregistrados não são apagados.

**Steps:**
1. RED `provider-registry.service.spec.ts`:
   - `it.each(['GOZAP','ZERNIO','TWILIO','META'])('forChannel(%s) lança ChannelProviderDisabledError 409')`;
   - `it('forChannel(EVOLUTION) devolve o adapter')`.
2. RED, spec do módulo:
   - `it('env com GOZAP e EVOLUTION completos: registry.configured() é [EVOLUTION] e o warn sai uma vez com GOZAP_BASE_URL, sem valores')`, com factory chamada direto e `ConfigService` stub;
   - `it('MESSAGE_PROVIDER é o EvolutionApiAdapter')`;
   - `it('módulo não registra processors nem controller dos desligados')`, via `Reflect.getMetadata('providers' | 'controllers', WhatsappProvidersModule)`.
3. GREEN conforme as Interfaces. Remover `PROVIDER_ENV_KEYS` se não restar uso; `envSnapshot` passa a ler `DISABLED_PROVIDER_ENV_KEYS`.
4. Verificação: `timeout 600 gate --test` em cada spec tocada, `npm run build`, `timeout 600 gate --changed --base origin/main`.

**Risco: alto**: arquitetura e DI do módulo central de envio. O boot real fica na B12 e no Fechamento.

## Task B3 — `GET /whatsapp/providers`, rotas removidas e remoção de canal desligado (back)

**Depends on:** B2 (`whatsapp-providers.module.ts`).

**Files:**
- Create: `backend/src/modules/whatsapp-providers/disabled-channels.service.ts`; `disabled-channels.service.integration.spec.ts` (padrão de `sector-channel.integration.spec.ts`: `PostgreSqlContainer('postgres:16-alpine')`, `describe.skipIf(!TESTCONTAINERS_ENABLED)`).
- Modify:
  - `whatsapp-providers.controller.ts` (+ `whatsapp-providers.controller.spec.ts`);
  - `whatsapp-providers.module.ts` (registrar `DisabledChannelsService`);
  - `backend/src/schemas/contracts/instance.schema.ts` (`disabledChannelSchema`, `disabledChannels` em `ProvidersResponse`).

**Interfaces:**
- Consumes: C1 (`PROVIDER_DISABLED_CODE`, `PROVIDER_DISPLAY_NAME`, `isEnabledChannelProvider`), C2; `PrismaService`; o serviço de auditoria usado por `SectorChannelService` (mesmo import e `audit.log(action, entity, id, payload)`); `AuthRequest` (como em `createChannel`, `controller:363`; o id do usuário é `req.user.sub`, `controller:378`, `:596`); `InstanceNotFoundError`.
- Produces:
  ```ts
  export type DisabledChannel = { id: string; name: string; provider: ChannelProvider; phoneE164: string | null; sectorNames: string[] };
  @Injectable() export class DisabledChannelsService {
    listDisabled(): Promise<DisabledChannel[]>; // C3
    remove(input: { channelId: string; actorId: string }): Promise<{ channelId: string; detachedSectorIds: string[]; failedMessages: number }>; // C4, uma transação
  }
  ```
- Controller:
  - `providers(@Req() req: AuthRequest)` acrescenta `disabledChannels`: ADMIN → `listDisabled()`, senão `[]`. Também no retorno antecipado de `configured.length === 0`.
  - `createChannel`: primeira linha `if (body.provider !== 'EVOLUTION') throw new ChannelProviderDisabledError(body.provider, 422)`; para EVOLUTION, a recusa atual.
  - `removeChannel` (`:628-631`, hoje `gozapInstances.remove(id)`, 200): passa a `@Delete('channels/:id') @HttpCode(204) async removeChannel(@Param('id') id: string, @Req() req: AuthRequest): Promise<void>` → `disabledChannels.remove({ channelId: id, actorId: req.user.sub })`.
  - **Removidas:** `GET zernio/accounts` (`:316-318`), `GET channels/health` (`:344-346`, DV2), `GET channels/:id/qr` (`:608-611`) e o método privado `createGozapChannel` (`:564`).
  - O construtor deixa de injetar `ZernioAccountsService`, `ChannelHealthService` e `GozapInstancesService`, mas eles continuam providers do módulo.

**Contexto vinculado:**
- R3: `GET /whatsapp/providers` só devolve EVOLUTION; `disabledChannels` (`{ id, name, provider, phoneE164, sectorNames }`) só para ADMIN, `[]` para os demais papéis.
- R4: criar canal com provider ≠ EVOLUTION → 422 `channel.provider_disabled`.
- R5: `GET /whatsapp/zernio/accounts` e `GET /whatsapp/channels/:id/qr` deixam de existir.
- R6: `DELETE /whatsapp/channels/:id` (só ADMIN) remove canal desligado: soft-delete local, desassocia as áreas, nenhuma API externa.
- C4: na mesma transação, `Message` do canal com `status in ['WAITING_INSTANCE','QUEUED']` → FAILED, `errorCode: 'channel.provider_disabled'`, `errorMessage` de GC7; padrão de `whatsapp-instances.service.ts:316-325`. Resposta 204 (`@HttpCode(204)`; hoje 200).
- D11: sem isso as paradas do canal removido ficariam em WAITING_INSTANCE para sempre (a varredura não solta canal inativo, `reconnect-replay.service.ts:79-84`, e a adoção exige canal ativo do mesmo provider, `:108-119`).
- GC7: `channel.not_disabled` 422 para EVOLUTION nessa rota.
- GC8: auditoria só com ids e contagens.
- DV2: `GET /whatsapp/channels/health` também sai.

**Steps:**
1. RED controller spec (`describe` novos):
   - `it('GET providers: ADMIN recebe disabledChannels do serviço')`;
   - `it.each(['SUPERVISOR','OPERATOR'])('GET providers: %s recebe disabledChannels []')`;
   - `it('GET providers: canais GOZAP do banco não aparecem em providers')`, com registry `configured()` = `['EVOLUTION']` e `listAll` devolvendo um GOZAP;
   - `it('POST channels com provider GOZAP → 422 channel.provider_disabled e nada é criado')`;
   - `it('rotas removidas')`: `routesOf(WhatsappProvidersController)` não contém `GET /zernio/accounts`, `GET /channels/health` nem `GET /channels/:id/qr`;
   - `it('DELETE channels/:id exige ADMIN, responde 204 e delega a DisabledChannelsService.remove com actorId = req.user.sub')` (204 via `Reflect.getMetadata(HTTP_CODE_METADATA, …)`).
   - Ajustar ou remover os casos antigos de GoZap e Zernio desse spec, inclusive `:729-734`.
2. RED integração:
   - `it('listDisabled: só canais ativos de provedor desligado, áreas ativas por nome')`;
   - `it('remove GOZAP: canal inativo, áreas com channelId null, auditoria com ids')` (cenário 5);
   - `it('remove → paradas viram FAILED')`: mensagens WAITING_INSTANCE e QUEUED do canal viram FAILED `channel.provider_disabled`; SENT do mesmo canal e WAITING_INSTANCE de outro canal não mudam; `failedMessages` = 2;
   - `it('remove EVOLUTION → 422 channel.not_disabled e nada muda')`;
   - `it('remove canal já inativo → 404')`.
3. GREEN.
4. Verificação: `timeout 600 gate --test src/modules/whatsapp-providers/whatsapp-providers.controller.spec.ts`, `TESTCONTAINERS_ENABLED=1 timeout 600 gate --test src/modules/whatsapp-providers/disabled-channels.service.integration.spec.ts`, `npm run build`, `timeout 600 gate --changed --base origin/main`.

**Risco: crítico (autorização)**: `disabledChannels` e a remoção são só do ADMIN; a remoção grava no banco.

## Task B4 — Área com canal desligado = sem número; team processor (back)

**Depends on:** B1.

**Files (Modify, + specs ao lado):**
- `backend/src/modules/team-whatsapp/team-whatsapp.policy.ts`;
- `team-whatsapp.outcome.ts`;
- `team-whatsapp-send.processor.ts` (`:271-273`);
- `team-whatsapp.repository.ts` (`failUnavailable`, `:874-895`);
- `team-whatsapp.test-fixtures.ts` (`:121`, `provider: 'GOZAP'` → `'EVOLUTION'`: com `TeamProvider = 'EVOLUTION'` o literal quebra o tsc; o default da fixture passa a ser EVOLUTION, e caso que precisa de GOZAP sobrescreve);
- `team-whatsapp.service.channels.spec.ts` (só casos novos, M5);
- `sector-channel.spec.ts` (team, só casos novos);
- `backend/src/modules/whatsapp-providers/sector-channel.service.ts` (`assertTeamChannel`, `:164-171`) + `sector-channel.integration.spec.ts`;
- `backend/src/modules/whatsapp-providers/channel-live-state.service.ts` (`:49`, `:105`) + spec.

**Interfaces:**
- Consumes: C1 (`ENABLED_CHANNEL_PROVIDERS`, `PROVIDER_DISABLED_CODE`).
- Produces:
  - `TEAM_PROVIDERS = ENABLED_CHANNEL_PROVIDERS`; `TeamProvider = EnabledChannelProvider`; `isTeamProvider` sem mudança de assinatura.
  - `NOT_REPEATABLE_CODES` ganha `'channel.provider_disabled'`.
  - `failureStatus(code, redispatchable)` devolve `'FAILED'` quando `code === PROVIDER_DISABLED_CODE`, antes das demais regras.
  - Team processor: canal ativo de provedor desligado → `{ status: 'FAILED', errorCode: 'channel.provider_disabled' }`; inexistente ou inativo segue `team_whatsapp.channel_invalid`.
  - `failUnavailable(tx, dispatchId): Promise<number>` (`team-whatsapp.repository.ts:874-895`; hoje filtra `!channel?.isActive || !isTeamProvider(channel.provider)` e faz **um** `updateMany` com `errorCode: CHANNEL_UNAVAILABLE`) faz a mesma distinção com **dois** `updateMany` escopados a `status: 'SCHEDULED'`: ids com canal ausente ou inativo → `CHANNEL_UNAVAILABLE` (como hoje); ids com canal ativo de provedor desligado → `PROVIDER_DISABLED_CODE`. Assinatura e retorno (soma das duas contagens) não mudam; o `updateMany` vazio é pulado.
  - `SectorChannelService.assertTeamChannel`: canal ativo de provedor desligado → `DomainError` 422 `sector.channel_provider_disabled` (mensagem GC7); inativo segue `channel.sectors_not_team`.
  - `ChannelLiveStateService`: provider ≠ EVOLUTION → estado `'unknown'`, sem chamada externa. Sai o ramo GOZAP (`:105`) e a injeção de `GozapInstancesService` deste serviço.

**Contexto vinculado:**
- R9: canal desligado não envia; mensagem já enfileirada → FAILED com `errorCode = 'channel.provider_disabled'`, sem retry; no envio da equipe o código entra em `NOT_REPEATABLE_CODES`.
- R10: área com canal desligado conta como sem número (aviso em Conexões, selo em Setores, 422 `team_whatsapp.sector_without_number` no envio); ligar área a canal não-EVOLUTION → 422 `sector.channel_provider_disabled`.
- D1: `effectiveChannel` herda a regra via `TEAM_PROVIDERS`; `teamProviderSchema` fica `['GOZAP','EVOLUTION']`.
- D2: `channel.provider_disabled` nunca vira `UNCERTAIN`.

**Steps:**
1. RED:
   - `team-whatsapp.policy.spec.ts:92-93` passa a esperar `['EVOLUTION']`;
   - `sector-channel.spec.ts`: `it('canal GOZAP ativo → sem número (cenário 4)')`;
   - `team-whatsapp.service.channels.spec.ts` (M5): `it('prévia com área ligada a canal GOZAP ativo → 422 team_whatsapp.sector_without_number')` e `it('POST com área ligada a canal GOZAP ativo → 422 team_whatsapp.sector_without_number e nada é gravado')`;
   - `failUnavailable` (spec do repositório que já cobre `channel_unavailable`; localizar por grep `CHANNEL_UNAVAILABLE` nos specs): `it('SCHEDULED com canal GOZAP ativo → FAILED channel.provider_disabled; com canal inativo → channel_unavailable')`;
   - `team-whatsapp.outcome.spec.ts`: `it('channel.provider_disabled é FAILED mesmo com redispatchable falso')` e `it('channel.provider_disabled não é repetível')`;
   - `team-whatsapp-send.processor.spec.ts:214`: a linha `'fora de TEAM_PROVIDERS'` (TWILIO ativo) passa a esperar `channel.provider_disabled`, e o caso de canal inativo continua `channel_invalid`;
   - `sector-channel.integration.spec.ts`: `it('PUT sectors em canal GOZAP ativo → 422 sector.channel_provider_disabled')`; o caso `:208-221` de canal inativo continua `channel.sectors_not_team`;
   - `channel-live-state.service.spec.ts`: `it('canal GOZAP → unknown sem chamada externa')`.
2. GREEN.
3. `npm run build`, para pegar comparações com `'GOZAP'` sobre `TeamProvider`. Corrigir só dentro dos arquivos desta task; se o tsc acusar arquivo de outra task, parar e reportar.
4. Verificação: `timeout 600 gate --test` em cada spec, `TESTCONTAINERS_ENABLED=1 timeout 600 gate --test src/modules/whatsapp-providers/sector-channel.integration.spec.ts`, `timeout 600 gate --changed --base origin/main`.

**Risco: alto**: anti-objetivo de envio por número errado ou "Situação incerta" falsa. Não é gate de acesso: as rotas seguem com os mesmos `@Roles`.

## Task B5 — Webhooks, inbox Zernio e métricas Zernio fora do ar (back)

**Depends on:** B1 (consome `routesOf`, C2, criado em `backend/test/routes-of.ts`).

**Files (Modify, + specs):**
- `backend/src/modules/webhooks/webhooks.module.ts` (`:28-33`);
- `webhooks.controller.ts` (GET `:121`; ramo META `:163`; `detectProvider` `:54-57`);
- `webhooks.integration.spec.ts`, só se ele exercitar rotas removidas;
- `backend/src/modules/chat/chat.module.ts` (`:28`);
- `backend/src/modules/metrics/metrics.controller.ts` (`:42-56`; sai a injeção de `ZernioMetricsService`, que fica provider em `metrics.module.ts`).

**Interfaces:**
- Consumes: C2.
- Produces:
  - `WebhooksModule.controllers = [WebhooksController]`;
  - `ChatModule` sem `ZernioInboxSyncController`;
  - `WebhooksController` sem handler `@Get()`;
  - no `@Post()`, `detectProvider(body) === 'META'` → `throw new NotFoundException()` **antes** de qualquer checagem de assinatura ou auditoria;
  - o fluxo Evolution (apikey em tempo constante, `:172-199`) não muda;
  - `MetricsController` sem `GET zernio`.

**Contexto vinculado:**
- R5: deixam de existir (404) `POST /webhooks/twilio`, `POST /webhooks/zernio`, `POST /webhooks/gozap`, `GET /webhooks/whatsapp` (handshake Meta), `POST`/`GET /whatsapp/channels/:id/sync-inbox`, `POST /whatsapp/zernio/sync-broadcasts` (B2), `GET /whatsapp/zernio/indeterminate-deliveries` (B2) e `GET /metrics/zernio`.
- R5: `POST /webhooks/whatsapp` aceita só payload Evolution; payload Meta → 404.
- Cenário 11: `POST /webhooks/gozap` → 404; Evolution válido segue como hoje.
- GC5: os arquivos dos controllers ficam no repositório.

**Steps:**
1. RED:
   - `webhooks.controller.spec.ts`: `it('POST com payload Meta (object whatsapp_business_account) → 404 sem auditar rejeição')` e `it('rotas: sem GET /')` (`routesOf`); os testes Evolution existentes continuam verdes;
   - `it('WebhooksModule só registra WebhooksController')` (metadata);
   - `it('ChatModule não registra ZernioInboxSyncController')`;
   - `metrics.controller.spec.ts`: `routesOf(MetricsController)` sem `GET /zernio`.
   - Remover os testes do handshake Meta.
2. GREEN.
3. Verificação: `timeout 600 gate --test` nas specs tocadas, `npm run build`, `timeout 600 gate --changed --base origin/main`.

**Risco: crítico (entrada de rota pública)**: mexe no `POST /webhooks/whatsapp`, rota pública autenticada por apikey.

## Task B6 — Templates só Evolution (back)

**Depends on:** B1.

**Files (Modify, + specs):** `backend/src/modules/templates/templates.controller.ts`, `templates.service.ts` (`list`, `:118`), `templates.repository.ts` (`listAll`, `:60-62`), `templates.module.ts` (`:26-30`).

**Interfaces:**
- Consumes: C1, C2.
- Produces:
  - `TemplatesRepository.listAll(providers: readonly ChannelProvider[]): Promise<Template[]>`, com where `{ provider: { in: [...providers] } }`;
  - `TemplatesService.list(provider?: ChannelProvider)`: provider desligado → `[]`; com provider ligado → `listAll([provider])`; sem provider → `listAll(ENABLED_CHANNEL_PROVIDERS)`;
  - rotas removidas: `POST /sync` (Meta, DV2), `POST /sync/zernio`, `POST /zernio`, `POST /twilio`, `POST /:id/twilio-submit`, `PATCH /:id/twilio-draft`;
  - `TemplatesModule` deixa de registrar `ZernioTemplateSyncProcessor`; `TemplateApprovalSyncProcessor` fica (DV3).
  - Os métodos do service ficam (GC5).

**Contexto vinculado:**
- R5: saem as rotas de criar, sincronizar ou enviar templates Twilio e Zernio.
- R12: templates de provedores desligados saem da lista e ficam só no banco.
- R8: nenhum `@Processor` de `templates.zernio-sync`.
- DV3: `template-approval-sync` só perde o cron (B8).

**Steps:**
1. RED:
   - `templates.service.spec.ts`: `it('list() pede só EVOLUTION')` e `it("list('ZERNIO') → [] sem consultar o banco")`;
   - `templates.controller.spec.ts`: `routesOf` sem as 6 rotas;
   - `it('TemplatesModule não registra ZernioTemplateSyncProcessor')`.
2. GREEN. Ajustar os specs antigos das rotas removidas, removendo os casos.
3. Verificação: `timeout 600 gate --test` nas specs, `npm run build`, `timeout 600 gate --changed --base origin/main`.

**Risco: médio**: contrato público de listagem; nada de dinheiro, autenticação ou dado irreversível.

## Task B7 — Guards de envio: roteador, fila, campanha e chat (back)

**Depends on:** B1.

**Files (Modify, + specs):**
- `backend/src/modules/queue/send-message.processor.ts`;
- `backend/src/modules/whatsapp-instances/whatsapp-instance-router.service.ts` (`isInstanceOnline`, `:105-114`);
- `backend/src/modules/whatsapp-instances/reconnect-replay.service.ts` (`sweepParked`, `:65`);
- `backend/src/modules/campaigns/campaigns.service.ts` (`:2257-2260`, `create`, `run` `:1869`);
- `backend/src/modules/chat/chat.service.ts` (o método de resposta que chega a `:444-469`).

**Interfaces:**
- Consumes: C1 (`isEnabledChannelProvider`, `skipsConnectionGate`, `ChannelProviderDisabledError`, `PROVIDER_DISABLED_CODE`).
- Produces:
  - **Roteador (D11):** `isInstanceOnline(instance)` troca `if (!isSessionProvider(instance.provider)) return true` por `if (skipsConnectionGate(instance.provider)) return true`. Canal desligado nunca vira `kind: 'waiting'`; `resolveForSend` mantém a assinatura.
  - **Varredura (D11):** `sweepParked` troca `!isSessionProvider(canal.provider)` (`:65`) por `skipsConnectionGate(canal.provider)`, a mesma regra do roteador (comentário `:61-64`). WAITING_INSTANCE de canal desligado **ativo** é solta (`replayWaitingFor`) e o processor a falha; canal inativo continua não sendo despertado (`:79-84`).
  - **Processor:** **um** guard, logo depois do bloco de reset/re-resolve (`:642-672`, quando `instance` já é o final, vindo de `routed.instance` ou de `freshRouted.instance`), antes da janela de envio, do throttle ZA4 (`:807-814`), da reserva de cota e de qualquer chamada ao adapter: `if (!isEnabledChannelProvider(instance.provider))` → marca a `Message` FAILED com `errorCode: PROVIDER_DISABLED_CODE`, usando o mesmo caminho de finalização terminal que o ramo de timeout indeterminado (`:1128-1150`) usa, para contadores e eventos de campanha iguais. A linha ainda está QUEUED (pré-claim, como no ramo `waiting`, `:586-588`): a gravação é escopada a `status: 'QUEUED'` e, com 0 linhas (já reivindicada ou já FAILED pela remoção, C4), só `return`. Depois `return`: não lança, sem retry.
  - **Campanha:**
    - `useBroadcast` ganha `isEnabledChannelProvider(channel.provider) &&` como primeiro termo;
    - `create()` e `run()` lançam `ChannelProviderDisabledError(provider)` (409) quando o canal da campanha (`defaultInstanceId`) é de provedor desligado;
    - `runScheduled` **não** lança: enfileira, e o processor falha cada mensagem com o motivo.
  - **Chat:** no método de resposta, primeira checagem depois de carregar a conversa: `if (!isEnabledChannelProvider(conv.instance.provider)) throw new ChannelProviderDisabledError(conv.instance.provider)`, antes do helper GOZAP (`:444-451`) e de `supportsInboxChatFor` (`:468`).

**Contexto vinculado:**
- R9: tentativa síncrona → `channel.provider_disabled` (409); mensagem já enfileirada → FAILED com esse código, sem nova tentativa.
- R12: campanha agendada em canal desligado falha no disparo com `channel.provider_disabled`, e o motivo aparece no resultado.
- Cenário 7: mensagem QUEUED num canal GoZap → FAILED `channel.provider_disabled`, não reenfileirada.
- D2: hoje o registry dá 400 `provider_not_configured`, e o processor cai no catch genérico.
- D11: o canal só é conhecido depois do roteador (`:580-606`); os ramos `waiting` (`:585-604`, `:657-670`) retornam antes de qualquer guard, e `isInstanceOnline` exige evento `open` para GOZAP (sessão). Por isso o roteador e a varredura tratam canal desligado como sempre alcançável, e o guard fica depois do re-resolve. `isSessionProvider` não muda (anti-ban, `:619`).
- GC4: `isEnabledChannelProvider` não é type guard, e o `=== 'ZERNIO'` existente continua compilando.

**Steps:**
1. RED:
   - `whatsapp-instance-router.service.spec.ts`: `it('canal GOZAP ativo com último evento close → kind send (sem gate de conexão)')` e `it('canal EVOLUTION com último evento close → waiting (sem mudança)')`;
   - `reconnect-replay.service.spec.ts`: `it('sweepParked solta WAITING_INSTANCE de canal GOZAP ativo mesmo com último evento close')` e `it('canal GOZAP inativo não é despertado')`;
   - `send-message.processor.spec.ts`:
     - `it('mensagem QUEUED em canal GOZAP → FAILED channel.provider_disabled, sem chamar adapter e sem lançar')`;
     - `it('GOZAP último evento close → FAILED')`: roteador real (ou com `isInstanceOnline` real) sobre canal GOZAP cujo último evento é `close` → a mensagem vira FAILED `channel.provider_disabled`, não WAITING_INSTANCE;
     - `it('re-resolve pós-reset devolve canal GOZAP → FAILED channel.provider_disabled')` (`sentTodayResetAt` com mais de 24 h);
     - `it('linha já fora de QUEUED → guard não grava e retorna')`;
     - `it('canal ZERNIO não passa pelo throttle ZA4')`.
   - `campaigns.service.spec.ts`:
     - `it('dispatchAudience em canal ZERNIO com broadcast ligado não usa a fila de broadcast')`;
     - `it('run() em canal GOZAP → 409 channel.provider_disabled')`;
     - `it('create() com canal GOZAP → 409')`.
   - `chat.service.spec.ts`: `it('responder conversa de canal GOZAP → 409 channel.provider_disabled e nada é enviado')`.
2. GREEN.
3. Verificação: `timeout 600 gate --test` nas 5 specs, `npm run build`, `timeout 600 gate --changed --base origin/main`.

**Risco: alto**: caminho de envio em massa; o anti-objetivo é FAILED claro em vez de mensagem presa ou "Situação incerta". Não toca cobrança: o guard roda antes da reserva de cota.

## Task B8 — Worker sem crons dos desligados e limpeza dos repetíveis (back)

**Depends on:** nada (usa `QUEUE_NAMES`).

**Files:**
- Create: `backend/src/modules/queue/disabled-provider-queues.ts`, `disabled-provider-queues.spec.ts`, `disabled-provider-queues.integration.spec.ts` (`RedisContainer('redis:7-alpine')`, padrão de `auth/refresh.service.integration.spec.ts`).
- Modify:
  - `backend/src/worker.ts`: saem os blocos de `TOKEN_CHECK` `:182-199`, GOZAP `:287-295`, `TEMPLATE_APPROVAL_SYNC` `:356-364`, `TWILIO_TIER_SYNC` `:381-389`, `ZERNIO_TIER_SYNC` `:404-412`, `ZERNIO_TEMPLATE_SYNC` `:428-436`, `ZERNIO_INBOX_SYNC` `:450-458` e `ZERNIO_BROADCAST_SYNC` `:472-497`;
  - `backend/src/worker.module.ts` (`:19-31`, `:89-118`).

**Interfaces:**
- Produces:
  ```ts
  export const DISABLED_PROVIDER_QUEUES = [QUEUE_NAMES.TOKEN_CHECK, QUEUE_NAMES.GOZAP_CONNECTION_RECONCILER, QUEUE_NAMES.TEMPLATE_APPROVAL_SYNC, QUEUE_NAMES.TWILIO_TIER_SYNC, QUEUE_NAMES.ZERNIO_TIER_SYNC, QUEUE_NAMES.ZERNIO_TEMPLATE_SYNC, QUEUE_NAMES.ZERNIO_INBOX_SYNC, QUEUE_NAMES.ZERNIO_BROADCAST_SYNC] as const;
  export type RepeatableQueue = Pick<Queue, 'getRepeatableJobs' | 'removeRepeatableByKey'>;
  export function purgeDisabledProviderRepeatables(getQueue: (name: string) => RepeatableQueue): Promise<{ removed: Record<string, number>; failed: string[] }>; // try/catch por fila, com o getQueue(name) DENTRO do try; idempotente
  ```
- `getQueue(name)` é chamado dentro do try/catch de cada fila: token de fila ausente (`app.get` lança) vai para `failed` e não derruba as demais.
- `getRepeatableJobs`/`removeRepeatableByKey` levam supressão pontual de S1874 com a justificativa de D7 (API depreciada de propósito: os repetíveis foram criados no formato legado `add` + `repeat` + `jobId`). Usar o formato de supressão que o projeto já usa (grep `S1874`/`NOSONAR` em `backend/src`); sem precedente, `// NOSONAR(S1874): <justificativa>`.
- Em `worker.ts` (`bootstrap`), em try/catch, chamar `purgeDisabledProviderRepeatables((n) => app.get<Queue>(getQueueToken(n)))`. Log `log` quando a soma de `removed` for > 0; `warn` com os nomes de `failed`.
- `WorkerModule` deixa de registrar `CheckTokenExpiryProcessor`, `ZernioInboxSyncProcessor`, `ZernioTierSyncProcessor`, `ZernioBroadcastSendService`, `ZernioBroadcastPollService` e `ZernioBroadcast{Dispatch,Poll,Cancel}Processor`.

**Contexto vinculado:**
- R7: o worker não agenda `gozap-connection-reconciler-tick`, `twilio.tier-sync`, `zernio.tier-sync`, `templates.zernio-sync`, `zernio.inbox-sync`, `zernio.broadcast-sync`, `zernio-analytics-sync-tick`, `token-expiry-check` nem `template-approval-sync`; os repetíveis antigos no Redis são removidos no boot, de forma idempotente.
- R8: nenhum `@Processor` de `zernio.*`, `whatsapp.check-token-expiry` etc.
- D7: `getRepeatableJobs` + `removeRepeatableByKey`, sem `drain`. As duas estão depreciadas no BullMQ 5.76, mas existem e são as que enxergam o formato legado `add(name, data, { repeat, jobId })` do `worker.ts`; `upsertJobScheduler`/`removeJobScheduler` não servem. Supressão de S1874 justificada.
- GC5: os arquivos ficam.

**Steps:**
1. **Antes de apagar os blocos**, copiar de `worker.ts` o `name`, o `repeat` e o `jobId` exatos de cada `add` removido para a tabela do teste de integração.
2. RED unit:
   - `it('remove todos os repetíveis de cada fila desligada e devolve a contagem')`, com fake;
   - `it('falha numa fila não impede as demais; nome vai para failed')`;
   - `it('getQueue lançando para uma fila → nome em failed, demais seguem')`;
   - `it('WorkerModule não registra processors dos desligados')` (metadata).
3. RED integração:
   - `it('cenário 3: repetíveis semeados como o worker antigo somem; o repetível do CONNECTION_RECONCILER fica')`, conferindo também `getDelayedCount() === 0` em cada fila de `DISABLED_PROVIDER_QUEUES` (o próximo job do repetível não fica para trás) e `> 0` na do reconciliador;
   - `it('segunda execução remove 0 (idempotente)')`.
4. GREEN. Se a integração mostrar que `getRepeatableJobs` não enxerga a chave, trocar por `removeRepeatable` com as triplas do passo 1 (D7) e registrar no relatório.
5. Verificação: `timeout 600 gate --test src/modules/queue/disabled-provider-queues.spec.ts`, `TESTCONTAINERS_ENABLED=1 timeout 600 gate --test src/modules/queue/disabled-provider-queues.integration.spec.ts`, `npm run build`, `timeout 600 gate --changed --base origin/main`.

**Risco: alto**: mexe no Redis de produção no boot (só chaves de repetível de filas exclusivas dos desligados, sem apagar jobs).

## Task B9 — Adapter Evolution: webhook conferido, criação com settings, delete (back)

**Depends on:** nada.

**Files:**
- Create: `backend/src/modules/whatsapp-providers/adapters/evolution-webhook-config.ts`, `evolution-webhook-config.spec.ts`.
- Modify: `adapters/evolution-api.adapter.ts`, nos pontos `:695-726` (`ensureWebhookConfigured`), `:781-787` (`ensureProvisioned`), `:1010-1043` (admin), mais o spec do adapter.

**Interfaces:**
- Produces: C5.
- No adapter:
  - `private expectedWebhook(): ExpectedWebhook`: url = `EVOLUTION_WEBHOOK_URL ?? 'http://api:3000/webhooks/whatsapp'`, apikey = `EVOLUTION_API_KEY`;
  - `ensureWebhookConfigured` envia `buildWebhookSetBody(this.expectedWebhook())`, e o seu `logger.warn({ err }, …)` de falha (`:724`) passa a `logger.warn({ instanceName, httpStatus: err.response?.status, code: err.code }, …)` (GC6, M9);
  - os dois `POST /instance/create` passam a espalhar `...EVOLUTION_CREATE_SETTINGS` (campos planos, como hoje);
  - `ensureWebhookArmed`: `GET /webhook/find/{name}` → `webhookDivergences` → se a lista não vier vazia, `POST /webhook/set/{name}` com o corpo de C5 e `logger.warn({ instanceName, fields }, 'Evolution: webhook re-armado')`. Em erro do find ou do set: `logger.warn({ instanceName, httpStatus, code }, 'Evolution: falha ao conferir o webhook')` e `status 'failed'`;
  - `adminDeleteInstance`: `DELETE /instance/delete/{name}`, propaga o erro (quem chama decide).

**Contexto vinculado:**
- E1: para cada instância, `GET /webhook/find/{instance}`; se `enabled`, `url`, `events` ou `headers.apikey` divergirem, `POST /webhook/set/{instance}` com `{ webhook: { enabled: true, url, headers: { apikey }, byEvents: false, base64: false, events: [...] } }`. O `ensureWebhookConfigured` usa o mesmo corpo. Cada re-arme gera `warn` com instância e campos, nunca a chave; falha da Evolution só logada.
- E2 e DV1: `EVOLUTION_CREATE_SETTINGS` (com `rejectCall: true`).
- E3: `DELETE /instance/delete/{instance}`.
- D5: as duas formas do `find`.
- GC6: nunca logar `err` do axios nem a `apikey`.

**Steps:**
1. RED `evolution-webhook-config.spec.ts`: `it.each` com a tabela de `webhookDivergences`:
   - igual, forma plana → `[]`;
   - igual, forma `{webhook}` → `[]`;
   - `enabled:false` → `['enabled']`;
   - url diferente → `['url']`;
   - events em outra ordem → `[]`;
   - events sem `QRCODE_UPDATED` → `['events']`;
   - `events: []` → `['events']`;
   - apikey diferente → `['headers.apikey']`;
   - headers como string JSON igual → `[]`;
   - `null` → os 4 campos.

   Mais `it('buildWebhookSetBody usa byEvents/base64 e omite headers sem apikey')`.
2. RED, spec do adapter (axios mockado como no spec atual):
   - `it('ensureWebhookArmed: configuração confere → não chama set')`;
   - `it('ensureWebhookArmed: diverge → set com o corpo de C5 e warn com os campos; nenhum log contém a apikey')`, com `JSON.stringify` das chamadas do logger sem o valor;
   - `it('ensureWebhookArmed: find falha → failed, sem lançar, log sem o objeto de erro')`;
   - `it('ensureWebhookConfigured: set falha → warn só com instanceName, httpStatus e code; nenhum log contém a apikey')` (M9);
   - `it('adminCreateInstance envia EVOLUTION_CREATE_SETTINGS e arma o webhook no corpo novo')`;
   - `it('adminDeleteInstance chama DELETE /instance/delete/x')`.
3. GREEN.
4. Verificação: `timeout 600 gate --test` nas 2 specs, `npm run build`, `timeout 600 gate --changed --base origin/main`.

**Risco: crítico (segredo/credencial)**: compara e regrava o header `apikey` global da Evolution e loga divergências; vazamento da chave em log é o risco.

## Task B10 — Remoção libera a sessão; reconciliador confere o webhook (back)

**Depends on:** B9.

**Files (Modify, + specs):**
- `backend/src/modules/whatsapp-instances/whatsapp-instances.service.ts` (`EvolutionAdminClient` `:31-35`; `delete(id)` `:293-326`);
- `whatsapp-instances.module.ts` (`buildEvolutionAdminClient`, `:31-47`: o no-op `:35-41` e o mapeamento `:42-46`);
- `connection-reconciler.service.ts` (`:42-77`).

**Interfaces:**
- Consumes: C5 (`ensureWebhookArmed`, `adminDeleteInstance`).
- Produces:
  - C6 nos **dois** ramos de `buildEvolutionAdminClient`: o mapeamento real ganha `deleteInstance: (name) => adapter.adminDeleteInstance(name)`, e o no-op (provider ≠ `'evolution'`) ganha `deleteInstance: async () => {}` (sem isso o tsc quebra, porque o no-op é um literal de `EvolutionAdminClient`);
  - `delete(id: string): Promise<void>` (o método se chama `delete`, não `remove`; assinatura sem mudança):
    1. logout best-effort (como hoje, `:302-310`);
    2. `deleteInstance` em try/catch, só quando há `evolutionInstanceName`, com `logger.warn({ instanceId, httpStatus }, 'Evolution: instance/delete falhou; conexão removida só no OrgaMind')`;
    3. soft-delete e auditoria, sempre; a auditoria `instance.delete` ganha `evolutionDeleted: boolean`;
    4. o `updateMany` de WAITING_INSTANCE → FAILED `antiban.instance_deleted` (`:316-325`) fica como está.
  - `export const WEBHOOK_CHECK_INTERVAL_MS = 10 * 60_000;`
  - `ConnectionReconcilerService`: `private readonly lastWebhookCheck = new Map<string, number>()`. No laço, para cada instância com `evolutionInstanceName`, **depois** do `reconcileOne` e no seu próprio try/catch: se `Date.now() - (last ?? -Infinity) >= WEBHOOK_CHECK_INTERVAL_MS`, grava `last = now` e chama `evolutionAdapter.ensureWebhookArmed(name)`. Uma falha não interrompe as demais instâncias nem o reconcile de estado.

**Contexto vinculado:**
- E1: o worker confere no boot (D8: o primeiro ciclo) e a cada ciclo do reconciliador, no máximo uma vez a cada 10 min por canal; falha só logada.
- D8 (M7): o `ConnectionReconcilerService` também roda na api (`app.module.ts:125`), cada processo com seu mapa: até 2 conferências por instância a cada 10 min, aceito (GET barato, `set` idempotente). Não acrescentar flag `isWorker`.
- E3: `DELETE /whatsapp/instances/:id` faz logout e depois `DELETE /instance/delete/{instance}` em best-effort; se falhar, loga e faz o soft-delete do mesmo jeito.
- Cenário 9: a conexão some do OrgaMind mesmo com o delete falhando.
- GC6: log sem o objeto de erro.

**Steps:**
1. RED:
   - `whatsapp-instances.service.spec.ts`:
     - `it('delete: logout e deleteInstance, nessa ordem')`;
     - `it('delete: deleteInstance rejeita → soft-delete e auditoria com evolutionDeleted false')`;
     - `it('buildEvolutionAdminClient no-op: deleteInstance resolve sem chamar o adapter')`.
   - `connection-reconciler.service.spec.ts` (`vi.setSystemTime`):
     - `it('primeiro ciclo confere o webhook de cada instância Evolution')`;
     - `it('novo ciclo antes de 10 min não confere; depois de 10 min confere')`;
     - `it('ensureWebhookArmed rejeitando não interrompe as outras instâncias nem o reconcile')`;
     - `it('instância sem evolutionInstanceName não é conferida')`.
2. GREEN.
3. Verificação: `timeout 600 gate --test` nas 2 specs, `npm run build`, `timeout 600 gate --changed --base origin/main`.

**Risco: alto**: ciclo do reconciliador em produção e remoção de sessão externa; best-effort, sem dado do OrgaMind perdido.

## Task B11 — Integração do adapter contra a imagem Evolution fixada (back)

**Depends on:** B9.

**Files:**
- Create: `backend/src/modules/whatsapp-providers/adapters/evolution-api.adapter.integration.spec.ts`.
- Modify, só nestes dois casos:
  - `adminRestart` em `evolution-api.adapter.ts`, se o caso de DV4 falhar;
  - `webhookDivergences` em `adapters/evolution-webhook-config.ts` (+ uma linha nova na tabela de `evolution-webhook-config.spec.ts`), **só** a regra de `headers` ausente na resposta do `find` (M10, autorizado pela principal). Se a 2.3.7 não devolver `headers` no `find` (ou devolver sem `apikey`), a regra atual "ausente = ausente" diverge em todo ciclo e re-arma em laço. Ajuste permitido: `headers` ausente na resposta → `headers.apikey` não diverge. Nenhuma outra regra de C5 muda.

**Interfaces:**
- Consumes: C5; `EvolutionApiAdapter`, construído com `ConfigService` stub (`EVOLUTION_BASE_URL` = URL mapeada do container, `EVOLUTION_API_KEY = 'it-key'`, `EVOLUTION_INSTANCE_NAME = 'it-default'`, `EVOLUTION_WEBHOOK_URL = 'https://orgamind.example.com/webhooks/whatsapp'`, proxy desligado).
- Via (decisão): testcontainers, como os testes existentes, e a imagem **por digest**.
  - `new Network().start()`;
  - `new PostgreSqlContainer('postgres:16-alpine').withNetwork(net).withNetworkAliases('evo-db')`;
  - `new GenericContainer('evoapicloud/evolution-api@sha256:966625532d9076a2381e973a271307d107e6f070450de3abeeea8bd18be07252')` com `withNetwork(net)`, `withExposedPorts(8080)`, `withWaitStrategy(Wait.forHttp('/', 8080).forStatusCode(200))` e `withStartupTimeout(240_000)`.
  - Env da Evolution copiado de `docker-compose.dev.yml:33-95`, trocando: `AUTHENTICATION_API_KEY=it-key`, `DATABASE_CONNECTION_URI` para `evo-db`, `CACHE_REDIS_ENABLED=false`, `CACHE_LOCAL_ENABLED=true`.
  - Sem Redis: é opcional na Evolution (`pesquisa-versao.md:6`).
  - `describe.skipIf(!TESTCONTAINERS_ENABLED)`, `beforeAll` com timeout de 300 s.

**Contexto vinculado:**
- §8: teste de integração do adaptador contra a imagem fixada, cobrindo `instance/create` com settings, `webhook/find` e `webhook/set` no formato da 2.3.7 e `instance/delete`.
- D5: o teste decide o formato do `find`.
- C5 (regra atual): `headers` pode vir objeto ou string JSON, e `headers.apikey` tem que ser igual a `expected.apikey` (ausente = ausente). M10: se o `find` não trouxer `headers`, a B11 troca só essa regra para "ausente na resposta não diverge" e registra no relatório.
- §6: o re-arme em laço é o risco principal.
- DV4: verbo do restart.
- GC1: `TESTCONTAINERS_ENABLED=1 timeout 600 gate --test <arquivo>`.

**Steps (todos casos de teste, RED → GREEN se algo do adapter não bater):**
1. `it('GET / informa a versão 2.3.7')`: confere que o digest é o esperado.
2. `it('adminCreateInstance aplica os settings')`: `GET /settings/find/it-1` → `groupsIgnore true`, `alwaysOnline false`, `readMessages false`, `readStatus false`, `syncFullHistory false`, `rejectCall true`.
3. `it('depois da criação, ensureWebhookArmed → ok sem set')` (**prova contra o laço**). Registrar no relatório a forma real devolvida pelo `find`.
4. `it('webhook desligado por fora → ensureWebhookArmed re-arma (enabled) e o ciclo seguinte dá ok')`, desligando por `POST /webhook/set/it-1` direto com `enabled:false`.
5. `it('adminDeleteInstance remove a instância')`: `fetchInstances` não a lista mais (404 ou ausente).
6. `it('adminRestart usa a rota aceita pela 2.3.7')` (DV4).
7. Verificação: `TESTCONTAINERS_ENABLED=1 timeout 600 gate --test src/modules/whatsapp-providers/adapters/evolution-api.adapter.integration.spec.ts`; se tocou `webhookDivergences` (M10), também `timeout 600 gate --test src/modules/whatsapp-providers/adapters/evolution-webhook-config.spec.ts`; `timeout 600 gate --changed --base origin/main`.
8. **Lacuna conhecida:** sem saída para a internet no container, o `instance/create` com `qrcode: true` pode demorar ou falhar ao abrir o socket do Baileys. Se acontecer, registrar o erro exato e reportar BLOCKED (infra), sem mudar o adapter para contornar.

**Risco: médio**: teste novo, sem mudança de produção, salvo DV4.

## Task B12 — DI e boot com env só Evolution e com env de sobra (back)

**Depends on:** B2, B3, B4, B5, B6, B7, B8, B10 (N4).

**Files:**
- Modify: `backend/src/worker.di.spec.ts`.
- Create: `backend/src/app.di.spec.ts`, no padrão de `backend/src/modules/team-whatsapp/team-whatsapp.module.di.spec.ts:49` (`Test.createTestingModule({ imports: [AppModule] })`, com os mesmos overrides).

**Interfaces:** consome C1 (`DISABLED_PROVIDER_QUEUES`, `ENABLED_CHANNEL_PROVIDERS`); não produz API.

**Contexto vinculado:**
- §8: boot real da api e do worker com env só Evolution e com env GoZap de sobra, sem erro de DI. Esta task cobre a compilação da DI; o boot real fica no Fechamento.
- R8: nenhum `@Processor` registrado para filas exclusivas.
- D3: serviços exclusivos continuam providers.

**Steps:**
1. RED/GREEN, com `it.each` de 2 envs: `só Evolution` e `Evolution + GOZAP completo + ZERNIO parcial`:
   - `AppModule` e `WorkerModule` compilam;
   - `ProviderRegistry.configured()` é `['EVOLUTION']`;
   - nenhum provider descoberto (`DiscoveryService.getProviders()`) tem metadata de `@Processor` com nome em `DISABLED_PROVIDER_QUEUES`, `zernio.broadcast-dispatch`, `zernio.broadcast-poll` ou `zernio.broadcast-cancel`;
   - no env de sobra, o warn de chaves ignoradas sai uma vez e sem valores.
2. Se a compilação acusar dependência faltando, corrigir **no módulo que perdeu o provider** (registrando de volta o serviço, nunca o processor) e registrar no relatório qual foi.
3. Verificação: `timeout 600 gate --test src/worker.di.spec.ts`, `timeout 600 gate --test src/app.di.spec.ts`, `npm run build`, `timeout 600 gate --changed --base origin/main`.

**Risco: alto**: o critério de aceite do boot.

---

## Task F1 — Conexões: só Evolution + "Números desligados" (front)

**Depends on:** contrato C3 (pode começar antes da B3).

**Files:**
- Create: `frontend/src/features/whatsapp/disabled-provider.ts`; `features/whatsapp/components/disabled-channels-section.tsx` + `.spec.tsx`.
- Modify: `frontend/src/features/whatsapp/api.ts`; `frontend/src/routes/_authenticated/connect.tsx` + `connect.spec.tsx`.
- Delete, com as specs: `features/whatsapp/components/{gozap-section,create-gozap-channel-dialog,gozap-qr-dialog,remove-gozap-channel-dialog,cloud-provider-section,create-channel-form,cloud-channel-list,webhook-drops-banner}.tsx`.

**Interfaces:**
- `disabled-provider.ts`:
  ```ts
  export const ENABLED_PROVIDERS = ['EVOLUTION'] as const;
  export function isEnabledProvider(p: ChannelProvider): boolean;
  export const DISABLED_PROVIDER_LABEL: Readonly<Record<ChannelProvider, string>>; // D10
  ```
- `api.ts`:
  - `disabledChannelSchema`, e `providersResponseSchema` ganha `disabledChannels` (C3, `.default([])`);
  - `export type DisabledChannel`;
  - `useRemoveDisabledChannel()` → `DELETE whatsapp/channels/${id}`, invalidando as mesmas chaves que `useUpdateChannelSectors` (`api.ts:22`, `:505`) e `['whatsapp','providers']`. Substitui `useDeleteGozapChannel`.
  - Removidos: `useZernioAccounts`, `useChannelHealth`, `createChannelInputSchema`/`useCreateChannel`, `useCreateGozapChannel`, `useGozapQr`, `useDeleteGozapChannel`, `useWebhookDrops`, `useSyncZernioInbox`, `useZernioSyncStatus`, `ZERNIO_SYNC_ACTIVE` e os tipos deles (`api.ts:596-660`; o único consumidor é `cloud-provider-section.tsx`, apagado aqui, M11), e `useUpdateChannel` se ficar sem consumidor.
  - Regra: remover um hook só quando um grep não acha consumidor fora dos arquivos desta task.
- `DisabledChannelsSection({ channels }: { channels: DisabledChannel[] })`.
- `ConnectPage`:
  - sem `useProviderScope`; renderiza `SectorsWithoutNumberNotice`, `EvolutionSection` e, só se ADMIN e `disabledChannels.length > 0`, `DisabledChannelsSection`;
  - sem EVOLUTION em `providers` → o estado "Nenhum provedor configurado no servidor.", sem banner.
- Telefone: o mesmo formatador de `phoneE164` que `gozap-section.tsx` usa hoje. Se for local a esse arquivo, mover para `features/whatsapp/format-phone.ts` antes de apagá-lo.

**Contexto vinculado:**
- R13: Conexões mostra só a seção Evolution e, para ADMIN com `disabledChannels` não vazio, o bloco "Números desligados" (nome, telefone, integração, áreas, ação Remover) com a confirmação de GC11.
- R14: saem a seção e os diálogos GoZap, a seção e o formulário cloud, a lista cloud e o inbox sync Zernio (hooks só usados pela seção cloud, M11).
- R15: nenhuma escolha de provedor na UI.
- GC10: erro com `readApiErrorBody`, em toast.
- GC11: textos exatos.
- DV2: o banner de webhook-drops sai.

**Steps:**
1. RED:
   - `disabled-channels-section.spec.tsx`:
     - `it('lista nome, telefone, Integração: GoZap e Áreas: Produção')`;
     - `it('sem áreas mostra Nenhuma área')`;
     - `it('Remover abre a confirmação com o texto exato (com áreas) e Remover chama a mutação com o id')`;
     - `it('confirmação sem áreas omite a frase das áreas')`;
     - `it('erro do back vira toast com a mensagem de readApiErrorBody')`.
   - `connect.spec.tsx`:
     - `it('ADMIN com disabledChannels vê Números desligados')`;
     - `it.each(['SUPERVISOR','OPERATOR'])('%s não vê o bloco')`;
     - `it('não há seção GoZap, cloud nem cabeçalho de provedor')`;
     - o caso existente `'Áreas sem número: RH'` continua verde.
2. GREEN; apagar os arquivos e as specs listados.
3. Conferir por grep `frontend/e2e` (se existir) referências às telas apagadas, e listá-las no relatório sem rodar e2e.
4. Verificação: `timeout 600 gate --test` nas specs, `npx tsc -b`, `timeout 600 gate --changed --base origin/main`.

**Risco: médio**: tela de configuração; a autorização é garantida no back (B3), e o front só esconde.

## Task F2 — Chat: conversa de canal desligado bloqueada, sem abas de provedor (front)

**Depends on:** F1 (`disabled-provider.ts`; a F1 também já removeu os hooks de sync Zernio de `api.ts`).

**Files:**
- Modify: `frontend/src/features/chat/components/message-composer.tsx` (`:25-98`, `:158-215`) + spec; `conversations-list.tsx` (`:65-109`, `:133`) + spec. A F2 **não** toca `features/whatsapp/api.ts`.
- Delete: `features/chat/components/provider-tabs.tsx` + spec.

**Interfaces:**
- Consumes: `isEnabledProvider`, `DISABLED_PROVIDER_LABEL` (F1).
- Produces:
  - `MessageComposer`: com `provider !== undefined && !isEnabledProvider(provider)`, mostra `<p data-testid="provider-disabled-banner">` com o texto de GC11, e textarea, anexo e enviar ficam desabilitados. Essa checagem vem **antes** de `providerInfoUnknown` (`:71`): sem ela, o canal desligado ficaria em "carregando" para sempre, porque não está mais em `/whatsapp/providers`.
  - `ConversationsList`:
    - sem o efeito de default GOZAP (`:65-89`), sem `ProviderTabs` e sem filtro de provedor na query;
    - o badge de provedor por conversa (`:168`) fica, porque ajuda a ler o histórico misto.

**Contexto vinculado:**
- R11: conversas de canal desligado continuam legíveis; o campo de resposta fica bloqueado com `Este número usa uma integração desligada (<Provedor>). Para responder, conecte um número Evolution em Conexões.`
- R14: saem as abas de provedor no chat e o default de aba GoZap (o inbox sync Zernio sai na F1, M11).
- Cenário 12.
- D6: as abas já se escondiam com menos de 2 provedores, mas saem do código.

**Steps:**
1. RED:
   - `message-composer.spec.tsx`:
     - `it.each([['GOZAP','GoZap'],['ZERNIO','Zernio'],['TWILIO','Twilio'],['META','Meta']])('%s: aviso exato e envio desabilitado')`;
     - `it('EVOLUTION: envio liberado')`.
   - `conversations-list.spec.tsx`: `it('não pré-seleciona GOZAP nem mostra abas de provedor')`.
2. GREEN; apagar `provider-tabs`.
3. Verificação: `timeout 600 gate --test` nas specs, `npx tsc -b`, `timeout 600 gate --changed --base origin/main`.

**Risco: médio**: bloqueio só de UI; o back recusa com 409 (B7).

## Task F3 — Topo e templates sem provedor (front)

**Depends on:** nada.

**Files:**
- Modify:
  - `frontend/src/features/whatsapp/provider-scope.tsx` (`:40-47`, `:158-200`) + spec;
  - `frontend/src/components/layout/topbar.tsx` (`:12`, `:60`);
  - `frontend/src/routes/_authenticated/templates.tsx` (`:379-453`, `:518-556`) + spec;
  - `frontend/src/features/templates/api.ts` (`:48`, `:56-60`, e hooks Twilio);
  - `features/templates/components/template-form-dialog.tsx`, se tiver escolha de provedor.
- Delete: `features/templates/components/{twilio-template-form-dialog,submit-twilio-template-dialog,zernio-template-form-dialog}.tsx`, `features/templates/{twilio,zernio}-schemas.ts`, com as specs.

**Interfaces:**
- `provider-scope.tsx`:
  - `ProviderScopeSelector` é removido;
  - `readPersisted()` devolve `'all'` para qualquer valor ≠ `'all'` e apaga a chave legada;
  - `ProviderScopeProvider`, `useProviderScope`, `ProviderBadge`, `ConnectionStateBadge`, `PROVIDER_LABEL` e o tipo `ProviderScope` **ficam** (a F4 e o chat ainda os importam).
- `templates/api.ts`: saem `useSyncTemplates` (POST `templates/sync`, DV2), `useSyncZernioTemplates` e os hooks de criar, submeter ou editar Twilio.
- `templates.tsx`: sem botões ou diálogos de sync, sem aba Twilio, sem diálogo Zernio.
- O formulário de template não oferece provedor (cria EVOLUTION).

**Contexto vinculado:**
- R14: saem o seletor de escopo de provedor no topo e os diálogos e ações de template Twilio e Zernio.
- R15: nenhuma escolha de provedor na UI.
- D6: o escopo persistido `GOZAP` não pode deixar listas vazias.
- DV2: `POST /templates/sync` sai do back.

**Steps:**
1. RED:
   - `provider-scope.spec.tsx`: `it("valor persistido 'GOZAP' vira 'all'")`; os casos antigos do seletor (`:184-210`) são removidos;
   - `topbar` (spec existente ou nova): `it('não renderiza o seletor de provedor')`;
   - `templates.spec.tsx`: `it('sem ações de sincronizar, Twilio ou Zernio')`.
2. GREEN; apagar os arquivos.
3. Verificação: `timeout 600 gate --test` nas specs, `npx tsc -b`, `timeout 600 gate --changed --base origin/main`.

**Risco: médio.**

## Task F4 — Campanhas e métricas Zernio (front)

**Depends on:** nada.

**Files:**
- Modify:
  - `frontend/src/routes/_authenticated/campaigns/new.tsx` (`:624-646`, `:934-946`, `:1461-1488`, `:1516-1521`, `:1541`) + spec;
  - `campaigns/index.tsx` (`:28-31`, `:310-312`);
  - `features/campaigns/resolve-channel.ts` (`:4-7`) + spec;
  - `features/campaigns/schemas.ts` (`:235-237`, `:266`).
- Delete: `frontend/src/features/zernio-metrics/` inteiro (sem consumidor, `mapa-front-infra.md:3`).

**Interfaces:**
- `new.tsx`:
  - sem escolha de provedor, sem toggle de broadcast Zernio e sem aviso de janela 24h Twilio;
  - a lista de canais vem de `useProviders()` (agora só EVOLUTION).
- Contrato de campanha (`schemas.ts`): campos lidos do back **ficam** (histórico). Só sai o que é exclusivo de entrada no formulário.
- Se existir mapa de rótulo de `errorCode` de mensagem na tela de resultado da campanha (grep `errorCode` em `features/campaigns`), ele ganha `'channel.provider_disabled' → 'Número de integração desligada'`. Se a tela mostra o código cru, não criar mapa novo: registrar no relatório.

**Contexto vinculado:**
- R12: campanhas só oferecem canais e templates Evolution; o motivo `channel.provider_disabled` aparece no resultado.
- R14: saem hooks e telas Zernio (`features/zernio-metrics`, broadcast).
- R15: nenhuma escolha de provedor.
- GC11: rótulo exato do motivo.

**Steps:**
1. RED:
   - `new.spec.tsx`: `it('só canais EVOLUTION e nenhuma escolha de provedor')`;
   - `resolve-channel.spec.ts`: ajustar a tabela (canal não-EVOLUTION → não encontrado).
2. GREEN; apagar `zernio-metrics`.
3. Verificação: `timeout 600 gate --test` nas specs, `npx tsc -b`, `timeout 600 gate --changed --base origin/main`.

**Risco: médio**: tela de disparo, sem mudança de regra de envio (o back é a autoridade, B7).

## Task F5 — Novidade e motivo de falha da equipe (front, `mecanico`)

**Depends on:** nada.

**Files (Modify):** `frontend/src/release-notes.ts` (+ spec, se a versão nova precisar), `frontend/src/features/team-whatsapp/error-messages.ts` + `error-messages.spec.ts`.

**Interfaces:**
- Entrada nova no **topo** de `RELEASE_NOTES`, com `version: '2026.11.11'` (ou `'2026.11.11.n'` se já existir), `where: '/connect'` e o texto exato de R16.
- `error-messages.ts`: `'channel.provider_disabled'` → `'Número de integração desligada'` no mapa de motivos de falha (o mesmo onde estão `gozap.*`, `:61-72`). Os códigos `gozap.*` **ficam**.

**Contexto vinculado:**
- R16: o texto da novidade de GC11.
- R14: os rótulos e mensagens de códigos antigos (`gozap.*`) ficam, porque o histórico ainda exibe esses motivos.
- `frontend/CLAUDE.md`: a entrada nova vai sempre no topo, em ordem decrescente de versão.

**Steps:** RED `it("channel.provider_disabled → 'Número de integração desligada'")` → GREEN → `timeout 600 gate --test src/features/team-whatsapp/error-messages.spec.ts`, `timeout 600 gate --test src/release-notes.spec.ts`, `timeout 600 gate --changed --base origin/main`.

**Risco: baixo.**

---

## Task I1 — Infra, CI e docs

**Depends on:** nada. O texto de E1/V1/V2 vem da spec; a principal confere depois da B10.

**Files (Modify):**
- `docker-compose.prod.yml`: `evolution-api` `:151-192`; env api `:257-309`, worker `:412-455`, migrate `:110-111`;
- `docker-compose.dev.yml` (`:33-95`);
- `.env.example` (`:29-49`), `.env.prod.example` (`:10-19`, `:55-70`);
- `.github/workflows/ci.yml` (`:46-52`), `.github/workflows/e2e.yml` (`:48-51`);
- `README.md`, `DEPLOY.md`, `OPERATIONS.md`;
- `frontend/nginx.conf`.

**Create:** `.claude/rules/whatsapp-provedores.md`, com frontmatter `paths: ["backend/src/modules/whatsapp-providers/**", "backend/src/modules/webhooks/**", "backend/src/worker.ts", "frontend/src/features/whatsapp/**"]`. Conteúdo: só a Evolution está ligada (`ENABLED_CHANNEL_PROVIDERS`); o código dos outros é inativo e não deve ser religado nem registrado sem spec; regras GC5 e GC6; onde ficam o reconciliador do webhook e a limpeza de repetíveis.

**Interfaces / valores:**
- Imagem nos dois composes: GC15. Comentário ao lado: `Evolution 2.3.7 (Baileys 7.0.0-rc.9, Node 24.15), build de 2026-05-06; trocar pela 2.3.8 quando publicada (correção de segurança #2435); não usar 2.4.0-rc (exige licença)`.
- Prod `evolution-api`: `mem_limit: 1g` e `NODE_OPTIONS: --max-old-space-size=768`. Os demais env, a rede e a ausência de porta ou domínio público não mudam.
- Saem todos os `GOZAP_*`, `ZERNIO_*`, `TWILIO_*` e `META_*` dos arquivos acima. Os `EVOLUTION_*` (inclusive os dummies do CI) ficam.
- `README.md`/`DEPLOY.md`/`OPERATIONS.md`: as seções GoZap, Meta, Zernio e Twilio viram `Desligado em 2026-11; código inativo no repositório.`. `OPERATIONS.md` ganha a seção `Evolution: versão fixa e troca de versão`, com:
  - a troca de digest (V1);
  - `mem_limit`/`NODE_OPTIONS` (V2);
  - o webhook conferido a cada 10 min pelo reconciliador, com `warn` "Evolution: webhook re-armado" (E1);
  - a remoção que apaga a instância (E3);
  - o roteiro §7 da spec (virada em produção), resumido e marcado "só com pedido explícito", **na ordem da spec**, inclusive o passo 6: esperar uma volta do sweeper de 5 min (log `paradas:` do GBR zerado — ele falha as paradas pelo processor e adota as de canais GoZap inativos do mesmo número, N3), e se "GBR" era a conexão padrão, marcar a conexão Evolution como padrão **antes** de remover "GBR" em "Números desligados" (as mensagens paradas nele viram falha com `channel.provider_disabled`, C4).
- `frontend/nginx.conf`: a `location /api/webhooks/` (`:114`) **fica**: não é exclusiva do GoZap (serve o `POST /webhooks/whatsapp` da Evolution). Só os comentários que citam GoZap, Zernio, Twilio ou Meta são atualizados (M13).

**Contexto vinculado:**
- I1: saem os env dos desligados de compose prod (api, worker, migrate), `.env.example`, `.env.prod.example`, `ci.yml` e `e2e.yml`; os dummies EVOLUTION ficam.
- I2: a nota curta nas docs e a seção nova no `OPERATIONS.md`.
- V1 e V2.
- Regra de documentação: contexto de feature vai em `docs/` ou `.claude/rules/<tema>.md` com `paths:`, nunca como seção nova no CLAUDE.md.

**Steps:**
1. Editar.
2. Conferir com `docker compose -f docker-compose.prod.yml config -q` e `docker compose -f docker-compose.dev.yml config -q` (validação de sintaxe; não sobe nada).
3. Conferir por grep que não sobra `GOZAP_|ZERNIO_|TWILIO_|META_` nos arquivos listados.
4. Gate: não se aplica a YAML ou markdown fora de `backend/` e `frontend/`. Se tocar `frontend/nginx.conf`, rodar `timeout 600 gate --changed --base origin/main` com cwd `frontend/`.

**Risco: alto**: configuração de produção (`mem_limit` da Evolution, env de credenciais). Nada é aplicado em produção nesta feature (§3).

---

## Fechamento (principal)

1. Gate completo uma vez no estado final, em `backend/` e `frontend/`, com `--base origin/main` (ou `3a1ceb3`; ver o topo). Sem regressão sobre a base. Typecheck: `npm run build` e `npx tsc -b`.
2. Integrações com Docker: `TESTCONTAINERS_ENABLED=1` nas specs das B3, B4, B8 e B11.
3. **Boot real** (§8), numa stack local, duas vezes:
   - env só Evolution;
   - env com o grupo GOZAP completo de sobra.

   Critérios:
   - api e worker sobem sem erro de DI;
   - o log da api e do worker mostra `chaves de provedores desligados ignoradas: GOZAP_BASE_URL, …` só no segundo boot e sem valores;
   - `GET /whatsapp/providers` lista só EVOLUTION;
   - o worker loga a limpeza dos repetíveis;
   - nenhum job GoZap, Zernio, Twilio ou Meta aparece agendado (`getRepeatableJobs` nas filas de `DISABLED_PROVIDER_QUEUES`).
4. QA visual (`qa`): Conexões com o bloco "Números desligados" e o aviso de áreas (cenários 4 e 5); chat com conversa de canal GoZap bloqueada (cenário 12). Usar o seed fictício da stack QA local.
5. Ledger: registrar D1–D11, DV1–DV5, a forma real do `webhook/find` (B11) e o que não foi verificado.

## Não verificado neste plano (lacunas para o ledger)

- **Formato do `GET /webhook/find` na 2.3.7:** decidido pela B11 (D5).
- **Paradas em canal desligado já inativo antes desta feature** (ex.: GoZap removido pelo fluxo antigo sem falhar as WAITING_INSTANCE): a varredura não desperta canal inativo; a adoção (`reconnect-replay.service.ts:108-139`) só move as de canal GoZap inativo com o mesmo número para um canal GoZap ativo, que depois é falhado pela varredura (N3); o resto continua parado. Fora do escopo; a principal confere a contagem no GBR (`groupBy instanceId` de WAITING_INSTANCE) antes da virada e leva ao backlog se houver.
- **Comportamento do `instance/create` com `qrcode: true`** num container sem internet (B11, passo 8).
- **Telas do front ligadas a provedor que não estão no mapa:** só por grep nas F1–F4. Exemplos: `contacts/components/sync-contacts-dialog.tsx:22-23` (taxa GoZap no texto), `layout/whatsapp-status-indicator.tsx:39-46`, `chat/schemas.ts`. Remover só ramo morto que o tsc ou o lint acusar; o resto vai para o backlog.
- **Specs de outros módulos que montam env com só um grupo não-Evolution:** passam a falhar no parse (B1). O `gate --changed` de cada task pega os relacionados; os demais aparecem no gate completo do Fechamento.
