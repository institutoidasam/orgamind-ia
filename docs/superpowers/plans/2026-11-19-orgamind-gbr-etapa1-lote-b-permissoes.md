# OrgaMind, Etapa 1 GBR, Lote B: permissões por ação (CAD-05). Implementation Plan

> **Para os agentes:** executar pela skill `sdd` (TDD, ledger em `.superpowers/sdd/2026-11-19-orgamind-gbr-etapa1-lote-b-permissoes/progress.md`). **Sem commit/push**: nenhuma task commita; a principal integra e commita o lote. Branch `feat/cadastro-permissoes`. O Lote B parte do Lote A **completo** (plano `docs/superpowers/plans/2026-11-19-orgamind-gbr-etapa1-lote-a-ficha-trilha.md`, Tasks 1 a 19). Fechamento de task por `gate --changed --base feat/cadastro-permissoes`. Nos módulos `users/` e `sector-people/` o código mudou no Lote A: este plano cita arquivo e símbolo, nunca linha; o estado esperado deles é o dos contratos C5 a C9 do plano do Lote A.

**Goal:** as ações de escrita de pessoas, escala, estrutura e envio da equipe passam a ser decididas por permissões nomeadas por papel, guardadas no banco e editáveis pelo ADMIN numa tela de Configurações. ADMIN tem todas e VIEWER nenhuma, fixos em código. Com a matriz inicial, ninguém ganha nem perde função (teste de equivalência). Sem `telefone.ver_completo` a API devolve o telefone mascarado; sem `equipe.disparo_amplo` o envio a todos os setores ativos é recusado. As permissões efetivas vão no login e em `GET /auth/me`; menu e botões leem delas.

**Architecture:** um decorator `@RequirePermission(chave)` por rota e um `PermissionsGuard` global depois do `RolesGuard`; o guard lê a matriz do banco a cada requisição (sem cache) por uma única função de leitura (`findEffectivePermissions`). Decisões que dependem do dado (telefone, disparo amplo, inativar, histórico) usam `hasPermission(ator, chave)` com as permissões carregadas junto do ator (`findTeamActor` e o `findActor` de `sector-people`), pela mesma função de leitura. As regras puras ficam em `backend/src/shared/authz/` (chaves, padrão, telefone visível) e nas políticas existentes. A matriz tem API própria (`/permissions`, só ADMIN) com trilha `PERMISSIONS` na mesma transação. O front ganha `features/permissions/` (chaves, rótulos, `usePermission`, releitura de `/auth/me`) e o card "Permissões" em Configurações.

**Tech Stack:** NestJS + Prisma + Zod v4 (`createZodDto`, `nestjs-zod`) + BullMQ + Vitest/testcontainers no back; React + TanStack Router/Query + ky 2 + Radix + zustand + Vitest/Testing Library no front.

**Spec:** `docs/superpowers/specs/2026-11-19-orgamind-gbr-etapa1-cadastro-permissoes.md` (seções B1 a B6, aceites 10 a 16). Sentença do conselho: `~/.claude/tribunais/2026-11-19/conselho-R/sentenca-R.md` (R2 partes 1 a 3). Mapas em `.superpowers/sdd/2026-11-19-orgamind-gbr-etapa1-lote-b-permissoes/fontes/` (`mapa-permissoes.md`, `mapa-envio-login.md`, `mapa-telefone.md`).

## Ordem e paralelismo

```
Back:  T1 ─> T2 ─┬─> T3a ─┬─> T7
                 │        ├─> T8 ─> T9
                 │        └─> T4 (também depois da T3b)
                 ├─> T3b ─┬─> T6
                 │        └─> T4
                 ├─> T5
                 ├─> T10
                 ├─> T11
                 └─> T12
Front: T13 ─┬─> T14 ─> T15
            ├─> T16
            ├─> T17
            └─> T18
       T19 (por último)
```

- **Paralelos (ownership disjunto):**
  - depois da T2: T3a ∥ T3b ∥ T5 ∥ T10 ∥ T11 ∥ T12 (T3a: `TeamActor`, `findTeamActor` e specs com ator de `team-whatsapp/`, `staff-schedule/` e `audit-trail/`; T3b: `PeopleActor`, `findActor` e specs com ator de `sector-people/`, sem o spec do controller; T5: só `sector-people.controller.ts` e seu spec; T10: controllers de `shifts`, `levels`, `internal-sectors`, o serviço de setores e a política nova do gestor; T11: `modules/permissions/` controller, service e repository; T12: `auth.service.ts`, `auth.controller.ts`, `auth.schema.ts`);
  - depois da T3a: T7 ∥ T8 (T7: `staff-schedule`; T8: `team-whatsapp` controller, policy, service, repository e errors);
  - depois da T3b: T6 (service, write service, repository e contrato de `sector-people`);
  - depois da T3a e da T3b: T4 (`person-actions.policy.ts`, `audit-trail.controller.ts` e specs de `audit-trail/`), em paralelo com T6, T7 e T8;
  - o front não espera o back: os contratos CB1 a CB9 estão fixados aqui. T13 pode começar junto com a T1. Depois da T13: T14 ∥ T16 ∥ T17 ∥ T18 (pastas disjuntas, listadas em cada task).
- **Em série (mesmo arquivo ou assinatura consumida):**
  - T1 → T2: a T2 usa o modelo `RolePermission`, `PERMISSION_KEYS`, `defaultPermissionsFor` e `permissionDenied` da T1;
  - T1 → T3a, T3b: as duas usam a fixture única de ator `actorWith` (CB2), criada na T1;
  - T2 → T3a, T3b: as duas usam `findEffectivePermissions` da T2;
  - T3b → T6: as duas mexem em `sector-people.repository.ts` (`findActor` na T3b; mapeadores na T6);
  - T3a → T7, T8: consomem `TeamActor.permissions` e mexem em specs que a T3a ajusta;
  - T3a e T3b → T4: a T4 recebe atores com `permissions` dos dois módulos e mexe em `audit-trail.service.spec.ts`, que a T3a ajusta;
  - T8 → T9: as duas mexem em `team-whatsapp.service.ts`;
  - T14 → T15: a T15 usa a nova assinatura de `ui-policy.ts` (T14) em `people-table.tsx`;
  - T19 depois de todas.
- **Revisão** (SKILL.md do sdd, §Revisão por risco):
  - **Críticas, com revisor `opus`:** T1, T2, T3a, T3b, T4, T5, T6, T7, T8, T9, T10, T11, T12 (autorização: cada uma decide quem faz ou vê o quê; a T1 define a matriz inicial e as regras fixas de ADMIN e VIEWER).
  - **Médio:** T13 a T18 (o front só esconde botão; a API decide). A T19 cabe no `mecanico`.
- **Base do `--changed`:** `feat/cadastro-permissoes`.

## Decisões deste plano (registradas para o ledger)

- **DB1. Tabela `RolePermission` com `granted` por (papel, chave):** só linhas de SUPERVISOR e OPERATOR, com `CHECK` no SQL recusando ADMIN e VIEWER. Linha ausente vale o padrão da matriz inicial. Porquê: um banco sem as linhas (restauração parcial, limpeza de teste) não tira função de ninguém (anti-objetivo 1).
- **DB2. Chave como texto validado em código, não enum do Postgres:** a chave de etapa futura (`pessoas.importar`, `pessoas.exportar`, `alerta.criar`) entra só com `INSERT` na migração da etapa, sem `ALTER TYPE`; a leitura ignora chave desconhecida.
- **DB3. Mecanismo = decorator `@RequirePermission(chave)` + `PermissionsGuard` global depois do `RolesGuard`.** O `RolesGuard` deixa passar rota cuja permissão está no handler, ou na classe sem `@Roles` no handler (não aplica `@Roles` nem o default ADMIN/OPERATOR); `@Roles` no handler vale sobre permissão na classe. Nenhuma rota mistura os dois, nem no mesmo nível nem entre classe e handler (o `route-parity.spec.ts` barra). O `PermissionsGuard` lê a matriz só nas rotas marcadas. Porquê: um ponto declarativo por rota, visível no controller, que o teste de equivalência percorre por metadado; o serviço não muda de assinatura.
- **DB4. Atores carregam as permissões:** `TeamActor` e `PeopleActor` ganham `permissions`, lidas por `findEffectivePermissions` dentro de `findTeamActor` e do `findActor` de `sector-people`. Porquê: as decisões que dependem do dado (telefone, disparo amplo, inativar, histórico) já recebem o ator; ler junto do ator cumpre "lida a cada request junto com o usuário" sem trocar assinatura de serviço.
- **DB5. Leituras só da manutenção seguem `estrutura.manter`:** `GET internal/shifts`, `GET internal/levels` e `GET internal/sectors/:id` (hoje só ADMIN) passam para a chave. Nenhuma rota nova: o formulário de setor do ADMIN continua lendo os gestores possíveis em `GET /users` (só ADMIN), e para quem não é ADMIN o campo gestor não aparece (DB20). Porquê: liberar a chave sem essas leituras deixaria as telas quebradas. Com a matriz inicial é igual (só ADMIN).
- **DB6. Cancelar e repetir envio usam `equipe.enviar`,** junto com criar o envio: são ações de envio, não leituras.
- **DB7. Escala:** `canEdit` de cada linha do quadro passa a ser alcance **e** `escala.alterar`; a nota da exceção continua visível pelo alcance (`canEditPerson`), não pela chave. Porquê: sem a chave a pessoa perde a edição, não a leitura que já tinha.
- **DB8. Telefone:** a API ganha `hasPhone` e `phoneMasked` (aditivos) e `phoneE164` só sai com a chave. A regra do setor (pessoa com login, só o ADMIN vê) continua por cima: nesse caso `phoneE164` e `phoneMasked` saem nulos. A busca por telefone some só para quem não tem a chave (com a chave fica como hoje, por equivalência); na busca de contatos isso vale porque `buildContactListWhere({ search })` (`contacts.repository.ts`) casa telefone (conferido na revisão). Sem a chave, pessoa já cadastrada **sem** telefone pode receber um. O quadro da escala não devolve telefone (nenhum `phone` em `staff-schedule/`, conferido na revisão), então fica fora.
- **DB9. Disparo amplo conferido em `TeamWhatsappService.dispatch`, logo depois de `resolveTarget` e antes de `requireNumbers`:** é o caminho comum do imediato e do agendado, antes de qualquer gravação. Setores ativos da organização inteira (não só os do ator) por `listActiveSectorIds()`.
- **DB10. Corpo do 403 de permissão:** `code 'auth.permission_denied'`, `title` "Ação não permitida", `detail` com o texto da ação (CB8). Porquê: o front do setor já mostra `detail` para esse código (`features/sector-people/error-messages.ts`, `SERVER_TEXT_CODES`).
- **DB11. API da matriz:** `GET /permissions`, `PUT /permissions` (estado completo de SUPERVISOR e OPERATOR) e `POST /permissions/restore-defaults`, todas `@Roles('ADMIN')` ("Definir permissões" é regra fixa, não chave). ADMIN ou VIEWER no corpo → `422 permissions.fixed_role`.
- **DB12. Trilha da matriz:** ações `permission.matrix_updated` e `permission.matrix_restored`, `entity 'RolePermission'`, `entityId null`, categoria `PERMISSIONS`, uma `FieldChange` por célula alterada com `field '<chave>:<PAPEL>'` e booleanos; mesma transação serializável; sem mudança, sem gravação nem trilha.
- **DB13. `GET /auth/me`** para os quatro papéis, resposta `{ user, mustChangePassword }` igual ao login sem o token.
- **DB14. Quando o front relê `/auth/me`:** ao montar o layout autenticado, ao voltar o foco à janela, a cada 5 minutos, depois de qualquer resposta `403 auth.permission_denied` e depois que o ADMIN salva ou restaura a matriz. Sessão persistida sem `permissions` usa o padrão do papel até a primeira releitura. A API vale na requisição seguinte em qualquer caso (sem cache).
- **DB15. Tela Permissões = card na página Configurações,** sem rota nova (`configuracoes.tsx` é rota folha; virar layout pediria `Outlet` e mudaria a página atual).
- **DB16. `canEditContactAuthorization`:** "pode editar o telefone daquela pessoa" (sentença R1.6) é a regra de acesso (pessoa com login, só ADMIN), não a chave `telefone.ver_completo`; o resto passa a ser `pessoas.editar` no lugar de `PERSON_WRITE_ROLES`.
- **DB17. `isTeamSender`/`SENDER_ROLES` e `isValidActor`/`WRITE_ROLES` continuam** como checagem de ator válido (ativo, com acesso, papel diferente de VIEWER) nas leituras e nos serviços. Nas rotas de escrita a permissão é o portão. Como VIEWER é fixo sem nenhuma permissão, as duas checagens nunca divergem.
- **DB18. Migração `20261119100000_role_permissions`:** `CREATE TABLE` + `INSERT ... ON CONFLICT DO NOTHING` das 16 células (2 papéis × 8 chaves) da matriz inicial; nada mais.
- **DB19. Front tolera chave desconhecida:** o schema do front aceita `string[]` e descarta o que não está em `PERMISSION_KEYS`, para um back mais novo não quebrar uma aba aberta.
- **DB20. Gestor do setor só pelo ADMIN (provisória, a confirmar com a GBR):** escolher ou trocar o gestor de um setor (`managerId`) continua exclusivo do ADMIN, regra fixa em código como "Definir permissões". Quem tem `estrutura.manter` sem ser ADMIN cria e edita setores (nome, código, descrição, ativo), turnos e níveis, mas não muda o gestor. Para quem não é ADMIN, o campo `managerId` nunca entra no que o serviço grava: sai do `updateData` sempre. A comparação com o valor lido serve só para decidir a resposta: `managerId` diferente do lido → `403 sector.manager_admin_only` "Só o administrador escolhe o gestor do setor.", antes de qualquer gravação; ausente ou igual ao lido segue, sem gravar `manager` (o formulário pode reenviar o objeto inteiro). Na criação por quem não é ADMIN, `managerId` ausente ou `null` cria sem gestor e qualquer outro valor → 403. Como nada é gravado nesse campo, a leitura fora do `tx` não abre corrida com um ADMIN que troque o gestor ao mesmo tempo. A checagem fica numa função de política (`canSetSectorManager`, `assertManagerChangeAllowed` em `internal-sectors/sector-manager.policy.ts`), sem `role ===` no serviço. Porquê: a chave não pode servir para alguém se pôr como gestor e ganhar alcance sobre pessoas, telefones e envios (GB4); a spec B2 diz que função nova tem padrão restritivo; com a matriz inicial nada muda (só o ADMIN tem a chave).

## Global Constraints

- **GB1. Equivalência:** com a matriz inicial, todo papel faz e vê exatamente o que fazia antes do Lote B em toda função existente (permitido ou negado, e os dados devolvidos). Só o `code` do 403 pode mudar (de `auth.insufficient_role` ou `*_forbidden` para `auth.permission_denied`) nas rotas que passaram a ser por permissão; o status é o mesmo. Caso do `POST :userId/status`: o OPERATOR já era recusado no serviço (`person-actions.policy.ts`); com a chave `pessoas.inativar` o guard o recusa antes, só o `code` muda.
- **GB2. ADMIN e VIEWER fixos em código:** ADMIN tem todas as chaves, VIEWER nenhuma; não existem linhas deles no banco (`CHECK`), a API recusa (`422 permissions.fixed_role`) e a tela trava as duas colunas. O ADMIN não pode se trancar para fora.
- **GB3. Sem cache:** a permissão é lida do banco a cada requisição, por `findEffectivePermissions` (CB3). Nada de permissão no JWT, em memória de processo ou no Redis.
- **GB4. Escopo por setor se soma:** a permissão nunca amplia o alcance. `requireManageable`, `canManageSector`, `canSendToSector`, `canSendToUser`, `canEditPerson` (setor e escala) e `viewableSectorIds` continuam como estão. Escolher ou trocar o gestor de um setor continua só do ADMIN (DB20), e o campo nunca é gravado por quem não é ADMIN, para `estrutura.manter` não virar caminho de ampliar alcance.
- **GB5. Fora do escopo:** leituras, `/users` (contas, papel, acesso, senha), números e canais (`internal/numbers`, `whatsapp/*`), comunicação interna e os módulos legados (chat, segments, imports, metrics, contacts, campaigns, templates) continuam em `@Roles` como estão. Só as 8 chaves de CB2.
- **GB6. Decisão de permissão num lugar só:** no back, por `@RequirePermission` na rota ou por `hasPermission` dentro das funções de política (`shared/authz/person-actions.policy.ts`, `team-whatsapp.policy.ts`, `shared/authz/phone-visibility.ts`, `staff-schedule/board.ts`, `internal-sectors/sector-manager.policy.ts`). No front, por `usePermission`/`hasPermission` de `features/permissions/`, por `people-record/ui-policy.ts` e por `internal-admin/sector-policy.ts` (`canSetSectorManagerUi`). Nada de `role === 'ADMIN'` novo em service ou componente.
- **GB7. Trilha na transação (GC1 do Lote A):** alteração da matriz grava com `AuditService.recordChange(tx, …)` dentro da transação da mudança; se a trilha falhar, a matriz não muda.
- **GB8. Máscara única (GC2 do Lote A):** telefone mascarado é sempre `maskPhone` de `backend/src/shared/audit/audit-change.ts` (`'+5592988887777'` → `'•••• 7777'`); nenhuma máscara nova.
- **GB9. Erros:** `code` estável e texto pt-BR, exatamente os de CB8.
- **GB10. Testes e tamanho (GC10 do Lote A):** `describe` novos, irmãos, de até 50 linhas, no topo do arquivo; funções novas de até 50 linhas e complexidade até 10. Um teste por regra ou aceite, mais as negações de autorização.
- **GB11. Validação:** cwd `backend/` ou `frontend/`, caminhos relativos ao pacote. Loop: `timeout 600 gate --test src/<arquivo>`, um arquivo por chamada; integração com `TESTCONTAINERS_ENABLED=1 timeout 600 gate --test src/<arquivo>.integration.spec.ts`. Fechamento: `timeout 600 gate --changed --base feat/cadastro-permissoes`. Nunca suíte inteira, gate completo, coverage ou e2e (são da principal). Sem commit.
- **GB12. Textos de tela (GC12 do Lote A):** pt-BR, no tom das telas atuais, sem jargão técnico; chave e papel nunca aparecem crus (`escala.alterar`, `OPERATOR`): sempre pelo rótulo.
- **GB13. Compila entre tasks (GC13 do Lote A):** assinatura existente só ganha parâmetro ou campo opcional, salvo onde a task diz o contrário e ajusta todos os chamadores e specs na própria task.
- **GB14. Infra e dados:** nada de serviço novo no compose; migração sem perda de dados e sem `migrate reset`.
- **GB15. Lote C (GC4 do Lote A):** nenhuma gravação nova de `User.sectorId/shiftId/levelId`.

## Contratos compartilhados

**CB1. Prisma e migração (T1).**
```prisma
model RolePermission {
  role        Role
  key         String   @db.VarChar(64)
  granted     Boolean
  updatedAt   DateTime @default(now()) @updatedAt
  updatedById String?            // sem FK, como AuditEvent.actorId; nulo = migração
  @@id([role, key])
}
```
Seguir a convenção de `@@map` dos modelos vizinhos (ex.: `Shift`). Migração `backend/prisma/migrations/20261119100000_role_permissions/migration.sql`: `CREATE TABLE`, `CHECK ("role" IN ('SUPERVISOR','OPERATOR'))`, e `INSERT … VALUES … ON CONFLICT DO NOTHING` das 16 células de `DEFAULT_MATRIX` (`granted` true ou false, `updatedById` nulo).

**CB2. Regras puras (T1), `backend/src/shared/authz/permissions.ts`.**
```ts
export const PERMISSION_KEYS = [
  'pessoas.editar', 'pessoas.inativar', 'escala.alterar', 'estrutura.manter',
  'telefone.ver_completo', 'equipe.enviar', 'equipe.disparo_amplo', 'trilha.consultar',
] as const;
export type PermissionKey = (typeof PERMISSION_KEYS)[number];
export const EDITABLE_ROLES = ['SUPERVISOR', 'OPERATOR'] as const;
export type EditableRole = (typeof EDITABLE_ROLES)[number];
/** Matriz inicial (spec B2). ADMIN e VIEWER não entram: são fixos. */
export const DEFAULT_MATRIX: Readonly<Record<EditableRole, readonly PermissionKey[]>>;
// SUPERVISOR: as 8 menos 'estrutura.manter'
// OPERATOR: 'pessoas.editar','escala.alterar','telefone.ver_completo','equipe.enviar','equipe.disparo_amplo'
export function isPermissionKey(value: string): value is PermissionKey;
export function isEditableRole(role: Role): role is EditableRole;
export function defaultPermissionsFor(role: Role): PermissionKey[];        // ADMIN todas; VIEWER []; demais DEFAULT_MATRIX
export function resolvePermissions(role: Role, rows: ReadonlyArray<{ key: string; granted: boolean }>): PermissionKey[];
  // ADMIN todas e VIEWER [] sem olhar rows; demais: linha vence, ausente = padrão, chave desconhecida ignorada; ordem de PERMISSION_KEYS
export type PermissionHolder = { permissions: readonly PermissionKey[] };
export function hasPermission(holder: PermissionHolder, key: PermissionKey): boolean;
export const PERMISSION_DENIED_TEXT: Readonly<Record<PermissionKey, string>>;  // CB8
export function permissionDenied(key: PermissionKey): DomainError;
  // new DomainError({ code: 'auth.permission_denied', status: 403, message: 'Ação não permitida', detail: PERMISSION_DENIED_TEXT[key] })
```
`backend/src/shared/authz/phone-visibility.ts` (T1):
```ts
export type PhoneView = { phoneE164: string | null; hasPhone: boolean; phoneMasked: string | null };
export function phoneView(phoneE164: string | null | undefined, opts: { full: boolean; hidden?: boolean }): PhoneView;
// sem telefone → { null, false, null }
// hidden (regra do setor: pessoa com login para quem não é ADMIN) → { null, true, null }
//   (o front mostra "—" nesse caso, como hoje, sem máscara nem "Sem telefone": T15)
// full → { e164, true, maskPhone(e164) };  senão → { null, true, maskPhone(e164) }
```
`backend/src/shared/authz/actor.test-fixtures.ts` (T1), fixture única de ator para os specs de T3a, T3b e seguintes:
```ts
export type PermissionChange = { grant?: readonly PermissionKey[]; revoke?: readonly PermissionKey[] };
export function permissionsWith(role: Role, change?: PermissionChange): PermissionKey[];
  // defaultPermissionsFor(role) + grant − revoke, na ordem de PERMISSION_KEYS
export function actorWith(role: Role, change?: PermissionChange & { id?: string }):
  { id: string; role: Role; isActive: true; hasAccess: true; permissions: PermissionKey[] };
  // serve como PeopleActor; TeamActor = { ...actorWith(role), managedSectorIds: [...] }
```

**CB3. Leitura e portão (T2).**
```ts
// backend/src/modules/permissions/permissions.query.ts: ÚNICO leitor da tabela
export async function findEffectivePermissions(
  client: Pick<PrismaService, 'rolePermission'> | Prisma.TransactionClient, role: Role,
): Promise<PermissionKey[]>;   // ADMIN/VIEWER sem consulta; demais findMany({ where: { role } }) → resolvePermissions
// backend/src/modules/permissions/permissions.service.ts  (PermissionsModule @Global, exporta o serviço)
effectiveFor(role: Role): Promise<PermissionKey[]>
// backend/src/modules/auth/decorators/require-permission.decorator.ts
export const PERMISSION_KEY = 'permission';
export const RequirePermission = (key: PermissionKey) => SetMetadata(PERMISSION_KEY, key);
// backend/src/modules/auth/permissions.guard.ts
export class PermissionsGuard implements CanActivate { canActivate(ctx: ExecutionContext): Promise<boolean> }
  // @Public → true; sem metadado (getAllAndOverride handler > classe) → true;
  // com metadado → effectiveFor(req.user.role) contém a chave, senão throw permissionDenied(chave)
// roles.guard.ts, antes de @Roles e do default legado:
//   PERMISSION_KEY no handler → return true;
//   PERMISSION_KEY na classe e nenhum ROLES_KEY no handler → return true;
//   ROLES_KEY no handler com PERMISSION_KEY na classe → aplica o @Roles do handler (caso que o route-parity barra)
// app.module.ts APP_GUARD: JwtAuthGuard, RolesGuard, PermissionsGuard, UserThrottlerGuard
```

**CB4. Atores e políticas (T3a, T3b, T4, T8, T10).**
```ts
// team-whatsapp.policy.ts
export type TeamActor = { id; role; isActive; hasAccess; managedSectorIds: readonly string[]; permissions: readonly PermissionKey[] };
export function isBroadSend(targetSectorIds: readonly string[], activeSectorIds: readonly string[]): boolean;
  // true só se activeSectorIds.length > 1 e todo id ativo está em targetSectorIds (sem repetição contada)
export function canBroadSend(actor: TeamActor): boolean;   // hasPermission(actor, 'equipe.disparo_amplo')
// sector-people.policy.ts
export type PeopleActor = { id; role; isActive; hasAccess; permissions: readonly PermissionKey[] };
// shared/authz/person-actions.policy.ts
export type PolicyActor = { id: string; role: Role };                 // igual
export type PermissionActor = PolicyActor & PermissionHolder;
canChangePersonStatus(actor: PermissionActor, person: PolicyPerson, inReach: boolean): boolean
  // hasPermission(actor,'pessoas.inativar') && (ADMIN || (!person.hasAccess && inReach))
canEditContactAuthorization(actor: PermissionActor, person: PolicyPerson): boolean
  // person.hasAccess ? ADMIN : hasPermission(actor,'pessoas.editar')
canViewPersonHistory(actor: PermissionActor, inReach: boolean): boolean
  // ADMIN || (hasPermission(actor,'trilha.consultar') && inReach)
canDeletePerson(actor: PolicyActor), canQueryAuditTrail(actor: PolicyActor), personHistoryCategories(actor: PolicyActor)  // sem mudança: só ADMIN
// internal-sectors/sector-manager.policy.ts (T10, DB20)
export function canSetSectorManager(actor: PolicyActor): boolean;   // actor.role === 'ADMIN' (regra fixa, único lugar)
export function sectorManagerAdminOnly(): ForbiddenError;          // 403 sector.manager_admin_only (CB8)
export function assertManagerChangeAllowed(
  actor: PolicyActor, requested: string | null | undefined, current: string | null,
): void;  // lança sectorManagerAdminOnly() se requested !== undefined && requested !== current && !canSetSectorManager(actor); na criação current = null
// Uso no serviço (T10): assertManagerChangeAllowed(...) decide só entre seguir e 403; depois, se !canSetSectorManager(actor), o serviço tira `managerId`
// do que grava (nunca entra no updateData nem na criação de quem não é ADMIN), seja qual for o valor lido.
```

**CB5. Telefone na API (T6, T9).**
- `sectorPersonSchema` (`schemas/contracts/sector-people.schema.ts`) ganha `hasPhone: z.boolean()` e `phoneMasked: z.string().nullable()`; `phoneE164` continua `string | null`.
- Itens de `contact-candidates` (`sectorContactCandidates…` no mesmo arquivo): `phoneE164` passa a `z.string().nullable()` e ganha `phoneMasked: z.string()`.
- `teamRosterMemberSchema` (`schemas/contracts/team-whatsapp.schema.ts`) ganha `hasPhone: z.boolean()` e `phoneMasked: z.string().nullable()`.
- Os três montam os campos por `phoneView` (CB2) com `full = hasPermission(ator, 'telefone.ver_completo')`; na lista do setor, `hidden = !isSectorAdmin(ator) && pessoa.hasAccess` (regra atual).

**CB6. Envio amplo (T8).** `backend/src/modules/team-whatsapp/team-whatsapp.errors.ts`: `export function broadSendDenied(): ForbiddenError` (CB8). `TeamWhatsappRepository.listActiveSectorIds(): Promise<string[]>` (`sector.findMany({ where: { isActive: true }, select: { id: true } })`).

**CB7. API (T10, T11, T12).** `backend/src/schemas/contracts/permissions.schema.ts` (T1 cria o arquivo inteiro):
```ts
export const permissionKeySchema = z.enum(PERMISSION_KEYS);
const keyList = permissionKeySchema.array();
export const permissionMatrixSchema = z.object({
  keys: keyList,                                                        // ordem de PERMISSION_KEYS
  roles: z.object({ ADMIN: keyList, SUPERVISOR: keyList, OPERATOR: keyList, VIEWER: keyList }),
  defaults: z.object({ SUPERVISOR: keyList, OPERATOR: keyList }),
  editableRoles: z.enum(['SUPERVISOR', 'OPERATOR']).array(),
});
export const savePermissionMatrixSchema = z.object({
  roles: z.object({ SUPERVISOR: keyList, OPERATOR: keyList, ADMIN: keyList.optional(), VIEWER: keyList.optional() }).strict(),
}).strict();                                                            // chave fora das 8 → 400; ADMIN/VIEWER presentes → 422 no serviço
export type PermissionMatrix = z.infer<typeof permissionMatrixSchema>;
export type SavePermissionMatrix = z.infer<typeof savePermissionMatrixSchema>;
```
Rotas: `GET /permissions` → `PermissionMatrix`; `PUT /permissions` (corpo `SavePermissionMatrix`) → `PermissionMatrix`; `POST /permissions/restore-defaults` → `PermissionMatrix`. Todas `@Roles('ADMIN')`.
Auth (`backend/src/schemas/contracts/auth.schema.ts`): o objeto `user` de `loginResponseSchema` vira `currentAuthUserSchema` exportado e ganha `permissions: permissionKeySchema.array()`; novo `meResponseSchema = z.object({ user: currentAuthUserSchema, mustChangePassword: z.boolean() })`. `CurrentAuthUser` (`auth.service.ts`) ganha `permissions: PermissionKey[]`. `GET /auth/me` com `@Roles('ADMIN','OPERATOR','SUPERVISOR','VIEWER')`.
Setores: nenhuma rota nova e nenhum campo novo. `POST internal/sectors` e `PATCH internal/sectors/:id` mantêm o corpo atual (`managerId` opcional); quem não é ADMIN e manda `managerId` diferente do lido (na criação, qualquer valor não nulo) recebe `403 sector.manager_admin_only`, e `managerId` igual ao lido ou ausente segue sem ser gravado (DB20). A resposta de `GET internal/sectors/:id` já traz `managerId` e `manager { id, name, email }` (front `features/internal-admin/schemas.ts`), que a T16 usa para mostrar o gestor como texto.

**CB8. Erros e textos (GB9).**

| status | code | title | detail |
|---|---|---|---|
| 403 | `auth.permission_denied` | Ação não permitida | texto da chave, abaixo |
| 403 | `team_whatsapp.broad_send_denied` | Você não tem permissão para enviar a todos os setores de uma vez. Desmarque um setor ou peça ao administrador. | (sem) |
| 403 | `sector.manager_admin_only` | Só o administrador escolhe o gestor do setor. | (sem) |
| 422 | `permissions.fixed_role` | Administrador e Visualizador têm permissões fixas e não podem ser alterados. | (sem) |

`PERMISSION_DENIED_TEXT`:
- `pessoas.editar`: "Você não tem permissão para cadastrar ou editar pessoas."
- `pessoas.inativar`: "Você não tem permissão para inativar ou reativar pessoas."
- `escala.alterar`: "Você não tem permissão para alterar a escala."
- `estrutura.manter`: "Você não tem permissão para manter setores, turnos e níveis."
- `telefone.ver_completo`: "Você não tem permissão para ver ou alterar o telefone completo."
- `equipe.enviar`: "Você não tem permissão para enviar WhatsApp à equipe."
- `equipe.disparo_amplo`: "Você não tem permissão para enviar a todos os setores de uma vez."
- `trilha.consultar`: "Você não tem permissão para consultar o histórico de alterações."

**CB9. Front (T13), `frontend/src/features/permissions/`.**
```ts
// keys.ts
export const PERMISSION_KEYS: readonly [...];                  // espelho de CB2, mesma ordem
export type PermissionKey;
export const DEFAULT_PERMISSIONS: Record<UserRole, readonly PermissionKey[]>;   // ADMIN todas; VIEWER []; demais DEFAULT_MATRIX
export const PERMISSION_LABELS: Record<PermissionKey, { name: string; description: string }>;
export function toPermissionKeys(raw: readonly string[]): PermissionKey[];     // descarta desconhecida (DB19)
// access.ts
export function effectivePermissions(user: Pick<AuthUser, 'role' | 'permissions'> | null): readonly PermissionKey[];
  // null → []; permissions ausente (sessão antiga) → DEFAULT_PERMISSIONS[role]
export function hasPermission(user: Pick<AuthUser, 'role' | 'permissions'> | null, key: PermissionKey): boolean;
// use-permission.ts
export function usePermission(key: PermissionKey): boolean;
export function usePermissions(): readonly PermissionKey[];
// use-session-sync.ts
export const ME_QUERY_KEY = ['auth', 'me'] as const;
export function useSessionSync(): void;   // DB14; grava com useAuthStore.getState().setUser(user)
```
`AuthUser` (`stores/auth.store.ts`) ganha `permissions?: PermissionKey[]` (opcional: sessão persistida antiga) e a store ganha `setUser(user: AuthUser): void` (troca só o `user`; persiste como hoje). `features/auth/schemas.ts`: `user.permissions` = `z.array(z.string()).optional().transform((v) => v && toPermissionKeys(v))`; novo `meResponseSchema`. `features/auth/api.ts`: `fetchMe(): Promise<{ user: AuthUser; mustChangePassword: boolean }>`. `lib/api-client.ts`: `onPermissionDenied(cb: () => void): () => void` disparado em resposta 403 com `code 'auth.permission_denied'` (ler o código de `response.clone()`, para não consumir o corpo que `readApiErrorBody` lê depois).
Rótulos (`PERMISSION_LABELS`):

| chave | name | description |
|---|---|---|
| `pessoas.editar` | Cadastrar e editar pessoas | Cadastrar, editar, mover e tirar pessoas nos setores que gerencia. |
| `pessoas.inativar` | Inativar e reativar pessoas | Só pessoas sem acesso ao sistema, nos setores que gerencia. Quem tem acesso, só o administrador. |
| `escala.alterar` | Alterar a escala | Mudar a escala e as exceções nos setores que gerencia. |
| `estrutura.manter` | Manter setores, turnos e níveis | Criar e editar setores, turnos e níveis. |
| `telefone.ver_completo` | Ver o telefone completo | Sem esta permissão, aparecem só os 4 últimos dígitos. |
| `equipe.enviar` | Enviar WhatsApp à equipe | Enviar, agendar, cancelar e repetir envios nos setores que gerencia. |
| `equipe.disparo_amplo` | Enviar a todos os setores de uma vez | Envio que cobre todos os setores ativos da empresa. |
| `trilha.consultar` | Consultar o histórico das pessoas | Ver o histórico de alterações das pessoas dos setores que gerencia. A trilha completa é só do administrador. |

## Rotas: o que troca e o que fica

| Controller | Rota | Antes | Depois |
|---|---|---|---|
| `SectorPeopleController` (`internal/sectors/:sectorId/people`) | `GET ''`, `GET candidates`, `GET contact-candidates` | `@Roles` A,S,O na classe | `@Roles('ADMIN','SUPERVISOR','OPERATOR')` em cada handler |
| idem | `POST ''`, `POST from-contacts`, `POST move`, `PATCH :userId`, `DELETE :userId` | A,S,O | `@RequirePermission('pessoas.editar')` |
| idem | `POST :userId/status` (Lote A) | A,S,O no guard (o serviço já recusa o OPERATOR) | `@RequirePermission('pessoas.inativar')`: no guard, A,S; o resultado final é o mesmo e só o `code` do 403 muda. O `route-parity.spec.ts` aceita A,S,O enquanto a rota tem `@Roles` e exige A,S com a chave |
| `StaffScheduleController` (`internal/staff-schedule`) | `GET options`, `GET board` | A,S,O na classe | `@Roles` A,S,O em cada handler |
| idem | `PUT users/:userId/schedule`, `DELETE users/:userId/schedule`, `POST users/:userId/exceptions`, `DELETE exceptions/:exceptionId` | A,S,O | `@RequirePermission('escala.alterar')` |
| `TeamWhatsappController` (`internal/team-whatsapp`) | `GET targets`, `roster`, `person-route`, `dispatches`, `dispatches/:id`, `dispatches/:id/recipients`, `scheduled` | A,S,O | igual |
| idem | `POST dispatches`, `POST dispatches/:id/cancel`, `POST dispatches/:id/retry` | A,S,O | `@RequirePermission('equipe.enviar')` |
| `ShiftsController`, `LevelsController` | todas (`GET`, `POST`, `PUT order`, `PATCH :id`) | `@Roles('ADMIN')` na classe | `@RequirePermission('estrutura.manter')` na classe (DB5) |
| `InternalSectorsController` (`internal/sectors`) | `GET ''`, `GET :id/members` | A4 | igual |
| idem | `POST ''`, `GET :id`, `PATCH :id` | A | `@RequirePermission('estrutura.manter')`; mudar `managerId` continua só ADMIN, no serviço (DB20) |
| `AuditTrailController` | `GET ''` | A | igual (consulta geral só ADMIN) |
| idem | `GET people/:userId` | A,S | `@RequirePermission('trilha.consultar')` |
| `AuthController` | `GET me` (nova) | | A4 |
| `PermissionsController` (novo) | `GET`, `PUT`, `POST restore-defaults` | | `@Roles('ADMIN')` |
| `/users`, `internal/numbers`, `whatsapp/*`, `internal/communications`, legados | todas | | igual (GB5) |

Sem rota: `telefone.ver_completo` (T6, T9) e `equipe.disparo_amplo` (T8) decidem dentro do serviço.

## Review Focus

- Equivalência (aceite 10): a tabela da T2 cobre toda rota dos sete controllers; `findEffectivePermissions` no banco migrado devolve `defaultPermissionsFor` para os quatro papéis (T1/T2); os testes de serviço de T4, T6, T7, T8 e T9 provam "com a matriz inicial, igual a hoje".
- Nenhuma rota fora da tabela "Rotas" perdeu `@Roles` (GB5); nenhuma rota tem `@Roles` e `@RequirePermission` juntos, nem no mesmo nível nem entre classe e handler.
- `RolesGuard` só se cala quando há `@RequirePermission` no handler, ou na classe sem `@Roles` no handler; o default ADMIN/OPERATOR continua para rota sem nada.
- Gestor do setor (DB20): quem não é ADMIN, mesmo com `estrutura.manter`, não muda `managerId`; o campo nunca entra no `updateData` de quem não é ADMIN, a recusa (valor diferente do lido) vem antes de qualquer gravação e a regra mora só em `sector-manager.policy.ts`.
- Sem cache (GB3): nenhum `Map`, memo ou campo de classe guardando permissão; o JWT não muda.
- ADMIN e VIEWER fixos (GB2): `resolvePermissions` não consulta linha para eles; `CHECK` no SQL; `422 permissions.fixed_role`.
- Telefone: `phoneE164` nunca sai sem a chave nas três listas; a regra do setor continua por cima; "Sem telefone" usa `hasPhone`; busca sem a chave não casa telefone.
- Disparo amplo: conferido antes de qualquer gravação, no imediato e no agendado; inativos não contam; um setor ativo nunca é amplo; alvo pessoa nunca é amplo.
- Trilha da matriz na mesma transação, só células alteradas, categoria `PERMISSIONS`, invisível para quem não é ADMIN.
- Front: sessão persistida sem `permissions` cai no padrão do papel, nunca em "nenhuma".

---

## Task 1 — Schema, migração, chaves e telefone visível (back)

**Arquivos:**
- Modificar: `backend/prisma/schema.prisma` (modelo `RolePermission`, CB1).
- Criar: `backend/prisma/migrations/20261119100000_role_permissions/migration.sql`; `backend/src/shared/authz/permissions.ts` e `permissions.spec.ts`; `backend/src/shared/authz/phone-visibility.ts` e `phone-visibility.spec.ts`; `backend/src/shared/authz/actor.test-fixtures.ts` (fixture única de ator, CB2); `backend/src/schemas/contracts/permissions.schema.ts` e `permissions.schema.spec.ts`; `backend/src/modules/permissions/role-permissions-migration.integration.spec.ts`.

**Interfaces:**
- Consome: `Role` (`@prisma/client`); `DomainError` (`backend/src/shared/errors/domain.error.ts`); `maskPhone` (`backend/src/shared/audit/audit-change.ts`).
- Produz: CB1, CB2 (inclusive a fixture `actorWith`/`permissionsWith`), CB7 (só o arquivo de contrato), CB8 (`PERMISSION_DENIED_TEXT`, `permissionDenied`).

**Contexto vinculado:**
- Spec B1: permissões por papel no banco; ADMIN tem todas, fixo; VIEWER nenhuma, fixo; a tela edita só SUPERVISOR e OPERATOR; sem exceção por pessoa; uma chave só entra na etapa em que a função existe.
- Spec B2 (matriz inicial): `pessoas.editar` A,S,O; `pessoas.inativar` A,S; `escala.alterar` A,S,O; `estrutura.manter` A; `telefone.ver_completo` A,S,O; `equipe.enviar` A,S,O; `equipe.disparo_amplo` A,S,O; `trilha.consultar` A,S. VIEWER nenhuma.
- DB1: linha por (papel, chave) com `granted`; só SUPERVISOR e OPERATOR (`CHECK`); linha ausente = padrão.
- DB2: chave é texto validado em código; leitura ignora chave desconhecida.
- DB18: migração `20261119100000_role_permissions` com `CREATE TABLE` e `INSERT … ON CONFLICT DO NOTHING` das 16 células.
- DB8/CB2: `phoneView` com `hidden` (regra do setor) por cima de `full`.
- GB8: máscara só por `maskPhone`.
- GB14: sem perda de dados, sem `migrate reset`, nada no compose.
- CB8: textos exatos de `PERMISSION_DENIED_TEXT` e o corpo do 403 (`title` "Ação não permitida", `detail` com o texto).

**Passos:**
1. [ ] RED `permissions.spec.ts`:
   - `it('defaultPermissionsFor: ADMIN todas, VIEWER nenhuma, SUPERVISOR sem estrutura.manter, OPERATOR as 5 de B2')`;
   - `it('resolvePermissions: linha vence o padrão; ausente cai no padrão; chave desconhecida ignorada; ADMIN e VIEWER ignoram linhas')`;
   - `it('permissionDenied devolve 403 auth.permission_denied com title "Ação não permitida" e detail da chave')`;
   - `it('PERMISSION_DENIED_TEXT tem texto para cada uma das 8 chaves')`.
2. [ ] RED `phone-visibility.spec.ts`: os quatro casos de CB2 (`'+5592988887777'` → `'•••• 7777'`). Em `permissions.spec.ts`, `it('permissionsWith: padrão do papel mais grant menos revoke, na ordem de PERMISSION_KEYS')` (a fixture `actorWith` é usada pelos specs de T3a em diante).
3. [ ] RED `permissions.schema.spec.ts`: `savePermissionMatrixSchema` recusa chave `'pessoas.exportar'` (400) e campo extra; aceita ADMIN opcional (o 422 é do serviço, T11).
4. [ ] RED `role-permissions-migration.integration.spec.ts` (banco migrado pelo testcontainers):
   - `it('semeia 16 linhas iguais a DEFAULT_MATRIX')`;
   - `it('CHECK recusa linha de ADMIN e de VIEWER')`;
   - `it('reaplicar o INSERT da migração não duplica nem altera linha editada')` (`granted` mudado à mão continua).
5. [ ] GREEN: modelo, SQL, funções e contrato pelas assinaturas. `npx prisma validate` e `npx prisma generate`.
6. [ ] Validação: `timeout 600 gate --test src/shared/authz/permissions.spec.ts`; `… src/shared/authz/phone-visibility.spec.ts`; `… src/schemas/contracts/permissions.schema.spec.ts`; `TESTCONTAINERS_ENABLED=1 timeout 600 gate --test src/modules/permissions/role-permissions-migration.integration.spec.ts`; `npm run build`; `timeout 600 gate --changed --base feat/cadastro-permissoes`.

**Aceite:** spec aceites 10 (parte: o banco nasce com a matriz inicial) e 12 (parte: o banco não aceita linha de ADMIN/VIEWER).

**Risco: crítico (autorização)**
**Crítico:** autorização — define a matriz inicial (`DEFAULT_MATRIX`), `resolvePermissions` (ADMIN e VIEWER fixos, linha ausente vale o padrão), `phoneView` e o contrato público da matriz, de que todo o aceite 10 depende; a migração só cria tabela nova e semeia, sem apagar dado.

## Task 2 — Leitura da permissão, guard e tabela de equivalência das rotas (back)

**Arquivos:**
- Criar: `backend/src/modules/permissions/permissions.module.ts` (`@Global`), `permissions.service.ts`, `permissions.query.ts`, `permissions.query.integration.spec.ts`, `route-parity.spec.ts`; `backend/src/modules/auth/decorators/require-permission.decorator.ts`; `backend/src/modules/auth/permissions.guard.ts` e `permissions.guard.spec.ts`.
- Modificar: `backend/src/modules/auth/roles.guard.ts` (`RolesGuard.canActivate`) e seu spec (`describe` novo no topo); `backend/src/app.module.ts` (`imports` ganha `PermissionsModule`; `APP_GUARD` ganha `PermissionsGuard` entre `RolesGuard` e `UserThrottlerGuard`).

**Interfaces:**
- Consome: CB1, CB2 (`resolvePermissions`, `permissionDenied`), `IS_PUBLIC_KEY` (`auth/decorators/public.decorator.ts`), `ROLES_KEY` (`auth/decorators/roles.decorator.ts`), `PrismaService`.
- Produz: CB3.

**Contexto vinculado:**
- Spec B1: nas rotas cobertas a checagem de papel é trocada pela permissão; o escopo por setor continua e se soma; sem cache, a permissão é lida do banco a cada requisição; recusa `403 auth.permission_denied` com texto pt-BR dizendo a ação.
- DB3: `@RequirePermission` + `PermissionsGuard` global depois do `RolesGuard`. Precedência no `RolesGuard`: permissão no handler cala o `@Roles`; permissão na classe cala só se o handler não tiver `@Roles`; `@Roles` no handler vale sobre permissão na classe. Sem `@Roles` e sem permissão, o default ADMIN/OPERATOR de hoje continua. Nenhuma rota mistura `@Roles` e `@RequirePermission`, nem no mesmo nível nem entre classe e handler.
- GB1 (equivalência): com a matriz inicial, permitido/negado igual a antes para cada papel e rota; só o `code` do 403 pode mudar nas rotas trocadas.
- GB3: leitura só por `findEffectivePermissions`; sem cache nem JWT.
- Tabela "Rotas" deste plano: o "Antes" de cada rota dos sete controllers (`SectorPeopleController`, `StaffScheduleController`, `TeamWhatsappController`, `ShiftsController`, `LevelsController`, `InternalSectorsController`, `AuditTrailController`) é o esperado da equivalência. A4 = ADMIN, SUPERVISOR, OPERATOR, VIEWER; A,S,O = sem VIEWER; A = só ADMIN; A,S = ADMIN e SUPERVISOR.
- Rota nova não entra na tabela de equivalência (não é função que já existia). Os sete controllers não ganham rota nova neste lote (`GET auth/me` fica em `AuthController`, fora da tabela), então a lista de rotas novas do spec começa vazia; o mecanismo fica para lotes futuros.

**Passos:**
1. [ ] RED `permissions.guard.spec.ts` (Reflector real, contexto falso, `PermissionsService` falso):
   - `it('sem metadado passa sem consultar a matriz')`;
   - `it('@Public passa')`;
   - `it('com a chave passa; sem a chave lança 403 auth.permission_denied com o detail da chave')`;
   - `it('metadado do handler vence o da classe')`.
2. [ ] RED no spec do `RolesGuard`:
   - `it('@RequirePermission no handler passa mesmo com @Roles na classe')`;
   - `it('@RequirePermission na classe e handler sem @Roles passa para SUPERVISOR')`;
   - `it('@RequirePermission na classe e @Roles(ADMIN) no handler: o @Roles do handler vale e SUPERVISOR recebe 403')`;
   - `it('rota sem nada continua só ADMIN e OPERATOR')`.
3. [ ] RED `permissions.query.integration.spec.ts`:
   - `it('banco migrado: os 4 papéis devolvem defaultPermissionsFor')`;
   - `it('linha OPERATOR escala.alterar granted false tira a chave na leitura seguinte; true devolve')` (prova "sem cache").
4. [ ] RED `route-parity.spec.ts` (aceite 10): percorre os métodos dos sete controllers pelos metadados do Nest (`PATH_METADATA`, `METHOD_METADATA` de `@nestjs/common/constants`), monta `"VERBO /caminho"`, e para cada papel roda `RolesGuard` e depois `PermissionsGuard` com `effectiveFor = defaultPermissionsFor`; permitido = os dois passam. Compara com a tabela literal do "Antes" (uma linha por rota, com o conjunto de papéis). Única exceção, `POST :userId/status`: a expectativa depende do metadado presente na rota. Com `@Roles` (estado de hoje) aceita {ADMIN, SUPERVISOR, OPERATOR}, porque o guard deixa o OPERATOR passar e quem o recusa é o serviço (`person-actions.policy.ts`); com `@RequirePermission('pessoas.inativar')` (depois da T5) exige {ADMIN, SUPERVISOR}. O spec lê o metadado da rota para escolher a expectativa, então a T5 não edita este arquivo. Falha se uma rota dos controllers não está na tabela (exceto a lista de novas, hoje vazia) e se uma rota mistura `@Roles` e `@RequirePermission`, no mesmo nível ou entre classe e handler (permissão na classe com `@Roles` no handler, ou `@Roles` na classe com permissão no handler). Este spec passa já agora, com os `@Roles` atuais, e precisa continuar verde depois de T4, T5, T7, T8 e T10.
5. [ ] GREEN pelas assinaturas; registrar módulo e guard.
6. [ ] Validação: `timeout 600 gate --test src/modules/auth/permissions.guard.spec.ts`; `… src/modules/auth/roles.guard.spec.ts`; `… src/modules/permissions/route-parity.spec.ts`; `TESTCONTAINERS_ENABLED=1 timeout 600 gate --test src/modules/permissions/permissions.query.integration.spec.ts`; `npm run build`; `timeout 600 gate --changed --base feat/cadastro-permissoes`.

**Aceite:** spec aceite 10 (rotas) e 11 (parte: leitura sem cache).

**Risco: crítico (autorização)**
**Crítico:** autorização — cria o portão de permissão por rota e muda o `RolesGuard` global, que decide o acesso de todas as rotas.

## Task 3a — Ator da equipe com permissões: team-whatsapp, escala e trilha (back)

**Arquivos:**
- Modificar: `backend/src/modules/team-whatsapp/team-whatsapp.policy.ts` (tipo `TeamActor`); `backend/src/modules/team-whatsapp/team-actor.query.ts` (`findTeamActor`); `backend/src/modules/team-whatsapp/team-whatsapp.test-fixtures.ts` (passa a montar o ator por `actorWith`); os specs que montam `TeamActor` literal (Grep de 19/11 por `managedSectorIds:`): em `team-whatsapp/` (`team-whatsapp.policy.spec.ts`, `team-whatsapp.service.spec.ts`, `.service.list.spec.ts`, `.service.roster.spec.ts`, `.service.schedule.spec.ts`, `.service.sectors.spec.ts`, `team-whatsapp-results.service.spec.ts`, `team-whatsapp-retry.service.spec.ts`), em `staff-schedule/` (`staff-schedule.policy.spec.ts`, `staff-schedule.service.spec.ts`, `staff-schedule-edit.service.spec.ts`) e em `audit-trail/` (`audit-trail.service.spec.ts`). Refazer o Grep no início: todo spec desses três módulos que não compila pelo campo novo entra.
- Modificar (integração, `describe` novo no topo): `team-whatsapp.repository.integration.spec.ts`.

**Interfaces:**
- Consome: CB2 (`defaultPermissionsFor`, `PermissionKey`, fixture `actorWith`), CB3 (`findEffectivePermissions`).
- Produz: CB4 (só o tipo `TeamActor` com `permissions`).

**Contexto vinculado:**
- DB4: `TeamActor` ganha `permissions`, lidas por `findEffectivePermissions` dentro de `findTeamActor`, com o papel lido do banco na mesma chamada.
- GB3: sem cache; a cada chamada lê de novo.
- GB13: o campo é obrigatório (nenhum caminho monta ator sem permissões sem o compilador apontar); todos os specs e fixtures dos três módulos ajustados nesta task.
- Fixture única (CB2): todo ator de spec sai de `actorWith(role, { grant?, revoke? })` (`shared/authz/actor.test-fixtures.ts`, T1), com `managedSectorIds` por espalhamento (`{ ...actorWith('OPERATOR'), managedSectorIds: ['s1'] }`). Nada de lista de permissões literal repetida nos specs: troca mecânica, um padrão só.
- GB1: nenhum comportamento muda nesta task; só o formato do ator.
- `findTeamActor` é usado por `team-whatsapp`, `staff-schedule` e `audit-trail` (todos pelos seus `repo.findActor`).

**Passos:**
1. [ ] RED `team-whatsapp.repository.integration.spec.ts` (`describe('ator com permissões')`): `findTeamActor` de um OPERATOR traz `defaultPermissionsFor('OPERATOR')`; com a linha `equipe.disparo_amplo` em `false`, a chave some.
2. [ ] GREEN: tipo e consulta; ajustar a fixture do módulo e os specs por `actorWith`.
3. [ ] Validação: `timeout 600 gate --test` em cada spec tocado (um por chamada); `TESTCONTAINERS_ENABLED=1 timeout 600 gate --test src/modules/team-whatsapp/team-whatsapp.repository.integration.spec.ts`; `npm run build`; `timeout 600 gate --changed --base feat/cadastro-permissoes`.

**Aceite:** o ator da equipe traz as permissões efetivas lidas do banco; nenhum teste de comportamento muda de expectativa.

**Risco: crítico (autorização)**
**Crítico:** autorização — passa a carregar, junto do ator da equipe, as permissões que decidem telefone do roster, disparo amplo, escala e histórico.

## Task 3b — Ator das pessoas do setor com permissões (back)

**Arquivos:**
- Modificar: `backend/src/modules/sector-people/sector-people.policy.ts` (tipo `PeopleActor`); `backend/src/modules/sector-people/sector-people.repository.ts` (`findActor`); os specs de `sector-people/` que montam `PeopleActor` literal (Grep de 19/11: `sector-people.policy.spec.ts`, `sector-people.service.spec.ts`, `sector-people-write.service.spec.ts`). Refazer o Grep no início: todo spec de `sector-people/` que não compila pelo campo novo entra, exceto `sector-people.controller.spec.ts` (é da T5; se ele montar ator, avisar a principal em vez de editar).
- Modificar (integração, `describe` novo no topo): `sector-people.repository.integration.spec.ts`.

**Interfaces:**
- Consome: CB2 (`defaultPermissionsFor`, `PermissionKey`, fixture `actorWith`), CB3 (`findEffectivePermissions`).
- Produz: CB4 (só o tipo `PeopleActor` com `permissions`).

**Contexto vinculado:**
- DB4: `PeopleActor` ganha `permissions`, lidas por `findEffectivePermissions` dentro do `findActor` de `sector-people`, com o papel lido do banco na mesma chamada.
- GB3: sem cache; a cada chamada lê de novo.
- GB13: o campo é obrigatório; todos os specs de `sector-people/` ajustados nesta task.
- Fixture única (CB2): todo ator de spec sai de `actorWith(role, { grant?, revoke? })` (`shared/authz/actor.test-fixtures.ts`, T1); nada de lista de permissões literal repetida.
- GB1: nenhum comportamento muda nesta task; só o formato do ator.
- `findActor` de `sector-people` alimenta `requireManageable`.

**Passos:**
1. [ ] RED `sector-people.repository.integration.spec.ts` (`describe('ator com permissões')`): `findActor` de um SUPERVISOR traz as 7 chaves dele; ADMIN traz as 8 sem consultar linha.
2. [ ] GREEN: tipo e consulta; ajustar specs por `actorWith`.
3. [ ] Validação: `timeout 600 gate --test` em cada spec tocado (um por chamada); `TESTCONTAINERS_ENABLED=1 timeout 600 gate --test src/modules/sector-people/sector-people.repository.integration.spec.ts`; `npm run build`; `timeout 600 gate --changed --base feat/cadastro-permissoes`.

**Aceite:** o ator das pessoas do setor traz as permissões efetivas lidas do banco; nenhum teste de comportamento muda de expectativa.

**Risco: crítico (autorização)**
**Crítico:** autorização — passa a carregar, junto do ator do setor, as permissões que decidem telefone, inativação e edição de pessoas.

## Task 4 — Políticas de pessoa e trilha por permissão (back)

**Arquivos:**
- Modificar: `backend/src/shared/authz/person-actions.policy.ts` (`PermissionActor` novo; corpos de `canChangePersonStatus`, `canEditContactAuthorization`, `canViewPersonHistory`; sai `PERSON_WRITE_ROLES`) e seu spec; `backend/src/modules/audit-trail/audit-trail.controller.ts` (`personHistory`) e `audit-trail.controller.spec.ts`; `audit-trail.service.spec.ts` (`describe` novo no topo).

**Interfaces:**
- Consome: CB2 (`hasPermission`), CB3 (`RequirePermission`), CB4 (atores com `permissions`: `TeamActor` da T3a e `PeopleActor` da T3b), fixture `actorWith` (CB2).
- Produz: CB4 (assinaturas e corpos de `person-actions.policy.ts`).

**Contexto vinculado:**
- Spec B2 `pessoas.inativar`: vale só para pessoa sem login dos setores que o ator alcança; pessoa com login, só o ADMIN; motivo obrigatório (já no Lote A).
- Sentença R2 `trilha.consultar`: quem não é ADMIN consulta a trilha pela ficha de pessoa que alcança (pessoa, vínculo, escala); a consulta geral e as mudanças de estrutura e de permissões ficam só para o ADMIN.
- DB16: `canEditContactAuthorization` = pessoa com login, só ADMIN; sem login, `pessoas.editar` (no lugar de `PERSON_WRITE_ROLES`).
- CB4: corpos exatos das três funções; `canDeletePerson`, `canQueryAuditTrail` e `personHistoryCategories` não mudam (regras fixas do ADMIN).
- Rotas: `GET audit-trail/people/:userId` troca `@Roles('ADMIN','SUPERVISOR')` por `@RequirePermission('trilha.consultar')`; `GET audit-trail` continua `@Roles('ADMIN')`.
- GB4: o alcance (`inReach`, `viewableSectorIds`) continua igual e se soma.
- GB1: com a matriz inicial cada função devolve o mesmo que no Lote A para os quatro papéis.

**Passos:**
1. [ ] RED no spec da política (`describe('por permissão')`):
   - `it('matriz inicial: resultado igual ao do Lote A para os 4 papéis')` (tabela papel × pessoa com/sem login × alcance);
   - `it('OPERATOR com pessoas.inativar inativa pessoa sem login no alcance; nunca pessoa com login')`;
   - `it('SUPERVISOR sem pessoas.inativar não inativa')`;
   - `it('OPERATOR com trilha.consultar vê histórico no alcance; SUPERVISOR sem a chave não vê')`;
   - `it('canEditContactAuthorization: sem pessoas.editar recusa pessoa sem login; pessoa com login só ADMIN')`.
2. [ ] RED `audit-trail.controller.spec.ts`: `personHistory` com metadado `trilha.consultar` e sem `@Roles`; `list` continua `@Roles('ADMIN')`.
3. [ ] RED `audit-trail.service.spec.ts`: OPERATOR com `trilha.consultar` no alcance recebe só `PERSON`, `ASSIGNMENT`, `SCHEDULE`.
4. [ ] GREEN.
5. [ ] Validação: `timeout 600 gate --test src/shared/authz/person-actions.policy.spec.ts`; `… src/modules/audit-trail/audit-trail.controller.spec.ts`; `… src/modules/audit-trail/audit-trail.service.spec.ts`; `… src/modules/permissions/route-parity.spec.ts`; `timeout 600 gate --changed --base feat/cadastro-permissoes`.

**Aceite:** spec aceites 10 (inativar e histórico) e 16 (parte: `PERMISSIONS` continua fora do histórico de quem não é ADMIN).

**Risco: crítico (autorização)**
**Crítico:** autorização — troca o critério de papel por permissão em quem inativa, quem altera autorização de contato e quem vê o histórico da pessoa.

## Task 5 — Pessoas do setor: rotas por permissão (back)

**Arquivos:**
- Modificar: `backend/src/modules/sector-people/sector-people.controller.ts` (sai o `@Roles` da classe; handlers conforme a tabela "Rotas") e `sector-people.controller.spec.ts` (`describe` novo no topo).

**Interfaces:**
- Consome: CB3 (`RequirePermission`), `Roles`.
- Produz: rotas de `SectorPeopleController` da tabela "Rotas".

**Contexto vinculado:**
- Tabela "Rotas": `GET ''`, `GET candidates`, `GET contact-candidates` com `@Roles('ADMIN','SUPERVISOR','OPERATOR')` por handler; `POST ''`, `POST from-contacts`, `POST move`, `PATCH :userId`, `DELETE :userId` com `@RequirePermission('pessoas.editar')`; `POST :userId/status` com `@RequirePermission('pessoas.inativar')`.
- Spec B1: leituras seguem em `@Roles`; o escopo por setor continua (`requireManageable` no serviço não muda) e se soma.
- GB1: com a matriz inicial, VIEWER continua 403 em tudo; ADMIN, SUPERVISOR e OPERATOR continuam passando onde passavam; no `status`, OPERATOR recebe 403 já no guard (`auth.permission_denied`) em vez de `sector_people.status_forbidden` (mesmo status; o serviço já o recusava). O `route-parity.spec.ts` da T2 escolhe a expectativa do `status` pelo metadado da rota (A,S,O com `@Roles`; A,S com `pessoas.inativar`), então esta task não edita esse arquivo.
- GB6: decisão de rota só pelo decorator; nada de checagem de papel nova no controller.

**Passos:**
1. [ ] RED `sector-people.controller.spec.ts`: metadados por handler (chave certa em cada escrita; `@Roles` A,S,O nas três leituras; nenhum `@Roles` de classe).
2. [ ] GREEN.
3. [ ] Validação: `timeout 600 gate --test src/modules/sector-people/sector-people.controller.spec.ts`; `… src/modules/permissions/route-parity.spec.ts`; `timeout 600 gate --changed --base feat/cadastro-permissoes`.

**Aceite:** spec aceite 10 (rotas do setor) e `route-parity.spec.ts` verde.

**Risco: crítico (autorização)**
**Crítico:** autorização — troca o portão de papel pelo de permissão nas escritas de pessoas do setor e na inativação.

## Task 6 — Telefone completo na página do setor (back)

**Arquivos:**
- Modificar: `backend/src/schemas/contracts/sector-people.schema.ts` (`sectorPersonSchema`; itens de `contact-candidates`); `backend/src/modules/sector-people/sector-people.repository.ts` (`toSectorPerson` e o tipo do `viewer`; `listContactCandidates`; `nameOrPhoneWhere` e o filtro de busca de contatos); `sector-people.service.ts` (onde monta `viewer` a partir de `isSectorAdmin`; `candidates`; `contactCandidates`); `sector-people-write.service.ts` (onde monta `viewer`; `update`); specs do módulo (`describe` novos no topo) e `sector-people.repository.integration.spec.ts`.

**Interfaces:**
- Consome: CB2 (`hasPermission`, `phoneView`, `permissionDenied`), CB4 (`PeopleActor.permissions`, T3b), CB5, fixture `actorWith` (CB2).
- Produz: CB5 (setor e candidatos de contatos).
```ts
type PeopleViewer = { isAdmin: boolean; fullPhone: boolean };   // fullPhone = hasPermission(actor, 'telefone.ver_completo')
```

**Contexto vinculado:**
- Spec B3: com a matriz inicial nada muda. Quem tem a chave vê o telefone como hoje. A regra atual da tela do setor continua e independe da chave: telefone de pessoa com login, só o ADMIN vê. Quem não tem a chave recebe da API só os 4 últimos dígitos (`•••• 1234`) e a indicação de que há telefone, na lista do setor e nos candidatos (pessoas e contatos). Não edita telefone já gravado, mas pode digitar o de pessoa nova. A busca passa a ser só por nome e matrícula.
- DB8: `hasPhone` e `phoneMasked` aditivos; `phoneE164` só com a chave; regra do setor por cima (`hidden`); sem a chave, busca sem telefone; pessoa existente sem telefone pode receber um.
- CB5: campos e `phoneView`. Candidatos de pessoas não devolvem telefone hoje: só a busca muda.
- Edição sem a chave: em `update`, corpo com `phone` para pessoa que já tem telefone → `permissionDenied('telefone.ver_completo')` (403 `auth.permission_denied`). Criação (`POST ''`) e "a partir de contatos" continuam aceitando telefone (o de contatos vem do banco por `findContactsForBatch`, não da resposta mascarada).
- Busca de contatos sem a chave: `buildContactListWhere({ search })` (`contacts.repository.ts`) casa telefone (conferido na revisão do plano), então sem a chave a busca de contatos usa só nome (`name contains q`, insensível); com a chave, `buildContactListWhere` como hoje. Não mudar o módulo `contacts` (GB5).
- GB8: máscara só por `maskPhone` (via `phoneView`).
- GB1: teste "matriz inicial, igual a hoje" nas três saídas.

**Passos:**
1. [ ] RED repository/serviço (`describe('telefone por permissão')`):
   - `it('matriz inicial: lista do setor igual a hoje, inclusive pessoa com login sem telefone para o gestor')`;
   - `it('sem a chave: phoneE164 null, phoneMasked "•••• 7777", hasPhone true')`;
   - `it('pessoa sem telefone: hasPhone false e phoneMasked null, com ou sem a chave')`;
   - `it('contact-candidates sem a chave: phoneE164 null e phoneMasked')`;
   - `it('busca sem a chave não casa telefone; com a chave casa como hoje')`.
2. [ ] RED write service: `it('update sem a chave trocando telefone gravado → 403 auth.permission_denied')`; `it('update sem a chave dando telefone a quem não tinha passa')`; `it('create sem a chave aceita telefone')`.
3. [ ] GREEN.
4. [ ] Validação: `timeout 600 gate --test` em cada spec tocado de `src/modules/sector-people/`; `TESTCONTAINERS_ENABLED=1 timeout 600 gate --test src/modules/sector-people/sector-people.repository.integration.spec.ts`; `npm run build`; `timeout 600 gate --changed --base feat/cadastro-permissoes`.

**Aceite:** spec aceite 13 (lista do setor e candidatos) e 10 (telefone igual com a matriz inicial).

**Risco: crítico (autorização)**
**Crítico:** autorização — decide quem recebe o telefone completo de terceiros na página do setor e quem pode trocar telefone gravado.

## Task 7 — Escala por permissão (back)

**Arquivos:**
- Modificar: `backend/src/modules/staff-schedule/staff-schedule.controller.ts` (sai o `@Roles` da classe; handlers conforme "Rotas"); `board.ts` (`canEdit`); `staff-schedule.service.ts` (`visibleExceptions`); specs de `board` e do serviço (`describe` novos no topo).
- Criar: `backend/src/modules/staff-schedule/staff-schedule.controller.spec.ts` (não existe hoje); `backend/src/modules/staff-schedule/staff-schedule-permission.integration.spec.ts`.

**Interfaces:**
- Consome: CB2 (`hasPermission`), CB3 (`RequirePermission`, `PermissionsGuard`, `PermissionsService`), CB4 (`TeamActor.permissions`), `canEditPerson(actor, person)` (`staff-schedule.policy.ts`).
- Produz: rotas de `StaffScheduleController`; `canEdit = canEditPerson(actor, person) && hasPermission(actor, 'escala.alterar')`.

**Contexto vinculado:**
- Tabela "Rotas": `GET options` e `GET board` com `@Roles('ADMIN','SUPERVISOR','OPERATOR')` por handler; `PUT users/:userId/schedule`, `DELETE users/:userId/schedule`, `POST users/:userId/exceptions`, `DELETE exceptions/:exceptionId` com `@RequirePermission('escala.alterar')`.
- DB7: `canEdit` do quadro = alcance e `escala.alterar`; a nota da exceção continua pelo alcance (`canEditPerson`), não pela chave.
- Spec aceite 11: desmarcar `escala.alterar` do OPERATOR faz a alteração de escala dele responder 403 na requisição seguinte; marcar de novo devolve.
- GB4: `assertCanEdit` e `viewableSectorIds` não mudam.
- GB1: com a matriz inicial o quadro e as rotas ficam iguais.

**Passos:**
1. [ ] RED `board`/serviço: `it('matriz inicial: canEdit igual a hoje')`; `it('OPERATOR gestor sem escala.alterar: canEdit false e a nota da exceção da pessoa do setor dele continua visível')`.
2. [ ] RED controller spec: metadados por handler.
3. [ ] RED `staff-schedule-permission.integration.spec.ts` (aceite 11; banco real, `PermissionsService` e `PermissionsGuard` reais, contexto do handler `PUT users/:userId/schedule`): OPERATOR passa; linha `OPERATOR/escala.alterar` com `granted false` → a avaliação seguinte lança 403 `auth.permission_denied`; `granted true` → passa.
4. [ ] GREEN.
5. [ ] Validação: `timeout 600 gate --test` nos specs tocados; `… src/modules/permissions/route-parity.spec.ts`; `TESTCONTAINERS_ENABLED=1 timeout 600 gate --test src/modules/staff-schedule/staff-schedule-permission.integration.spec.ts`; `timeout 600 gate --changed --base feat/cadastro-permissoes`.

**Aceite:** spec aceites 10 (escala) e 11.

**Risco: crítico (autorização)**
**Crítico:** autorização — troca o portão de papel pelo de permissão nas escritas da escala e no `canEdit` do quadro.

## Task 8 — Envio da equipe: rotas por permissão e disparo amplo (back)

**Arquivos:**
- Modificar: `backend/src/modules/team-whatsapp/team-whatsapp.controller.ts` (`createDispatch`, cancelar, repetir) e seu spec; `team-whatsapp.policy.ts` (`isBroadSend`, `canBroadSend`) e `team-whatsapp.policy.spec.ts`; `team-whatsapp.errors.ts` (`broadSendDenied`); `team-whatsapp.repository.ts` (`listActiveSectorIds`); `team-whatsapp.service.ts` (`dispatch`); `team-whatsapp.service.sectors.spec.ts` ou spec novo `team-whatsapp.service.broad.spec.ts`; `team-whatsapp.repository.integration.spec.ts` (`describe` novo no topo).

**Interfaces:**
- Consome: CB2 (`hasPermission`), CB3 (`RequirePermission`), CB4 (`TeamActor.permissions`), `resolveTarget`, `requireNumbers`, `requireSender` (internos de `TeamWhatsappService`).
- Produz: CB4 (`isBroadSend`, `canBroadSend`), CB6.

**Contexto vinculado:**
- Spec B4: disparo amplo é o envio da equipe por setor cujo alvo inclui todos os setores ativos da organização, quando há mais de um setor ativo; envio a um ou vários setores sem cobrir todos não é amplo; envio a uma pessoa nunca é amplo. Conferido na criação do envio, imediato ou agendado, numa única função. O alcance continua limitado aos setores que o ator gerencia. Sem a chave: `403 team_whatsapp.broad_send_denied`, texto "Você não tem permissão para enviar a todos os setores de uma vez. Desmarque um setor ou peça ao administrador."
- DB9: conferido em `dispatch` logo depois de `resolveTarget` (que já recusa setor fora do alcance com `team_whatsapp.forbidden`) e antes de `requireNumbers`, ou seja, antes de `repo.createDispatch`; `isBroadSend(input.target.sectorIds, await repo.listActiveSectorIds())` com ids sem repetição; setor inativo não conta.
- Tabela "Rotas": `POST dispatches`, `POST dispatches/:id/cancel`, `POST dispatches/:id/retry` trocam `@Roles` A,S,O por `@RequirePermission('equipe.enviar')`; leituras ficam (DB6).
- DB17: `isTeamSender`/`SENDER_ROLES` continuam como ator válido no serviço.
- Sentença R2.3: padrão ADMIN, SUPERVISOR e OPERATOR sim; um OPERATOR gestor de todos os setores ativos continua enviando a todos com a matriz inicial (GB1).
- GB4: `canSendToSector` e `requireSectors` não mudam.

**Passos:**
1. [ ] RED `team-whatsapp.policy.spec.ts`: `isBroadSend` com 3 ativos e alvo dos 3 → true; 2 dos 3 → false; 1 ativo só → false; alvo com id repetido → conta uma vez; `canBroadSend` pela chave.
2. [ ] RED serviço (`describe('disparo amplo')`):
   - `it('matriz inicial: OPERATOR gestor de todos os setores ativos envia a todos')`;
   - `it('sem equipe.disparo_amplo, alvo com todos os ativos → 403 broad_send_denied e createDispatch não é chamado')`, com `when` ausente e com `'shift_start'`;
   - `it('sem a chave, subconjunto passa')`;
   - `it('alvo user nunca é amplo')`.
3. [ ] RED controller spec: metadados das três escritas; leituras com `@Roles` A,S,O.
4. [ ] RED integração: `listActiveSectorIds` ignora setor inativo.
5. [ ] GREEN.
6. [ ] Validação: `timeout 600 gate --test` em cada spec tocado; `… src/modules/permissions/route-parity.spec.ts`; `TESTCONTAINERS_ENABLED=1 timeout 600 gate --test src/modules/team-whatsapp/team-whatsapp.repository.integration.spec.ts`; `timeout 600 gate --changed --base feat/cadastro-permissoes`.

**Aceite:** spec aceites 14 e 10 (envio).

**Risco: crítico (autorização)**
**Crítico:** autorização — troca o portão das escritas do envio pela permissão e cria a regra que recusa o envio a todos os setores.

## Task 9 — Envio da equipe: telefone no roster (back)

**Arquivos:**
- Modificar: `backend/src/schemas/contracts/team-whatsapp.schema.ts` (`teamRosterMemberSchema`); `backend/src/modules/team-whatsapp/team-whatsapp.roster.ts` (`toRosterMember`); `team-whatsapp.service.ts` (`roster`); `team-whatsapp.roster.spec.ts` e `team-whatsapp.service.roster.spec.ts` (`describe` novos no topo).

**Interfaces:**
- Consome: CB2 (`phoneView`, `hasPermission`), CB4 (`TeamActor.permissions`), CB5.
- Produz: CB5 (roster).
```ts
toRosterMember(m: DayMember, viewer: { fullPhone: boolean }): RosterMember   // o parâmetro atual (DayMember) fica; viewer é novo
```
O chamador em `team-whatsapp.service.ts` (`roster`) usa hoje `.map(toRosterMember)`: passa a lambda `.map((m) => toRosterMember(m, viewer))`, senão o `map` entregaria o índice no lugar de `viewer`.

**Contexto vinculado:**
- Spec B3: quem não tem `telefone.ver_completo` recebe só os 4 últimos dígitos e a indicação de que há telefone na lista de destinatários do envio; o grupo "Sem telefone" continua correto. A lista de destinatários continua mostrando o telefone de quem tem login para quem tem a chave (como hoje; anotado para a GBR).
- DB8/CB5: `phoneE164` só com a chave; `hasPhone` e `phoneMasked` sempre; o telefone do roster continua `contact.phoneE164 ?? user.phoneE164`.
- O envio em si (classificação `NO_PHONE` na montagem e no worker) lê o telefone do banco e não muda.
- GB1: com a matriz inicial o roster é igual a hoje mais os dois campos novos.
- GB8: máscara só por `maskPhone`.

**Passos:**
1. [ ] RED `team-whatsapp.roster.spec.ts`: com `fullPhone` igual a hoje (inclusive membro com login); sem `fullPhone` `phoneE164 null` e `phoneMasked`; membro sem telefone `hasPhone false`.
2. [ ] RED `team-whatsapp.service.roster.spec.ts`: `roster` passa `fullPhone` pela chave do ator; OPERATOR sem a chave recebe mascarado.
3. [ ] GREEN; chamadores de `toRosterMember` ajustados (GB13).
4. [ ] Validação: `timeout 600 gate --test src/modules/team-whatsapp/team-whatsapp.roster.spec.ts`; `… src/modules/team-whatsapp/team-whatsapp.service.roster.spec.ts`; `npm run build`; `timeout 600 gate --changed --base feat/cadastro-permissoes`.

**Aceite:** spec aceite 13 (roster).

**Risco: crítico (autorização)**
**Crítico:** autorização — decide quem recebe o telefone completo dos destinatários do envio.

## Task 10 — Estrutura: setores, turnos e níveis por permissão (back)

**Arquivos:**
- Modificar: `backend/src/modules/shifts/shifts.controller.ts` e `backend/src/modules/levels/levels.controller.ts` (classe: `@Roles('ADMIN')` → `@RequirePermission('estrutura.manter')`) e seus specs; `backend/src/modules/internal-sectors/internal-sectors.controller.ts` (`create`, `get`, `update`: decorator e repasse do papel), `internal-sectors.service.ts` (`create`, `update`: ganham `actorRole`; chamam `assertManagerChangeAllowed` antes de `validateManager` e, se `!canSetSectorManager`, tiram `managerId` do que gravam); specs do módulo que chamam `create`/`update` do serviço (Grep no início; pelo menos `internal-sectors.controller.spec.ts`, `internal-sectors.service.spec.ts`, `internal-sectors.integration.spec.ts`, `internal-sectors.audit.integration.spec.ts`), com `describe` novos no topo.
- Criar: `backend/src/modules/internal-sectors/sector-manager.policy.ts` e `sector-manager.policy.spec.ts`.

**Interfaces:**
- Consome: CB3 (`RequirePermission`), CB4 (`PolicyActor`), `validateManager` (`internal-sectors.service.ts`, regra de quem pode ser gestor; não muda), `ForbiddenError` (o mesmo de `broadSendDenied`, CB6).
- Produz: rotas de estrutura da tabela "Rotas"; CB4 (`sector-manager.policy.ts`); CB8 (`sector.manager_admin_only`).
```ts
// internal-sectors.service.ts (exceção a GB13: parâmetro novo obrigatório; a task ajusta todos os chamadores e specs)
create(input: CreateSector, actorId: string, actorRole: Role)
update(id: string, input: UpdateSector, actorId: string, actorRole: Role)
// controller: this.sectors.create(dto, req.user.sub, req.user.role); idem update (o papel vem do banco pelo JwtStrategy)
```

**Contexto vinculado:**
- Spec B2 `estrutura.manter`: criar e editar setores, turnos e níveis; hoje é só ADMIN; a chave permite ao ADMIN liberar para outro papel.
- DB5: as leituras só da manutenção (`GET internal/shifts`, `GET internal/levels`, `GET internal/sectors/:id`) seguem a chave; `GET internal/sectors` e `GET :id/members` continuam A4. Nenhuma rota nova.
- DB20 (provisória, a confirmar com a GBR): escolher ou trocar o gestor (`managerId`) continua só do ADMIN, regra fixa em código. Quem tem a chave sem ser ADMIN cria e edita o resto do setor, e o campo `managerId` nunca entra no que o serviço grava (sai do `updateData` sempre; na criação, o setor nasce sem gestor). A comparação com o valor lido (`this.get(id)`, fora do `tx`) serve só para decidir a resposta: `managerId` diferente do lido → `403 sector.manager_admin_only` "Só o administrador escolhe o gestor do setor.", antes de `validateManager` e de qualquer gravação; ausente ou igual ao lido segue, sem gravar `manager` (o formulário reenvia o objeto inteiro). Na criação, `managerId` ausente ou `null` cria sem gestor e qualquer valor → 403. Como nada é gravado nesse campo, a leitura fora do `tx` não abre corrida com um ADMIN que troque o gestor ao mesmo tempo, e a trilha `sector.updated` do Lote A não registra `manager` para quem não é ADMIN.
- GB6: a checagem mora só em `sector-manager.policy.ts` (`canSetSectorManager` é o único `role === 'ADMIN'`); o serviço chama `assertManagerChangeAllowed`.
- GB4: a permissão nunca amplia o alcance; sem DB20, `estrutura.manter` deixaria alguém se pôr como gestor e ganhar alcance sobre pessoas, telefones e envios.
- CB8: `403 sector.manager_admin_only`, `title` "Só o administrador escolhe o gestor do setor.", sem `detail`.
- GB5: números e canais do setor (`whatsapp/channels/:id/sectors`, `internal/numbers`) continuam só ADMIN.
- GB1: com a matriz inicial, só o ADMIN passa em todas essas rotas, e ele cria e troca gestor como hoje.
- A trilha de setor do Lote A (`sector.created`/`sector.updated`, `STRUCTURE`, `actorId` explícito) não muda.

**Passos:**
1. [ ] RED specs dos três controllers: metadados (chave em classe para turnos e níveis; chave em `create`, `get`, `update`; `list` e `members` com `@Roles` A4); `create` e `update` repassam `req.user.role`.
2. [ ] RED `sector-manager.policy.spec.ts`:
   - `it('canSetSectorManager: só ADMIN')`;
   - `it('SUPERVISOR: managerId ausente ou igual ao atual passa')`;
   - `it('SUPERVISOR: managerId diferente do atual lança 403 sector.manager_admin_only com o texto')`, inclusive trocando para `null` e, na criação (atual `null`), mandando um id;
   - `it('ADMIN troca o gestor')`.
3. [ ] RED `internal-sectors.service.spec.ts` (`describe('gestor só pelo ADMIN')`):
   - `it('SUPERVISOR com a chave cria setor sem managerId')`;
   - `it('SUPERVISOR cria setor com managerId → 403 e nada é gravado')` (`validateManager` e a gravação não são chamados);
   - `it('SUPERVISOR edita o nome reenviando o managerId atual → passa')`;
   - `it('SUPERVISOR com a chave reenviando o gestor atual não grava manager')`: o `updateData` entregue ao repositório não tem a chave `managerId` e a trilha `sector.updated` não traz `manager`;
   - `it('SUPERVISOR cria setor com managerId null → cria sem gestor')`;
   - `it('SUPERVISOR troca o managerId → 403 e nada é gravado')`;
   - `it('ADMIN cria e troca o gestor como hoje')`.
4. [ ] GREEN; ajustar os chamadores de `create`/`update` nos specs (`'ADMIN'` onde o teste não é sobre o papel).
5. [ ] Validação: `timeout 600 gate --test` em cada spec tocado; `… src/modules/permissions/route-parity.spec.ts`; os de integração com `TESTCONTAINERS_ENABLED=1 timeout 600 gate --test src/modules/internal-sectors/<arquivo>.integration.spec.ts`; `npm run build`; `timeout 600 gate --changed --base feat/cadastro-permissoes`.

**Aceite:** spec aceite 10 (estrutura); com `estrutura.manter` liberada, SUPERVISOR lista, cria e edita turno, nível e setor sem mudar o gestor (teste de guard com permissões falsas e testes do serviço); só o ADMIN escolhe o gestor (DB20).

**Risco: crítico (autorização)**
**Crítico:** autorização — troca o portão de papel pelo de permissão na manutenção da estrutura e mantém a escolha do gestor do setor, que define alcance sobre pessoas, telefones e envios, só com o ADMIN.

## Task 11 — API da matriz com trilha (back)

**Arquivos:**
- Criar: `backend/src/modules/permissions/permissions.controller.ts`, `permissions.repository.ts`, `dto/save-permission-matrix.dto.ts`, `permissions.errors.ts`, `permissions.service.spec.ts`, `permissions.controller.spec.ts`, `permissions.repository.integration.spec.ts`.
- Modificar: `backend/src/modules/permissions/permissions.service.ts` (`matrix`, `save`, `restoreDefaults`) e `permissions.module.ts` (controller e repositório).

**Interfaces:**
- Consome: CB1, CB2, CB3 (`findEffectivePermissions`), CB7, `AuditService.recordChange(tx, change)` e `diffFields` (`backend/src/shared/audit/`), `AuditChange` (C2 do Lote A: `action`, `entity`, `entityId`, `category`, `changes`, `actorId` obrigatório).
- Produz:
```ts
matrix(): Promise<PermissionMatrix>
save(actorId: string, body: SavePermissionMatrix): Promise<PermissionMatrix>
restoreDefaults(actorId: string): Promise<PermissionMatrix>
// permissions.repository.ts
findRows(client): Promise<Array<{ role: Role; key: string; granted: boolean }>>
writeCells(tx, cells: ReadonlyArray<{ role: EditableRole; key: PermissionKey; granted: boolean }>, actorId: string): Promise<void>   // upsert
// permissions.errors.ts
export function fixedRole(): DomainError;   // 422 permissions.fixed_role (CB8)
```

**Contexto vinculado:**
- Spec B1/B5: só o ADMIN define permissões ("Definir permissões" é regra fixa, não chave); a tela edita só SUPERVISOR e OPERATOR; ADMIN e VIEWER não são editáveis, nem pela API (aceite 12); toda alteração grava na trilha antes e depois por chave e papel; a mudança vale na requisição seguinte.
- DB11: `GET /permissions`, `PUT /permissions` com estado completo de SUPERVISOR e OPERATOR, `POST /permissions/restore-defaults`; `@Roles('ADMIN')` na classe; ADMIN ou VIEWER no corpo → `422 permissions.fixed_role`; chave repetida no corpo conta uma vez.
- DB12: ação `permission.matrix_updated` ou `permission.matrix_restored`, `entity 'RolePermission'`, `entityId null`, categoria `PERMISSIONS`, `field '<chave>:<PAPEL>'`, `before`/`after` booleanos, só células alteradas; sem mudança, nada é gravado.
- GB7: células e trilha na mesma transação serializável (o helper que `users.repository.ts` usa; se for privado do módulo, `prisma.$transaction(fn, { isolationLevel: 'Serializable' })`); trilha que falha desfaz a mudança. O "antes" é lido dentro da transação.
- GB2: o ADMIN nunca perde a tela (regra fixa por `@Roles`).
- `categoryOfAction('permission.')` já devolve `PERMISSIONS` (C2 do Lote A).

**Passos:**
1. [ ] RED `permissions.service.spec.ts`:
   - `it('matrix devolve keys, roles dos 4 papéis, defaults e editableRoles')`;
   - `it('save com ADMIN ou VIEWER no corpo → 422 permissions.fixed_role sem gravar')`;
   - `it('save tirando escala.alterar do OPERATOR grava uma célula e uma FieldChange escala.alterar:OPERATOR true→false')`;
   - `it('save sem mudança não grava nem chama recordChange')`;
   - `it('restoreDefaults grava só as células diferentes do padrão com permission.matrix_restored')`.
2. [ ] RED `permissions.controller.spec.ts`: `@Roles('ADMIN')` na classe; `PUT` repassa `req.user.sub` como `actorId`.
3. [ ] RED `permissions.repository.integration.spec.ts`: `it('trilha que lança desfaz a mudança da matriz')`; `it('evento gravado tem category PERMISSIONS, subjectUserId nulo e changes por célula')`.
4. [ ] GREEN; registrar controller e repositório no módulo.
5. [ ] Validação: `timeout 600 gate --test src/modules/permissions/permissions.service.spec.ts`; `… src/modules/permissions/permissions.controller.spec.ts`; `TESTCONTAINERS_ENABLED=1 timeout 600 gate --test src/modules/permissions/permissions.repository.integration.spec.ts`; `npm run build`; `timeout 600 gate --changed --base feat/cadastro-permissoes`.

**Aceite:** spec aceites 12 e 16 (gravação; a consulta geral já é só ADMIN).

**Risco: crítico (autorização)**
**Crítico:** autorização — cria a API que muda quem pode fazer cada ação para SUPERVISOR e OPERATOR, com trilha na mesma transação.

## Task 12 — Login e GET /auth/me com permissões (back)

**Arquivos:**
- Modificar: `backend/src/schemas/contracts/auth.schema.ts` (`currentAuthUserSchema`, `meResponseSchema`); `backend/src/modules/auth/auth.service.ts` (`CurrentAuthUser`, `loginResult`, `me` novo); `auth.controller.ts` (`@Get('me')`); `auth.service.spec.ts` e o spec do controller (`describe` novos no topo).

**Interfaces:**
- Consome: CB3 (`PermissionsService.effectiveFor`), CB7 (auth), `AuthRepository.findById`.
- Produz:
```ts
me(userId: string): Promise<{ user: CurrentAuthUser; mustChangePassword: boolean }>
// CurrentAuthUser ganha permissions: PermissionKey[]
```

**Contexto vinculado:**
- Spec B1: as permissões efetivas vão na resposta do login e em `GET /auth/me` (novo); menu e botões leem delas; sem cache.
- DB13: `GET /auth/me` com `@Roles('ADMIN','OPERATOR','SUPERVISOR','VIEWER')`, resposta `{ user, mustChangePassword }` igual ao login sem o token; o usuário vem do banco (o `JwtStrategy` já recarrega e recusa inativo, sem acesso ou sessão revogada).
- GB2: ADMIN recebe as 8 chaves e VIEWER `[]`, sem depender do banco.
- GB3: o JWT não ganha permissões; `refresh` continua devolvendo só `{ accessToken }`.
- GB13: o objeto `user` do login só ganha campo; o front antigo continua lendo.

**Passos:**
1. [ ] RED `auth.service.spec.ts`: `it('login devolve user.permissions de effectiveFor(role)')`; `it('me devolve o mesmo user do login e mustChangePassword')`; `it('VIEWER recebe []')`.
2. [ ] RED controller: `GET me` com `@Roles` dos 4 papéis, chama `me(req.user.sub)`; resposta valida em `meResponseSchema`.
3. [ ] GREEN.
4. [ ] Validação: `timeout 600 gate --test src/modules/auth/auth.service.spec.ts`; `timeout 600 gate --test` no spec do controller; `npm run build`; `timeout 600 gate --changed --base feat/cadastro-permissoes`.

**Aceite:** spec aceite 15 (back).

**Risco: crítico (autorização)**
**Crítico:** autorização — expõe as permissões efetivas no login e numa rota nova de sessão, que o front usa para decidir menu e botões.

## Task 13 — Permissões no front: tipos, sessão e releitura (front)

**Arquivos:**
- Criar: `frontend/src/features/permissions/keys.ts`, `access.ts` e `access.spec.ts`, `use-permission.ts`, `use-session-sync.ts` e `use-session-sync.spec.tsx`.
- Modificar: `frontend/src/stores/auth.store.ts` (`AuthUser.permissions?`, `setUser`); `frontend/src/features/auth/schemas.ts` (`loginResponseSchema`, `meResponseSchema`) e seu spec; `frontend/src/features/auth/api.ts` (`fetchMe`); `frontend/src/lib/api-client.ts` (`onPermissionDenied`) e seu spec; `frontend/src/components/layout/authenticated-layout.tsx` (chama `useSessionSync()`).

**Interfaces:**
- Consome: CB7 (formato do login e de `/auth/me`), CB8 (código `auth.permission_denied`).
- Produz: CB9.

**Contexto vinculado:**
- Spec B1/B5: permissões efetivas no login e em `/auth/me`; menu e botões leem delas; a mudança vale na requisição seguinte de cada usuário, sem novo login.
- DB14: relê `/auth/me` ao montar o layout autenticado, ao voltar o foco à janela, a cada 5 minutos (`refetchInterval`), depois de qualquer 403 `auth.permission_denied` (`onPermissionDenied`) e quando o ADMIN salva a matriz (a T18 invalida `ME_QUERY_KEY`). Sessão persistida sem `permissions` usa `DEFAULT_PERMISSIONS[role]`.
- DB19: chave desconhecida é descartada; `permissions` ausente no login (back antigo) não quebra.
- `persist` de `picoa-auth` continua sem o token (`partialize` com `user` e `mustChangePassword`); `setUser` não toca no token.
- Memória do projeto: ky 2 consome o corpo do erro (o código fica em `HTTPError.data`; usar `readApiErrorBody`); no hook do api-client, ler de `response.clone()`.
- GB12: nenhum texto novo de tela nesta task além de rótulos de CB9.

**Passos:**
1. [ ] RED `access.spec.ts`: sessão sem `permissions` → padrão do papel (OPERATOR tem `escala.alterar`, não tem `trilha.consultar`); com `permissions` → só elas; `null` → nenhuma; `toPermissionKeys` descarta desconhecida.
2. [ ] RED spec de `schemas.ts`: login sem `permissions` passa; com chave desconhecida, ela some; `meResponseSchema` valida.
3. [ ] RED `use-session-sync.spec.tsx`: montar chama `GET auth/me` e grava `user` com `permissions` na store mantendo o token; evento `onPermissionDenied` refaz a leitura.
4. [ ] RED spec do api-client: 403 com `code 'auth.permission_denied'` dispara os ouvintes e o corpo continua legível por `readApiErrorBody`.
5. [ ] GREEN.
6. [ ] Validação: `timeout 600 gate --test` em cada spec tocado; `timeout 600 gate --changed --base feat/cadastro-permissoes`.

**Aceite:** spec aceite 15 (store e releitura).

**Risco: médio** (o front só esconde; a API decide).

## Task 14 — Menu, guardas de rota e políticas de tela (front)

**Arquivos:**
- Modificar: `frontend/src/lib/nav.ts` (`NavItem.permission?`; `navItemsForRole`, `navSection`, `canAccessPath` ganham `permissions?` como último parâmetro; itens `/turnos` e `/niveis`) e `nav.spec.ts`; consumidores `components/layout/sidebar.tsx`, `components/command-palette.tsx`, `components/layout/release-notes-dialog.tsx` (passam `usePermissions()`); `frontend/src/features/people-record/ui-policy.ts` e `ui-policy.spec.ts`; `frontend/src/routes/_authenticated/turnos/index.tsx` e `niveis/index.tsx` (`beforeLoad`); `frontend/src/features/staff-schedule/error-messages.ts` (mostrar `detail` de `auth.permission_denied`).

**Interfaces:**
- Consome: CB9 (`hasPermission`, `effectivePermissions`, `usePermissions`).
- Produz:
```ts
// nav.ts
navItemsForRole(role?: NavRole, permissions?: readonly PermissionKey[]): NavItem[]
navSection(section: NavSection, role?: NavRole, permissions?: readonly PermissionKey[]): NavItem[]
canAccessPath(path: string, role?: NavRole, permissions?: readonly PermissionKey[]): boolean
  // item com permission exige papel em roles E a chave; permissions ausente → DEFAULT_PERMISSIONS[role]
// ui-policy.ts: nas duas funções com permissions, permissions ausente (undefined) → DEFAULT_PERMISSIONS[role], como no nav.ts
canChangePersonStatusUi(role: UserRole, person: { hasAccess: boolean }, permissions?: readonly PermissionKey[]): boolean
  // tem pessoas.inativar && (ADMIN || !person.hasAccess)
canViewPersonHistoryUi(role: UserRole, permissions?: readonly PermissionKey[]): boolean   // ADMIN || tem trilha.consultar
canQueryAuditTrailUi(role: UserRole): boolean                                            // igual: só ADMIN
```

**Contexto vinculado:**
- Spec B1: menu e botões das telas cobertas leem das permissões; leituras seguem por papel.
- Itens de menu: `/turnos` e `/niveis` passam a `roles: WRITE_INTERNAL_ROLES, permission: 'estrutura.manter'` (DB5); `/escala`, `/whatsapp-equipe`, `/setores` continuam por papel (a leitura continua para quem tinha); `/trilha`, `/users`, `/connect`, `/configuracoes` continuam só ADMIN.
- `beforeLoad` de `turnos` e `niveis`: `hasPermission(user, 'estrutura.manter')`, senão `redirect` para `/dashboard` como hoje.
- GB6 (front): decisão só por `features/permissions` e `ui-policy.ts`; nada de `role === 'ADMIN'` novo.
- GB1: sem `permissions` (padrão do papel) o menu e as guardas ficam iguais a hoje para os quatro papéis.
- GB13: parâmetros novos opcionais; chamadores atuais (`user-actions-menu.tsx`, `people-table.tsx`, `trilha/index.tsx`) compilam sem mudança.
- DB10: o 403 de permissão traz o texto em `detail`.

**Passos:**
1. [ ] RED `nav.spec.ts`: `it('padrão do papel: menu igual a hoje para os 4 papéis')`; `it('OPERATOR com estrutura.manter vê Turnos e Níveis')`; `it('SUPERVISOR sem a chave não acessa /turnos')`.
2. [ ] RED `ui-policy.spec.ts`: matriz inicial igual ao Lote A; sem o argumento `permissions` usa `DEFAULT_PERMISSIONS[role]` (SUPERVISOR inativa pessoa sem login e vê histórico; OPERATOR não); OPERATOR com `pessoas.inativar` inativa sem login; SUPERVISOR sem `trilha.consultar` não vê histórico.
3. [ ] GREEN; consumidores passam `usePermissions()`.
4. [ ] Validação: `timeout 600 gate --test src/lib/nav.spec.ts`; `… src/features/people-record/ui-policy.spec.ts`; `timeout 600 gate --changed --base feat/cadastro-permissoes`.

**Aceite:** spec aceite 15 (menu).

**Risco: médio**

## Task 15 — Pessoas do setor: telefone mascarado e ações por permissão (front)

**Arquivos:**
- Modificar em `frontend/src/features/sector-people/`: `schemas.ts` (`sectorPersonSchema`, `sectorContactCandidatesSchema`); `components/contacts-tab.tsx` (telefone e placeholder da busca); `components/existing-person-tab.tsx` (placeholder); `components/edit-person-dialog.tsx` (telefone); `components/people-table.tsx` (ações por permissão); specs desses componentes (`describe` novos no topo).

**Interfaces:**
- Consome: CB5, CB9 (`usePermission`, `usePermissions`), T14 (`canChangePersonStatusUi`, `canViewPersonHistoryUi` com `permissions`).
- Produz: telas do setor lendo `hasPhone`/`phoneMasked` e as chaves.

**Contexto vinculado:**
- Spec B3: sem `telefone.ver_completo` a API manda só `•••• 1234` e a indicação de que há telefone; não edita telefone já gravado, mas digita o de pessoa nova; a busca é só por nome e matrícula.
- DB8/CB5: mostrar `formatPhoneBR(phoneE164)` quando vier, senão `phoneMasked`; candidatos de contatos com `phoneE164` nulo.
- Regra do setor (`hidden`, CB2): pessoa com login para quem não é ADMIN chega com `hasPhone` true e `phoneE164` e `phoneMasked` nulos; a célula mostra "—" como hoje, sem máscara, sem selo de telefone e sem "Sem telefone". O `hasPhone` dessa pessoa não aparece em lugar nenhum da tela.
- Edição: com `person.hasPhone` e sem `telefone.ver_completo`, o campo Telefone fica só leitura mostrando `phoneMasked` e o texto "Você não tem permissão para alterar o telefone já cadastrado."; o payload não manda `phone` (já só manda se mudou). Pessoa com login segue o texto atual ("Nome e telefone de quem tem acesso mudam em Usuários").
- Placeholder sem a chave: contatos "Buscar contato por nome"; pessoas "Buscar por nome ou matrícula". Com a chave, os textos atuais.
- Botões de escrita dentro de `features/sector-people/` (editar, mover, tirar, adicionar) só com `pessoas.editar`; inativar por `canChangePersonStatusUi(role, person, permissions)`; histórico por `canViewPersonHistoryUi(role, permissions)`. Botões que ficam nas rotas `setores/` são da T16.
- GB1: com a matriz inicial, as telas ficam iguais a hoje.
- GB12: textos pt-BR exatos acima.

**Passos:**
1. [ ] RED specs: `it('sem telefone.ver_completo mostra •••• 7777 no contato e no diálogo, telefone só leitura')`; `it('com a chave mostra o telefone formatado como hoje')`; `it('pessoa com login para quem não é ADMIN (hasPhone true, phoneE164 e phoneMasked nulos) mostra "—", sem máscara nem Sem telefone')`; `it('sem pessoas.editar some Editar/Mover/Tirar')`; `it('placeholder sem a chave fala só de nome')`.
2. [ ] GREEN.
3. [ ] Validação: `timeout 600 gate --test` em cada spec tocado; `timeout 600 gate --changed --base feat/cadastro-permissoes`.

**Aceite:** spec aceites 13 e 15 (tela do setor).

**Risco: médio**

## Task 16 — Setores: estrutura por permissão e gestor só do administrador (front)

**Arquivos:**
- Modificar: `frontend/src/routes/_authenticated/setores/index.tsx` (botão de novo setor; filtro da lista), `setores/$sectorId.tsx` (cabeçalho, `AdminPanel` e o aviso de setor não gerenciado; botões de pessoa que estiverem neste arquivo), `setores/new.tsx` (`beforeLoad`); `frontend/src/features/internal-admin/components/sector-form.tsx` (gestor) e seus specs.
- Criar: `frontend/src/features/internal-admin/sector-policy.ts` e `sector-policy.spec.ts`.

**Interfaces:**
- Consome: CB7 (setores: sem rota nova; `GET internal/sectors/:id` já traz `managerId` e `manager { id, name, email }`), CB8 (`sector.manager_admin_only`), CB9 (`usePermission`, `hasPermission`), `useAllUsers` (`features/users/api.ts`, `GET /users`, só ADMIN), `isSectorForbidden` e `SECTOR_FORBIDDEN_MESSAGE` (`features/sector-people/error-messages.ts`).
- Produz:
```ts
// features/internal-admin/sector-policy.ts (DB20; único lugar do front com a regra)
export function canSetSectorManagerUi(role?: UserRole): boolean;   // só ADMIN
```

**Contexto vinculado:**
- Spec B2 `estrutura.manter`: criar e editar setores, turnos e níveis; o ADMIN pode liberar para outro papel.
- DB20 (provisória, a confirmar com a GBR): escolher ou trocar o gestor do setor continua só do ADMIN. No formulário, o campo Gestor (e a chamada a `useAllUsers()`, que hoje fica no topo de `SectorForm`) só monta quando `canSetSectorManagerUi(role)`; mover `useAllUsers()` para dentro do bloco do gestor, para quem não é ADMIN não chamar `GET /users`. Para os demais, o gestor atual aparece como texto "Gestor: <nome>" a partir de `sector.manager?.name`, ou "Gestor: A definir" (mesmo texto do cabeçalho da página). O payload continua mandando `managerId` como hoje (na edição, o valor gravado; na criação, `null`): o back aceita valor igual ao gravado e não grava o campo. Se vier `403 sector.manager_admin_only`, mostrar o texto do servidor.
- DB5: nenhuma rota nova; o ADMIN continua lendo os gestores possíveis em `GET /users`, com o filtro atual do formulário.
- Com `estrutura.manter`: botão de novo setor, `setores/new` e o painel de edição do setor aparecem; a lista de setores mostra todos (hoje: ADMIN todos, os demais só os que gerenciam). Sem a chave, igual a hoje.
- Página do setor com a chave em setor que o ator não gerencia: hoje `$sectorId.tsx` sai cedo com `SECTOR_FORBIDDEN_MESSAGE` quando `useSectorPeople` devolve 403, antes de montar o `AdminPanel`. Com `estrutura.manter`, a página renderiza o cabeçalho (a partir de `useSector`, que só é chamado com a chave) e o `AdminPanel`, e mostra `SECTOR_FORBIDDEN_MESSAGE` só no lugar da lista de pessoas. Vale também para o setor recém-criado em `setores/new`. Sem a chave, igual a hoje. O `AdminPanel` passa de `isAdmin` para `usePermission('estrutura.manter')`.
- GB5: a parte de número e canal do setor (`sector-number.tsx`) continua só para o ADMIN; usar a checagem de ADMIN que já existe na página, sem criar outra.
- Botões de escrita de pessoas que estiverem em `setores/$sectorId.tsx` só com `pessoas.editar` (os de `features/sector-people/` são da T15).
- GB6/GB1/GB12: decisão por `features/permissions` e, para o gestor, por `canSetSectorManagerUi`; nada de `role === 'ADMIN'` novo em componente; matriz inicial igual a hoje (o ADMIN vê o formulário e a página como hoje); textos atuais.

**Passos:**
1. [ ] RED:
   - `it('SUPERVISOR com estrutura.manter vê Novo setor e o painel do setor, sem a parte de número')`;
   - `it('SUPERVISOR com estrutura.manter em setor que não gerencia (pessoas 403) vê cabeçalho, edita o setor e vê o aviso no lugar da lista')`;
   - `it('sem a chave a página fica como hoje')`;
   - `it('canSetSectorManagerUi: só ADMIN')` (`sector-policy.spec.ts`);
   - `it('sector-form do ADMIN lista gestores de GET /users como hoje')`;
   - `it('sector-form de quem não é ADMIN não mostra o campo Gestor, não chama GET /users e mostra "Gestor: <nome>"')`.
2. [ ] GREEN.
3. [ ] Validação: `timeout 600 gate --test` em cada spec tocado; `timeout 600 gate --changed --base feat/cadastro-permissoes`.

**Aceite:** spec aceite 15 (estrutura).

**Risco: médio**

## Task 17 — WhatsApp da equipe: ações, disparo amplo e telefone (front)

**Arquivos:**
- Modificar em `frontend/src/features/team-whatsapp/`: `schemas.ts` (`rosterMemberSchema`); `member-filter.ts` (`canReceive`, `isNotAuthorized`, `leftOutPeople`, grupo sem telefone) e seu spec; `components/member-selection.tsx` (subtítulo do telefone; grupo "Sem telefone"); `components/scheduled-dispatches.tsx` (Cancelar); `components/recipient-table.tsx` (Repetir); `error-messages.ts` (`team_whatsapp.broad_send_denied`, `auth.permission_denied`); `frontend/src/routes/_authenticated/whatsapp-equipe/index.tsx` (entrada do envio); specs tocados (`describe` novos no topo).

**Interfaces:**
- Consome: CB5 (roster), CB8, CB9 (`usePermission`).
- Produz: telas do envio lendo `hasPhone`/`phoneMasked` e as chaves.

**Contexto vinculado:**
- Spec B3: sem a chave, o roster traz só `•••• 1234` e a indicação de telefone; o grupo "Sem telefone" continua correto.
- DB8: todo teste de presença de telefone em `member-filter.ts` passa a usar `hasPhone` (não `phoneE164`): `canReceive`, `isNotAuthorized` (alimenta o grupo "Contato não autorizado" de `member-selection.tsx`), `leftOutPeople` (prévia `no_phone`) e o grupo "Sem telefone". Sem isso, com `phoneE164` nulo o grupo "Contato não autorizado" fica vazio e a prévia marca todo mundo como `no_phone` (aceite 13); subtítulo mostra `formatPhoneBR(phoneE164)` ou `phoneMasked`.
- Spec B4: sem `equipe.disparo_amplo`, envio a todos os setores ativos é recusado com o texto "Você não tem permissão para enviar a todos os setores de uma vez. Desmarque um setor ou peça ao administrador." O atalho "Todos os setores" fica sempre visível e não muda (`sector-shift-picker.tsx` não é tocado): ali "Todos" são os setores do remetente, e para quem gerencia só parte dos setores ativos isso não é amplo (B4). A recusa vem do servidor (`403 team_whatsapp.broad_send_denied`) e o front mostra esse texto.
- DB6: entrada de envio, Cancelar envio e Repetir só com `equipe.enviar`; o histórico e os detalhes continuam visíveis.
- DB10: `auth.permission_denied` mostra o `detail` do servidor.
- GB1: com a matriz inicial, as telas ficam iguais a hoje.
- Memória do projeto: ky 2 consome o corpo; ler o código por `readApiErrorBody`.

**Passos:**
1. [ ] RED:
   - `it('membro sem phoneE164 mas com hasPhone não cai em Sem telefone e mostra •••• 7777')`;
   - `it('membro sem telefone cai em Sem telefone')`;
   - `it('sem a chave: não autorizado continua no grupo próprio e a prévia não marca no_phone')` (`member-filter.spec.ts`: `isNotAuthorized` e `leftOutPeople` com `phoneE164` nulo e `hasPhone` true);
   - `it('sem equipe.disparo_amplo o atalho Todos os setores continua visível')`;
   - `it('broad_send_denied mostra o texto da spec')`;
   - `it('sem equipe.enviar some Enviar, Cancelar envio e Repetir')`.
2. [ ] GREEN.
3. [ ] Validação: `timeout 600 gate --test` em cada spec tocado; `timeout 600 gate --changed --base feat/cadastro-permissoes`.

**Aceite:** spec aceites 13 (roster na tela), 14 (mensagem) e 15 (botões).

**Risco: médio**

## Task 18 — Tela Permissões em Configurações e rótulos da trilha (front)

**Arquivos:**
- Criar: `frontend/src/features/permissions/api.ts` (`usePermissionMatrix`, `useSavePermissionMatrix`, `useRestorePermissionDefaults`); `schemas.ts` (espelho de `permissionMatrixSchema`); `matrix-diff.ts` e `matrix-diff.spec.ts`; `components/permissions-matrix.tsx` e `.spec.tsx`; `components/permissions-confirm-dialog.tsx`.
- Modificar: `frontend/src/routes/_authenticated/configuracoes.tsx` (card "Permissões" abaixo de "Organização"); `frontend/src/features/audit-trail/labels.ts` e seu spec (campos `<chave>:<PAPEL>` e ações `permission.*`).

**Interfaces:**
- Consome: CB7 (matriz), CB9 (`PERMISSION_LABELS`, `ME_QUERY_KEY`), `ROLE_LABEL` (`features/users/role.ts`).
- Produz:
```ts
export type MatrixChange = { role: 'SUPERVISOR' | 'OPERATOR'; key: PermissionKey; granted: boolean };
export function matrixChanges(current: PermissionMatrix['roles'], draft: { SUPERVISOR: PermissionKey[]; OPERATOR: PermissionKey[] }): MatrixChange[];
PermissionsMatrix(): JSX.Element
```

**Contexto vinculado:**
- Spec B5: em Configurações, só para o ADMIN: tabela com uma linha por permissão (nome e explicação curta em pt-BR) e uma coluna por papel. ADMIN marcado e travado; VIEWER desmarcado e travado. SUPERVISOR e OPERATOR com caixas. Salvar pede confirmação mostrando o que muda. Há o botão "Restaurar padrão". A mudança vale na requisição seguinte de cada usuário, sem novo login.
- DB15: card na página Configurações (já só ADMIN pelo `beforeLoad`).
- Confirmação: título "Confirmar alterações de permissões"; uma linha por mudança, "<Papel>: passa a poder <nome>" ou "<Papel>: deixa de poder <nome>" (papel por `ROLE_LABEL`, nome por `PERMISSION_LABELS`); botões "Salvar" e "Cancelar". "Restaurar padrão" abre a mesma confirmação com as diferenças para `defaults`; sem diferença, o botão fica desabilitado. Sucesso: toast "Permissões salvas" e invalidar `ME_QUERY_KEY` (DB14). Erro: toast com o texto do servidor.
- Texto de apoio do card: "Defina o que Supervisor e Operador podem fazer. Administrador tem todas as permissões e Visualizador nenhuma; essas colunas não mudam."
- Trilha (DB12): campo `<chave>:<PAPEL>` vira "<nome da permissão> (<Papel>)"; valores booleanos "Sim"/"Não"; ações `permission.matrix_updated` "Permissões alteradas" e `permission.matrix_restored` "Permissões restauradas ao padrão"; categoria `PERMISSIONS` já rotulada "Permissões" (C11 do Lote A).
- GB12: chave e papel nunca crus.

**Passos:**
1. [ ] RED `matrix-diff.spec.ts`: ganho, perda, sem mudança.
2. [ ] RED `permissions-matrix.spec.tsx`: colunas ADMIN e VIEWER desabilitadas e marcadas/desmarcadas; marcar uma caixa e Salvar abre a confirmação com a frase certa; confirmar chama `PUT /permissions` só com `SUPERVISOR` e `OPERATOR`; "Restaurar padrão" chama `POST /permissions/restore-defaults`.
3. [ ] RED spec de `labels.ts`: `escala.alterar:OPERATOR` → "Alterar a escala (Operador)"; ações `permission.*`.
4. [ ] GREEN.
5. [ ] Validação: `timeout 600 gate --test` em cada spec tocado; `timeout 600 gate --changed --base feat/cadastro-permissoes`.

**Aceite:** spec aceites 12 (tela trava), 16 (trilha legível) e B5.

**Risco: médio**

## Task 19 — Novidades (front)

**Arquivos:**
- Modificar: `frontend/src/release-notes.ts` (entrada nova no topo de `RELEASE_NOTES`).

**Interfaces:**
- Consome: formato atual de `RELEASE_NOTES` (`version` 'YYYY.MM.DD' ou 'YYYY.MM.DD.n', decrescente).
- Produz: nota de versão do Lote B.

**Contexto vinculado:**
- Spec B6: nota explicando a tela de permissões e que nada mudou para quem já usava.
- `frontend/CLAUDE.md`: texto pt-BR para o operador; `where` só quando há tela para linkar (aqui `/configuracoes`, que só o ADMIN abre; `release-notes-dialog.tsx` já filtra por `canAccessPath`); entrada nova no topo; versão maior que a do Lote A.
- Texto sugerido: título "Permissões por ação"; corpo "O administrador agora define, em Configurações → Permissões, o que Supervisor e Operador podem fazer: cadastrar pessoas, inativar, alterar a escala, manter setores, ver o telefone completo, enviar WhatsApp à equipe, enviar a todos os setores de uma vez e consultar o histórico das pessoas. Nada mudou para quem já usava o sistema: cada um continua podendo fazer o mesmo que antes."

**Passos:**
1. [ ] Adicionar a entrada; `timeout 600 gate --test src/release-notes.spec.ts`; `timeout 600 gate --changed --base feat/cadastro-permissoes`.

**Aceite:** spec B6.

**Risco: baixo**

## Fechamento (principal)

1. Conferir o ledger: T1 a T19 aceitas (com T3a e T3b), revisões críticas com `opus` feitas.
2. Gate completo do back e do front, uma vez cada, no estado final, comparado com a base registrada (memória: `--base origin/main` para o completo; dívida legada conhecida; comparar com a base e bloquear violação nova ou agravada).
3. `route-parity.spec.ts` e os testes "matriz inicial" de T4, T6, T7, T8, T9, T14, T15, T17 verdes no estado integrado (aceite 10).
4. Migração numa cópia com dados na stack local de QA (`orgamind-turnos-qa`, seed fictício Marina/Rafael): `prisma migrate deploy`; conferir 16 linhas em `role_permissions` iguais a `DEFAULT_MATRIX`, nenhuma outra tabela alterada, contagem de usuários e eventos da trilha igual.
5. Boot real da API e do worker na stack local; login dos quatro papéis devolve `permissions`; `GET /auth/me` responde.
6. QA visual (agente `qa`, Playwright): menu dos quatro papéis igual ao de antes; Configurações → Permissões (colunas travadas, confirmação, Restaurar padrão); tirar `escala.alterar` do OPERATOR e ver o 403 dele na alteração seguinte sem novo login (aceite 11); tirar `telefone.ver_completo` e ver `•••• 1234` nas três listas, com "Sem telefone" certo (aceite 13); tirar `equipe.disparo_amplo` e ver o texto da recusa (aceite 14); trilha mostra a alteração da matriz só para o ADMIN (aceite 16); nota em Novidades.
7. Commit do lote só com pedido do usuário.

## Não verificado

- Produção: se existe OPERATOR gestor de todos os setores ativos (a matriz inicial o mantém enviando; a GBR pode tirar).
- DB20 (gestor do setor só pelo ADMIN, mesmo com `estrutura.manter`) é decisão provisória do controlador; a GBR confirma. Com a matriz inicial não muda nada, porque só o ADMIN tem a chave.
- Se a paleta de comandos tem outro filtro além de `navItemsForRole`.
- Onde ficam exatamente os botões de escrita de pessoas da página do setor (`setores/$sectorId.tsx` ou `features/sector-people/`): T15 e T16 dividem por arquivo.
- Latência do menu depois de uma mudança na matriz (até a próxima releitura de `/auth/me`, DB14); a API vale na requisição seguinte.

## Estado (19/11/2026)

Lote implementado e validado no branch `feat/permissoes-por-acao` (sobre `feat/cadastro-permissoes`, PR 13). Sem merge e sem deploy.

**Feito além do plano (decisões registradas na spec, "Para a GBR confirmar"):**
- Task 20a/20b e fixes da Task 6: o nome que é o próprio telefone (pessoa criada de contato sem nome) sai mascarado para quem não tem `telefone.ver_completo` em setor, envio, escala, trilha e nas rotas de membros do setor; listas ordenadas pelo nome exibido com desempate por id; busca por dígitos não procura no nome.
- Conflito de gravação da matriz responde 409 `permissions.conflict`.
- `frontend/src/lib/api-client.ts`: as regras de `/auth/*` passam a valer com a API sob prefixo (`VITE_API_URL=/api`, produção).
- Diálogo de edição da pessoa: nome mascarado abre o campo vazio; texto de ajuda da Escala sem a frase de edição para quem não pode alterar.

**Validação:**
- Revisão independente por task (opus no back, sonnet no front), revisão final do conjunto e re-revisão dos fixes: sem Critical nem Important em aberto.
- Gate por diff contra `feat/cadastro-permissoes`: back PASS (1645/1645 com banco real, cobertura 99,6% das linhas novas); front PASS (1580/1580, 98,6%).
- Gate completo comparado com a base do Lote A: nenhuma violação nova ou agravada (números no ledger).
- Migração `20261119100000_role_permissions` aplicada no banco local de QA: 16 linhas iguais ao padrão; pessoas e trilha sem alteração.
- Boot real, fumaça HTTP dos quatro papéis e QA visual local (Supervisor sem duas permissões; Administrador na tela de Permissões): comportamento conforme.

**Pendências e limitações (backlog):**
- Telas legadas de Contatos e Inbox mostram o telefone completo ao Operador mesmo sem a permissão (fora do escopo; decisão da GBR).
- Nome do gestor do setor (`manager.name`) não passa pela máscara: só importa se uma pessoa com o número como nome receber login e virar gestora sem ser renomeada.
- Listas cortadas no banco pelo nome real: candidatos (20), contatos (30), destinatários de um envio (paginação), quadro da escala (500).
- O disparo amplo é conferido só na criação do envio.
- 401 em `auth/change-password` com token vencido pede recarregar a página.
- Minors das revisões por task estão no ledger (`.superpowers/sdd/2026-11-19-orgamind-gbr-etapa1-lote-b-permissoes/progress.md`).
- Antes de qualquer deploy: publicar back e front juntos (contratos estritos) e a migração junto com o código.

**Próximo:** Lote C (vínculo com vigência, CAD-02), em branch novo a partir deste.
