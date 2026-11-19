# OrgaMind — Etapa 1 GBR, Lote A: ficha da pessoa e trilha (CAD-01 + DAT-02) — Implementation Plan

> **Para os agentes:** executar pela skill `sdd` (TDD, ledger em `.superpowers/sdd/2026-11-19-gbr-etapa1/progress-lote-a.md`). **Sem commit/push**: nenhuma task commita; a principal integra e commita o lote com pedido do usuário. Branch `feat/cadastro-permissoes`, empilhada sobre `feat/somente-evolution` (PR 12 sobre PR 11), HEAD do início `88cd170`. Projeto com dívida legada: fechamento de task por `gate --changed --base feat/somente-evolution`.

**Goal:** a pessoa (`User`) ganha matrícula, autorização de contato com origem e data, situação ativa/inativa com motivo, e toda alteração dela (e de setor) vai para a trilha com autor, motivo e antes/depois, gravada na mesma transação. Pessoa `NAO_AUTORIZADO` sai do envio da equipe com `NOT_AUTHORIZED`. Exclusão física só sem histórico. Tela "Trilha de alterações" (ADMIN) e "Histórico" por pessoa (ADMIN e SUPERVISOR no alcance).

**Architecture:** o back ganha uma API de trilha transacional (`AuditService.recordChange(tx, change)`) com diff genérico e máscaras num arquivo só (`shared/audit/audit-change.ts`), reaproveitável pelos Lotes B e C. As decisões de autorização novas ficam em funções nomeadas (`shared/authz/person-actions.policy.ts`), para o Lote B trocar papel por permissão num lugar só. `UsersService` continua sendo o único caminho de escrita da pessoa (Lote C troca o miolo depois). O front ganha componentes compartilhados da ficha (`features/people-record/`), usados pelas duas listas, e o módulo `features/audit-trail/`.

**Tech Stack:** NestJS + Prisma + Zod v4 (`createZodDto`, `nestjs-zod`) + BullMQ + Vitest/testcontainers no back; React + TanStack Router/Query + ky 2 + Radix + Vitest/Testing Library no front.

**Spec:** `docs/superpowers/specs/2026-11-19-orgamind-gbr-etapa1-cadastro-permissoes.md` (seções A1–A6, aceites 1–9). Mapas em `.superpowers/sdd/2026-11-19-gbr-etapa1/` (`mapa-pessoas.md`, `mapa-auditoria.md`, `mapa-permissoes.md`, `mapa-vinculo.md`). Sentença do conselho: `~/.claude/tribunais/2026-11-19/conselho-R/sentenca-R.md` (R1; células `pessoas.inativar` e `trilha.consultar`).

## Ordem e paralelismo

```
Back:  T1 ─> T2 ─┬─> T3a ─> T3b ─> T4 ─┬─> T5 ─> T6
                 │                       └─> T7 ─> T8
                 ├─> T9
                 └─> T10
       T1 ─> T11
Front: T12 ─┬─> T13 ───────────┬─> T14
            ├─> T15 ───────────┼─> T16
            └─> T17a ─> T17b ──┘   (T14 = T13 + T17b; T16 = T15 + T17b; usam o PersonHistoryDialog)
       T18
       T19 (por último)
```

- **Paralelos (ownership disjunto):**
  - T9 ∥ T10 ∥ T3a, depois da T2; T11 depois da T1, em paralelo com tudo do back;
  - T5 ∥ T7, depois da T4; T6 depois da T5; T8 depois da T7;
  - T12 ∥ T18 podem começar já: os contratos C4–C8 estão fixados neste plano;
  - T13 ∥ T15 ∥ T17a, depois da T12 (`features/users`, `features/sector-people` e `features/audit-trail` + `nav.ts`, sem arquivo em comum).
- **Em série (mesmo arquivo ou assinatura consumida):**
  - T3a → T3b → T4 → T5 → T6: a T3a cria as funções puras (`person-record`, `person-audit`) que T3b, T4 e T5 consomem; T3b, T4, T5 e T6 mexem em `users.service.ts` e `users.repository.ts`;
  - T4 → T7: a T7 consome `updateUser(id, input, actorId, meta)` e `requireReason`, criados na T4;
  - T7 → T8: as duas mexem no controller, no write service, no repositório e no contrato de `sector-people`;
  - T12 → T13 → T14 e T12 → T15 → T16: T13/T15 donas de `api.ts`/`schemas.ts` da feature; T14/T16 só das listas;
  - T12 → T17a: a T17a usa `canQueryAuditTrailUi` de `people-record/ui-policy.ts`, criada na T12 (GC5 proíbe decidir por conta própria);
  - T17a → T17b (o diálogo usa `usePersonHistory`, `TrailTable` e os rótulos da T17a); T17b antes de T14 e T16 (consomem `PersonHistoryDialog`);
  - T19 depois de T14, T16, T17b e T18.
- **Revisão** (SKILL.md do sdd, §Revisão por risco):
  - **Críticas, com revisor `opus`:** T2 (dado pessoal em log; autorização), T3a e T3b (dado pessoal em log), T4 (dado pessoal em log), T5 (dado pessoal em log), T7 e T8 (autorização), T9 (autorização), T10 (dado pessoal em trilha: gestor do setor).
  - **Alto, com revisor `sonnet` dedicado:** T1 (migração com backfill), T11 (bloqueio de envio).
  - **Demais:** T6, T12–T16, T17a, T17b, T18. A T19 cabe no `mecanico`.
- **Base do `--changed`:** `feat/somente-evolution`.

## Decisões deste plano (registradas para o ledger)

- **D1 — Matrícula:** `User.registration VarChar(30)` (como digitado, aparado) e `User.registrationKey VarChar(30) @unique` (minúsculas, só para unicidade e busca). Sem índice funcional `lower()`: o Prisma não o representa e geraria drift.
- **D2 — Autorização em colunas planas no `User`:** `contactAuthorization` (enum, default `NAO_AUTORIZADO`), `authorizationSource` (enum, nulo quando não autorizado), `authorizationNote VarChar(120)`, `authorizationDate Date`, `authorizationRecordedById` (sem FK, como `AuditEvent.actorId`, para não bloquear exclusão nem criar relação nova) e `authorizationRecordedAt`.
- **D3 — `AuditEvent` ganha** `subjectUserId` (sem FK, índice `(subjectUserId, createdAt)`), `category AuditCategory?` (índice `(category, createdAt)`), `reason VarChar(200)` e `changes Json` (array de `FieldChange`). `metadata` fica para o legado.
- **D4 — Categoria:** derivada da ação por prefixo (`categoryOfAction`) quando a chamada não informa; a mesma tabela vai no backfill SQL. Setor criado/editado = `STRUCTURE`; mover/tirar/adicionar no setor = `ASSIGNMENT`; ficha da pessoa = `PERSON`; escala = `SCHEDULE`; `PERMISSIONS` fica reservado ao Lote B.
- **D5 — Motivo:** `reason` opcional no Zod (só `trim().max(200)`), conferido por `requireReason` no serviço/controller, para o erro ser `422 user.reason_required` e não um 400 de validação. Mover e tirar aceitam `optionalReason` (se vier, 3–200).
- **D6 — Inativar/reativar:** em `/users`, `PATCH /users/:id { isActive, reason }` (rota existente, que já tem guarda do último ADMIN, de auto-inativação e revoga a sessão). No setor, rota nova `POST internal/sectors/:sectorId/people/:userId/status { isActive, reason }`. O campo "Situação" sai do diálogo de edição de usuário: um caminho só, pelas ações da lista.
- **D7 — Exclusão física:** `personHasHistory(tx, userId)` roda dentro da transação serializável do DELETE (C5). Histórico inclui também a escala da pessoa: `StaffSchedule` e `StaffScheduleException` com `onDelete: Cascade` apagariam a escala passada (anti-objetivo da spec); lacuna da spec A3 decidida pela principal e já registrada na spec.
- **D8 — Consulta da trilha:** módulo novo `audit-trail`; consulta geral lista só eventos com `category` não nula.
- **D9 — `GET /users`:** `status` com default `all` (contrato atual intacto para outros consumidores); a tela de usuários manda `active` até marcar "Mostrar inativos". Contadores contam pessoas ativas da base inteira, sem paginação.
- **D10 — "Ficha" = diálogo "Histórico"** aberto pela ação da linha nas duas listas; não existe página de ficha hoje.
- **D11 — Prévia do envio:** o roster ganha `contactAuthorization` e `authorizationUnverified`; o front agrupa. `canReceive` passa a exigir telefone **e** autorizado.
- **D12 — Migrações:** `20261119090000_team_skip_not_authorized` (só `ALTER TYPE ... ADD VALUE`, padrão de `20261110091000_team_recipient_status_values`) e `20261119091000_person_record_and_trail` (resto, com backfill).
- **D13 — Seed:** o admin de `backend/prisma/seed.ts:25` passa a ser criado `AUTORIZADO`/`OUTRO` com nota "Seed de desenvolvimento"; sem isso, o default novo o tiraria dos envios locais.
- **D14 — Front não pede motivo** em mover e tirar do setor (a API aceita opcional).
- **D15 — `CADASTRO_ANTERIOR` recusado por validação** (400, valor fora do enum de input), sem código próprio: a spec não fixa código.
- **D16 — Autorização de pessoa com login no setor:** na página do setor a pessoa com login continua `limited` em `canEditPerson`; matrícula e autorização dela não se editam ali (nem pelo ADMIN, que usa `/users`). `canEditContactAuthorization` fica como guarda explícita no `update` do setor (T7).
- **D17 — Reenvio da mesma autorização:** se status, origem, nota e data efetiva são iguais aos atuais, `authorizationColumns` não mexe nas colunas (`authorizationRecordedAt`/`RecordedById` ficam); sem mudança, sem trilha.
- **D18 — Histórico da pessoa só com evento categorizado:** o backfill de `subjectUserId` e a consulta `personHistory` ignoram eventos sem `category` (login, refresh, logout).

## Global Constraints

- **GC1 — Trilha na transação:** criação, edição, autorização, inativar, reativar, exclusão, concessão de acesso e troca de papel da pessoa; mover, tirar, adicionar e editar pessoa do setor; criação e edição de setor. Gravam com `AuditService.recordChange(tx, …)` dentro da transação da mudança; se a trilha falhar, a mudança não é gravada. Os demais `audit.log` seguem como hoje (engolem erro).
- **GC2 — Dado pessoal na trilha:** telefone só `•••• 1234` (4 últimos dígitos), e-mail `a•••@dominio`, senha nunca. Nome, função, matrícula, situação e autorização por extenso; setor, turno e nível como `{ id, name }`. A comparação usa os valores crus; a máscara vem depois (troca entre dois telefones com o mesmo final ainda é alteração).
- **GC3 — Só campos alterados** entram em `changes`. Registro antigo (sem `changes`) sai na consulta com `changes: null`.
- **GC4 — Lote C:** nenhuma gravação nova de `User.sectorId/shiftId/levelId`. Elas continuam só em `personWithoutAccessData` (`users.service.ts:117-137`), `createInvitation` (`:267-293`) e `toUpdateData` (`:500-522`). Registrar a mudança na trilha pode.
- **GC5 — Lote B:** toda decisão de autorização nova chama uma função de `backend/src/shared/authz/person-actions.policy.ts` (back) ou de `frontend/src/features/people-record/ui-policy.ts` (front, só para esconder botão). Nada de `role === 'ADMIN'` novo em service ou componente.
- **GC6 — `CADASTRO_ANTERIOR` só pela migração:** o input da API não tem esse valor. Criação sem `contactAuthorization` grava `NAO_AUTORIZADO`.
- **GC7 — Erros:** `code` estável e texto pt-BR, exatamente os da tabela C9.
- **GC8 — Datas civis** no fuso do app com `todayIn` (`backend/src/modules/staff-schedule/civil-date.ts:19`).
- **GC9 — `AuditService.log` não muda de assinatura** (113 chamadas em 37 arquivos); só ganha um 5º parâmetro opcional.
- **GC10 — Testes e tamanho:** `describe` novos, irmãos, de até 50 linhas, no topo do arquivo; funções novas de até 50 linhas e complexidade até 10 (o gate completo mede; o `--changed` não pega tudo). Um teste por regra ou aceite, mais as negações de autorização; sem matriz exaustiva.
- **GC11 — Validação:** cwd `backend/` ou `frontend/`, caminhos relativos ao pacote. Loop: `timeout 600 gate --test src/<arquivo>`. Fechamento: `timeout 600 gate --changed --base feat/somente-evolution`. Nunca suíte inteira, gate completo, coverage ou e2e (são da principal). Sem commit.
- **GC12 — Textos de tela** em pt-BR, no tom das telas atuais, sem jargão técnico. Valores de enum nunca aparecem crus (`NAO_AUTORIZADO`, `CADASTRO_ANTERIOR`): sempre pelo rótulo.
- **GC13 — Compila entre tasks:** assinaturas existentes só ganham parâmetro opcional ou campo opcional; nenhuma task deixa chamador existente sem compilar (front: `useUsers(page, pageSize, filters?)` em `assign-menu.tsx:27` e `users/index.tsx:48`; `useSectorPeople(sectorId, opts?)` em `$sectorId.tsx:30`; back: `updateUser`, `deleteUser` e `log` com os chamadores e specs existentes ajustados na própria task).

## Contratos compartilhados

**C1 — Prisma (T1).**
```prisma
enum ContactAuthorizationStatus { AUTORIZADO NAO_AUTORIZADO }
enum ContactAuthorizationSource { TERMO_ASSINADO FICHA_ADMISSAO ACEITE_WHATSAPP OUTRO CADASTRO_ANTERIOR }
enum AuditCategory { PERSON ASSIGNMENT SCHEDULE STRUCTURE PERMISSIONS }
// User (+)
registration              String?  @db.VarChar(30)
registrationKey           String?  @unique @db.VarChar(30)
contactAuthorization      ContactAuthorizationStatus @default(NAO_AUTORIZADO)
authorizationSource       ContactAuthorizationSource?
authorizationNote         String?  @db.VarChar(120)
authorizationDate         DateTime? @db.Date
authorizationRecordedById String?
authorizationRecordedAt   DateTime?
// AuditEvent (+)
subjectUserId String?
category      AuditCategory?
reason        String? @db.VarChar(200)
changes       Json?
@@index([subjectUserId, createdAt])
@@index([category, createdAt])
// TeamWhatsappSkipReason (+) NOT_AUTHORIZED
```
Backfill: todo `User` existente fica `AUTORIZADO`, `CADASTRO_ANTERIOR`, data nula, registrado por nulo, registrado em `NOW()`. `AuditEvent` antigo: `category` pelo prefixo (C2, `categoryOfAction`); `subjectUserId = entityId` quando `entity = 'User'` **e `category` não é nula** (eventos `auth.login_success`, `auth.login_failed`, `auth.refresh`, `auth.logout` ficam com `subjectUserId` e `category` nulos); `subjectUserId = metadata->>'userId'` para `staff_schedule.%` e `sector_people.removed`.

**C2 — API da trilha (T2), `backend/src/shared/audit/audit-change.ts`.**
```ts
export type AuditRef = { id: string; name: string };
export type AuditValue = string | number | boolean | null | AuditRef;
export type FieldChange = { field: string; before: AuditValue; after: AuditValue };
export type AuditChange = {
  action: string; entity: string; entityId: string | null;
  category: AuditCategory;            // de @prisma/client
  subjectUserId?: string | null;
  reason?: string | null;
  changes: FieldChange[];
  metadata?: Record<string, unknown>;
  actorId: string;                    // obrigatório e explícito (quem chama já o tem); o CLS só fornece ip e user-agent
};
export function diffFields(
  before: Readonly<Record<string, AuditValue>> | null,
  after: Readonly<Record<string, AuditValue>> | null,
  present?: (field: string, value: AuditValue) => AuditValue,
): FieldChange[];                      // compara cru (AuditRef por id), aplica `present` só na saída; null = lado inexistente
export function maskPhone(e164: string | null | undefined): string | null;  // '+5592988887777' → '•••• 7777'; <4 dígitos → '••••'
export function maskEmail(email: string | null | undefined): string | null; // 'ana@gbr.com.br' → 'a•••@gbr.com.br'
export function categoryOfAction(action: string): AuditCategory | null;
// 'user.' → PERSON; 'sector_people.' e 'assignment.' → ASSIGNMENT; 'staff_schedule.' → SCHEDULE;
// 'sector.' 'shift.' 'level.' → STRUCTURE; 'permission.' → PERMISSIONS; resto → null
```
`AuditService`:
```ts
log(action, entity, entityId?, metadata?, opts?: { subjectUserId?: string | null; category?: AuditCategory | null }): Promise<void>
  // igual a hoje; category default = categoryOfAction(action); continua engolindo erro
recordChange(tx: Prisma.TransactionClient, change: AuditChange): Promise<void>
  // grava com tx.auditEvent.create; actorId vem de change.actorId; ip e user-agent do CLS; NÃO engole erro
```
`AuditRepository`: `create(data)` vira `createIn(this.prisma, data)`; `createIn(client: Prisma.TransactionClient | PrismaService, data: AuditWriteData)`; `AuditWriteData` ganha `subjectUserId?`, `category?`, `reason?`, `changes?` (nullish → null / `Prisma.JsonNull`).

**C3 — Políticas (T2), `backend/src/shared/authz/person-actions.policy.ts`.** Matriz inicial por papel; o Lote B troca o corpo por permissão.
```ts
export type PolicyActor = { id: string; role: Role };
export type PolicyPerson = { hasAccess: boolean };
/** pessoas.inativar: ADMIN qualquer pessoa; SUPERVISOR só sem login e no alcance; OPERATOR/VIEWER nunca. */
export function canChangePersonStatus(actor: PolicyActor, person: PolicyPerson, inReach: boolean): boolean;
/** Autorização de contato: pessoa com login, só ADMIN; sem login, quem já pode editar a pessoa. */
export function canEditContactAuthorization(actor: PolicyActor, person: PolicyPerson): boolean;
/** Exclusão física: só ADMIN. */
export function canDeletePerson(actor: PolicyActor): boolean;
/** trilha.consultar, consulta geral: só ADMIN. */
export function canQueryAuditTrail(actor: PolicyActor): boolean;
/** trilha.consultar, ficha: ADMIN sempre; SUPERVISOR só no alcance; OPERATOR/VIEWER nunca. */
export function canViewPersonHistory(actor: PolicyActor, inReach: boolean): boolean;
/** Categorias da ficha: ADMIN null (todas as categorizadas); demais ['PERSON','ASSIGNMENT','SCHEDULE'].
 *  Em qualquer caso a consulta `personHistory` filtra também `category IS NOT NULL` (login, refresh e logout ficam fora). */
export function personHistoryCategories(actor: PolicyActor): AuditCategory[] | null;
```
"Ninguém inativa a si mesmo" continua no `UsersService.assertSelfChangeAllowed` (`users.service.ts:424-440`, `403 user.cannot_self_deactivate`); o último ADMIN, em `updateWithLastAdminGuard` (`users.repository.ts:174-197`).

**C4 — Contrato da autorização (T1), `backend/src/schemas/contracts/contact-authorization.schema.ts`.**
```ts
export const contactAuthorizationStatusSchema = z.enum(['AUTORIZADO', 'NAO_AUTORIZADO']);
export const contactAuthorizationSourceSchema = z.enum(['TERMO_ASSINADO','FICHA_ADMISSAO','ACEITE_WHATSAPP','OUTRO','CADASTRO_ANTERIOR']);
export const contactAuthorizationSchema = z.object({          // saída
  status: contactAuthorizationStatusSchema,
  source: contactAuthorizationSourceSchema.nullable(),
  note: z.string().nullable(),
  date: civilDateSchema.nullable(),
  recordedAt: z.string().nullable(),
});
export const contactAuthorizationInputSchema = z.discriminatedUnion('status', [   // entrada
  z.object({ status: z.literal('NAO_AUTORIZADO') }).strict(),
  z.object({
    status: z.literal('AUTORIZADO'),
    source: z.enum(['TERMO_ASSINADO','FICHA_ADMISSAO','ACEITE_WHATSAPP','OUTRO']),
    note: z.string().trim().max(120).optional(),
    date: civilDateSchema.optional(),               // ausente = hoje (serviço)
  }).strict(),
]);  // + refinamento: source OUTRO exige note não vazia (400)
export type ContactAuthorization = z.infer<typeof contactAuthorizationSchema>;
export type ContactAuthorizationInput = z.infer<typeof contactAuthorizationInputSchema>;
```
`civilDateSchema` vem de `backend/src/schemas/contracts/civil-date.schema.ts` (importado em `team-whatsapp.schema.ts:2`).

**C5 — API de usuários (T3a–T6).**
- `userSummarySchema` (`schemas/contracts/user.schema.ts:3-35`) ganha `registration: z.string().nullable()` e `contactAuthorization: contactAuthorizationSchema`.
- `POST /users` (os dois ramos de `createUserSchema`, `dto/create-user.dto.ts:16-68`) ganha `registration: z.string().trim().max(30).nullable().optional()` e `contactAuthorization: contactAuthorizationInputSchema.optional()`.
- `PATCH /users/:id` (`dto/update-user.dto.ts:4-24`) ganha `registration`, `contactAuthorization` e `reason: z.string().trim().max(200).optional()`; o refine "ao menos um campo" ignora `reason`. Motivo obrigatório (`422 user.reason_required`).
- `GET /users` (`dto/list-users.dto.ts`) ganha `q?: string (trim, max 80)` (nome ou matrícula), `status: 'active' | 'inactive' | 'all'` (default `all`), `authorization?: 'UNVERIFIED' | 'NOT_AUTHORIZED'`. Resposta (`userListResponseSchema`, `:37-42`) ganha `authorizationCounts: { unverified: number; notAuthorized: number }`.
- `DELETE /users/:id`: com histórico, `409 user.has_history`.
- `UsersService`:
```ts
type PersonChangeMeta = { reason: string | null; action?: string; category?: AuditCategory };
updateUser(id: string, input: UserPatch, actorId: string, meta: PersonChangeMeta = { reason: null }): Promise<void>
createPersonWithoutAccess(actorId: string, input: PersonWithoutAccessInput): Promise<UserSummary>
  // PersonWithoutAccessInput ganha registration?: string | null; contactAuthorization?: ContactAuthorizationInput
```
- Ações gravadas (`entity 'User'`, `subjectUserId` = a pessoa): `user.invited`, `user.person_created`, `user.profile_updated`, `user.authorization_changed`, `user.role_changed`, `user.deactivated`, `user.reactivated`, `user.access_granted`, `user.deleted`; no setor, `sector_people.person_moved` e `sector_people.person_removed` (`ASSIGNMENT`). `user.password_reset` segue no `log`.
- Campos da ficha na trilha (`PersonAuditField`): `name`, `registration`, `jobTitle`, `phone`, `email`, `role`, `hasAccess`, `isActive`, `contactAuthorization`, `authorizationSource`, `authorizationNote`, `authorizationDate`, `sector`, `shift`, `level`.

**C6 — API de pessoas do setor (T7–T8)**, `schemas/contracts/sector-people.schema.ts`:
- `sectorPersonSchema` (`:15-29`) ganha `registration: string | null`, `isActive: boolean`, `contactAuthorization: contactAuthorizationSchema`.
- `createSectorPersonBodySchema` (`:96-104`) ganha `registration` e `contactAuthorization` (opcionais). `addFromContactsBodySchema` (`:107-113`) ganha `contactAuthorization` (opcional, um para o lote).
- `updateSectorPersonBodySchema` (`:120-131`) ganha `registration`, `contactAuthorization` e `reason`; refine ignora `reason`; motivo obrigatório.
- `movePeopleBodySchema` (`:115-117`) ganha `reason?`. Novo `removeSectorPersonBodySchema = z.object({ reason: … .optional() }).strict()` (corpo opcional do DELETE).
- Novo `sectorPersonStatusBodySchema = z.object({ isActive: z.boolean(), reason: z.string().trim().max(200).optional() }).strict()` → `POST internal/sectors/:sectorId/people/:userId/status`, resposta `SectorPerson`.
- Novo `sectorPeopleListQuerySchema = z.object({ includeInactive: z.enum(['true','false']).optional().transform((v) => v === 'true') })` em `GET internal/sectors/:sectorId/people`.
- `sectorPeopleCandidatesResponseSchema.items` (`:56-65`) ganha `registration: string | null`.

**C7 — API da trilha (T9)**, `backend/src/schemas/contracts/audit-trail.schema.ts`:
```ts
export const auditCategorySchema = z.enum(['PERSON','ASSIGNMENT','SCHEDULE','STRUCTURE','PERMISSIONS']);
export const auditValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null(), z.object({ id: z.string(), name: z.string() })]);
export const fieldChangeSchema = z.object({ field: z.string(), before: auditValueSchema, after: auditValueSchema });
export const auditTrailEntrySchema = z.object({
  id: z.string(), createdAt: z.string(), action: z.string(),
  category: auditCategorySchema.nullable(),
  actor: z.object({ id: z.string(), name: z.string().nullable() }).nullable(),
  subject: z.object({ id: z.string(), name: z.string().nullable(), registration: z.string().nullable() }).nullable(),
  reason: z.string().nullable(),
  changes: fieldChangeSchema.array().nullable(),   // null = registro antigo
});
export const auditTrailQuerySchema = z.object({
  q: z.string().trim().max(80).optional(), from: civilDateSchema.optional(), to: civilDateSchema.optional(),
  category: auditCategorySchema.optional(),
  page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(50),
});
export const personHistoryQuerySchema = auditTrailQuerySchema.pick({ page: true, pageSize: true });
export const auditTrailPageSchema = z.object({ items: auditTrailEntrySchema.array(), total: z.number().int(), page: z.number().int(), pageSize: z.number().int() });
```
Rotas: `GET /audit-trail` (`@Roles('ADMIN')` + `canQueryAuditTrail`) e `GET /audit-trail/people/:userId` (`@Roles('ADMIN','SUPERVISOR')` + `canViewPersonHistory`). Mais recentes primeiro. Período em datas civis do fuso do app: `[zonedStart(from,'00:00'), zonedStart(addDays(to,1),'00:00'))`.

**C8 — Envio da equipe (T11, T18).**
- `teamSkipReasonSchema` (`team-whatsapp.schema.ts:14-18`) ganha `'NOT_AUTHORIZED'`.
- `teamRosterMemberSchema` (`:153-160`) ganha `contactAuthorization: z.enum(['AUTORIZADO','NAO_AUTORIZADO'])` e `authorizationUnverified: z.boolean()` (= origem `CADASTRO_ANTERIOR`).
- Ordem de exclusão, na montagem e no worker: `NO_PHONE` → `SUPPRESSED` → `NOT_AUTHORIZED`.

**C9 — Erros novos (GC7).**

| status | code | texto |
|---|---|---|
| 422 | `user.registration_taken` | Já existe uma pessoa com esta matrícula |
| 422 | `user.reason_required` | Informe o motivo da alteração, de 3 a 200 caracteres. |
| 422 | `user.authorization_future_date` | A data da autorização não pode ser futura. |
| 409 | `user.has_history` | Esta pessoa tem histórico e não pode ser excluída. Inative o cadastro. |
| 403 | `sector_people.status_forbidden` | Você não pode inativar ou reativar esta pessoa. Pessoa com acesso ao sistema, só o administrador. |
| 403 | `audit_trail.forbidden` | Você não pode ver o histórico desta pessoa. |

**C10 — Componentes compartilhados do front (T12)**, `frontend/src/features/people-record/`:
```ts
// authorization.ts
export type AuthorizationChoice =
  | { status: 'NAO_AUTORIZADO' }
  | { status: 'AUTORIZADO'; source: 'TERMO_ASSINADO'|'FICHA_ADMISSAO'|'ACEITE_WHATSAPP'|'OUTRO'; note?: string; date: string };
export const contactAuthorizationSchema;            // espelho de C4 (saída)
export function authorizationLabel(a: ContactAuthorization): string;
// "Cadastro anterior — origem não verificada" | "Termo assinado em dd/mm/aaaa" | "Ficha de admissão em …" |
// "Aceite pelo WhatsApp em …" | "Outro (<nota>) em …" | "Sem autorização registrada"
export function authorizationFlag(a: ContactAuthorization): 'unverified' | 'not_authorized' | null;
export function toAuthorizationInput(c: AuthorizationChoice): ContactAuthorizationInput;
// reason.ts
export const reasonSchema;                          // trim, 3..200, mensagem "Informe o motivo, de 3 a 200 caracteres"
// ui-policy.ts (GC5; só esconde botão, a API decide)
export function canChangePersonStatusUi(role: Role, person: { hasAccess: boolean }): boolean;
export function canViewPersonHistoryUi(role: Role): boolean;   // ADMIN, SUPERVISOR
export function canQueryAuditTrailUi(role: Role): boolean;     // ADMIN
// components/
AuthorizationField({ value: AuthorizationChoice | null, onChange, error?: string })   // criação e edição; sem pré-marcado
AuthorizationBadge({ authorization })               // "Origem não verificada" | "Sem autorização" | nada
RegistrationField({ value, onChange, error? })      // "Matrícula", até 30
ReasonField({ value, onChange, error? })            // "Motivo da alteração"
PersonStatusDialog({ person: { name: string; isActive: boolean }, open, onOpenChange, onConfirm: (reason: string) => Promise<void> })
```
Opções do `AuthorizationField`: Termo assinado, Ficha de admissão, Aceite pelo WhatsApp, Outro (texto até 120), Sem autorização registrada. Origem escolhida mostra a data (padrão hoje, `max` hoje). "Sem autorização registrada" mostra "Esta pessoa não receberá mensagens até a autorização ser registrada".

**C11 — Rótulos da trilha (T17a)**, `frontend/src/features/audit-trail/labels.ts`: categorias (Pessoa, Vínculo e setor, Escala, Estrutura, Permissões); campos (Nome, Matrícula, Função, Telefone, E-mail, Papel, Acesso ao sistema, Situação, Autorização de contato, Origem da autorização, Detalhe da origem, Data da autorização, Setor, Turno, Nível, Gestor); ações (C5 mais `sector.created` "Setor criado", `sector.updated` "Setor editado", `staff_schedule.*`, `shift.*`, `level.*`, `sector_people.*` antigos); ação desconhecida mostra o próprio código. Valor (função `formatAuditValue(field, value)`): `AuditRef` → nome; booleano → Sim/Não (`isActive` → Ativa/Inativa); `null` → "—"; papel por `ROLE_LABEL` (`features/users/role.ts:5-10`); `contactAuthorization`: `AUTORIZADO` → "Autorizado", `NAO_AUTORIZADO` → "Sem autorização"; `authorizationSource`: `TERMO_ASSINADO` → "Termo assinado", `FICHA_ADMISSAO` → "Ficha de admissão", `ACEITE_WHATSAPP` → "Aceite pelo WhatsApp", `OUTRO` → "Outro", `CADASTRO_ANTERIOR` → "Cadastro anterior — origem não verificada"; `authorizationDate` (`aaaa-mm-dd`) → `dd/mm/aaaa`.

## Review Focus

- Trilha realmente dentro da transação (aceite 8): o `recordChange` usa o `tx` recebido, nunca `this.prisma`; nenhum `catch` engole o erro dele.
- Nenhum telefone, e-mail completo ou senha em `changes`, `metadata` ou `reason` dos eventos novos; `user.invited` e `user.deleted` deixam de gravar e-mail cru.
- Diff sobre valor cru, máscara depois (GC2).
- Autorização: SUPERVISOR não inativa pessoa com login nem fora do alcance; OPERATOR nunca; SUPERVISOR não abre `GET /audit-trail` e só vê histórico de quem alcança, sem `STRUCTURE`/`PERMISSIONS`.
- Envio: `NOT_AUTHORIZED` conferido na montagem e no worker, depois de `NO_PHONE` e `SUPPRESSED`; `CADASTRO_ANTERIOR` não bloqueia.
- Exclusão física: `personHasHistory` cobre também `StaffSchedule` e `StaffScheduleException` (cascade apagaria a escala passada); a decisão de papel usa `req.user.role` passado pelo controller.
- Trilha da pessoa: `personHistory` e o backfill ignoram evento sem `category` (login, refresh, logout).
- Migração: sem perda; default final `NAO_AUTORIZADO`, igual ao `schema.prisma` (sem drift); `ADD VALUE` em migração separada.
- GC4 (sem gravação nova de setor/turno/nível) e GC5 (decisão só nas funções de política).

---

## Task 1 — Schema, migrações e contrato da autorização (back)

**Arquivos:**
- Modificar: `backend/prisma/schema.prisma` (`model User` `:44-98`, `model AuditEvent` `:1208-1222`, `enum TeamWhatsappSkipReason` `:1650`); `backend/prisma/seed.ts` (`upsert` `:25`).
- Criar: `backend/prisma/migrations/20261119090000_team_skip_not_authorized/migration.sql`; `backend/prisma/migrations/20261119091000_person_record_and_trail/migration.sql`; `backend/src/schemas/contracts/contact-authorization.schema.ts` e `contact-authorization.schema.spec.ts`; `backend/src/modules/users/person-record-migration.integration.spec.ts` (modelo: `backend/src/modules/users/user-access-migration.integration.spec.ts`).

**Interfaces:**
- Consome: `civilDateSchema` (`schemas/contracts/civil-date.schema.ts`).
- Produz: C1 e C4.

**Contexto vinculado:**
- Spec A2/R1: migração deixa toda pessoa existente `AUTORIZADO`, origem `CADASTRO_ANTERIOR`, data da autorização nula, registrado por nulo, registrado em = momento da migração. `CADASTRO_ANTERIOR` só existe pela migração.
- Spec Restrições: migração sem perda de dados, backfill em SQL na própria migração (padrão `20261021100000_shift_entity/migration.sql:39-43`).
- D1: `registration` + `registrationKey @unique` em minúsculas; sem índice funcional.
- D2: `contactAuthorization` default `NAO_AUTORIZADO`; `authorizationRecordedById` sem FK.
- D3: `AuditEvent` + `subjectUserId` (sem FK), `category`, `reason`, `changes`, com os dois índices.
- D4/C2: categoria por prefixo — `user.`→PERSON; `sector_people.`/`assignment.`→ASSIGNMENT; `staff_schedule.`→SCHEDULE; `sector.`/`shift.`/`level.`→STRUCTURE; `permission.`→PERMISSIONS; resto nulo.
- C1 (backfill): `subjectUserId = entityId` só quando `entity = 'User'` e `category` não é nula; eventos `auth.login_success`, `auth.login_failed`, `auth.refresh`, `auth.logout` ficam com `subjectUserId` e `category` nulos (senão o Histórico da pessoa se enche de refresh).
- D12: `ADD VALUE 'NOT_AUTHORIZED'` sozinho em `20261119090000_…`, sem uso do valor no mesmo arquivo.
- D13: admin do seed criado `AUTORIZADO`/`OUTRO`, nota "Seed de desenvolvimento".
- GC6: input sem `CADASTRO_ANTERIOR`; criação sem o campo = `NAO_AUTORIZADO`.

**Passos:**
1. [ ] RED `contact-authorization.schema.spec.ts` (`describe('contactAuthorizationInputSchema')`):
   - `it('aceita NAO_AUTORIZADO sem outros campos')`;
   - `it('recusa CADASTRO_ANTERIOR como origem')`;
   - `it('recusa OUTRO sem nota e nota acima de 120')`;
   - `it('aceita TERMO_ASSINADO sem data (o serviço usa hoje)')`.
2. [ ] RED `person-record-migration.integration.spec.ts` (seguir o padrão do arquivo-modelo para aplicar migrações até `20261110092000`, inserir linhas e aplicar o resto):
   - `it('pessoa existente vira AUTORIZADO / CADASTRO_ANTERIOR, data e autor nulos, registrado em preenchido')`;
   - `it('pessoa inserida depois sem o campo fica NAO_AUTORIZADO')`;
   - `it('registrationKey repetida estoura unique')`;
   - `it('AuditEvent antigo: User → subjectUserId = entityId e PERSON; staff_schedule.put → subjectUserId = metadata.userId e SCHEDULE; campaign.create → categoria nula')`;
   - `it('AuditEvent antigo auth.login_success (entity User) fica com subjectUserId e categoria nulos')`;
   - `it('TeamWhatsappRecipient aceita skipReason NOT_AUTHORIZED')`.
3. [ ] GREEN: `schema.prisma` conforme C1; as duas migrações (na segunda: `CREATE TYPE` ×3; `ADD COLUMN "contactAuthorization" … NOT NULL DEFAULT 'AUTORIZADO'`; `UPDATE` do backfill; `ALTER COLUMN … SET DEFAULT 'NAO_AUTORIZADO'`; índice único de `registrationKey`; colunas e índices de `AuditEvent`; `UPDATE` de categoria e, depois dele, `UPDATE` de `subjectUserId = entityId WHERE entity = 'User' AND category IS NOT NULL` — `auth.*` fica nulo, D18); contrato C4; seed (D13). `npx prisma validate` e `npx prisma generate`.
4. [ ] Conferir drift: `npx prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --shadow-database-url <do testcontainer ou do .env local>` sem diferença; se o ambiente não permitir, registrar como lacuna no relatório.
5. [ ] Validação: `timeout 600 gate --test src/schemas/contracts/contact-authorization.schema.spec.ts`, `timeout 600 gate --test src/modules/users/person-record-migration.integration.spec.ts`, `timeout 600 gate --changed --base feat/somente-evolution`.

**Aceite:** spec aceite 4 (parte de dados: existentes continuam `AUTORIZADO`/`CADASTRO_ANTERIOR`) e base de 3, 5, 7.

**Risco: alto** (migração não destrutiva com backfill de produção; default de coluna decide quem recebe envio).

## Task 2 — API de trilha em transação, máscaras e políticas (back)

**Arquivos:**
- Criar: `backend/src/shared/audit/audit-change.ts` e `audit-change.spec.ts`; `backend/src/shared/authz/person-actions.policy.ts` e `person-actions.policy.spec.ts`; `backend/src/shared/audit/audit.service.spec.ts` (se já existir, acrescentar `describe` irmão no topo).
- Modificar: `backend/src/shared/audit/audit.service.ts` (`log` `:29-55`), `backend/src/shared/audit/audit.repository.ts` (`AuditWriteData` `:5-13`, `create` `:23-35`); `backend/src/shared/audit/audit.repository.spec.ts` (confere os dados exatos do `create`; ajustar para `createIn` e os campos novos).

**Interfaces:**
- Consome: C1 (tipos Prisma `AuditCategory`, `Role`, `Prisma.TransactionClient`).
- Produz: C2 e C3.

**Contexto vinculado:**
- GC1: alterações de pessoa, autorização, situação, setor e pessoas do setor gravam a trilha na mesma transação; se a trilha falhar, a mudança não é gravada. Demais `audit.log` como hoje.
- GC2: telefone `•••• 1234`, e-mail `a•••@dominio`, senha nunca; compara cru, mascara depois.
- GC3: só campos alterados em `changes`.
- GC9: `log` mantém a assinatura; só ganha `opts` opcional.
- C2: `AuditChange.actorId` é obrigatório; `recordChange` grava esse ator e usa o CLS só para ip e user-agent.
- GC5 / Lote B: a decisão de quem inativa e quem consulta a trilha fica nas funções de C3; o Lote B troca o corpo delas por permissão.
- Sentença R2, `pessoas.inativar`: "Vale só nas pessoas dos setores que o ator alcança e só para pessoa sem login; pessoa com login só o ADMIN inativa ou reativa. Motivo obrigatório."
- Sentença R2, `trilha.consultar`: "Quem não é ADMIN consulta a trilha pela ficha de pessoa que alcança (pessoa, vínculo, escala). A consulta geral e as mudanças de estrutura e de permissões ficam só para o ADMIN." OPERATOR não tem `trilha.consultar`.
- Spec A2: altera a autorização quem pode editar a pessoa; pessoa com login, só o ADMIN.
- Spec A3: exclusão física só ADMIN.

**Passos:**
1. [ ] RED `audit-change.spec.ts`, um `describe` por função:
   - `diffFields`: só campos alterados; `before null` (criação) lista os não nulos com `before: null`; `AuditRef` compara por `id`; `present` aplicado depois — dois telefones com o mesmo final geram uma `FieldChange` com os dois lados mascarados iguais.
   - `maskPhone`: `'+5592988887777'` → `'•••• 7777'`; `null` → `null`; `'12'` → `'••••'`.
   - `maskEmail`: `'ana@gbr.com.br'` → `'a•••@gbr.com.br'`; sem `@` → `'•••'`.
   - `categoryOfAction` com `it.each` curto: `user.deleted` PERSON, `sector_people.moved` ASSIGNMENT, `staff_schedule.put` SCHEDULE, `sector.updated` STRUCTURE, `campaign.create` null.
2. [ ] RED `audit.service.spec.ts`:
   - `it('recordChange grava no tx recebido, com actorId explícito (não o do CLS), ip e user-agent do CLS, reason, changes e subjectUserId')` (tx falso com `auditEvent.create` espiado; `PrismaService` não é chamado);
   - `it('recordChange propaga erro do tx')`;
   - `it('log continua engolindo erro e deriva category da ação')`;
   - `it('log grava subjectUserId de opts')`.
3. [ ] RED `person-actions.policy.spec.ts`: `canChangePersonStatus` — ADMIN com login true; SUPERVISOR sem login no alcance true; SUPERVISOR com login false; SUPERVISOR fora do alcance false; OPERATOR false. `canViewPersonHistory` — ADMIN true; SUPERVISOR no alcance true, fora false; OPERATOR false. `canQueryAuditTrail` — só ADMIN. `personHistoryCategories` — ADMIN null; SUPERVISOR as três. `canEditContactAuthorization` — com login só ADMIN. `canDeletePerson` — só ADMIN.
4. [ ] GREEN pelas assinaturas de C2 e C3.
5. [ ] Validação: `timeout 600 gate --test src/shared/audit/audit-change.spec.ts`, `… src/shared/audit/audit.service.spec.ts`, `… src/shared/audit/audit.repository.spec.ts`, `… src/shared/authz/person-actions.policy.spec.ts`, `timeout 600 gate --changed --base feat/somente-evolution`.

**Aceite:** base dos aceites 2, 8 e 9.

**Risco: crítico (dado pessoal em log; autorização)**
**Crítico:** dado pessoal em log — define as máscaras de telefone e e-mail e a gravação de antes/depois na trilha; autorização — define as funções que decidem quem inativa e quem consulta a trilha.

## Task 3a — Ficha da pessoa: funções puras de matrícula, autorização e trilha (back)

**Arquivos:**
- Criar: `backend/src/modules/users/person-record.ts` e `person-record.spec.ts`; `backend/src/modules/users/person-audit.ts` e `person-audit.spec.ts`.
- Modificar: `backend/src/modules/users/users.errors.ts` (`registrationTaken`, `authorizationFutureDate`).

**Interfaces:**
- Consome: C2 (`diffFields`, `maskPhone`, `maskEmail`, `FieldChange`), C4, `todayIn` (`staff-schedule/civil-date.ts:19`), `toDbDate`/`fromDbDate` (`:56`, `:61`).
- Produz (para T3b, T4, T5, T7):
```ts
// person-record.ts
export function normalizeRegistration(raw: string | null | undefined): { registration: string | null; registrationKey: string | null };
export type AuthorizationRow = Pick<User, 'contactAuthorization'|'authorizationSource'|'authorizationNote'|'authorizationDate'|'authorizationRecordedAt'>;
export type AuthorizationColumns = Pick<Prisma.UserUncheckedCreateInput,
  'contactAuthorization'|'authorizationSource'|'authorizationNote'|'authorizationDate'|'authorizationRecordedById'|'authorizationRecordedAt'>;
export function authorizationColumns(input: ContactAuthorizationInput | undefined, actorId: string, now: Date, current?: AuthorizationRow): Partial<AuthorizationColumns>;
  // criação (sem current): undefined → NAO_AUTORIZADO; AUTORIZADO sem date → todayIn(now); date > hoje → throw authorizationFutureDate()
  // edição (com current): input undefined → {}; status, origem, nota e data efetiva (date ausente = hoje) iguais aos atuais → {} (D17: não regrava RecordedAt/RecordedById)
export function toContactAuthorization(row: AuthorizationRow): ContactAuthorization;
export function rethrowRegistrationConflict(error: unknown): never; // P2002 em registrationKey → registrationTaken(); senão relança
// person-audit.ts
export const personAuditSelect: Prisma.UserSelect;   // campos de C5 + sector/workShift/level { id, name }; nunca password
export type PersonAuditRow;
export function personAuditChanges(before: PersonAuditRow | null, after: PersonAuditRow | null): FieldChange[]; // diff cru, phone/email mascarados
// users.errors.ts
export function registrationTaken(): DomainError;       // C9
export function authorizationFutureDate(): DomainError; // C9
```

**Contexto vinculado:**
- Spec A1: matrícula opcional, até 30, aparada, única entre quem tem, sem diferenciar maiúsculas; repetida → `422 user.registration_taken` "Já existe uma pessoa com esta matrícula".
- Spec A2/R1: origem escolhida grava `AUTORIZADO` com a data informada (padrão hoje, não aceita futura), autor e momento; "Sem autorização registrada" grava `NAO_AUTORIZADO`; sem o campo grava `NAO_AUTORIZADO`; `CADASTRO_ANTERIOR` recusado.
- D17: reenviar a mesma autorização (status, origem, nota e data efetiva iguais) não mexe nas colunas; `authorizationRecordedAt`/`RecordedById` ficam fora de `PersonAuditField`, então regravá-las seria mudança sem trilha.
- D1: `registration` como digitado (aparado), `registrationKey` em minúsculas para unicidade.
- GC2: telefone `•••• 1234` e e-mail `a•••@dominio` na trilha, senha nunca (o `personAuditSelect` não tem `password`); compara cru, mascara depois.
- GC3: só campos alterados entram em `changes`.
- GC8: data civil com `todayIn`.
- C9: `user.registration_taken` (422), `user.authorization_future_date` (422).

**Passos:**
1. [ ] RED `person-record.spec.ts`: `normalizeRegistration(' Ab-12 ')` → `{ registration: 'Ab-12', registrationKey: 'ab-12' }`, vazio → nulos; `authorizationColumns(undefined, …)` → `NAO_AUTORIZADO` com autor e momento; com `TERMO_ASSINADO` sem data → data = hoje em Manaus (relógio fixo perto da meia-noite UTC); data futura → `user.authorization_future_date`; com `current` igual ao input (D17) → `{}`; com `current` e origem diferente → colunas novas com autor e momento; `toContactAuthorization` de uma linha `CADASTRO_ANTERIOR`.
2. [ ] RED `person-audit.spec.ts`: criação lista telefone `•••• 7777` e e-mail mascarado; `sector` sai `{ id, name }`; nenhum campo `password`; edição só do telefone para outro com o mesmo final gera uma `FieldChange` com os dois lados iguais.
3. [ ] GREEN pelas assinaturas.
4. [ ] Validação: `timeout 600 gate --test src/modules/users/person-record.spec.ts`, `… src/modules/users/person-audit.spec.ts`, `npm run build`, `timeout 600 gate --changed --base feat/somente-evolution`.

**Aceite:** base dos aceites 2, 5, 7 e 8 (funções puras).

**Risco: crítico (dado pessoal em log)**
**Crítico:** dado pessoal em log — `personAuditChanges` e `personAuditSelect` definem o retrato da pessoa (telefone e e-mail mascarados) que a trilha grava.

## Task 3b — Ficha na criação: serviço, repositório e trilha na transação (back)

**Arquivos:**
- Criar: `backend/src/modules/users/users.service.person-record.spec.ts`.
- Modificar: `backend/src/modules/users/dto/create-user.dto.ts` (`:16-68`) e `create-user.dto.spec.ts`; `users.service.ts` (`personWithoutAccessData` `:117-137`, `toUserSummary` `:142-165`, `createUser` `:208-248`, `createInvitation` `:267-293`, `createPersonWithoutAccess` `:300-325`); `users.repository.ts` (`USER_SUMMARY_SELECT` `:8-30`, `create`/`createSummary` `:93-100`); `backend/src/schemas/contracts/user.schema.ts` (`:3-35`); `users.repository.integration.spec.ts` (`describe` novo no topo); `users.service.spec.ts` (e `users.service.access.spec.ts`, se esperar `audit.log('user.invited')` / `'user.person_created'`: trocar pela expectativa de `recordChange`).

**Interfaces:**
- Consome: T3a (`normalizeRegistration`, `authorizationColumns`, `toContactAuthorization`, `rethrowRegistrationConflict`, `personAuditSelect`, `personAuditChanges`, `registrationTaken`), C2 (`recordChange` com `actorId` explícito), C4.
- Produz:
```ts
// users.repository.ts
createWithAudit(data: Prisma.UserCreateInput, audit: (tx: Prisma.TransactionClient, row: PersonAuditRow) => Promise<void>): Promise<UserSummary>
findIdByRegistrationKey(key: string): Promise<string | null>
// users.service.ts (C5)
createPersonWithoutAccess(actorId: string, input: PersonWithoutAccessInput): Promise<UserSummary>
  // PersonWithoutAccessInput ganha registration?: string | null; contactAuthorization?: ContactAuthorizationInput
```

**Contexto vinculado:**
- Spec A1/A2/R1: pessoa nova, igual nas três portas; matrícula repetida → `422 user.registration_taken`; API sem `contactAuthorization` grava `NAO_AUTORIZADO`; `CADASTRO_ANTERIOR` recusado (GC6, D15). Nada derivado de `Contact.sourceOrigin`.
- GC1: criação grava a trilha na mesma transação (`user.invited` com acesso, `user.person_created` sem acesso; `PERSON`; `subjectUserId` = a pessoa; `reason` nulo — cadastro novo não pede motivo, spec A4); se a trilha falhar, a pessoa não é criada.
- C2: `recordChange` recebe o `actorId` explícito (o ator que o serviço já tem), não o do CLS.
- GC2: telefone e e-mail mascarados na trilha; senha nunca; `user.invited` deixa de gravar e-mail cru.
- GC4: não criar gravação nova de `sectorId/shiftId/levelId`; só acrescentar campos aos objetos já existentes de `createInvitation` e `personWithoutAccessData`.
- GC13: chamadores e specs existentes de `createUser`/`createPersonWithoutAccess` continuam compilando.
- C9: `user.registration_taken`, `user.authorization_future_date`.

**Passos:**
1. [ ] RED `users.service.person-record.spec.ts`:
   - `it('createUser sem contactAuthorization grava NAO_AUTORIZADO')`;
   - `it('createPersonWithoutAccess com TERMO_ASSINADO grava AUTORIZADO, data, autor')`;
   - `it('matrícula repetida (pré-checagem e P2002) → 422 user.registration_taken')`;
   - `it('criação chama recordChange no tx com user.person_created, PERSON, actorId explícito, sem e-mail ou telefone completos')`.
2. [ ] RED `create-user.dto.spec.ts` (`describe` novo): aceita `registration` e `contactAuthorization` nos dois ramos; recusa `CADASTRO_ANTERIOR`.
3. [ ] RED `users.repository.integration.spec.ts` (`describe('createWithAudit (aceite 8)')`): callback de auditoria que lança → nenhuma linha de `User` criada.
4. [ ] GREEN pelas assinaturas. `USER_SUMMARY_SELECT` ganha as colunas de C1; `toUserSummary` devolve `registration` e `contactAuthorization` (C5). O `audit.log('user.invited', …email…)` e o `'user.person_created'` saem e viram `recordChange` no callback do `createWithAudit`; ajustar `users.service.spec.ts` (e `users.service.access.spec.ts`) que esperavam esses `audit.log`.
5. [ ] Validação: `timeout 600 gate --test` em cada spec acima e em `src/modules/users/users.service.spec.ts`; `npm run build`; `timeout 600 gate --changed --base feat/somente-evolution`.

**Aceite:** spec aceites 5 (API), 7 (matrícula repetida na criação), 8 (criação).

**Risco: crítico (dado pessoal em log)**
**Crítico:** dado pessoal em log — passa a gravar o retrato da pessoa criada (telefone e e-mail mascarados) na trilha.

## Task 4 — Edição com motivo e trilha em transação, inativar e reativar (back)

**Arquivos:**
- Criar: `backend/src/modules/users/change-reason.ts` e `change-reason.spec.ts`; `backend/src/modules/users/users.service.edit-trail.spec.ts`.
- Modificar: `backend/src/modules/users/dto/update-user.dto.ts` (`:4-24`); `users.controller.ts` (PATCH `:72-78`); `users.service.ts` (`UserPatch` `:32-45`, `updateUser` `:376-422`, `toUpdateData` `:500-522`, `lastAdminGuard` `:549-564`); `users.repository.ts` (`updateWithLastAdminGuard` `:174-197`); `person-audit.ts` (T3a); `users.errors.ts`; `users.repository.integration.spec.ts` (`describe` novo no topo); `users.service.spec.ts` (esperam `audit.log('user.role_changed')`/`'user.profile_updated'` de `:411-420`: trocar pela expectativa de `recordChange`).

**Interfaces:**
- Consome: C2, C3 (não decide nada novo aqui: /users é só ADMIN), T3a (`personAuditSelect`, `personAuditChanges`, `normalizeRegistration`, `authorizationColumns(input, actorId, now, current)`, `rethrowRegistrationConflict`).
- Produz:
```ts
// change-reason.ts
export function requireReason(raw: string | undefined): string;          // trim; <3 ou ausente → 422 user.reason_required
export function optionalReason(raw: string | undefined): string | null;  // ausente/vazio → null; 1–2 chars → 422
// person-audit.ts (+)
export function personChangeAction(changes: readonly FieldChange[]): string;
  // isActive → user.deactivated | user.reactivated; role → user.role_changed;
  // só campos authorization* → user.authorization_changed; senão user.profile_updated
// users.service.ts
updateUser(id: string, input: UserPatch, actorId: string, meta: PersonChangeMeta = { reason: null }): Promise<void>
  // UserPatch ganha registration?: string | null; contactAuthorization?: ContactAuthorizationInput
// users.repository.ts
updateWithLastAdminGuard(id, data, audit?: (tx, before: PersonAuditRow, after: PersonAuditRow) => Promise<void>):
  Promise<{ updated: PersonAuditRow } | { lastAdmin: true }>
// users.errors.ts
export function reasonRequired(): DomainError; // C9
```

**Contexto vinculado:**
- Spec A4: toda edição de pessoa existente pede "Motivo da alteração", 3 a 200 caracteres; vale para inativar, reativar e alterar a autorização; sem motivo, `422 user.reason_required`. Mover e tirar do setor aceitam motivo opcional.
- Spec A3: inativa não recebe envio (`INACTIVE`), não entra em público novo, não faz login; ninguém inativa a si mesmo; último ADMIN ativo não pode ser inativado (guarda existente).
- D6: em `/users`, inativar/reativar = `PATCH /users/:id { isActive, reason }`; a revogação de sessão de hoje (`changesIdentity`, `:492-498`, `revokeAllForUser` `:410`) continua.
- GC1: a edição grava a trilha no mesmo `runSerializable` do update; falha da trilha desfaz o update.
- GC2/GC3: só campos alterados; telefone e e-mail mascarados; diff cru, máscara depois.
- GC4: sem gravação nova de setor/turno/nível; `toUpdateData` só ganha `registration`/`registrationKey` e as colunas de autorização.
- C2: `recordChange` recebe o `actorId` explícito (o `actorId` de `updateUser`), não o do CLS.
- D17: `toUpdateData` chama `authorizationColumns(input, actorId, now, current)` com a autorização atual da pessoa; reenviar a mesma autorização devolve `{}`: nenhuma coluna é regravada e, sem outra mudança, nenhuma trilha.
- C5: `updateUser(…, meta)`, ações e `PersonAuditField`.
- Aceite 1: editar telefone e situação muda o público de um envio novo; destinatários de envio anterior continuam iguais.

**Passos:**
1. [ ] RED `change-reason.spec.ts`: `requireReason(undefined)` e `'ab'` → 422 `user.reason_required`; `' ajuste '` → `'ajuste'`; `optionalReason(undefined)` → `null`.
2. [ ] RED `users.service.edit-trail.spec.ts`:
   - `it('aceite 2: edição de telefone e função grava só os dois campos, telefone mascarado, autor, motivo')`;
   - `it('isActive false grava user.deactivated, revoga sessão; true grava user.reactivated')`;
   - `it('só autorização grava user.authorization_changed com antes e depois')`;
   - `it('matrícula de outra pessoa → 422 user.registration_taken')`;
   - `it('meta.action e meta.category substituem os derivados (uso do setor)')`;
   - `it('nada mudou → não grava trilha')`;
   - `it('reenviar a mesma autorização não regrava authorizationRecordedAt/RecordedById nem grava trilha (D17)')`.
3. [ ] RED `users.controller.spec.ts` ou no service spec: `PATCH` sem `reason` → 422 `user.reason_required` (o controller chama `requireReason` e passa `{ reason }` ao serviço).
4. [ ] RED `users.repository.integration.spec.ts`:
   - `describe('updateWithLastAdminGuard + trilha (aceite 8)')`: callback que lança → nome e telefone continuam os antigos;
   - `describe('aceite 1')`: com um `TeamWhatsappRecipient` antigo da pessoa, mudar telefone e `isActive` não altera a linha do destinatário (`userName`, `status`, `skipReason`).
5. [ ] GREEN pelas assinaturas. `updateUser` monta o callback que chama `recordChange(tx, { action: meta.action ?? personChangeAction(changes), category: meta.category ?? 'PERSON', subjectUserId: id, actorId, reason: meta.reason, changes })` e pula quando `changes` é vazio. O `audit.log` de `user.role_changed`/`user.profile_updated` (`:411-420`) sai. `rethrowPhoneConflict` dentro de `lastAdminGuard` passa a tratar também a matrícula. Chamadas atuais com 3 argumentos continuam compilando (meta opcional).
6. [ ] Validação: `timeout 600 gate --test` em cada spec tocado; `npm run build`; `timeout 600 gate --changed --base feat/somente-evolution`.

**Aceite:** spec aceites 1, 2, 6 (inativar/reativar em `/users`), 7 (matrícula repetida na edição), 8.

**Risco: crítico (dado pessoal em log)**
**Crítico:** dado pessoal em log — grava antes/depois da ficha (telefone e e-mail mascarados) na trilha a cada edição, inativação e reativação.

## Task 5 — Exclusão só sem histórico e concessão de acesso na trilha (back)

**Arquivos:**
- Modificar: `backend/src/modules/users/users.service.ts` (`grantAccess` `:332-363`, `deleteUser` `:566-596`); `users.repository.ts` (`grantAccess` `:108-117`, `deleteWithLastAdminGuard` `:147-167`); `users.errors.ts`; `users.controller.ts` (DELETE: passa `req.user.id` e `req.user.role`); `users.service.access.spec.ts` e `users.service.spec.ts` (esperam `audit.log('user.access_granted')` / `'user.deleted'`: trocar pela expectativa de `recordChange`) e `users.repository.integration.spec.ts` (`describe` novos no topo).
- Criar: `backend/src/modules/users/person-history.ts` e `person-history.spec.ts` (ou só integração, se o unitário não agregar).

**Interfaces:**
- Consome: C2, C3 (`canDeletePerson`), T3a/T4 (`personAuditSelect`, `personAuditChanges`).
- Produz:
```ts
// person-history.ts
export async function personHasHistory(tx: Prisma.TransactionClient, userId: string): Promise<boolean>;
// users.service.ts
deleteUser(id: string, actorId: string, actorRole: Role): Promise<void>
  // o controller passa req.user.id e req.user.role (JwtPayload); o serviço chama canDeletePerson({ id: actorId, role: actorRole }) antes da transação e,
  // se falso, recusa com o erro de proibido já usado pelo módulo; o actorId também vai no recordChange (C2)
// users.repository.ts
deleteWithLastAdminGuard(id, audit: (tx, before: PersonAuditRow) => Promise<void>):
  Promise<{ deleted: PersonAuditRow } | { lastAdmin: true } | { hasHistory: true }>
grantAccess(id, data: AccessGrantData, audit: (tx, before: PersonAuditRow, after: PersonAuditRow) => Promise<void>): Promise<UserSummary | null>
// users.errors.ts
export function hasHistory(): ConflictError; // 409 user.has_history, texto C9
```

**Contexto vinculado:**
- Spec A3 (decisão minha): `DELETE /users/:id` só ADMIN e só sem histórico. Tem histórico quem aparece em envio da equipe (destinatário ou autor), escreveu comunicado interno ou comentário, tem conversa atribuída **ou tem escala ou exceção de escala** (apagar a pessoa apagaria a escala passada por `onDelete: Cascade`; anti-objetivo da spec). Com histórico, `409 user.has_history` "Esta pessoa tem histórico e não pode ser excluída. Inative o cadastro."
- D7 — consulta exata do histórico, dentro da transação serializável do DELETE: existe `TeamWhatsappRecipient{ userId }` (schema `:1715`) **ou** `TeamWhatsappDispatch{ authorId }` (`:1658`) **ou** `InternalCommunication{ authorId }` (`:182`) **ou** `InternalEvent{ actorId, kind: 'COMMENTED' }` (`:225`, enum `:129-131`) **ou** `Conversation{ assignedUserId }` (`:909`) **ou** `StaffSchedule{ userId }` (relação com `onDelete: Cascade`, `:1775`) **ou** `StaffScheduleException{ userId }` (`:1802`). Cada uma com `findFirst({ select: { id: true } })`; confirmar o nome do campo da pessoa nos dois modelos de escala em `schema.prisma`.
- GC1: exclusão e concessão de acesso gravam a trilha na transação (`user.deleted`, `user.access_granted`, `PERSON`). `user.deleted` deixa de gravar e-mail cru (`:592-595`).
- GC2: e-mail mascarado; senha e hash nunca.
- GC5: a regra "só ADMIN exclui" passa por `canDeletePerson`, com o papel vindo de `req.user.role` (controller → serviço).
- C2: `recordChange` recebe o `actorId` explícito (`deleteUser`/`grantAccess` já têm o ator).
- GC13: chamadores e specs existentes de `deleteUser` (agora com 3 argumentos) ajustados nesta task.
- Guardas existentes continuam: auto-exclusão `403 user.cannot_delete_self` (`:570-575`); último ADMIN (`:577-586`).

**Passos:**
1. [ ] RED `users.repository.integration.spec.ts` (`describe('exclusão com histórico (aceite 6)')`):
   - `it('pessoa destinatária de envio da equipe → hasHistory, linha continua')`;
   - `it('pessoa com conversa atribuída → hasHistory')`;
   - `it('pessoa só com exceção de escala (sem outro histórico) → hasHistory, a exceção continua')` (o serviço devolve 409 `user.has_history`);
   - `it('pessoa só com escala (StaffSchedule) → hasHistory')`;
   - `it('pessoa sem nada → excluída e trilha user.deleted gravada no tx')`;
   - `it('trilha que lança desfaz a exclusão')`.
2. [ ] RED no serviço: `deleteUser` com `hasHistory` → 409 `user.has_history`; `deleteUser` com `actorRole` diferente de ADMIN → recusado por `canDeletePerson`; `grantAccess` grava `user.access_granted` com `hasAccess false→true`, `role` e e-mail mascarado; trilha que lança → acesso não concedido (integração).
3. [ ] GREEN pelas assinaturas; `refresh.revokeAllForUser` continua depois da transação.
4. [ ] Validação: `timeout 600 gate --test src/modules/users/users.repository.integration.spec.ts`, `… src/modules/users/users.service.access.spec.ts`, `… src/modules/users/users.service.spec.ts`, `timeout 600 gate --changed --base feat/somente-evolution`.

**Aceite:** spec aceite 6 (exclusão 409/204) e 8.

**Risco: crítico (dado pessoal em log)**
**Crítico:** dado pessoal em log — grava o retrato mascarado da pessoa excluída e da concessão de acesso na trilha; também decide quando a exclusão física é recusada.

## Task 6 — Lista de usuários: busca, filtros e contadores (back)

**Arquivos:**
- Criar: `backend/src/modules/users/user-list-where.ts` e `user-list-where.spec.ts`.
- Modificar: `backend/src/modules/users/dto/list-users.dto.ts`; `users.repository.ts` (`UserListFilters` `:42`, `findMany` `:62-80`); `users.service.ts` (`listUsers` `:199-206`); `users.controller.ts` (`listUsers` `:36`); `backend/src/schemas/contracts/user.schema.ts` (`userListResponseSchema` `:37-42`); `users.repository.integration.spec.ts` (`describe` novo).

**Interfaces:**
- Consome: C1, C5.
- Produz:
```ts
export type UserListFilters = { hasAccess?: boolean; q?: string; status?: 'active'|'inactive'|'all'; authorization?: 'UNVERIFIED'|'NOT_AUTHORIZED' };
export function userListWhere(filters: UserListFilters): Prisma.UserWhereInput;
  // q → OR [name contains insensitive, registrationKey contains q.toLowerCase()]
  // UNVERIFIED → contactAuthorization AUTORIZADO e authorizationSource CADASTRO_ANTERIOR; NOT_AUTHORIZED → NAO_AUTORIZADO
countAuthorizationPending(): Promise<{ unverified: number; notAuthorized: number }> // só isActive = true
```

**Contexto vinculado:**
- Spec A1: `GET /users` ganha busca por nome ou matrícula.
- Spec A2: filtro ("Origem não verificada", "Sem autorização") e contador na lista de usuários.
- Spec A3: as listas escondem inativos por padrão e têm "Mostrar inativos".
- D9: `status` default `all` no back (contrato atual intacto); a tela manda `active`. Contadores sobre ativos da base inteira, sem paginação.

**Passos:**
1. [ ] RED `user-list-where.spec.ts`: `q` monta o OR com a chave em minúsculas; `status: 'active'` → `isActive: true`; `authorization` nos dois valores; tudo ausente → `{}`.
2. [ ] RED integração: `it('aceite 7: busca "ab-12" acha a pessoa de matrícula "AB-12"')`; `it('contadores contam só ativos')`.
3. [ ] GREEN; controller repassa a query; resposta com `authorizationCounts`.
4. [ ] Validação: `timeout 600 gate --test src/modules/users/user-list-where.spec.ts`, `… src/modules/users/users.repository.integration.spec.ts`, `timeout 600 gate --changed --base feat/somente-evolution`.

**Aceite:** spec aceite 7 (lista de usuários) e parte do 4 (contador).

**Risco: médio** (listagem; contrato aditivo).

## Task 7 — Pessoas do setor: escrita com matrícula, autorização e motivo (back)

**Arquivos:**
- Modificar: `backend/src/schemas/contracts/sector-people.schema.ts` (`:15-29`, `:96-131`); `backend/src/modules/sector-people/sector-people-write.service.ts` (`personPatch` `:47-53`, `create` `:74-95`, `addFromContacts` `:98-130`, `move` `:133-160`, `update` `:162-179`, `remove` `:181-196`, `addContact` `:209-229`); `sector-people.policy.ts` (`PersonField` `:24`, `canEditPerson` `:56-64`); `sector-people.controller.ts` (`move` `:93`, `update` `:105`, `remove` `:117`); `sector-people.repository.ts` (`sectorPersonSelect` `:24-34`, `toSectorPerson` `:94-…`); specs do módulo (`describe` novos no topo).

**Interfaces:**
- Consome: C3 (`canEditContactAuthorization`), C4, C5 (`createPersonWithoutAccess` com `registration`/`contactAuthorization`, T3b; `updateUser(…, meta)`, T4), T4 (`requireReason`, `optionalReason`), `toContactAuthorization` (T3a), `PeopleActor` (`sector-people.policy.ts:7-12`, o ator que `requireManageable` já devolve).
- Produz: C6 (exceto status, lista e candidatos, que são da T8).

**Contexto vinculado:**
- Spec A2/R1: as três portas pedem a autorização; em "a partir de contatos" a escolha é uma só para o lote, e nada é derivado de `Contact.sourceOrigin`; sem o campo, `NAO_AUTORIZADO`. Altera a autorização quem pode editar a pessoa; pessoa com login, só o ADMIN.
- Spec A4: editar pessoa do setor exige motivo (`422 user.reason_required`); mover e tirar aceitam motivo opcional; cadastro novo não pede.
- Spec A5: pessoas do setor — edição, mover, tirar, adicionar — gravam antes/depois. Mover/tirar por pessoa: `sector_people.person_moved` / `sector_people.person_removed`, categoria `ASSIGNMENT`, via `updateUser(id, { sectorId }, actorId, { reason, action, category: 'ASSIGNMENT' })`. Os `audit.log` de lote atuais (`sector_people.moved` `:154`, `.removed` `:191`, `.added` `:278`) continuam.
- GC4: mover e tirar continuam passando por `users.updateUser` (`:152`, `:190`); nenhuma gravação nova de setor/turno/nível.
- GC5 / D16: pessoa com acesso continua `limited` em `canEditPerson` (só nível, função, turno); `registration` e `contactAuthorization` entram em `PersonField` e ficam fora do `limited`, então `canEditPerson` já recusa (403 `sector_people.forbidden`) matrícula e autorização de pessoa com login, até para o ADMIN (ele usa `/users`). Ponto exato da chamada: em `sector-people-write.service.update`, logo depois de `canEditPerson` passar e antes de `updateUser`, quando o corpo traz `contactAuthorization`, chamar `canEditContactAuthorization(actor, { hasAccess: person.hasAccess })` com o `PeopleActor` de `requireManageable` (`{ id, role }`); falso → 403 `sector_people.forbidden`. É guarda explícita para o Lote B: com a regra atual ela só devolve verdadeiro para pessoa sem login.
- C2: o `updateUser(…, meta)` recebe o `actorId` do `PeopleActor` e o repassa ao `recordChange`.

**Passos:**
1. [ ] RED no spec do write service (`describe('ficha no setor')`):
   - `it('create e from-contacts repassam contactAuthorization; from-contacts usa a mesma para o lote')`;
   - `it('update sem reason → 422 user.reason_required; com reason → updateUser recebe { reason }')`;
   - `it('update de contactAuthorization de pessoa com acesso → 403 (limited), inclusive para ADMIN')`;
   - `it('update de contactAuthorization de pessoa sem acesso chama canEditContactAuthorization com o PeopleActor e passa')`;
   - `it('move repassa action sector_people.person_moved, ASSIGNMENT e reason opcional')`;
   - `it('remove repassa sector_people.person_removed e reason do corpo')`.
2. [ ] RED no spec do contrato ou do controller: `createSectorPersonBodySchema` recusa `CADASTRO_ANTERIOR`; `updateSectorPersonBodySchema` só com `reason` → 400 (refine).
3. [ ] GREEN; `SectorPerson` devolve `registration`, `isActive`, `contactAuthorization`.
4. [ ] Validação: `timeout 600 gate --test` nos specs tocados de `src/modules/sector-people/`; `timeout 600 gate --changed --base feat/somente-evolution`.

**Aceite:** spec aceites 2 e 5 (portas do setor).

**Risco: crítico (autorização)**
**Crítico:** autorização — estende `canEditPerson` com matrícula e autorização de contato e decide quem pode alterá-las na página do setor.

## Task 8 — Pessoas do setor: inativar/reativar, mostrar inativos, busca por matrícula (back)

**Arquivos:**
- Modificar: `backend/src/schemas/contracts/sector-people.schema.ts`; `sector-people.controller.ts` (`list` `:43`, rota nova de status); `sector-people.service.ts` (listagem); `sector-people-write.service.ts` (`setStatus` novo); `sector-people.repository.ts` (`nameOrPhoneWhere` `:72-80`, `listPeople` `:212-217`, select de candidatos `:220-…`); `sector-people.errors.ts`; specs do módulo (`describe` novos no topo).

**Interfaces:**
- Consome: C3 (`canChangePersonStatus`, com o `PeopleActor` de `requireManageable` como ator), C6, T4 (`requireReason`, `updateUser`), `requireManageable` (`sector-people.service.ts:38-54`), `PeopleActor` (`sector-people.policy.ts:7-12`).
- Produz:
```ts
setStatus(actorId: string, sectorId: string, userId: string, body: { isActive: boolean; reason?: string }): Promise<SectorPerson>
listPeople(sectorId: string, includeInactive: boolean)
export function sectorPeopleStatusForbidden(): DomainError; // 403 sector_people.status_forbidden, texto C9
```

**Contexto vinculado:**
- Spec A3/R2: ADMIN inativa e reativa qualquer pessoa; SUPERVISOR só pessoa sem login dos setores que alcança; pessoa com login, só o ADMIN; OPERATOR não. Motivo obrigatório. Ninguém inativa a si mesmo; último ADMIN ativo não pode ser inativado (guardas do `UsersService`).
- Alcance no setor = `requireManageable` passou (ADMIN, ou gestor do setor ativo) **e** `person.sectorId === sector.id`. A pessoa pode estar inativa: não usar `requirePerson` (`:251-255`, que exige ativa).
- D6: `POST internal/sectors/:sectorId/people/:userId/status { isActive, reason }` → `users.updateUser(userId, { isActive }, actorId, { reason })` (ação `user.deactivated`/`user.reactivated`).
- Spec A3: lista esconde inativos por padrão; `includeInactive=true` mostra.
- Spec A1: busca de pessoas e candidatos do setor acha também pela matrícula (`registrationKey contains q.toLowerCase()`, junto do nome e telefone de hoje).
- GC5: decisão só em `canChangePersonStatus`.
- C9: `403 sector_people.status_forbidden`.

**Passos:**
1. [ ] RED (`describe('status no setor')`, até 50 linhas):
   - `it('SUPERVISOR gestor inativa pessoa sem login do setor; updateUser recebe { isActive:false } e reason')`;
   - `it('SUPERVISOR em pessoa com login → 403 sector_people.status_forbidden')`;
   - `it('OPERATOR gestor → 403')`;
   - `it('pessoa de outro setor → 403 sector_people.forbidden (existente)')`;
   - `it('sem reason → 422 user.reason_required')`;
   - `it('reativar pessoa inativa funciona (não exige ativa)')`.
2. [ ] RED (`describe('lista e busca')`): `listPeople` sem flag → só ativos; com flag → inclui inativos; `nameOrPhoneWhere('ab-12')` inclui `registrationKey`; candidatos devolvem `registration`.
3. [ ] GREEN.
4. [ ] Validação: `timeout 600 gate --test` nos specs tocados; `timeout 600 gate --changed --base feat/somente-evolution`.

**Aceite:** spec aceites 6 (setor) e 7 (busca no setor).

**Risco: crítico (autorização)**
**Crítico:** autorização — decide quem inativa e reativa pessoa pela página do setor (gate de acesso: inativar derruba o login).

## Task 9 — Consulta da trilha: geral e histórico por pessoa (back)

**Arquivos:**
- Criar: `backend/src/schemas/contracts/audit-trail.schema.ts`; `backend/src/modules/audit-trail/audit-trail.module.ts`, `audit-trail.controller.ts`, `audit-trail.service.ts`, `audit-trail.repository.ts`, `audit-trail.service.spec.ts`, `audit-trail.controller.spec.ts`, `audit-trail.repository.integration.spec.ts`.
- Modificar: `backend/src/app.module.ts` (lista `imports` `:83-111`).

**Interfaces:**
- Consome: C1, C3 (`canQueryAuditTrail`, `canViewPersonHistory`, `personHistoryCategories`), C7, `findTeamActor(prisma, id)` (`team-whatsapp/team-actor.query.ts:8-11`), `viewableSectorIds(actor)` (`staff-schedule/staff-schedule.policy.ts:18-21`; `null` = todos), `zonedStart`/`addDays` (`staff-schedule/civil-date.ts:47`, `:31`), `@Roles` (`auth/decorators/roles.decorator.ts:4-5`).
- Produz:
```ts
// audit-trail.service.ts
list(actorId: string, query: AuditTrailQuery): Promise<AuditTrailPage>
personHistory(actorId: string, userId: string, query: PersonHistoryQuery): Promise<AuditTrailPage>
// audit-trail.repository.ts
findPage(where: Prisma.AuditEventWhereInput, page: number, pageSize: number): Promise<{ rows; total }>
findPeopleByIds(ids: readonly string[]): Promise<Array<{ id; name; registration }>>
findSubjectIdsByQuery(q: string, take: number): Promise<string[]>   // nome ou registrationKey
```

**Contexto vinculado:**
- Spec A5: consulta com filtro por pessoa (nome ou matrícula), período e tipo (Pessoa, Vínculo e setor, Escala, Estrutura, Permissões), paginada, mais recentes primeiro. Registros antigos aparecem sem antes/depois (`changes: null`). Trilha só de leitura.
- Sentença R2 `trilha.consultar`: "Quem não é ADMIN consulta a trilha pela ficha de pessoa que alcança (pessoa, vínculo, escala). A consulta geral e as mudanças de estrutura e de permissões ficam só para o ADMIN." OPERATOR não consulta.
- D8: consulta geral lista só eventos com `category` não nula.
- D18: `personHistory` também filtra `category IS NOT NULL` (ADMIN: `{ not: null }`; SUPERVISOR: `{ in: personHistoryCategories }`), para `auth.login_success`/`auth.refresh`/`auth.logout`, que não têm categoria, não encherem o Histórico.
- Alcance do SUPERVISOR: `viewableSectorIds(actor)` contém `person.sectorId`. Pessoa inexistente: 404 só para ADMIN; para os demais, 403 (padrão de `requireManageable`, `sector-people.service.ts:38-54`).
- GC2: a resposta não acrescenta dado pessoal: `actor` e `subject` só com id, nome (e matrícula do sujeito).
- GC5: decisão só nas funções de C3; o `@Roles` das duas rotas espelha a matriz (`ADMIN` / `ADMIN, SUPERVISOR`).
- C9: `403 audit_trail.forbidden`.

**Passos:**
1. [ ] RED `audit-trail.service.spec.ts` (`describe` curtos):
   - `it('list monta where com categoria, período em Manaus (fim exclusivo no dia seguinte) e q → subjectUserId in')`;
   - `it('personHistory SUPERVISOR no alcance filtra categorias PERSON, ASSIGNMENT, SCHEDULE')`;
   - `it('personHistory SUPERVISOR fora do alcance → 403 audit_trail.forbidden; pessoa inexistente → 403')`;
   - `it('personHistory ADMIN sem filtro de categoria, mas com category não nula; pessoa inexistente → 404')`;
   - `it('personHistory monta where { subjectUserId, category: { not: null } } para ADMIN e { in: [...] } para SUPERVISOR')`;
   - `it('entrada sem changes sai com changes null; actor e subject resolvidos por id')`.
2. [ ] RED `audit-trail.controller.spec.ts`: metadados de `@Roles` — `list` só `ADMIN` (SUPERVISOR recebe 403 pelo guard); `personHistory` `ADMIN, SUPERVISOR` (OPERATOR fora).
3. [ ] RED `audit-trail.repository.integration.spec.ts`: evento de uma pessoa com `category` nula (ex.: `auth.refresh`) fica fora da consulta da pessoa; ordem `createdAt desc`, paginação e `total`; usa o índice `(subjectUserId, createdAt)` só por filtro (sem asserção de plano).
4. [ ] GREEN; registrar `AuditTrailModule` em `app.module.ts`.
5. [ ] Validação: `timeout 600 gate --test` nos três specs; `npm run build`; `timeout 600 gate --changed --base feat/somente-evolution`.

**Aceite:** spec aceite 9 (back).

**Risco: crítico (autorização)**
**Crítico:** autorização — decide quem vê a trilha geral e o histórico de cada pessoa (dado pessoal mascarado de terceiros).

## Task 10 — Trilha de setores e escala (back)

**Arquivos:**
- Criar: `backend/src/modules/internal-sectors/sector-audit.ts` e `sector-audit.spec.ts`.
- Modificar: `backend/src/modules/internal-sectors/internal-sectors.service.ts` (`create` `:43-48`, `update` `:49-55`, construtor `:30`); `internal-sectors.repository.ts` (`create` `:56-58`, `update` `:59-62`); `internal-sectors.controller.ts` (só se o ator não chegar ao serviço: passar `req.user.id` a `create`/`update`); `backend/src/modules/staff-schedule/staff-schedule-edit.service.ts` (`audit.log` em `:46`, `:57`, `:76`, `:93`); specs dos dois módulos (`describe` novos no topo).

**Interfaces:**
- Consome: C2 (`recordChange`, `diffFields`, `log(..., opts)`).
- Produz:
```ts
export const sectorAuditSelect: Prisma.SectorSelect;   // id, name, isActive, manager { id, name }
export function sectorAuditChanges(before: SectorAuditRow | null, after: SectorAuditRow): FieldChange[]; // name, manager (AuditRef), isActive
// internal-sectors.repository.ts
createWithAudit(data: Prisma.SectorCreateInput, audit: (tx, row: SectorAuditRow) => Promise<void>)
updateWithAudit(id: string, data: Prisma.SectorUpdateInput, audit: (tx, before: SectorAuditRow, after: SectorAuditRow) => Promise<void>)
```

**Contexto vinculado:**
- Spec A5: setor — criação e edição (nome, gestor, ativo), hoje não registradas, passam a gravar antes/depois na mesma transação (GC1). Ações `sector.created` / `sector.updated`, `entity 'Sector'`, categoria `STRUCTURE` (D4), sem `subjectUserId`.
- Spec A5: escala — os quatro registros existentes passam a apontar a pessoa afetada: `opts.subjectUserId = userId` nas quatro chamadas; categoria `SCHEDULE` vem de `categoryOfAction`. Escala não entra na transação (spec só pede apontar a pessoa).
- GC9: os quatro `log` mantêm os argumentos atuais; só ganham o 5º.
- C2: `recordChange` exige `actorId` explícito; o serviço de setores passa o ator do controller (`req.user.id`) a `create`/`update` e o repassa ao `recordChange`; chamadores e specs existentes ajustados (GC13).
- GC2: o gestor entra na trilha só como `{ id, name }`, sem telefone nem e-mail.
- O `this.write(...)` atual do serviço de setores (tradução de erro de unicidade) continua envolvendo a gravação. `AuditModule` é `@Global` (`audit.module.ts:6`): basta injetar `AuditService`.

**Passos:**
1. [ ] RED `sector-audit.spec.ts`: criação lista nome, gestor `{ id, name }` e ativo; edição só com gestor trocado gera uma `FieldChange`.
2. [ ] RED no spec do serviço de setores: `create` e `update` chamam `recordChange` no tx com `sector.created`/`sector.updated`, `STRUCTURE` e `actorId` explícito; falha da trilha propaga; o gestor sai só como `{ id, name }`.
3. [ ] RED no spec de `staff-schedule-edit.service`: as quatro chamadas passam `{ subjectUserId: userId }`.
4. [ ] GREEN.
5. [ ] Validação: `timeout 600 gate --test` nos specs tocados; `timeout 600 gate --changed --base feat/somente-evolution`.

**Aceite:** spec aceite 9 (tipos Estrutura e Escala aparecem na consulta) e A5.

**Risco: crítico (dado pessoal em log)**
**Crítico:** dado pessoal em log — grava o gestor do setor (`manager { id, name }`, nome de pessoa) no antes/depois da trilha de setor; a escrita de setor também passa a rodar em transação.

## Task 11 — Envio da equipe: NOT_AUTHORIZED na montagem, no worker e no roster (back)

**Arquivos:**
- Modificar: `backend/src/schemas/contracts/team-whatsapp.schema.ts` (`teamSkipReasonSchema` `:14-18`, `teamRosterMemberSchema` `:153-160`); `backend/src/modules/team-whatsapp/team-whatsapp.repository.ts` (`teamMemberSelect` `:39-50`, `teamMemberRowSelect` `:56-…`); `team-whatsapp.service.ts` (`classify` `:642-672`); `team-whatsapp-send.processor.ts` (`recipientSelect` `:36-45`, `FinishData` `:70-73`, `precheck` `:264-270`); `team-whatsapp.roster.ts` (`toRosterMember` `:215-…`); `team-whatsapp.test-fixtures.ts` (membros ganham os campos novos); specs de service, processor e roster (`describe` novos no topo); e os specs de integração de `backend/src/modules/team-whatsapp/` que criam usuários com `prisma.user.create`/`db.user.create`/`createMany` (Grep de 19/11): `team-whatsapp.schedule.integration.spec.ts` (`:101`, `:123`, `:452-517`; roda o `TeamWhatsappSendProcessor` real), `team-whatsapp.retry.integration.spec.ts` (`:78`), `team-whatsapp.repository.integration.spec.ts` (vários `user.create` e o `createMany` de `:743`) e `team-dispatch-sectors.integration.spec.ts` (`:253`, `:258`). Depois da T1 esses usuários nascem `NAO_AUTORIZADO`; nos que são destinatários ou membros do público, passar `contactAuthorization: 'AUTORIZADO'` (autores e usuários que nunca recebem envio não precisam). Refazer o Grep no início da task: qualquer outro spec de integração do módulo que crie usuário destinatário entra na mesma lista.

**Interfaces:**
- Consome: C1 (`contactAuthorization`, `authorizationSource`), C8.
- Produz: C8 (`NOT_AUTHORIZED`; roster com `contactAuthorization` e `authorizationUnverified`).

**Contexto vinculado:**
- Spec A2/R1: `NAO_AUTORIZADO` fica fora de todo envio, motivo `NOT_AUTHORIZED` ("Contato não autorizado"), conferido na montagem dos destinatários e de novo no worker, depois de sem telefone e de supressão. Supressão continua por cima. `CADASTRO_ANTERIOR` não bloqueia.
- Spec A2: prévia mostra quem é `NAO_AUTORIZADO` pelo nome no grupo "Contato não autorizado"; havendo `CADASTRO_ANTERIOR`, linha informativa com a contagem (o front conta por `authorizationUnverified`, D11).
- Anti-objetivo: pessoa marcada "sem autorização" receber mensagem da equipe.
- Ordem C8: `NO_PHONE` → `SUPPRESSED` → `NOT_AUTHORIZED`. O desfecho de `Message` já gravada continua antes das pré-checagens (`processor :173-176`).
- Envio agendado: a pessoa vira `QUEUED` no disparo e o worker pula com `NOT_AUTHORIZED` se a autorização foi retirada depois do agendamento (aceite 3).

**Passos:**
1. [ ] RED service spec (`describe('autorização no envio')`): membro com telefone, sem supressão e `NAO_AUTORIZADO` → `SKIPPED`/`NOT_AUTHORIZED`; suprimido e `NAO_AUTORIZADO` → `SUPPRESSED`; `CADASTRO_ANTERIOR` → pendente.
2. [ ] RED processor spec: destinatário `QUEUED` cujo usuário passou a `NAO_AUTORIZADO` → `finish` com `SKIPPED`/`NOT_AUTHORIZED`; sem telefone continua `NO_PHONE`.
3. [ ] RED roster spec: `toRosterMember` devolve `contactAuthorization` e `authorizationUnverified` (true só para `CADASTRO_ANTERIOR`).
4. [ ] GREEN.
5. [ ] Marcar `contactAuthorization: 'AUTORIZADO'` nos usuários destinatários/membros dos specs de integração listados em Arquivos (o `--changed` pode não pegá-los, por isso a lista é explícita).
6. [ ] Validação: `timeout 600 gate --test` nos três specs de unidade e em cada um dos quatro specs de integração de team-whatsapp acima (`schedule`, `retry`, `repository`, `team-dispatch-sectors`); `npm run build`; `timeout 600 gate --changed --base feat/somente-evolution`.

**Aceite:** spec aceites 3 (back) e 4 (roster); nenhum spec de integração de team-whatsapp quebra por causa do default `NAO_AUTORIZADO`.

**Risco: alto** (bloqueio de envio e contrato da prévia; nenhuma das categorias críticas).

## Task 12 — Componentes compartilhados da ficha (front)

**Arquivos:**
- Criar em `frontend/src/features/people-record/`: `authorization.ts` e `authorization.spec.ts`; `reason.ts`; `ui-policy.ts` e `ui-policy.spec.ts`; `components/authorization-field.tsx` e `.spec.tsx`; `components/authorization-badge.tsx`; `components/registration-field.tsx`; `components/reason-field.tsx`; `components/person-status-dialog.tsx` e `.spec.tsx`.

**Interfaces:**
- Consome: C4 (formato), C9 (textos vêm da API pelo leitor de corpo de erro existente; ky 2 consome o corpo, usar o helper `readApiErrorBody` do projeto).
- Produz: C10.

**Contexto vinculado:**
- Spec A2: campo obrigatório "Autorização de contato", sem valor pré-marcado, opções Termo assinado, Ficha de admissão, Aceite pelo WhatsApp, Outro (texto até 120) e "Sem autorização registrada"; origem escolhida grava a data informada (padrão hoje, não aceita futura); "Sem autorização registrada" mostra "Esta pessoa não receberá mensagens até a autorização ser registrada".
- Spec A2: rótulos "Cadastro anterior — origem não verificada"; "Termo assinado em dd/mm/aaaa"; "Sem autorização registrada". Selo: "Origem não verificada" / "Sem autorização".
- Spec A4: "Motivo da alteração", 3 a 200 caracteres.
- GC5: `ui-policy.ts` só esconde botões; espelha C3 (ADMIN inativa qualquer pessoa; SUPERVISOR só sem login; histórico ADMIN e SUPERVISOR; consulta geral só ADMIN).
- GC8: "hoje" no fuso do app (America/Manaus); usar o helper de data civil do front, se existir; senão `Intl.DateTimeFormat('en-CA', { timeZone: 'America/Manaus' })` dentro de `authorization.ts`.
- GC12: textos pt-BR.

**Passos:**
1. [ ] RED `authorization.spec.ts`: `authorizationLabel` para `CADASTRO_ANTERIOR`, `TERMO_ASSINADO` com data, `OUTRO` com nota, `NAO_AUTORIZADO`; `authorizationFlag`; `toAuthorizationInput`.
2. [ ] RED `authorization-field.spec.tsx`: nada marcado no início; escolher "Outro" exige texto; escolher "Sem autorização registrada" mostra o aviso; data com `max` = hoje.
3. [ ] RED `person-status-dialog.spec.tsx`: confirmar sem motivo mostra o erro e não chama `onConfirm`; com motivo chama `onConfirm('…')`; título "Inativar <nome>?" / "Reativar <nome>?".
4. [ ] RED `ui-policy.spec.ts`: `canChangePersonStatusUi` (ADMIN com login true; SUPERVISOR com login false; OPERATOR false).
5. [ ] GREEN, com componentes Radix/shadcn já usados nas telas.
6. [ ] Validação (cwd `frontend/`): `timeout 600 gate --test` nos quatro specs; `timeout 600 gate --changed --base feat/somente-evolution`.

**Aceite:** base dos aceites 2, 4, 5 e 6 no front.

**Risco: médio**.

## Task 13 — Usuários: diálogos e API (front)

**Arquivos:**
- Modificar: `frontend/src/features/users/schemas.ts`; `frontend/src/features/users/api.ts` (`useUpdateUser` `:112-119`, `useDeleteUser` `:136-139`, hook de listagem e de criação); `components/edit-user-dialog.tsx`; `components/invite-user-dialog.tsx`; specs `edit-user-dialog-ui.spec.tsx`, `invite-user-dialog.spec.tsx` e `api.spec.ts` (`describe` novos no topo; `api.spec.ts:110,117` chamam `useUsers(1, 100, { hasAccess: true })` e `useUsers(1, 20)` e continuam valendo).

**Interfaces:**
- Consome: C5, C10.
- Produz (para a T14):
```ts
useUsers(page = 1, pageSize = 20, filters?: UsersFilters)   // assinatura atual mantida (api.ts:40); chamadas existentes (assign-menu.tsx:27, users/index.tsx:48) seguem compilando (GC13)
type UsersFilters = { hasAccess?: boolean; q?: string; status?: 'active'|'inactive'|'all'; authorization?: 'UNVERIFIED'|'NOT_AUTHORIZED' }
  // hasAccess já existe e continua sendo enviado; q, status e authorization só vão na query quando informados
useSetUserStatus(): mutation({ id, isActive, reason })   // PATCH users/:id
useDeleteUser(): mutation(id)                            // 409 user.has_history → mensagem da API
```

**Contexto vinculado:**
- Spec A1: matrícula nos dois diálogos de edição.
- Spec A2: "Autorização de contato" obrigatória no cadastro (com ou sem login), sem pré-marcado; na edição, mostra a atual e permite registrar outra; pessoa com login, só o ADMIN altera (a tela de usuários já é só ADMIN).
- Spec A4: edição exige "Motivo da alteração"; cadastro novo não pede.
- D6: o campo "Situação" (`AccessField` `edit-active`, `edit-user-dialog.tsx:74-76`) sai do diálogo; inativar e reativar viram ações da lista (T14).
- Erros C9 exibidos com o texto da API: `user.registration_taken`, `user.reason_required`, `user.authorization_future_date`.
- GC13: `useUsers(page, pageSize, filters?)` mantém a assinatura; `assign-menu.tsx:27` (`useUsers(1, 100, { hasAccess: true })`) e `users/index.tsx:48` (`useUsers(page, 20)`, que é da T14) continuam compilando e o filtro `hasAccess` não se perde.

**Passos:**
1. [ ] RED `api.spec.ts` (`describe('filtros da ficha')`): `useUsers(1, 20, { q: 'ab', status: 'active', authorization: 'NOT_AUTHORIZED' })` manda os três na query; `useUsers(1, 100, { hasAccess: true })` continua mandando só `hasAccess`.
2. [ ] RED `edit-user-dialog-ui.spec.tsx` (`describe('ficha')`): salvar sem motivo mostra o erro e não chama a API; com motivo envia `reason`, `registration` e só a autorização alterada; não há mais o campo "Situação".
3. [ ] RED `invite-user-dialog.spec.tsx`: sem escolher a autorização, o envio é bloqueado com "Escolha a autorização de contato"; com "Termo assinado" envia `contactAuthorization` com a data; matrícula repetida mostra "Já existe uma pessoa com esta matrícula".
4. [ ] GREEN (schemas espelham C5).
5. [ ] Validação: `timeout 600 gate --test` nos specs tocados; `timeout 600 gate --changed --base feat/somente-evolution`.

**Aceite:** spec aceites 2, 5 e 7 (porta `POST /users`).

**Risco: médio**.

## Task 14 — Usuários: lista com matrícula, selo, filtros, inativar e histórico (front)

**Arquivos:**
- Modificar: `frontend/src/routes/_authenticated/users/index.tsx` (menu da linha `:169-175`, diálogo de remoção `:195-202`, colunas `:133-154`); `frontend/src/routes/_authenticated/users/index.spec.tsx` (`describe` novos no topo).

**Interfaces:**
- Consome: T13 (`useUsers(page, pageSize, filters?)` com `{ q, status, authorization }`, `useSetUserStatus`, `useDeleteUser`), C10 (`AuthorizationBadge`, `PersonStatusDialog`, `ui-policy`), T17b (`PersonHistoryDialog`).

**Contexto vinculado:**
- Spec A3: "Remover usuário" sai; entram **Inativar** e **Reativar** (motivo obrigatório) e "Excluir cadastro" como ação secundária, que mostra "Esta pessoa tem histórico e não pode ser excluída. Inative o cadastro." quando recusada. Inativos escondidos por padrão; filtro "Mostrar inativos".
- Spec A1: coluna Matrícula; busca por nome ou matrícula.
- Spec A2: selo na linha, filtro ("Origem não verificada", "Sem autorização") e contador (`authorizationCounts`).
- D9: a tela manda `status: 'active'` até marcar "Mostrar inativos" (`'all'`), chamando `useUsers(page, 20, { q, status, authorization })`.
- D10: ação "Histórico" abre o `PersonHistoryDialog` (T17b: `{ person: { id, name }, open, onOpenChange }`).
- Guarda existente: ação desabilitada para o próprio usuário (`isSelf`, `:173-175`).

**Passos:**
1. [ ] RED `index.spec.tsx`:
   - `it('mostra matrícula e selo "Origem não verificada"')`;
   - `it('busca envia q e "Mostrar inativos" envia status all')`;
   - `it('filtro "Sem autorização" envia authorization NOT_AUTHORIZED; contador mostra os números')`;
   - `it('Inativar pede motivo e chama PATCH com isActive false; linha inativa oferece Reativar')`;
   - `it('Excluir cadastro recusado mostra a mensagem de histórico')`;
   - `it('Histórico abre o diálogo')`.
2. [ ] GREEN.
3. [ ] Validação: `timeout 600 gate --test src/routes/_authenticated/users/index.spec.tsx`; `timeout 600 gate --changed --base feat/somente-evolution`.

**Aceite:** spec aceites 6 e 7 (lista de usuários), 4 (rótulo e contador).

**Risco: médio**.

## Task 15 — Pessoas do setor: diálogos, abas e API (front)

**Arquivos:**
- Modificar: `frontend/src/features/sector-people/schemas.ts`; `frontend/src/features/sector-people/api.ts` (`useUpdateSectorPerson` `:37-41`, `useRemoveSectorPerson` `:46-49`, `useCreateSectorPerson` `:78`, hook de "a partir de contatos" e da listagem); `components/edit-person-dialog.tsx`; `components/new-person-tab.tsx`; `components/contacts-tab.tsx`; specs `edit-person-dialog.spec.tsx`, `new-person-tab.spec.tsx`, `contacts-tab.spec.tsx`, `api.spec.tsx` (`describe` novos no topo).

**Interfaces:**
- Consome: C6, C10.
- Produz (para a T16):
```ts
useSectorPeople(sectorId: string, opts?: { includeInactive?: boolean })   // opts opcional, padrão false: `$sectorId.tsx:30` (T16) continua compilando (GC13)
useSetSectorPersonStatus(sectorId): mutation({ userId, isActive, reason })  // POST …/people/:userId/status
```

**Contexto vinculado:**
- Spec A2/R1: "pessoa nova no setor" e "a partir de contatos" pedem a autorização; em contatos, uma escolha só para o lote; nada derivado do contato.
- Spec A4: editar pessoa do setor exige motivo; cadastro novo não pede. D14: mover e tirar não pedem motivo na tela.
- Spec A1: matrícula no diálogo de edição e no cadastro de pessoa nova.
- Pessoa com acesso (`editable: 'limited'`, contrato `:14`): matrícula e autorização ficam só leitura no diálogo.
- Erros C9 pelo texto da API.
- GC13: `useSectorPeople(sectorId, opts?)` com `opts` opcional (padrão `includeInactive: false`); `$sectorId.tsx:30` (`useSectorPeople(sectorId)`, que é da T16) continua compilando.

**Passos:**
1. [ ] RED `edit-person-dialog.spec.tsx`: salvar sem motivo bloqueia; com motivo envia `reason`; pessoa `limited` não mostra autorização editável.
2. [ ] RED `new-person-tab.spec.tsx` e `contacts-tab.spec.tsx`: sem autorização escolhida não envia; a escolha vai no corpo (uma para o lote em contatos).
3. [ ] RED `api.spec.tsx`: `useSetSectorPersonStatus` chama `POST internal/sectors/:id/people/:userId/status`; listagem com `includeInactive=true`; `useSectorPeople(sectorId)` sem `opts` não manda o parâmetro.
4. [ ] GREEN.
5. [ ] Validação: `timeout 600 gate --test` nos specs tocados; `timeout 600 gate --changed --base feat/somente-evolution`.

**Aceite:** spec aceites 2 e 5 (portas do setor).

**Risco: médio**.

## Task 16 — Pessoas do setor: lista com selo, filtros, busca, inativar e histórico (front)

**Arquivos:**
- Modificar: `frontend/src/features/sector-people/components/people-table.tsx` (ações da linha `:59`, colunas `:47-48`); `frontend/src/routes/_authenticated/setores/$sectorId.tsx`; `frontend/src/routes/_authenticated/setores/$sectorId.spec.tsx` (`describe` novos no topo).

**Interfaces:**
- Consome: T15 (`useSectorPeople(sectorId, { includeInactive })`, `useSetSectorPersonStatus`), C10 (`AuthorizationBadge`, `PersonStatusDialog`, `canChangePersonStatusUi`, `canViewPersonHistoryUi`), T17b (`PersonHistoryDialog`).

**Contexto vinculado:**
- Spec A3: a lista do setor ganha **Inativar** e **Reativar** com motivo; "Tirar do setor" continua como hoje; inativos escondidos por padrão, filtro "Mostrar inativos".
- Spec A3/R2: o botão só aparece para quem pode (ADMIN; SUPERVISOR em pessoa sem login); a API decide (403 `sector_people.status_forbidden` mostra o texto).
- Spec A1: matrícula na lista; aceite 7 pede achar pela matrícula na lista do setor: campo de busca local por nome ou matrícula sobre as pessoas carregadas.
- Spec A2: selo, filtro ("Origem não verificada", "Sem autorização") e contador, calculados sobre a lista carregada.
- D10: "Histórico" (ADMIN e SUPERVISOR) abre o `PersonHistoryDialog` (T17b: `{ person: { id, name }, open, onOpenChange }`).

**Passos:**
1. [ ] RED `$sectorId.spec.tsx`:
   - `it('mostra matrícula e selo; contador conta origem não verificada e sem autorização')`;
   - `it('busca local por matrícula filtra a lista')`;
   - `it('Mostrar inativos recarrega com includeInactive')`;
   - `it('SUPERVISOR vê Inativar em pessoa sem login e não vê em pessoa com login')`;
   - `it('OPERATOR não vê Inativar nem Histórico')`.
2. [ ] GREEN.
3. [ ] Validação: `timeout 600 gate --test src/routes/_authenticated/setores/$sectorId.spec.tsx`; `timeout 600 gate --changed --base feat/somente-evolution`.

**Aceite:** spec aceites 6 e 7 (setor), 4 (rótulo e contador).

**Risco: médio**.

## Task 17a — Tela Trilha de alterações, rota e menu (front)

**Arquivos:**
- Criar: `frontend/src/features/audit-trail/schemas.ts`, `api.ts`, `labels.ts` e `labels.spec.ts`, `components/trail-table.tsx`; `frontend/src/routes/_authenticated/trilha/index.tsx` e `index.spec.tsx`.
- Modificar: `frontend/src/lib/nav.ts` (`NAV` `:78-90`).

**Interfaces:**
- Consome: T12 (`canQueryAuditTrailUi` de `features/people-record/ui-policy.ts`), C7, C11.
- Produz (para a T17b):
```ts
// api.ts
useAuditTrail(query: { q?: string; from?: string; to?: string; category?: AuditCategory; page: number; pageSize: number })
usePersonHistory(userId: string, page: number)       // GET audit-trail/people/:userId; consumido pela T17b
// labels.ts
categoryLabel, fieldLabel, actionLabel, formatAuditValue(field, value)   // C11
// components/trail-table.tsx
TrailTable({ entries: AuditTrailEntry[], showSubject: boolean })        // autor, data/hora, tipo, pessoa (se showSubject), motivo, antes/depois; reaproveitada pela T17b
```

**Contexto vinculado:**
- Spec A5: tela **Trilha de alterações** no menu, filtro por pessoa (nome ou matrícula), período e tipo (Pessoa, Vínculo e setor, Escala, Estrutura, Permissões), paginada, mais recentes primeiro; cada linha mostra autor, data e hora, tipo, pessoa, motivo e o antes/depois por campo; registro antigo mostra "Registro anterior, sem detalhe das alterações".
- Spec A5/R2: consulta geral só ADMIN.
- GC5: a guarda da rota e o item de menu usam `canQueryAuditTrailUi(role)` (ADMIN) da T12; a T17a não decide papel por conta própria, por isso vem depois da T12.
- Item de menu: `{ to: '/trilha', label: 'Trilha de alterações', icon: History, section: 'admin', roles: ['ADMIN'] }`; guarda de rota como `routes/_authenticated/users/index.tsx:35-41`, mas pela função `canQueryAuditTrailUi`.
- C11: rótulos de categoria, campo, ação e valor, incluindo `contactAuthorization` (Autorizado / Sem autorização) e `authorizationSource` (Termo assinado, Ficha de admissão, Aceite pelo WhatsApp, Outro, Cadastro anterior — origem não verificada); GC12: nunca mostrar `NAO_AUTORIZADO` ou `CADASTRO_ANTERIOR` crus.
- Rota nova do TanStack Router: o `routeTree.gen.ts` é regenerado pelo plugin no build/dev; rodar o build do front para regenerar.

**Passos:**
1. [ ] RED `labels.spec.ts`: ação conhecida e desconhecida; `AuditRef` → nome; `isActive` → Ativa/Inativa; `null` → "—"; `contactAuthorization` `NAO_AUTORIZADO` → "Sem autorização"; `authorizationSource` `CADASTRO_ANTERIOR` → "Cadastro anterior — origem não verificada"; `authorizationDate` → `dd/mm/aaaa`.
2. [ ] RED `trilha/index.spec.tsx`: filtros viram query (`q`, `from`, `to`, `category`); paginação; não-ADMIN redirecionado; registro com `changes: null` mostra "Registro anterior, sem detalhe das alterações".
3. [ ] GREEN; `nav.ts` com o item.
4. [ ] Validação: `timeout 600 gate --test src/features/audit-trail/labels.spec.ts`, `… src/routes/_authenticated/trilha/index.spec.tsx`; `npm run build` (regenera rotas); `timeout 600 gate --changed --base feat/somente-evolution`.

**Aceite:** spec aceite 9 (front, tela geral) e 2 (exibição de antes/depois).

**Risco: médio**.

## Task 17b — Diálogo Histórico da pessoa (front)

**Arquivos:**
- Criar: `frontend/src/features/audit-trail/components/person-history-dialog.tsx` e `person-history-dialog.spec.tsx`.

**Interfaces:**
- Consome: T17a (`usePersonHistory`, `TrailTable`, `labels.ts`), C7, C11.
- Produz (para T14 e T16):
```ts
PersonHistoryDialog({ person: { id: string; name: string }, open: boolean, onOpenChange: (open: boolean) => void })
```

**Contexto vinculado:**
- Spec A5/R2: Histórico da pessoa para ADMIN e SUPERVISOR no alcance; 403 da API (`audit_trail.forbidden`) mostra "Você não pode ver o histórico desta pessoa."; consulta paginada, mais recentes primeiro; a API já filtra por categoria (SUPERVISOR não vê Estrutura nem Permissões) e ignora eventos sem categoria (D18).
- D10: "Ficha" = este diálogo, aberto pela ação "Histórico" das duas listas (T14 e T16).
- C11/GC12: valores por `formatAuditValue`, sem enum cru; telefone aparece como "Telefone: •••• 1234 → •••• 5678" (já mascarado pela API).

**Passos:**
1. [ ] RED `person-history-dialog.spec.tsx`: lista entradas com motivo e "Telefone: •••• 1234 → •••• 5678"; 403 mostra o texto da API; paginação pede a página seguinte.
2. [ ] GREEN, reaproveitando `TrailTable` com `showSubject: false`.
3. [ ] Validação: `timeout 600 gate --test src/features/audit-trail/components/person-history-dialog.spec.tsx`; `timeout 600 gate --changed --base feat/somente-evolution`.

**Aceite:** spec aceite 9 (front, Histórico da pessoa).

**Risco: médio**.

## Task 18 — Envio da equipe: grupo "Contato não autorizado" e linha informativa (front)

**Arquivos:**
- Modificar: `frontend/src/features/team-whatsapp/schemas.ts` (membro do roster `:50-…`, motivo `:95`, comentário `:206`); `member-filter.ts` (`canReceive` `:6`); `components/member-selection.tsx` (grupos `:142-143`, `MemberSelection` `:148-151`); `error-messages.ts` (`:31-33`); specs `member-selection.spec.tsx`, `error-messages.spec.ts` (`describe` novos no topo; ajustar o `it` de `:72` que lista os motivos).

**Interfaces:**
- Consome: C8.
- Produz: `canReceive(m) = !!m.phoneE164 && m.contactAuthorization !== 'NAO_AUTORIZADO'`; `isNotAuthorized(m) = !!m.phoneE164 && m.contactAuthorization === 'NAO_AUTORIZADO'`; `unverifiedCount(members, selectedIds): number`.

**Contexto vinculado:**
- Spec A2: quem está `NAO_AUTORIZADO` aparece pelo nome nas exclusões, no grupo "Contato não autorizado", sem caixa de seleção. Havendo destinatários com `CADASTRO_ANTERIOR`, linha informativa sem bloqueio: "N destinatários com origem de autorização não verificada (cadastro anterior)".
- O grupo "Sem telefone" continua só para quem não tem telefone (`!m.phoneE164`).
- Rótulo do motivo `NOT_AUTHORIZED` nas telas de resultado e histórico: "Contato não autorizado".

**Passos:**
1. [ ] RED `member-selection.spec.tsx`: membro com telefone e `NAO_AUTORIZADO` aparece em "Contato não autorizado", sem checkbox, e não em "Escalados"; dois selecionados com `authorizationUnverified` mostram "2 destinatários com origem de autorização não verificada (cadastro anterior)"; nenhum → linha ausente.
2. [ ] RED `error-messages.spec.ts`: `['SKIPPED', 'NOT_AUTHORIZED', 'Pulado: Contato não autorizado']`.
3. [ ] GREEN.
4. [ ] Validação: `timeout 600 gate --test` nos specs tocados; `timeout 600 gate --changed --base feat/somente-evolution`.

**Aceite:** spec aceites 3 (prévia) e 4 (linha informativa).

**Risco: médio**.

## Task 19 — Novidades (front)

**Arquivos:**
- Modificar: `frontend/src/release-notes.ts` (topo de `RELEASE_NOTES`, `:32`).

**Contexto vinculado:**
- Spec A6: uma nota explicando matrícula, autorização de contato, inativar no lugar de excluir, motivo da alteração e a tela da trilha.
- `frontend/CLAUDE.md`: entrada nova no topo, versão `YYYY.MM.DD`, texto para o operador, `where` só com tela específica. Formato igual à nota `2026.11.10` (`release-notes.ts:44-66`).

**Passos:**
1. [ ] Entrada `{ version: '2026.11.19', date: '2026-11-19', title: 'Ficha da pessoa e trilha de alterações', items: [...] }` com estes textos:
   - "Cada pessoa pode ter matrícula. A busca da lista de usuários e da página do setor também acha pela matrícula." (`where: '/users'`)
   - "Ao cadastrar alguém, informe a autorização de contato: termo assinado, ficha de admissão, aceite pelo WhatsApp ou outro. Quem fica sem autorização não recebe mensagens da equipe. Quem já estava cadastrado aparece como \"Cadastro anterior — origem não verificada\" e continua recebendo." (`where: '/users'`)
   - "No lugar de excluir, use Inativar. A pessoa deixa de receber mensagens e de entrar no sistema, e o histórico fica guardado. Reativar devolve tudo." (`where: '/users'`)
   - "Toda alteração no cadastro pede o motivo." 
   - "A nova tela Trilha de alterações mostra quem mudou o quê, quando, o antes e o depois, e o motivo. Na lista, a ação Histórico mostra as alterações de uma pessoa." (`where: '/trilha'`)
2. [ ] Validação: `timeout 600 gate --test src/release-notes.spec.ts`; `timeout 600 gate --changed --base feat/somente-evolution`.

**Aceite:** spec A6.

**Risco: baixo** (`mecanico`).

---

## Fechamento (principal)

- Gate completo do back e do front contra a base, sem violação nova nem agravada (comparar com o completo da base; o `--changed` não pega `describe` que cresce nem toda função nova).
- Migrações aplicadas na stack local de QA (`orgamind-turnos-qa`) a partir de uma cópia com dados; conferir o backfill (contagem de `CADASTRO_ANTERIOR` = pessoas antes da migração).
- Boot real da API e do worker.
- QA visual: diálogos com autorização e motivo, as duas listas (selo, filtro, contador, inativos, Inativar/Reativar, Excluir cadastro), Histórico, tela Trilha, prévia do envio com os dois avisos.
- Ledger com decisões D1–D18, aceites cobertos e lacunas.

## Não verificado

- O mecanismo exato de `backend/src/modules/users/user-access-migration.integration.spec.ts` para aplicar migrações até um ponto (T1 usa como modelo, não foi lido).
- Nome do campo da pessoa em `StaffSchedule` e `StaffScheduleException` (`schema.prisma:1775`, `:1802`), assumido `userId` na T5 (o implementador confirma no schema).
- Se `InternalEvent` com `kind = COMMENTED` é o único registro de comentário de comunicado (T5); o enum (`schema.prisma:129-131`) e `actorId` (`:225`) foram confirmados, o fluxo de comentário não.
- Corpo de `sector-people.service.ts` (listagem e `requireManageable`) e de `canEditPerson` (`policy.ts:56-64`) além das assinaturas.
- Frontend: miolo de `edit-user-dialog.tsx`, `invite-user-dialog.tsx`, `new-person-tab.tsx`, `contacts-tab.tsx`, `people-table.tsx`, `$sectorId.tsx` e `users/index.tsx`; existência de helper de data civil no front; outros consumidores de `GET /users` (por isso D9 mantém o default `all`).
- Se o `gate --test` roda os `*.integration.spec.ts` com testcontainers no ambiente do implementador.
- Se `npx prisma migrate diff` com shadow database está disponível localmente (T1, passo 4).

## Estado (19/11/2026)

Lote concluído: as 21 tasks aceitas, cada uma com revisão independente e gate; revisão final do conjunto sem Critical nem Important.

- **Gate completo no estado final, contra a base (`feat/somente-evolution`):** back 5773/5803 testes (30 ignorados, igual à base), cobertura 94,1/85,2; front 1930/1930, cobertura 86,6/80,5. Lint, sonar e complexidade sem nada novo nem agravado.
- **Migração:** aplicada numa cópia com dados (42 pessoas → `AUTORIZADO` / `CADASTRO_ANTERIOR`) e na stack local de QA.
- **Boot real** da API e do worker; fumaça HTTP na API real das rotas novas; QA visual de `/users`, página do setor, `/trilha`, Novidades e `/whatsapp-equipe` (sem envio): PASS.
- **Decisões tomadas no fechamento:**
  - os registros de lote do setor (`sector_people.moved`, `.removed`, `.added`) continuam gravados, mas sem categoria, para não duplicar a linha do evento por pessoa na trilha;
  - linha sem antes/depois mostra "Sem detalhe das alterações" (vale também para registro novo de escala);
  - busca por nome/matrícula escapa `%`, `_` e `\` (o Prisma não escapa em `contains`);
  - responsável por demanda de comunicado conta como histórico na exclusão;
  - nota da origem só é guardada quando a origem é "Outro".
- **Fica para depois (Minor, sem bloqueio):** pessoa excluída não é achada pela busca da trilha (só por período ou tipo); busca da trilha limitada a 500 pessoas; período invertido não é recusado; lista de usuários sem paginação na tela (já era assim); `grantAccess` devolve 500 em conflito de serialização depois de 3 tentativas (raro).
- **Antes do deploy:** contar `AuditEvent` em produção (a migração atualiza a categoria de todos); publicar migração e código juntos (uma API antiga criando pessoa depois da migração gravaria `NAO_AUTORIZADO`).
