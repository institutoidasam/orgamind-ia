# OrgaMind — número por área e envio rastreável — Implementation Plan

> **Para os agentes:** executar pela skill `sdd` (TDD, ledger em `.superpowers/sdd/2026-11-10-orgamind-numero-por-area/progress.md`). **Sem commit/push**: nenhuma task commita; a principal integra e só commita/publica com pedido explícito do usuário. Base: `origin/main` `50afdee`. A principal cria a branch a partir de `origin/main`, porque o `main` local está atrasado.

**Goal:** cada área (setor) passa a ter o próprio número (canal) e o envio da equipe escolhe sozinho o número de cada pessoa. Área sem número fica bloqueada e à vista. O número é conferido no provedor antes de enviar. Cada pessoa ganha situação (aceito, entregue, lido, respondeu, incerta), tentativas e um "Repetir" seguro, numa tela de resultado. Também entram vários turnos no mesmo envio, "fora: não selecionado" e o D-01 (limites, paginação e erro recuperável).

**Architecture:** a associação é `Sector.channelId` (D1), e o "número efetivo" sai de uma função pura só (D2). Cada destinatário grava o próprio canal com snapshot (D3); o grupo por número é o agrupamento desses destinatários. O estado ao vivo passa por uma porta no `WhatsappProvidersModule` (D7), usada pela prévia, pelo POST imediato e pelo processor antes de cada mensagem. Os recibos e as respostas chegam ao destinatário por um serviço que só usa o Prisma (D10), chamado pelo webhook e pela ingestão do chat. "Repetir" troca o estado no banco com `UPDATE … RETURNING` e enfileira com um jobId novo (D12). O front espelha os contratos à mão.

**Tech Stack:** NestJS + Prisma + Zod (`createZodDto`) + BullMQ 5 + Vitest/testcontainers (backend); React + TanStack Router/Query + Radix + ky 2 + sonner + Vitest/Testing Library/user-event (frontend).

**Spec:** `docs/superpowers/specs/2026-11-10-orgamind-numero-por-area-envio-rastreavel.md` (fonte da verdade). Mapas: `.superpowers/sdd/2026-11-10-orgamind-numero-por-area/mapa-envio-backend.md`, `mapa-canais-recibos.md`, `mapa-frontend.md`. Fluxo aprovado: `reports/fluxo-numero-por-area/fluxo.html`.

## Ordem e paralelismo

```
Back:  T1 ─┐
       T2 ─┼─> T3 ─> T5 ─┐
           ├─> T4        │
           └─> T10 ──────┼──────────────┐
       T1 ─> T6 ─────────┴─> T7 ─> T8 ─> T9 ─> T11 ─> T12
Front: T6 ─> T13 ─> T14 (também T8) ─> T15 (também T11) ─> T16 (também T12)
       T3 + T4 ─> T17           tudo ─> T18
```

- **Paralelos permitidos (ownership disjunto):**
  - **T1 ∥ T2**: `team-whatsapp/*.repository.ts`, `staff-schedule/**` × `prisma/**` e `team-whatsapp/sector-channel.ts`.
  - **T3 ∥ T4**: `whatsapp-providers/**`, `whatsapp-instances/**`, `schemas/contracts/instance.schema.ts` × `internal-sectors/**`, `internal-numbers/**`, `sector-people/**`.
  - **T10 ∥ T6–T9**: `webhooks/**`, `chat/chat-ingest.service.ts`, `chat/chat.module.ts`, `team-whatsapp/tracking/**`. A T9 mexe só em `chat/chat.service.ts` (`prepareTeamMessage`).
  - **T17 ∥ T13–T16**: `features/whatsapp/**`, `features/internal-admin/**`, `routes/_authenticated/{connect,setores}/**` × `features/team-whatsapp/**`, `routes/_authenticated/whatsapp-equipe/**`, `features/staff-schedule/**`, `routes/_authenticated/escala/**`.
- **Em série:**
  - T1 → T6 → T7 → T8 → T9 → T11 → T12, porque todas dividem `team-whatsapp.service.ts`, `.repository.ts` e os contratos.
  - T5 depois da T3, porque as duas mexem em `whatsapp-providers.module.ts`.
  - No front, T13 → T14 → T15 → T16, porque dividem `features/team-whatsapp/{schemas,api,error-messages}.ts`.
- **Revisão** (SKILL.md do sdd, §Revisão por risco):
  - **Críticas** (revisor `opus`): T2 (produção), T11 (autorização), T12 (autorização, e a garantia anti-duplicata no escopo da revisão).
  - **Não críticas com revisor dedicado** (`sonnet`): T3, T6, T8, T9 e T10. Mexem em contrato público, concorrência e anti-objetivos de número errado ou "Enviado" falso.
  - **Demais não críticas:** T1, T4, T5, T7, T13–T18. A T18 cabe no `mecanico`.

## Global Constraints

- **GC1 — Gate.**
  - Iteração: `timeout 600 gate --test <arquivo>`, com cwd `backend/` ou `frontend/`. Specs de integração (testcontainers) precisam de Docker e de `TESTCONTAINERS_ENABLED=1` no ambiente do comando.
  - Fechamento de cada task: um único `timeout 600 gate --changed --base origin/main`.
  - Suíte inteira, gate completo, `test:cov`/`--coverage` e e2e ficam com a principal, no Fechamento. Nunca os rode dentro de uma task.
  - Em worktree, o gate precisa de `backend/.env` fictício e de `node_modules` (memória do projeto).
- **GC2 — Limites do gate de complexidade, inclusive em specs.**
  - Função/callback (inclusive o callback de `describe`) ≤ 50 linhas; ≤ 4 parâmetros (mais campos = objeto); ciclomática ≤ 10; cognitiva ≤ 15; profundidade ≤ 4.
  - Duplicação ≤ 3% e cobertura ≥ 80% das linhas novas.
  - O `--changed` não acusa `max-lines-per-function` em `describe` nem `max-params` em spec: cada task confere à mão (casos novos em `describe` novos, `it.each` com tabela).
- **GC3 — Banco.**
  - Nunca `prisma migrate reset`. `migrate dev`/`deploy`/`db push`/`migrate diff --shadow-database-url` só contra o Postgres do testcontainers. `bun run prisma generate` é livre.
  - DDL sem banco: `bunx prisma migrate diff --from-schema-datamodel <cópia do schema anterior> --to-schema-datamodel prisma/schema.prisma --script`. Depois, o SQL de dados à mão, sem renomear constraints ou índices gerados.
  - Helpers: `backend/test/migrations.ts` `deployMigrations({ databaseUrl, until? })` e `schemaDrift({ shadowUrl })`.
- **GC4 — Migrações: só a T2 mexe em `schema.prisma`.** Todas aditivas, sem perda de dados, nesta ordem, depois de `20261022110000_team_dispatch_sectors` (a T2 confere que não há migração mais nova em `origin/main`):
  - `20261110090000_sector_channel`;
  - `20261110091000_team_recipient_status_values` (só `ALTER TYPE … ADD VALUE`: o Postgres não deixa usar um valor novo de enum na mesma transação em que foi criado);
  - `20261110092000_team_recipient_tracking`.

  O CI `migration-drift` só aceita diff vazio ou exatamente `DROP TABLE "_message_dup_neutralized_20260819";`. A T2 roda de novo o teste de drift (`describe('schema sem drift (igual ao CI)')` em `backend/src/modules/shifts/shift-migration.integration.spec.ts`).
- **GC5 — Quem envia e quem configura não mudam.**
  - Remetente: ADMIN, SUPERVISOR e OPERATOR (`isTeamSender`, 403 `team_whatsapp.forbidden`). O ADMIN alcança todos os setores; o gestor (`Sector.managerId`), só os que gerencia (`canSendToSector`; alvo pessoa: `canSendToUser`).
  - Associar número a área é só do ADMIN (`@Roles('ADMIN')`, como conectar número).
  - Histórico: o ADMIN vê todos os envios e os demais só os próprios (`authorId`).
- **GC6 — Lista conferida = lista enviada.**
  - O POST refaz a lista no servidor com setores, turnos, níveis, data e `includeOff`. `userIds` fora dela dá 422 `team_whatsapp.invalid_selection`, e nada é criado: nem dispatch, nem job, nem auditoria.
  - No agendado, o público e o número de cada pessoa ficam congelados na criação.
- **GC7 — Número da pessoa = número efetivo do setor onde ela aparece na data.**
  - Número efetivo (D2): o canal do setor, se `isActive` e de provedor `GOZAP`/`EVOLUTION`; senão, "sem número".
  - Área selecionada sem número trava o envio inteiro, na tela e no servidor.
  - Nunca enviar por um número que se sabe desconectado. Só o estado `open` libera.
- **GC8 — Dado pessoal.** Telefone e nome de pessoa nunca vão para log ou auditoria novos; auditoria nova grava ids e contagens. O telefone do número (canal) é da empresa e pode aparecer na API e na tela, mas não em log.
- **GC9 — Contratos espelhados.** O back é a fonte (`backend/src/schemas/contracts/*.schema.ts` + DTOs). O front copia os mesmos campos em `frontend/src/features/*/schemas.ts`, sem SDK. Back e front sobem no mesmo PR.
- **GC10 — Erros no front.** Código lido só com `readApiErrorBody` (`frontend/src/lib/api-error.ts`; em team-whatsapp, pelo wrapper `apiErrorCode`). Specs simulam o erro com `new HTTPError(new Response(JSON.stringify({ code }), { status }), new Request('https://x'), {} as never)`.
- **GC11 — Rótulos pt-BR exatos.** Separador ` · ` (espaço, U+00B7, espaço). Estes textos são o `fixture` de toda task de front:
  - **Situação:**

    | Status | Rótulo |
    |---|---|
    | `QUEUED` | `Na fila` |
    | `SENT` | `Aceito pelo WhatsApp` |
    | `DELIVERED` | `Entregue` |
    | `READ` | `Lido` |
    | `REPLIED` | `Respondeu` |
    | `FAILED` | `Falhou: <motivo>` |
    | `UNCERTAIN` | `Situação incerta` |
    | `SKIPPED` | `Pulado: <motivo>` |
    | `SCHEDULED` | `Agendado` |
    | `CANCELLED` | `Cancelado` |

    Explicação de incerta: `O WhatsApp não confirmou o envio. A mensagem pode ter saído: confira no celular antes de mandar de novo.`
  - **Motivos de falha** (substituem os de `error-messages.ts:70-74`):
    - `team_whatsapp.channel_disconnected` e demais `DISCONNECTED_CODES` → `Número desconectado`;
    - `team_whatsapp.channel_unverified` → `Não foi possível conferir o número`;
    - `team_whatsapp.channel_unavailable` → `Número indisponível na hora do envio`;
    - `team_whatsapp.channel_invalid` → `Número removido ou inválido`.
  - **Erros do POST:**
    - `team_whatsapp.sector_without_number` → `Há área sem número neste envio. Associe um número a ela em Conexões.`;
    - `team_whatsapp.no_sector` → `Esta pessoa não tem área. Coloque-a num setor antes de enviar.`;
    - `team_whatsapp.channel_disconnected` → `Um número deste envio está desconectado. Veja na prévia qual é.`;
    - `team_whatsapp.channel_unverified` → `Não foi possível conferir o número. Tente de novo`;
    - `team_whatsapp.too_many_people` → `Os setores escolhidos têm mais de 2000 pessoas. Escolha menos setores.`
  - **Prévia:**
    - grupo `<setor>, <N> pessoas, pelo <número>`, com vários setores num número separados por `; `;
    - hora `conferido às HH:mm`;
    - aviso `Áreas sem número: <nomes>`, com `Associe um número a esta área em Conexões`, e o link `Conexões` (`/connect`) só para o ADMIN;
    - desconectado `O número <número> está desconectado. Áreas: <nomes>.`;
    - sem resposta `Não foi possível conferir o número. Tente de novo`, com botão `Conferir de novo`;
    - fora `Ficam de fora (N)`, cada item `<nome> · não selecionado` ou `<nome> · sem telefone`;
    - dica `Os filtros do quadro da escala não mudam quem recebe: o envio usa só as escolhas abaixo.`;
    - turnos `Todos os turnos` + um checkbox por turno.
  - **Resultado:**
    - título `Resultado do envio`;
    - colunas `Nome`, `Situação`, `Número`, `Tentativas`, `Motivo`;
    - filtro `Situação` com `Todas`;
    - botões `Repetir` e `Repetir todas as falhas (N)`;
    - toasts `N mensagem(ns) na fila de novo` e `Nada para repetir`;
    - link no histórico `Ver resultado`.
  - **Conexões e setores:**
    - campo `Áreas`;
    - linha `Áreas: <nomes>` ou `Nenhuma área`;
    - botão `Áreas` (edição);
    - confirmação `<área> sai do número <número> e passa para este.` com `Mover` e `Cancelar`;
    - topo `Áreas sem número: <nomes>`;
    - selo `Sem número`.
  - **Número:** exibido com o mesmo formatador que a lista GoZap (`gozap-section.tsx`) usa para `phoneE164`. Sem telefone, o nome do canal.
- **GC12 — Testes enxutos.** Um teste por critério de aceite, mais os riscos do Review Focus, sem duplicar unit e integração. Backend: unit com `vitest-mock-extended` e harness do módulo; integração com `@testcontainers/postgresql` só onde a query, a gravação ou a migração muda. Frontend: `vi.mock` dos hooks de `api.ts`, sem msw.
- **GC13 — Sem extras.**
  - Sem dependência nova, sem serviço novo no compose e sem componente novo em `frontend/src/components/ui/`.
  - Rota nova só `/whatsapp-equipe/$dispatchId`. `src/routeTree.gen.ts` é gerado.
  - Paginação reusa `features/internal-communications/components/pagination.tsx`, e o erro reusa `QueryErrorFallback` (texto dele: `Tentar novamente`, D14).
- **GC14 — Outros fluxos não mudam.** Campanhas, chat da caixa de entrada e comunicados internos continuam escolhendo o canal como hoje. Os ganchos novos no webhook e na ingestão são best-effort, em try/catch, e nunca mudam o resultado do fluxo de mensagem.
- **GC15 — Novidades.** Só a T18 mexe em `frontend/src/release-notes.ts`.

## Contratos compartilhados (fonte: back; o front espelha)

- **C1 — Associação número ↔ áreas** (modelo: T2; API: T3; leitura no setor: T4).
  - **Prisma:**
    - `Sector.channelId String?` + `channel Channel? @relation("SectorChannel", fields: [channelId], references: [id], onDelete: SetNull)` + `@@index([channelId])`;
    - `Channel.sectors Sector[] @relation("SectorChannel")`.
  - **`backend/src/modules/team-whatsapp/sector-channel.ts` (T2):**
    - `SECTOR_CHANNEL_SELECT = { id: true, name: true, phoneE164: true, provider: true, isActive: true } as const`;
    - `type SectorChannelRow = { id: string; name: string; phoneE164: string | null; provider: ChannelProvider; isActive: boolean }`;
    - `type SectorChannelRef = { id: string; name: string; phoneE164: string | null; provider: 'GOZAP' | 'EVOLUTION' }`;
    - `effectiveChannel(row: SectorChannelRow | null): SectorChannelRef | null`.
  - **`PUT /whatsapp/channels/:id/sectors`** (T3, `@Roles('ADMIN')`, vale para GoZap e Evolution).
    - Corpo `{ sectorIds: string[] 0..100 }` (`.strict()`, repetidos contam uma vez).
    - Resposta 200 `{ channelId, sectors: { id, name }[], moved: { sectorId, fromChannelId }[] }`.
    - Setores fora da lista que estavam neste canal ficam sem número.
    - Erros:
      - 404 do canal inexistente (código de hoje do controller);
      - 422 `channel.sectors_not_team` (canal inativo ou fora de GOZAP/EVOLUTION);
      - 422 `channel.sector_invalid` (setor inexistente ou inativo).
  - **Criação:**
    - `POST /whatsapp/channels` `{ provider: 'GOZAP', name, sectorIds?: string[] 0..100 }`;
    - `POST /whatsapp/instances` `{ name, ownerUserId?, isDefault?, sectorIds?: string[] 0..100 }`.
    - Os setores são validados antes de criar a instância no provedor, e a associação é gravada depois.
  - **Listas:** `GET /whatsapp/providers` (cada canal GoZap) e `GET /whatsapp/instances` (cada instância) ganham `sectors: { id, name }[]`, por nome.
  - **Setor (T4):** as respostas de setor (`internal/sectors` lista e detalhe, `internal/sectors/:id/people` `sector`) trocam `numberCount`/`numbers` por `channel: { id, name, phoneE164 } | null` (número efetivo).
- **C2 — Prévia** (T7).
  - `TeamSectorChannel = { id, name, phoneE164: string | null, provider: 'GOZAP' | 'EVOLUTION', live: { state: 'open' | 'connecting' | 'close' | 'unknown', checkedAt: string /* ISO */ } }`.
  - `GET /internal/team-whatsapp/roster`: cada `sectors[]` ganha `channel: TeamSectorChannel | null`.
  - `GET /internal/team-whatsapp/person-route?userId=` → `{ userId, sector: { id, name } | null, channel: TeamSectorChannel | null }`, com 403 pela GC5 (`canSendToUser`). O setor é o do dia de hoje: exceção "Outro setor" da escala, senão `User.sectorId`.
  - `GET targets` não muda (o front para de ler `channels`).
- **C3 — POST de envio** (turnos: T6; número: T8).
  - Alvo setor: `{ type: 'sector', sectorIds, shiftIds?: string[] 1..20, userIds?, date, includeOff?, levelIds?, withoutLevel? }`. `shiftId` sozinho vira `shiftIds: [shiftId]`; os dois juntos = 400.
  - `includeOff` só sem `shiftIds`. `when: 'shift_start'` exige alvo setor com exatamente um turno.
  - `channelId` é aceito e ignorado (`z.string().optional()`), para a aba aberta durante o deploy.
  - Ordem das recusas:
    1. remetente;
    2. política de cada setor (403);
    3. turnos (422 `invalid_shift`);
    4. níveis;
    5. lista refeita (422 `too_many_people` se passar de 2000);
    6. seleção (422 `invalid_selection`);
    7. área sem número (422 `team_whatsapp.sector_without_number`);
    8. agendamento (`invalid_shift`/`schedule_in_past`);
    9. no envio imediato, estado ao vivo de cada número dos setores selecionados (409 `team_whatsapp.channel_disconnected`, que vence `team_whatsapp.channel_unverified`);
    10. resto como hoje.
  - Alvo pessoa: sem setor no dia → 422 `team_whatsapp.no_sector`; setor sem número → 422 `sector_without_number`; depois, o mesmo estado ao vivo.
  - Resposta igual à de hoje.
- **C4 — Destinatário** (modelo: T2; gravação: T8, T9, T10, T12).
  - **Enum `TeamWhatsappRecipientStatus`:** os de hoje + `DELIVERED`, `READ`, `REPLIED`, `UNCERTAIN`, no fim do enum.
  - **`TeamWhatsappRecipient` ganha:**
    - `channelId String?` + `channel Channel? @relation("TeamRecipientChannel", fields: [channelId], references: [id], onDelete: SetNull)`;
    - `channelName String?`, `channelPhoneE164 String?` (snapshot);
    - `contactId String?` (sem FK);
    - `attempts Int @default(0)`, `manualRetries Int @default(0)`;
    - `acceptedAt DateTime?`, `deliveredAt DateTime?`, `readAt DateTime?`, `repliedAt DateTime?`;
    - `@@index([messageId])`, `@@index([channelId, contactId, acceptedAt])`.
  - **`backend/src/modules/team-whatsapp/team-whatsapp.outcome.ts` (T9):**
    - `INDETERMINATE_CODE = 'team_whatsapp.indeterminate'`;
    - `NOT_REPEATABLE_CODES = new Set(['evolution.number_not_on_whatsapp', 'gozap.not_on_whatsapp', 'gozap.invalid_recipient', 'team_whatsapp.message_missing'])`;
    - `failureStatus(code: string, redispatchable: (code: string) => boolean): 'FAILED' | 'UNCERTAIN'`, que devolve `UNCERTAIN` quando `code === INDETERMINATE_CODE || !redispatchable(code)`;
    - `isRepeatable(status: TeamWhatsappRecipientStatus, errorCode: string | null): boolean`, verdadeiro quando `status === 'FAILED' && errorCode !== null && !NOT_REPEATABLE_CODES.has(errorCode) && !errorCode.endsWith('.timeout')`.
  - **Ordem:** `QUEUED 0 < SENT 1 < DELIVERED 2 < READ 3 < REPLIED 4`. `UNCERTAIN` sobe para `DELIVERED`/`READ` com recibo. `FAILED`, `SKIPPED` e `CANCELLED` são terminais.
- **C5 — Listas e resultado** (paginação: T1; formato novo e detalhe: T11).
  - `pageQuerySchema` (`backend/src/modules/team-whatsapp/dto/page-query.dto.ts`): `{ page: coerce int ≥ 1, default 1; pageSize: coerce int 1..50, default 20 }` → `type PageQuery = { page: number; pageSize: number }`.
  - `GET dispatches?page&pageSize` e `GET scheduled?page&pageSize` → `{ items, total, page, pageSize }`.
  - Na T11, cada item do histórico perde `recipients`, `unselected`, `off` e `channel` e ganha:
    - `channels: { name: string | null, phoneE164: string | null, count: number }[]`, agrupado pelo snapshot dos destinatários;
    - `counts: { queued, sent, delivered, read, replied, failed, uncertain, skipped, scheduled, cancelled }`.
  - `GET dispatches/:id` → `{ id, targetLabel, text, state, createdAt, scheduledFor, firedAt, author: { id, name } | null, sectors: { id, name }[], counts, channels, leftOut: { unselected: RosterPerson[], off: RosterPerson[] } }`.
  - `GET dispatches/:id/recipients?status&page&pageSize` (pageSize 1..100, default 50; `status` opcional, um valor do enum), por `userName` e depois `id`:
    - resposta `{ items, total, page, pageSize }`;
    - cada item `{ id, userName, sectorName, levelName, shiftName, status, reason: string | null /* skipReason ?? errorCode */, attempts, channel: { name, phoneE164 } | null, acceptedAt, deliveredAt, readAt, repliedAt, repeatable: boolean /* isRepeatable */ }`.
  - Envio que o ator não vê (GC5) → 404 `team_whatsapp.dispatch_not_found`.
- **C6 — Repetir** (T12).
  - `POST dispatches/:id/retry`, com corpo `{ recipientIds: string[] 1..100 }` ou `{ all: true }` (cada um `.strict()`) → 200 `{ requeued: number }`.
  - Ordem: remetente (403) → envio visível (404) → pode enviar à área (403) → troca atômica → fila.
  - jobId `teamSendJobId(recipientId, manualRetries)` = `recipientId` quando `manualRetries === 0`, senão `` `${recipientId}-r${manualRetries}` ``.

## Decisões do plano

- **D1 — Associação em `Sector.channelId` (nullable, SetNull).** A regra "no máximo um número por área" fica no próprio modelo. Remover o canal deixa o setor sem número sem código extra. Mover uma área é um `update`.
- **D2 — Número efetivo calculado (`effectiveChannel`), sem apagar a associação ao desativar.**
  - Canal inativo ou fora de GOZAP/EVOLUTION = "sem número" em todo lugar: envio, prévia, setores, conexões.
  - Uma função só serve às telas e ao servidor, e os fluxos de desativar e remover (`gozapInstances.remove`, Evolution `delete`/`PATCH`) não mudam.
- **D3 — Canal por destinatário com snapshot.**
  - `channelId` + `channelName` + `channelPhoneE164` no destinatário. O grupo por número é o agrupamento dos destinatários, sem tabela nova.
  - `TeamWhatsappDispatch.channelId` = o canal quando o envio tem um número só; `null` com mais de um.
  - Backfill: o canal do envio, com nome e telefone. O snapshot preserva o histórico se o canal for removido; com o plano GoZap de uma vaga, remover e recriar é provável.
- **D4 — `SectorNumber` migrado e aposentado.**
  - O passo 1 da seção 9 usa o cadastro. Depois saem a tela "Números e canais" (`NumberRegistry`), as rotas `POST`/`PATCH /internal/numbers` e `numbers`/`numberCount` das respostas de setor.
  - A tabela e o `GET` ficam, sem perda de dados. Fonte única: `Sector.channelId`, editada em Conexões.
  - `routeToSector` não tem consumidor, então a entrada de mensagens não muda.
- **D5 — Status.**
  - `SENT` continua no banco e passa a significar "Aceito pelo WhatsApp" (só o rótulo muda). Entram `DELIVERED`, `READ`, `REPLIED` e `UNCERTAIN`.
  - Renomear `SENT` reescreveria todas as linhas e quebraria o worker antigo no meio do deploy.
  - Migração: `FAILED` com código incerto (`team_whatsapp.indeterminate`, `%.timeout`, os códigos de `TEAM_NEVER_REDISPATCH_CODES` do `chat.service.ts`) → `UNCERTAIN`. O resto fica.
  - Daqui em diante, o processor grava `UNCERTAIN` em vez de `FAILED` + indeterminate.
- **D6 — Tentativas.**
  - `attempts` sobe 1 imediatamente antes de cada `chat.sendTeamMessage`, automática ou manual. Pré-checagem, recusa por número e caminho `priorOutcome` não contam.
  - `manualRetries` conta as repetições e compõe o jobId.
  - Envios antigos ficam com `attempts = 0`, e a tela mostra `—`.
- **D7 — Estado ao vivo.**
  - Porta `ChannelLiveStateService` no `WhatsappProvidersModule`. GOZAP → `GozapInstancesService.reconcileConnection(channelId)` (só `GET /instance/status`; nunca `getConnectionInfo`, que pode abrir sessão). EVOLUTION → `EvolutionApiAdapter.getLiveConnectionState(evolutionInstanceName)`. Sem nome, `unknown`: nunca chamar sem argumento, que cai na instância padrão. Erro ou `null` → `unknown`.
  - Cache por processo de `LIVE_STATE_TTL_MS = 15_000` por canal, só de estados observados (`unknown` não entra). Só `open` libera.
  - Usos:
    - prévia (roster e person-route);
    - POST imediato (bloqueia);
    - processor, antes de cada envio: `close`/`connecting` → `FAILED team_whatsapp.channel_disconnected`, repetível; `unknown` → retry do BullMQ e, na última tentativa, `FAILED team_whatsapp.channel_unverified`, repetível, porque nada saiu.
  - **Agendado:** a criação não consulta o provedor, porque o número pode reconectar até o turno. O disparo confere pelo precheck do processor: a primeira mensagem de cada pessoa é conferida segundos depois do `claimScheduled`, sem chamada ao provedor dentro da transação. O `claimScheduled` passa a checar o canal de cada destinatário (inativo/fora → `FAILED team_whatsapp.channel_unavailable`).
- **D8 — Pessoa sem área (alvo pessoa) = 422 `team_whatsapp.no_sector`.** O envio para uma pessoa é um só, então recusar o pedido é mais claro que gravar um pulado. Na prévia, a pessoa aparece bloqueada com `Esta pessoa não tem área.`
- **D9 — Vários turnos.**
  - `shiftIds[]`, com `shiftId` como apelido.
  - `when='shift_start'` exige exatamente um turno: a hora do disparo é o início de um turno, e com vários não há uma só. É a regra mais conservadora; o front habilita "No início do turno" só com um turno marcado.
  - As colunas `shiftId/shiftName/shiftStartTime/shiftEndTime` do envio só são preenchidas com um turno; com vários ficam `null`, e os nomes vão no `targetLabel`.
  - Rótulo do turno: um → o nome; vários → pela ordem de `listActiveShifts`, até dois nomes com `, ` e mais de dois com ` +N` (`Dia, Noite +1`); nenhum → `todos os turnos`.
- **D10 — Recibos e respostas num serviço só com Prisma.** `TeamRecipientTrackingService` em `team-whatsapp/tracking/`, num `TeamTrackingModule` sem imports (o `PrismaModule` é `@Global`). Assim `WebhooksModule` e `ChatModule` o importam sem ciclo; o `TeamWhatsappModule` depende do chat.
- **D11 — "Respondeu".**
  - Casa por `channelId` + `contactId` do destinatário. O snapshot é gravado pelo processor no `prepare`, a partir do `contactId` da `Message`, e o backfill vem da `Message` antiga.
  - A mensagem recebida traz `contactIds = [contact.id, ...twinIds]`, o que cobre o 9º dígito e o `@lid` sem telefone.
  - Marca só o destinatário mais recente daquele número com `acceptedAt < receivedAt`. Se esse já é `REPLIED`, nada muda, e a segunda mensagem não desce para um envio mais antigo.
- **D12 — Repetir.**
  - Troca atômica por SQL cru, `UPDATE "TeamWhatsappRecipient" SET status='QUEUED', "errorCode"=NULL, "manualRetries"="manualRetries"+1, "updatedAt"=now() WHERE "dispatchId"=$1 AND status='FAILED' AND <repetível> [AND id = ANY($2)] RETURNING id, "manualRetries"`.
  - Um comando só devolve exatamente as linhas que esta chamada tirou de `FAILED`. Dois cliques ou duas abas: uma recebe a linha, a outra recebe vazio.
  - jobId novo por repetição: o BullMQ 5 ignora `add` com o id de um job retido (`removeOnFail` 24 h) e recusa `:` em jobId.
  - Falha ao enfileirar → `markFailed(ids, 'team_whatsapp.queue_unavailable')`, que é repetível, e relança, como o `enqueueTeamSend`.
  - O processor reaproveita a mesma `Message`: `sendTeamMessage` já re-despacha uma linha `FAILED`. Mesmo destinatário, texto e número.
- **D13 — D-01.**
  - Histórico e agendados com `page/pageSize` + `total` e o `Pagination` existente.
  - O histórico deixa de trazer os destinatários (era `listRecipients` sem limite); eles vão para o detalhe paginado.
  - Lista do dia: uma rodada de consultas para todos os setores (`loadDayPeopleMany`) com teto de 2000 pessoas (`DAY_PEOPLE_LIMIT`; passou → 422 `too_many_people`, nunca corte silencioso).
  - Quadro da escala: `BOARD_PEOPLE_LIMIT = 500` por setor, com `truncated` na resposta e aviso na tela.
  - Front sem erro recuperável hoje: roster no diálogo (T13), person-route (T14), detalhe e destinatários (T16), setores em Conexões (T17).
- **D14 — Texto do erro recuperável = o do `QueryErrorFallback` (`Tentar novamente`).** A spec §8 manda reaproveitar o componente e o texto; o aceite diz "Tentar de novo". Mudar o componente mexeria em todas as telas e specs; a divergência fica registrada para o usuário.
- **D15 — Aviso de áreas sem número uma vez só, no topo de `/connect`.** Cobre GoZap e Evolution, calculado no front a partir de `useSectors(true)` (setores ativos com `channel === null`).
- **D16 — Confirmação de mover só no front.** O servidor move, porque só o ADMIN chama a rota. O front monta a confirmação a partir do `channel` de cada setor.

## Review Focus (riscos da spec → teste → task)

1. **R1 — Remanejado.** Quem está "Outro setor" na data recebe pelo número da área onde atua, não pela de origem → T8 "remanejado de Logística para Expedição recebe pelo número da Expedição".
2. **R2 — Número desativado com áreas.** As áreas dele contam como sem número no POST, na prévia, nos setores e no aviso de Conexões → T7 "canal inativo → channel null", T8 "setor com canal inativo → 422 sector_without_number", T4 `it.each` (inativo, TWILIO, nenhum).
3. **R3 — `connecting` e sessão caindo.** Não é `open`, então trava como desconectado. Evolution sem `evolutionInstanceName` nunca consulta a instância padrão → T5 `it.each`, T9 "connecting → channel_disconnected".
4. **R4 — Recibo antes do fim do processor.** `QUEUED` → `DELIVERED` preenche `acceptedAt`, e o `finish(SENT)` não regride → T10.
5. **R5 — Repetir com fila fora do ar.** O destinatário volta a `FAILED queue_unavailable`, repetível, e não fica preso em `QUEUED` → T12.
6. **R6 — Deploy com aba antiga.** Corpo com `channelId` + `shiftId` continua aceito, e o `channelId` é ignorado → T6 e T8.

## Riscos aceitos e pendências

- **M1 — Transição na GBR.** Se a produção tiver mais de um canal elegível ativo (por exemplo um Evolution ativo além do GoZap) e nenhum padrão elegível, a regra da spec cai no passo 4 e o envio fica bloqueado até o ADMIN associar. A principal confere, antes do deploy e só lendo, quantos canais `isActive` GOZAP/EVOLUTION existem e qual é `isDefault`. Se cair no passo 4, avisa o usuário (Fechamento).
- **M2 — Cache do estado por processo** (API e worker separados): até 15 s sem notar uma queda. Vale a garantia da spec ("número que se sabe desconectado").
- **M3 — Recibo best-effort.** Se a atualização do destinatário falhar depois de a `Message` já ter subido, o replay do webhook é descartado pelo dedup e o destinatário fica um degrau abaixo. Fica no log, sem retry.
- **M4 — D-01 sem reprodução.** Reproduzir as falhas de 26/10 exige conta de teste na versão publicada (a senha do seed não vale mais). Entra pelo código, e a reprodução fica pendente no ledger.

---

### Task 1: back — D-01: limites, lista do dia em uma rodada, paginação de histórico e agendados

**Risco:** médio · **Revisão:** não crítica · **Depende de:** —

**Files:**
- Modify: `backend/src/modules/team-whatsapp/team-whatsapp.repository.ts` (`findMembersForDay` ~252, `loadDayPeople` ~271, `listScheduled` ~447, `listDispatches` ~473)
- Modify: `team-whatsapp.service.ts` (`resolveSector` → `sectorDays`; `listDispatches`), `team-whatsapp-schedule.service.ts` (`listScheduled`), `team-whatsapp.controller.ts`, `team-whatsapp.errors.ts`, `backend/src/schemas/contracts/team-whatsapp.schema.ts`
- Create: `backend/src/modules/team-whatsapp/dto/page-query.dto.ts`
- Modify: `backend/src/modules/staff-schedule/staff-schedule.repository.ts` (`listSectorPeople` ~196, `listVisitorIds` ~212, novo `listVisitorIdsBySector`), `staff-schedule.service.ts` (`board` ~66) e o contrato do quadro
- Test: `team-whatsapp.repository.integration.spec.ts`, `team-whatsapp.service.list.spec.ts`, `dto/page-query.dto.spec.ts`, `staff-schedule.repository.integration.spec.ts`, `staff-schedule.service.spec.ts`

**Contexto vinculado:**
- Spec §8: limitar `findMembersForDay`, `listScheduled` e as consultas do quadro (`listSectorPeople`, `listVisitorIds`); reduzir o recálculo por setor; paginar o histórico, que hoje mostra só os 20 últimos (`RECENT_DISPATCHES`).
- D13: `page/pageSize` + `total`; lista do dia em uma rodada para todos os setores, com teto `DAY_PEOPLE_LIMIT = 2000` (passou → 422 `team_whatsapp.too_many_people`, nunca corte silencioso); quadro `BOARD_PEOPLE_LIMIT = 500` por setor com `truncated`.
- GC5: histórico — ADMIN vê todos, os demais só os próprios (`authorId`); agendados do gestor só com todos os setores geridos (regra `every` de hoje).
- C5: `pageQuerySchema` `{ page ≥ 1 default 1, pageSize 1..50 default 20 }`; listas → `{ items, total, page, pageSize }`.

**Interfaces:**
- Produces:
  - `PageQuery`, `pageQuerySchema`, `PageQueryDto`;
  - `repo.loadDayPeopleMany(sectorIds: readonly string[], date: CivilDate): Promise<Map<string, TeamMemberWithSchedule[]>>`, que substitui o `Promise.all` de `loadDayPeople` no `resolveSector` e no roster;
  - `repo.listDispatches(authorId: string | null, page: PageQuery): Promise<{ rows: TeamDispatchRow[]; total: number }>`;
  - `repo.listScheduled(onlySectorIds: readonly string[] | null, page: PageQuery): Promise<{ rows: ScheduledRow[]; total: number }>`;
  - `staffRepo.listVisitorIdsBySector(sectorIds: readonly string[], from: CivilDate, to: CivilDate): Promise<Map<string, string[]>>`;
  - `staffRepo.listSectorPeople(sectorId, take: number)`, `staffRepo.listVisitorIds(sectorId, from, to, take?: number)`;
  - quadro com `truncated: boolean`;
  - erro `tooManyPeople()` → 422 `team_whatsapp.too_many_people`.

- [ ] **Step 1: testes que falham**
  - `page-query.dto.spec.ts` `it.each`: `{}` → `{page:1,pageSize:20}`; `pageSize: '51'` → 400; `page: '0'` → 400.
  - Repository integration, `describe('paginação')`:
    - 25 envios do autor A e 3 do B: `listDispatches('A', {page:2,pageSize:20})` → 5 linhas, `total 25`, todas do A, ordem `createdAt desc`;
    - `listDispatches(null, {page:1,pageSize:50})` → 28;
    - `listScheduled` do gestor de A com envio A, A+B e B → só A, `total 1`.
  - Repository integration, `describe('lista do dia em uma rodada')`:
    - `loadDayPeopleMany([A,B], date)` devolve as mesmas pessoas e situações que `loadDayPeople(A)` e `loadDayPeople(B)`, com o visitante "Outro setor" em B;
    - com 2001 ativos nos setores pedidos → lança `team_whatsapp.too_many_people`.
  - `staff-schedule.service.spec.ts`: setor com 501 pessoas → `rows.length === 500` e `truncated === true`; com 3 → `truncated === false`.
- [ ] **Step 2: rodar e ver FAIL.** `cd backend && TESTCONTAINERS_ENABLED=1 timeout 600 gate --test src/modules/team-whatsapp/team-whatsapp.repository.integration.spec.ts` e os demais.
- [ ] **Step 3: implementar.**
  - `loadDayPeopleMany` faz uma consulta de cada: `listVisitorIdsBySector`; `user.findMany({ where: { isActive: true, OR: [{ sectorId: { in } }, { id: { in: visitantes } }] }, orderBy: name, take: DAY_PEOPLE_LIMIT + 1 })`; `loadScheduleData(todos, date, date)`. Depois agrupa por setor (membro do setor ou visitante dele).
  - `listDispatches`/`listScheduled` usam `$transaction([findMany({ skip, take }), count()])`. Controller com `@Query() PageQueryDto`; resposta com `total/page/pageSize`. Os itens continuam no formato de hoje (a T11 muda).
  - O quadro pede `take: BOARD_PEOPLE_LIMIT + 1` e corta. `RECENT_DISPATCHES` sai.
- [ ] **Step 4: rodar e ver PASS** (os specs acima e `team-whatsapp.service.sectors.spec.ts`, `team-whatsapp.service.single-sector.spec.ts` verdes sem mudar asserções).
- [ ] **Step 5: fechar.** `cd backend && timeout 600 gate --changed --base origin/main`.

### Task 2: back — migrações: área ↔ número, canal e rastreio por destinatário, status novos

**Risco: crítico (produção)** — a migração associa setores de produção a canais e reescreve o status de destinatários existentes (`FAILED` incerto → `UNCERTAIN`), com backfill de canal, contato e `acceptedAt`. · **Revisão:** crítica · **Depende de:** —

**Files:**
- Modify: `backend/prisma/schema.prisma` (`Sector` ~145, `Channel` ~1237, enum ~1626, `TeamWhatsappRecipient` ~1696)
- Create: `backend/prisma/migrations/20261110090000_sector_channel/migration.sql`, `.../20261110091000_team_recipient_status_values/migration.sql`, `.../20261110092000_team_recipient_tracking/migration.sql`
- Create: `backend/src/modules/team-whatsapp/sector-channel.ts`, `sector-channel.spec.ts`
- Create: `backend/src/modules/team-whatsapp/team-number-by-area.migration.integration.spec.ts`
- Test (de novo): `backend/src/modules/shifts/shift-migration.integration.spec.ts` (drift)

**Contexto vinculado:**
- Spec §9 (transição), a associação das **áreas ativas**, nesta ordem:
  1. setor com `SectorNumber` ligado a canal elegível → esse canal;
  2. os demais → canal `isDefault`, se elegível;
  3. sem padrão elegível → o único elegível;
  4. mais de um elegível e nenhum padrão elegível → sem número.

  Elegível = `isActive` e provider `GOZAP` ou `EVOLUTION`; TWILIO/ZERNIO nunca contam, mesmo como padrão. Áreas criadas depois começam sem número.
- Anti-objetivos: perder ou reescrever o histórico, inclusive o canal usado; o envio da GBR parar no dia da implantação.
- C1:
  - Prisma: `Sector.channelId String?` + `channel Channel? @relation("SectorChannel", fields: [channelId], references: [id], onDelete: SetNull)` + `@@index([channelId])`; `Channel.sectors Sector[] @relation("SectorChannel")`.
  - `sector-channel.ts`: `SECTOR_CHANNEL_SELECT = { id, name, phoneE164, provider, isActive: true }`; `SectorChannelRow`/`SectorChannelRef`; `effectiveChannel(row)` → ref só se `isActive` e provider GOZAP/EVOLUTION, senão `null`.
- C4:
  - Enum: os de hoje + `DELIVERED`, `READ`, `REPLIED`, `UNCERTAIN`, no fim.
  - O destinatário ganha:
    - `channelId String?` (relação `"TeamRecipientChannel"`, SetNull);
    - `channelName String?`, `channelPhoneE164 String?`;
    - `contactId String?` (sem FK);
    - `attempts Int @default(0)`, `manualRetries Int @default(0)`;
    - `acceptedAt`, `deliveredAt`, `readAt`, `repliedAt` (`DateTime?`);
    - `@@index([messageId])`, `@@index([channelId, contactId, acceptedAt])`.
- D3: backfill do canal = canal do envio, com `channelName`/`channelPhoneE164`. D5: `SENT` fica; `FAILED` com `team_whatsapp.indeterminate`, `LIKE '%.timeout'` ou código de `TEAM_NEVER_REDISPATCH_CODES` (`backend/src/modules/chat/chat.service.ts` ~74; copiar os literais para o SQL) → `UNCERTAIN`. D11: `contactId` do destinatário vem de `Message.contactId` por `messageId`.
- GC3/GC4: só aditivo; nomes fixos; `ADD VALUE` sozinho na 2ª migração; valores novos no fim do enum; drift de novo.

**Interfaces:**
- Produces: modelo C1/C4 gerado no Prisma client; `effectiveChannel`, `SectorChannelRow`, `SectorChannelRef`, `SECTOR_CHANNEL_SELECT` (C1). Se o `tsc` acusar `Record<TeamWhatsappRecipientStatus, …>` incompleto, completar com as chaves novas, sem mudar comportamento (a T11 dá o significado).

- [ ] **Step 1: testes que falham.**
  - `sector-channel.spec.ts` `it.each`: GOZAP ativo → ref sem `isActive`; EVOLUTION ativo → ref; GOZAP inativo → `null`; TWILIO ativo → `null`; `null` → `null`.
  - `team-number-by-area.migration.integration.spec.ts`: um container Postgres 16, um banco por cenário (`CREATE DATABASE`), `deployMigrations({ databaseUrl, until: '20261022110000_team_dispatch_sectors' })`, dados legados em SQL cru (padrão de `team-dispatch-sectors.integration.spec.ts`) e depois `deployMigrations({ databaseUrl })`.
    - `describe('associação')` `it.each`:

      | Cenário | Resultado |
      |---|---|
      | (a) GOZAP padrão + EVOLUTION ativo; Logística com `SectorNumber` → EVOLUTION | Logística = EVOLUTION, RH = GOZAP |
      | (b) `SectorNumber` de Logística → TWILIO; GOZAP padrão | Logística = GOZAP |
      | (c) TWILIO padrão + um GOZAP não padrão | todas = GOZAP |
      | (d) dois GOZAP ativos, nenhum padrão | todas `null` |
      | (e) setor inativo | `null` em qualquer cenário |
      | (f) GOZAP padrão inativo + EVOLUTION ativo | todas = EVOLUTION |

      Em (a) e (b), o setor com dois `SectorNumber` elegíveis fica com o padrão; sem padrão, com o canal de `createdAt` mais antigo.
    - `describe('destinatários legados')`: envio com canal C (nome `GBR`, `+5592999991111`).
      - `SENT` com `Message` (`contactId K`, `sentAt T`) → `SENT`, `channelId C`, `channelName 'GBR'`, `channelPhoneE164 '+5592999991111'`, `contactId K`, `acceptedAt T`, `attempts 0`.
      - `it.each` de `FAILED`: `team_whatsapp.indeterminate` → `UNCERTAIN`; `gozap.timeout` → `UNCERTAIN`; `gozap.not_on_whatsapp` → `FAILED`; `team_whatsapp.channel_disconnected` → `FAILED`. O `errorCode` fica.
      - `SKIPPED`/`SCHEDULED`/`CANCELLED` sem mudança de status.
      - Envio sem canal → destinatário com `channelId null`.
  - Drift: o `describe('schema sem drift (igual ao CI)')` continua verde.
- [ ] **Step 2: rodar e ver FAIL.**
- [ ] **Step 3: implementar.**
  - DDL por `migrate diff` (GC3), depois o SQL de dados.
  - Na 1ª migração, os passos 1→4 como `UPDATE … FROM`, cada um só em `"Sector"."isActive" AND "channelId" IS NULL`. Passo 1 com `DISTINCT ON ("sectorId")` ordenando o canal por `isDefault DESC, "createdAt" ASC, id ASC`.
  - Na 3ª migração, o backfill e o mapeamento `UNCERTAIN`.
- [ ] **Step 4: rodar e ver PASS** (os dois specs + drift).
- [ ] **Step 5: fechar.** `timeout 600 gate --changed --base origin/main` (cwd `backend`).

### Task 3: back — associar áreas ao número: serviço, `PUT …/sectors`, criação GoZap/Evolution, listas

**Risco:** alto (contrato público, rota ADMIN nova) · **Revisão:** não crítica, revisor dedicado · **Depende de:** T2

**Files:**
- Create: `backend/src/modules/whatsapp-providers/sector-channel.service.ts`, `sector-channel.integration.spec.ts`
- Modify: `whatsapp-providers.module.ts` (provider + export), `whatsapp-providers.controller.ts` (`POST channels` ~351, nova rota `PUT channels/:id/sectors`), `backend/src/schemas/contracts/instance.schema.ts` (`createChannelSchema` :24 + `updateChannelSectorsSchema`), o serviço que monta `GET providers` (`lastStates` ~147) e o schema de resposta dele
- Modify: `backend/src/modules/whatsapp-instances/whatsapp-instances.service.ts` (`create` :147, lista), DTO `CreateInstanceDto`, `whatsapp-instances.module.ts` (importar `WhatsappProvidersModule`, se ainda não importa)
- Test: `whatsapp-providers.controller.spec.ts`, `whatsapp-instances.service.spec.ts`

**Contexto vinculado:**
- Spec §1:
  - um número atende uma ou mais áreas, escolhidas no diálogo de nova conexão e editáveis depois;
  - só o ADMIN associa;
  - uma área tem no máximo um número, e a já associada é movida (a confirmação fica no front, D16).
- C1: rota `PUT /whatsapp/channels/:id/sectors` `{ sectorIds: string[] 0..100 }` → `{ channelId, sectors, moved }`; setores fora da lista saem do número. Erros 422 `channel.sectors_not_team` (canal inativo ou fora de GOZAP/EVOLUTION) e `channel.sector_invalid` (setor inexistente/inativo). Criação com `sectorIds?`, validados **antes** de criar no provedor. Listas com `sectors: { id, name }[]`.
- GC5: `@Roles('ADMIN')`. GC8: auditoria com ids (`channel.sectors_update` `{ channelId, sectorIds, moved }`).

**Interfaces:**
- Produces:
  - `SectorChannelService.assertAssignable(sectorIds: readonly string[]): Promise<string[] /* únicos */>`;
  - `assign(input: { channelId: string; sectorIds: readonly string[]; actorId: string }): Promise<ChannelSectorsResult>`;
  - `sectorsByChannel(channelIds: readonly string[]): Promise<Map<string, { id: string; name: string }[]>>`;
  - `type ChannelSectorsResult = { channelId: string; sectors: { id: string; name: string }[]; moved: { sectorId: string; fromChannelId: string }[] }`.

- [ ] **Step 1: testes que falham.**
  - Integration (`sector-channel.integration.spec.ts`):
    - "Logística e Expedição passam ao número X";
    - "Expedição estava em Y → `moved: [{sectorId: Expedição, fromChannelId: Y}]` e Y fica sem ela";
    - "RH estava em X e não veio na lista → `channelId null`";
    - "lista vazia tira todas";
    - `it.each` canal TWILIO / GOZAP inativo → 422 `channel.sectors_not_team`;
    - setor inativo / inexistente → 422 `channel.sector_invalid`, e nada muda.
  - Controller:
    - `PUT` com SUPERVISOR → 403 (RolesGuard);
    - `POST channels` GOZAP com `sectorIds` → `assertAssignable` antes de `gozapInstances.createChannel` e `assign` depois;
    - `assertAssignable` rejeita → `createChannel` não é chamado.
  - Evolution service: `create({ name, sectorIds })` → `assertAssignable` antes de `evo.createInstance`, `assign` depois de `repo.create`; sem `sectorIds` não chama `assign`.
  - Lista de providers e de instances: canal com dois setores → `sectors` por nome.
- [ ] **Step 2: rodar e ver FAIL.**
- [ ] **Step 3: implementar.** O `assign` roda em `$transaction`: lê os setores pedidos com o `channelId` atual (para `moved`), `updateMany` de quem sai e `updateMany` de quem entra, e audita depois.
- [ ] **Step 4: rodar e ver PASS.**
- [ ] **Step 5: fechar** (`gate --changed`, cwd `backend`).

### Task 4: back — setor mostra o número; "Números e canais" aposentado

**Risco:** médio · **Revisão:** não crítica · **Depende de:** T2

**Files:**
- Modify: `backend/src/modules/internal-sectors/internal-sectors.repository.ts` (:15, :51-60), `internal-sectors.service.ts` (:21, :40), o schema de contrato do setor
- Modify: `backend/src/modules/sector-people/` (resposta `GET …/people` `sector`)
- Modify: `backend/src/modules/internal-numbers/internal-numbers.controller.ts`, `.service.ts` (remover `create` :52, `update` :67, `assertReferences` :88, `assertPhoneAvailable` :118), `src/schemas/contracts/internal-number.schema.ts` (remover create/update), `dto/internal-number.dto.ts`
- Test: `internal-sectors.service.spec.ts`, `internal-sectors.controller.spec.ts`, specs de `sector-people`, `internal-numbers.*.spec.ts`, `internal-number.schema.spec.ts`

**Contexto vinculado:**
- Spec §1: uma só fonte da verdade; não pode haver dois lugares que definam a área de um número. Spec §2: selo "Sem número" na lista e na página do setor.
- D2: número efetivo por `effectiveChannel` (inativo ou TWILIO/ZERNIO = sem número).
- D4: saem `POST`/`PATCH /internal/numbers` e `numbers`/`numberCount` das respostas de setor; ficam a tabela e o `GET`.
- C1: setor responde `channel: { id, name, phoneE164 } | null`, com select `SECTOR_CHANNEL_SELECT`.
- Pergunta resolvida na task: as telas `/setores` (lista e página) do não-ADMIN leem setor por `sector-people` ou por outro endpoint. Localizar com LSP (`findReferences` dos hooks usados em `R/setores/index.tsx` e `$sectorId.tsx`) e pôr `channel` em todo resumo de setor que essas telas leem.

**Interfaces:**
- Consumes: `effectiveChannel`, `SECTOR_CHANNEL_SELECT` (T2).
- Produces: `channel` nos resumos de setor (C1).

- [ ] **Step 1: testes que falham.**
  - `internal-sectors.service.spec.ts` `it.each`: canal GOZAP ativo → `channel {id,name,phoneE164}`; canal inativo → `null`; TWILIO → `null`; sem canal → `null`; a resposta não tem `numberCount` nem `numbers`.
  - `sector-people`: `GET …/people` → `sector.channel`.
  - `internal-numbers.controller.spec.ts`: o controller não expõe `create`/`update`; `GET /` continua.
- [ ] **Step 2: rodar e ver FAIL.**
- [ ] **Step 3: implementar.** Remover os testes dos métodos apagados, sem tocar na tabela.
- [ ] **Step 4: rodar e ver PASS.**
- [ ] **Step 5: fechar** (`gate --changed`, cwd `backend`).

### Task 5: back — porta de estado ao vivo do número

**Risco:** médio · **Revisão:** não crítica · **Depende de:** T3 (mesmo `whatsapp-providers.module.ts`)

**Files:**
- Create: `backend/src/modules/whatsapp-providers/channel-live-state.service.ts`, `channel-live-state.service.spec.ts`
- Modify: `whatsapp-providers.module.ts` (provider + export)

**Contexto vinculado:**
- Spec §5: consultar no provedor o estado de cada número envolvido, em vez do último evento. Se o provedor não responder, o envio trava. A frequência real (cache curto por número) fica com o construtor, desde que nunca se envie por um número que se sabe desconectado.
- D7:
  - GOZAP → `GozapInstancesService.reconcileConnection(channelId): Promise<ConnectionState | null>`, nunca `getConnectionInfo`;
  - EVOLUTION → `EvolutionApiAdapter.getLiveConnectionState(evolutionInstanceName)`, e sem nome → `unknown`, sem chamar;
  - erro ou `null` → `unknown`;
  - cache `LIVE_STATE_TTL_MS = 15_000` por canal, só de estados observados;
  - só `open` libera.

**Interfaces:**
- Produces:
  - `type LiveState = 'open' | 'connecting' | 'close' | 'unknown'`;
  - `type LiveCheck = { channelId: string; state: LiveState; checkedAt: Date }`;
  - `type LiveCheckChannel = { id: string; provider: ChannelProvider; evolutionInstanceName: string | null }`;
  - `ChannelLiveStateService.check(channel: LiveCheckChannel): Promise<LiveCheck>`;
  - `checkMany(channels: readonly LiveCheckChannel[]): Promise<Map<string, LiveCheck>>` (ids repetidos consultam uma vez, em paralelo);
  - `LIVE_STATE_TTL_MS`.

- [ ] **Step 1: testes que falham** (`vi.useFakeTimers`, `mockDeep` dos dois serviços).
  - `it.each` GOZAP: reconcile `'open'`/`'close'`/`'connecting'` → o mesmo; `null` → `unknown`; lança → `unknown`.
  - EVOLUTION com nome `'gbr'` → `getLiveConnectionState('gbr')`.
  - EVOLUTION com nome `null` → `unknown` e o adaptador não é chamado.
  - TWILIO → `unknown`.
  - Cache: duas chamadas em 14 s → uma consulta; depois de 15 s → duas; `unknown` não fica em cache.
  - `checkMany` com `[X, X, Y]` → duas consultas.
  - `checkedAt` = hora da consulta (em cache, a da consulta original).
- [ ] **Step 2: rodar e ver FAIL.**
- [ ] **Step 3: implementar.** `Map<string, LiveCheck>` em memória.
- [ ] **Step 4: rodar e ver PASS.**
- [ ] **Step 5: fechar** (`gate --changed`, cwd `backend`).

### Task 6: back — PUB-01: vários turnos no mesmo envio

**Risco:** alto (lista conferida = enviada) · **Revisão:** não crítica, revisor dedicado · **Depende de:** T1

**Files:**
- Modify: `backend/src/modules/team-whatsapp/dto/create-team-dispatch.dto.ts`, `team-whatsapp.roster.ts` (`eligibleFor` ~112, `eligibleAcross` ~144), `team-whatsapp.service.ts` (`resolveSector` ~409, `requireShift`, `shiftStartOf` ~546, `shiftColumns`, rótulo), `team-whatsapp.repository.ts` (se `findShift` virar lista)
- Test: `dto/create-team-dispatch.dto.spec.ts`, `team-whatsapp.roster.spec.ts`, `team-whatsapp.service.sectors.spec.ts`, `team-whatsapp.service.schedule.spec.ts`, `team-whatsapp.service.single-sector.spec.ts` (sem mudar asserções)

**Contexto vinculado:**
- Spec §4:
  - vários turnos no mesmo envio, junto com vários setores, e cada pessoa contada uma vez;
  - "Todos os turnos" continua;
  - "incluir quem está de folga" só com todos os turnos.
- C3: `shiftIds?: string[] 1..20`; `shiftId` sozinho → `[shiftId]`; os dois → 400; `includeOff` só sem `shiftIds`; `when='shift_start'` exige alvo setor com exatamente um turno; `channelId` aceito e ignorado.
- D9: colunas de turno do envio só com um turno; rótulo do turno pela ordem de `listActiveShifts` (`Dia, Noite`; mais de dois `Dia, Noite +1`; nenhum `todos os turnos`).
- GC6: a lista é refeita no servidor; 422 `invalid_selection` sem efeito.
- Caracterização: `team-whatsapp.service.single-sector.spec.ts` (um setor, sem nível) fica idêntico, com `shiftId` e com `shiftIds: [id]`.

**Interfaces:**
- Produces:
  - `CreateTeamDispatchInput.target.shiftIds?: string[]` (sem `shiftId` depois do preprocess);
  - `eligibleFor(member, opts: { shiftIds: ReadonlySet<string> | null; includeOff: boolean; level })`;
  - `MAX_SHIFTS = 20`.

- [ ] **Step 1: testes que falham.**
  - DTO, `it.each`:

    | Corpo | Resultado |
    |---|---|
    | `shiftIds: [D, N]` | ok |
    | `shiftId: D` | `shiftIds: [D]` |
    | `shiftId` + `shiftIds` | 400 |
    | `includeOff: true` + `shiftIds` | 400, path `includeOff` |
    | `when: 'shift_start'` + 2 turnos | 400, path `when` |
    | `when: 'shift_start'` + 1 turno | ok |
    | 21 turnos | 400 |
    | `channelId` presente | aceito |
    | sem `channelId` | aceito |
  - Roster: `eligibleFor` com `{D, N}` → passa WORK em D e em N; OFF não passa.
  - `service.sectors.spec`:
    - "Dia + Noite em dois setores conta cada pessoa uma vez" (aceite: pessoa que aparece nos dois setores → um destinatário);
    - "um turno inativo entre os pedidos → 422 invalid_shift antes de carregar a escala";
    - rótulo `'Produção, TI · Dia, Noite · 21/10'`;
    - com dois turnos, `createDispatch` recebe `shiftId null` e `shiftName null`.
- [ ] **Step 2: rodar e ver FAIL.**
- [ ] **Step 3: implementar.** Preprocess `shiftIdAlias` ao lado de `sectorIdAlias`; `requireShifts(ids)`.
- [ ] **Step 4: rodar e ver PASS** (incluindo `single-sector` e `schedule` sem mudar asserções).
- [ ] **Step 5: fechar** (`gate --changed`, cwd `backend`).

### Task 7: back — prévia: número de cada área e estado ao vivo (roster, person-route)

**Risco:** médio · **Revisão:** não crítica · **Depende de:** T2, T5, T6

**Files:**
- Create: `backend/src/modules/team-whatsapp/team-whatsapp.channels.ts`, `team-whatsapp.channels.spec.ts`, `dto/person-route-query.dto.ts`
- Modify: `team-whatsapp.module.ts` (importar `WhatsappProvidersModule`), `team-whatsapp.service.ts` (`roster`, novo `personRoute`), `team-whatsapp.repository.ts` (`findSectorChannels`), `team-whatsapp.controller.ts` (`GET person-route`), `backend/src/schemas/contracts/team-whatsapp.schema.ts`
- Test: `team-whatsapp.service.roster.spec.ts`, `team-whatsapp.controller.spec.ts`

**Contexto vinculado:**
- Spec §3: cada pessoa recebe pelo número da área em que trabalha na data, e o remanejado pelo da área onde atua. Spec §5: a prévia mostra o número de origem de cada grupo e a hora da última verificação, e o desconectado mostra qual número e quais áreas.
- C2:
  - `TeamSectorChannel = { id, name, phoneE164, provider, live: { state, checkedAt ISO } }`;
  - roster `sectors[].channel`;
  - `GET person-route?userId=` → `{ userId, sector, channel }`, com 403 por `canSendToUser`;
  - o setor do dia vem da exceção "Outro setor" da escala, senão `User.sectorId`. Reusar a resolução do dia que `dayMembers` usa (`resolveDay`: situação `WORK` traz `sectorId`).
- D2/GC7: número efetivo por `effectiveChannel`. D7: estado por `ChannelLiveStateService.checkMany`, um por canal distinto.

**Interfaces:**
- Consumes: `effectiveChannel`, `SECTOR_CHANNEL_SELECT` (T2); `ChannelLiveStateService.checkMany` (T5).
- Produces:
  - `repo.findSectorChannels(sectorIds: readonly string[]): Promise<Map<string, TeamSectorChannelRow | null>>`, com `type TeamSectorChannelRow = SectorChannelRef & { evolutionInstanceName: string | null }` (já passado por `effectiveChannel`);
  - `service.personRoute(actorId: string, userId: string): Promise<TeamPersonRoute>`;
  - `service.personSectorOn(userId: string, date: CivilDate): Promise<{ id: string; name: string } | null>`;
  - em `team-whatsapp.channels.ts`:
    - `missingSectors(sectors: readonly { id: string; name: string; channel: SectorChannelRef | null }[]): { id: string; name: string }[]`;
    - `liveBlock(checks: Iterable<LiveCheck>): 'team_whatsapp.channel_disconnected' | 'team_whatsapp.channel_unverified' | null` (qualquer `close`/`connecting` vence `unknown`);
    - `toTeamSectorChannel(ref: SectorChannelRef, check: LiveCheck): TeamSectorChannel`.

- [ ] **Step 1: testes que falham.**
  - `channels.spec` `it.each`: `liveBlock([open, open])` → `null`; `[open, unknown]` → `channel_unverified`; `[unknown, close]` → `channel_disconnected`; `[connecting]` → `channel_disconnected`. `missingSectors` devolve só os de `channel null`, na ordem recebida.
  - `roster.spec`:
    - "setor com número → `channel.live.state 'open'` e `checkedAt` ISO";
    - "setor com canal inativo → `channel null`" (R2);
    - "Logística e Expedição no mesmo número → `checkMany` com um canal".
  - `personRoute`:
    - "remanejado hoje para Expedição → `sector` Expedição e o número dela";
    - "sem setor → `{ sector: null, channel: null }`";
    - "gestor de outro setor → 403 `team_whatsapp.forbidden`".
- [ ] **Step 2: rodar e ver FAIL.**
- [ ] **Step 3: implementar.**
- [ ] **Step 4: rodar e ver PASS.**
- [ ] **Step 5: fechar** (`gate --changed`, cwd `backend`).

### Task 8: back — POST escolhe o número de cada pessoa, bloqueia área sem número e número desconectado

**Risco:** alto (anti-objetivo: mensagem por número de outra área) · **Revisão:** não crítica, revisor dedicado · **Depende de:** T7

**Files:**
- Modify: `backend/src/modules/team-whatsapp/team-whatsapp.service.ts` (`dispatch` ~174, `resolveUser`, remover `requireChannel` ~473 do POST, `classify`), `team-whatsapp.repository.ts` (`createDispatch`, tipo `NewTeamDispatch`), `team-whatsapp.errors.ts`
- Create: `backend/src/modules/team-whatsapp/team-whatsapp.service.channels.spec.ts`
- Test: `team-whatsapp.service.spec.ts`, `.service.single-sector.spec.ts` (fixture: o setor tem como número o mesmo canal que o input antigo mandava, para o literal não mudar), `.service.schedule.spec.ts`

**Contexto vinculado:**
- Spec §3: o seletor de canal sai; áreas com números diferentes viram um grupo por número, e para o operador continua um envio; cada destinatário guarda por qual número saiu, e isso não muda depois; o agendado congela o número na criação.
- Spec §2: o servidor também bloqueia. Spec §5: desconectado trava; sem resposta trava com `Não foi possível conferir o número. Tente de novo`.
- C3 (ordem das recusas):
  1. remetente;
  2. política de cada setor;
  3. turnos;
  4. níveis;
  5. lista (`too_many_people`);
  6. seleção;
  7. 422 `team_whatsapp.sector_without_number`;
  8. agendamento;
  9. só no imediato, `liveBlock` sobre os canais dos setores selecionados → 409 `team_whatsapp.channel_disconnected` / `team_whatsapp.channel_unverified`.

  Alvo pessoa: 422 `team_whatsapp.no_sector`, ou `sector_without_number`, e depois o mesmo bloqueio ao vivo. `channelId` do corpo ignorado.
- D3: o destinatário grava `channelId`, `channelName`, `channelPhoneE164` do número efetivo do setor onde aparece (`inSector`); `dispatch.channelId` = o canal único, ou `null` com mais de um. D7: o agendado não consulta o provedor na criação. D8: pessoa sem área = 422.
- GC6: nada criado em recusa (nem dispatch, nem job, nem auditoria). GC14: outros fluxos continuam com `channelId`.

**Interfaces:**
- Consumes: `findSectorChannels`, `missingSectors`, `liveBlock`, `personSectorOn` (T7); `ChannelLiveStateService.checkMany` (T5).
- Produces:
  - `NewTeamDispatch.channelId: string | null`;
  - `NewTeamDispatch.recipients[]` com `channelId: string | null`, `channelName: string | null`, `channelPhoneE164: string | null`;
  - erros `sectorWithoutNumber()`, `noSector()`, `channelDisconnected()`, `channelUnverified()` em `team-whatsapp.errors.ts`.

- [ ] **Step 1: testes que falham** (`service.channels.spec.ts`).
  - "Logística (número 1111) + Expedição (2222): cada destinatário com o `channelId` do seu setor, snapshot de nome e telefone, `dispatch.channelId null`" (aceite: envio dividido).
  - "remanejado de Logística para Expedição recebe pelo 2222" (R1).
  - "um número só → `dispatch.channelId` = ele".
  - `it.each` área sem número (sem canal; canal inativo, R2) → 422 `sector_without_number`, e `createDispatch`, `queue.addBulk` e `audit` não são chamados.
  - `it.each` live (imediato): `close` → 409 `channel_disconnected`; `connecting` → 409 `channel_disconnected`; `unknown` → 409 `channel_unverified`; nada criado.
  - "agendado (`shift_start`) com número `close` → criado `SCHEDULED`, `checkMany` não chamado".
  - "`userIds` fora da lista + área sem número → 422 `invalid_selection`" (a seleção vem antes).
  - Alvo pessoa: "sem setor no dia → 422 `no_sector`"; "remanejado hoje → sai pelo número do setor do dia".
  - "`channelId` no corpo apontando para outro canal → ignorado" (R6).
- [ ] **Step 2: rodar e ver FAIL.**
- [ ] **Step 3: implementar.** Ajustar os testes antigos de `channel_invalid`/`channel_disconnected` por `connectionEvents` no POST, que deixam de valer.
- [ ] **Step 4: rodar e ver PASS** (`single-sector` com o literal de hoje + as chaves novas dos destinatários).
- [ ] **Step 5: fechar** (`gate --changed`, cwd `backend`).

### Task 9: back — fila: número do destinatário, conferência antes de cada mensagem, tentativas, incerta

**Risco:** alto (anti-objetivos: envio por número desconectado; "Enviado" sem confirmação) · **Revisão:** não crítica, revisor dedicado · **Depende de:** T8

**Files:**
- Create: `backend/src/modules/team-whatsapp/team-whatsapp.outcome.ts`, `team-whatsapp.outcome.spec.ts`
- Modify: `team-whatsapp-send.processor.ts` (`deliver`, `precheck` ~198, `priorOutcome`, `settle`, `finish`, INDETERMINATE ~59-61, prepare ~215-225), `team-whatsapp.repository.ts` (`load`, `claimScheduled` ~424, `failAll`/`queueActive`, `countAttempt`), `backend/src/modules/chat/chat.service.ts` (`prepareTeamMessage` :215 devolve também `contactId`)
- Test: `team-whatsapp-send.processor.spec.ts`, `team-whatsapp.schedule.integration.spec.ts`, specs do chat que conferem o retorno de `prepareTeamMessage`

**Contexto vinculado:**
- Spec §5: na fila, o número é conferido de novo antes de cada mensagem, e nunca se envia por um número que se sabe desconectado; a mensagem que não sai vira falha "número desconectado", repetível. Spec §6: tentativa = cada chamada ao provedor, automáticas (até 3) + manuais. Spec §7: timeout ou estado desconhecido = "Situação incerta". Agendado: no disparo, desconectado vira falha com motivo.
- D5: `UNCERTAIN` substitui `FAILED` + indeterminate.
- C4:
  - `failureStatus(code, redispatchable)` → `UNCERTAIN` se `code === 'team_whatsapp.indeterminate' || !redispatchable(code)` (passar `chat.isRedispatchableFailure`), senão `FAILED`;
  - `isRepeatable(status, code)` = `status === 'FAILED'`, `code` não nulo, fora de `NOT_REPEATABLE_CODES` (`evolution.number_not_on_whatsapp`, `gozap.not_on_whatsapp`, `gozap.invalid_recipient`, `team_whatsapp.message_missing`) e sem sufixo `.timeout`.
- D6: `attempts` +1 imediatamente antes de `chat.sendTeamMessage`; `acceptedAt` no `finish(SENT)`.
- D7:
  - a conferência vem depois de `priorOutcome` devolver `null` (só quando vai mesmo chamar o provedor);
  - `close`/`connecting` → `FAILED team_whatsapp.channel_disconnected`, sem retry e sem tentativa;
  - `unknown` → lança `TeamSendJobError('team_whatsapp.channel_unverified')` e, na última tentativa, `FAILED team_whatsapp.channel_unverified`;
  - o `claimScheduled` checa o canal de cada destinatário.
- D3: o canal do envio é `recipient.channel`; `dispatch.channel` só como reserva de linha sem canal. D11: o `updateMany` que grava `messageId` grava também `contactId`.

**Interfaces:**
- Consumes: `ChannelLiveStateService.check` (T5).
- Produces:
  - `team-whatsapp.outcome.ts` (C4): `INDETERMINATE_CODE`, `NOT_REPEATABLE_CODES`, `failureStatus`, `isRepeatable`;
  - `repo.countAttempt(recipientId: string): Promise<void>` (`updateMany where { id, status: 'QUEUED' }`, `attempts: { increment: 1 }`);
  - `chat.prepareTeamMessage(...)` → `Promise<{ messageId: string; contactId: string | null }>` (o `conv.contactId` que a `Message` recebeu).

- [ ] **Step 1: testes que falham.**
  - `outcome.spec` `it.each`:
    - `failureStatus`: `'team_whatsapp.indeterminate'` → `UNCERTAIN`; `'gozap.timeout'` com `redispatchable = () => false` → `UNCERTAIN`; `'gozap.not_on_whatsapp'` → `FAILED`; `'team_whatsapp.channel_disconnected'` → `FAILED`.
    - `isRepeatable`: `FAILED channel_disconnected` → `true`; `FAILED gozap.not_on_whatsapp` → `false`; `FAILED x.timeout` → `false`; `UNCERTAIN` → `false`; `SENT` → `false`; `FAILED null` → `false`.
  - `processor.spec`:
    - "número `close` → `FAILED channel_disconnected`, `sendTeamMessage` e `countAttempt` não chamados";
    - "`connecting` → `FAILED channel_disconnected`" (R3);
    - "`unknown` fora da última → lança; na última → `FAILED channel_unverified`";
    - "`open` → `countAttempt` antes de `sendTeamMessage`; enviado → `SENT` com `acceptedAt`";
    - "Message SENDING → `UNCERTAIN` `team_whatsapp.indeterminate`";
    - "falha final `gozap.timeout` → `UNCERTAIN`"; "`gozap.not_on_whatsapp` → `FAILED`";
    - "destinatário no canal B e envio no canal A → `prepareTeamMessage` e `check` com B";
    - "prepare grava `contactId` devolvido";
    - "`priorOutcome` SENT → sem `check` e sem tentativa".
  - `schedule.integration.spec`: "destinatário com canal inativo → `FAILED channel_unavailable`, o outro → `QUEUED`". Os casos de hoje (disparo idempotente, corrida com cancelamento) continuam verdes.
- [ ] **Step 2: rodar e ver FAIL.**
- [ ] **Step 3: implementar.**
- [ ] **Step 4: rodar e ver PASS.**
- [ ] **Step 5: fechar** (`gate --changed`, cwd `backend`).

### Task 10: back — recibos (entregue, lido) e "respondeu" chegam ao destinatário

**Risco:** alto (estado vindo de webhook público; anti-objetivo "lido" sem confirmação) · **Revisão:** não crítica, revisor dedicado · **Depende de:** T2

**Files:**
- Create: `backend/src/modules/team-whatsapp/tracking/team-recipient-tracking.service.ts`, `team-tracking.module.ts`, `team-recipient-tracking.integration.spec.ts`
- Modify: `backend/src/modules/webhooks/webhooks.service.ts` (`processStatusUpdates` ~838-860), `webhooks.module.ts`; `backend/src/modules/chat/chat-ingest.service.ts` (`persistChatMessage` ~730-778), `chat.module.ts`
- Test: `webhooks.service.spec.ts`, `chat-ingest.service.spec.ts`

**Contexto vinculado:**
- Spec §7: "Entregue" e "Lido" vêm dos recibos que já chegam para `Message`, levados ao destinatário pelo id da mensagem; evento repetido ou fora de ordem não faz a situação voltar (lido não volta a entregue). "Respondeu" = a primeira mensagem que a pessoa manda **para aquele número** depois do envio; com vários envios do número, marca o mais recente anterior a ela; respondeu fica acima de lido.
- C4: ordem `QUEUED < SENT < DELIVERED < READ < REPLIED`; `UNCERTAIN` sobe com recibo; `FAILED`/`SKIPPED`/`CANCELLED` terminais.
- D10: serviço só com Prisma num módulo sem imports. D11: casa por `channelId` + `contactIds`; `acceptedAt < receivedAt`; o mais recente; já `REPLIED` → nada.
- Ponto do webhook: logo depois do `updateMany` da `Message` com `count > 0` e status novo `DELIVERED`/`READ`, com `messageId = message.id`, em try/catch. Ponto do chat: depois do `message.create` inbound e não backfill, antes de `events.publish`, em try/catch, com `contactIds = [contact.id, ...twinIds]` e `receivedAt = m.receivedAt`; sem contato, não chama. GC14: falha aqui nunca muda o webhook nem a ingestão. GC8: log sem telefone.

**Interfaces:**
- Produces:
  - `TeamRecipientTrackingService.applyReceipt(input: { messageId: string; status: 'DELIVERED' | 'READ'; occurredAt: Date }): Promise<number>`.
    - `DELIVERED` sai de `QUEUED`, `SENT` ou `UNCERTAIN` e grava `deliveredAt`.
    - `READ` sai de `QUEUED`, `SENT`, `DELIVERED` ou `UNCERTAIN` e grava `readAt`.
    - Dois `updateMany`: um com `acceptedAt: null` no where, que também grava `acceptedAt = occurredAt`; outro com `acceptedAt: { not: null }`.
  - `applyReply(input: { channelId: string; contactIds: readonly string[]; receivedAt: Date }): Promise<string | null>` (id marcado):
    - `findFirst where { channelId, contactId: { in }, acceptedAt: { lt: receivedAt }, status: { in: [SENT, DELIVERED, READ, REPLIED] } } orderBy acceptedAt desc`;
    - se não for `REPLIED`, `updateMany where { id, status: { in: [SENT, DELIVERED, READ] } }` → `REPLIED`, `repliedAt = receivedAt`.

- [ ] **Step 1: testes que falham.**
  - Integration (Postgres real), `describe('recibos')`:
    - "SENT + DELIVERED → DELIVERED com `deliveredAt`";
    - "READ depois DELIVERED (fora de ordem) → fica READ";
    - "DELIVERED repetido → `count 0`";
    - "QUEUED + DELIVERED → DELIVERED com `acceptedAt = occurredAt`" (R4);
    - "UNCERTAIN + READ → READ";
    - "FAILED + DELIVERED → fica FAILED";
    - "REPLIED + READ → fica REPLIED".
  - Integration, `describe('respondeu')`:
    - "dois envios do número X à pessoa (T1 < T2) e resposta depois de T2 → só o de T2 vira REPLIED";
    - "segunda resposta → nada muda, o de T1 continua";
    - "resposta para o número Y → nenhum do X muda";
    - "resposta antes do `acceptedAt` → nada";
    - "contato gêmeo (9º dígito) em `contactIds` → marca".
  - `webhooks.service.spec`:
    - "`count > 0` com DELIVERED → `applyReceipt({ messageId: message.id, status: 'DELIVERED' })`";
    - "`count 0` → não chama";
    - "`applyReceipt` lança → o webhook segue e publica `message.status`".
  - `chat-ingest.service.spec`:
    - "inbound não backfill → `applyReply` com `channelId = instanceId`, `contactIds [contato, ...gêmeos]` e `receivedAt`";
    - "backfill → não chama"; "`fromMe` → não chama";
    - "`applyReply` lança → a mensagem é gravada e publicada".
- [ ] **Step 2: rodar e ver FAIL.**
- [ ] **Step 3: implementar.**
- [ ] **Step 4: rodar e ver PASS** (os specs de webhooks e chat-ingest de hoje continuam verdes).
- [ ] **Step 5: fechar** (`gate --changed`, cwd `backend`).

### Task 11: back — histórico no formato novo e tela de resultado (detalhe + destinatários paginados)

**Risco: crítico (autorização)** — endpoint novo decide quem vê o detalhe e a lista de destinatários de um envio. · **Revisão:** crítica · **Depende de:** T9, T10

**Files:**
- Create: `backend/src/modules/team-whatsapp/team-whatsapp-results.service.ts`, `team-whatsapp-results.service.spec.ts`, `dto/dispatch-recipients-query.dto.ts`
- Modify: `team-whatsapp.repository.ts` (`findDispatchDetail`, `listDispatchRecipients`, `channelsByDispatch`, `countByStatus`; sai `listRecipients` ~499 do histórico), `team-whatsapp.service.ts` (`listDispatches`), `team-whatsapp.policy.ts` (`canViewDispatch`), `team-whatsapp.controller.ts`, `team-whatsapp.module.ts`, `backend/src/schemas/contracts/team-whatsapp.schema.ts`
- Test: `team-whatsapp.repository.integration.spec.ts`, `team-whatsapp.service.list.spec.ts`, `team-whatsapp.controller.spec.ts`

**Contexto vinculado:**
- Spec §7: a tela de resultado é vista por quem já tem acesso ao histórico. ADMIN vê todos os envios e os demais só os próprios (`authorId`). No topo, contagens por situação; abaixo, a lista por nome com filtro por situação, número de origem, tentativas e motivo; quem ficou de fora. Spec "Regressão": envios antigos continuam mostrando canal, destinatários e situação.
- C5:
  - **Histórico:** cada item perde `recipients`, `unselected`, `off` e `channel` e ganha:
    - `channels: { name, phoneE164, count }[]`, pelo snapshot dos destinatários;
    - `counts: { queued, sent, delivered, read, replied, failed, uncertain, skipped, scheduled, cancelled }`.
  - **`GET dispatches/:id`** → `{ id, targetLabel, text, state, createdAt, scheduledFor, firedAt, author: { id, name } | null, sectors, counts, channels, leftOut: { unselected, off } }`.
  - **`GET dispatches/:id/recipients?status&page&pageSize`** (pageSize 1..100, padrão 50), por `userName` e depois `id`:
    - resposta `{ items, total, page, pageSize }`;
    - cada item `{ id, userName, sectorName, levelName, shiftName, status, reason /* skipReason ?? errorCode */, attempts, channel: { name, phoneE164 } | null, acceptedAt, deliveredAt, readAt, repliedAt, repeatable /* isRepeatable(status, errorCode) */ }`.
  - **Visibilidade:** envio que o ator não vê → 404 `team_whatsapp.dispatch_not_found`.
- GC5: o remetente é exigido antes (403 `team_whatsapp.forbidden`). D13: o histórico deixa de trazer destinatários. GC8: sem telefone de pessoa na resposta.

**Interfaces:**
- Consumes: `isRepeatable` (T9); `PageQuery` (T1).
- Produces:
  - `canViewDispatch(actor: TeamActor, dispatch: { authorId: string | null }): boolean` (ADMIN ou `authorId === actor.id`);
  - `repo.findDispatchForActor(id: string): Promise<{ id; authorId; targetType; targetId; state; sectors: { sectorId }[] } | null>` (a T12 reusa);
  - `TeamWhatsappResultsService.detail(actorId: string, dispatchId: string): Promise<TeamDispatchDetail>`;
  - `recipients(actorId: string, dispatchId: string, query: DispatchRecipientsQuery): Promise<TeamDispatchRecipientPage>`.

- [ ] **Step 1: testes que falham.**
  - `results.service.spec` `it.each` de visibilidade, em `detail` e `recipients`:

    | Ator | Envio | Resultado |
    |---|---|---|
    | ADMIN | de outro autor | 200 |
    | OPERATOR | o próprio | 200 |
    | OPERATOR | de outro autor | 404 `dispatch_not_found` |
    | SUPERVISOR | de outro autor | 404 |
    | VIEWER | qualquer | 403 |
    | qualquer | inexistente | 404 |
  - Repository integration:
    - "120 destinatários, `pageSize 50`, página 3 → 20, por `userName`";
    - "`status: 'FAILED'` → só falhas, `total` certo";
    - "`counts` de um envio com SENT, DELIVERED, READ, REPLIED, UNCERTAIN → cada chave";
    - "envio legado (destinatários do backfill da T2) → `channels: [{ name: 'GBR', phoneE164, count }]`".
  - `service.list.spec`: o item do histórico não tem `recipients`, `unselected`, `off` nem `channel`, e tem `channels` e `counts.uncertain`.
  - Detalhe: `leftOut.unselected` vem da foto `roster`; foto antiga sem o campo → `[]`.
- [ ] **Step 2: rodar e ver FAIL.**
- [ ] **Step 3: implementar.** `channelsByDispatch` usa `groupBy(['dispatchId', 'channelName', 'channelPhoneE164'])`.
- [ ] **Step 4: rodar e ver PASS.**
- [ ] **Step 5: fechar** (`gate --changed`, cwd `backend`).

### Task 12: back — "Repetir" seguro (um, vários ou todas as falhas certas)

**Risco: crítico (autorização)** — decide quem pode repetir (quem vê o envio e pode enviar àquela área). No mesmo delta fica a garantia anti-duplicata: troca atômica no banco + jobId novo. · **Revisão:** crítica · **Depende de:** T11

**Files:**
- Create: `backend/src/modules/team-whatsapp/team-whatsapp-retry.service.ts`, `team-whatsapp-retry.service.spec.ts`, `dto/retry-recipients.dto.ts`, `team-whatsapp.retry.integration.spec.ts`
- Modify: `team-whatsapp.repository.ts` (`requeueFailed`), `team-whatsapp.service.ts` (`teamSendJobId`, `enqueueTeamRetry` ao lado de `enqueueTeamSend` ~522), `team-whatsapp.controller.ts`, `team-whatsapp.module.ts`, contrato

**Contexto vinculado:**
- Spec §6:
  - "Repetir" só em falha certa (desconectado, provedor recusou, validação); nunca em timeout, situação incerta ou "telefone sem WhatsApp";
  - não cria destinatário novo, e mantém o texto e o número;
  - a garantia contra duplicata fica no banco (falha certa → na fila por troca atômica); dois cliques ou duas abas = uma tentativa;
  - quem pode = quem vê o envio no histórico e pode enviar àquela área;
  - repetir em lote se sair barato.
- C4: `isRepeatable` e `NOT_REPEATABLE_CODES`; o SQL da troca repete a regra: `status='FAILED' AND "errorCode" IS NOT NULL AND "errorCode" <> ALL(<NOT_REPEATABLE_CODES>) AND "errorCode" NOT LIKE '%.timeout'`.
- C6: corpo `{ recipientIds: 1..100 } | { all: true }` → `{ requeued }`; ordem remetente (403) → visível (`canViewDispatch`, 404) → área (403) → troca → fila.
- Regra de área, a mesma do cancelamento: ADMIN qualquer; gestor só se **todo** setor do envio passa por `canSendToSector`; alvo pessoa → `canSendToUser` do `targetId` (usuário apagado → 403).
- D12: `UPDATE … RETURNING id, "manualRetries"`; jobId `teamSendJobId`; falha ao enfileirar → `markFailed(ids, 'team_whatsapp.queue_unavailable')` e relança; auditoria `team_whatsapp.retry` `{ actorId, dispatchId, requeued }` (GC8).

**Interfaces:**
- Consumes: `canViewDispatch`, `repo.findDispatchForActor` (T11); `isRepeatable`, `NOT_REPEATABLE_CODES` (T9).
- Produces:
  - `repo.requeueFailed(dispatchId: string, recipientIds: readonly string[] | 'all'): Promise<{ id: string; manualRetries: number }[]>`;
  - `teamSendJobId(recipientId: string, manualRetries: number): string`;
  - `enqueueTeamRetry(queue, repo, refs: readonly { id: string; manualRetries: number }[]): Promise<void>`;
  - `TeamWhatsappRetryService.retry(actorId: string, dispatchId: string, input: RetryRecipientsInput): Promise<{ requeued: number }>`.

- [ ] **Step 1: testes que falham.**
  - `team-whatsapp.retry.integration.spec.ts` (Postgres real):
    - "duas chamadas simultâneas (`Promise.all`) para o mesmo destinatário FAILED → uma devolve `[{ id, manualRetries: 1 }]`, a outra `[]`";
    - `it.each` UNCERTAIN / SENT / FAILED `gozap.not_on_whatsapp` / FAILED `gozap.timeout` → `[]`, sem mudança;
    - "`'all'` → só os repetíveis daquele envio";
    - "segunda repetição depois de nova falha → `manualRetries 2`".
  - `retry.service.spec`:
    - `it.each` de autorização: OPERATOR em envio de outro autor → 404; gestor autor cujo envio tem setor que ele não gerencia mais → 403; alvo pessoa fora do alcance → 403; ADMIN → ok;
    - "`teamSendJobId('r1', 0)` → `'r1'`; `('r1', 2)` → `'r1-r2'`";
    - "`queue.add` com `jobId 'r1-r1'` e `data { recipientId: 'r1' }`";
    - "fila fora → `markFailed(['r1'], 'team_whatsapp.queue_unavailable')` e relança" (R5);
    - "nada repetível → `{ requeued: 0 }` sem `queue.add` e sem auditoria".
  - DTO `it.each`: `{}` → 400; `{ all: false }` → 400; `{ recipientIds: [] }` → 400; os dois juntos → 400.
- [ ] **Step 2: rodar e ver FAIL.**
- [ ] **Step 3: implementar.** `$queryRaw` com `Prisma.sql`.
- [ ] **Step 4: rodar e ver PASS.**
- [ ] **Step 5: fechar** (`gate --changed`, cwd `backend`).

### Task 13: front — diálogo de envio: vários turnos, "fora: não selecionado", erro da escala

**Risco:** médio · **Revisão:** não crítica · **Depende de:** T6

**Files:**
- Modify: `frontend/src/features/team-whatsapp/components/sector-shift-picker.tsx`, `use-send-filters.ts` (`choice` → `shiftIds: string[]`), `member-filter.ts`, `components/send-whatsapp-dialog.tsx` (`requestTarget` l.31-43, `SectorPeople` l.55-63, `DialogActions` l.180-199), `components/member-selection.tsx` (`IncludeOffToggle`), `schemas.ts` (`SendTarget`, `CreateDispatchInput`)
- Test: `sector-shift-picker.spec.tsx`, `send-whatsapp-dialog.spec.tsx`, `member-filter.spec.ts`

**Contexto vinculado:**
- Spec §4: vários turnos com vários setores; "Todos os turnos" continua; folga só com todos os turnos; fica claro que o filtro do quadro da escala não limita o envio; na seleção "somente os marcados", a prévia lista os não marcados com o motivo.
- C3: o corpo leva `shiftIds` (sem `shiftId`); `includeOff` só sem turnos; "No início do turno" só com exatamente um turno (D9).
- D13/D14: a consulta da escala dentro do diálogo (`useTeamRoster`) com erro mostra `QueryErrorFallback` com `onRetry={refetch}`.
- GC11 (textos): `Todos os turnos`; dica `Os filtros do quadro da escala não mudam quem recebe: o envio usa só as escolhas abaixo.`; `Ficam de fora (N)` com `<nome> · não selecionado` / `<nome> · sem telefone`.

**Interfaces:**
- Produces:
  - `SendFilters.shiftIds: string[]` (vazio = todos);
  - `leftOutPeople(members, selection): { name: string; reason: 'unselected' | 'no_phone' }[]` em `member-filter.ts`.

- [ ] **Step 1: testes que falham.**
  - "marcar Dia e Noite → POST com `shiftIds: [dia, noite]` e sem `includeOff`".
  - "Todos os turnos → sem `shiftIds`, e o toggle de folga aparece".
  - "com dois turnos, `No início do turno` desabilitado; com um, habilitado e o corpo leva `when: 'shift_start'`".
  - "seleção parcial → `Ficam de fora (2)` com `Ana · não selecionado` e `Bruno · sem telefone`".
  - "roster com erro → `QueryErrorFallback`; clicar `Tentar novamente` chama `refetch`" (`findBy`).
  - "dica do quadro visível".
- [ ] **Step 2: rodar e ver FAIL.** `cd frontend && timeout 600 gate --test src/features/team-whatsapp/components/send-whatsapp-dialog.spec.tsx`.
- [ ] **Step 3: implementar.**
- [ ] **Step 4: rodar e ver PASS.**
- [ ] **Step 5: fechar.** `cd frontend && timeout 600 gate --changed --base origin/main`.

### Task 14: front — diálogo de envio: sem seletor de canal, grupos por número, áreas sem número, estado do número

**Risco:** médio · **Revisão:** não crítica · **Depende de:** T8, T13

**Files:**
- Create: `frontend/src/features/team-whatsapp/channel-groups.ts`, `channel-groups.spec.ts`, `components/channel-groups.tsx`, `components/channel-groups.spec.tsx`
- Modify: `components/send-whatsapp-dialog.tsx` (remover `ChannelSelect` l.149-176, `channelsStatusOf`/`orderChannels`/`resolveChannelId`/`channelLabel` ~l.92-120; `useSendForm` l.122-147 sem `channelId`), `channel-availability.ts`, `api.ts` (`useTeamPersonRoute`), `schemas.ts` (`teamSectorChannelSchema`, roster `channel`, `teamPersonRouteSchema`, sem `channelId` em `CreateDispatchInput`), `error-messages.ts` (códigos novos)
- Test: `send-whatsapp-dialog.spec.tsx`, `routes/_authenticated/whatsapp-equipe/index.spec.tsx`, `routes/_authenticated/users` (spec do diálogo com alvo pessoa, se existir), `channel-availability.spec.ts`, `error-messages.spec.ts`, `schemas.spec.ts`

**Contexto vinculado:**
- Spec §2: cada área selecionada sem número aparece num aviso destacado com o nome, e enviar/agendar fica travado; o aviso diz `Associe um número a esta área em Conexões`, com o link só para o ADMIN.
- Spec §3: o seletor de canal sai do envio para áreas e para uma pessoa; a prévia mostra a divisão (`Logística, 12 pessoas, pelo (92) 9xxxx-1111; …`); pessoa sem área bloqueada.
- Spec §5: desconectado trava e a prévia diz o número e as áreas; sem resposta, `Não foi possível conferir o número. Tente de novo`; a prévia mostra a hora da verificação.
- C2: roster `sectors[].channel: TeamSectorChannel | null`; `GET person-route?userId=` → `{ userId, sector, channel }`.
- D7: desconectado/`unknown` trava só `Enviar agora`; `sem número` trava os dois botões; agendar não confere o número.
- GC11, prévia:
  - grupo `<setor>, <N> pessoas, pelo <número>` (vários setores num número separados por `; `);
  - `conferido às HH:mm`;
  - `Áreas sem número: <nomes>` + `Associe um número a esta área em Conexões`, com o link `Conexões` (`/connect`) só ADMIN;
  - `O número <número> está desconectado. Áreas: <nomes>.`;
  - `Não foi possível conferir o número. Tente de novo` + botão `Conferir de novo`;
  - pessoa sem área: `Esta pessoa não tem área.`
- GC11, erros do POST:
  - `sector_without_number` → `Há área sem número neste envio. Associe um número a ela em Conexões.`;
  - `no_sector` → `Esta pessoa não tem área. Coloque-a num setor antes de enviar.`;
  - `channel_disconnected` → `Um número deste envio está desconectado. Veja na prévia qual é.`;
  - `channel_unverified` → `Não foi possível conferir o número. Tente de novo`;
  - `too_many_people` → `Os setores escolhidos têm mais de 2000 pessoas. Escolha menos setores.`
- Número pelo formatador da lista GoZap. GC10: erros por `apiErrorCode`. O papel ADMIN vem do mesmo hook de sessão que `R/connect.tsx` usa para o painel só de ADMIN (l.65).

**Interfaces:**
- Consumes: C2, C3.
- Produces:
  - `buildChannelGroups(sectors: readonly RosterSectorView[], receivingBySector: ReadonlyMap<string, number>): { groups: ChannelGroupView[]; missing: { id: string; name: string }[]; block: 'missing' | 'disconnected' | 'unverified' | null }`;
  - `ChannelGroupView = { channel: TeamSectorChannel; sectors: { name: string; count: number }[] }`;
  - `useTeamPersonRoute(userId: string)`, com key `['team-whatsapp', 'person-route', userId]`.

- [ ] **Step 1: testes que falham.**
  - `channel-groups.spec` `it.each`:
    - dois setores em números diferentes → dois grupos;
    - dois setores no mesmo número → um grupo com dois setores;
    - setor sem número → `missing` e `block 'missing'`;
    - `close` → `'disconnected'`; `unknown` → `'unverified'`; `missing` vence os outros.
  - `channel-groups.spec.tsx`:
    - texto `Logística, 12 pessoas, pelo <número>` e `conferido às 14:05`;
    - `Áreas sem número: Expedição` com o link `Conexões` para ADMIN e sem link para OPERATOR;
    - `O número <número> está desconectado. Áreas: Logística.`;
    - `unknown` → `Conferir de novo` chama `refetch`.
  - `send-whatsapp-dialog.spec`:
    - "não há campo `Canal`; o POST não leva `channelId`";
    - "área sem número → `Enviar agora` e `No início do turno` desabilitados";
    - "número `close` → só `Enviar agora` desabilitado";
    - "alvo pessoa sem área → `Esta pessoa não tem área.` e envio desabilitado";
    - `it.each` 422 `sector_without_number` / 409 `channel_unverified` → mensagem da GC11 em `role="alert"` e roster invalidado.
  - Ajustar `index.spec.tsx` (sem canais em `targets`).
- [ ] **Step 2: rodar e ver FAIL.**
- [ ] **Step 3: implementar.**
- [ ] **Step 4: rodar e ver PASS.**
- [ ] **Step 5: fechar** (`gate --changed`, cwd `frontend`).

### Task 15: front — histórico e agendados paginados, situações novas, aviso do quadro da escala

**Risco:** médio · **Revisão:** não crítica · **Depende de:** T11, T14

**Files:**
- Modify: `frontend/src/features/team-whatsapp/api.ts` (`useTeamDispatches(page)`, `useScheduledDispatches(page)`), `schemas.ts` (`dispatchListSchema`, `scheduledListSchema`, `dispatchCountsSchema`, `recipientStatusSchema`), `error-messages.ts` (`recipientStatusLabel` :87-95, `failureReasonLabel` :68-85), `components/recent-dispatches.tsx` (`countsText` l.9-16; sai `RecipientsDetails`; link `Ver resultado`), `components/scheduled-dispatches.tsx`, `routes/_authenticated/whatsapp-equipe/index.tsx`
- Modify: `frontend/src/features/staff-schedule/` (schema do quadro com `truncated`), `routes/_authenticated/escala/index.tsx`
- Test: `recent-dispatches.spec.tsx`, `scheduled-dispatches.spec.tsx`, `error-messages.spec.ts`, `api.spec.ts`, `R/whatsapp-equipe/index.spec.tsx`, `R/escala/index.spec.tsx`

**Contexto vinculado:**
- Spec §8: o histórico pagina além dos 20; o erro mostra o botão de tentar de novo, no lugar de tela vazia (o texto fica `Tentar novamente`, D14).
- Spec §5: o rótulo "Enviado" passa a `Aceito pelo WhatsApp`.
- C5: listas `{ items, total, page, pageSize }`; item com `channels` e `counts` com 10 chaves; sem destinatários.
- D13: quadro com `truncated` → aviso `Mostrando as primeiras 500 pessoas deste setor.`
- GC11, situação:

  | Status | Rótulo |
  |---|---|
  | `QUEUED` | `Na fila` |
  | `SENT` | `Aceito pelo WhatsApp` |
  | `DELIVERED` | `Entregue` |
  | `READ` | `Lido` |
  | `REPLIED` | `Respondeu` |
  | `FAILED` | `Falhou: <motivo>` |
  | `UNCERTAIN` | `Situação incerta` |
  | `SKIPPED` | `Pulado: <motivo>` |
  | `SCHEDULED` | `Agendado` |
  | `CANCELLED` | `Cancelado` |
- GC11, motivos:
  - `DISCONNECTED_CODES` (inclui `team_whatsapp.channel_disconnected`) → `Número desconectado`;
  - `team_whatsapp.channel_unverified` → `Não foi possível conferir o número`;
  - `team_whatsapp.channel_unavailable` → `Número indisponível na hora do envio`;
  - `team_whatsapp.channel_invalid` → `Número removido ou inválido`.
- `countsText` mostra só as partes não zero, na ordem `Na fila N · Aceito pelo WhatsApp N · Entregue N · Lido N · Respondeu N · Falhou N · Situação incerta N · Pulado N`.
- GC13: `Pagination` de `features/internal-communications/components/pagination.tsx` (`{ page, pageSize, total, onPageChange }`).

**Interfaces:**
- Produces: `recipientStatusLabel(status, reason)` com os 10 status; `useTeamDispatches(page: number)`, com key `['team-whatsapp', 'dispatches', page]` (a invalidação por prefixo continua).

- [ ] **Step 1: testes que falham.**
  - `error-messages.spec` `it.each`: os 10 status → rótulo da GC11; `FAILED team_whatsapp.channel_disconnected` → `Falhou: Número desconectado`; `channel_invalid` → `Falhou: Número removido ou inválido`.
  - `recent-dispatches.spec`:
    - "`counts { sent: 3, read: 1 }` → `Aceito pelo WhatsApp 3 · Lido 1`";
    - "link `Ver resultado` para `/whatsapp-equipe/$dispatchId`";
    - "`channels` com dois números → os dois exibidos".
  - `index.spec`: "`total 45` → `Página 1 de 3`; `Próxima` pede `page 2`".
  - `scheduled-dispatches.spec`: paginação.
  - `escala/index.spec`: "`truncated` → aviso".
- [ ] **Step 2: rodar e ver FAIL.**
- [ ] **Step 3: implementar.**
- [ ] **Step 4: rodar e ver PASS.**
- [ ] **Step 5: fechar** (`gate --changed`, cwd `frontend`).

### Task 16: front — tela de resultado do envio e "Repetir"

**Risco:** médio · **Revisão:** não crítica · **Depende de:** T12, T15

**Files:**
- Create: `frontend/src/routes/_authenticated/whatsapp-equipe/$dispatchId.tsx` (+ `.spec.tsx`), `frontend/src/features/team-whatsapp/components/dispatch-result.tsx`, `components/recipient-table.tsx` (+ specs)
- Modify: `api.ts` (`useTeamDispatch`, `useDispatchRecipients`, `useRetryRecipients`), `schemas.ts` (`dispatchDetailSchema`, `dispatchRecipientPageSchema`, `retryResultSchema`)

**Contexto vinculado:**
- Spec §7: no topo, contagens por situação; abaixo, a lista por nome com filtro por situação, número de origem, tentativas e motivo; quem ficou de fora; serve para auditoria.
- Spec §6: `Repetir` só em falha certa; `Situação incerta` com explicação e sem botão; nenhum para "sem WhatsApp".
- C5/C6: `GET dispatches/:id`, `GET dispatches/:id/recipients?status&page&pageSize=50`, `POST dispatches/:id/retry` `{ recipientIds } | { all: true }` → `{ requeued }`. O botão aparece só com `repeatable === true` (decisão do servidor, sem lógica no front).
- Rota: `createFileRoute('/_authenticated/whatsapp-equipe/$dispatchId')`, no padrão de `R/setores/$sectorId.tsx` (`route.useParams()`, `export { route as Route }`). Erro → `QueryErrorFallback`; 404 → `Envio não encontrado.`. Atualização com `dispatchPollInterval` (janela de 60 min).
- GC11:
  - título `Resultado do envio`;
  - colunas `Nome`, `Situação`, `Número`, `Tentativas`, `Motivo`;
  - filtro `Situação` com `Todas`;
  - botões `Repetir` e `Repetir todas as falhas (N)`;
  - toasts `N mensagem(ns) na fila de novo` e `Nada para repetir`;
  - explicação de incerta `O WhatsApp não confirmou o envio. A mensagem pode ter saído: confira no celular antes de mandar de novo.`;
  - situações:

    | Status | Rótulo |
    |---|---|
    | `QUEUED` | `Na fila` |
    | `SENT` | `Aceito pelo WhatsApp` |
    | `DELIVERED` | `Entregue` |
    | `READ` | `Lido` |
    | `REPLIED` | `Respondeu` |
    | `FAILED` | `Falhou: <motivo>` |
    | `UNCERTAIN` | `Situação incerta` |
    | `SKIPPED` | `Pulado: <motivo>` |
    | `SCHEDULED` | `Agendado` |
    | `CANCELLED` | `Cancelado` |
  - `attempts 0` → `—`.

**Interfaces:**
- Produces:
  - `useTeamDispatch(id)`, com key `['team-whatsapp', 'dispatch', id]`;
  - `useDispatchRecipients(id, { status, page })`, com key `['team-whatsapp', 'dispatch', id, 'recipients', status, page]`;
  - `useRetryRecipients(id)`, que invalida `['team-whatsapp', 'dispatch', id]` e `['team-whatsapp', 'dispatches']`.

- [ ] **Step 1: testes que falham.**
  - "contagens no topo com os rótulos da GC11".
  - "linha FAILED `repeatable` → `Repetir` chama `POST retry { recipientIds: [id] }` e mostra o toast `1 mensagem(ns) na fila de novo`".
  - "linha UNCERTAIN → `Situação incerta`, explicação e sem `Repetir`".
  - "`Repetir todas as falhas (2)` → `{ all: true }`; `requeued 0` → `Nada para repetir`".
  - "filtro `Situação` = `Lido` → pede `status 'READ'` e página 1".
  - "colunas `Número` (formatado), `Tentativas` (`—` com 0) e `Motivo`".
  - "`leftOut.unselected` → lista `<nome> · não selecionado`".
  - "erro → `QueryErrorFallback`; 404 → `Envio não encontrado.`".
- [ ] **Step 2: rodar e ver FAIL.**
- [ ] **Step 3: implementar.**
- [ ] **Step 4: rodar e ver PASS.**
- [ ] **Step 5: fechar** (`gate --changed`, cwd `frontend`).

### Task 17: front — Conexões: áreas no número (criar e editar), mover com confirmação, avisos; selo "Sem número" nos setores

**Risco:** médio · **Revisão:** não crítica · **Depende de:** T3, T4

**Files:**
- Create: `frontend/src/features/whatsapp/sector-moves.ts` (+ spec), `components/sector-picker.tsx`, `components/edit-channel-sectors-dialog.tsx`, `components/sectors-without-number-notice.tsx` (+ specs)
- Modify: `features/whatsapp/api.ts` (`useCreateGozapChannel` l.453 com `sectorIds`, `useCreateInstance` l.40, novo `useUpdateChannelSectors`; `channelSummarySchema` l.132 e `instanceSchema` com `sectors`), `features/whatsapp/schemas.ts` (`createInstanceInputSchema` l.47), `components/create-gozap-channel-dialog.tsx` (~l.113-119, l.68), `components/create-instance-dialog.tsx` (l.64-65), `components/gozap-section.tsx` (linha com `Áreas: …` + botão `Áreas`), `components/instance-row.tsx` (idem), `routes/_authenticated/connect.tsx` (aviso no topo; sai `NumberRegistry` l.65)
- Delete: `frontend/src/features/internal-admin/components/number-registry.tsx` (+ spec) e o que só ele usa em `internal-admin/api.ts`/`schemas.ts` (l.77-103)
- Modify: `features/internal-admin/schemas.ts` (`sectorSchema` sem `numberCount`, com `channel`), `routes/_authenticated/setores/index.tsx` (`SectorRow` l.105-119: coluna `Número`), `routes/_authenticated/setores/$sectorId.tsx` (`SectorHeader` l.46-62), e o schema de `features/sector-people` (`sector.channel`)
- Test: `create-gozap-channel-dialog.spec.tsx`, `create-instance-dialog.spec.tsx`, `gozap-section.spec.tsx`, `instances-list.spec.tsx`, `R/setores/index.spec.tsx`, spec da página do setor

**Contexto vinculado:**
- Spec §1:
  - escolher a área ou as áreas no diálogo de nova conexão e editar depois na lista;
  - área já associada a outro número pede confirmação (`Logística sai do número (92) 9xxxx-1111 e passa para este`);
  - só o ADMIN.
- Spec §2: selo `Sem número` na lista e na página do setor; cada número mostra as áreas que atende; no topo de Conexões, `Áreas sem número: …`.
- C1: `PUT /whatsapp/channels/:id/sectors { sectorIds }`; criação GoZap `{ provider: 'GOZAP', name, sectorIds }`; Evolution `{ name, ownerUserId?, isDefault?, sectorIds }`; listas com `sectors`; setor com `channel | null`.
- D4: sai a tela "Números e canais". D15: aviso uma vez no topo de `/connect`, a partir de `useSectors(true)` (`channel === null`). D16: a confirmação de mover é montada no front a partir de `sector.channel`.
- GC11: `Áreas`, `Áreas: <nomes>`, `Nenhuma área`, `Mover`, `Cancelar`, `Sem número`; erros `channel.sectors_not_team` → `Este número não serve para o WhatsApp da equipe.`, `channel.sector_invalid` → `Área inválida ou inativa. Atualize a página e tente de novo.` (lidos por `extractApiError`, como os diálogos de hoje; GC10). Checkbox + Label como em `sector-shift-picker.tsx` (GC13).

**Interfaces:**
- Produces:
  - `sectorMoves(selected: readonly string[], sectors: readonly { id: string; name: string; channel: { id: string; name: string; phoneE164: string | null } | null }[], channelId: string | null): { sectorName: string; from: { name: string; phoneE164: string | null } }[]`;
  - `useUpdateChannelSectors()` (`PUT`, invalida `['whatsapp', 'providers']`, `['whatsapp', 'instances']` e a key de `useSectors`).

- [ ] **Step 1: testes que falham.**
  - `sector-moves.spec` `it.each`:
    - área livre → `[]`;
    - área de outro número → `[{ sectorName, from }]`;
    - área já deste número → `[]`;
    - na criação (`channelId null`) → todas as que têm número.
  - Diálogo GoZap:
    - "marcar Logística e Expedição → `mutateAsync({ name, sectorIds: [l, e] })`";
    - "Logística em outro número → confirmação `Logística sai do número <número> e passa para este.`; `Cancelar` não cria; `Mover` cria".
  - Diálogo Evolution: o mesmo com `sectorIds` no input.
  - Edição: "botão `Áreas` → diálogo pré-marcado; salvar → `PUT` com a lista".
  - Lista: `Áreas: Logística, Expedição` / `Nenhuma área`.
  - Topo de `/connect`: "`Áreas sem número: RH`; sem nenhuma → nada; `useSectors` com erro → `QueryErrorFallback`"; `Números e canais` não aparece.
  - Setores: "lista mostra `Sem número` quando `channel null` e o número quando há"; "página do setor mostra `Sem número`".
- [ ] **Step 2: rodar e ver FAIL.**
- [ ] **Step 3: implementar.**
- [ ] **Step 4: rodar e ver PASS.**
- [ ] **Step 5: fechar** (`gate --changed`, cwd `frontend`).

### Task 18: front — Novidade

**Risco:** baixo · **Revisão:** inspeção focada · **Depende de:** T13–T17 · **Agente:** `mecanico`

**Files:** Modify: `frontend/src/release-notes.ts` (+ spec, se existir)

**Contexto vinculado:**
- GC15: só esta task mexe em `release-notes.ts`; entrada nova no topo com `version: '2026.11.10'`, `date: '2026-11-10'` (conferir que a do topo é mais antiga).
- Conteúdo, em pt-BR e no tom das entradas atuais, 4 itens:
  - cada área tem o próprio número, escolhido em Conexões, e a área sem número fica bloqueada e marcada;
  - o envio escolhe o número sozinho e confere se ele está conectado;
  - "Aceito pelo WhatsApp", "Entregue", "Lido" e "Respondeu" na tela de resultado, com "Repetir" nas falhas;
  - vários turnos no mesmo envio, e o histórico paginado.

- [ ] **Step 1:** escrever a entrada; rodar `timeout 600 gate --test` no spec de release notes, se houver.
- [ ] **Step 2: fechar** (`gate --changed`, cwd `frontend`).

## Fechamento (principal, depois da T18)

- Gate completo em `backend/` e `frontend/` (`--base origin/main`), o teste de drift e os specs de integração do envio (`TESTCONTAINERS_ENABLED=1`), com log em arquivo.
- QA local na stack `orgamind-turnos-qa`, que não tem worker nem Evolution:
  - Conexões: áreas, mover, aviso;
  - setores: selo;
  - diálogo: grupos, área sem número, vários turnos, fora não selecionado;
  - histórico paginado;
  - tela de resultado.

  O envio real e os recibos ficam registrados como não verificados em QA.
- **Antes do deploy (M1):** conferir só lendo, em produção, os canais `isActive` com provider GOZAP/EVOLUTION e qual é `isDefault`. Se a regra da seção 9 cair no passo 4, avisar o usuário antes de publicar.
- Pendências no ledger: reprodução das falhas de 26/10 (M4); divergência `Tentar novamente` × `Tentar de novo` (D14), para o usuário decidir.
