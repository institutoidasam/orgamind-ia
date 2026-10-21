# OrgaMind — módulo de escala: turnos cadastráveis, escala por pessoa, envio por data e agendado — Implementation Plan

> **Para os agentes:** executar pela skill `sdd` (TDD, ledger em `.superpowers/sdd/2026-10-21-orgamind-escala/progress.md`). **Sem commit/push**: nenhuma task commita; a principal integra e só commita/publica com pedido explícito do usuário.

**Goal:** turnos com nome e horário cadastrados pelo ADMIN (o `FIRST`/`SECOND` da 1ª versão vira "1º turno"/"2º turno"); escala por pessoa como ciclo de 1 a 28 dias mais exceções por data; quadro da escala por setor; WhatsApp da equipe por setor + data + turno com escalados, "De folga" e "Sem telefone"; envio agendado para o início do turno com cancelamento; histórico com a foto da escala; campo "função" na pessoa.

**Architecture:** back primeiro, em série (todas as tasks de back tocam `schema.prisma`, `app.module.ts` ou o módulo `team-whatsapp`). Migração em expand/contract: T1 cria `Shift`, colunas FK e faz o backfill; T2a troca o código do envio para o Turno (sem migração); T2b faz só o DROP do enum. Regra da escala num resolvedor puro `(pessoa, data) → situação do dia` (T3), consumido pelo quadro (T5) e pelo envio (T7b). Agendamento reaproveita o dispatch: estado `SCHEDULED`, destinatários `SCHEDULED` congelados, tick por minuto no worker com claim por `updateMany` condicional (T9). O front espelha os contratos à mão em `features/*/schemas.ts` e não faz conta de fuso: o servidor devolve "hoje", o turno em andamento e o instante de início de cada turno.

**Tech Stack:** NestJS + Prisma + Zod (`createZodDto`) + BullMQ + date-fns 4 / date-fns-tz 3 + Vitest/testcontainers (backend); React + TanStack Router/Query + Radix (select, checkbox, dialog, tabs, table) + sonner + Vitest/Testing Library/user-event (frontend).

**Spec:** `docs/superpowers/specs/2026-10-21-orgamind-escala.md` (fonte da verdade). Mapas: `.superpowers/sdd/2026-10-21-orgamind-escala/mapa-backend-team.md`, `mapa-backend-fila.md`, `mapa-frontend.md`. Base: `8c33d6b` (branch `feat/escala`). Baseline dos gates: ledger `progress.md`.

## Ordem e paralelismo

```
Back (série):  T1 ─> T2a ─> T2b ─> T3 ─> T4 ─> T5 ─> T6 ─> T7a ─> T7b ─> T8 ─> T9
Front:                                    T4 ─> T10 ─┬─> T11 ────────────────┐
                                           T6 ──────>└─> T12 ─> T13           ├─> T14 (precisa T7b) ─> T15 (precisa T8)
                                                          T12 ───────────────┘
```

- **Back em série**: T1, T2a, T2b, T3–T6, T7a, T7b, T8 e T9 compartilham `backend/prisma/schema.prisma`, `backend/src/app.module.ts` e `backend/src/modules/team-whatsapp/**`. Ordem fixa dentro dos pares: T2a antes da T2b (o DROP só depois de nenhum código ler a coluna enum); T7a antes da T7b (a 7b grava a foto pelas colunas e pelo `createDispatch` da 7a).
- **Front em paralelo com o back** assim que o contrato existe: T10 depois da T4; T11 depois da T10 (e da T3); T12 depois da T6 e da T10; T13 depois da T12; T14 depois da T7b, T11 e T12; T15 depois da T8 e da T14.
- Paralelos permitidos (ownership disjunto): T10 com T5–T9; **T11 ∥ T12** (`features/users/**` + `routes/_authenticated/users/**` vs `features/staff-schedule/**` + `routes/_authenticated/escala/**` + `lib/nav.ts` + `lib/civil-date.ts`); **T13 ∥ T14** (`features/staff-schedule/**` + `routes/_authenticated/escala/**` vs `features/team-whatsapp/**` + `routes/_authenticated/whatsapp-equipe/**` + `lib/work-shift.ts`).
- Revisão: todas as tasks de back (T1, T2a, T2b, T3–T6, T7a, T7b, T8, T9) são críticas (revisor `opus`, conforme a SKILL.md do sdd). T10–T15 não são críticas; A/B de effort: T11, T13 e T15 (não críticas, número ímpar) vão com `effort: high`.

**Divergências da divisão sugerida (B1–B5, F1–F3), com motivo:**
- B1 virou **T1 + T2a + T2b** (expand/contract): um único passo passaria de 20 arquivos e misturaria DROP com troca de código. T1 é aditiva e preserva tudo; T2a troca o código e o contrato do envio sem migração; T2b é a única destrutiva (só o DROP, a migração e o teste dela).
- O envio por data virou **T7a + T7b**: T7a = foto da escala (migração aditiva) + grupos da lista de envios (C8); T7b = `targets`/`roster`/POST por data (C6/C7, GC9). A 7a vem antes porque a 7b grava a foto nas colunas criadas por ela; a 7a testa sozinha porque envio sem foto já é um caso do contrato (`[]`).
- A função (`jobTitle`) foi para a **T3** (com a migração aditiva da escala), não para a API de Turnos: juntas, T4 passaria de 15 arquivos.
- B3 virou **T3 + T5 + T6** (modelo + resolvedor puro; leitura + política; edição + recorte de exceções). B5 virou **T8 + T9** (API de agendar/cancelar; disparo no worker com concorrência).
- F1 virou **T10 + T11** (Turnos; Usuários). F2 virou **T12 + T13** (quadro + exceções; editor do ciclo). F3 virou **T14 + T15** (envio por data + histórico; agendamento + Novidades).
- A regra "em uso por envio agendado pendente" só pode existir depois da coluna de estado do envio: a T4 entrega três motivos (`users`, `schedules`, `exceptions`) e a T8 acrescenta `scheduled`. O enum do contrato já nasce com os quatro (C1), então o front da T10 não muda depois.

## Global Constraints

- **GC1 — Gate.** Iteração: `timeout 600 gate --test <arquivo>`. Fechamento de cada task: um único `timeout 600 gate --changed --base origin/main`, com cwd `backend/` ou `frontend/` conforme o lado. Suíte inteira, gate completo, `test:cov`/`--coverage` e e2e ficam com a principal, no Fechamento. Nunca os rode dentro de uma task.
- **GC2 — Limites do gate de complexidade, inclusive em specs.** Função/callback (inclusive o callback de `describe`) ≤ 50 linhas; ≤ 4 parâmetros (helper de teste com mais campos recebe um objeto); ciclomática ≤ 10; cognitiva ≤ 15; profundidade ≤ 4. Duplicação ≤ 3% das linhas novas; cobertura ≥ 80% das linhas novas. O `--changed` **não** acusa `max-lines-per-function` em `describe` nem `max-params` em spec: cada task confere isso à mão antes de fechar (casos novos em `describe` novos, `it.each` com tabela).
- **GC3 — Banco.** Nunca `prisma migrate reset`. `migrate dev`/`migrate deploy`/`db push`/`migrate diff --shadow-database-url` só contra o Postgres do testcontainers. `bun run prisma generate` (sem banco) é livre. Para gerar o DDL de uma migração sem banco: `bunx prisma migrate diff --from-schema-datamodel <cópia do schema anterior> --to-schema-datamodel prisma/schema.prisma --script`, e depois acrescentar o backfill à mão, sem renomear constraints/índices gerados.
- **GC4 — Migrações (dono e nome fixos).** Só estas, cada uma criada pela task indicada; nenhuma outra task mexe em `schema.prisma`:
  - T1 `20261021100000_shift_entity` (aditiva + backfill);
  - T2b `20261021101000_drop_work_shift_enum` (DROP das colunas `shift` e do tipo `WorkShift`; única destrutiva);
  - T3 `20261021110000_staff_schedule` (aditiva);
  - T7a `20261021120000_team_dispatch_roster` (aditiva);
  - T8 `20261021130000_team_dispatch_schedule` (aditiva + valores novos de enum).
  T2a e T7b não criam migração nem mexem em `schema.prisma`. O CI `migration-drift` (`.github/workflows/ci.yml:130-165`) só aceita diff vazio ou exatamente `DROP TABLE "_message_dup_neutralized_20260819";`. O teste de drift da T1 reproduz esse check e é rodado de novo por toda task que cria migração.
- **GC5 — Fuso e datas.** Fuso único `TIMEZONE_DEFAULT = 'America/Manaus'` (`backend/src/schemas/contracts/schedule.schema.ts:44`). Datas civis na API como string `'YYYY-MM-DD'`; instantes como ISO UTC (`toISOString()`). No banco, data civil é `@db.Date`, convertida só por `toDbDate`/`fromDbDate` (T3). "Hoje" e "agora HH:mm" só por `todayIn`/`timeIn` (T3), nunca por `new Date().toISOString().slice(0, 10)` nem `getDate()`. O frontend não faz conta de fuso: recebe `today`, `inProgress` e `shiftStarts[].startsAt` do servidor e só compara instantes ISO com `Date.now()` ou faz aritmética de calendário em string `'YYYY-MM-DD'` (`frontend/src/lib/civil-date.ts`, T12).
- **GC6 — Sem dependência nova, sem serviço novo.** Backend usa date-fns 4 e date-fns-tz 3 já instalados. Nada novo no compose. O agendador é um job repetível no worker, no padrão do `CAMPAIGN_SCHEDULER` (`backend/src/worker.ts:179-195`: `add('tick', {}, { repeat: { pattern: '* * * * *' }, jobId, ...REPEATABLE_JOB_CLEANUP_OPTS })`), com processor `concurrency: 1`.
- **GC7 — Política de envio inalterada.** `team-whatsapp.policy.ts`: o ADMIN alcança todos os setores ativos; o gestor (`Sector.managerId`), só os que gerencia (`managedSectorIds`), via `canSendToSector`. Setor fora da política dá o 403 `team_whatsapp.forbidden` **antes** de qualquer checagem de seleção/escala; `userIds` não abre outro setor.
- **GC8 — Política da escala.** Ver a escala: ADMIN e gestor (mesmo `isTeamSender`), só setores que alcança (ADMIN: todos os ativos; gestor: os que gerencia). Editar ciclo/exceção de uma pessoa: ADMIN, ou gestor que gerencia o **setor principal** (`User.sectorId`) dela. Destino de "Outro setor": ADMIN, qualquer setor ativo; gestor, só setor que também gerencia. Violação = 403 `staff_schedule.forbidden`, aplicado no servidor (a tela só esconde).
- **GC9 — Lista conferida = lista enviada.** No POST o servidor refaz a escala da data com os dados atuais e valida `userIds` contra ela; qualquer id fora (outro turno, de folga sem `includeOff`, outro setor no dia, sem escala, inativo, inexistente) dá 422 `team_whatsapp.invalid_selection` e **nada** é criado: nem `createDispatch`, nem job, nem auditoria. Ids repetidos contam uma vez. Agendado: os destinatários gravados no agendamento são os únicos que recebem.
- **GC10 — Telefone e dado pessoal.** Telefone nunca vai para log, auditoria, foto da escala (`roster`), destinatário gravado nem listagem de envios. Auditoria grava ids e contagens, nunca texto da mensagem, nome ou telefone.
- **GC11 — Contratos espelhados.** O back é a fonte (`backend/src/schemas/contracts/*.schema.ts` + DTOs); o front copia os mesmos campos e tipos em `frontend/src/features/*/schemas.ts`, sem SDK. Back e front sobem no mesmo PR: campo removido sai sem período de compatibilidade.
- **GC12 — Rótulos pt-BR exatos.** Separador ` · ` (espaço, U+00B7, espaço). `targetLabel`: `Produção · Noite · 21/10 · seleção de 2`, `Produção · todos os turnos · 21/10` (data `dd/MM` da data da escala). Turnos: `Turnos`, `Novo turno`, `Editar`, `Desativar`, `Reativar`, `Subir`, `Descer`, `atravessa a meia-noite`, `Sem turno`. Escala: `Escala`, `Semana`, `Mês`, `Editar escala`, `de outro setor`, células `<nome do turno>` / `Folga` / `Férias` / vazio, `Em <setor>` para quem trabalha em outro setor naquele dia; exceções `Folga`, `Férias`, `Troca de turno`, `Outro setor`, `Observação`, `Remover exceção`; modelos `Semanal`, `Rodízio semanal`, `12x36`, `Personalizado`. Envio: `Data`, `Todos os turnos`, `De folga`, `Sem telefone`, `incluir quem está de folga`, `Enviar agora`, `No início do turno`, `Agendados`, `Cancelar`, `Ver destinatários`, grupos `Destinatários` / `Escalados não marcados` / `De folga`, aviso `A Noite de 21/10 ainda está em andamento` + botão `Ver esse turno`, motivo `O início deste turno já passou`, falha `Canal indisponível na hora do envio`, pulado `Usuário inativo`, status `Agendado` / `Cancelado`.
- **GC13 — Testes enxutos e relógio.** Um teste por critério de aceite mais os 6 riscos (Review Focus), sem duplicar unit e integração. Backend: Vitest unit com `vitest-mock-extended`/harness do módulo; integração com `@testcontainers/postgresql` só onde a query/gravação muda. Relógio: `vi.useFakeTimers({ toFake: ['Date'] })` + `vi.setSystemTime(...)` em unit; métodos de disparo recebem `now: Date` explícito. Frontend: Vitest + Testing Library + user-event, `vi.mock` dos hooks de `api.ts`, sem msw.
- **GC14 — Sem extras.** Rotas novas só `/turnos` e `/escala` (em `frontend/src/routes/_authenticated/`; `src/routeTree.gen.ts` é gerado e não versionado). Itens de menu em `frontend/src/lib/nav.ts` com `roles`. Sem componente novo em `components/ui/` (não há calendar/popover: data é `<Input type="date">`). Sem commit/push.
- **GC15 — Novidades.** Só a T15 mexe em `frontend/src/release-notes.ts`: entrada nova no topo com `version: '2026.10.21.1'` (a atual do topo é `'2026.10.21'`), e o `describe` "novidade 2026.10.21" de `release-notes.spec.ts` deixa de supor que ela é `RELEASE_NOTES[0]`.

## Contratos compartilhados (fonte: back; o front espelha)

- **C1 — Turnos** (tabela: T1; API: T4; motivo `scheduled`: T8).
  - Prisma `Shift { id, name @unique, startTime String 'HH:mm', endTime String 'HH:mm', isActive Boolean @default(true), sortOrder Int, createdAt, updatedAt }`. Migrados com ids fixos: `shift_first` = `1º turno`, `06:00`, `14:00`, sortOrder 1; `shift_second` = `2º turno`, `14:00`, `22:00`, sortOrder 2. `endTime <= startTime` = atravessa a meia-noite; o turno pertence à data em que começa.
  - `backend/src/schemas/contracts/shift.schema.ts`: `hhmmSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)`; `shiftRefSchema = z.object({ id, name, startTime: hhmmSchema, endTime: hhmmSchema })`; `shiftUsageKindSchema = z.enum(['users', 'schedules', 'exceptions', 'scheduled'])`; `shiftAdminSchema = shiftRefSchema.extend({ isActive: boolean, sortOrder: int, crossesMidnight: boolean, inUse: z.object({ kind: shiftUsageKindSchema, count: int positive }).array() })`; `shiftListResponseSchema = z.object({ items: shiftAdminSchema.array() })`.
  - Rotas, todas `@Roles('ADMIN')`: `GET /internal/shifts` → `ShiftListResponse` (sortOrder asc, depois name); `POST /internal/shifts` `{ name: trim 1..40, startTime, endTime }` → 201 `ShiftAdmin`; `PATCH /internal/shifts/:id` `{ name?, startTime?, endTime?, isActive? }` (≥ 1 campo) → `ShiftAdmin`; `PUT /internal/shifts/order` `{ ids: string[] (1..100) }` → `ShiftListResponse`.
  - Erros: 404 `shifts.not_found`; 409 `shifts.name_taken` (comparação sem caixa, após trim); 409 `shifts.in_use` (desativar com `inUse` não vazio); 422 `shifts.invalid_order` (ids repetidos ou ≠ conjunto de todos os turnos).
  - `inUse`: `users` = usuários (ativos ou não) com `shiftId`; `schedules` = escalas com algum dia nesse turno; `exceptions` = exceções com esse `shiftId` e `endDate >= hoje (Manaus)`; `scheduled` = envios `state = SCHEDULED` com esse `shiftId` (T8). Só entram motivos com count > 0.
- **C2 — Usuários** (`shiftId`: T1; `jobTitle`: T3). `userSummarySchema` ganha `shiftId: string | null` (no lugar de `shift`) e `jobTitle: string | null`. `POST /users` aceita `shiftId?: string | null` (ausente = `null`) e `jobTitle?: string | null` (trim, ≤ 80; vazio vira `null`). `PATCH /users/:id`: ausente mantém, `null` limpa; `{ shiftId }` ou `{ jobTitle }` sozinho é PATCH válido. `shiftId` inexistente ou inativo → 422 `users.invalid_shift`. Nenhum dos dois revoga sessão.
- **C3 — Situação do dia** (tipo puro: T3; schema Zod: T5). `daySituationSchema = z.discriminatedUnion('kind', [ { kind: 'WORK', sectorId: string | null, shiftId: string, source: 'PROFILE' | 'CYCLE' | 'EXCEPTION' }, { kind: 'OFF', reason: 'DAY_OFF' | 'VACATION', source: 'CYCLE' | 'EXCEPTION' }, { kind: 'NONE' } ])`. Regra (spec §2–§3): exceção que cobre a data vence; senão ciclo, se `date >= startDate`, no dia `(date − startDate) mod cycleLength` (`null` no dia = folga); senão turno do cadastro todos os dias, no setor principal; senão `NONE` ("sem escala", não entra em nenhum turno).
- **C4 — Escala, leitura** (T5). `@Roles('ADMIN', 'SUPERVISOR', 'OPERATOR')` + GC8.
  - `GET /internal/staff-schedule/options` → `{ today: CivilDate, sectors: { id, name }[], shifts: ShiftRef[] }` (sectors = os que o ator alcança = destinos permitidos de "Outro setor"; shifts = ativos por sortOrder).
  - `GET /internal/staff-schedule/board?sectorId&from&to` (from ≤ to, até 42 dias) → `{ sectorId, from, to, today, sectors: { id, name }[], shifts: (ShiftRef & { isActive })[], rows: BoardRow[], exceptions: StaffException[] }`, com `BoardRow = { userId, name, jobTitle: string | null, fromOtherSector: boolean, canEdit: boolean, profileShiftId: string | null, schedule: StaffSchedule | null, days: { date, situation: DaySituation, exceptionId: string | null }[] }`. Linhas: membros ativos do setor principal (nome asc, pt-BR), depois ativos de outros setores com exceção `OTHER_SECTOR` para este setor no período (`fromOtherSector: true`). `sectors`/`shifts` = os citados nas linhas.
  - `staffScheduleSchema = { template: 'WEEKLY' | 'WEEKLY_ROTATION' | 'TWELVE_36' | 'CUSTOM', startDate, cycleLength: int 1..28, days: (string | null)[] }`; `staffExceptionSchema = { id, userId, kind: 'DAY_OFF' | 'VACATION' | 'SHIFT_SWAP' | 'OTHER_SECTOR', startDate, endDate, shiftId: string | null, sectorId: string | null, note: string | null }`.
  - Erros: 403 `staff_schedule.forbidden`; 422 `staff_schedule.invalid_period`.
- **C5 — Escala, edição** (T6).
  - `PUT /internal/staff-schedule/users/:userId/schedule` body `StaffSchedule` (`days.length === cycleLength`) → `StaffSchedule`. `DELETE /internal/staff-schedule/users/:userId/schedule` → 204 (idempotente; volta ao turno do cadastro).
  - `POST /internal/staff-schedule/users/:userId/exceptions` body `{ kind, startDate, endDate, shiftId?, sectorId?, note? (trim ≤ 200) }` → 201 `{ exception: StaffException, adjusted: number }`. Refines: `endDate >= startDate`, até 366 dias; `SHIFT_SWAP` exige `shiftId` e proíbe `sectorId`; `OTHER_SECTOR` exige os dois; `DAY_OFF`/`VACATION` proíbem os dois. `adjusted` = quantas exceções anteriores da pessoa foram recortadas ou substituídas.
  - `DELETE /internal/staff-schedule/exceptions/:exceptionId` → 204 (remove a exceção inteira).
  - Erros: 403 `staff_schedule.forbidden`; 404 `staff_schedule.user_not_found`, `staff_schedule.exception_not_found`; 422 `staff_schedule.invalid_shift` (inexistente ou inativo), `staff_schedule.invalid_sector` (inexistente ou inativo).
- **C6 — Alvos e escala do dia no envio** (T7b).
  - `GET /internal/team-whatsapp/targets` → `{ today: CivilDate, inProgress: { date: CivilDate, shift: ShiftRef } | null, shifts: ShiftRef[] (ativos), channels: (igual a hoje), sectors: { id, name, code }[] }`. `sectors[].members` deixa de existir.
  - `GET /internal/team-whatsapp/roster?sectorId&date` → `{ sectorId, date, shiftStarts: { shiftId, startsAt: ISO }[], members: { id, name: string | null, email, phoneE164: string | null, isActive, jobTitle: string | null, fromOtherSector: boolean, situation: DaySituation }[] }`. `members` = membros ativos do setor principal, menos quem trabalha em outro setor nesse dia, mais ativos de outros setores com `WORK` neste setor (`fromOtherSector: true`). 403 pela GC7.
- **C7 — POST de envio** `POST /internal/team-whatsapp/dispatches`.
  - Alvo pessoa `{ type: 'user', userId }` não muda.
  - Alvo setor: `{ type: 'sector', sectorId, shiftId?: string (T2a), userIds?: string[] 1..500 (já existe), date: CivilDate (T7b, obrigatório), includeOff?: boolean (T7b, só sem shiftId) }`. Ausência de `shiftId` = "Todos os turnos".
  - Topo do body (T8): `when?: 'now' | 'shift_start'` (padrão `'now'`); `'shift_start'` exige alvo setor com `shiftId`.
  - Resposta (T8): `{ dispatchId, queued: int ≥ 0, scheduled: int ≥ 0, scheduledFor: ISO | null, skipped: { userId, name, reason }[] }`.
  - Erros novos: 422 `team_whatsapp.invalid_shift` (T2a; turno inexistente ou inativo), 422 `team_whatsapp.schedule_in_past` (T8).
- **C8 — Lista de envios** `GET /internal/team-whatsapp/dispatches`, por item:
  - T2a: `target.shift: { id, name, startTime, endTime } | null` (snapshot); `recipients[].shiftName: string | null` no lugar de `recipients[].shift`.
  - T7a: `rosterDate: CivilDate | null`; `unselected: RosterPerson[]` (escalados no filtro, não destinatários); `off: RosterPerson[]` (de folga, não destinatários), com `RosterPerson = { userId: string | null, name, jobTitle: string | null, shiftName: string | null, reason: 'DAY_OFF' | 'VACATION' | null }` (tipo TS `TeamRosterPerson`, para não colidir com o `RosterPerson` do resolvedor da T3). Envio sem foto (anterior à T7b, que passa a gravá-la) → `[]`.
  - T8: `state: 'DISPATCHED' | 'SCHEDULED' | 'CANCELLED'`, `scheduledFor: ISO | null`, `firedAt: ISO | null`; `counts` ganha `scheduled` e `cancelled`; status do destinatário ganha `'SCHEDULED'` e `'CANCELLED'`; `teamSkipReasonSchema` ganha `'INACTIVE'`.
  - Nenhum campo de telefone.
- **C9 — Agendados** (T8). `GET /internal/team-whatsapp/scheduled` → `{ items: { id, scheduledFor: ISO, rosterDate, shift: { id, name, startTime, endTime }, label, recipientCount, channel: { id, name } | null, author: { id, name, email } | null }[] }`, só `state = SCHEDULED`, `scheduledFor` asc; ADMIN vê todos, gestor só os de setores que gerencia. `POST /internal/team-whatsapp/dispatches/:id/cancel` → 200 `{ id, state: 'CANCELLED' }`; erros 404 `team_whatsapp.dispatch_not_found`, 403 `team_whatsapp.forbidden` (`canSendToSector` falso), 409 `team_whatsapp.not_cancellable` (já disparado ou cancelado).
- **C10 — Gravação.**
  - `TeamWhatsappDispatch`: `shiftId` (relação `workShift`, D12), `shiftName`, `shiftStartTime`, `shiftEndTime` (colunas: T1; gravação: T2a — snapshot do turno do filtro; `null` = todos os turnos ou alvo pessoa); `rosterDate`, `includeOff`, `roster Json { working: RosterPerson[], off: RosterPerson[] }` (colunas e `createDispatch`: T7a; gravação no POST: T7b); `state`, `scheduledFor`, `firedAt`, `cancelledAt`, `cancelledById` (T8).
  - `TeamWhatsappRecipient`: `shiftId` (relação `workShift`), `shiftName` = turno da pessoa no dia (T7b; até a T7b, o turno do cadastro), `null` para quem entrou por `includeOff`.
  - Disparo (T9): canal inexistente, inativo ou de provedor não-equipe → destinatários `FAILED` com `errorCode = 'team_whatsapp.channel_unavailable'`; usuário inativo ou apagado → `SKIPPED` com `skipReason = INACTIVE`.

## Decisões do plano

- **D1 — Modelo `Shift`, não `WorkShift`.** No Postgres o tipo enum `"WorkShift"` ocupa o nome até o DROP (tabelas e tipos dividem `pg_type`), e a T1 precisa dos dois ao mesmo tempo. Ids fixos `shift_first`/`shift_second` tornam o backfill um `CASE` simples.
- **D2 — "Todos os turnos" deixa de incluir quem está `NONE`** (sem escala e sem turno no cadastro), conforme a spec §2 ("não entra em nenhum turno"). A mudança acontece na T7b; a T2a preserva o comportamento da 1ª versão. A tela de envio mostra o contador `N pessoa(s) deste setor estão sem escala e sem turno no cadastro — defina em Escala`, para que ninguém suma sem aviso.
- **D3 — Ciclo relacional, foto em JSON.** `StaffScheduleDay(scheduleId, dayIndex, shiftId?)` permite contar "em uso" com `count`; a foto do envio é `Json` no dispatch (lida só para exibir).
- **D4 — Exceções sem sobreposição.** Criar exceção recorta ou substitui as anteriores da mesma pessoa nos dias em comum (inclusive dividindo uma exceção em duas), numa transação com `SELECT … FROM "User" WHERE id = $1 FOR UPDATE` para serializar edições da mesma pessoa. "Remover exceção" remove a exceção inteira.
- **D5 — Modelos prontos no front.** `templates.ts` (T13) preenche o ciclo e alinha a Semanal/Rodízio à segunda-feira; o servidor guarda o ciclo recebido e só valida a forma e os turnos. `template` fica gravado para reabrir o editor.
- **D6 — "Nome curto" = `name`.** A spec não pede campo novo; a célula trunca com `title` no hover.
- **D7 — Canal no agendamento.** Agendar aplica o mesmo `requireChannel` do envio imediato (422/409). No disparo, canal inexistente/inativo falha com `channel_unavailable`; canal só desconectado segue o processor de hoje.
- **D8 — Inativo no disparo.** O processor de hoje não checa `isActive` (`team-whatsapp-send.processor.ts:198-212`); o disparo agendado marca `SKIPPED/INACTIVE` para usuário inativo ou apagado, antes de enfileirar.
- **D9 — Agendamento classifica na hora de agendar.** Sem telefone/suprimido viram `SKIPPED` já no agendamento (como no envio imediato); o resto vira `SCHEDULED`. Nenhum `SCHEDULED` → 422 `no_recipients`.
- **D10 — Menu.** `Escala` na seção `ops`, logo depois de "WhatsApp da equipe", `roles: WRITE_INTERNAL_ROLES`; `Turnos` na seção `admin`, logo depois de "Setores", `roles: ['ADMIN']` (os dois itens citados na spec estão em seções diferentes em `nav.ts`).
- **D11 — `roster` separado de `targets`.** A escala do dia vem por setor + data (`GET …/roster`), sem carregar todos os setores a cada troca de data.
- **D12 — Relação Prisma `workShift`, FK `shiftId`.** Em `User`, `TeamWhatsappDispatch` e `TeamWhatsappRecipient` a FK é `shiftId` e a relação com `Shift` se chama `workShift` (`workShift Shift? @relation(fields: [shiftId], references: [id], …)`): a coluna enum `shift WorkShift?` existe nesses três modelos até a T2b, e dois campos `shift` no mesmo modelo quebram o `prisma generate`. Depois do DROP (T2b) o nome **continua `workShift`** (não volta para `shift`), para nenhum `select`/`include` mudar nas tasks seguintes. Back-relations em `Shift`: `users User[]`, `teamDispatches TeamWhatsappDispatch[]`, `teamRecipients TeamWhatsappRecipient[]`. Em `StaffScheduleDay`/`StaffScheduleException` (T3), que nunca tiveram coluna enum, a relação se chama `shift`.
- **D13 — T1, T2a e T2b não sobem separadas.** O deploy é só no fim da feature (um PR, GC11). Entre T1 e T2a, `users` grava só `shiftId` enquanto o `team-whatsapp` ainda filtra por `User.shift`; essa inconsistência existe só no ambiente local entre as tasks e é aceitável por isso. Nenhuma task faz deploy parcial.

## Review Focus (riscos da spec → teste → task)

1. **R1 — Data civil em Manaus.** T3 `civil-date.spec.ts` "21:00 de Manaus já é amanhã em UTC": `todayIn(new Date('2026-10-22T01:00:00Z')) === '2026-10-21'`. T7b `team-whatsapp.service.roster.spec.ts` "targets.today em Manaus". T8 `team-whatsapp.service.schedule.spec.ts` "scheduledFor da Noite de 21/10".
2. **R2 — Turno que atravessa a meia-noite.** T3 `schedule-resolver.spec.ts` "Noite de 21/10 é de quem o ciclo põe na Noite em 21/10"; T7b `team-whatsapp.selection.spec.ts` + `service.roster.spec.ts` "às 02:00 de 22/10 a Noite de 21/10 está em andamento"; T8 `service.schedule.spec.ts` "agendar Noite de 21/10 → 2026-10-22T02:00:00.000Z"; T14 `index.spec.tsx` "Ver esse turno leva à Noite de 21/10".
3. **R3 — Ciclo.** T3 `schedule-resolver.spec.ts`: "antes da data de início cai no turno do cadastro", `it.each` "mod do ciclo de 2, 7 e 14 dias atravessa mês e ano", "exceção vence o ciclo".
4. **R4 — Migração.** T1 `shift-migration.integration.spec.ts` "FIRST/SECOND viram shift_first/shift_second em User, envio e destinatário" e "schema sem drift (igual ao CI)"; T2b no mesmo arquivo "tipo WorkShift e colunas shift não existem mais" e "backfill da T1 preservado depois do DROP". O drift roda de novo na T2b, T3, T7a e T8.
5. **R5 — Agendado sem disparo duplo nem depois de cancelado.** T9 `team-whatsapp.schedule.integration.spec.ts`: "dois disparos concorrentes: um só enfileira", "cancelar e disparar concorrentes: estado final coerente", "cancelado não dispara"; T8 `service.schedule.spec.ts` "cancelar já disparado → 409".
6. **R6 — Seleção e alcance pela API.** T7b `service.roster.spec.ts` `it.each` "seleção fora da escala da data → 422 sem efeito" (outro turno, de folga sem `includeOff`, outro setor no dia, sem escala) e "gestor de outro setor com userIds → 403"; T5 `staff-schedule.policy.spec.ts` e T6 `staff-schedule-edit.service.spec.ts` "gestor não edita pessoa de setor que não gerencia nem manda para setor que não gerencia → 403".

## Riscos aceitos

- **M1 — Escala calculada a cada leitura.** Quadro e roster resolvem a situação por pessoa × dia em memória (setor × até 42 dias). Aceitável para setores de dezenas de pessoas; rever se o cliente tiver setores com centenas.
- **M2 — Seleção fora da transação do envio.** Como na 1ª versão (M7 de lá): a escala pode mudar entre a resolução e o `createDispatch` (milissegundos). O 422 cobre a mudança anterior ao POST.
- **M3 — Lista de envios pesada.** Herdado (M6 da 1ª versão), agora com a foto: até 20 envios × (destinatários + foto). Paginar se crescer.
- **M4 — Horários migrados são valores de partida.** `06:00–14:00`/`14:00–22:00` podem não ser os do cliente; a Novidade (T15) pede ao ADMIN que confira.

---

### Task 1: back — entidade Turno, migração expand com backfill, usuários por `shiftId`

Depende de: nada.

**Crítico: contrato público — `userSummary.shift` vira `shiftId` e `POST/PATCH /users` aceitam `shiftId`.** A migração também faz backfill de dados de produção (sem apagar nada: o DROP fica na T2b).

**Files:**
- Modify: `backend/prisma/schema.prisma` (model `Shift`; `User.shiftId` + relação `workShift`; `TeamWhatsappDispatch.shiftId/shiftName/shiftStartTime/shiftEndTime` + relação `workShift`; `TeamWhatsappRecipient.shiftId/shiftName` + relação `workShift`; enum `WorkShift` e as três colunas `shift` **continuam**)
- Create: `backend/prisma/migrations/20261021100000_shift_entity/migration.sql`
- Create: `backend/test/migrations.ts` (helpers de migração para testcontainers)
- Create: `backend/src/modules/shifts/shift-migration.integration.spec.ts`
- Modify: `backend/src/schemas/contracts/user.schema.ts` (`userSummarySchema.shiftId`; `workShiftSchema` continua exportado até a T2a)
- Modify: `backend/src/modules/users/dto/create-user.dto.ts`, `backend/src/modules/users/dto/update-user.dto.ts` (+ refine)
- Modify: `backend/src/modules/users/users.service.ts`, `backend/src/modules/users/users.repository.ts` (`USER_SUMMARY_SELECT`, `findShiftForAssignment`)
- Modify (teste): `backend/src/modules/users/users.service.shift.spec.ts`, `backend/src/modules/users/users.repository.integration.spec.ts`
- Modify (só se o `tsc` acusar): `backend/src/modules/auth/refresh.service.spec.ts` (fixture `shift: null` → `shiftId: null`) e outras fixtures de `UserSummary`

**Contexto vinculado:**
- GC3: nunca `migrate reset`; `migrate deploy`/`migrate diff --shadow-database-url` só contra o testcontainers; DDL sem banco por `migrate diff --from-schema-datamodel … --to-schema-datamodel … --script`, sem renomear constraints geradas.
- GC4: esta task cria só `20261021100000_shift_entity`; o CI `migration-drift` aceita diff vazio ou exatamente `DROP TABLE "_message_dup_neutralized_20260819";`.
- C1: `Shift { id, name @unique, startTime 'HH:mm', endTime 'HH:mm', isActive @default(true), sortOrder Int, createdAt, updatedAt }`; migrados `shift_first` = `1º turno` 06:00–14:00 sortOrder 1, `shift_second` = `2º turno` 14:00–22:00 sortOrder 2.
- C2: `userSummary.shiftId: string | null`; POST `shiftId?` (ausente = null); PATCH ausente mantém, `null` limpa, `{ shiftId }` sozinho é válido; inexistente/inativo → 422 `users.invalid_shift`; não revoga sessão.
- D1: modelo `Shift` porque o tipo `"WorkShift"` ocupa o nome no Postgres até o DROP.
- D12: em `User`, `TeamWhatsappDispatch` e `TeamWhatsappRecipient` a FK é `shiftId` e a relação se chama `workShift`, porque a coluna enum `shift` coexiste até a T2b (dois campos `shift` quebram o `prisma generate`); depois do DROP o nome continua `workShift`; back-relations em `Shift`: `users`, `teamDispatches`, `teamRecipients`.
- D13: T1, T2a e T2b não sobem separadas (deploy só no fim da feature); entre T1 e T2a o `team-whatsapp` ainda filtra por `User.shift`, inconsistência só local.
- GC2: `describe` ≤ 50 linhas, helper ≤ 4 parâmetros (objeto), conferir à mão.

**Interfaces:**
- Consumes: `users.service.ts` `createUser`/`createInvitation`/`updateUser`/`toUpdateData` (mapa-backend-team §5); padrão testcontainers de `users.repository.integration.spec.ts` (`PostgreSqlContainer('postgres:16-alpine')` + `execFileSync(prisma migrate deploy)`).
- Produces:

```ts
// backend/test/migrations.ts
export function deployMigrations(opts: { databaseUrl: string; until?: string }): void;
// copia prisma/schema.prisma, migration_lock.toml e as pastas de migração com nome <= until para um tmp e roda `prisma migrate deploy --schema <tmp>/schema.prisma`
export function schemaDrift(opts: { shadowUrl: string }): { status: number; script: string };
// roda `prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --shadow-database-url <shadowUrl> --script --exit-code`; script sem linhas `--`, trim
```

- Prisma (nomes fixos, D12):
  - `User`: `shiftId String?` + `workShift Shift? @relation(fields: [shiftId], references: [id], onDelete: Restrict)` + `@@index([shiftId])`;
  - `TeamWhatsappDispatch`: `shiftId String?` + `workShift Shift? @relation(fields: [shiftId], references: [id], onDelete: SetNull)`, `shiftName String?`, `shiftStartTime String?`, `shiftEndTime String?`;
  - `TeamWhatsappRecipient`: `shiftId String?` + `workShift Shift? @relation(fields: [shiftId], references: [id], onDelete: SetNull)`, `shiftName String?`;
  - `Shift`: `users User[]`, `teamDispatches TeamWhatsappDispatch[]`, `teamRecipients TeamWhatsappRecipient[]`;
  - o campo enum `shift WorkShift?` dos três modelos fica intacto (sai na T2b). Nenhum `select`/`include` desta task usa o nome `shift` para a relação.
- SQL do backfill (ordem: CREATE TABLE → INSERT dos dois turnos → ADD COLUMN → UPDATE → índices/FKs):

```sql
INSERT INTO "Shift" ("id","name","startTime","endTime","isActive","sortOrder","createdAt","updatedAt") VALUES
  ('shift_first','1º turno','06:00','14:00',true,1,now(),now()),
  ('shift_second','2º turno','14:00','22:00',true,2,now(),now());
UPDATE "User" SET "shiftId" = CASE "shift" WHEN 'FIRST' THEN 'shift_first' WHEN 'SECOND' THEN 'shift_second' END WHERE "shift" IS NOT NULL;
UPDATE "TeamWhatsappDispatch" d SET "shiftId" = s."id", "shiftName" = s."name", "shiftStartTime" = s."startTime", "shiftEndTime" = s."endTime"
  FROM "Shift" s WHERE d."shift" IS NOT NULL AND s."id" = CASE d."shift" WHEN 'FIRST' THEN 'shift_first' ELSE 'shift_second' END;
UPDATE "TeamWhatsappRecipient" r SET "shiftId" = s."id", "shiftName" = s."name"
  FROM "Shift" s WHERE r."shift" IS NOT NULL AND s."id" = CASE r."shift" WHEN 'FIRST' THEN 'shift_first' ELSE 'shift_second' END;
```

- `users.repository.ts`: `findShiftForAssignment(id: string): Promise<{ id: string; isActive: boolean } | null>`; `USER_SUMMARY_SELECT` troca `shift` por `shiftId`.
- DTOs: `shiftId: z.string().min(1).nullable().optional()` nos dois; o refine "ao menos um campo" do update inclui `shiftId`.
- Erro `users.invalid_shift` (422, mensagem `Turno inválido`) no padrão de erros do módulo users.

**Steps:**
- [ ] **Step 1 (RED) — migração.** Em `shift-migration.integration.spec.ts`, container próprio; `deployMigrations({ databaseUrl, until: '20261021090000_work_shift' })`; inserir por SQL 3 usuários (`FIRST`, `SECOND`, `NULL`), um envio com `shift = 'SECOND'` e dois destinatários (`FIRST`, `NULL`); `deployMigrations({ databaseUrl })`. Testes:
  - `describe('migração 20261021100000_shift_entity')`:
    - "cria 1º turno 06:00–14:00 e 2º turno 14:00–22:00, ativos, ordem 1 e 2" → linhas exatas de `"Shift"`;
    - "FIRST/SECOND viram shift_first/shift_second em User, envio e destinatário" → usuários `shift_first`/`shift_second`/`null`; envio `shiftId 'shift_second'`, `shiftName '2º turno'`, `shiftStartTime '14:00'`, `shiftEndTime '22:00'`; destinatários `('shift_first', '1º turno')` e `(null, null)`.
  - `describe('schema sem drift (igual ao CI)')`: criar database `shadow` no mesmo container; `schemaDrift({ shadowUrl })` → `status === 0 && script === ''` ou `status === 2 && script === 'DROP TABLE "_message_dup_neutralized_20260819";'`.
- [ ] **Step 2 (RED) — users.** Em `users.service.shift.spec.ts` (trocar os casos de `shift` por `shiftId`): "POST com shiftId de turno ativo grava shift_first"; `it.each` "shiftId inexistente ou inativo → 422 users.invalid_shift sem gravar" (`null` do repo e `{ isActive: false }`); "PATCH sem shiftId não envia shiftId ao repositório"; "PATCH shiftId null limpa e não revoga sessão" (`sessionVersion` não incrementa). Em `users.repository.integration.spec.ts`: "shiftId grava, lê e limpa" usando `shift_first` criado pela migração.
- [ ] **Step 3:** `timeout 600 gate --test src/modules/shifts/shift-migration.integration.spec.ts` e `timeout 600 gate --test src/modules/users/users.service.shift.spec.ts` (cwd `backend/`) → FAIL pelo motivo esperado (migração/coluna inexistente).
- [ ] **Step 4:** implementar schema, migração (DDL gerado sem banco + o SQL acima), helpers, DTOs, contrato, service (`createInvitation`: `shiftId: input.shiftId ?? null`; valida com `findShiftForAssignment` antes de gravar quando `shiftId` é string; `toUpdateData` com `shiftId` só se `!== undefined`; `changesIdentity` não muda) e repository. `bun run prisma generate` (tem de passar com `shift` enum e `workShift` relação no mesmo modelo).
- [ ] **Step 5 (GREEN):** os comandos do Step 3 e `timeout 600 gate --test src/modules/users/users.repository.integration.spec.ts` → PASS.
- [ ] **Step 6:** `timeout 600 gate --changed --base origin/main` (cwd `backend/`) → PASS; conferir GC2 à mão nos specs.

---

### Task 2a: back — WhatsApp da equipe pelo Turno (código e contrato, sem migração)

Depende de: T1.

**Crítico: contrato público** — `targets`, `POST dispatches` e `GET dispatches` trocam `shift` por `shiftId`/snapshot, e o POST ganha a regra 422 `team_whatsapp.invalid_shift`. Não há migração nem mudança em `schema.prisma`: as colunas enum `shift` continuam no banco até a T2b, mas depois desta task nenhum código as lê nem grava.

**Files:**
- Modify: `backend/src/schemas/contracts/user.schema.ts` (remove `workShiftSchema`/`WorkShift`)
- Modify: `backend/src/schemas/contracts/team-whatsapp.schema.ts`
- Modify: `backend/src/modules/team-whatsapp/dto/create-team-dispatch.dto.ts` (+ spec do DTO)
- Modify: `backend/src/modules/team-whatsapp/team-whatsapp.selection.ts`, `team-whatsapp.repository.ts`, `team-whatsapp.service.ts`, `team-whatsapp.errors.ts` (`invalidShift`)
- Modify (teste): `team-whatsapp.test-fixtures.ts`, `team-whatsapp.service.shift.spec.ts`, `team-whatsapp.service.list.spec.ts`, `team-whatsapp.repository.integration.spec.ts`; `team-whatsapp.service.spec.ts` e specs do controller/processor só se o `tsc` acusar

**Contexto vinculado:**
- GC4: esta task não cria migração nem mexe em `schema.prisma` (o DROP é da T2b, a única destrutiva).
- D12: a relação com `Shift` em `User`/`TeamWhatsappDispatch`/`TeamWhatsappRecipient` se chama `workShift` (FK `shiftId`); `select`/`include` usam `shiftId` ou `workShift`, nunca `shift` (que ainda é a coluna enum até a T2b).
- D13: T1, T2a e T2b não sobem separadas; deploy só no fim da feature.
- GC7: ADMIN alcança todos os setores ativos, gestor só os que gerencia; 403 `team_whatsapp.forbidden` antes de qualquer checagem de seleção.
- GC9: seleção fora → 422 `team_whatsapp.invalid_selection` e nada criado (sem `createDispatch`, job ou auditoria); ids repetidos contam uma vez.
- C7 (parte T2a): alvo setor `{ type: 'sector', sectorId, shiftId?: string, userIds?: string[] 1..500 }`; sem `shiftId` = todos os turnos; turno inexistente ou inativo → 422 `team_whatsapp.invalid_shift`.
- C8 (parte T2a): `target.shift: { id, name, startTime, endTime } | null`; `recipients[].shiftName: string | null` no lugar de `shift`.
- C10: dispatch grava `shiftId/shiftName/shiftStartTime/shiftEndTime` do turno do filtro (null = todos os turnos ou alvo pessoa); recipient grava `shiftId/shiftName` do turno do cadastro do destinatário; a coluna enum `shift` deixa de ser gravada (fica `null` em envios novos).
- D2: nesta task "Todos os turnos" continua incluindo quem está sem turno (comportamento da 1ª versão); a mudança é da T7b.
- GC12: `targetLabel` com ` · `, ex.: `Produção · 2º turno · seleção de 2`, `Produção · todos os turnos` (a data entra na T7b).

**Interfaces:**
- Consumes: T1 (`Shift`, colunas FK com backfill, `userSummary.shiftId`).
- Produces:

```ts
// team-whatsapp.schema.ts
export const teamShiftSnapshotSchema = z.object({ id: z.string(), name: z.string(), startTime: z.string(), endTime: z.string() });
// members[].shiftId: z.string().nullable()  (sai members[].shift)
// target.shift: teamShiftSnapshotSchema.nullable()
// recipients[].shiftName: z.string().nullable()  (sai recipients[].shift)

// team-whatsapp.selection.ts (sai SHIFT_LABEL)
export function selectMembers<M extends { id: string; shiftId: string | null }>(
  members: readonly M[], shiftId: string | undefined, userIds: readonly string[] | undefined,
): M[] | null;
export function sectorTargetLabel(sectorName: string, shiftName: string | null, selectedCount: number | null): string;

// team-whatsapp.repository.ts
findActiveShift(id: string): Promise<{ id: string; name: string; startTime: string; endTime: string } | null>;
// listSectors/findSectorWithActiveMembers selecionam shiftId; listRecipients seleciona shiftName; listDispatches seleciona os 4 campos de snapshot

// team-whatsapp.errors.ts
export const invalidShift: () => DomainError; // { code: 'team_whatsapp.invalid_shift', message: 'Turno inválido', status: 422 }
```

**Steps:**
- [ ] **Step 1 (RED):**
  - `team-whatsapp.service.shift.spec.ts` (reescrito para `shiftId`): `it.each` "filtro de turno" — `shiftId: 'shift_second'` lista só quem tem `shift_second`; sem `shiftId` lista todos, inclusive `shiftId: null`; `it.each` "shiftId inexistente ou inativo → 422 team_whatsapp.invalid_shift sem efeito"; "seleção em shift_second com João agora em shift_first → 422 invalid_selection, nenhum destinatário"; "gestor fora da política com userIds → 403"; "snapshot: dispatch shiftId 'shift_second', shiftName '2º turno', 14:00, 22:00; destinatário com o shiftName do cadastro"; "rótulo 'Produção · 2º turno · seleção de 2'".
  - `team-whatsapp.service.list.spec.ts`: "target.shift vem do snapshot `{ id: 'shift_second', name: '2º turno', startTime: '14:00', endTime: '22:00' }`; todos os turnos → null"; "recipients[].shiftName e nenhuma chave de telefone".
  - DTO spec: `shiftId: ''` → falha; `shift: 'FIRST'` é ignorado/recusado conforme o `strict` atual do DTO.
  - `team-whatsapp.repository.integration.spec.ts`: "createDispatch grava snapshot do turno e listRecipients devolve shiftName".
- [ ] **Step 2:** `timeout 600 gate --test src/modules/team-whatsapp/team-whatsapp.service.shift.spec.ts` → FAIL.
- [ ] **Step 3:** implementar contratos, DTO, selection, repository e service (`resolveSector`: política → `findActiveShift` se `shiftId` (null → `invalidShift`) → `selectMembers` → snapshot); `createDispatch` deixa de gravar a coluna enum `shift` no envio e nos destinatários. Sem `prisma generate` (schema não muda).
- [ ] **Step 4 (pré-condição da T2b):** Grep `WorkShift` e `workShiftSchema` em `backend/src` → nenhuma ocorrência fora de `src/modules/shifts/shift-migration.integration.spec.ts`; Grep de leitura/gravação do campo enum `shift` em `src/modules/users/**` e `src/modules/team-whatsapp/**` → nenhuma. Citar o resultado no relatório.
- [ ] **Step 5 (GREEN):** `timeout 600 gate --test` em `team-whatsapp.service.shift.spec.ts`, `team-whatsapp.service.list.spec.ts`, spec do DTO e `team-whatsapp.repository.integration.spec.ts` → PASS.
- [ ] **Step 6:** `timeout 600 gate --changed --base origin/main` (cwd `backend/`) → PASS; GC2 à mão.

---

### Task 2b: back — DROP do enum `WorkShift` (migração contract)

Depende de: T2a.

**Crítico: migração destrutiva de produção** — DROP das colunas `shift` de `User`, `TeamWhatsappDispatch`, `TeamWhatsappRecipient` e do tipo `WorkShift`. Única task destrutiva do plano; não muda código de aplicação.

**Files:**
- Modify: `backend/prisma/schema.prisma` (remove o enum `WorkShift` e as três colunas `shift`; FKs `shiftId` e relações `workShift` ficam como estão)
- Create: `backend/prisma/migrations/20261021101000_drop_work_shift_enum/migration.sql`
- Modify (teste): `backend/src/modules/shifts/shift-migration.integration.spec.ts`
- Modify (só se o Grep do Step 1 achar fora de `src/`): `backend/prisma/seed*.ts` ou `backend/test/**` que gravem o enum `shift` (troca mecânica por `shiftId`)

**Contexto vinculado:**
- GC3: nunca `migrate reset`; `migrate deploy`/`migrate diff --shadow-database-url` só contra o testcontainers; DDL sem banco por `migrate diff --from-schema-datamodel … --to-schema-datamodel … --script`, sem renomear constraints geradas.
- GC4: esta task cria só `20261021101000_drop_work_shift_enum`; drift aceito: vazio ou exatamente `DROP TABLE "_message_dup_neutralized_20260819";`.
- D12: depois do DROP a relação continua `workShift` (FK `shiftId`) em `User`, `TeamWhatsappDispatch` e `TeamWhatsappRecipient`; não renomear para `shift`.
- D13: T1, T2a e T2b sobem juntas, no deploy do fim da feature.
- R4: o backfill da T1 (`shift_first`/`shift_second` em User, envio e destinatário) tem de sobreviver ao DROP.

**Interfaces:**
- Consumes: T2a (nenhum código lê/grava a coluna enum); `deployMigrations`/`schemaDrift` (T1, `backend/test/migrations.ts`).
- Migração:

```sql
ALTER TABLE "User" DROP COLUMN "shift";
ALTER TABLE "TeamWhatsappDispatch" DROP COLUMN "shift";
ALTER TABLE "TeamWhatsappRecipient" DROP COLUMN "shift";
DROP TYPE "WorkShift";
```

**Steps:**
- [ ] **Step 1 (pré-condição):** Grep `WorkShift` em `backend/src`, `backend/test` e `backend/prisma/*.ts` → só o spec de migração. Ocorrência em `src/` fora dele = BLOCKED (é trabalho da T2a); em seed/`test/`, trocar por `shiftId`.
- [ ] **Step 2 (RED):** `shift-migration.integration.spec.ts`: novo `describe('migração 20261021101000_drop_work_shift_enum')` com "tipo WorkShift e colunas shift não existem mais" (`pg_type` sem `WorkShift`; `information_schema.columns` sem `shift` nas três tabelas) e "backfill da T1 preservado depois do DROP" (mesmas asserções de `shiftId`/`shiftName`). O drift continua no `describe` próprio.
- [ ] **Step 3:** `timeout 600 gate --test src/modules/shifts/shift-migration.integration.spec.ts` → FAIL.
- [ ] **Step 4:** remover enum e colunas do schema; gerar o DDL sem banco (GC3) e conferir que é igual ao SQL acima; `bun run prisma generate`.
- [ ] **Step 5 (GREEN):** `timeout 600 gate --test` em `src/modules/shifts/shift-migration.integration.spec.ts`, `src/modules/team-whatsapp/team-whatsapp.repository.integration.spec.ts` e `src/modules/users/users.repository.integration.spec.ts` (rodam todas as migrações) → PASS.
- [ ] **Step 6:** `timeout 600 gate --changed --base origin/main` (cwd `backend/`) → PASS; GC2 à mão.

---

### Task 3: back — modelo da escala, função, datas civis e resolvedor puro

Depende de: T2b.

**Crítico: contrato público — `userSummary` ganha `jobTitle` e `POST/PATCH /users` aceitam `jobTitle`.** O resto é aditivo e puro.

**Files:**
- Modify: `backend/prisma/schema.prisma` (enums `StaffScheduleTemplate`, `StaffExceptionKind`; models `StaffSchedule`, `StaffScheduleDay`, `StaffScheduleException`; `User.jobTitle String? @db.VarChar(80)`)
- Create: `backend/prisma/migrations/20261021110000_staff_schedule/migration.sql`
- Create: `backend/src/schemas/contracts/civil-date.schema.ts`
- Create: `backend/src/modules/staff-schedule/civil-date.ts` + `civil-date.spec.ts`
- Create: `backend/src/modules/staff-schedule/schedule-resolver.ts` + `schedule-resolver.spec.ts`
- Modify: `backend/src/schemas/contracts/user.schema.ts`, `users/dto/create-user.dto.ts`, `users/dto/update-user.dto.ts`, `users/users.service.ts`, `users/users.repository.ts`
- Create (teste): `backend/src/modules/users/users.service.job-title.spec.ts`
- Modify (teste): `backend/src/modules/users/users.repository.integration.spec.ts`; `shift-migration.integration.spec.ts` só roda (drift)

**Contexto vinculado:**
- GC4: esta task cria só `20261021110000_staff_schedule`; rodar de novo o drift.
- GC5: fuso `TIMEZONE_DEFAULT = 'America/Manaus'`; datas civis `'YYYY-MM-DD'`, instantes ISO UTC; `@db.Date` só por `toDbDate`/`fromDbDate`; "hoje" só por `todayIn`.
- C2 (parte T3): `jobTitle?: string | null`, trim, ≤ 80, vazio vira `null`; PATCH ausente mantém, `null` limpa; não revoga sessão.
- C3: exceção que cobre a data vence; senão ciclo se `date >= startDate`, no dia `(date − startDate) mod cycleLength` (`null` = folga); senão turno do cadastro todos os dias no setor principal; senão `NONE`.
- D3: ciclo relacional `StaffScheduleDay(scheduleId, dayIndex, shiftId?)`.
- GC13: unit com `vi.useFakeTimers({ toFake: ['Date'] })` quando precisar de relógio.

**Interfaces:**
- Prisma (nomes exatos). Relações de ida: `StaffSchedule.user`, `StaffScheduleDay.schedule` e `StaffScheduleDay.shift`, `StaffScheduleException.user`, `.shift` e `.sector`. Back-relations (re-revisão do plano): `User.staffSchedule StaffSchedule?` e `User.staffExceptions StaffScheduleException[]`; `Shift.scheduleDays StaffScheduleDay[]` e `Shift.staffExceptions StaffScheduleException[]`; `Sector.staffExceptions StaffScheduleException[]`. `createdById` fica sem relação.

```prisma
enum StaffScheduleTemplate { WEEKLY WEEKLY_ROTATION TWELVE_36 CUSTOM }
enum StaffExceptionKind { DAY_OFF VACATION SHIFT_SWAP OTHER_SECTOR }
model StaffSchedule {
  id String @id @default(cuid())
  userId String @unique            // User onDelete: Cascade
  template StaffScheduleTemplate
  startDate DateTime @db.Date
  cycleLength Int
  updatedById String?
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  days StaffScheduleDay[]
}
model StaffScheduleDay {
  scheduleId String                // StaffSchedule onDelete: Cascade
  dayIndex Int
  shiftId String?                  // null = folga; Shift onDelete: Restrict
  @@id([scheduleId, dayIndex])
  @@index([shiftId])
}
model StaffScheduleException {
  id String @id @default(cuid())
  userId String                    // User onDelete: Cascade
  kind StaffExceptionKind
  startDate DateTime @db.Date
  endDate DateTime @db.Date
  shiftId String?                  // Shift onDelete: Restrict
  sectorId String?                 // Sector onDelete: Restrict
  note String? @db.VarChar(200)
  createdById String?
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  @@index([userId, startDate])
  @@index([sectorId, startDate])
  @@index([shiftId, endDate])
}
```

- Produces:

```ts
// backend/src/schemas/contracts/civil-date.schema.ts
export const civilDateSchema: z.ZodType<string>; // regex ^\d{4}-\d{2}-\d{2}$ + data real (recusa '2026-02-30')

// backend/src/modules/staff-schedule/civil-date.ts
export type CivilDate = string;
export function isCivilDate(s: string): boolean;
export function todayIn(now: Date, timeZone?: string): CivilDate;          // padrão TIMEZONE_DEFAULT
export function timeIn(now: Date, timeZone?: string): string;              // 'HH:mm'
export function addDays(date: CivilDate, days: number): CivilDate;
export function diffDays(later: CivilDate, earlier: CivilDate): number;
export function isoWeekday(date: CivilDate): number;                       // 1 = segunda … 7 = domingo
export function zonedStart(date: CivilDate, hhmm: string, timeZone?: string): Date; // fromZonedTime
export function toDbDate(date: CivilDate): Date;                           // meia-noite UTC
export function fromDbDate(d: Date): CivilDate;
export function formatDayMonth(date: CivilDate): string;                   // '21/10'

// backend/src/modules/staff-schedule/schedule-resolver.ts
export type ScheduleCycle = { startDate: CivilDate; cycleLength: number; days: readonly (string | null)[] };
export type ScheduleExceptionInput = { id: string; kind: StaffExceptionKind; startDate: CivilDate; endDate: CivilDate; shiftId: string | null; sectorId: string | null };
export type RosterPerson = { id: string; sectorId: string | null; profileShiftId: string | null; cycle: ScheduleCycle | null; exceptions: readonly ScheduleExceptionInput[] };
export type DaySituation =
  | { kind: 'WORK'; sectorId: string | null; shiftId: string; source: 'PROFILE' | 'CYCLE' | 'EXCEPTION' }
  | { kind: 'OFF'; reason: 'DAY_OFF' | 'VACATION'; source: 'CYCLE' | 'EXCEPTION' }
  | { kind: 'NONE' };
export function cycleIndex(cycle: ScheduleCycle, date: CivilDate): number | null; // null antes do início
export function exceptionOn(exceptions: readonly ScheduleExceptionInput[], date: CivilDate): ScheduleExceptionInput | null;
export function resolveDay(person: RosterPerson, date: CivilDate): DaySituation;
```

- Users: `userSummarySchema.jobTitle: z.string().nullable()`; DTOs `jobTitle: z.string().trim().max(80).nullable().optional()`; service grava `''` como `null`; `toUpdateData` só se `!== undefined`.

**Steps:**
- [ ] **Step 1 (RED) — `civil-date.spec.ts`:**
  - "21:00 de Manaus já é amanhã em UTC": `todayIn(new Date('2026-10-22T01:00:00Z')) === '2026-10-21'`; `todayIn(new Date('2026-10-22T04:00:00Z')) === '2026-10-22'`; `timeIn(new Date('2026-10-22T06:00:00Z')) === '02:00'`.
  - "início do turno em Manaus": `zonedStart('2026-10-21', '22:00').toISOString() === '2026-10-22T02:00:00.000Z'`; `zonedStart('2026-10-21', '06:00').toISOString() === '2026-10-21T10:00:00.000Z'`.
  - `it.each` calendário: `addDays('2026-10-31', 1) === '2026-11-01'`; `addDays('2026-12-31', 1) === '2027-01-01'`; `diffDays('2027-01-01', '2026-12-30') === 2`; `isoWeekday('2026-10-26') === 1`; `isoWeekday('2026-10-25') === 7`; `isCivilDate('2026-02-30') === false`; `formatDayMonth('2026-10-21') === '21/10'`; `fromDbDate(toDbDate('2026-10-21')) === '2026-10-21'`.
- [ ] **Step 2 (RED) — `schedule-resolver.spec.ts`** (turnos `manha`, `noite`, `a`, `b`; setor `sec_producao`):
  - "antes da data de início cai no turno do cadastro": ciclo início `2026-12-21`, `profileShiftId: 'shift_first'`, data `2026-12-20` → `{ kind: 'WORK', sectorId: 'sec_producao', shiftId: 'shift_first', source: 'PROFILE' }`; sem turno no cadastro → `{ kind: 'NONE' }`.
  - "sem escala: turno do cadastro todos os dias" (sábado `2026-10-24` → WORK PROFILE).
  - `it.each` "mod do ciclo de 2, 7 e 14 dias atravessa mês e ano":
    - 12x36 início `2026-12-30`, dias `['noite', null]`: `2026-12-31` → OFF DAY_OFF CYCLE; `2027-01-01` → WORK noite CYCLE; `2027-01-02` → OFF;
    - semanal início `2026-10-26`, `[m,m,m,m,m,null,null]`: `2026-11-01` → OFF; `2026-11-02` → WORK manha; `2027-01-03` → OFF; `2027-01-04` → WORK manha;
    - rodízio início `2026-12-21`, `[a×5, null, null, b×5, null, null]`: `2026-12-28` → WORK b; `2027-01-01` → WORK b; `2027-01-02` → OFF; `2027-01-04` → WORK a; `2027-01-11` → WORK b.
  - "exceção vence o ciclo": DAY_OFF em `2026-10-27` (dia de trabalho no semanal) → OFF DAY_OFF EXCEPTION; VACATION `2026-11-02..2026-11-06` em `2026-11-04` → OFF VACATION EXCEPTION; SHIFT_SWAP `noite` → WORK `sec_producao` noite EXCEPTION; OTHER_SECTOR `sec_logistica` + `manha` → WORK `sec_logistica` manha EXCEPTION.
  - "Noite de 21/10 é de quem o ciclo põe na Noite em 21/10": 12x36 início `2026-10-21`, `['noite', null]` → `2026-10-21` WORK noite; `2026-10-22` OFF (a madrugada de 22/10 pertence à entrada de 21/10).
- [ ] **Step 3 (RED) — função:** `users.service.job-title.spec.ts`: "POST com jobTitle '  Operador de empilhadeira  ' grava sem espaços"; "jobTitle '' grava null"; "PATCH sem jobTitle não envia jobTitle"; "PATCH jobTitle null limpa e não revoga sessão"; DTO "jobTitle com 81 caracteres → falha de validação". `users.repository.integration.spec.ts`: "jobTitle grava, lê e limpa".
- [ ] **Step 4:** `timeout 600 gate --test src/modules/staff-schedule/schedule-resolver.spec.ts` → FAIL.
- [ ] **Step 5:** implementar schema, migração aditiva (DDL gerado sem banco), `civil-date.ts` (date-fns-tz `formatInTimeZone`/`fromZonedTime`; aritmética de calendário em UTC), resolvedor (`cycleIndex`: `diff < 0 → null`, senão `diff % cycleLength`) e função em users. `bun run prisma generate`.
- [ ] **Step 6 (GREEN):** `timeout 600 gate --test` em `civil-date.spec.ts`, `schedule-resolver.spec.ts`, `users.service.job-title.spec.ts`, `users.repository.integration.spec.ts` e `src/modules/shifts/shift-migration.integration.spec.ts` (drift) → PASS.
- [ ] **Step 7:** `timeout 600 gate --changed --base origin/main` (cwd `backend/`) → PASS; GC2 à mão.

---

### Task 4: back — API de Turnos (ADMIN)

Depende de: T3 (tabelas da escala para o "em uso").

**Crítico: decide autorização + contrato público** — rotas só ADMIN; regra "não desativa turno em uso"; contrato `shift.schema.ts` consumido pelo front.

**Files:**
- Create: `backend/src/schemas/contracts/shift.schema.ts`
- Create: `backend/src/modules/shifts/shifts.module.ts`, `shifts.controller.ts`, `shifts.service.ts`, `shifts.repository.ts`, `shifts.errors.ts`
- Create: `backend/src/modules/shifts/dto/create-shift.dto.ts`, `dto/update-shift.dto.ts`, `dto/reorder-shifts.dto.ts`
- Create (teste): `backend/src/modules/shifts/shifts.service.spec.ts`, `shifts.controller.spec.ts`, `shifts.repository.integration.spec.ts`, `dto/shift-dtos.spec.ts`
- Modify: `backend/src/app.module.ts` (registrar `ShiftsModule`)

**Contexto vinculado:**
- C1 inteiro (schemas `hhmmSchema`, `shiftRefSchema`, `shiftUsageKindSchema = ['users','schedules','exceptions','scheduled']`, `shiftAdminSchema`, `shiftListResponseSchema`; 4 rotas `@Roles('ADMIN')`; erros `shifts.not_found` 404, `shifts.name_taken` 409, `shifts.in_use` 409, `shifts.invalid_order` 422; `crossesMidnight = endTime <= startTime`; motivos de "em uso" com count > 0).
- Spec §1: não se apaga turno (sem rota DELETE); inativo some de escala nova e envio mas fica no histórico; mudar o horário vale para novos agendamentos (não tocar envios).
- Nesta task `inUse` produz só `users`, `schedules`, `exceptions`; `scheduled` vem na T8.
- GC5: "hoje" para `exceptions` = `todayIn(new Date())`.
- GC10: auditoria só com ids (`shift.create`, `shift.update`, `shift.reorder`, `{ actorId, shiftId }`).

**Interfaces:**
- Consumes: `todayIn` (T3); `AuditService.log(action, entity, id, meta)`; `@Roles` (`backend/src/modules/auth/decorators/roles.decorator.ts`).
- Produces:

```ts
// shifts.service.ts
list(): Promise<ShiftListResponse>;
create(actorId: string, input: CreateShiftInput): Promise<ShiftAdmin>;      // sortOrder = max + 1
update(actorId: string, id: string, input: UpdateShiftInput): Promise<ShiftAdmin>;
reorder(actorId: string, input: ReorderShiftsInput): Promise<ShiftListResponse>; // sortOrder 1..n na ordem recebida, numa transação
// shifts.repository.ts
listAll(): Promise<ShiftRow[]>;
findById(id: string): Promise<ShiftRow | null>;
findByNameInsensitive(name: string, exceptId?: string): Promise<ShiftRow | null>;
usage(ids: readonly string[], today: CivilDate): Promise<Map<string, ShiftUsage[]>>; // ShiftUsage = { kind, count }
maxSortOrder(): Promise<number>;
create(data): Promise<ShiftRow>; update(id, data): Promise<ShiftRow>; setOrder(ids: readonly string[]): Promise<void>;
```

**Steps:**
- [ ] **Step 1 (RED):**
  - `shifts.service.spec.ts`:
    - "cria 'Noite' 22:00–06:00 com sortOrder = maior + 1 e crossesMidnight true";
    - `it.each` "nome repetido → 409 shifts.name_taken" (`'noite'`, `' Noite '`);
    - "desativar turno em uso → 409 shifts.in_use e não grava";
    - "desativar sem uso → isActive false e auditoria";
    - "mudar horário só atualiza o Shift" (repo `update` chamado com `{ startTime }`, nada mais);
    - `it.each` "reordenar com conjunto diferente → 422 shifts.invalid_order" (faltando, sobrando, repetido);
    - "reordenar grava 1..n na ordem recebida";
    - "id inexistente → 404 shifts.not_found";
    - "list devolve inUse só com count > 0".
  - `dto/shift-dtos.spec.ts`: `it.each` "HH:mm inválido" (`'24:00'`, `'7:00'`, `'07:60'`) → falha; nome `''` e 41 caracteres → falha; PATCH `{}` → falha.
  - `shifts.controller.spec.ts`: "todas as rotas exigem ADMIN" (metadado de `@Roles` igual a `['ADMIN']` no controller).
  - `shifts.repository.integration.spec.ts`: "usage conta pessoa com o turno no cadastro, escala com o turno e exceção de hoje em diante; exceção encerrada ontem não conta" (`today` passado por parâmetro, ex.: `'2026-10-21'` e exceção com `endDate '2026-10-20'`).
- [ ] **Step 2:** `timeout 600 gate --test src/modules/shifts/shifts.service.spec.ts` → FAIL.
- [ ] **Step 3:** implementar contrato, DTOs, módulo, controller (`@Controller('internal/shifts')`), service, repository, erros; registrar em `app.module.ts`.
- [ ] **Step 4 (GREEN):** `timeout 600 gate --test` nos quatro specs + `src/schemas/openapi-representability.spec.ts` → PASS.
- [ ] **Step 5:** `timeout 600 gate --changed --base origin/main` (cwd `backend/`) → PASS; GC2 à mão.

---

### Task 5: back — Escala: opções, quadro e política

Depende de: T4.

**Crítico: decide autorização + contrato público** — quem vê a escala de qual setor e quem pode editar cada linha (`canEdit`); contrato `staff-schedule.schema.ts` de leitura.

**Files:**
- Create: `backend/src/schemas/contracts/staff-schedule.schema.ts` (leitura: `daySituationSchema`, `staffScheduleSchema`, `staffExceptionSchema`, `staffScheduleOptionsSchema`, `staffScheduleBoardSchema`)
- Create: `backend/src/modules/staff-schedule/staff-schedule.module.ts` (exporta `StaffScheduleRepository`), `staff-schedule.controller.ts`, `staff-schedule.service.ts`, `staff-schedule.repository.ts`, `staff-schedule.policy.ts`, `staff-schedule.errors.ts`, `board.ts` (montagem pura das linhas), `dto/board-query.dto.ts`
- Create: `backend/src/modules/team-whatsapp/team-actor.query.ts` (extrai a query de `findActor`)
- Modify: `backend/src/modules/team-whatsapp/team-whatsapp.repository.ts` (`findActor` passa a usar `team-actor.query.ts`)
- Modify: `backend/src/app.module.ts`
- Create (teste): `staff-schedule.policy.spec.ts`, `staff-schedule.service.spec.ts`, `staff-schedule.repository.integration.spec.ts`

**Contexto vinculado:**
- GC8: ver = ADMIN e gestor, só setores que alcança (ADMIN todos os ativos, gestor os que gerencia); editar = ADMIN ou gestor do setor principal da pessoa; destino "Outro setor" = ADMIN qualquer ativo, gestor só os que gerencia; violação 403 `staff_schedule.forbidden`.
- C3: `daySituationSchema` (WORK `{ sectorId, shiftId, source }` / OFF `{ reason, source }` / NONE).
- C4 inteiro (options `{ today, sectors, shifts }`; board `{ sectorId, from, to, today, sectors, shifts (com isActive), rows, exceptions }`; `BoardRow`; linhas do setor principal por nome pt-BR e depois `fromOtherSector`; `from <= to`, até 42 dias, senão 422 `staff_schedule.invalid_period`).
- Spec §4 (decisão): o gestor do setor de destino vê quem vem de fora mas não edita (`canEdit: false`).
- GC5: `today = todayIn(new Date())`; datas via `toDbDate`/`fromDbDate`.

**Interfaces:**
- Consumes: `resolveDay`, `RosterPerson`, `ScheduleCycle`, `ScheduleExceptionInput` (T3); `TeamActor`, `isTeamSender`, `canSendToSector` de `team-whatsapp.policy.ts` (funções puras; não importar o `TeamWhatsappModule`).
- Produces:

```ts
// team-whatsapp/team-actor.query.ts
export function findTeamActor(prisma: PrismaService, id: string): Promise<TeamActor | null>; // mesmo select de team-whatsapp.repository.ts:87-100

// staff-schedule.policy.ts
export function canViewSchedule(actor: TeamActor): boolean;                              // = isTeamSender
export function viewableSectorIds(actor: TeamActor): readonly string[] | null;           // null = todos (ADMIN)
export function canEditPerson(actor: TeamActor, person: { sectorId: string | null }): boolean;
export function canAssignSector(actor: TeamActor, sector: { id: string; isActive: boolean }): boolean;

// staff-schedule.repository.ts (exportado pelo módulo; T6 e T7b consomem)
findActor(id: string): Promise<TeamActor | null>;
listSectors(onlyIds: readonly string[] | null): Promise<{ id: string; name: string }[]>;  // ativos
listActiveShifts(): Promise<ShiftRef[]>;
listSectorPeople(sectorId: string): Promise<BoardPersonRow[]>;                           // ativos do setor principal: id, name, email, jobTitle, sectorId, shiftId
listVisitorIds(sectorId: string, from: CivilDate, to: CivilDate): Promise<string[]>;     // ativos de outro setor com OTHER_SECTOR para sectorId no período
loadScheduleData(userIds: readonly string[], from: CivilDate, to: CivilDate):
  Promise<Map<string, { cycle: ScheduleCycle | null; schedule: StaffSchedule | null; exceptions: ScheduleExceptionInput[] }>>;

// board.ts
export function buildBoardRows(input: { actor: TeamActor; sectorId: string; dates: readonly CivilDate[]; people: readonly BoardPersonInput[] }): BoardRow[];

// staff-schedule.service.ts
options(actorId: string): Promise<StaffScheduleOptions>;
board(actorId: string, query: BoardQuery): Promise<StaffScheduleBoard>;
```

- Controller: `@Controller('internal/staff-schedule')`, `@Roles('ADMIN', 'SUPERVISOR', 'OPERATOR')`, `GET options`, `GET board` (query `sectorId`, `from`, `to` com `civilDateSchema`); `actorId = req.user.sub`.

**Steps:**
- [ ] **Step 1 (RED):**
  - `staff-schedule.policy.spec.ts` — `it.each` com ADMIN, gestor de Produção, gestor de Logística, operador sem setor gerenciado:
    - `canViewSchedule`;
    - `canEditPerson` (pessoa de Produção, de Logística, sem setor);
    - `canAssignSector` (Produção ativa, Logística ativa, setor inativo para ADMIN → false).
  - `staff-schedule.service.spec.ts` (repo mockado; `vi.setSystemTime(new Date('2026-10-22T01:00:00Z'))`):
    - "options: today '2026-10-21'; ADMIN vê todos os setores ativos; gestor só os que gerencia";
    - "options/board de quem não é ADMIN nem gestor → 403 staff_schedule.forbidden";
    - "board de setor que o gestor não gerencia → 403";
    - `it.each` "período inválido → 422 staff_schedule.invalid_period" (from > to; 43 dias);
    - "board: linhas do setor principal por nome com jobTitle, depois 'de outro setor'; canEdit false para quem vem de fora quando o ator é o gestor do destino";
    - "board: célula de Maria com VACATION 2026-10-20..2026-10-24 → OFF VACATION com exceptionId; João no rodízio alterna turno e fim de semana OFF" (aceite 2 e 3).
  - `staff-schedule.repository.integration.spec.ts`:
    - "listVisitorIds só traz OTHER_SECTOR para o setor e no período";
    - "loadScheduleData devolve ciclo ordenado por dayIndex e exceções que cruzam o período".
- [ ] **Step 2:** `timeout 600 gate --test src/modules/staff-schedule/staff-schedule.service.spec.ts` → FAIL.
- [ ] **Step 3:** implementar; extrair `findTeamActor` sem mudar o comportamento do `team-whatsapp` (rodar `team-whatsapp.service.spec.ts`).
- [ ] **Step 4 (GREEN):** `timeout 600 gate --test` nos três specs, em `src/modules/team-whatsapp/team-whatsapp.service.spec.ts` e em `src/schemas/openapi-representability.spec.ts` → PASS.
- [ ] **Step 5:** `timeout 600 gate --changed --base origin/main` (cwd `backend/`) → PASS; GC2 à mão.

---

### Task 6: back — Escala: edição do ciclo e das exceções

Depende de: T5.

**Crítico: decide autorização + transação com risco de perda** — quem edita a escala de quem, destino de "Outro setor", e recorte/substituição de exceções anteriores numa transação.

**Files:**
- Create: `backend/src/modules/staff-schedule/exception-overlap.ts` + `exception-overlap.spec.ts`
- Create: `backend/src/modules/staff-schedule/staff-schedule-edit.service.ts` + `staff-schedule-edit.service.spec.ts`
- Create: `backend/src/modules/staff-schedule/dto/put-schedule.dto.ts`, `dto/create-exception.dto.ts`, `dto/staff-schedule-dtos.spec.ts`
- Modify: `staff-schedule.controller.ts`, `staff-schedule.repository.ts`, `staff-schedule.errors.ts`, `staff-schedule.module.ts`
- Modify: `backend/src/schemas/contracts/staff-schedule.schema.ts` (`createStaffExceptionResponseSchema`)
- Modify (teste): `staff-schedule.repository.integration.spec.ts`

**Contexto vinculado:**
- GC8: editar = ADMIN ou gestor que gerencia o setor principal da pessoa; "Outro setor" = ADMIN qualquer setor ativo, gestor só setor que também gerencia; 403 `staff_schedule.forbidden`.
- C5 inteiro (PUT/DELETE schedule; POST exceptions → `{ exception, adjusted }`; DELETE exception; refines por `kind`; até 366 dias; note ≤ 200; erros 404 `user_not_found`/`exception_not_found`, 422 `invalid_shift`/`invalid_sector`).
- C4: `staffScheduleSchema` (`template`, `startDate`, `cycleLength` 1..28, `days` com `length === cycleLength`).
- D4: exceções não se sobrepõem; criar recorta/substitui as anteriores nos dias em comum (inclusive dividindo uma em duas), na transação com `SELECT … FROM "User" WHERE id = $1 FOR UPDATE`; "Remover exceção" remove a exceção inteira.
- D5: o servidor guarda o ciclo como recebido e valida forma e turnos (existe e ativo).
- GC10: auditoria `staff_schedule.put`, `staff_schedule.delete`, `staff_schedule.exception_create` (`{ actorId, userId, adjusted }`), `staff_schedule.exception_delete`; sem nome nem nota.

**Interfaces:**
- Consumes: `StaffScheduleRepository`, `canEditPerson`, `canAssignSector` (T5); `addDays`, `toDbDate` (T3).
- Produces:

```ts
// exception-overlap.ts (puro)
export type DateRange = { startDate: CivilDate; endDate: CivilDate };
export type OverlapPlan = {
  deleteIds: string[];
  updates: { id: string; startDate: CivilDate; endDate: CivilDate }[];
  splits: { fromId: string; startDate: CivilDate; endDate: CivilDate }[]; // cauda nova copiada de fromId
};
export function planOverlap(existing: readonly (DateRange & { id: string })[], incoming: DateRange): OverlapPlan;

// staff-schedule-edit.service.ts
putSchedule(actorId: string, userId: string, input: PutScheduleInput): Promise<StaffSchedule>;
deleteSchedule(actorId: string, userId: string): Promise<void>;
createException(actorId: string, userId: string, input: CreateExceptionInput): Promise<{ exception: StaffException; adjusted: number }>;
deleteException(actorId: string, exceptionId: string): Promise<void>;

// staff-schedule.repository.ts (acréscimos)
findPerson(userId: string): Promise<{ id: string; sectorId: string | null } | null>;
findShiftsActive(ids: readonly string[]): Promise<string[]>;           // ids ativos encontrados
findSector(id: string): Promise<{ id: string; isActive: boolean } | null>;
replaceSchedule(userId: string, data: PutScheduleInput, actorId: string): Promise<StaffSchedule>; // upsert + recria days, numa transação
deleteSchedule(userId: string): Promise<void>;
createExceptionTrimming(userId: string, data: CreateExceptionInput, actorId: string): Promise<{ exception: StaffException; adjusted: number }>;
// transação: FOR UPDATE no User → lê exceções que cruzam [start,end] → planOverlap → aplica → cria
findException(id: string): Promise<{ id: string; userId: string; sectorId: string | null } | null>;
deleteException(id: string): Promise<void>;
```

- Ordem das checagens (todas as rotas): ator (403 se `!canViewSchedule`) → pessoa (404) → `canEditPerson` (403) → turnos (422) → setor de destino: inexistente/inativo → 422 `invalid_sector`, fora de `canAssignSector` → 403. Em `deleteException`, a pessoa é a dona da exceção.

**Steps:**
- [ ] **Step 1 (RED):**
  - `exception-overlap.spec.ts` — `it.each` "recorte de exceções" com existente `21..25`:
    - nova `23..27` → update `21..22`;
    - nova `19..22` → update `23..25`;
    - nova `20..26` → delete;
    - nova `23..23` → update `21..22` + split `24..25`;
    - nova `26..28` → plano vazio;
    - duas existentes `21..22` e `24..25` com nova `22..24` → update das duas.
  - `staff-schedule-edit.service.spec.ts`:
    - `it.each` "gestor não edita pessoa de setor que não gerencia → 403 e nada gravado" (PUT, DELETE schedule, POST exception, DELETE exception);
    - "gestor de Produção manda João para Logística (não gerencia) → 403; ADMIN pode";
    - "OTHER_SECTOR para setor inativo → 422 invalid_sector";
    - `it.each` "turno inexistente ou inativo no ciclo ou na exceção → 422 invalid_shift";
    - "pessoa inexistente → 404 user_not_found";
    - "createException devolve adjusted do repositório e audita sem nota".
  - `dto/staff-schedule-dtos.spec.ts` — `it.each`:
    - `days.length !== cycleLength`; `cycleLength` 0 e 29;
    - `endDate < startDate`; 367 dias;
    - SHIFT_SWAP sem `shiftId`; OTHER_SECTOR sem `sectorId`; DAY_OFF com `shiftId`;
    - note com 201 caracteres.
  - `staff-schedule.repository.integration.spec.ts`:
    - "createExceptionTrimming divide a exceção anterior e devolve adjusted 1";
    - "duas criações concorrentes para a mesma pessoa terminam sem sobreposição" (`Promise.all`, depois conferir que nenhum par cruza);
    - "replaceSchedule troca os dias inteiros".
- [ ] **Step 2:** `timeout 600 gate --test src/modules/staff-schedule/exception-overlap.spec.ts` → FAIL.
- [ ] **Step 3:** implementar (rotas no controller existente; `planOverlap` com ramos curtos para respeitar a GC2).
- [ ] **Step 4 (GREEN):** `timeout 600 gate --test` nos quatro specs → PASS.
- [ ] **Step 5:** `timeout 600 gate --changed --base origin/main` (cwd `backend/`) → PASS; GC2 à mão.

---

### Task 7a: back — foto da escala no envio e grupos na lista de envios

Depende de: T6. Vem antes da T7b: cria as colunas e o `createDispatch` que a 7b usa para gravar a foto.

**Crítico: contrato público** — `GET /internal/team-whatsapp/dispatches` ganha `rosterDate`, `unselected` e `off`; a foto (`roster Json`) não pode levar telefone (GC10). A migração é aditiva. O POST não muda nesta task: envios novos continuam sem foto (`[]`) até a T7b.

**Files:**
- Modify: `backend/prisma/schema.prisma` (`TeamWhatsappDispatch.rosterDate DateTime? @db.Date`, `includeOff Boolean @default(false)`, `roster Json?`)
- Create: `backend/prisma/migrations/20261021120000_team_dispatch_roster/migration.sql`
- Modify: `backend/src/schemas/contracts/team-whatsapp.schema.ts` (`rosterPersonSchema`, `rosterSnapshotSchema`, itens da lista com `rosterDate`/`unselected`/`off`)
- Create: `backend/src/modules/team-whatsapp/team-whatsapp.roster.ts` (nesta task só `parseRosterSnapshot` e `rosterGroups`; a T7b acrescenta a escala do dia)
- Modify: `backend/src/modules/team-whatsapp/team-whatsapp.repository.ts` (`createDispatch` aceita os campos da foto; `listDispatches` os seleciona), `team-whatsapp.service.ts` (só a listagem)
- Modify (teste): `team-whatsapp.service.list.spec.ts`, `team-whatsapp.repository.integration.spec.ts`; `team-whatsapp.test-fixtures.ts` só se precisar; `src/modules/shifts/shift-migration.integration.spec.ts` só roda (drift)

**Contexto vinculado:**
- GC3: nunca `migrate reset`; DDL gerado sem banco (`migrate diff --from-schema-datamodel … --to-schema-datamodel … --script`); `migrate deploy` só contra o testcontainers.
- GC4: esta task cria só `20261021120000_team_dispatch_roster` (aditiva); rodar de novo o drift (aceito: vazio ou exatamente `DROP TABLE "_message_dup_neutralized_20260819";`).
- C8 (parte T7a): `rosterDate: CivilDate | null`; `unselected` = escalados no filtro que não são destinatários; `off` = de folga que não são destinatários; `RosterPerson = { userId: string | null, name, jobTitle: string | null, shiftName: string | null, reason: 'DAY_OFF' | 'VACATION' | null }` (tipo TS `TeamRosterPerson`); envio sem foto → `[]`; nenhum campo de telefone.
- C10: dispatch guarda `rosterDate` (`@db.Date`), `includeOff` (padrão `false`) e `roster Json { working, off }` (working = todos os escalados no filtro, marcados ou não; off = de folga/férias do setor principal); quem grava no POST é a T7b.
- GC5: `rosterDate` só por `toDbDate`/`fromDbDate` (T3); na API, `'YYYY-MM-DD'`.
- GC10: telefone nunca vai para a foto nem para a listagem.

**Interfaces:**
- Consumes: `toDbDate`/`fromDbDate`, `CivilDate` (T3); `civilDateSchema` (T3).
- Produces:

```ts
// team-whatsapp.schema.ts
export const rosterPersonSchema = z.object({ userId: z.string().nullable(), name: z.string(), jobTitle: z.string().nullable(), shiftName: z.string().nullable(), reason: z.enum(['DAY_OFF', 'VACATION']).nullable() });
export const rosterSnapshotSchema = z.object({ working: rosterPersonSchema.array(), off: rosterPersonSchema.array() });
export type TeamRosterPerson = z.infer<typeof rosterPersonSchema>;
// item da lista ganha: rosterDate: civilDateSchema.nullable(), unselected: rosterPersonSchema.array(), off: rosterPersonSchema.array()

// team-whatsapp.roster.ts
export type RosterSnapshot = z.infer<typeof rosterSnapshotSchema>;
export function parseRosterSnapshot(json: unknown): RosterSnapshot | null;   // safeParse; null ou fora do formato → null
export function rosterGroups(snapshot: RosterSnapshot | null, recipientUserIds: ReadonlySet<string>):
  { unselected: TeamRosterPerson[]; off: TeamRosterPerson[] };               // null → [] e []

// team-whatsapp.repository.ts
// createDispatch(input) aceita rosterDate?: CivilDate | null (grava por toDbDate), includeOff?: boolean, roster?: RosterSnapshot | null; ausentes = null / false / null
// listDispatches seleciona rosterDate, includeOff, roster
```

**Steps:**
- [ ] **Step 1 (RED):**
  - `team-whatsapp.service.list.spec.ts`:
    - "unselected = foto.working − destinatários; off = foto.off − destinatários";
    - `it.each` "envio sem foto ou com foto fora do formato → unselected e off vazios";
    - "rosterDate em 'YYYY-MM-DD'";
    - "nenhuma chave de telefone em unselected/off".
  - `team-whatsapp.repository.integration.spec.ts`: "createDispatch grava rosterDate, includeOff e roster; listDispatches devolve"; "createDispatch sem os campos novos grava rosterDate null, includeOff false e roster null".
- [ ] **Step 2:** `timeout 600 gate --test src/modules/team-whatsapp/team-whatsapp.service.list.spec.ts` → FAIL.
- [ ] **Step 3:** implementar schema + migração aditiva (DDL gerado sem banco), contrato, `team-whatsapp.roster.ts`, repository e listagem no service. `bun run prisma generate`.
- [ ] **Step 4 (GREEN):** `timeout 600 gate --test` em `team-whatsapp.service.list.spec.ts`, `team-whatsapp.repository.integration.spec.ts`, `team-whatsapp.service.spec.ts` e `src/modules/shifts/shift-migration.integration.spec.ts` (drift) → PASS.
- [ ] **Step 5:** `timeout 600 gate --changed --base origin/main` (cwd `backend/`) → PASS; GC2 à mão.

---

### Task 7b: back — envio por data: `targets`, escala do dia (`roster`) e POST validado pela escala

Depende de: T7a.

**Crítico: decide autorização (filtro de quem recebe) + contrato público** — o POST passa a validar a seleção contra a escala da data refeita no servidor e ganha `date`/`includeOff`; `targets` muda de forma e `roster` é novo. Sem migração.

**Files:**
- Modify: `backend/src/schemas/contracts/team-whatsapp.schema.ts` (targets novo, `teamRosterResponseSchema`)
- Modify: `backend/src/modules/team-whatsapp/dto/create-team-dispatch.dto.ts` (+ spec do DTO); Create: `dto/roster-query.dto.ts`
- Modify: `team-whatsapp.module.ts` (importa `StaffScheduleModule`), `team-whatsapp.controller.ts` (`GET roster`), `team-whatsapp.selection.ts`, `team-whatsapp.repository.ts`, `team-whatsapp.service.ts`
- Modify: `backend/src/modules/team-whatsapp/team-whatsapp.roster.ts` (T7a; acrescenta a montagem pura da escala do dia e da foto)
- Create (teste): `team-whatsapp.selection.spec.ts`, `team-whatsapp.service.roster.spec.ts` (substitui `team-whatsapp.service.shift.spec.ts`, que é apagado)
- Modify (teste): `team-whatsapp.test-fixtures.ts`, `team-whatsapp.repository.integration.spec.ts`

**Contexto vinculado:**
- GC4: esta task não cria migração nem mexe em `schema.prisma`.
- D12: relação `workShift`/FK `shiftId` em User e destinatário; consultas filtram por `shiftId`.
- GC7: 403 `team_whatsapp.forbidden` antes de qualquer checagem de escala/seleção.
- GC9: o servidor refaz a escala da data no POST; id fora (outro turno, de folga sem `includeOff`, outro setor no dia, sem escala, inativo, inexistente) → 422 `team_whatsapp.invalid_selection` e nada criado.
- C3: exceção vence; ciclo `(date − startDate) mod cycleLength`; sem escala → turno do cadastro; senão `NONE`.
- C6 inteiro (targets `{ today, inProgress, shifts, channels, sectors: { id, name, code }[] }`; roster `{ sectorId, date, shiftStarts, members }` com a regra de quem entra).
- C7 (parte T7b): alvo setor ganha `date` obrigatório e `includeOff?` só sem `shiftId`.
- C8 (feito na T7a): a foto gravada aqui aparece na lista como `rosterDate`, `unselected`, `off` (`TeamRosterPerson = { userId, name, jobTitle, shiftName, reason }`).
- C10: o POST grava, pelo `createDispatch` da T7a, `rosterDate`, `includeOff`, `roster { working, off }` (working = todos os escalados no filtro, marcados ou não; off = de folga/férias do setor principal); recipient `shiftId/shiftName` = turno do dia, `null` para quem entrou por `includeOff`.
- D2: "Todos os turnos" = todos com WORK neste setor no dia (inclusive quem só tem turno no cadastro), sem `NONE`; `includeOff` acrescenta os OFF do setor principal.
- GC5: `today`/`inProgress` em Manaus; `shiftStarts[].startsAt = zonedStart(date, startTime).toISOString()`; data passada aceita envio imediato.
- GC10: `roster` sem telefone; auditoria sem nomes.
- GC12: rótulo `Produção · Noite · 21/10 · seleção de 2` e `Produção · todos os turnos · 21/10`.

**Interfaces:**
- Consumes: `StaffScheduleRepository.listVisitorIds`/`loadScheduleData` (T5), `resolveDay` (T3), `todayIn`/`timeIn`/`addDays`/`zonedStart`/`formatDayMonth`/`toDbDate` (T3), `shiftRefSchema` (T4), `civilDateSchema` (T3), `daySituationSchema` (T5); `createDispatch` com `rosterDate`/`includeOff`/`roster`, `RosterSnapshot`, `TeamRosterPerson` (T7a).
- Produces:

```ts
// team-whatsapp.selection.ts
export function overnightInProgress(shifts: readonly ShiftRef[], now: Date): { date: CivilDate; shift: ShiftRef } | null;
// primeiro turno ativo (por sortOrder) com endTime <= startTime e timeIn(now) < endTime → date = addDays(todayIn(now), -1)
export function sectorTargetLabel(sectorName: string, shiftName: string | null, date: CivilDate, selectedCount: number | null): string;
export function selectMembers<M extends { id: string }>(eligible: readonly M[], userIds: readonly string[] | undefined): M[] | null; // sem filtro de turno: recebe a lista elegível

// team-whatsapp.roster.ts
export type DayMember = TeamMember & { jobTitle: string | null; fromOtherSector: boolean; situation: DaySituation };
export function dayMembers(input: { sectorId: string; date: CivilDate; people: readonly TeamMemberWithSchedule[] }): DayMember[];
export function eligibleFor(members: readonly DayMember[], filter: { shiftId?: string; includeOff: boolean }): DayMember[];
export function rosterSnapshot(members: readonly DayMember[], filter: { shiftId?: string }, shiftNames: ReadonlyMap<string, string>): RosterSnapshot; // { working: TeamRosterPerson[]; off: TeamRosterPerson[] }

// team-whatsapp.service.ts
targets(actorId: string): Promise<TeamTargetsResponse>;
roster(actorId: string, query: { sectorId: string; date: CivilDate }): Promise<TeamRosterResponse>;
// dispatch(): ramo setor = política → turno (se shiftId) → dayMembers → eligibleFor → selectMembers → classify → createDispatch com rosterDate/includeOff/roster

// team-whatsapp.repository.ts (acréscimos)
listActiveShifts(): Promise<ShiftRef[]>;
listSectors(onlyIds: readonly string[] | null): Promise<{ id: string; name: string; code: string }[]>; // sem members
findMembersForDay(sectorId: string, visitorIds: readonly string[]): Promise<TeamMemberRow[]>;        // ativos do setor + visitantes, com phone, jobTitle, sectorId, shiftId
```

- DTO: `date: civilDateSchema`, `includeOff: z.boolean().optional()`, refine "includeOff só sem shiftId".
- Se `team-whatsapp.service.ts` passar dos limites da GC2, mover o ramo setor para `team-whatsapp.roster.ts`/helper privado.

**Steps:**
- [ ] **Step 1 (RED):**
  - `team-whatsapp.selection.spec.ts`:
    - `it.each` `overnightInProgress` com Noite 22:00–06:00 e Manhã 06:00–14:00: `2026-10-22T06:00:00Z` (02:00) → `{ date: '2026-10-21', shift: Noite }`; `2026-10-22T10:00:00Z` (06:00) → `null`; `2026-10-22T01:00:00Z` (21:00 de 21/10) → `null`;
    - `sectorTargetLabel('Produção', 'Noite', '2026-10-21', 2) === 'Produção · Noite · 21/10 · seleção de 2'`; `sectorTargetLabel('Produção', null, '2026-10-21', null) === 'Produção · todos os turnos · 21/10'`.
  - `team-whatsapp.service.roster.spec.ts` (fixture de Produção):
    - João: ciclo com Noite em 21/10;
    - Maria: VACATION 2026-10-20..2026-10-24;
    - Ana: sem escala, cadastro `shift_first`;
    - Beto: sem escala e sem turno;
    - Caio: de Logística, OTHER_SECTOR Produção + Noite em 21/10;
    - Davi: de Produção, OTHER_SECTOR Logística em 21/10.

    Testes:
    - `describe('targets em Manaus')`: em `2026-10-22T01:00:00Z` → `today '2026-10-21'`, `inProgress null`; em `2026-10-22T06:00:00Z` → `today '2026-10-22'`, `inProgress { date: '2026-10-21', shift: { name: 'Noite', … } }`; `shifts` só ativos por sortOrder; `sectors` sem `members`.
    - `describe('roster por data')`: `2026-10-21` → membros João, Maria, Ana, Beto, Caio (`fromOtherSector: true`), sem Davi; situações conforme C3; `shiftStarts` da Noite `'2026-10-22T02:00:00.000Z'`; gestor de Logística pedindo Produção → 403.
    - `describe('seleção fora da escala da data → 422 sem efeito')` — `it.each`:
      - Noite + `[ana]`;
      - Noite + `[maria]`;
      - todos sem includeOff + `[maria]`;
      - todos + `[davi]`;
      - todos + `[beto]`;
      - id inexistente.

      Em todos: `createDispatch`, `queue.addBulk` e `audit.log` não chamados.
    - "gestor de Logística com sectorId Produção e userIds [caio] → 403 antes da seleção".
    - `describe('todos os turnos e incluir folga')`:
      - "todos alcança João, Ana e Caio, sem Beto nem Maria";
      - "todos + includeOff acrescenta Maria, destinatária com shiftName null".
    - `describe('foto e rótulo')`: Noite + `[joao]` em 21/10 → `createDispatch` com `targetLabel 'Produção · Noite · 21/10 · seleção de 1'`, `rosterDate '2026-10-21'`, `includeOff false`, `roster.working` = João e Caio com `jobTitle` e `shiftName 'Noite'`, `roster.off` = Maria com `reason 'VACATION'`; nenhuma chave de telefone na foto. O mesmo caso fixa o snapshot do turno do filtro: `shiftId`, `shiftName 'Noite'`, `shiftStartTime '22:00'`, `shiftEndTime '06:00'`.
    - Herdados do `team-whatsapp.service.shift.spec.ts` apagado (re-revisão do plano): "shiftId inexistente ou inativo → 422 `team_whatsapp.invalid_shift`, sem `createDispatch`" (`it.each` com os dois casos).
  - DTO spec: "includeOff com shiftId → falha"; "date '2026-02-30' → falha"; "alvo setor sem date → falha".
  - `team-whatsapp.repository.integration.spec.ts`: "findMembersForDay traz os ativos do setor e os visitantes pedidos, sem inativos".
- [ ] **Step 2:** `timeout 600 gate --test src/modules/team-whatsapp/team-whatsapp.service.roster.spec.ts` → FAIL.
- [ ] **Step 3:** implementar contratos, DTOs, controller (`GET roster`), módulo, selection, roster, repository, service; apagar `team-whatsapp.service.shift.spec.ts`. Sem `prisma generate` (schema não muda).
- [ ] **Step 4 (GREEN):** `timeout 600 gate --test` em `team-whatsapp.selection.spec.ts`, `team-whatsapp.service.roster.spec.ts`, `team-whatsapp.service.list.spec.ts` (continua verde), `team-whatsapp.service.spec.ts`, spec do DTO e `team-whatsapp.repository.integration.spec.ts` → PASS.
- [ ] **Step 5:** `timeout 600 gate --changed --base origin/main` (cwd `backend/`) → PASS; GC2 à mão.

---

### Task 8: back — agendar no início do turno, cancelar e lista de agendados

Depende de: T7b.

**Crítico: concorrência + decide autorização + contrato público** — cancelamento com `updateMany` condicional (disputa com o disparo da T9), cancelamento por `canSendToSector`, rotas e campos novos.

Tamanho (M5): ~15 arquivos mantidos numa task — a migração é aditiva e todo o código daqui depende dos campos dela; separá-la criaria uma task sem comportamento e deixaria esta com ~13 arquivos, e o ponto de concorrência do disparo já está isolado na T9.

**Files:**
- Modify: `backend/prisma/schema.prisma` (enum `TeamWhatsappDispatchState { DISPATCHED SCHEDULED CANCELLED }`; dispatch `state @default(DISPATCHED)`, `scheduledFor DateTime?`, `firedAt DateTime?`, `cancelledAt DateTime?`, `cancelledById String?`, `@@index([state, scheduledFor])`; `TeamWhatsappRecipientStatus` + `SCHEDULED`, `CANCELLED`; `TeamWhatsappSkipReason` + `INACTIVE`)
- Create: `backend/prisma/migrations/20261021130000_team_dispatch_schedule/migration.sql`
- Modify: `backend/src/schemas/contracts/team-whatsapp.schema.ts` (resposta do POST, `teamScheduledListResponseSchema`, `cancelTeamDispatchResponseSchema`, campos da lista)
- Modify: `dto/create-team-dispatch.dto.ts` (+ spec), `team-whatsapp.errors.ts`, `team-whatsapp.repository.ts`, `team-whatsapp.service.ts`, `team-whatsapp.controller.ts`, `team-whatsapp.module.ts`
- Create: `backend/src/modules/team-whatsapp/team-whatsapp-schedule.service.ts` (`cancel`, `listScheduled`; a T9 acrescenta o disparo)
- Create (teste): `team-whatsapp.service.schedule.spec.ts`
- Modify (teste): `team-whatsapp.service.list.spec.ts`; `backend/src/modules/shifts/shifts.repository.ts` + `shifts.repository.integration.spec.ts` (motivo `scheduled`)

**Contexto vinculado:**
- Spec §6: "No início do turno" só com turno específico; hora = data escolhida + início do turno em Manaus; hora passada → 422 `team_whatsapp.schedule_in_past`; a lista conferida fica congelada; cancelado não dispara; cancela quem pode enviar para o setor.
- C7 (parte T8): `when?: 'now' | 'shift_start'` (padrão `'now'`), `'shift_start'` exige alvo setor com `shiftId`; resposta `{ dispatchId, queued, scheduled, scheduledFor, skipped }`.
- C8 (parte T8): `state`, `scheduledFor`, `firedAt`; `counts.scheduled`/`counts.cancelled`; status `SCHEDULED`/`CANCELLED`; skip `INACTIVE`.
- C9 inteiro (GET scheduled: só `SCHEDULED`, `scheduledFor` asc, ADMIN todos, gestor setores que gerencia; POST cancel → `{ id, state: 'CANCELLED' }`; 404/403/409).
- C1: `inUse` ganha `scheduled` = envios `state = SCHEDULED` com o `shiftId`.
- D7: agendar aplica o mesmo `requireChannel` do envio imediato.
- D9: sem telefone/suprimido → `SKIPPED` no agendamento; resto `SCHEDULED`; nenhum `SCHEDULED` → 422 `no_recipients`.
- GC9: agendar valida a seleção como o envio imediato (422 sem efeito).
- GC5: `scheduledFor = zonedStart(date, shift.startTime)`; `scheduledFor <= now` = passado.

**Interfaces:**
- Consumes: ramo setor do `dispatch` (T7b), `zonedStart` (T3), `canSendToSector`.
- Produces:

```ts
// team-whatsapp.errors.ts
scheduleInPast(): DomainError;    // 422 'team_whatsapp.schedule_in_past'
dispatchNotFound(): DomainError;  // 404 'team_whatsapp.dispatch_not_found'
notCancellable(): DomainError;    // 409 'team_whatsapp.not_cancellable'

// team-whatsapp-schedule.service.ts
cancel(actorId: string, dispatchId: string): Promise<{ id: string; state: 'CANCELLED' }>;
listScheduled(actorId: string): Promise<TeamScheduledListResponse>;

// team-whatsapp.repository.ts (acréscimos)
findDispatchForCancel(id: string): Promise<{ id: string; targetType: TeamWhatsappTargetType; targetId: string; state: TeamWhatsappDispatchState } | null>;
cancelScheduled(id: string, actorId: string, now: Date): Promise<boolean>;
// $transaction: updateMany({ where: { id, state: 'SCHEDULED' }, data: { state: 'CANCELLED', cancelledAt: now, cancelledById: actorId } });
// count 0 → false; senão recipients SCHEDULED → CANCELLED
listScheduled(onlySectorIds: readonly string[] | null): Promise<ScheduledRow[]>;
// createDispatch aceita { state: 'SCHEDULED', scheduledFor } e recipients com status SCHEDULED

// shifts.repository.ts usage(): acrescenta kind 'scheduled'
```

- Controller: `GET scheduled`, `POST dispatches/:id/cancel` (200), mesmos `@Roles` do controller.
- Auditoria: `team_whatsapp.schedule` (`{ actorId, dispatchId, scheduled, skipped }`) e `team_whatsapp.cancel` (`{ actorId, dispatchId }`).

**Steps:**
- [ ] **Step 1 (RED) — `team-whatsapp.service.schedule.spec.ts`:**
  - "agendar Noite de 21/10 às 16:00 de Manaus" (`vi.setSystemTime(new Date('2026-10-21T20:00:00Z'))`) → `createDispatch` com `state 'SCHEDULED'`, `scheduledFor 2026-10-22T02:00:00.000Z`, destinatários `SCHEDULED`; `queue.addBulk` não chamado; resposta `{ queued: 0, scheduled: N, scheduledFor: '2026-10-22T02:00:00.000Z' }`.
  - `it.each` "início já passou → 422 schedule_in_past sem efeito": 1º turno de 21/10 às `2026-10-21T10:00:00Z` (igual) e às `2026-10-21T12:00:00Z`; às `2026-10-21T09:59:00Z` → aceita com `scheduledFor '2026-10-21T10:00:00.000Z'`.
  - "agendar com seleção fora da escala → 422 invalid_selection sem efeito".
  - "sem telefone fica SKIPPED NO_PHONE no agendamento".
  - "cancelar: ADMIN → state CANCELLED, auditoria" (`cancelScheduled` true).
  - "cancelar: gestor de outro setor → 403".
  - "cancelar já disparado ou cancelado → 409 not_cancellable" (`cancelScheduled` false).
  - "cancelar inexistente → 404".
  - "listScheduled: ADMIN vê todos; gestor só setores que gerencia; shift vem do snapshot (startTime gravado), não do Shift atual".
- [ ] **Step 2 (RED) — demais testes:**
  - DTO spec: "when shift_start sem shiftId → falha"; "when shift_start com alvo pessoa → falha".
  - `team-whatsapp.service.list.spec.ts`: "state/scheduledFor/firedAt e counts scheduled/cancelled".
  - `shifts.repository.integration.spec.ts`: "envio agendado pendente conta como scheduled; cancelado não conta".
- [ ] **Step 3:** `timeout 600 gate --test src/modules/team-whatsapp/team-whatsapp.service.schedule.spec.ts` → FAIL.
- [ ] **Step 4:** implementar schema + migração (gerar sem banco; `ALTER TYPE … ADD VALUE` como o Prisma gerar), contratos, DTO, erros, repository, services, controller; motivo `scheduled` em `shifts.repository.ts`. `bun run prisma generate`.
- [ ] **Step 5 (GREEN):** `timeout 600 gate --test` em `team-whatsapp.service.schedule.spec.ts`, `team-whatsapp.service.list.spec.ts`, spec do DTO, `src/modules/shifts/shifts.repository.integration.spec.ts` e `src/modules/shifts/shift-migration.integration.spec.ts` (drift) → PASS.
- [ ] **Step 6:** `timeout 600 gate --changed --base origin/main` (cwd `backend/`) → PASS; GC2 à mão.

---

### Task 9: back — disparo agendado no worker (tick idempotente)

Depende de: T8.

**Crítico: concorrência** — o claim por `updateMany` condicional garante que dois ticks ou um cancelamento concorrente não façam o envio sair duas vezes nem depois de cancelado.

**Files:**
- Modify: `backend/src/modules/queue/queue.constants.ts` (`QUEUE_NAMES.TEAM_WHATSAPP_SCHEDULER = 'team-whatsapp.scheduler'`)
- Modify: `backend/src/modules/queue/queue.module.ts` (registrar a fila com os `defaultJobOptions` do scheduler de campanhas)
- Modify: `backend/src/worker.ts` (tick repetível) e `backend/src/worker.module.ts` (processor)
- Create: `backend/src/modules/team-whatsapp/team-whatsapp-scheduler.processor.ts` + `.spec.ts`
- Modify: `team-whatsapp-schedule.service.ts` (`fireDue`, `fireOne`), `team-whatsapp.repository.ts` (`findDueScheduled`, `claimScheduled`)
- Create (teste): `backend/src/modules/team-whatsapp/team-whatsapp.schedule.integration.spec.ts`

**Contexto vinculado:**
- GC6: job repetível no padrão do `CAMPAIGN_SCHEDULER` (`worker.ts:179-195`): `add('tick', {}, { repeat: { pattern: '* * * * *' }, jobId: 'team-whatsapp-scheduler-tick', ...REPEATABLE_JOB_CLEANUP_OPTS })` dentro de try/catch com log; processor `concurrency: 1`; cada tick em CLS com correlationId `team-sched-<uuid>`, como `scheduler.processor.ts`.
- Spec §6: atraso aceitável ~1 min; worker fora no horário → sai quando ele voltar, histórico mostra a hora real (`firedAt`); canal inexistente/inativo na hora → cada destinatário `FAILED` "Canal indisponível na hora do envio", sem trocar de canal; canal só desconectado segue o processor de hoje.
- C10: `errorCode = 'team_whatsapp.channel_unavailable'`; inativo/apagado → `SKIPPED` `INACTIVE` (D8).
- Fila de envio de hoje: `addBulk` com name `'send'`, data `{ recipientId }`, opts `{ jobId: recipientId }`; erro → `markFailed(ids, 'team_whatsapp.queue_unavailable')` e relança; o processor sai se o status ≠ `QUEUED`.
- GC10: auditoria `team_whatsapp.scheduled_fire` com `{ dispatchId, queued, skipped, failed }`, sem nomes.

**Interfaces:**
- Consumes: `cancelScheduled` (T8), `enqueue` do `TeamWhatsappService` (extrair para helper compartilhado se necessário, sem mudar o comportamento).
- Produces:

```ts
// team-whatsapp.repository.ts
findDueScheduled(now: Date, take: number): Promise<{ id: string }[]>; // state SCHEDULED, scheduledFor <= now, orderBy scheduledFor, take 50
claimScheduled(id: string, now: Date): Promise<ClaimResult | null>;
// $transaction: updateMany({ where: { id, state: 'SCHEDULED', scheduledFor: { lte: now } }, data: { state: 'DISPATCHED', firedAt: now } });
// count 0 → null. Senão, na mesma transação: canal inválido → recipients SCHEDULED → FAILED channel_unavailable;
// senão inativos/apagados → SKIPPED INACTIVE e o resto → QUEUED. Devolve { queuedIds, skipped, failed }.

// team-whatsapp-schedule.service.ts
fireDue(now: Date): Promise<{ fired: number }>;                  // erro de um envio não para os outros (log com dispatchId)
fireOne(dispatchId: string, now: Date): Promise<'fired' | 'skipped'>;

// team-whatsapp-scheduler.processor.ts
@Processor(QUEUE_NAMES.TEAM_WHATSAPP_SCHEDULER, { concurrency: 1 })
export class TeamWhatsappSchedulerProcessor extends WorkerHost { process(job: Job): Promise<void> } // fireDue(new Date())
```

**Steps:**
- [ ] **Step 1 (RED) — `team-whatsapp.schedule.integration.spec.ts`** (testcontainers; service real com repository real; fila e auditoria mockadas; helper `seedScheduled({ prisma, scheduledFor, recipients })` com objeto):
  - `describe('disparo idempotente')`:
    - "dois disparos concorrentes: um só enfileira" (`Promise.all([fireOne(id, now), fireOne(id, now)])` → `['fired', 'skipped']` em qualquer ordem; `addBulk` uma vez com os 3 `recipientId`);
    - "cancelado não dispara" (cancel e depois `fireOne` → `'skipped'`, `addBulk` não chamado, destinatários `CANCELLED`);
    - "disparado não cancela" (`fireOne` e depois cancel → 409 `not_cancellable`);
    - "cancelar e disparar concorrentes: estado final coerente" (20 rodadas de `Promise.allSettled([fireOne, cancel])`; em cada uma, exatamente um vence; `CANCELLED` ⇒ todos os destinatários `CANCELLED` e nenhum job; `DISPATCHED` ⇒ nenhum `CANCELLED`).
  - `describe('hora do disparo')`:
    - "antes da hora não dispara" (`scheduledFor = now + 1 min` → `'skipped'`);
    - "worker fora: vencido há 3 h dispara no próximo tick com firedAt = now".
  - `describe('condições na hora')`:
    - "canal inativo → FAILED team_whatsapp.channel_unavailable e nenhum job";
    - "usuário inativo → SKIPPED INACTIVE; os outros enfileirados".
- [ ] **Step 2 (RED) — `team-whatsapp-scheduler.processor.spec.ts`:** "tick chama fireDue com o relógio atual"; "erro num envio não impede os outros" (via `fireDue` com dois ids, o primeiro lança).
- [ ] **Step 3:** `timeout 600 gate --test src/modules/team-whatsapp/team-whatsapp.schedule.integration.spec.ts` → FAIL.
- [ ] **Step 4:** implementar fila, tick no `worker.ts` (bloco novo logo após o do campaign scheduler, log `'Scheduled team WhatsApp scheduler tick (every minute)'`), processor, service e repository.
- [ ] **Step 5 (GREEN):** os dois specs → PASS; `timeout 600 gate --test src/modules/queue/scheduler.processor.spec.ts` continua PASS.
- [ ] **Step 6:** `timeout 600 gate --changed --base origin/main` (cwd `backend/`) → PASS; GC2 à mão.

---

### Task 10: front — tela Turnos e item de menu

Depende de: T4. Risco: médio (tela ADMIN; a regra fica no servidor).

**Files:**
- Create: `frontend/src/features/shifts/schemas.ts`, `api.ts`, `in-use.ts` + `in-use.spec.ts`, `labels.ts` (`NO_SHIFT_LABEL = 'Sem turno'`), `error-messages.ts`
- Create: `frontend/src/features/shifts/components/shift-form-dialog.tsx`
- Create: `frontend/src/routes/_authenticated/turnos/index.tsx` + `index.spec.tsx`
- Modify: `frontend/src/lib/nav.ts` (+ spec de navegação, se existir)

**Contexto vinculado:**
- C1: `GET/POST /internal/shifts`, `PATCH /internal/shifts/:id`, `PUT /internal/shifts/order`; `ShiftAdmin = { id, name, startTime, endTime, isActive, sortOrder, crossesMidnight, inUse: { kind: 'users'|'schedules'|'exceptions'|'scheduled', count }[] }`; erros `shifts.name_taken`, `shifts.in_use`, `shifts.invalid_order`, `shifts.not_found`.
- GC11: o front espelha o contrato à mão em `features/shifts/schemas.ts`.
- GC12: `Turnos`, `Novo turno`, `Editar`, `Desativar`, `Reativar`, `Subir`, `Descer`, `atravessa a meia-noite`.
- GC14: rota nova `/turnos` em `src/routes/_authenticated/`; sem componente novo em `components/ui/` (horário com `<Input type="time">`).
- D10: `Turnos` na seção `admin`, logo depois de "Setores", `roles: ['ADMIN']`.
- Spec §1: só ADMIN; turno em uso não desativa e a tela diz onde está em uso.

**Interfaces:**
- Produces:

```ts
// features/shifts/schemas.ts
export const shiftRefSchema; export const shiftUsageKindSchema; export const shiftAdminSchema; export const shiftListSchema;
export type ShiftRef; export type ShiftAdmin;
// features/shifts/api.ts
export function useShifts(): UseQueryResult<ShiftAdmin[]>;                 // key ['shifts']
export function useCreateShift(); export function useUpdateShift(); export function useReorderShifts(); // invalidam ['shifts']
// features/shifts/in-use.ts
export function inUseText(inUse: ShiftAdmin['inUse']): string | null;
```

- Textos por motivo: `users` → `N pessoa(s) com este turno no cadastro`; `schedules` → `N escala(s)`; `exceptions` → `N exceção(ões) de hoje em diante`; `scheduled` → `N envio(s) agendado(s)`; frase `Em uso: ` + itens separados por `, `.
- Mensagens: `shifts.name_taken` → `Já existe um turno com esse nome.`; `shifts.in_use` → `Este turno está em uso e não pode ser desativado.`.

**Steps:**
- [ ] **Step 1 (RED):**
  - `in-use.spec.ts`: `inUseText([{ kind: 'users', count: 3 }, { kind: 'scheduled', count: 1 }]) === 'Em uso: 3 pessoa(s) com este turno no cadastro, 1 envio(s) agendado(s)'`; `inUseText([]) === null`.
  - `turnos/index.spec.tsx`:
    - "lista na ordem com '22:00–06:00' e o selo 'atravessa a meia-noite'";
    - "Novo turno envia { name: 'Noite', startTime: '22:00', endTime: '06:00' }";
    - "Desativar fica desabilitado e mostra o texto de em uso";
    - "Reativar envia { isActive: true }";
    - "Subir no 2º turno envia PUT order com [shift_second, shift_first]";
    - "409 shifts.name_taken mostra 'Já existe um turno com esse nome.'";
    - "não ADMIN não vê a tela" (mesma guarda de `routes/_authenticated/setores/`).
  - Navegação: "Turnos só para ADMIN, na seção admin logo após Setores".
- [ ] **Step 2:** `timeout 600 gate --test src/routes/_authenticated/turnos/index.spec.tsx` (cwd `frontend/`) → FAIL.
- [ ] **Step 3:** implementar seguindo `routes/_authenticated/setores/` e `features/team-whatsapp/api.ts`.
- [ ] **Step 4 (GREEN):** os specs → PASS.
- [ ] **Step 5:** `timeout 600 gate --changed --base origin/main` (cwd `frontend/`) → PASS; GC2 à mão.

---

### Task 11: front — Usuários com turno da API e função

Depende de: T10 (e T1/T3 no back). Risco: médio.

**Files:**
- Modify: `frontend/src/features/users/schemas.ts`, `edit-user-payload.ts` (+ spec), `components/shift-select.tsx`, `components/invite-user-dialog.tsx`, `components/edit-user-dialog.tsx`
- Modify: `frontend/src/routes/_authenticated/users/index.tsx` (+ `index.spec.tsx`)
- Modify (teste): specs dos diálogos de usuário existentes

**Contexto vinculado:**
- C2: `userSummary.shiftId: string | null`, `jobTitle: string | null`; POST `shiftId?`/`jobTitle?`; PATCH ausente mantém, `null` limpa; `jobTitle` ≤ 80, vazio vira `null`; 422 `users.invalid_shift`.
- Spec §1: o select de turno lista só turnos **ativos**; a tabela mostra o nome do turno mesmo inativo. Spec §8: "Função" nos diálogos "Cadastrar usuário"/"Editar usuário" e coluna na tabela.
- GC11: espelhar em `features/users/schemas.ts`; deixar de importar `lib/work-shift.ts` (o arquivo é apagado na T14).
- GC12: `Sem turno` (de `features/shifts/labels.ts`).

**Interfaces:**
- Consumes: `useShifts`, `ShiftAdmin`, `NO_SHIFT_LABEL` (T10).
- Produces: `ShiftSelect({ value: string | null, onChange, shifts: readonly ShiftRef[] })` (sentinela `'none'` = `null`, só ativos); `buildEditUserPayload` envia `shiftId` e `jobTitle` só quando mudam.

**Steps:**
- [ ] **Step 1 (RED):**
  - `edit-user-payload.spec`: "shiftId só quando muda"; "jobTitle só quando muda; '' vira null".
  - `users/index.spec.tsx`:
    - "coluna Turno mostra o nome vindo de useShifts, inclusive de turno inativo, e 'Sem turno'";
    - "coluna Função".
  - Specs dos diálogos:
    - "ShiftSelect lista só turnos ativos";
    - "Cadastrar com Função 'Operador de empilhadeira' envia jobTitle";
    - "Função com 81 caracteres mostra erro e não envia";
    - "422 users.invalid_shift mostra 'Turno inválido. Atualize a página.'".
- [ ] **Step 2:** `timeout 600 gate --test src/routes/_authenticated/users/index.spec.tsx` → FAIL.
- [ ] **Step 3:** implementar.
- [ ] **Step 4 (GREEN):** specs → PASS.
- [ ] **Step 5:** `timeout 600 gate --changed --base origin/main` (cwd `frontend/`) → PASS; GC2 à mão.

---

### Task 12: front — Escala: quadro, exceções e menu

Depende de: T6 e T10 (`nav.ts`). Risco: médio.

**Files:**
- Create: `frontend/src/lib/civil-date.ts` + `civil-date.spec.ts`
- Create: `frontend/src/features/staff-schedule/schemas.ts`, `api.ts`, `board-cells.ts` + `board-cells.spec.ts`, `error-messages.ts`
- Create: `frontend/src/features/staff-schedule/components/schedule-board.tsx`, `components/exception-dialog.tsx` + `exception-dialog.spec.tsx`
- Create: `frontend/src/routes/_authenticated/escala/index.tsx` + `index.spec.tsx`
- Modify: `frontend/src/lib/nav.ts`

**Contexto vinculado:**
- C4 (options `{ today, sectors, shifts }`; board `{ …, rows: BoardRow[], exceptions }`; `BoardRow = { userId, name, jobTitle, fromOtherSector, canEdit, profileShiftId, schedule, days: { date, situation, exceptionId }[] }`) e C5 (POST exceptions → `{ exception, adjusted }`; DELETE exception; erros `staff_schedule.*`).
- C3: `situation` WORK/OFF/NONE.
- Spec §3: a exceção pode levar uma observação opcional; C5: `note?` com trim, ≤ 200 caracteres.
- Spec §4: setor alcançado só por um já vem escolhido; semana ou mês com navegação; uma linha por pessoa ativa do setor com nome e função; abaixo, separadas e marcadas `de outro setor`; célula com nome do turno, `Folga`, `Férias` ou vazio; clicar abre folga/férias/troca/outro setor para o dia ou período e "Remover exceção".
- GC5: o front não faz conta de fuso; `today` vem de `options`; `lib/civil-date.ts` só faz aritmética de calendário em `'YYYY-MM-DD'` (via `Date.UTC`).
- GC8: a tela só esconde ações (`canEdit`); o servidor decide.
- GC12: `Escala`, `Semana`, `Mês`, `de outro setor`, `Folga`, `Férias`, `Troca de turno`, `Outro setor`, `Observação`, `Remover exceção`, `Em <setor>`; aviso de recorte `N exceção(ões) anterior(es) foram recortadas ou substituídas nesses dias.`
- D6: célula mostra `name` do turno, truncado, com `title`.
- D10: `Escala` na seção `ops`, logo depois de "WhatsApp da equipe", `roles: WRITE_INTERNAL_ROLES`.

**Interfaces:**
- Produces:

```ts
// lib/civil-date.ts
export function addDays(date: string, days: number): string;
export function isoWeekday(date: string): number;                        // 1 = segunda … 7 = domingo (T13 usa no editor)
export function mondayOf(date: string): string;
export function weekRange(date: string): { from: string; to: string };   // segunda..domingo
export function monthRange(date: string): { from: string; to: string };
export function daysBetween(from: string, to: string): string[];
export function formatDayMonth(date: string): string;                    // '21/10'
// features/staff-schedule/board-cells.ts
export function cellLabel(input: { situation: DaySituation; sectorId: string; shiftNames: ReadonlyMap<string, string>; sectorNames: ReadonlyMap<string, string> }): string;
// features/staff-schedule/api.ts
export function useScheduleOptions(); export function useScheduleBoard(q: { sectorId: string; from: string; to: string } | null);
export function useCreateException(); export function useDeleteException(); // invalidam ['staff-schedule','board']
```

- Diálogo de exceção: campo opcional `Observação` (`<Input>`, sem componente novo); valor com trim; vazio não envia `note`; mais de 200 caracteres mostra `A observação pode ter até 200 caracteres.` e não envia.

**Steps:**
- [ ] **Step 1 (RED):**
  - `civil-date.spec.ts`: `addDays('2026-12-31', 1) === '2027-01-01'`; `isoWeekday('2026-10-26') === 1`; `isoWeekday('2026-10-25') === 7`; `mondayOf('2026-11-01') === '2026-10-26'`; `weekRange('2026-10-21')` = `{ from: '2026-10-19', to: '2026-10-25' }`; `monthRange('2026-10-21')` = `{ from: '2026-10-01', to: '2026-10-31' }`; `formatDayMonth('2026-10-21') === '21/10'`.
  - `board-cells.spec.ts` — `it.each`: WORK `noite` neste setor → `'Noite'`; OFF DAY_OFF → `'Folga'`; OFF VACATION → `'Férias'`; NONE → `''`; WORK em Logística → `'Em Logística'`.
  - `escala/index.spec.tsx`:
    - "setor único já vem escolhido";
    - "linha por pessoa com função; 'de outro setor' separado abaixo";
    - "Semana pede board de 2026-10-19 a 2026-10-25 a partir de today '2026-10-21'; Mês pede 2026-10-01 a 2026-10-31; navegação avança o período";
    - "linha sem canEdit não abre o diálogo".
  - `exception-dialog.spec.tsx`:
    - "Férias de 2026-10-20 a 2026-10-24 envia POST { kind: 'VACATION', startDate: '2026-10-20', endDate: '2026-10-24' }";
    - `it.each` "Observação": `'  troca combinada  '` → POST com `note: 'troca combinada'`; vazia → POST sem `note`; 201 caracteres → mensagem de erro e nenhum POST;
    - "Troca de turno exige turno";
    - "Outro setor lista só options.sectors e exige turno";
    - "adjusted 1 mostra o aviso de recorte";
    - "célula com exceção mostra Remover exceção e chama DELETE";
    - "403 staff_schedule.forbidden mostra 'Você não pode editar a escala desta pessoa.'".
  - Navegação: "Escala na seção ops após WhatsApp da equipe".
- [ ] **Step 2:** `timeout 600 gate --test src/routes/_authenticated/escala/index.spec.tsx` → FAIL.
- [ ] **Step 3:** implementar (quadro com `components/ui/table`; seletor Semana/Mês com `tabs`; período no diálogo com dois `<Input type="date">`).
- [ ] **Step 4 (GREEN):** specs → PASS.
- [ ] **Step 5:** `timeout 600 gate --changed --base origin/main` (cwd `frontend/`) → PASS; GC2 à mão.

---

### Task 13: front — editor de escala com modelos prontos

Depende de: T12. Risco: médio.

**Files:**
- Create: `frontend/src/features/staff-schedule/templates.ts` + `templates.spec.ts`
- Create: `frontend/src/features/staff-schedule/components/schedule-editor-dialog.tsx` + `schedule-editor-dialog.spec.tsx`
- Modify: `frontend/src/features/staff-schedule/api.ts` (`usePutSchedule`, `useDeleteSchedule`), `schemas.ts`
- Modify: `frontend/src/routes/_authenticated/escala/index.tsx` (+ `index.spec.tsx`: botão `Editar escala` na linha)

**Contexto vinculado:**
- Spec §2: no máximo uma escala por pessoa; início, ciclo 1–28, turno ou folga por dia. Semanal: 7 dias, seg–sex num turno, sáb/dom folga, início alinhado à segunda da semana escolhida. Rodízio semanal: 14 dias, semana A seg–sex, semana B seg–sex, fins de semana folga. 12x36: 2 dias, trabalho e folga. Personalizado: tamanho e dias livres.
- C5: `PUT …/users/:userId/schedule` body `{ template, startDate, cycleLength, days }` (`days.length === cycleLength`); `DELETE …/schedule` volta ao turno do cadastro.
- D5: os modelos preenchem no front; depois tudo pode ser editado; `template` grava o último modelo escolhido.
- GC12: `Editar escala`, `Semanal`, `Rodízio semanal`, `12x36`, `Personalizado`; remover com confirmação `A pessoa volta a seguir o turno do cadastro.`
- GC5: `mondayOf` de `lib/civil-date.ts` (calendário, sem fuso).

**Interfaces:**

```ts
// features/staff-schedule/templates.ts
export function weekly(shiftId: string, anyDate: string): StaffSchedule;
export function weeklyRotation(input: { shiftA: string; shiftB: string; anyDate: string }): StaffSchedule;
export function twelve36(shiftId: string, startDate: string): StaffSchedule;
export function custom(cycleLength: number, startDate: string): StaffSchedule;
export function resizeCycle(schedule: StaffSchedule, cycleLength: number): StaffSchedule; // mantém o prefixo, completa com null
```

**Steps:**
- [ ] **Step 1 (RED):**
  - `templates.spec.ts`:
    - `weekly('noite', '2026-10-29')` → `{ template: 'WEEKLY', startDate: '2026-10-26', cycleLength: 7, days: ['noite'×5, null, null] }`;
    - `weeklyRotation({ shiftA: 'manha', shiftB: 'noite', anyDate: '2026-10-29' })` → início `'2026-10-26'`, 14 dias `[manha×5, null, null, noite×5, null, null]`;
    - `twelve36('noite', '2026-10-21')` → `{ template: 'TWELVE_36', startDate: '2026-10-21', cycleLength: 2, days: ['noite', null] }`;
    - `custom(5, '2026-10-21')` → 5 `null`;
    - `resizeCycle` de 7 para 3 e de 2 para 4.
  - `schedule-editor-dialog.spec.tsx`:
    - "abre com a escala existente (modelo, início, ciclo)";
    - "Rodízio semanal com Manhã/Noite preenche 14 dias e Salvar envia PUT com o corpo de weeklyRotation";
    - "editar um dia depois do modelo altera só aquele dia";
    - "Remover escala pede confirmação e chama DELETE";
    - "422 staff_schedule.invalid_shift mostra 'Um dos turnos não está mais disponível. Atualize a página.'".
  - `escala/index.spec.tsx`: "Editar escala só aparece em linha com canEdit".
- [ ] **Step 2:** `timeout 600 gate --test src/features/staff-schedule/templates.spec.ts` → FAIL.
- [ ] **Step 3:** implementar (dias do ciclo como lista de `select` por dia, rotulados `Dia 1 (seg)`…; o dia da semana sai de `isoWeekday` sobre `startDate` + índice).
- [ ] **Step 4 (GREEN):** specs → PASS.
- [ ] **Step 5:** `timeout 600 gate --changed --base origin/main` (cwd `frontend/`) → PASS; GC2 à mão.

---

### Task 14: front — WhatsApp da equipe por data e histórico com três grupos

Depende de: T7b (e, por ela, T7a), T11 e T12 (`lib/civil-date.ts`). Risco: alto (a lista conferida na tela é o que vai no POST; a regra continua no servidor).

Tamanho (M4): ~18 arquivos (10 de código, 6 specs, `lib/work-shift.ts` removido). Mantidos aqui: cada spec testa um arquivo que esta task altera e o `gate --changed` o roda nesta task; tirar o histórico (`recent-dispatches`) não reduz, porque ele já precisa trocar `recipients[].shift` por `shiftName` aqui.

**Files:**
- Modify: `frontend/src/features/team-whatsapp/schemas.ts`, `api.ts` (`useTeamTargets`, `useTeamRoster`), `member-filter.ts` (+ spec), `error-messages.ts`
- Modify: `frontend/src/features/team-whatsapp/components/sector-shift-picker.tsx` (Setor + Data + Turno), `member-selection.tsx` (função, `De folga`, `incluir quem está de folga`), `send-whatsapp-dialog.tsx` (`requestTarget` com `date`, `shiftId`, `includeOff`), `recent-dispatches.tsx` (três grupos, `shiftName`)
- Create: `frontend/src/features/team-whatsapp/components/in-progress-notice.tsx`
- Modify: `frontend/src/routes/_authenticated/whatsapp-equipe/index.tsx` (+ `index.spec.tsx`)
- Delete: `frontend/src/lib/work-shift.ts` (e o spec dele, se existir); conferir por busca que não sobrou import
- Modify (teste): specs de `recent-dispatches`/`member-selection` existentes; `frontend/src/features/team-whatsapp/components/send-whatsapp-dialog.spec.tsx` e `frontend/src/features/team-whatsapp/api.spec.ts` (fixtures e corpo do POST saem de `shift` para `date`/`shiftId`/`includeOff`)

**Contexto vinculado:**
- C6: targets `{ today, inProgress: { date, shift } | null, shifts, channels, sectors }`; roster `{ sectorId, date, shiftStarts, members: { …, jobTitle, fromOtherSector, situation }[] }`.
- C7: alvo setor `{ type: 'sector', sectorId, date, shiftId?, userIds?, includeOff? }`; `includeOff` só sem `shiftId`; 422 `invalid_selection` / `invalid_shift`.
- C8: `target.shift` snapshot, `recipients[].shiftName`, `rosterDate`, `unselected`, `off`.
- Spec §5: Data começa em hoje (Manaus); Turno = turnos ativos + `Todos os turnos`; lista = escalados no setor/data/turno, inclusive de outro setor; abaixo `De folga` e `Sem telefone`, sem checkbox; `incluir quem está de folga` só em `Todos os turnos` e acrescenta os de folga à lista; seleção, `Enviar para todos (N)`, `Enviar para selecionados (M)` e o diálogo com nomes como hoje; aviso de turno da véspera em andamento com atalho que troca data e turno.
- Spec §7: `Ver destinatários` com `Destinatários` (resultado), `Escalados não marcados`, `De folga`; nenhum telefone.
- D2: quem está `NONE` não entra na lista; contador `N pessoa(s) deste setor estão sem escala e sem turno no cadastro — defina em Escala`.
- GC5: sem conta de fuso; a data inicial é `targets.today` (nunca `new Date()`); trocar data/turno/setor limpa a seleção.
- GC12: `Data`, `Todos os turnos`, `De folga`, `Sem telefone`, `incluir quem está de folga`, `A Noite de 21/10 ainda está em andamento`, `Ver esse turno`; `invalid_selection` → `A lista de pessoas mudou. Atualize a página e confira de novo.`; `invalid_shift` → `Este turno não está mais disponível. Atualize a página.`

**Interfaces:**

```ts
// features/team-whatsapp/member-filter.ts
export type ShiftChoice = string | 'ALL';
export function eligibleMembers(members: readonly RosterMember[], choice: ShiftChoice, includeOff: boolean): RosterMember[];
export function offMembers(members: readonly RosterMember[]): RosterMember[];        // OFF e !fromOtherSector
export function noScheduleCount(members: readonly RosterMember[]): number;           // NONE
export function buildSectorTarget(input: { sectorId: string; date: string; choice: ShiftChoice; includeOff: boolean; selectedIds: readonly string[] | null; members: readonly RosterMember[] }): SendTarget;
// features/team-whatsapp/api.ts
export function useTeamRoster(q: { sectorId: string; date: string } | null): UseQueryResult<TeamRoster>; // key ['team-whatsapp','roster',sectorId,date]
```

**Steps:**
- [ ] **Step 1 (RED):**
  - `member-filter.spec`:
    - `it.each` "Noite lista só WORK noite; ALL lista todo WORK; ALL + includeOff acrescenta OFF; turno específico ignora includeOff";
    - "offMembers exclui visitantes";
    - "noScheduleCount conta NONE".
  - `whatsapp-equipe/index.spec.tsx`:
    - "Data começa em targets.today '2026-10-21'";
    - "Turno lista os turnos ativos da API e Todos os turnos";
    - "Noite lista só os escalados na Noite com a função; De folga mostra Maria (Férias)" (aceite 3 e 4);
    - "incluir quem está de folga só aparece em Todos os turnos e põe Maria na lista";
    - "aviso 'A Noite de 21/10 ainda está em andamento' com Ver esse turno troca para 2026-10-21 e Noite" (R2);
    - "trocar a data limpa a seleção";
    - "Enviar para selecionados manda { type: 'sector', sectorId, date: '2026-10-21', shiftId: 'noite', userIds: [...] }";
    - "contador de quem está sem escala".
  - `recent-dispatches` spec: "Ver destinatários mostra Destinatários com resultado, Escalados não marcados e De folga, sem telefone".
  - `send-whatsapp-dialog.spec.tsx`: "requestTarget leva date, shiftId e includeOff, sem shift".
  - `api.spec.ts`: "useTeamRoster pede /internal/team-whatsapp/roster?sectorId&date com a key ['team-whatsapp','roster',sectorId,date]".
- [ ] **Step 2:** `timeout 600 gate --test src/routes/_authenticated/whatsapp-equipe/index.spec.tsx` → FAIL.
- [ ] **Step 3:** implementar; apagar `lib/work-shift.ts`.
- [ ] **Step 4 (GREEN):** specs → PASS.
- [ ] **Step 5:** `timeout 600 gate --changed --base origin/main` (cwd `frontend/`) → PASS; GC2 à mão.

---

### Task 15: front — agendar, lista Agendados e Novidades

Depende de: T8 e T14. Risco: médio.

**Files:**
- Modify: `frontend/src/features/team-whatsapp/schemas.ts`, `api.ts` (`useScheduledDispatches`, `useCancelDispatch`), `error-messages.ts` (+ spec), `components/send-whatsapp-dialog.tsx` (+ spec), `components/recent-dispatches.tsx`
- Create: `frontend/src/features/team-whatsapp/components/scheduled-dispatches.tsx` + `scheduled-dispatches.spec.tsx`
- Modify: `frontend/src/routes/_authenticated/whatsapp-equipe/index.tsx` (+ `index.spec.tsx`)
- Modify: `frontend/src/release-notes.ts` + `frontend/src/release-notes.spec.ts`

**Contexto vinculado:**
- Spec §6: diálogo com `Enviar agora` e `No início do turno`; o segundo só com turno específico e desabilitado com motivo se o início já passou; lista `Agendados` com data/hora, rótulo, quantidade e `Cancelar` até o disparo.
- C7: `when: 'shift_start'`; resposta `{ dispatchId, queued, scheduled, scheduledFor, skipped }`; 422 `team_whatsapp.schedule_in_past`.
- C9: `GET /internal/team-whatsapp/scheduled` e `POST …/dispatches/:id/cancel`; 409 `not_cancellable`.
- C8/C10: status `SCHEDULED`/`CANCELLED`, `errorCode 'team_whatsapp.channel_unavailable'`, skip `INACTIVE`.
- GC5: habilitar/desabilitar comparando `roster.shiftStarts[].startsAt` (ISO) com `Date.now()`; a hora exibida é `formatDayMonth(rosterDate)` + `shift.startTime` do snapshot (a hora gravada), sem conta de fuso.
- GC12: `Enviar agora`, `No início do turno`, `O início deste turno já passou`, `Agendados`, `Cancelar`, `Agendado`, `Cancelado`, `Canal indisponível na hora do envio`, `Usuário inativo`; `schedule_in_past` → `O início deste turno já passou. Escolha Enviar agora ou outra data.`; `not_cancellable` → `Este envio já saiu ou foi cancelado.`; toast `Agendado para 21/10 às 22:00`.
- GC15: entrada nova no topo com `version: '2026.10.21.1'`; ajustar o `describe` "novidade 2026.10.21".

**Interfaces:**
- `useScheduledDispatches()` (key `['team-whatsapp', 'scheduled']`, `refetchInterval` 60 s enquanto houver itens); `useCancelDispatch()` invalida `scheduled` e `dispatches`; `useCreateTeamDispatch` invalida também `scheduled`.
- Novidade (texto para o operador):

```ts
{
  version: '2026.10.21.1',
  date: '2026-10-21',
  title: 'Escala da equipe, turnos com horário e envio agendado',
  items: [
    { text: 'Cadastre os turnos com nome e horário. Confira os horários de "1º turno" (06:00–14:00) e "2º turno" (14:00–22:00), que vieram do cadastro anterior.', where: '/turnos' },
    { text: 'Monte a escala de cada pessoa com os modelos Semanal, Rodízio semanal ou 12x36 e marque folga, férias, troca de turno ou outro setor.', where: '/escala' },
    { text: 'No WhatsApp da equipe, escolha a data e veja quem está escalado, de folga e sem telefone. Agende o envio para o início do turno e cancele se precisar.', where: '/whatsapp-equipe' },
    { text: 'Usuários ganham o campo Função.', where: '/users' },
  ],
}
```

(o formato exato de `date`/`where` segue `ReleaseNote` em `release-notes.ts:16-32`).

**Steps:**
- [ ] **Step 1 (RED):**
  - `send-whatsapp-dialog.spec`:
    - "No início do turno não aparece em Todos os turnos";
    - "desabilitado com 'O início deste turno já passou' quando startsAt <= agora" (`vi.setSystemTime(new Date('2026-10-22T02:00:00Z'))`, startsAt `'2026-10-22T02:00:00.000Z'`);
    - "agendar envia when 'shift_start' e mostra 'Agendado para 21/10 às 22:00'".
  - `scheduled-dispatches.spec.tsx`:
    - "lista '21/10 22:00', rótulo e 'N pessoa(s)'";
    - "Cancelar confirma e chama POST cancel";
    - "409 mostra 'Este envio já saiu ou foi cancelado.'".
  - `error-messages.spec`: `it.each` `channel_unavailable`, `INACTIVE`, `SCHEDULED`, `CANCELLED`, `schedule_in_past`.
  - `release-notes.spec.ts`:
    - `describe('novidade 2026.10.21.1')`: topo, com `where` `/turnos`, `/escala`, `/whatsapp-equipe`, `/users`, e o texto citando `06:00–14:00` e `14:00–22:00`;
    - o `describe` "novidade 2026.10.21" passa a localizar a entrada por `version`.
- [ ] **Step 2:** `timeout 600 gate --test src/features/team-whatsapp/components/scheduled-dispatches.spec.tsx` → FAIL.
- [ ] **Step 3:** implementar (escolha com dois botões/`select` existentes, sem radio novo).
- [ ] **Step 4 (GREEN):** specs, `whatsapp-equipe/index.spec.tsx` e `release-notes.spec.ts` → PASS.
- [ ] **Step 5:** `timeout 600 gate --changed --base origin/main` (cwd `frontend/`) → PASS; GC2 à mão.

---

## Fechamento (principal, depois da T15)

1. **Gate completo por lado**, supervisionado (`run_in_background` com `timeout N`, log em arquivo), com `--base origin/main`, cwd `backend/` e `frontend/`. Comparar com a baseline do ledger (`8c33d6b`):
   - FRONT: TESTES 1662/1662, COV 81.6/76.6, LINT 107/8, SONAR 25, COMPLEXIDADE 292;
   - BACK: TESTES 4533/4578 (45 ignorados), COV 93.0/83.5, LINT 7877/716, SONAR 102, COMPLEXIDADE 750.

   Aceite: testes todos verdes (só os 45 ignorados); cobertura sem queda; LINT/SONAR/COMPLEXIDADE sem aumento. Os casos de `describe` > 50 linhas e de `max-params` em spec (que o `--changed` não pega) aparecem aqui: corrigir na hora. Regressão nova bloqueia; não regenerar a baseline.
2. **CI do PR**: backend-tests, frontend-build, e2e, migration-drift (só depois de pedido explícito de push/PR).
3. **QA visual local** (agente `qa`, Playwright, stack local com seed; sem produção), roteiro dos aceites 1–7 da spec:
   - Turnos: criar "Manhã 06:00–14:00" e "Noite 22:00–06:00"; migrados com as pessoas;
   - Escala: Rodízio semanal do João; férias da Maria;
   - Envio: Produção + hoje + Noite; Todos os turnos + incluir folga; agendar Noite, Agendados, Cancelar; Ver destinatários com três grupos;
   - Função em Usuários, no quadro e no envio.

   Evidência por tela. O disparo às 22:00 fica coberto pelo teste da T9; no QA, conferir só que o agendado aparece e é cancelado.
4. **Revisão final de contratos** (revisor `opus`): C1–C10, back (`schemas/contracts/*.schema.ts` + DTOs) contra front (`features/*/schemas.ts`), campo a campo; códigos de erro de C1/C2/C4/C5/C7/C9 com mensagem no front; nenhum telefone em `roster`, lista de envios ou auditoria.
5. **Ledger**: registrar gates, QA, revisão e próximo passo em `.superpowers/sdd/2026-10-21-orgamind-escala/progress.md`.
