# OrgaMind — pessoas no setor, nível hierárquico e envio para vários setores — Implementation Plan

> **Para os agentes:** executar pela skill `sdd` (TDD, ledger em `.superpowers/sdd/2026-10-22-orgamind-pessoas-setor-nivel/progress.md`). **Sem commit/push**: nenhuma task commita; a principal integra e só commita/publica com pedido explícito do usuário.

**Goal:** pôr pessoas num setor pela página do setor (nova pessoa, a partir de Contatos em lote, ou mudando de setor uma pessoa já cadastrada); pessoa **sem acesso ao sistema** (só recebe WhatsApp, sem e-mail, sem senha, sem login); **Nível** editável (Coordenador, Líder, Funcionário, Operador); envio do WhatsApp da equipe para **um ou mais setores** com filtro por nível; telas vazias com "Adicionar pessoas"; Novidade.

**Architecture:** back primeiro, em série (T1, T2 e T7 mexem em `schema.prisma`; T4, T7, T8a e T8b mexem em `team-whatsapp/**`). A pessoa sem acesso é uma linha `User` com `hasAccess = false` (D1): escala, turno, telefone/Contato e envio continuam apontando para `User`, e um único critério (`hasAccess`) tira a pessoa de todo seletor de quem age (T4). A página do setor ganha uma API própria em módulo novo `sector-people` com a política do gestor (T5 leitura, T6 escrita), que reaproveita o `UsersService` para criar/editar (T3). O envio guarda os setores numa tabela de junção com snapshot do nome (T7), o que permite a regra "o gestor só vê/cancela quando todos os setores do envio são seus" numa query `every`; a T8a abre a leitura (roster de vários setores, níveis nos alvos, filtro e rótulo puros) e a T8b troca o alvo setor do POST para `sectorIds[]` + filtro de nível, mantendo o caminho de um setor sem nível idêntico (teste de caracterização criado na T7 antes de qualquer mudança). O front espelha os contratos à mão em `features/*/schemas.ts`.

**Tech Stack:** NestJS + Prisma + Zod (`createZodDto`) + BullMQ + argon2 + Vitest/testcontainers (backend); React + TanStack Router/Query + Radix (dialog, tabs, checkbox, select, table) + ky 2 + sonner + Vitest/Testing Library/user-event (frontend).

**Spec:** `docs/superpowers/specs/2026-10-22-orgamind-pessoas-setor-nivel.md` (fonte da verdade). Mapas: `.superpowers/sdd/2026-10-22-orgamind-pessoas-setor-nivel/mapa-pessoas-setor.md`, `mapa-envio.md`. Base: `origin/main` `a2520bb` (escala em produção); a principal cria a branch da feature a partir de `origin/main` (o `main` local está atrasado). Baseline dos gates: ledger `progress.md`.

## Ordem e paralelismo

```
Back (série):  T1 ─> T2 ─> T3 ─> T4 ─> T5 ─> T6 ─> T7 ─> T8a ─> T8b
Front:         T1 ─> T9
               T3 ─> T10
               T6 + T10 ─> T11 ─> T12
               T8b ─> T13 ─> T14   (T14 também depende da T7)
               T9..T14 ─> T15 (Novidade)
```

- **Back em série**: T1/T2/T7 criam migração em `backend/prisma/schema.prisma`; T3 e T6 dividem `users.service.ts`; T4, T7, T8a e T8b dividem `team-whatsapp/**`; T5 e T6 dividem o módulo novo `sector-people/**`.
- **Front** começa quando o contrato existe: T9 depois da T1; T10 depois da T3; T11 depois da T6 e da T10 (usa `hasAccess` do `userSummary`); T12 depois da T11; T13 depois da T8b (usa roster da T8a e POST da T8b); T14 depois da T7 e da T13; T15 por último.
- Paralelos permitidos (ownership disjunto): **T9 ∥ T10** (`features/levels/**` + `routes/_authenticated/niveis/**` + `lib/nav.ts` vs `features/users/**` + `routes/_authenticated/users/**` + `features/chat/components/assign-menu.tsx`); **T11/T12 ∥ T13/T14** (`features/sector-people/**` + `routes/_authenticated/setores/**` + `features/internal-admin/**` + `lib/nav.ts` vs `features/team-whatsapp/**` + `routes/_authenticated/whatsapp-equipe/**`). T9 e T11 tocam `lib/nav.ts`: não rodar juntas.
- Revisão: **críticas** (revisor `opus`, SKILL.md do sdd) = T2, T3, T4, T5, T6, T7, T8a, T8b. **Fronteira**: T1 (API pública nova e `User.levelId`, consumido por T3, T5 e T8a) → revisor `opus`, implementador `sonnet`, fora do A/B (sem `effort: high`). Não críticas: T9–T15. A/B de effort: T9, T11, T13 e T15 (não críticas, número ímpar) vão com `effort: high`. T15 cabe no `mecanico` (1 arquivo + spec, sem lógica de estado).

## Global Constraints

- **GC1 — Gate.** Iteração: `timeout 600 gate --test <arquivo>`. Fechamento de cada task: um único `timeout 600 gate --changed --base origin/main`, com cwd `backend/` ou `frontend/` conforme o lado. Suíte inteira, gate completo, `test:cov`/`--coverage` e e2e ficam com a principal, no Fechamento. Nunca os rode dentro de uma task. Em worktree, o gate precisa de `backend/.env` fictício e `node_modules` (memória do projeto).
- **GC2 — Limites do gate de complexidade, inclusive em specs.** Função/callback (inclusive o callback de `describe`) ≤ 50 linhas; ≤ 4 parâmetros (mais campos = objeto); ciclomática ≤ 10; cognitiva ≤ 15; profundidade ≤ 4. Duplicação ≤ 3% das linhas novas; cobertura ≥ 80% das linhas novas. O `--changed` **não** acusa `max-lines-per-function` em `describe` nem `max-params` em spec: cada task confere à mão antes de fechar (casos novos em `describe` novos, `it.each` com tabela).
- **GC3 — Banco.** Nunca `prisma migrate reset`. `migrate dev`/`migrate deploy`/`db push`/`migrate diff --shadow-database-url` só contra o Postgres do testcontainers. `bun run prisma generate` (sem banco) é livre. DDL sem banco: `bunx prisma migrate diff --from-schema-datamodel <cópia do schema anterior> --to-schema-datamodel prisma/schema.prisma --script`, depois o SQL de dados à mão, sem renomear constraints/índices gerados. Helpers prontos em `backend/test/migrations.ts`: `deployMigrations({ databaseUrl, until? })` e `schemaDrift({ shadowUrl })`.
- **GC4 — Migrações (dono e nome fixos, todas aditivas, sem perda de dados).** Só estas; nenhuma outra task mexe em `schema.prisma`:
  - T1 `20261022090000_staff_level` (tabela `StaffLevel` + 4 níveis + `User.levelId`);
  - T2 `20261022100000_user_without_access` (`hasAccess`, `email`/`password` anuláveis, CHECK);
  - T7 `20261022110000_team_dispatch_sectors` (tabela de setores do envio + snapshot no destinatário + backfill).
  O CI `migration-drift` só aceita diff vazio ou exatamente `DROP TABLE "_message_dup_neutralized_20260819";`. Toda task que cria migração roda o teste de drift (`describe('schema sem drift (igual ao CI)')` em `backend/src/modules/shifts/shift-migration.integration.spec.ts`) de novo.
- **GC5 — Um critério de "quem age": `hasAccess`.** Pessoa com `hasAccess = false` não loga, não tem senha nem e-mail, não pode ser gestor de setor, responsável de Demanda, atribuída a conversa, nem remetente do WhatsApp da equipe. Todo filtro de "quem age" ganha `hasAccess: true` **além** dos filtros de hoje (papel, ativo). Ela aparece só como destinatária do WhatsApp da equipe, na escala e nas listas de pessoas (Usuários, página do setor).
- **GC6 — Política de envio inalterada, por setor.** `team-whatsapp.policy.ts`: ADMIN alcança todos os setores ativos; gestor (`Sector.managerId`), só os que gerencia (`managedSectorIds`), via `canSendToSector`. Com vários setores, **cada** setor passa por `canSendToSector`; um que falhe dá 403 `team_whatsapp.forbidden` antes de turno, nível, escala, seleção ou canal. `userIds` não abre setor.
- **GC7 — Lista conferida = lista enviada.** No POST o servidor refaz a lista com os mesmos setores, níveis, data, turno e `includeOff`; `userIds` fora dela dá 422 `team_whatsapp.invalid_selection` e nada é criado (nem dispatch, nem job, nem auditoria). Ids repetidos contam uma vez. No agendado, só os destinatários gravados recebem (pipeline da T9 da escala, sem mudança).
- **GC8 — Dado pessoal.** Telefone, nome e e-mail nunca vão para log ou auditoria novos; auditoria nova grava ids e contagens (`actorId`, `sectorId`, `created`, `failed`…). Telefone continua fora da foto (`roster`), dos destinatários gravados e da lista de envios. A página do setor mostra o telefone só a quem pode editá-lo: ADMIN vê o de todos; o gestor vê o de quem não tem acesso (`editable: 'full'`) e recebe `phoneE164: null` de quem tem acesso (`editable: 'limited'`). A auditoria nova `auth.login_failed` reason `no_access` não grava e-mail (sem exceção à GC8).
- **GC9 — Contratos espelhados.** O back é a fonte (`backend/src/schemas/contracts/*.schema.ts` + DTOs); o front copia os mesmos campos em `frontend/src/features/*/schemas.ts`, sem SDK. Back e front sobem no mesmo PR; deploy só no fim da feature.
- **GC10 — Erros no front.** Código de erro lido só com `readApiErrorBody` de `frontend/src/lib/api-error.ts` (ky 2 consome o corpo; `code` vem de `HTTPError.data`). Specs do front simulam o erro com corpo consumível, como os specs atuais.
- **GC11 — Rótulos pt-BR exatos.** Separador ` · ` (espaço, U+00B7, espaço).
  - Pessoas: `Adicionar pessoas`, abas `Nova pessoa` / `Dos contatos` / `Já cadastrada`, `já é <nome> · <setor>`, confirmação `<nome> sai de <setor>`, `Editar`, `Tirar do setor`, `Sem setor`, `Acesso ao sistema`, `Sem acesso`, `Com acesso`, `Dar acesso`, `Nível`, `Sem nível`, `Função`, `Turno`, botão do lote `Adicionar (N)`, toast `N pessoa(s) adicionada(s)`.
  - Níveis: menu e título `Níveis`, `Novo nível`, `Editar`, `Desativar`, `Reativar`, `Subir`, `Descer`; migrados `Coordenador`, `Líder`, `Funcionário`, `Operador`.
  - Envio: `Setores`, `Todos os setores`, `Níveis`, `Sem nível`; tela vazia `Ninguém neste setor ainda.` + link `Adicionar pessoas`.
  - Erros (front): `users.no_access` → `Esta pessoa não tem acesso ao sistema.`; `users.already_has_access` → `Esta pessoa já tem acesso.`; `users.invalid_level` / `team_whatsapp.invalid_level` → `Nível inválido. Atualize a página e tente de novo.`; `levels.name_taken` → `Já existe um nível com esse nome.`; `sector_people.forbidden` → `Você não pode mexer nesta pessoa.`; `sector_people.has_access` → `Quem tem acesso muda de setor pelo cadastro em Usuários.`; motivos do lote `invalid_phone` → `Telefone inválido`, `phone_taken` → `Número já usado por outra pessoa`, `already_person` → `Já é uma pessoa cadastrada`, `contact_not_found` → `Contato não encontrado`.
- **GC12 — Rótulo do envio (`targetLabel`).** `<setores> · <níveis>? · <turno | todos os turnos> · dd/MM · seleção de N?`. Setores pela ordem de nome (`localeCompare(…, 'pt-BR')`); até dois nomes separados por `, `, e com mais de dois os dois primeiros + ` +N` (`RH, TI +2`). Níveis pelo `sortOrder`, `Sem nível` por último, mesma regra de dois + `+N`; parte omitida sem filtro de nível. Um setor sem nível = rótulo de hoje: `Produção · Noite · 21/10 · seleção de 2`, `Produção · todos os turnos · 21/10`.
- **GC13 — Testes enxutos.** Um teste por critério de aceite mais os riscos do Review Focus, sem duplicar unit e integração. Backend: Vitest unit com `vitest-mock-extended`/harness do módulo; integração com `@testcontainers/postgresql` só onde query/gravação/migração muda. Frontend: Vitest + Testing Library + user-event, `vi.mock` dos hooks de `api.ts`, sem msw.
- **GC14 — Sem extras.** Sem dependência nova, sem serviço novo no compose, sem componente novo em `frontend/src/components/ui/` (multi-escolha = lista de `Checkbox`). Rota nova só `/niveis`. Item de menu em `frontend/src/lib/nav.ts` com `roles`. `src/routeTree.gen.ts` é gerado. Sem commit/push.
- **GC15 — Novidades.** Só a T15 mexe em `frontend/src/release-notes.ts`: entrada nova no topo com `version: '2026.10.22'` (a do topo hoje é `'2026.10.21.1'`).

## Contratos compartilhados (fonte: back; o front espelha)

- **C1 — Níveis** (T1).
  - Prisma `StaffLevel { id String @id @default(cuid()), name String @unique, sortOrder Int, isActive Boolean @default(true), createdAt DateTime @default(now()), updatedAt DateTime @updatedAt, users User[] }`. `User.levelId String?` + `level StaffLevel? @relation(fields: [levelId], references: [id], onDelete: Restrict)` + `@@index([levelId])`.
  - Migrados com ids fixos: `level_coordinator` `Coordenador` 1, `level_leader` `Líder` 2, `level_employee` `Funcionário` 3, `level_operator` `Operador` 4, todos ativos. Ninguém recebe nível na migração.
  - `backend/src/schemas/contracts/level.schema.ts`: `levelRefSchema = z.object({ id: z.string(), name: z.string() })`; `levelAdminSchema = levelRefSchema.extend({ isActive: z.boolean(), sortOrder: z.number().int(), userCount: z.number().int().nonnegative() })`; `levelListResponseSchema = z.object({ items: levelAdminSchema.array() })`.
  - Rotas, todas `@Roles('ADMIN')`: `GET /internal/levels` → lista (sortOrder asc, depois name); `POST /internal/levels` `{ name: trim 1..40 }` → 201 `LevelAdmin` (sortOrder = máx + 1, ativo); `PATCH /internal/levels/:id` `{ name?, isActive? }` (≥ 1 campo) → `LevelAdmin`; `PUT /internal/levels/order` `{ ids: string[] 1..100 }` → lista. Sem DELETE.
  - Erros: 404 `levels.not_found`; 409 `levels.name_taken` (sem caixa, após trim); 422 `levels.invalid_order` (ids repetidos ou ≠ conjunto de todos).
  - Desativar não é bloqueado por uso: o nível fica nas pessoas e no histórico, e some do cadastro novo e do filtro (C2, C4, C5).
- **C2 — Acesso e nível no usuário** (banco/login: T2; API: T3).
  - Banco (T2): `User.email String? @unique`, `password String?`, `hasAccess Boolean @default(true)`; CHECK `User_access_consistent`: `("hasAccess" AND "email" IS NOT NULL AND "password" IS NOT NULL) OR (NOT "hasAccess" AND "email" IS NULL AND "password" IS NULL)`. Pessoa sem acesso grava `role = 'VIEWER'`, `mustChangePassword = false` (D1).
  - `userSummarySchema` (`backend/src/schemas/contracts/user.schema.ts`): `email: string | null` e `hasAccess: boolean` (T2); `levelId: string | null` e `level: { id, name, isActive } | null` (T3). Todo schema de contrato com e-mail de pessoa (`email: z.string()` em `team-whatsapp.schema.ts`, membros do setor etc.) vira `.nullable()` (T2).
  - Login (T2): `hasAccess = false` ou `password = null` → o mesmo 401 de credencial inválida, com `argon2.verify` contra o hash fictício (mesmo tempo), auditoria `auth.login_failed` `{ reason: 'no_access' }` **sem e-mail** (GC8). Sessão/refresh de usuário `hasAccess = false` → 401.
  - `GET /users?hasAccess=true` (T3): filtro opcional em `ListUsersDto` (`backend/src/modules/users/dto/list-users.dto.ts`), `'true'`/`'false'` na query viram boolean, outro valor → 400; sem o filtro lista todos, como hoje. Usado pelo menu de atribuição de conversa (T10).
  - `POST /users` (T3): `hasAccess?: boolean` (padrão `true` = fluxo de hoje). `hasAccess: false` → `name` obrigatório (trim 1..120), `phone` obrigatório, `email` e `role` proibidos (refine → 400), `sectorId?: string | null`, `shiftId?`, `jobTitle?`, `levelId?`; resposta no formato de hoje com `temporaryPassword: null`.
  - `POST /users/:id/access` (T3) `{ email, role }` → 200 `{ user: UserSummary, temporaryPassword: string }`; 409 `users.already_has_access`; 409 `user.email_taken` (o código de hoje); 422 `user.sector_required`/`user.sector_invalid` (papel ≠ ADMIN sem setor ativo, regra de hoje); 404 do usuário inexistente como hoje.
  - `POST /users/:id/reset-password` em pessoa sem acesso → 422 `users.no_access`.
  - `PATCH /users/:id` (T3): `levelId?: string | null` (ausente mantém, `null` limpa); `role` em pessoa sem acesso → 422 `users.no_access`; "não-ADMIN exige setor" vale só para `hasAccess = true`.
  - `levelId` inexistente, ou inativo e diferente do nível atual da pessoa → 422 `users.invalid_level`.
- **C3 — Pessoas do setor** (leitura: T5; escrita: T6). Módulo `backend/src/modules/sector-people/`, controller `@Controller('internal/sectors/:sectorId/people')` com `@Roles('ADMIN', 'SUPERVISOR', 'OPERATOR')` e a política P1 (abaixo). Contrato `backend/src/schemas/contracts/sector-people.schema.ts`:
  - `sectorPersonSchema = z.object({ id, name: z.string(), phoneE164: z.string().nullable() /* null ao gestor quando editable = 'limited' (GC8); ADMIN recebe o número */, hasAccess: z.boolean(), role: roleSchema.nullable() /* null quando sem acesso */, level: z.object({ id, name, isActive }).nullable(), jobTitle: z.string().nullable(), shift: z.object({ id, name }).nullable(), editable: z.enum(['full', 'limited']) /* full = sem acesso; limited = com acesso */ })`.
  - `GET /` → `{ sector: { id, name, code, isActive, manager: { id, name: string | null } | null }, people: SectorPerson[] /* ativos com sectorId = este, nome asc pt-BR */, options: { levels: LevelRef[] /* ativos, sortOrder */, shifts: { id, name }[] /* ativos, sortOrder */ } }`.
  - `GET /candidates?q=` (q trim 0..80) → `{ items: { id, name: string, hasAccess: boolean, sector: { id, name } | null }[] }`, até 20, ativos, `sectorId ≠ este`, nome ou telefone contém `q`. ADMIN: todos; gestor: só `sectorId = null` **e** `hasAccess = false` (D6).
  - `GET /contact-candidates?q=` → `{ items: { contactId, name: string | null, phoneE164: string, person: { userId, name: string, sectorName: string | null } | null }[] }`, até 30, mesmo filtro base da listagem `GET /contacts`, nome ou número contém `q`, nome asc. `person` = usuário ligado ao contato (`Contact.user`, relação `UserContact`).
  - `POST /` `{ name: trim 1..120, phone: string 1..40, levelId?: string | null, jobTitle?: string | null (trim ≤ 80), shiftId: string (obrigatório, turno ativo — Q3) }` (`.strict()`) → 201 `SectorPerson` (sem acesso, neste setor).
  - `POST /from-contacts` `{ contactIds: string[] 1..100, levelId?: string | null, shiftId: string (obrigatório, turno ativo — Q3) }` (`.strict()`) → 200 `{ created: SectorPerson[], failed: { contactId, reason: 'invalid_phone' | 'phone_taken' | 'already_person' | 'contact_not_found' }[] }`. Ids repetidos contam uma vez. `levelId`/`shiftId` inválidos → 422 do pedido inteiro antes de criar qualquer um.
  - `POST /move` `{ userIds: string[] 1..100 }` (`.strict()`) → 200 `{ moved: SectorPerson[] }`. Algum id fora do alcance do ator (P1) → 403 sem mover ninguém; inexistente/inativo → 404 `sector_people.person_not_found` sem mover ninguém.
  - `PATCH /:userId` `{ name?, phone?, levelId?, jobTitle?, shiftId? }` (≥ 1 campo, `.strict()`) → `SectorPerson`. Pessoa com acesso + `name`/`phone` → 403 `sector_people.forbidden`.
  - `DELETE /:userId` → 204 (fica `sectorId = null`); pessoa com acesso → 422 `sector_people.has_access`.
  - Erros: 403 `sector_people.forbidden`; 404 `sector_people.sector_not_found` (só ADMIN; não-ADMIN recebe 403); 404 `sector_people.person_not_found`; 422 `users.invalid_level`, `users.invalid_shift` e os de telefone do `UserPhoneService` (vindos da T3/escala).
  - Campo desconhecido no body (`email`, `role`, `hasAccess`, `sectorId`) → 400 pelo `.strict()`; dar acesso, mudar perfil ou e-mail só existe em `/users` (ADMIN) → 403 para o gestor pelo `RolesGuard`.
  - Nota (aceite 1b, "403 no servidor"): o 403 de dar acesso vem de `POST /users/:id/access` (`RolesGuard`, teste na T3). Pelas rotas `sector-people`, `hasAccess` no body dá **400** (`.strict()`, teste na T6), não 403; os dois são recusa no servidor e coerentes com a spec.
- **C4 — Alvos e lista do dia no envio** (T8a).
  - `GET /internal/team-whatsapp/targets` ganha `levels: LevelRef[]` (ativos, sortOrder). O resto não muda.
  - `GET /internal/team-whatsapp/roster?sectorIds=<id>,<id>&date` (`sectorIds` 1..100 separados por vírgula, repetidos contam uma vez; `sectorId=<id>` sozinho é aceito como `[id]`, D7) → `{ date, shiftStarts: { shiftId, startsAt }[], sectors: { sectorId, name, members: TeamRosterMember[] }[] }`, setores por nome (pt-BR). `TeamRosterMember` ganha `level: LevelRef | null`. Cada `members` é o de hoje para aquele setor (C6 da escala). 403 pela GC6 se algum setor falhar.
- **C5 — POST de envio** `POST /internal/team-whatsapp/dispatches` (T8b). Alvo setor: `{ type: 'sector', sectorIds: string[] 1..100, shiftId?, userIds? 1..500, date, includeOff?, levelIds?: string[] 0..50, withoutLevel?: boolean }`; `sectorId: string` sozinho é aceito e vira `sectorIds: [sectorId]` (D7). Filtro de nível: sem `levelIds` (ou vazio) e sem `withoutLevel` = todos; senão passa quem tem `levelId ∈ levelIds`, ou não tem nível e `withoutLevel = true`. Erros novos: 422 `team_whatsapp.invalid_level` (nível inexistente ou inativo). Ordem: remetente → política de cada setor (403) → turno (422 `invalid_shift`) → níveis (422 `invalid_level`) → lista refeita → seleção (422 `invalid_selection`) → resto como hoje. Alvo pessoa e `when` não mudam.
- **C6 — Gravação e lista de envios** (colunas e backfill: T7; gravação do nível e de vários setores: T8b).
  - Prisma: `TeamWhatsappDispatchSector { dispatchId String, dispatch TeamWhatsappDispatch @relation(fields: [dispatchId], references: [id], onDelete: Cascade), sectorId String /* sem FK, como targetId */, sectorName String /* snapshot */, @@id([dispatchId, sectorId]), @@index([sectorId]) }`; `TeamWhatsappDispatch.sectors TeamWhatsappDispatchSector[]`; `TeamWhatsappRecipient` + `sectorId String?`, `sectorName String?`, `levelName String?` (snapshot, sem FK).
  - Alvo setor grava `targetType 'SECTOR'`, `targetId` = primeiro setor pela ordem do rótulo (compatibilidade) e uma linha em `sectors` por setor. Alvo pessoa: nenhuma linha.
  - Foto (`roster` Json): `RosterPerson` ganha `sectorName: string | null` e `levelName: string | null` (foto antiga sem os campos → `null` na leitura).
  - `GET /internal/team-whatsapp/dispatches`, por item: `sectors: { id, name }[]` (`[]` no alvo pessoa); `recipients[]`, `unselected[]` e `off[]` ganham `sectorName: string | null` e `levelName: string | null`.
- **C7 — Quem vê e cancela** (T7). Gestor = não-ADMIN remetente.
  - Agendados (`GET …/scheduled`): ADMIN todos; gestor só `targetType = 'SECTOR'` com `sectors` não vazio e **todo** `sectors.sectorId ∈ managedSectorIds`.
  - Cancelar: ADMIN qualquer envio a setor (como hoje); gestor só se **todo** setor do envio passa por `canSendToSector`; senão 403 `team_whatsapp.forbidden`.
  - Recentes (`GET …/dispatches`): ADMIN todos; gestor = `authorId = ele`, exatamente como hoje (Q1 resolvida: o gestor sempre vê os próprios envios; ele só cria envio para setores que gerencia, então não vê nome de setor alheio).
- **P1 — Política da página do setor** (T5, pura em `sector-people.policy.ts`).
  - Ator válido: ativo, `hasAccess`, papel ADMIN/SUPERVISOR/OPERATOR.
  - `canManageSector`: ADMIN, qualquer setor existente; gestor (`sector.managerId === actor.id`), só se o setor está ativo.
  - `canEditPerson(fields)`: pessoa com `sectorId` = este setor; sem acesso: `name`, `phone`, `levelId`, `jobTitle`, `shiftId`; com acesso: só `levelId`, `jobTitle`, `shiftId`. Vale para ADMIN e gestor (o ADMIN edita e-mail/perfil em Usuários).
  - `canPickExisting`: ADMIN, pessoa com `sectorId ≠ este`; gestor, só `sectorId = null` e `hasAccess = false`.
  - `canRemove`: pessoa deste setor e `hasAccess = false`.

## Decisões do plano

- **D1 — Pessoa sem acesso = `User` com `hasAccess = false`, `email`/`password` NULL, `role = 'VIEWER'`.** Escala, turno, telefone/Contato (`UserPhoneService`), roster e histórico já apontam para `User`; uma tabela à parte duplicaria o envio e a escala. `hasAccess` explícito é o "critério único" da spec (GC5); o CHECK impede estado misto (acesso sem senha, senha sem acesso). `VIEWER` é defesa em profundidade: todo filtro que hoje exige papel de escrita já a exclui mesmo se esquecer `hasAccess`. `email @unique` anulável: Postgres aceita vários NULL. Dar acesso grava `email`, `role`, `password` (hash da temporária), `mustChangePassword = true` e `hasAccess = true` num único `update`. Tirar acesso fica fora (spec).
- **D2 — Login, reset, auditoria e listagens sem e-mail.** Login é por e-mail (`auth.service.ts:55`), então e-mail NULL nunca é encontrado; mesmo assim `assertLoginAllowed` recusa `!hasAccess || password === null` antes do `argon2.verify` (que quebraria com NULL), com o hash fictício para igualar o tempo. Não existe "esqueci a senha" público (só `POST /auth/change-password` autenticado e `POST /users/:id/reset-password` do ADMIN): o reset recusa sem acesso (422). Auditorias de hoje que gravam `email` passam a gravar `null` sem quebrar; auditorias novas não gravam e-mail (GC8). Nome exibido: `name ?? email ?? ''` onde hoje é `name ?? email` (pessoa sem acesso sempre tem nome). `findMembers` deixa de ordenar por `email` só se o tipo exigir; a ordem do seletor de Demanda não muda (sem acesso sai pelo `eligible`).
- **D3 — Notificações de Comunicados/Demandas.** `notifyTeam`/`notifyAssignee` são filtros de leitura de quem entra no sistema (`internal-communications.service.ts:581-594`); não há fan-out para usuários. Quem não loga nunca é ator, então fica fora sem código novo. O que muda é o responsável de Demanda (`:649-655`) e o seletor do front, que lê `GET /internal/sectors/:id/members?eligible=true` (T4).
- **D4 — Nível em tabela `StaffLevel`, snapshot no envio.** Renomear muda o nome em cadastro, página do setor, Usuários, filtro e lista do dia (aceite 6). Histórico guarda `levelName` do destinatário e da foto (spec §4: "nível da época"), então não muda ao renomear. Nome do modelo `StaffLevel` para não colidir com palavras genéricas (`Level`).
- **D5 — Setores do envio em tabela de junção.** O modelo tem um `targetId` só; uma coluna array não expressa "todos ⊆ geridos" no Prisma, e a junção expressa com `sectors: { some: {}, every: { sectorId: { in: managed } } }`. `targetId` continua preenchido (primeiro setor) para nada que leia `targetId` quebrar. Backfill: uma linha por envio a setor existente, nome do `Sector` ou, se o setor sumiu, o começo do `targetLabel` (`split_part(…, ' · ', 1)`); destinatários desses envios recebem `sectorId`/`sectorName` do envio. Com um setor, as regras de Agendados e cancelamento ficam idênticas às de hoje.
- **D6 — "Já cadastrada" do gestor: só sem setor e sem acesso.** A spec diz "só pessoas sem setor"; com acesso e sem setor só existe ADMIN (não-ADMIN com acesso exige setor), e o gestor mover um ADMIN seria mexer em quem ele não gerencia.
- **D7 — `sectorId` aceito como apelido de `sectorIds: [sectorId]`** no roster e no POST, para uma aba aberta durante o deploy não receber 400. Sem custo: o DTO converte antes da validação.
- **D8 — Aba "Dos contatos" para o gestor.** `GET /contacts` não tem `@Roles` (`contacts.controller.ts:36`): todo usuário autenticado lê contatos hoje. A aba aparece para ADMIN e gestor, servida por `contact-candidates` (que também diz "já é <nome> · <setor>"). O lote exige **Turno** (obrigatório, Q3) e aceita Nível, os dois valendo para todos: sem turno nem escala a pessoa ficaria `NONE` e não entraria em "Todos os turnos" (D2 da escala), e o aceite 1 pede que os contatos apareçam no envio.
- **D9 — Página do setor aberta ao gestor.** A entrada `/setores` do `NAV` passa a `roles: WRITE_INTERNAL_ROLES`. Para não-ADMIN, `/setores` lista só os setores que ele gerencia (sem "Novo setor"), com `Você não gerencia nenhum setor.` quando vazia; `/setores/$sectorId` mostra só cabeçalho e pessoas (vindos de `GET …/people`, porque `GET /internal/sectors/:id` é só ADMIN), sem editar setor nem números; 403 vira `Você não gerencia este setor.`. `/setores/new` continua só ADMIN. Sem isso o link `Adicionar pessoas` da tela de envio não abre para o gestor.
- **D10 — Lote sem transação única.** Cada contato do lote é criado na sua transação (a do `UserPhoneService`), em ordem; erro de um vira item de `failed` e os demais seguem (spec §2). O `@unique` de `phoneE164`/`contactId` cobre a corrida entre dois lotes (P2002 → `phone_taken`/`already_person`).
- **D11 — Contato sem nome vira pessoa com o número como nome** (`name = phoneE164`), editável depois. Bloquear o item travaria o lote por um dado que o cliente não preencheu.
- **D12 — Nova pessoa e lote reaproveitam `UsersService`.** A T3 expõe `createPersonWithoutAccess` e a edição/mudança de setor usa o `updateUser` de hoje; o módulo `sector-people` só acrescenta a política P1. Telefone único e ligação ao Contato continuam no `UserPhoneService`.

## Review Focus (riscos da spec → teste → task)

1. **R1 — Pessoa sem acesso não entra.** T2 `auth.service.spec.ts` `it.each` "sem acesso → 401 igual ao de senha errada e verify do hash fictício" (`hasAccess false`, `password null`); "login com o telefone da pessoa → 401"; `jwt.strategy`/`refresh.service` "hasAccess false → 401". T3 "reset de senha de quem não tem acesso → 422 users.no_access".
2. **R2 — Gestor fora do próprio setor.** T5 `sector-people.policy.spec.ts` `it.each` (gestor de Operação × pessoa de TI, setor inativo, gestor sem acesso); T6 `sector-people-write.service.spec.ts` "gestor de Operação editando pessoa de TI → 403 sem gravar", "gestor editando nome de pessoa com acesso → 403"; T3 `users.controller` "gestor em POST /users/:id/access → 403".
3. **R3 — Migração sem perda.** T1 "4 níveis na ordem e ninguém com nível"; T2 "usuários existentes ficam com e-mail, senha e hasAccess true; CHECK recusa estado misto"; T7 "envio antigo ganha uma linha de setor com o nome; destinatários ganham sectorName; nada mais muda". Drift em T1, T2 e T7.
4. **R4 — Lista conferida com vários setores e nível.** T8b `team-whatsapp.service.sectors.spec.ts`: "TI + Operação + Coordenador envia só aos coordenadores dos dois" (aceite 3); `it.each` "seleção fora da lista → 422 sem efeito" (não coordenador, setor fora do pedido); "um setor proibido no meio → 403 antes de tudo". T8a: roster de vários setores com `members[].level` e `passesLevel`.
5. **R5 — Um setor sem nível idêntico (anti-objetivo).** T7 Step 0 cria, **antes de mexer em código**, o teste de caracterização `team-whatsapp.service.single-sector.spec.ts`, verde no código atual: `it.each(['now', 'shift_start'])` captura os argumentos de `createDispatch` de um envio a um setor sem nível (`targetType`, `targetId`, `targetLabel 'Produção · Noite · 21/10'`, `shift*`, `rosterDate`, `includeOff`, destinatários com ids, status e turno, `roster.working/off`) num literal `toMatchObject`. A T7 e a T8b só acrescentam chaves ao literal (`sectors`, `sectorId`, `sectorName`, `levelName`); nenhuma chave antiga muda. T7 "Agendados/cancelar de um setor: mesmas regras de hoje".
6. **R6 — Gestor e envios de vários setores.** T7 repository integration `it.each`: Agendados — gestor de A vê envio só de A, não vê A+B nem B; ADMIN vê A+B. Recentes (autor, como hoje) — gestor autor vê o próprio envio A+B; não vê envio de outro autor. Cancelar A+B como gestor de A → 403; ADMIN cancela A+B.
7. **R7 — Seletores de quem age.** T4 `it.each` por seletor: gestor de setor, responsável de Demanda, atribuição de conversa, remetente da equipe.
8. **R8 — Lote parcial.** T6 "3 contatos, um com número de outra pessoa: 2 criados, 1 phone_taken, nada desfeito".
9. **R9 — Turno obrigatório ao adicionar (Q3).** T6 `it.each` em `POST /` e `from-contacts`: "sem shiftId → 400"; "shiftId inativo → 422 users.invalid_shift, nenhum criado". T12: "sem turno, Adicionar / Adicionar (N) desabilitado e nenhuma chamada" nas abas Nova pessoa e Dos contatos.
10. **R10 — Atribuição de conversa sem perder agente.** T3 `GET /users?hasAccess=true` filtra no servidor; T10 "o pedido do menu leva hasAccess=true" (o filtro no cliente sobre a 1ª página esconderia agentes reais).

## Riscos aceitos

- **M2 — Lista do dia por setor.** O roster multi-setor resolve um setor por vez (`Promise.all` de `loadDayPeople`). Aceitável para dezenas de setores; rever se "Todos os setores" ficar lento.
- **M3 — Histórico não acompanha renomeação** (D4). "Ver destinatários" mostra o nível com o nome da época.
- **M4 — Nível do envio não fica gravado à parte.** Só no rótulo e no `levelName` de cada destinatário; reabrir o filtro de um envio antigo não é pedido.

---

### Task 1: back — Níveis: entidade, migração e API (ADMIN)

Depende de: nada. Risco: alto (migração aditiva com dados de partida; rotas novas só ADMIN). **Fronteira**: API pública nova e `User.levelId`, consumido por T3, T5 e T8a → revisor `opus`, implementador `sonnet`, fora do A/B (sem `effort: high`).

**Files:**
- Modify: `backend/prisma/schema.prisma` (model `StaffLevel`; `User.levelId` + relação `level` + `@@index([levelId])`)
- Create: `backend/prisma/migrations/20261022090000_staff_level/migration.sql`
- Create: `backend/src/modules/levels/{levels.module.ts, levels.controller.ts, levels.service.ts, levels.repository.ts, levels.errors.ts}`, `backend/src/modules/levels/dto/{create-level.dto.ts, update-level.dto.ts, reorder-levels.dto.ts}`
- Create: `backend/src/schemas/contracts/level.schema.ts`
- Modify: `backend/src/app.module.ts` (importa `LevelsModule`)
- Create (teste): `backend/src/modules/levels/levels.service.spec.ts`, `backend/src/modules/levels/levels.repository.integration.spec.ts` (inclui o `describe` da migração)
- Modelo a copiar: `backend/src/modules/shifts/**` (mesma forma: lista, criar, editar, ordenar, nome sem caixa)

**Contexto vinculado:**
- C1 inteiro (modelo, ids fixos `level_coordinator`/`level_leader`/`level_employee`/`level_operator` com `Coordenador` 1, `Líder` 2, `Funcionário` 3, `Operador` 4; rotas ADMIN; erros 404 `levels.not_found`, 409 `levels.name_taken`, 422 `levels.invalid_order`; sem DELETE; desativar não é bloqueado por uso).
- Spec §3: lista editável só ADMIN, no padrão de Turnos; todo mundo começa sem nível; nível inativo fica nas pessoas e no histórico.
- GC3: nunca `migrate reset`; DDL gerado sem banco por `migrate diff --from-schema-datamodel … --script`, depois o `INSERT` à mão.
- GC4: esta task cria só `20261022090000_staff_level`; o drift aceita vazio ou exatamente `DROP TABLE "_message_dup_neutralized_20260819";`.
- GC2: `describe` ≤ 50 linhas, helper ≤ 4 parâmetros, conferir à mão.

**Interfaces:**
- Produces:

```ts
// levels.repository.ts
list(): Promise<LevelAdmin[]>;                  // userCount = count de User com levelId
findById(id: string): Promise<{ id: string; isActive: boolean } | null>;
listActive(): Promise<LevelRef[]>;              // sortOrder asc; usado por T5, T8a e T8b
// levels.service.ts
list(): Promise<LevelListResponse>;
create(input: { name: string }): Promise<LevelAdmin>;
update(id: string, input: { name?: string; isActive?: boolean }): Promise<LevelAdmin>;
reorder(ids: string[]): Promise<LevelListResponse>;
```

- `LevelsModule` exporta `LevelsRepository` (T3, T5, T8a e T8b consomem `findById`/`listActive`).
- SQL de dados (depois do `CREATE TABLE`, antes do `ADD COLUMN "levelId"`):

```sql
INSERT INTO "StaffLevel" ("id","name","sortOrder","isActive","createdAt","updatedAt") VALUES
  ('level_coordinator','Coordenador',1,true,now(),now()),
  ('level_leader','Líder',2,true,now(),now()),
  ('level_employee','Funcionário',3,true,now(),now()),
  ('level_operator','Operador',4,true,now(),now());
```

**Steps:**
- [ ] **Step 1 (RED) — migração**, em `levels.repository.integration.spec.ts`, container próprio: `deployMigrations({ databaseUrl, until: '20261021130000_team_dispatch_schedule' })`, inserir 2 usuários por SQL, `deployMigrations({ databaseUrl })`.
  - `describe('migração 20261022090000_staff_level')`: "cria Coordenador, Líder, Funcionário e Operador, ativos, ordem 1 a 4" (linhas exatas); "usuários existentes ficam sem nível" (`levelId` NULL nos 2).
  - `describe('levels.repository')`: "userCount conta quem tem o nível"; "nível com usuário não se apaga (Restrict)".
- [ ] **Step 2 (RED) — service** em `levels.service.spec.ts`: "criar entra no fim (sortOrder 5) e ativo"; `it.each` "nome repetido sem caixa → 409 levels.name_taken" (`'funcionário'`, `' Funcionário '`); "renomear Funcionário para Colaborador devolve o novo nome"; "desativar nível em uso é aceito"; `it.each` "ordem inválida → 422 levels.invalid_order" (id repetido, faltando um, id estranho); "PATCH vazio → 400"; "id inexistente → 404 levels.not_found".
- [ ] **Step 3:** `timeout 600 gate --test src/modules/levels/levels.service.spec.ts` (cwd `backend/`) → FAIL.
- [ ] **Step 4:** schema, migração, módulo, contrato, `app.module.ts`; `bun run prisma generate`.
- [ ] **Step 5 (GREEN):** os specs da task e `timeout 600 gate --test src/modules/shifts/shift-migration.integration.spec.ts` (drift) → PASS.
- [ ] **Step 6:** `timeout 600 gate --changed --base origin/main` (cwd `backend/`) → PASS; GC2 à mão.

---

### Task 2: back — pessoa sem acesso no banco e no login

Depende de: T1.

**Crítico: autenticação + migração de produção — `User.email`/`password` passam a anuláveis com `hasAccess` e CHECK; login, sessão e refresh recusam quem não tem acesso.**

Tamanho: ~18 arquivos, a maioria ajuste de tipo de uma linha (`email` anulável) que o `tsc` aponta; separar o ajuste de tipo da migração deixaria o projeto sem compilar entre as tasks.

**Files:**
- Modify: `backend/prisma/schema.prisma` (`User.email String? @unique`, `password String?`, `hasAccess Boolean @default(true)`)
- Create: `backend/prisma/migrations/20261022100000_user_without_access/migration.sql`
- Modify: `backend/src/modules/auth/auth.service.ts` (`assertLoginAllowed`), `auth.repository.ts` (select `hasAccess`), `jwt.strategy.ts`, `refresh.service.ts` (recusar `hasAccess = false`; e-mail não nulo por guarda)
- Modify: `backend/src/schemas/contracts/user.schema.ts` (`email` nullable, `hasAccess`), `auth.schema.ts` (só se o `tsc` acusar), `team-whatsapp.schema.ts` e demais contratos com `email: z.string()` de pessoa → `.nullable()` (inclusive `manager.email` da lista de setores; o `managerId` já existe em `internal-sectors.repository.ts:11`)
- Modify (ajuste de tipo, só o que o `tsc` acusar): `users/users.service.ts`, `users/users.repository.ts` (`USER_SUMMARY_SELECT` + `hasAccess`), `team-whatsapp/team-whatsapp.roster.ts`, `team-whatsapp.repository.ts`, `team-whatsapp.service.ts` (`displayName`), `internal-communications/internal-communications.service.ts`, `internal-sectors/internal-sectors.repository.ts`, `staff-schedule/board.ts`, `staff-schedule/staff-schedule.repository.ts`, `consent/consent-admin.controller.ts`, `consent/consent-bulk-grant.service.ts`
- Create (teste): `backend/src/modules/users/user-access-migration.integration.spec.ts`
- Modify (teste): `backend/src/modules/auth/auth.service.spec.ts`, specs de `jwt.strategy`/`refresh.service` existentes, fixtures de `UserSummary` que o `tsc` acusar

**Contexto vinculado:**
- C2 (banco e login): `email String? @unique`, `password String?`, `hasAccess Boolean @default(true)`; CHECK `User_access_consistent` `("hasAccess" AND "email" IS NOT NULL AND "password" IS NOT NULL) OR (NOT "hasAccess" AND "email" IS NULL AND "password" IS NULL)`; login de quem não tem acesso → o mesmo 401, com verify do hash fictício, auditoria `auth.login_failed` reason `no_access`; sessão/refresh com `hasAccess = false` → 401.
- D1: sem acesso = `User` com `hasAccess false`, e-mail/senha NULL, `role VIEWER`, `mustChangePassword false`; Postgres aceita vários NULL no `@unique`.
- D2: login é por e-mail (`auth.service.ts:55`); `assertLoginAllowed` (`:81-92`) recusa `!hasAccess || password === null` antes do `argon2.verify`; nome exibido `name ?? email ?? ''`; auditorias de hoje com `email` passam a gravar `null`.
- Anti-objetivos: pessoa sem acesso não entra; ninguém perde setor, turno, escala ou histórico.
- GC3/GC4: só `20261022100000_user_without_access`; rodar o drift (o Prisma não gerencia CHECK; se o drift acusar a constraint, BLOCKED com a saída, não removê-la por conta própria).
- GC8: telefone, nome e e-mail nunca vão para log ou auditoria novos; a auditoria nova `auth.login_failed` reason `no_access` grava só `{ reason: 'no_access' }` (sem `email`, sem exceção).

**Interfaces:**
- SQL (depois do DDL gerado):

```sql
ALTER TABLE "User" ADD CONSTRAINT "User_access_consistent" CHECK (
  ("hasAccess" AND "email" IS NOT NULL AND "password" IS NOT NULL)
  OR (NOT "hasAccess" AND "email" IS NULL AND "password" IS NULL)
);
```

- `auth.service.ts`: `assertLoginAllowed(user, input)` → `if (!user.hasAccess || user.password === null) { await argon2.verify(DUMMY_PASSWORD_HASH, input.password); audit 'auth.login_failed' { reason: 'no_access' } /* sem email: GC8 */; throw new InvalidCredentialsError(); }` antes do verify real. `email` do token: o usuário que passou tem e-mail; tipar com guarda (`if (user.email === null) throw new InvalidCredentialsError()`), sem `!`.
- `jwt.strategy.ts`/`refresh.service.ts`: usuário com `hasAccess = false` → mesma recusa de usuário inativo de hoje.

**Steps:**
- [ ] **Step 1 (RED) — migração** em `user-access-migration.integration.spec.ts`: `deployMigrations({ until: '20261022090000_staff_level' })`, inserir 2 usuários (um ADMIN, um OPERATOR com setor e turno), `deployMigrations()`.
  - `describe('migração 20261022100000_user_without_access')`: "usuários existentes ficam com e-mail, senha, setor, turno e hasAccess true"; "aceita pessoa sem acesso com e-mail e senha NULL"; `it.each` "CHECK recusa estado misto" (`hasAccess true` + e-mail NULL; `hasAccess false` + senha preenchida); "duas pessoas sem acesso convivem com e-mail NULL".
- [ ] **Step 2 (RED) — login** em `auth.service.spec.ts`:
  - `describe('login de quem não tem acesso')`: `it.each` "→ InvalidCredentialsError e verify do hash fictício" (`{ hasAccess: false, password: null }`, `{ hasAccess: true, password: null }`): `argon2.verify` chamado com `DUMMY_PASSWORD_HASH`, auditoria `reason 'no_access'` sem a chave `email` no metadata, `refresh.issueNew` não chamado; "login com o telefone da pessoa (`'+5592991234567'`) → InvalidCredentialsError" (`findByEmail` → null).
  - specs de sessão/refresh: "hasAccess false → 401".
- [ ] **Step 3:** `timeout 600 gate --test src/modules/auth/auth.service.spec.ts` → FAIL.
- [ ] **Step 4:** schema, migração, auth, contratos, ajustes de tipo (`bun run prisma generate` e `bunx tsc --noEmit -p .` para achar todos; corrigir só o que acusar, sem mudar comportamento de quem tem acesso).
- [ ] **Step 5 (GREEN):** specs da task, `src/modules/users/users.service.shift.spec.ts` e o drift → PASS.
- [ ] **Step 6:** `timeout 600 gate --changed --base origin/main` (cwd `backend/`) → PASS; GC2 à mão.

---

### Task 3: back — Usuários: criar sem acesso, dar acesso, nível, reset bloqueado

Depende de: T2.

**Crítico: autorização + contrato público — `POST /users/:id/access` cria credencial; `hasAccess` muda a regra de setor obrigatório e do reset de senha; `userSummary` ganha nível.**

**Files:**
- Modify: `backend/src/modules/users/dto/create-user.dto.ts` (+ refine; spec `dto/create-user.dto.spec.ts`), `dto/update-user.dto.ts` (`levelId`), `dto/list-users.dto.ts` (`hasAccess?` na query)
- Create: `backend/src/modules/users/dto/grant-access.dto.ts`
- Modify: `backend/src/modules/users/users.controller.ts` (`POST :id/access`), `users.service.ts`, `users.repository.ts` (`USER_SUMMARY_SELECT` + `levelId` + `level`), `users.module.ts` (importa `LevelsModule`, exporta `UsersService` se ainda não exporta), erros do módulo
- Modify: `backend/src/schemas/contracts/user.schema.ts` (`levelId`, `level`, resposta do grant)
- Create (teste): `backend/src/modules/users/users.service.access.spec.ts`
- Modify (teste): `backend/src/modules/users/users.repository.integration.spec.ts`, `users.controller` spec existente (ou o e2e de roles do módulo, se for onde o `RolesGuard` é testado)

**Contexto vinculado:**
- C2 (API): `POST /users` `hasAccess?` (padrão true); `false` → `name` 1..120 e `phone` obrigatórios, `email`/`role` proibidos (400), `sectorId` anulável; resposta com `temporaryPassword: null`. `POST /users/:id/access` `{ email, role }` → `{ user, temporaryPassword }`, 409 `users.already_has_access`, 409 `user.email_taken`, 422 `user.sector_required`/`user.sector_invalid`. Reset em sem acesso → 422 `users.no_access`. PATCH `levelId` (ausente mantém, null limpa); `role` em sem acesso → 422 `users.no_access`; "não-ADMIN exige setor" só com acesso. `levelId` inexistente ou inativo diferente do atual → 422 `users.invalid_level`.
- C2 (listagem): `GET /users?hasAccess=true` em `ListUsersDto` — `'true'`/`'false'` viram boolean, outro valor → 400; sem o filtro lista todos, como hoje; o menu de atribuição de conversa (T10) pede `hasAccess=true` para não perder agente fora da 1ª página.
- D1: sem acesso grava `role 'VIEWER'`, `mustChangePassword false`, e-mail/senha NULL; dar acesso grava e-mail (trim/lowercase como o convite), papel, hash da temporária, `mustChangePassword true`, `hasAccess true` num único update; corrida de e-mail (P2002) → 409 `user.email_taken`.
- D12: a T6 cria pessoa por `createPersonWithoutAccess` e edita/muda de setor pelo `updateUser` de hoje.
- Spec §1: Usuários lista todos; quem é sem acesso não tem "Redefinir senha".
- Mapa: convite gera `temporaryPassword` (`users.service.ts:114-149`, argon2); "não-ADMIN exige setor ativo" (`:158-166` create, `:266-278` update); telefone via `user-phone.service.ts` (`:127-136`, `:174-190`); controller `@Roles('ADMIN')` na classe (`users.controller.ts:16`).
- GC8: auditorias novas `user.person_created` `{ actorId, sectorId, hasAccess: false }` e `user.access_granted` `{ actorId, role }`, sem e-mail, nome ou telefone.

**Interfaces:**
- Produces:

```ts
// users.service.ts
createPersonWithoutAccess(actorId: string, input: {
  name: string; phone: string; sectorId: string | null;
  levelId?: string | null; jobTitle?: string | null; shiftId?: string | null;
}): Promise<UserSummary>;   // usado pelo POST /users (hasAccess false) e pela T6
grantAccess(actorId: string, userId: string, input: { email: string; role: Role }): Promise<{ user: UserSummary; temporaryPassword: string }>;
// erros
noAccess(): DomainError;           // 422 'users.no_access'
alreadyHasAccess(): DomainError;   // 409 'users.already_has_access'
invalidLevel(): DomainError;       // 422 'users.invalid_level'
```

- `createPersonWithoutAccess` liga o Contato pelo telefone pelo mesmo caminho do convite (`UserPhoneService`), de modo que o número de um Contato existente liga a pessoa a ele.

**Steps:**
- [ ] **Step 1 (RED) — `users.service.access.spec.ts`:**
  - `describe('criar sem acesso')`: "grava hasAccess false, VIEWER, e-mail e senha null, mustChangePassword false e temporaryPassword null"; "sem setor é aceito"; "telefone de outra pessoa → o erro de hoje do UserPhoneService"; "nível Funcionário (level_employee) gravado".
  - `describe('dar acesso')`: "OPERATOR com setor ativo → hasAccess true, e-mail minúsculo, mustChangePassword true, temporaryPassword devolvida, auditoria sem e-mail"; "quem já tem acesso → 409 users.already_has_access"; "e-mail de outro → 409 user.email_taken"; "OPERATOR sem setor → 422 user.sector_required".
  - `describe('nível e regras de quem não tem acesso')`: "reset de senha → 422 users.no_access sem gravar"; "PATCH role em sem acesso → 422 users.no_access"; "PATCH sectorId null em sem acesso é aceito"; `it.each` "levelId inválido → 422 users.invalid_level" (inexistente; inativo e diferente do atual); "PATCH com o mesmo nível inativo atual é aceito".
- [ ] **Step 2 (RED) — DTO e controller:** `it.each` "POST hasAccess false com email ou role → 400"; "POST sem hasAccess segue exigindo email"; "gestor (OPERATOR) em POST /users/:id/access → 403" (aceite 1b). `users.repository.integration.spec.ts`: "listagem traz quem não tem acesso com email null e level { id, name, isActive }"; "hasAccess=true exclui quem não tem acesso; sem o filtro lista todos". DTO da listagem: `it.each` "hasAccess 'true' → true, 'false' → false, 'sim' → 400".
- [ ] **Step 3:** `timeout 600 gate --test src/modules/users/users.service.access.spec.ts` → FAIL.
- [ ] **Step 4:** DTOs, contrato, repository, service, controller, erros.
- [ ] **Step 5 (GREEN):** specs da task e os specs atuais de `users/` → PASS.
- [ ] **Step 6:** `timeout 600 gate --changed --base origin/main` (cwd `backend/`) → PASS; GC2 à mão.

---

### Task 4: back — pessoa sem acesso fora dos seletores de quem age

Depende de: T3.

**Crítico: autorização em 4 módulos — `hasAccess` passa a decidir quem pode ser gestor de setor, responsável de Demanda, atribuído a conversa e remetente da equipe.**

**Files:**
- Modify: `backend/src/modules/internal-sectors/internal-sectors.repository.ts` (`findMembers` com `eligible`, `:74-93`; `findValidManager`, `:94-103`)
- Modify: `backend/src/modules/internal-communications/internal-communications.service.ts` (responsável, `:649-655`)
- Modify: `backend/src/modules/chat/chat.service.ts` (`assignConversation`, `:155-162`)
- Modify: `backend/src/modules/team-whatsapp/team-actor.query.ts` (select `hasAccess`), `team-whatsapp.policy.ts` (`isTeamSender`, `:32-35`)
- Modify (teste): `internal-sectors.repository` integration spec (ou criar `internal-sectors.repository.access.integration.spec.ts`), spec do responsável em `internal-communications`, `backend/src/modules/chat/chat.assign.service.spec.ts`, `team-whatsapp.policy.spec.ts`

**Contexto vinculado:**
- GC5: `hasAccess: true` se soma aos filtros de hoje (papel ADMIN/SUPERVISOR/OPERATOR, ativo); a pessoa sem acesso fica só como destinatária, na escala e nas listas de pessoas.
- D3: notificações de Comunicados/Demandas são filtros de leitura de quem entra (sem fan-out); o seletor de responsável do front lê `GET /internal/sectors/:id/members?eligible=true`, então o filtro do servidor basta.
- Spec §1: quem não tem acesso não pode ser gestor de setor, nem enviar ou agendar.
- O `members` sem `eligible` (página do setor de hoje) continua listando todos os ativos, inclusive sem acesso.
- `isTeamSender` também serve à política da escala (GC8 da escala): não mudar nada além do `hasAccess`.

**Interfaces:**
- `TeamActor` ganha `hasAccess: boolean`; `isTeamSender(actor)` = hoje `&& actor.hasAccess`.
- `assignConversation`: usuário sem acesso → o mesmo erro de usuário inexistente de hoje (`chat.service.ts:159-161`), sem gravar nem auditar.

**Steps:**
- [ ] **Step 1 (RED):**
  - internal-sectors integration: "membros elegíveis excluem pessoa sem acesso e mantêm OPERATOR ativo"; "membros sem eligible incluem pessoa sem acesso"; "findValidManager de pessoa sem acesso → null".
  - internal-communications: "responsável sem acesso do próprio setor → ValidationError de hoje".
  - `chat.assign.service.spec.ts`: "atribuir conversa a pessoa sem acesso → erro, repo.assignConversation não chamado".
  - `team-whatsapp.policy.spec.ts`: `it.each` "isTeamSender falso sem acesso" (`{ role: 'ADMIN', hasAccess: false }`, gestor com setor e `hasAccess false`).
- [ ] **Step 2:** `timeout 600 gate --test src/modules/team-whatsapp/team-whatsapp.policy.spec.ts` → FAIL.
- [ ] **Step 3:** implementar os quatro pontos.
- [ ] **Step 4 (GREEN):** os specs da task e os specs atuais de `internal-sectors/`, `chat/` e `staff-schedule/` que usam `TeamActor` → PASS.
- [ ] **Step 5:** `timeout 600 gate --changed --base origin/main` (cwd `backend/`) → PASS; GC2 à mão.

---

### Task 5: back — página do setor: leitura e política do gestor

Depende de: T4.

**Crítico: autorização — política nova do gestor no próprio setor (P1) e exposição de telefone das pessoas do setor a ele.**

**Files:**
- Create: `backend/src/modules/sector-people/{sector-people.module.ts, sector-people.controller.ts, sector-people.service.ts, sector-people.policy.ts, sector-people.repository.ts, sector-people.errors.ts}`, `dto/{list-candidates.query.ts}`
- Create: `backend/src/schemas/contracts/sector-people.schema.ts`
- Modify: `backend/src/app.module.ts` (importa `SectorPeopleModule`)
- Create (teste): `sector-people.policy.spec.ts`, `sector-people.service.spec.ts`, `sector-people.repository.integration.spec.ts`

**Contexto vinculado:**
- C3 (leitura): `GET /` → `{ sector: { id, name, code, isActive, manager }, people (ativos do setor, nome asc pt-BR), options: { levels ativos, shifts ativos } }`; `GET /candidates?q=` até 20, ADMIN todos com `sectorId ≠ este`, gestor só sem setor e sem acesso; `GET /contact-candidates?q=` até 30, `person` pela relação `UserContact`; `sectorPersonSchema` com `editable 'full'` (sem acesso) / `'limited'` (com acesso) e `role null` quando sem acesso. Erros 403 `sector_people.forbidden`; 404 `sector_people.sector_not_found` só para ADMIN.
- P1: ator ativo, `hasAccess`, papel de escrita; ADMIN qualquer setor existente; gestor (`sector.managerId === actor.id`) só setor ativo; `canEditPerson` por campos (com acesso: só `levelId`, `jobTitle`, `shiftId`); `canPickExisting` (gestor: `sectorId null` e `hasAccess false`); `canRemove` (deste setor e sem acesso).
- D6: candidatos do gestor só sem setor e sem acesso. D8: `GET /contacts` não tem `@Roles`, então o gestor lê contatos; `contact-candidates` usa o mesmo filtro base da listagem de contatos (`contacts.service`). D9: a lista `GET /internal/sectors` (aberta a todos, `internal-sectors.controller.ts:23`) já traz `managerId` (`internal-sectors.repository.ts:11,14`); nada a mudar nela nesta task (o `manager.email` anulável é da T2).
- GC8: a página do setor mostra o telefone só a quem pode editá-lo — ADMIN recebe o de todos; o gestor recebe o de quem não tem acesso (`editable: 'full'`) e `phoneE164: null` de quem tem acesso (`editable: 'limited'`); nada de telefone/nome em log.
- `LevelsRepository.listActive` (T1); turnos ativos pelo repositório de `shifts` existente.

**Interfaces:**
- Produces:

```ts
// sector-people.policy.ts (puro)
type PeopleActor = { id: string; role: Role; isActive: boolean; hasAccess: boolean };
type PeopleSector = { id: string; isActive: boolean; managerId: string | null };
type PeoplePerson = { id: string; sectorId: string | null; hasAccess: boolean; isActive: boolean };
type PersonField = 'name' | 'phone' | 'levelId' | 'jobTitle' | 'shiftId';
export function canManageSector(actor: PeopleActor, sector: PeopleSector): boolean;
export function canEditPerson(sector: PeopleSector, person: PeoplePerson, fields: readonly PersonField[]): boolean;
export function canPickExisting(actor: PeopleActor, sector: PeopleSector, person: PeoplePerson): boolean;
export function canRemove(sector: PeopleSector, person: PeoplePerson): boolean;

// sector-people.service.ts
requireManageable(actorId: string, sectorId: string): Promise<{ actor: PeopleActor; sector: PeopleSector }>; // 403/404; usado pela T6
list(actorId: string, sectorId: string): Promise<SectorPeopleResponse>;
candidates(actorId: string, sectorId: string, q: string): Promise<SectorPeopleCandidatesResponse>;
contactCandidates(actorId: string, sectorId: string, q: string): Promise<SectorContactCandidatesResponse>;
// sector-people.repository.ts
findPerson(id: string): Promise<(PeoplePerson & { name: string | null }) | null>; // usado pela T6
toSectorPerson(row, viewer: { isAdmin: boolean }): SectorPerson; // mapper exportado, usado pela T6; phoneE164 null quando !isAdmin && hasAccess (GC8)
```

**Steps:**
- [ ] **Step 1 (RED) — `sector-people.policy.spec.ts`:**
  - `describe('canManageSector')` `it.each`: ADMIN em setor inativo → true; gestor de Operação em Operação → true; gestor de Operação em TI → false; gestor em setor inativo → false; gestor sem acesso → false; VIEWER → false.
  - `describe('canEditPerson')` `it.each`: sem acesso deste setor com `['name','phone']` → true; com acesso com `['levelId','jobTitle','shiftId']` → true; com acesso com `['name']` → false; pessoa de TI no setor Operação → false.
  - `describe('canPickExisting / canRemove')`: gestor × pessoa de TI → false; gestor × sem setor e sem acesso → true; gestor × sem setor com acesso → false; ADMIN × pessoa de TI → true; `canRemove` com acesso → false.
- [ ] **Step 2 (RED) — service e repository:**
  - `sector-people.service.spec.ts`: "gestor de Operação lista Operação com options de níveis ativos (sem o inativo)"; "gestor de Operação em TI → 403 sector_people.forbidden"; "ADMIN em setor inexistente → 404; gestor → 403"; `it.each` "telefone por quem vê" (gestor × pessoa com acesso → `phoneE164 null`; gestor × sem acesso → número; ADMIN × com acesso → número).
  - `sector-people.repository.integration.spec.ts`: "lista ativos do setor por nome com nível, função, turno e hasAccess"; "candidatos do gestor: só sem setor e sem acesso"; "candidatos do ADMIN excluem quem já está no setor"; "contact-candidates marca person { name, sectorName } no contato ligado a uma pessoa e busca por número".
- [ ] **Step 3:** `timeout 600 gate --test src/modules/sector-people/sector-people.policy.spec.ts` → FAIL.
- [ ] **Step 4:** módulo, contrato, controller (rotas GET), `app.module.ts`.
- [ ] **Step 5 (GREEN):** specs da task → PASS.
- [ ] **Step 6:** `timeout 600 gate --changed --base origin/main` (cwd `backend/`) → PASS; GC2 à mão.

---

### Task 6: back — página do setor: nova pessoa, dos contatos em lote, mover, editar, tirar

Depende de: T5.

**Crítico: autorização + transação — o gestor grava pessoas pela política P1; o lote cria pessoas uma a uma com telefone único, sem desfazer as que deram certo.**

**Files:**
- Create: `backend/src/modules/sector-people/sector-people-write.service.ts`, `dto/{create-sector-person.dto.ts, add-from-contacts.dto.ts, move-people.dto.ts, update-sector-person.dto.ts}`
- Modify: `sector-people.controller.ts` (POST `/`, POST `/from-contacts`, POST `/move`, PATCH `/:userId`, DELETE `/:userId`), `sector-people.module.ts` (importa `UsersModule`), `sector-people.repository.ts` (`findContactsForBatch`), `sector-people.errors.ts`, `backend/src/schemas/contracts/sector-people.schema.ts` (respostas de escrita)
- Create (teste): `sector-people-write.service.spec.ts`, `sector-people-write.integration.spec.ts`

**Contexto vinculado:**
- C3 (escrita): POST `/` (`.strict()`) → 201 sem acesso neste setor; `from-contacts` `{ contactIds 1..100, levelId?, shiftId }` (shiftId obrigatório, Q3) → `{ created, failed: { contactId, reason: 'invalid_phone' | 'phone_taken' | 'already_person' | 'contact_not_found' } }`, `levelId`/`shiftId` inválidos → 422 antes de criar; `move` `{ userIds 1..100 }` → `{ moved }`, fora do alcance → 403 sem mover ninguém, inexistente/inativo → 404 `sector_people.person_not_found`; PATCH com acesso + `name`/`phone` → 403; DELETE com acesso → 422 `sector_people.has_access`; body com `email`/`role`/`hasAccess`/`sectorId` → 400 pelo `.strict()` (o 403 de "dar acesso" do aceite 1b é o de `POST /users/:id/access`, testado na T3; aqui a recusa é 400 e é coerente).
- Q3: `shiftId` obrigatório (turno ativo) em `POST /` e `from-contacts`; ausente → 400 (DTO); inativo/inexistente → 422 `users.invalid_shift` antes de criar qualquer um.
- Aceite 1: os contatos adicionados aparecem na página do setor **e no envio** para o setor (lista do dia = `loadDayPeople` do `TeamWhatsappRepository`, assinatura de hoje).
- P1: `canManageSector`, `canEditPerson(fields)`, `canPickExisting`, `canRemove` (T5).
- D10: cada contato na sua transação, em ordem; erro vira `failed`; P2002 de `phoneE164` → `phone_taken`, de `contactId` → `already_person`. D11: contato sem nome → `name = phoneE164`. D12: criar por `UsersService.createPersonWithoutAccess`; editar, mover e tirar pelo `updateUser` de hoje, depois da política.
- Spec §2: o gestor não dá/tira acesso, não muda perfil/e-mail, não move para outro setor, não mexe em pessoa de setor que não gerencia (403). Telefone único e ligado ao Contato (`UserPhoneService`).
- GC8: auditoria `sector_people.added` `{ actorId, sectorId, source: 'new' | 'contacts', created, failed }`, `sector_people.moved` `{ actorId, sectorId, count }`, `sector_people.removed` `{ actorId, sectorId, userId }`; sem nome/telefone. Respostas pelo mapper da T5 `toSectorPerson(row, { isAdmin })`: `phoneE164: null` ao gestor quando a pessoa tem acesso (`editable: 'limited'`).

**Interfaces:**
- Produces:

```ts
// sector-people-write.service.ts
create(actorId: string, sectorId: string, input: CreateSectorPersonInput): Promise<SectorPerson>;
addFromContacts(actorId: string, sectorId: string, input: { contactIds: string[]; levelId?: string | null; shiftId: string }): Promise<AddFromContactsResponse>;
move(actorId: string, sectorId: string, userIds: string[]): Promise<{ moved: SectorPerson[] }>;
update(actorId: string, sectorId: string, userId: string, patch: UpdateSectorPersonInput): Promise<SectorPerson>;
remove(actorId: string, sectorId: string, userId: string): Promise<void>;
```

- Mapeamento de erro do telefone: o erro de telefone inválido e o de número de outra pessoa que o `UserPhoneService` já lança (conferir os códigos em `backend/src/modules/users/user-phone.service.ts`) viram `invalid_phone`/`phone_taken` no lote; nas rotas de item único seguem como hoje.

**Steps:**
- [ ] **Step 1 (RED) — `sector-people-write.service.spec.ts`:**
  - `describe('nova pessoa')`: "gestor de Operação cria sem acesso em Operação com nível e turno" (aceite 1b); "gestor de Operação criando em TI → 403 sem chamar UsersService".
  - `describe('dos contatos')`: "ADMIN adiciona 3 contatos com Funcionário e um turno ativo: 3 criados, ligados aos contatos, nível level_employee, shiftId gravado" (aceite 1); "3 contatos, um com número de outra pessoa: 2 criados, 1 phone_taken" (R8); `it.each` "motivos por item" (`already_person`, `contact_not_found`, `invalid_phone`); "levelId inativo → 422 users.invalid_level e nenhum criado"; `it.each(['create', 'addFromContacts'])` "shiftId inativo → 422 users.invalid_shift, nenhum criado" (Q3); "contato sem nome vira pessoa com o número como nome"; "ids repetidos criam uma vez".
  - `describe('mover, editar e tirar')`: "gestor move pessoa sem setor e sem acesso para Operação"; "gestor movendo pessoa de TI → 403 e ninguém movido"; "ADMIN move pessoa de TI para RH"; "gestor define nível de pessoa com acesso de Operação" (aceite 1b); "gestor editando nome de pessoa com acesso → 403"; "gestor editando pessoa de TI → 403 sem gravar"; "tirar do setor pessoa sem acesso → sectorId null"; "tirar pessoa com acesso → 422 sector_people.has_access".
- [ ] **Step 2 (RED) — DTO e integração:** `it.each` "body com email, role, hasAccess ou sectorId → 400"; `it.each` "sem shiftId → 400" (DTO de `POST /` e de `from-contacts`, Q3); `sector-people-write.integration.spec.ts`: "lote real com testcontainers: dois criados e o terceiro com telefone repetido fica em failed sem desfazer os dois"; "depois do lote de 3 contatos com turno Noite no RH, `loadDayPeople` do RH na data traz os 3 com o turno" (aceite 1, envio).
- [ ] **Step 3:** `timeout 600 gate --test src/modules/sector-people/sector-people-write.service.spec.ts` → FAIL.
- [ ] **Step 4:** DTOs, service, controller, repository, contrato.
- [ ] **Step 5 (GREEN):** specs da task e os da T5 → PASS.
- [ ] **Step 6:** `timeout 600 gate --changed --base origin/main` (cwd `backend/`) → PASS; GC2 à mão.

---

### Task 7: back — setores do envio: migração, backfill e quem vê/cancela

Depende de: T6.

**Crítico: autorização + migração com backfill — Agendados e cancelamento passam a exigir que todos os setores do envio sejam do gestor (Recentes segue por autor, como hoje); envios existentes ganham uma linha de setor.**

**Files:**
- Modify: `backend/prisma/schema.prisma` (model `TeamWhatsappDispatchSector`; `TeamWhatsappDispatch.sectors`; `TeamWhatsappRecipient.sectorId/sectorName/levelName`)
- Create: `backend/prisma/migrations/20261022110000_team_dispatch_sectors/migration.sql`
- Modify: `backend/src/modules/team-whatsapp/team-whatsapp.repository.ts` (`createDispatch` grava `sectors` e o snapshot do destinatário; `listScheduled`, `listDispatches`, `findDispatchForCancel`), `team-whatsapp-schedule.service.ts` (`listScheduled`, `requireSectorOf`, `:120-148`), `team-whatsapp.service.ts` (`listDispatches`, `toListItem`, ramo setor grava `sectors: [o setor]` e `sectorId/sectorName` nos destinatários), `backend/src/schemas/contracts/team-whatsapp.schema.ts` (C6 da lista)
- Create (teste): `backend/src/modules/team-whatsapp/team-dispatch-sectors.integration.spec.ts`, `backend/src/modules/team-whatsapp/team-whatsapp.service.single-sector.spec.ts` (caracterização, Step 0)
- Modify (teste): `team-whatsapp.service.schedule.spec.ts`, `team-whatsapp.service.list.spec.ts`

**Contexto vinculado:**
- C6 (colunas e lista): junção `TeamWhatsappDispatchSector { dispatchId, sectorId sem FK, sectorName snapshot, @@id([dispatchId, sectorId]), @@index([sectorId]) }`; destinatário + `sectorId`, `sectorName`, `levelName`; alvo setor grava `targetId` = primeiro setor e uma linha por setor; lista ganha `sectors[]` e `sectorName`/`levelName` em `recipients`/`unselected`/`off` (foto antiga → null).
- C7: Agendados do gestor só `SECTOR` com `sectors` não vazio e todos em `managedSectorIds`; cancelar: ADMIN qualquer, gestor só se todo setor passa por `canSendToSector`, senão 403; Recentes: ADMIN todos, gestor = `authorId = ele`, exatamente como hoje (`team-whatsapp.repository.ts:427-429`, `team-whatsapp.service.ts:284-286`), sem condição de setor (Q1; spec §4 "em Recentes, vê os envios que ele mesmo fez, como hoje").
- R5 (anti-objetivo "um setor sem nível = hoje"): antes de qualquer mudança, o Step 0 fixa os argumentos de `createDispatch` de hoje num teste de caracterização; esta task e a T8b só acrescentam chaves ao literal.
- D5: query `sectors: { some: {}, every: { sectorId: { in: managed } } }`; backfill com `COALESCE(s."name", split_part(d."targetLabel", ' · ', 1))`.
- Anti-objetivo: envio de um setor sem nível não muda; histórico de quem já existe não se perde.
- GC3/GC4: só `20261022110000_team_dispatch_sectors`; rodar o drift.
- O `levelName` é gravado a partir da T8b; nesta task fica `null` nos envios novos.

**Interfaces:**
- SQL de dados (depois do DDL gerado):

```sql
INSERT INTO "TeamWhatsappDispatchSector" ("dispatchId","sectorId","sectorName")
  SELECT d."id", d."targetId", COALESCE(s."name", split_part(d."targetLabel", ' · ', 1))
  FROM "TeamWhatsappDispatch" d LEFT JOIN "Sector" s ON s."id" = d."targetId"
  WHERE d."targetType" = 'SECTOR';
UPDATE "TeamWhatsappRecipient" r SET "sectorId" = ds."sectorId", "sectorName" = ds."sectorName"
  FROM "TeamWhatsappDispatchSector" ds
  WHERE r."dispatchId" = ds."dispatchId";
```

- Repository:

```ts
createDispatch(input: { …de hoje; sectors: { sectorId: string; sectorName: string }[]; recipients: (NewTeamRecipient & { sectorId: string | null; sectorName: string | null; levelName: string | null })[] }): Promise<TeamCreatedDispatch>;
listScheduled(onlySectorIds: readonly string[] | null): Promise<ScheduledRow[]>; // gestor: every/some acima
listDispatches(authorId: string | null): Promise<TeamDispatchRow[]>; // assinatura e filtro de hoje (null = ADMIN); só o select ganha sectors e o snapshot
findDispatchForCancel(id: string): Promise<{ id; targetType; targetId; state; sectorIds: string[] } | null>;
```

**Steps:**
- [ ] **Step 0 (caracterização, VERDE no código atual, antes de mexer em qualquer arquivo)** — `team-whatsapp.service.single-sector.spec.ts`, harness dos specs atuais de `team-whatsapp.service`: `describe('um setor sem nível = hoje')` `it.each(['now', 'shift_start'])` "createDispatch recebe o mesmo de hoje": envio a Produção, turno Noite, data `2026-10-21`, sem nível; `expect(repo.createDispatch).toHaveBeenCalledWith(expect.objectContaining(<literal>))` / `toMatchObject(<literal>)` com o literal copiado da chamada real de hoje: `targetType 'SECTOR'`, `targetId`, `targetLabel 'Produção · Noite · 21/10'`, `shift*`, `rosterDate`, `includeOff`, destinatários (ids, status, turno) e `roster.working/off`. Rodar `timeout 600 gate --test src/modules/team-whatsapp/team-whatsapp.service.single-sector.spec.ts` → PASS **antes** do Step 1. Daqui em diante só se acrescentam chaves ao literal (nesta task `sectors: [{ sectorId, sectorName: 'Produção' }]` e `sectorId`/`sectorName` nos destinatários, `levelName: null`); nenhuma chave antiga muda.
- [ ] **Step 1 (RED) — migração e queries** em `team-dispatch-sectors.integration.spec.ts`: `deployMigrations({ until: '20261022100000_user_without_access' })`; inserir por SQL um envio a setor Produção (2 destinatários), um a setor apagado com `targetLabel 'Antigo · Noite · 21/10'` e um alvo pessoa; `deployMigrations()`.
  - `describe('migração 20261022110000_team_dispatch_sectors')`: "envio a Produção ganha uma linha (Produção) e os destinatários sectorName Produção"; "setor apagado usa 'Antigo' do rótulo"; "alvo pessoa não ganha linha"; "rótulo, turno, foto e status ficam iguais".
  - `describe('quem vê — Agendados')` `it.each` (R6, `listScheduled`): gestor de A × envio de A → vê; × A+B → não vê; × B → não vê; ADMIN × A+B → vê.
  - `describe('quem vê — Recentes')` (R6, `listDispatches`, por autor como hoje): "gestor autor vê o próprio envio A+B"; "gestor não vê envio de outro autor"; "ADMIN (null) vê todos".
- [ ] **Step 2 (RED) — service:** `team-whatsapp.service.schedule.spec.ts`: "gestor de A cancela envio de A (igual a hoje)"; "gestor de A cancela A+B → 403 sem cancelar"; "ADMIN cancela A+B". `team-whatsapp.service.list.spec.ts`: "item traz sectors [{ id, name }] e recipients com sectorName; foto antiga → sectorName/levelName null"; "envio novo de um setor grava sectors com o setor e sectorName nos destinatários, targetId igual ao de hoje" (é o literal do Step 0 com as chaves novas acrescentadas).
- [ ] **Step 3:** `timeout 600 gate --test src/modules/team-whatsapp/team-dispatch-sectors.integration.spec.ts` → FAIL.
- [ ] **Step 4:** schema, migração, repository, services, contrato; `bun run prisma generate`.
- [ ] **Step 5 (GREEN):** specs da task, os specs atuais de `team-whatsapp/` (inclusive o disparo agendado do worker) e o drift → PASS.
- [ ] **Step 6:** `timeout 600 gate --changed --base origin/main` (cwd `backend/`) → PASS; GC2 à mão.

---

### Task 8a: back — envio: leitura de vários setores e níveis (roster, alvos, filtro e rótulo puros)

Depende de: T7.

**Crítico: autorização + contrato público — `GET …/roster` passa a receber `sectorIds[]`; cada setor passa pela política (403) antes de ler pessoas; `targets` ganha `levels`.**

**Files:**
- Modify: `backend/src/modules/team-whatsapp/dto/roster-query.dto.ts` (`sectorIds` 1..100 por vírgula, `sectorId` como apelido), `backend/src/schemas/contracts/team-whatsapp.schema.ts` (C4: `targets.levels`, resposta do roster com `sectors[]`, `TeamRosterMember.level`)
- Modify: `team-whatsapp.service.ts` (`targets`, `roster`), `team-whatsapp.repository.ts` (`loadDayPeople` traz `levelId` e `level.name`), `team-whatsapp.roster.ts` (`passesLevel`, `sectorTargetLabel`, puros), `team-whatsapp.module.ts` (importa `LevelsModule`)
- Create (teste): `backend/src/modules/team-whatsapp/team-whatsapp.roster.spec.ts` (rótulo e `passesLevel`; o arquivo não existe hoje)
- Modify (teste): `team-whatsapp.service.roster.spec.ts`; spec do DTO do roster (criar `dto/roster-query.dto.spec.ts` se não houver)

**Contexto vinculado:**
- C4: `targets.levels` (ativos); `GET roster?sectorIds=a,b&date` (1..100, repetidos uma vez; `sectorId` sozinho aceito) → `{ date, shiftStarts, sectors: { sectorId, name, members }[] }`, setores por nome pt-BR, `members[].level`.
- GC6: cada setor passa por `canSendToSector`; um falho → 403 `team_whatsapp.forbidden` antes de ler pessoas. `userIds` não abre setor.
- GC12: rótulo `<setores> · <níveis>? · <turno|todos os turnos> · dd/MM · seleção de N?`; setores por nome (`localeCompare(…, 'pt-BR')`), até dois nomes por `, ` e com mais de dois os dois primeiros + ` +N`; níveis pelo `sortOrder`, `Sem nível` por último, mesma regra; parte de nível omitida sem filtro; um setor sem nível = rótulo de hoje.
- C5 (filtro de nível, usado pela T8b): sem `levelIds` (ou vazio) e sem `withoutLevel` = todos; senão passa `levelId ∈ levelIds`, ou sem nível com `withoutLevel = true`.
- D7: `sectorId` apelido de `[sectorId]` (aba aberta no deploy não recebe 400). Uma pessoa aparece em um setor só no dia (`dayMembers` já tira quem trabalha em outro setor).
- Risco aceito M2: roster multi-setor resolve um setor por vez (`Promise.all` de `loadDayPeople`).
- Nesta task `sectorTargetLabel` e `passesLevel` ficam prontos e testados; o POST passa a usá-los na T8b.

**Interfaces:**
- Produces:

```ts
// team-whatsapp.roster.ts
export type LevelFilter = { levelIds: ReadonlySet<string>; withoutLevel: boolean } | null; // null = todos
export function passesLevel(member: { levelId: string | null }, filter: LevelFilter): boolean;
export function sectorTargetLabel(input: {
  sectorNames: readonly string[]; levelNames: readonly string[]; // já ordenados; 'Sem nível' no fim
  shiftName: string | null; date: string; selected: number | null;
}): string;
// GC12: sectorTargetLabel({ sectorNames: ['Produção'], levelNames: [], shiftName: 'Noite', date: '2026-10-21', selected: 2 }) === 'Produção · Noite · 21/10 · seleção de 2'
//       sectorTargetLabel({ sectorNames: ['Logística', 'Operação', 'RH', 'TI'], levelNames: ['Coordenador'], shiftName: 'Noite', date: '2026-10-22', selected: null }) === 'Logística, Operação +2 · Coordenador · Noite · 22/10'
// team-whatsapp.service.ts
roster(actor, input: { sectorIds: string[]; date: string }): Promise<TeamRosterResponse>; // requireSectors (403 no primeiro que falhar) → por setor loadDayPeople + dayMembers
```

**Steps:**
- [ ] **Step 1 (RED):** `team-whatsapp.roster.spec.ts` `it.each` do rótulo (1, 2, 3 e 4 setores; com e sem nível; `Sem nível` por último; seleção; o exemplo `'Logística, Operação +2 · Coordenador · Noite · 22/10'`) e `it.each` de `passesLevel` (null → passa; Coordenador × coordenador/sem nível; `withoutLevel` × sem nível; os dois juntos). `team-whatsapp.service.roster.spec.ts`: "roster de TI + Operação devolve sectors por nome com members[].level"; "gestor de Operação pedindo roster de Operação + TI → 403"; "sectorId sozinho = sectorIds [sectorId]"; "targets.levels só ativos". DTO do roster: "sectorIds vazio → falha"; "101 ids → falha"; "repetidos contam uma vez".
- [ ] **Step 2:** `timeout 600 gate --test src/modules/team-whatsapp/team-whatsapp.roster.spec.ts` → FAIL.
- [ ] **Step 3:** contrato (C4), DTO do roster, roster puro, repository, service, module.
- [ ] **Step 4 (GREEN):** specs da task, `team-whatsapp.service.single-sector.spec.ts` (T7) e os specs atuais de `src/modules/team-whatsapp/` (um por um com `gate --test`) → PASS.
- [ ] **Step 5:** `timeout 600 gate --changed --base origin/main` (cwd `backend/`) → PASS; GC2 à mão.

---

### Task 8b: back — POST de envio para vários setores e por nível; gravação e agendamento

Depende de: T8a.

**Crítico: autorização + contrato público — o alvo setor do POST vira `sectorIds[]` com filtro de nível; cada setor passa pela política (403) e a lista conferida é refeita sobre vários setores antes de gravar.**

**Files:**
- Modify: `backend/src/modules/team-whatsapp/dto/create-team-dispatch.dto.ts` (+ `dto/create-team-dispatch.dto.spec.ts`), `backend/src/schemas/contracts/team-whatsapp.schema.ts` (C5, `RosterPerson` com `sectorName`/`levelName`)
- Modify: `team-whatsapp.service.ts` (`resolveSector` → vários setores, gravação), `team-whatsapp.repository.ts` (`createDispatch` grava `levelName`), `team-whatsapp.roster.ts` (`eligibleFor` com `passesLevel`, `rosterSnapshot` com `sectorName`/`levelName`), `team-whatsapp.errors.ts` (`invalidLevel`)
- Create (teste): `backend/src/modules/team-whatsapp/team-whatsapp.service.sectors.spec.ts`
- Modify (teste): `dto/create-team-dispatch.dto.spec.ts`, `team-whatsapp.service.single-sector.spec.ts` (só acrescentar `sectorName`/`levelName` à foto no literal; a entrada do teste pode passar a `sectorIds: [id]` (ou pelo DTO) quando o tipo do service mudar, sem mexer no literal esperado)

**Contexto vinculado:**
- C5: `{ type: 'sector', sectorIds 1..100, shiftId?, userIds? 1..500, date, includeOff?, levelIds? 0..50, withoutLevel? }`; sem filtro = todos; passa `levelId ∈ levelIds` ou sem nível com `withoutLevel`; 422 `team_whatsapp.invalid_level` (inexistente ou inativo); ordem remetente → política de cada setor → turno → níveis → lista → seleção.
- C6 (gravação): `sectors` = setores do pedido com o nome; destinatário com `sectorId`/`sectorName` do setor em que entrou e `levelName` do nível na hora; foto com `sectorName`/`levelName`.
- GC6: cada setor passa por `canSendToSector`; um falho → 403 antes de tudo. GC7: lista refeita com os mesmos setores, níveis, data, turno e `includeOff`; fora dela → 422 sem efeito; repetidos uma vez. GC12: rótulo `<setores> · <níveis>? · <turno|todos os turnos> · dd/MM · seleção de N?`, dois nomes + `+N`, `Sem nível` por último.
- D7: `sectorId` apelido de `[sectorId]`. Uma pessoa aparece em um setor só no dia (`dayMembers` já tira quem trabalha em outro setor); mesmo assim a união deduplica por `userId`, ficando no primeiro setor pela ordem do nome.
- Spec §4: pessoa sem setor não entra; data, turno, "incluir quem está de folga" e agendamento iguais a hoje. Anti-objetivo: um setor sem nível = envio de hoje (R5).
- R5: o teste de caracterização da T7 (`team-whatsapp.service.single-sector.spec.ts`, verde no código de antes) continua verde; a T7 já acrescentou `levelName: null` aos destinatários; esta task só acrescenta `sectorName`/`levelName` à foto no literal, sem mudar chave antiga, e pode trocar a entrada do teste para `sectorIds: [id]` (ou passá-la pelo DTO) sem mexer no literal esperado.
- Aceite 7: agendar para vários setores no início do turno sai uma vez, só para a lista conferida, e cancela como hoje (cancelamento de vários setores: C7, T7).
- Da T8a: `passesLevel(member, filter)`, `LevelFilter`, `sectorTargetLabel({ sectorNames, levelNames, shiftName, date, selected })` e `requireSectors` (403 no primeiro setor que falhar).

**Interfaces:**
- Produces:

```ts
// errors
invalidLevel(): DomainError; // 422 'team_whatsapp.invalid_level'
```

- `resolveSector` vira: `requireSectors(actor, ids)` (T8a; todos, 403 no primeiro que falhar) → `requireShift` → `requireLevels` → por setor `loadDayPeople` + `dayMembers` + `eligibleFor` + `passesLevel` → união → `selectMembers` → `ResolvedTarget` com `sectors[]`; rótulo por `sectorTargetLabel`. Se for mais longo que 50 linhas, quebrar em funções puras em `team-whatsapp.roster.ts` (GC2).

**Steps:**
- [ ] **Step 1 (RED) — `team-whatsapp.service.sectors.spec.ts`:**
  - `describe('vários setores e nível')`: "TI + Operação + Coordenador: destinatários só os coordenadores dos dois, sectorName de cada um, levelName Coordenador" (aceite 3); "withoutLevel sozinho envia só a quem não tem nível"; "Coordenador + Sem nível juntos"; "sem filtro de nível envia a todos dos setores".
  - `describe('recusas')`: "gestor de Operação pedindo Operação + TI → 403 antes de turno e seleção" (aceite 4); `it.each` "nível inválido → 422 invalid_level sem efeito" (inexistente, inativo); `it.each` "seleção fora da lista → 422 invalid_selection sem efeito" (não coordenador; pessoa de setor fora do pedido; pessoa sem setor).
  - "body com sectorId sozinho = sectorIds [sectorId]". R5 fica no `team-whatsapp.service.single-sector.spec.ts` da T7 (só acrescentar `levelName` ao literal; nenhuma chave antiga muda).
  - `describe('agendar vários setores')`: "agendar TI + Operação no início da Noite grava SCHEDULED só para a lista conferida, com sectors [Operação, TI]" (aceite 7).
- [ ] **Step 2 (RED) — DTO:** `dto/create-team-dispatch.dto.spec.ts`: "sectorIds vazio → falha"; "levelIds com 51 → falha"; "sectorId e sectorIds juntos → falha".
- [ ] **Step 3:** `timeout 600 gate --test src/modules/team-whatsapp/team-whatsapp.service.sectors.spec.ts` → FAIL.
- [ ] **Step 4:** contrato (C5, `RosterPerson`), DTO, roster puro (`eligibleFor`, `rosterSnapshot`), repository, service, erro.
- [ ] **Step 5 (GREEN):** specs da task, `team-whatsapp.service.single-sector.spec.ts` (R5) e todos os specs atuais de `src/modules/team-whatsapp/` (um por um com `gate --test`) → PASS.
- [ ] **Step 6:** `timeout 600 gate --changed --base origin/main` (cwd `backend/`) → PASS; GC2 à mão.

---

### Task 9: front — tela Níveis e item de menu

Depende de: T1. Risco: médio. Effort: high (A/B).

**Files:**
- Create: `frontend/src/features/levels/{schemas.ts, api.ts, error-messages.ts}`, `frontend/src/features/levels/components/{level-form-dialog.tsx, levels-table.tsx}` (+ specs)
- Create: `frontend/src/routes/_authenticated/niveis/index.tsx` (+ `index.spec.tsx`)
- Modify: `frontend/src/lib/nav.ts` (`Níveis` em `admin`, depois de `Turnos`, `roles: ['ADMIN']`) + spec de nav, se existir
- Modelo a copiar: `frontend/src/features/shifts/**` e `routes/_authenticated/turnos/**`

**Contexto vinculado:**
- C1: `GET/POST/PATCH /internal/levels`, `PUT /internal/levels/order`; `LevelAdmin { id, name, isActive, sortOrder, userCount }`; erros 404 `levels.not_found`, 409 `levels.name_taken`, 422 `levels.invalid_order`; sem apagar.
- Spec §3: nome, ordem, ativo/inativo, só ADMIN, padrão Turnos.
- GC10: erro por `readApiErrorBody` (`lib/api-error.ts`). GC11: `Níveis`, `Novo nível`, `Editar`, `Desativar`, `Reativar`, `Subir`, `Descer`; `levels.name_taken` → `Já existe um nível com esse nome.`. GC14: rota nova só `/niveis`; sem componente novo em `components/ui/`.

**Steps:**
- [ ] **Step 1 (RED):** `index.spec.tsx`: "lista Coordenador, Líder, Funcionário, Operador na ordem com a contagem de pessoas"; "Novo nível chama POST com o nome aparado"; "renomear Funcionário chama PATCH { name }" (aceite 6); "Desativar chama PATCH { isActive: false } e mostra Reativar"; "Subir chama PUT order com a ordem trocada"; "409 mostra 'Já existe um nível com esse nome.'". Spec de nav: "Níveis só para ADMIN, depois de Turnos".
- [ ] **Step 2:** `timeout 600 gate --test src/routes/_authenticated/niveis/index.spec.tsx` (cwd `frontend/`) → FAIL.
- [ ] **Step 3:** implementar.
- [ ] **Step 4 (GREEN):** specs da task → PASS.
- [ ] **Step 5:** `timeout 600 gate --changed --base origin/main` (cwd `frontend/`) → PASS; GC2 à mão.

---

### Task 10: front — Usuários: acesso, dar acesso, nível; atribuição de conversa

Depende de: T3 (e T1 para os níveis). Risco: médio.

**Files:**
- Modify: `frontend/src/features/users/schemas.ts` (`email: string | null`, `hasAccess`, `levelId`, `level`; form com `Acesso ao sistema`; setor obrigatório só com acesso e papel ≠ ADMIN), `api.ts` (`useGrantAccess`, `useActiveLevels` lendo `GET /internal/levels` e filtrando ativos), `error-messages.ts`
- Modify: `frontend/src/features/users/components/invite-user-dialog.tsx`, `edit-user-dialog.tsx`, `role-sector-selects.tsx` (só se precisar esconder papel)
- Create: `frontend/src/features/users/components/{grant-access-dialog.tsx, level-select.tsx}` (+ specs)
- Modify: `frontend/src/routes/_authenticated/users/index.tsx` (+ spec): coluna Email `—` quando null; coluna Perfil `—` sem acesso; coluna Acesso `Sem acesso`; menu sem `Redefinir senha` e com `Dar acesso` para sem acesso
- Modify: `frontend/src/features/users/api.ts` `useUsers(page, pageSize, filters?: { hasAccess?: true })` (manda `hasAccess=true` na query quando pedido; chamadas atuais não mudam)
- Modify: `frontend/src/features/chat/components/assign-menu.tsx` (+ spec): `useUsers(1, 100, { hasAccess: true })` (filtro no servidor, T3), sem filtrar no cliente

**Contexto vinculado:**
- C2 (API): `POST /users` `hasAccess` (false: sem e-mail/papel, nome e telefone obrigatórios, setor opcional), resposta `temporaryPassword: null`; `POST /users/:id/access` `{ email, role }` → `{ user, temporaryPassword }`; 409 `users.already_has_access`, 409 `user.email_taken`, 422 `user.sector_required`; reset → 422 `users.no_access`; PATCH `levelId`; 422 `users.invalid_level`.
- Spec §1: na tela Usuários todos aparecem; coluna Acesso `Sem acesso`; sem acesso não tem `Redefinir senha`; dar acesso depois = e-mail + perfil, senha temporária como no convite. §3: convite e edição ganham Nível; nível inativo some do cadastro novo, mas aparece se já é o da pessoa.
- GC5: atribuição de conversa só para quem tem acesso (o servidor também recusa, T4). O menu (`assign-menu.tsx:25`, hoje `useUsers(1, 100)`, só a 1ª página) pede `GET /users?hasAccess=true` (C2, T3): filtrar no cliente sobre a 1ª página esconderia agentes reais quando houver pessoas sem acesso. `GET /internal/levels` é só ADMIN, e esta tela também.
- GC10/GC11: `Acesso ao sistema`, `Sem acesso`, `Com acesso`, `Dar acesso`, `Nível`, `Sem nível`; mensagens de `users.no_access`, `users.already_has_access`, `users.invalid_level`.

**Steps:**
- [ ] **Step 1 (RED):**
  - `invite-user-dialog.spec`: "Sem acesso esconde e-mail, perfil e senha e envia hasAccess false"; "Sem acesso não exige setor"; "Com acesso segue o fluxo de hoje"; "Nível lista só ativos".
  - `grant-access-dialog.spec`: "envia { email, role } e mostra a senha temporária"; "409 already_has_access mostra a mensagem".
  - `users/index.spec`: "pessoa sem acesso: Email —, Perfil —, Acesso 'Sem acesso', sem 'Redefinir senha', com 'Dar acesso'" (aceite 2).
  - `edit-user-dialog.spec`: "nível inativo atual aparece selecionado"; "sem acesso não mostra perfil".
  - `assign-menu.spec`: "o pedido leva hasAccess=true" (`useUsers` chamado com `(1, 100, { hasAccess: true })`); spec de `api.ts`/`useUsers`: "com { hasAccess: true } a query tem hasAccess=true; sem filtro, a query de hoje".
- [ ] **Step 2:** `timeout 600 gate --test src/routes/_authenticated/users/index.spec.tsx` → FAIL.
- [ ] **Step 3:** implementar.
- [ ] **Step 4 (GREEN):** specs da task e os specs atuais de `features/users/` → PASS.
- [ ] **Step 5:** `timeout 600 gate --changed --base origin/main` (cwd `frontend/`) → PASS; GC2 à mão.

---

### Task 11: front — página do setor: pessoas, editar, tirar, tela vazia e acesso do gestor

Depende de: T6 e T10. Risco: médio. Effort: high (A/B).

**Files:**
- Create: `frontend/src/features/sector-people/{schemas.ts, api.ts, error-messages.ts}`, `components/{people-table.tsx, edit-person-dialog.tsx, empty-sector.tsx}` (+ specs)
- Modify: `frontend/src/routes/_authenticated/setores/$sectorId.tsx` (+ spec), `setores/index.tsx` (+ spec)
- Modify: `frontend/src/lib/nav.ts` (`/setores` com `roles: WRITE_INTERNAL_ROLES`) + spec de nav; guard de `setores/new.tsx` continua só ADMIN
- Modify: `frontend/src/features/internal-admin/components/sector-form.tsx` (+ spec): seletor de Gestor só `hasAccess`

**Contexto vinculado:**
- C3: `GET /internal/sectors/:id/people` → `{ sector, people, options }`; `SectorPerson { id, name, phoneE164, hasAccess, role, level, jobTitle, shift, editable }` (GC8: `phoneE164` vem `null` ao gestor quando `editable: 'limited'`; a tela mostra `—`); PATCH `/:userId` (`editable 'limited'` → só nível, função, turno); DELETE `/:userId` só sem acesso (422 `sector_people.has_access`); 403 `sector_people.forbidden`.
- Spec §2: lista com nome, nível, função, turno e acesso; ações `Editar` (mesmo cadastro) e `Tirar do setor` (só sem acesso, fica `Sem setor`); botão `Adicionar pessoas` para ADMIN e gestor do setor. §3: a página mostra o nível e o Gestor. §5: setor sem membros → `Ninguém neste setor ainda.` + `Adicionar pessoas`.
- D9: `/setores` aberta a `WRITE_INTERNAL_ROLES`; não-ADMIN vê só os setores que gerencia (lista `GET /internal/sectors` filtrada pelo gestor = usuário logado), sem `Novo setor`, e `Você não gerencia nenhum setor.` se vazia; `/setores/$sectorId` para não-ADMIN mostra só cabeçalho (do `GET …/people`) e pessoas, sem editar setor nem números; 403 → `Você não gerencia este setor.`.
- GC5: seletor de Gestor só lista quem tem acesso. GC10/GC11: rótulos e mensagens de `sector_people.*`.
- O botão `Adicionar pessoas` desta task chama `onAddPeople()` (estado `addOpen` na rota); o diálogo entra na T12.

**Steps:**
- [ ] **Step 1 (RED):**
  - `$sectorId.spec`: "lista nome, nível, função, turno e 'Sem acesso'/'Com acesso'"; "Tirar do setor só em quem não tem acesso e chama DELETE"; "setor vazio mostra 'Ninguém neste setor ainda.' e 'Adicionar pessoas'"; "gestor: sem Editar setor e sem números; mostra Gestor e pessoas"; "403 mostra 'Você não gerencia este setor.'".
  - `edit-person-dialog.spec`: "sem acesso edita nome, telefone, nível, função e turno"; "com acesso: nome e telefone só leitura, PATCH só com nível/função/turno"; "phoneE164 null (gestor × pessoa com acesso) mostra '—'"; "403 mostra 'Você não pode mexer nesta pessoa.'".
  - `setores/index.spec`: "gestor vê só os setores que gerencia, sem 'Novo setor'"; "sem setor gerido mostra 'Você não gerencia nenhum setor.'".
  - `sector-form.spec`: "Gestor não lista pessoa sem acesso". Nav spec: "/setores para ADMIN, SUPERVISOR e OPERATOR".
- [ ] **Step 2:** `timeout 600 gate --test src/routes/_authenticated/setores/$sectorId.spec.tsx` → FAIL.
- [ ] **Step 3:** implementar.
- [ ] **Step 4 (GREEN):** specs da task e os specs atuais de `routes/_authenticated/setores/` e `features/internal-admin/` → PASS.
- [ ] **Step 5:** `timeout 600 gate --changed --base origin/main` (cwd `frontend/`) → PASS; GC2 à mão.

---

### Task 12: front — diálogo Adicionar pessoas (três abas)

Depende de: T11. Risco: médio.

**Files:**
- Create: `frontend/src/features/sector-people/components/{add-people-dialog.tsx, new-person-tab.tsx, contacts-tab.tsx, existing-person-tab.tsx}` (+ specs)
- Modify: `frontend/src/features/sector-people/{api.ts, schemas.ts, error-messages.ts}` (hooks de candidatos e escrita), `frontend/src/routes/_authenticated/setores/$sectorId.tsx` (monta o diálogo no `addOpen`)

**Contexto vinculado:**
- C3: `POST /` (nova pessoa, sem acesso), `GET /contact-candidates?q=` + `POST /from-contacts` `{ contactIds, levelId?, shiftId }` (Turno obrigatório nas abas Nova pessoa e Dos contatos, Q3) → `{ created, failed: { contactId, reason } }`, `GET /candidates?q=` + `POST /move` `{ userIds }`; `options.levels`/`options.shifts` do `GET …/people`.
- Spec §2: abas `Nova pessoa` (nome, telefone, nível, função, turno; entra sem acesso), `Dos contatos` (busca por nome ou número, vários; o nível vale para todos; contato que já é pessoa desabilitado com `já é <nome> · <setor>`), `Já cadastrada` (busca; pessoa de outro setor pede confirmação `<nome> sai de <setor>`; o gestor só vê sem setor). Erros por item sem perder os que deram certo.
- D8: a aba `Dos contatos` aparece para ADMIN e gestor e tem `Turno` além de `Nível`. D11: contato sem nome aparece pelo número.
- GC11: `Adicionar (N)`, toast `N pessoa(s) adicionada(s)`, motivos `Telefone inválido`, `Número já usado por outra pessoa`, `Já é uma pessoa cadastrada`, `Contato não encontrado`; `Sem setor` quando `sectorName` é null.
- GC10: erros por `readApiErrorBody`. Busca com debounce de 300 ms (sem dependência nova).

**Steps:**
- [ ] **Step 1 (RED):**
  - `contacts-tab.spec`: "seleciona 3 contatos, escolhe Funcionário e o turno Noite e envia { contactIds: [3 ids], levelId: 'level_employee', shiftId: 'noite' }" (aceite 1); "contato que já é pessoa fica desabilitado com 'já é Ana · TI'"; "resultado com 1 phone_taken mostra 'Número já usado por outra pessoa' e o toast '2 pessoa(s) adicionada(s)'" (R8).
  - `existing-person-tab.spec`: "pessoa de TI pede 'Ana sai de TI' antes de chamar move"; "pessoa sem setor move sem confirmação".
  - `new-person-tab.spec`: "envia nome, telefone, nível, função e turno"; "erro de telefone mostra a mensagem do servidor".
  - Q3, `it.each` em `new-person-tab.spec` e `contacts-tab.spec`: "sem turno, Adicionar / Adicionar (N) desabilitado e nenhuma chamada" (o hook de escrita não é chamado; Turno sem pré-seleção).
  - `add-people-dialog.spec`: "três abas para ADMIN e para o gestor".
- [ ] **Step 2:** `timeout 600 gate --test src/features/sector-people/components/contacts-tab.spec.tsx` → FAIL.
- [ ] **Step 3:** implementar.
- [ ] **Step 4 (GREEN):** specs da task e `setores/$sectorId.spec.tsx` → PASS.
- [ ] **Step 5:** `timeout 600 gate --changed --base origin/main` (cwd `frontend/`) → PASS; GC2 à mão.

---

### Task 13: front — envio para vários setores, nível e tela vazia

Depende de: T8b (roster da T8a e POST da T8b). Risco: alto (muda a tela de envio em produção). Effort: high (A/B).

**Files:**
- Modify: `frontend/src/features/team-whatsapp/schemas.ts` (C4, C5, `email` nullable, `level`), `api.ts` (`useTeamRoster(sectorIds, date)` com `searchParams: { sectorIds: ids.join(','), date }`), `member-filter.ts` (+ spec; filtro de nível), `error-messages.ts` (+ spec; `invalid_level`)
- Modify: `frontend/src/features/team-whatsapp/components/sector-shift-picker.tsx` (setores múltiplos com `Todos os setores`; níveis múltiplos com `Sem nível`), `member-selection.tsx` (agrupada por setor, nível ao lado do nome, tela vazia por setor), `send-whatsapp-dialog.tsx` (body `sectorIds`, `levelIds`, `withoutLevel`) (+ specs)
- Modify: `frontend/src/routes/_authenticated/whatsapp-equipe/index.tsx` (+ `index.spec.tsx`)

**Contexto vinculado:**
- C4/C5: `targets.levels`; `roster?sectorIds=…&date` → `sectors[{ sectorId, name, members[].level }]`; POST `{ type: 'sector', sectorIds, shiftId?, userIds?, date, includeOff?, levelIds?, withoutLevel? }`; 422 `team_whatsapp.invalid_level`, 403 `team_whatsapp.forbidden`, 422 `invalid_selection`.
- Spec §4: setores múltiplos com `Todos os setores`; começa vazio, exceto quando só há um setor possível (já vem escolhido, como hoje); níveis múltiplos com `Sem nível`, vazio = todos; data, turno, `incluir quem está de folga` e agendamento iguais; lista agrupada por setor com nível ao lado do nome, mostrando de folga e sem telefone como hoje; seleção, `Enviar para todos (N)`, `Enviar para selecionados (M)` e confirmação com os nomes iguais. §5: setor sem ninguém → `Ninguém neste setor ainda.` + link `Adicionar pessoas` para `/setores/$sectorId`.
- Anti-objetivo: um setor sem nível = tela e POST de hoje (só o nome do campo muda para `sectorIds: [id]`).
- GC10/GC11: `Setores`, `Todos os setores`, `Níveis`, `Sem nível`, mensagem de `invalid_level`. GC14: multi-escolha com `Checkbox`, sem componente novo.

**Steps:**
- [ ] **Step 1 (RED):**
  - `member-filter.spec` `it.each`: sem filtro → todos; `Coordenador` → só coordenadores; `Sem nível` → só sem nível; os dois juntos.
  - `sector-shift-picker.spec`: "Todos os setores marca todos"; "um setor possível já vem marcado"; "níveis ativos vêm de targets.levels, com Sem nível no fim".
  - `member-selection.spec`: "agrupa por setor com 'Ana · Coordenador'"; "setor vazio mostra 'Ninguém neste setor ainda.' com link para /setores/<id>".
  - `send-whatsapp-dialog.spec`: "TI + Operação + Coordenador envia sectorIds [ti, op] e levelIds ['level_coordinator']" (aceite 3); "um setor sem nível envia sectorIds [id] sem levelIds nem withoutLevel" (R5).
  - `index.spec`: "roster pedido com sectorIds 'a,b' e a data"; "422 invalid_level mostra a mensagem".
- [ ] **Step 2:** `timeout 600 gate --test src/features/team-whatsapp/member-filter.spec.ts` → FAIL.
- [ ] **Step 3:** implementar.
- [ ] **Step 4 (GREEN):** specs da task e os specs atuais de `features/team-whatsapp/` → PASS.
- [ ] **Step 5:** `timeout 600 gate --changed --base origin/main` (cwd `frontend/`) → PASS; GC2 à mão.

---

### Task 14: front — histórico com setores e nível

Depende de: T7 e T13. Risco: médio.

**Files:**
- Modify: `frontend/src/features/team-whatsapp/schemas.ts` (C6 da lista: `sectors`, `sectorName`, `levelName`), `components/recent-dispatches.tsx` (+ spec)

**Contexto vinculado:**
- C6: item com `sectors: { id, name }[]`; `recipients`/`unselected`/`off` com `sectorName: string | null` e `levelName: string | null` (envio antigo: `sectorName` vem do backfill; `levelName` null).
- Spec §4: rótulo cita setores e níveis (`RH, TI +2 · Coordenador · Noite · 22/10`, vem pronto do servidor em `label`); `Ver destinatários` agrupa por setor, com o nível da época. Os três grupos de hoje (`Destinatários`, `Escalados não marcados`, `De folga`) continuam; dentro de cada grupo, subgrupo por setor quando houver mais de um setor.
- D4/M3: o nível exibido é o `levelName` gravado (não muda ao renomear).
- Agendados (`scheduled-dispatches.tsx`) já mostra `label`; não muda.

**Steps:**
- [ ] **Step 1 (RED):** `recent-dispatches.spec`: "envio de TI + Operação: Ver destinatários agrupa 'TI' e 'Operação' com 'Ana · Coordenador'"; "envio de um setor mostra a lista como hoje, sem subtítulo de setor"; "levelName null mostra só o nome".
- [ ] **Step 2:** `timeout 600 gate --test src/features/team-whatsapp/components/recent-dispatches.spec.tsx` → FAIL.
- [ ] **Step 3:** implementar.
- [ ] **Step 4 (GREEN):** spec da task e `whatsapp-equipe/index.spec.tsx` → PASS.
- [ ] **Step 5:** `timeout 600 gate --changed --base origin/main` (cwd `frontend/`) → PASS; GC2 à mão.

---

### Task 15: front — Novidade

Depende de: T9–T14. Risco: baixo. Effort: high (A/B). Cabe no `mecanico`.

**Files:**
- Modify: `frontend/src/release-notes.ts`, `frontend/src/release-notes.spec.ts`

**Contexto vinculado:**
- GC15: entrada nova no topo com `version: '2026.10.22'` (a do topo hoje é `'2026.10.21.1'`); se algum `describe` supõe que `'2026.10.21.1'` é `RELEASE_NOTES[0]`, passar a localizá-la por `version`.
- Spec §5: a Novidade explica como pôr pessoas no setor e como enviar só para coordenadores. `frontend/CLAUDE.md`: texto para o operador, `where` só com tela específica, ordem decrescente.

**Interfaces:**

```ts
{
  version: '2026.10.22',
  date: '2026-10-22',
  title: 'Pessoas no setor, níveis e envio para vários setores',
  items: [
    { text: 'Na página do setor, use "Adicionar pessoas" para incluir uma pessoa nova, vários contatos de uma vez ou alguém já cadastrado. Quem só recebe WhatsApp entra "Sem acesso", sem e-mail e sem senha.', where: '/setores' },
    { text: 'Cada pessoa pode ter um nível: Coordenador, Líder, Funcionário ou Operador. A lista de níveis pode ser editada.', where: '/niveis' },
    { text: 'No WhatsApp da equipe, escolha um ou mais setores e o nível. Para mandar só para os coordenadores, marque os setores e o nível Coordenador.', where: '/whatsapp-equipe' },
    { text: 'Em Usuários, quem não entra no sistema aparece como "Sem acesso" e pode receber acesso depois.', where: '/users' },
  ],
}
```

(o formato exato de `date`/`where` segue `ReleaseNote` em `release-notes.ts`).

**Steps:**
- [ ] **Step 1 (RED):** `release-notes.spec.ts` `describe('novidade 2026.10.22')`: "está no topo"; "where /setores, /niveis, /whatsapp-equipe e /users"; "texto cita 'Adicionar pessoas' e 'Coordenador'".
- [ ] **Step 2:** `timeout 600 gate --test src/release-notes.spec.ts` → FAIL.
- [ ] **Step 3:** implementar.
- [ ] **Step 4 (GREEN):** o mesmo comando → PASS.
- [ ] **Step 5:** `timeout 600 gate --changed --base origin/main` (cwd `frontend/`) → PASS.

---

## Fechamento (principal, depois da T15)

1. **Gate completo por lado**, supervisionado (`run_in_background` com `timeout N`, log em arquivo), `--base origin/main`, cwd `backend/` e `frontend/`, comparado com a baseline do ledger (medida em `a2520bb` antes da T1). Aceite: testes verdes (só os ignorados da baseline); cobertura sem queda; LINT/SONAR/COMPLEXIDADE sem aumento; os `describe` > 50 linhas e `max-params` em spec que o `--changed` não pega são corrigidos na hora. Regressão nova bloqueia; não regenerar a baseline.
2. **CI do PR**: backend-tests, frontend-build, e2e, migration-drift (só depois de pedido explícito de push/PR).
3. **QA visual local** (agente `qa`, Playwright, stack local com seed; sem produção), roteiro dos aceites 1–7: ADMIN adiciona 3 contatos com Funcionário ao RH e vê na página e no envio; gestor de Operação adiciona pessoa nova e muda o nível de alguém, e não vê TI; pessoa sem acesso em Usuários e login recusado; envio TI + Operação + Coordenador agrupado; renomear Funcionário; agendar para dois setores e cancelar. Evidência por tela. **Aceite 6** (renomear Funcionário troca o nome no cadastro, página do setor, Usuários, filtro e lista do dia; nível inativo some do cadastro novo) é coberto só por este QA, de ponta a ponta; o aceite 1 tem também o teste de integração da T6 (lote → `loadDayPeople`).
4. **Revisão final de contratos** (revisor `opus`): C1–C7 e P1, back (`schemas/contracts/*.schema.ts` + DTOs) contra front (`features/*/schemas.ts`), campo a campo; códigos de erro com mensagem no front; nenhum telefone/nome/e-mail em auditoria nova.
5. **Ledger**: gates, QA, revisão e próximo passo em `.superpowers/sdd/2026-10-22-orgamind-pessoas-setor-nivel/progress.md`.

## Perguntas abertas — resolvidas pela principal (22/10, antes da revisão do plano)

1. **Q1 — Recentes do gestor:** mantém o de hoje, `authorId = ele`, sem condição de setor (C7). Ele só cria envio para setor que gerencia; esconder os próprios envios mudaria o comportamento atual sem ganho de privacidade.
2. **Q2 — Menu "Setores" (D9):** fica como no plano (`WRITE_INTERNAL_ROLES` com `Você não gerencia nenhum setor.`), coerente com o item WhatsApp da equipe.
3. **Q3 — Turno ao adicionar:** **obrigatório** nas abas Nova pessoa e Dos contatos (um turno para o lote), sem pré-seleção. Pela regra da escala (D2), quem fica sem turno nem escala não entra em "Todos os turnos". O caso principal do cliente (RH para os coordenadores de todos os setores) falharia em silêncio para quem entrou sem turno. No convite de Usuários o turno continua opcional, como hoje.
4. **Q4 — Contato sem nome:** vira pessoa com o número como nome (D11).
5. **Q5 — Histórico:** mostra o nome do nível da época (D4/M3). O aceite 6 vale para cadastro, página do setor, Usuários, filtro e lista do dia, e não para a foto do histórico.

## Estado (22/10/2026, fim da implementação)

- Referência: `a2520bb` (origin/main local da branch `feat/pessoas-setor`); tudo **sem commit** no working tree.
- T1–T15 completas (8a/8b inclusas), cada uma com gate `--changed` PASS e revisão (opus nas críticas). Lotes de fechamento F1, B1, B2 e F2 aplicados. A revisão final de contratos (opus) achou 1 Important, o painel do ADMIN que caía com pessoa sem e-mail. Foi corrigida no fix round 1/4 e a re-review deu APPROVED.
- Gates completos finais sem regressão contra a baseline (ver ledger). QA visual local com PASS nos aceites 1, 1b, 2, 3, 4 e 6 e no histórico. No aceite 7, o clique de agendar foi negado pelo classificador de permissão, e a cobertura é só automática. O aceite 5 tem cobertura automática (caracterização da T7 e teste da T13).
- Próximo passo: o usuário pede commit, PR e deploy. Back e front sobem juntos, logo após as 3 migrações (M2 da revisão final). Backlog de Minors no ledger.
