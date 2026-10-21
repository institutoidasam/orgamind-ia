# WhatsApp da equipe — turno fixo no cadastro e envio por setor e turno (21/10) Implementation Plan

> **For agentic workers:** executar pela skill `sdd` (TDD, ledger em `.superpowers/sdd/2026-10-21-orgamind-team-whatsapp-turnos/progress.md`). **Sem commit/push**: nenhuma task commita; a principal integra e só commita/publica com pedido explícito do usuário.

**Goal:** o usuário ganha um turno fixo (`FIRST`/`SECOND`/sem turno) no cadastro; a tela "WhatsApp da equipe" passa a enviar por setor + turno, para todos do turno ou só para os marcados, conferindo os nomes antes; o histórico guarda o filtro usado, o turno de cada destinatário e mostra todos os destinatários.

**Architecture:** uma migração aditiva (enum `WorkShift` + três colunas nulas). Back: `users` aceita/devolve `shift`; `team-whatsapp` aceita `shift?`/`userIds?` no alvo setor, refaz o filtro no servidor no POST (helper puro `team-whatsapp.selection.ts`), grava snapshot de turno no envio e no destinatário e troca `issues` por `recipients` na listagem. Front: espelha os contratos à mão (`features/*/schemas.ts`), ganha `ShiftSelect` e coluna Turno em Usuários e troca os cards por setor por seletores Setor/Turno + lista com seleção.

**Tech Stack:** NestJS + Prisma + Zod (nestjs-zod) + BullMQ + Vitest/testcontainers (backend); React + TanStack Router/Query + Radix Select/Checkbox + sonner + Vitest/Testing Library (frontend).

**Spec:** `docs/superpowers/specs/2026-10-21-orgamind-team-whatsapp-turnos.md` (fonte da verdade). Mapas: `.superpowers/sdd/2026-10-21-orgamind-team-whatsapp-turnos/mapa-backend.md` e `mapa-frontend.md`. Baseline: `a68a532`.

## Ordem e paralelismo

```
T1 (back users + migração) ──┬──> T2 (back team-whatsapp) ──┐
                             └──> T3 (front users + lib/work-shift) ──┴──> T4 (front contrato + histórico) ──> T5 (front fluxo de envio + Novidades)
```

- T2 e T3 rodam em paralelo depois de T1 (ownership disjunto: `backend/src/modules/team-whatsapp/**` + `team-whatsapp.schema.ts` vs `frontend/src/features/users/**`, `frontend/src/lib/work-shift.ts`, `frontend/src/routes/_authenticated/users/**`).
- T4 depende de T2 (contrato) e de T3 (`frontend/src/lib/work-shift.ts`). T5 depende de T4 (`schemas.ts`, `error-messages.ts`).
- Divergência da sugestão do despacho: o front do WhatsApp da equipe foi dividido em T4 + T5 (estimativa > 80 chamadas numa task só). O corte é por compilação: T4 muda só o que não quebra `SendTarget`/`team-sector-card.tsx`; T5 troca `SendTarget`, o diálogo e a página juntos, porque o card antigo deixa de compilar com o `SendTarget` novo.
- Risco/modelo: T1 e T2 são críticas (revisão com `opus`, conforme a SKILL.md do sdd). T3 e T5 são não críticas de número ímpar (A/B de effort: despachar com `effort: high`).

## Global Constraints

- **GC1 — Gate.** Iteração: `timeout 600 gate --test <arquivo>`. Fechamento da task: `timeout 600 gate --changed --base origin/main`. Sempre com cwd `backend/` ou `frontend/`, conforme o lado. Suíte inteira, gate completo, cobertura total e e2e ficam com a principal, no fim, comparados à baseline `a68a532`. Nunca os rode dentro de uma task.
- **GC2 — Banco.** Nunca rodar `prisma migrate reset`. Nunca rodar `migrate dev`/`migrate deploy`/`db push` contra banco que não seja o do testcontainers ou outro Postgres descartável de teste. `bun run prisma generate` (sem banco) é livre.
- **GC3 — Migração única e aditiva.** Uma só migração, `backend/prisma/migrations/20261021090000_work_shift/migration.sql`, criada na T1: `enum WorkShift { FIRST SECOND }`, colunas `User.shift`, `TeamWhatsappDispatch.shift` e `TeamWhatsappRecipient.shift`, todas `WorkShift?` (nullable), sem default e sem backfill. Nenhuma outra task cria migração nem mexe em `schema.prisma`.
- **GC4 — Rótulos pt-BR exatos.** Turno: `1º turno`, `2º turno`, `Sem turno`. Seletor de turno da tela: `1º turno`, `2º turno`, `Todos os turnos`. `targetLabel` gravado: `Produção · 2º turno`, `Produção · todos os turnos`, `Produção · 2º turno · seleção de 2`, com separador ` · ` (espaço, ponto médio U+00B7, espaço). Textos da tela: `Escolha o setor e o turno`, `N pessoa(s) deste setor estão sem turno definido — defina em Usuários`, `Marcar todos`, `Enviar para todos do turno (N)`, `Enviar para selecionados (M)`, `Ficam de fora (sem telefone)`, `Ver destinatários`, e para `team_whatsapp.invalid_selection` o texto `A lista de pessoas mudou. Atualize a página e confira de novo.`
- **GC5 — Telefone.** Telefone nunca vai para log nem auditoria. A listagem de envios (`recipients`) não traz telefone. O snapshot do destinatário grava `shift`, nunca telefone; o processor continua relendo o telefone do usuário.
- **GC6 — Política inalterada.** O ADMIN alcança qualquer setor ativo e o gestor, só os setores que gerencia (`managedSectorIds`), via `canSendToSector`. Setor fora da política devolve o 403 `team_whatsapp.forbidden` de hoje, que vem ANTES de qualquer checagem de seleção; `userIds` não abre caminho para outro setor. Canal, texto (1 a 2000 caracteres), supressão, pacing, fila e códigos de erro atuais não mudam.
- **GC7 — Filtro no servidor.** No POST o servidor recarrega o setor com os membros ativos atuais e aplica `shift` e `userIds` sobre esses dados. Se algum id de `userIds` estiver fora do setor ou do turno, inativo ou inexistente, a resposta é 422 `team_whatsapp.invalid_selection` e nada é criado: nem `createDispatch`, nem job na fila, nem auditoria. Ids repetidos contam uma vez. Sem `shift`, vale "todos os turnos", inclusive quem está sem turno.
- **GC8 — Contratos espelhados.** O front espelha o back à mão, sem SDK. O back é a fonte: T1 define `workShiftSchema` e `userSummarySchema.shift`; T2 define os shapes de `team-whatsapp.schema.ts` e do DTO. T3 e T4 copiam os mesmos campos e tipos. Front e back sobem juntos (não há outro consumidor), então `issues` sai sem período de compatibilidade.
- **GC9 — Testes enxutos.** Um teste por critério de aceite mais os 5 riscos da spec (Review Focus), sem duplicar cobertura entre unit e integração. Backend: Vitest unit com `team-whatsapp.test-fixtures.ts` (`member()`, `sector()`, `createHarness()`) e `vitest-mock-extended`; integração do repository com testcontainers só onde o select ou a gravação mudam. Frontend: Vitest + Testing Library + user-event, com `vi.mock` dos hooks de `api.ts` e sem msw. `describe` ≤ 50 linhas por callback; o `gate --changed` não detecta, o gate completo sim. Casos novos vão em `describe` novos em vez de crescer os existentes.
- **GC10 — Novidades.** Mudança visível ao operador ganha entrada no TOPO de `RELEASE_NOTES` (`frontend/src/release-notes.ts`), com texto pt-BR para o operador e `where` só quando há tela para linkar. Só a T5 mexe nesse arquivo, com uma entrada que cobre T3, T4 e T5.
- **GC11 — Sem extras.** Sem dependência nova, sem rota nova, sem componente UI novo em `components/ui/` (radio/toggle não existem; usar `select`/`checkbox`). Sem commit/push.

## Contratos compartilhados (fonte: back; o front espelha)

- **C1 — Turno.** `workShiftSchema = z.enum(['FIRST', 'SECOND'])`, com `WorkShift = 'FIRST' | 'SECOND'`. `null` = sem turno. Back: exportado de `backend/src/schemas/contracts/user.schema.ts` (T1). Front: `frontend/src/lib/work-shift.ts` (T3).
- **C2 — Usuários.** `POST /users` aceita `shift?: 'FIRST' | 'SECOND' | null` (ausente = `null`). `PATCH /users/:id` aceita `shift?: 'FIRST' | 'SECOND' | null`: ausente mantém, `null` limpa, e `{ shift }` sozinho é um PATCH válido. Em `GET /users` (e nos retornos de create/update que usam `userSummarySchema`), cada item tem `shift: 'FIRST' | 'SECOND' | null`. Mudar o turno não é mudança de identidade: não revoga sessões.
- **C3 — Alvos.** Em `GET /internal/team-whatsapp/targets`, `sectors[].members[]` ganha `shift: WorkShift | null`. O resto não muda (`id, name, email, phoneE164, isActive`).
- **C4 — POST de envio.** `POST /internal/team-whatsapp/dispatches`, com `target`:
  - `{ type: 'user', userId: string }`, igual a hoje;
  - `{ type: 'sector', sectorId: string, shift?: 'FIRST' | 'SECOND', userIds?: string[] }`, com `userIds` de 1 a 500 itens, cada um com `min(1)`.
  - Erro novo: 422 `{ code: 'team_whatsapp.invalid_selection' }`. A resposta de sucesso não muda: `{ dispatchId, queued, skipped: [{ userId, name, reason }] }`.
- **C5 — Lista de envios.** Em `GET /internal/team-whatsapp/dispatches`, cada item:
  - `target: { type: 'user' | 'sector', id: string, label: string, shift: WorkShift | null }`;
  - `recipients: { userId: string | null, name: string, shift: WorkShift | null, status: 'QUEUED' | 'SENT' | 'FAILED' | 'SKIPPED', reason: string | null }[]`, NO LUGAR de `issues`.
  - `reason` é o `errorCode` quando FAILED e o `skipReason` (`'NO_PHONE' | 'SUPPRESSED'`) quando SKIPPED; QUEUED e SENT têm `null`. Ordem por `name` asc (`localeCompare(…, 'pt-BR')`). `userId` é nulo quando o usuário foi apagado (FK `SetNull`).
- **C6 — Snapshot gravado.** `TeamWhatsappDispatch.shift` = o `shift` do alvo setor, ou `null` para "todos os turnos" e para o alvo pessoa. `TeamWhatsappRecipient.shift` = o `User.shift` do destinatário no momento do POST.

## Review Focus

1. **R1 — `userIds` fora do alcance.** Id de outro setor, de outro turno, inativo ou inexistente dá 422 `invalid_selection` e nada é criado. Gestor que manda `userIds` para um setor que não gerencia recebe o 403 de hoje. Fixado em T2, `team-whatsapp.service.shift.spec.ts`: `it.each` "seleção inválida → 422 sem efeito" e "gestor fora da política com userIds → 403".
2. **R2 — Turno mudou entre a tela e o POST.** O servidor usa o turno atual e devolve 422 sem envio parcial. Fixado em T2, mesmo arquivo: "seleção feita no 2º turno, João agora no 1º → 422, nenhum destinatário criado".
3. **R3 — "Todos os turnos" inclui quem está sem turno; 1º/2º não incluem.** Fixado em T2 (`it.each` "filtro de turno") e, na tela, em T5 (`index.spec.tsx` "Todos os turnos lista quem está sem turno").
4. **R4 — Selecionado sem telefone ou suprimido, pela API, e ids repetidos.** Sem telefone e suprimido são pulados com o motivo; um id repetido gera um destinatário só. Fixado em T2: "seleção com sem telefone, suprimido e id repetido".
5. **R5 — PATCH sem `shift` mantém e `null` apaga.** Fixado em T1, `users.service.shift.spec.ts`: "PATCH sem shift não envia shift ao repositório" e "PATCH shift null limpa e não revoga sessão". A gravação real fica em `users.repository.integration.spec.ts` ("shift grava, lê e limpa").

## Riscos aceitos

- **M6 — Lista de envios pesada.** `GET /internal/team-whatsapp/dispatches` traz todos os destinatários de cada envio, até 20 envios × 500 destinatários, e a lista é repetida no polling enquanto houver `queued`. Aceitável para setores pequenos; revisar (paginar ou carregar sob demanda) se o cliente tiver setores grandes.
- **M7 — Seleção fora de transação.** A seleção (`selectMembers`) e o `createDispatch` não rodam na mesma transação; há uma janela de milissegundos em que o turno pode mudar entre as duas (R2). Aceitável pela spec: o 422 cobre a mudança anterior ao POST, e a janela residual não envia para quem está fora do setor.

---

### Task 1: back — turno no usuário + migração

**Crítico: contrato público/arquitetura** — cria o enum `WorkShift` e a migração aditiva das três colunas e muda `POST/PATCH/GET /users` (`user.schema.ts`), contrato que o front consome.

**Files:**
- Modify: `backend/prisma/schema.prisma` (enum `WorkShift`; `shift` em `User`, `TeamWhatsappDispatch` e `TeamWhatsappRecipient`)
- Create: `backend/prisma/migrations/20261021090000_work_shift/migration.sql`
- Modify: `backend/src/schemas/contracts/user.schema.ts`
- Modify: `backend/src/modules/users/dto/create-user.dto.ts` e `dto/update-user.dto.ts`
- Modify: `backend/src/modules/users/users.service.ts` (`UserPatch`, `CreateUserInput`, `toUserSummary`, `createInvitation`, `toUpdateData`)
- Modify: `backend/src/modules/users/users.repository.ts` (`USER_SUMMARY_SELECT`)
- Create: `backend/src/modules/users/users.service.shift.spec.ts`
- Modify (teste): `backend/src/modules/users/users.repository.integration.spec.ts`
- Modify (só fixtures, se o `tsc` acusar): specs/fixtures que montam `UserSummary` à mão

**Interfaces (Produces):**
- `export const workShiftSchema = z.enum(['FIRST', 'SECOND']);` e `export type WorkShift = z.infer<typeof workShiftSchema>;` em `user.schema.ts`. A T2 importa daqui; não criar um segundo enum zod.
- `userSummarySchema`: `+ shift: workShiftSchema.nullable()`, logo depois de `phoneE164`.
- `createUserSchema`: `+ shift: workShiftSchema.nullable().optional()`.
- `updateUserSchema`: `+ shift: workShiftSchema.nullable().optional()`. O `refine` passa a aceitar `d.shift !== undefined`, com a mensagem `'At least one of name, role, sectorId, isActive, phone or shift must be provided'`.
- `UserPatch.shift?: WorkShift | null` e `CreateUserInput.shift?: WorkShift | null`. `WorkShift` vem de `@prisma/client`, que tem os mesmos literais.
- Prisma: `User.shift WorkShift?`, `TeamWhatsappDispatch.shift WorkShift?`, `TeamWhatsappRecipient.shift WorkShift?`. A T2 só consome os tipos gerados.

**Contexto vinculado:**
- Spec §1: o enum novo `WorkShift { FIRST, SECOND }` cria a coluna `User.shift WorkShift?`. Nulo = "sem turno", e todos os usuários existentes começam assim.
- Spec §Contratos: `POST /users` e `PATCH /users/:id` aceitam `shift?: 'FIRST' | 'SECOND' | null`. No PATCH, campo ausente mantém e `null` limpa. Em `GET /users`, cada item ganha `shift`. O contrato `user.schema.ts` e o schema do front mudam juntos.
- GC2: nunca `prisma migrate reset`; migrar só contra o testcontainers ou outro Postgres descartável de teste. `prisma generate` é livre.
- GC3: uma só migração, `20261021090000_work_shift`, com o enum `WorkShift { FIRST SECOND }` e as colunas `User.shift`, `TeamWhatsappDispatch.shift` e `TeamWhatsappRecipient.shift`, todas nullable, sem default e sem backfill.
- GC5: telefone nunca em log nem auditoria. A auditoria de `updateUser` não ganha campo de telefone.
- C2: mudar o turno não é mudança de identidade, então não revoga sessões. `changesIdentity` continua olhando só `role`/`sectorId`/`isActive`.
- R5: PATCH sem `shift` não apaga o turno; `null` apaga.
- GC1: `timeout 600 gate --test <arquivo>` na iteração; `timeout 600 gate --changed --base origin/main` no fechamento; cwd `backend/`.
- GC9: um teste por critério de aceite ou risco, sem duplicar unit e integração.

- [ ] **Step 1: schema Prisma + migração** (sem banco)

`schema.prisma`, junto dos enums de team-whatsapp (por volta da L1559) ou perto de `model User`:

```prisma
// Turno fixo do usuário. null = sem turno (todos os usuários anteriores ao campo).
enum WorkShift {
  FIRST
  SECOND
}
```

- `model User` (L44), perto de `sectorId`: `shift WorkShift?`
- `model TeamWhatsappDispatch` (L1576), depois de `targetLabel`: `// Filtro de turno usado; null = todos os turnos ou alvo pessoa.` + `shift WorkShift?`
- `model TeamWhatsappRecipient` (L1594), depois de `userName`: `// Turno do destinatário no momento do envio (quem estava escalado).` + `shift WorkShift?`

`backend/prisma/migrations/20261021090000_work_shift/migration.sql`, no formato que o Prisma gera (tabelas sem `@@map`, como em `20261016090000_user_phone_contact`):

```sql
-- CreateEnum
CREATE TYPE "WorkShift" AS ENUM ('FIRST', 'SECOND');

-- AlterTable
ALTER TABLE "TeamWhatsappDispatch" ADD COLUMN     "shift" "WorkShift";

-- AlterTable
ALTER TABLE "TeamWhatsappRecipient" ADD COLUMN     "shift" "WorkShift";

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "shift" "WorkShift";
```

Rodar `bun run prisma generate` (cwd `backend/`). Conferir drift, igual ao job `migration-drift` do CI (`.github/workflows/ci.yml:136`): `npx prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --shadow-database-url "<Postgres descartável>" --exit-code` → exit 0. *A confirmar pelo implementador:* se não houver Postgres descartável fora do testcontainers, pular esse comando, registrar a lacuna no relatório e deixar a verificação para o CI. O integration spec do Step 2 aplica a migração no container e já prova que o SQL roda.

- [ ] **Step 2: testes RED**

`users.service.shift.spec.ts`. Copiar o setup de `users.service.phone.spec.ts`: dublês de `UsersRepository`, `AuditService`, `RefreshService` e `UserPhoneService`, o serviço `svc`, o helper `user(phone)` (usuário PARCIAL, com cast) e a função `invite()`.

```ts
describe('UsersService — turno', () => {
  // user(phone) é parcial (com cast): aqui só acrescenta o turno.
  const withShift = (shift: 'FIRST' | 'SECOND' | null) => ({ ...user(null), shift }) as never;

  it('cadastro grava o turno informado e null quando ausente', async () => {
    await svc.createUser({ ...invite(), shift: 'SECOND' }, 'admin');
    expect(repo.create.mock.calls[0][0]).toMatchObject({ shift: 'SECOND' });
    await svc.createUser({ ...invite(), email: 'b@idasam.org' }, 'admin');
    expect(repo.create.mock.calls[1][0]).toMatchObject({ shift: null });
  });

  it('PATCH sem shift não envia shift ao repositório (R5)', async () => {
    repo.findById.mockResolvedValue(withShift('FIRST'));
    await svc.updateUser('u1', { name: 'Ana' }, 'admin');
    expect(repo.updateWithLastAdminGuard.mock.calls[0][1]).not.toHaveProperty('shift');
  });

  it('PATCH shift null limpa e não revoga sessão (R5)', async () => {
    repo.findById.mockResolvedValue(withShift('FIRST'));
    await svc.updateUser('u1', { shift: null }, 'admin');
    expect(repo.updateWithLastAdminGuard.mock.calls[0][1]).toMatchObject({ shift: null });
    expect(refresh.revokeAllForUser).not.toHaveBeenCalled();
  });

  it('listUsers devolve shift e passa no contrato', async () => {
    // Contrato (parse) exige usuário COMPLETO: usar um fixture completo, não o user() parcial.
    repo.findMany.mockResolvedValue({ data: [fullUser({ shift: null })], total: 1 });
    const res = await svc.listUsers(1, 20);
    expect(res.data[0].shift).toBeNull();
    expect(() => userListResponseSchema.parse(serialize(res))).not.toThrow();
  });

  it.each([
    [{ shift: null }, true],
    [{ shift: 'THIRD' }, false],
  ])('updateUserSchema %o → válido=%s', (body, ok) => {
    expect(updateUserSchema.safeParse(body).success).toBe(ok);
  });
});
```

O teste de contrato (`userListResponseSchema.parse`) precisa de um fixture COMPLETO de usuário (`fullUser`: todos os campos do `userSummarySchema`, com `Date` onde o schema pede), não do `user()` parcial do spec de telefone, que não passa no parse. `serialize` converte Date → ISO como o controller faz. Se `users.service.phone.spec.ts` já valida o contrato de outra forma, reusar. *A confirmar pelo implementador:* se `updateWithLastAdminGuard` recebe `data` em outra posição, ajustar o índice.

`users.repository.integration.spec.ts`, um teste: "shift grava, lê e limpa". Criar usuário com `shift: 'SECOND'` → `findById(...).shift === 'SECOND'`; usuário criado sem shift → `null`; `updateWithLastAdminGuard(id, { shift: null })` → `findById(...).shift === null`.

- [ ] **Step 3:** `timeout 600 gate --test src/modules/users/users.service.shift.spec.ts` e `timeout 600 gate --test src/modules/users/users.repository.integration.spec.ts` → FAIL pelos campos ausentes.

- [ ] **Step 4: implementar**

`user.schema.ts`:

```ts
export const workShiftSchema = z.enum(['FIRST', 'SECOND']);
export type WorkShift = z.infer<typeof workShiftSchema>;
// ... em userSummarySchema, depois de phoneE164:
  // Turno fixo; null = sem turno (usuários anteriores ao campo).
  shift: workShiftSchema.nullable(),
```

- `create-user.dto.ts`: `shift: workShiftSchema.nullable().optional(),`, importando de `../../../schemas/contracts/user.schema` (*a confirmar:* o caminho relativo/alias usado pelos outros imports de contrato).
- `update-user.dto.ts`: `shift: workShiftSchema.nullable().optional(),`, com `|| d.shift !== undefined` no `refine` e a mensagem de C2.
- `users.repository.ts`: `shift: true` em `USER_SUMMARY_SELECT`.
- `users.service.ts`:
  - `UserPatch` e `CreateUserInput` ganham `shift?: WorkShift | null`;
  - `toUserSummary` ganha `shift: u.shift`;
  - `createInvitation` ganha `shift: input.shift ?? null`;
  - `toUpdateData` ganha `...(input.shift !== undefined ? { shift: input.shift } : {})`;
  - `changesIdentity` não muda.

Se o `tsc` acusar fixtures de `UserSummary` em outros specs (auth, sectors…), acrescentar `shift: null` só nelas.

- [ ] **Step 5:** os dois comandos do Step 3 → PASS. Specs vizinhos verdes: `timeout 600 gate --test src/modules/users/users.service.phone.spec.ts`; e o spec do controller de users, se existir, para o `refine`.
- [ ] **Step 6:** `timeout 600 gate --changed --base origin/main` (cwd `backend/`) → PASS.

---

### Task 2: back — envio por setor e turno, snapshots e lista de destinatários

Depende da T1 (enum `WorkShift`, colunas e `workShiftSchema`).

**Crítico: autorização/filtro de quem recebe + contrato público** — o POST passa a escolher os destinatários por `shift`/`userIds` vindos do cliente (filtro refeito no servidor, 422 sem efeito para seleção fora do setor/turno), e `targets`/`dispatches` mudam de shape para o front.

**Files:**
- Modify: `backend/src/modules/team-whatsapp/dto/create-team-dispatch.dto.ts`
- Create: `backend/src/modules/team-whatsapp/dto/create-team-dispatch.dto.spec.ts` (*a confirmar:* se já existir spec do DTO, acrescentar lá)
- Modify: `backend/src/modules/team-whatsapp/team-whatsapp.errors.ts` (`invalidSelection`)
- Create: `backend/src/modules/team-whatsapp/team-whatsapp.selection.ts` (helpers puros)
- Modify: `backend/src/modules/team-whatsapp/team-whatsapp.repository.ts`
- Modify: `backend/src/modules/team-whatsapp/team-whatsapp.service.ts`
- Modify: `backend/src/schemas/contracts/team-whatsapp.schema.ts`
- Modify: `backend/src/modules/team-whatsapp/team-whatsapp.test-fixtures.ts` (`member()` com `shift: null`; harness com `listRecipients`)
- Create: `backend/src/modules/team-whatsapp/team-whatsapp.service.shift.spec.ts`
- Modify: `backend/src/modules/team-whatsapp/team-whatsapp.service.list.spec.ts` (trocar os testes de `issues` pelos de `recipients`)
- Modify (teste): `backend/src/modules/team-whatsapp/team-whatsapp.repository.integration.spec.ts`
- Modify (só se o `tsc` acusar): `team-whatsapp.service.spec.ts`, `team-whatsapp.controller.spec.ts` e o processor spec (fixtures)

**Interfaces (Produces):**
- DTO (C4):

```ts
import { workShiftSchema } from '../../../schemas/contracts/user.schema';
// ...
z.object({
  type: z.literal('sector'),
  sectorId: z.string().min(1),
  // Ausente = todos os turnos (inclui quem está sem turno).
  shift: workShiftSchema.optional(),
  // Seleção manual: só estes recebem; o servidor revalida contra setor/turno atuais.
  userIds: z.array(z.string().min(1)).min(1).max(500).optional(),
}),
```

- `invalidSelection(): DomainError` → `{ code: 'team_whatsapp.invalid_selection', message: 'Seleção de destinatários inválida', status: 422 }`.
- `team-whatsapp.selection.ts`:

```ts
import type { WorkShift } from '@prisma/client';

export const SHIFT_LABEL: Record<WorkShift, string> = { FIRST: '1º turno', SECOND: '2º turno' };

/**
 * Filtro do alvo setor sobre os membros ATIVOS atuais. `null` = seleção inválida
 * (algum id fora do setor/turno, inativo ou inexistente). Ids repetidos contam uma vez.
 */
export function selectMembers<M extends { id: string; shift: WorkShift | null }>(
  members: readonly M[],
  shift: WorkShift | undefined,
  userIds: readonly string[] | undefined,
): M[] | null {
  const inShift = shift ? members.filter((m) => m.shift === shift) : [...members];
  if (!userIds) return inShift;
  const wanted = new Set(userIds);
  const picked = inShift.filter((m) => wanted.has(m.id));
  return picked.length === wanted.size ? picked : null;
}

/** "Produção · 2º turno", "Produção · todos os turnos", "… · seleção de 2". */
export function sectorTargetLabel(
  sectorName: string,
  shift: WorkShift | null,
  selectedCount: number | null,
): string {
  const parts = [sectorName, shift ? SHIFT_LABEL[shift] : 'todos os turnos'];
  if (selectedCount !== null) parts.push(`seleção de ${selectedCount}`);
  return parts.join(' · ');
}
```

- Repository:
  - `teamMemberSelect` ganha `shift: true`, e com isso `TeamMember.shift: WorkShift | null`;
  - em `listSectors`, o select de `members` ganha `shift: true`;
  - `dispatchListSelect` ganha `shift: true`;
  - `NewTeamRecipient` ganha `shift: WorkShift | null`, e `NewTeamDispatch` também;
  - `createDispatch` não muda de corpo, porque o spread já leva `shift` e o `recipients.create` leva o `shift` de cada um;
  - **`listIssues` sai** e entra `listRecipients(dispatchIds: readonly string[]): Promise<TeamRecipientRow[]>`. A lista vazia devolve `[]` sem consulta, e a consulta é `where: { dispatchId: { in } }` com select `{ dispatchId, userId, userName, shift, status, errorCode, skipReason }`;
  - `TeamRecipientRow = { dispatchId: string; userId: string | null; userName: string; shift: WorkShift | null; status: TeamWhatsappRecipientStatus; errorCode: string | null; skipReason: TeamWhatsappSkipReason | null }`.
- Contrato `team-whatsapp.schema.ts`:
  - `import { workShiftSchema } from './user.schema'`;
  - `export const teamRecipientStatusSchema = z.enum(['QUEUED', 'SENT', 'FAILED', 'SKIPPED'])`;
  - nos membros de `teamTargetsResponseSchema`, `.extend({ phoneE164, isActive, shift: workShiftSchema.nullable() })`;
  - `teamDispatchListResponseSchema.items[]`:
    - `target` ganha `shift: workShiftSchema.nullable()`;
    - `issues` sai e entra `recipients: z.object({ userId: z.string().nullable(), name: z.string(), shift: workShiftSchema.nullable(), status: teamRecipientStatusSchema, reason: z.string().nullable() }).array()`;
  - remover `teamIssueStatusSchema` se ficar sem uso.
- Service:
  - `ResolvedTarget` ganha `shift: WorkShift | null`;
  - `resolveSector(actor, target: Extract<CreateTeamDispatchInput['target'], { type: 'sector' }>)`;
  - `classify` grava `shift: m.shift` em cada destinatário;
  - `listDispatches` usa `listRecipients` e monta `recipients` conforme C5;
  - `toListItem` ganha `target.shift = row.shift`.

**Contexto vinculado:**
- Spec §2: o alvo setor aceita `shift?` e `userIds?`. Com `shift`, vão só os membros desse turno; sem `shift`, todos, inclusive quem está sem turno. Com `userIds`, recebem APENAS esses, que precisam ser membros ativos do setor e estar no turno filtrado. Ids repetidos contam uma vez. Id fora, inativo ou inexistente dá 422 `team_whatsapp.invalid_selection` e nada é criado. Sem `shift` e sem `userIds`, os destinatários são os de hoje.
- Spec §2: o alvo pessoa continua igual (usado pelo "Enviar WhatsApp" da tela Usuários).
- Spec §3: `TeamWhatsappDispatch.shift` guarda o filtro usado, com nulo para "todos os turnos" e para o alvo pessoa. `TeamWhatsappRecipient.shift` guarda o turno do destinatário no momento do envio. O `targetLabel` inclui o turno e a seleção. A listagem traz todos os destinatários (nome, turno, situação) e nenhum telefone.
- GC6: política inalterada. ADMIN alcança qualquer setor ativo; gestor, só `managedSectorIds` (`canSendToSector`). O 403 `team_whatsapp.forbidden` vem ANTES de qualquer checagem de seleção, e `userIds` não abre caminho para outro setor. Canal, texto, supressão, pacing, fila e códigos de erro atuais não mudam.
- GC7: no POST, o servidor recarrega o setor com os membros ativos atuais e aplica `shift`/`userIds`. Seleção inválida dá 422 `invalid_selection` sem `createDispatch`, sem job e sem auditoria. Sem `shift`, entra quem está sem turno.
- GC5: sem telefone em log, em auditoria ou em `recipients`. O snapshot grava `shift`, nunca telefone.
- GC4: `targetLabel` exatamente `Produção · 2º turno` / `Produção · todos os turnos` / `Produção · 2º turno · seleção de 2`, com separador ` · `.
- Decisão do plano D1: o alvo setor SEMPRE grava o rótulo com a parte do turno. Sem `shift`, o rótulo é `Produção · todos os turnos`. Envios antigos ficam com `Produção`. A spec diz que "o comportamento é o de hoje" sem filtros, e isso se refere a quem recebe; os exemplos de rótulo pedem a parte do turno.
- Decisão do plano D2: a seleção vem no rótulo como `seleção de N`, com N = destinatários depois de deduplicar (`wanted.size`).
- C4/C5/C6: ver "Contratos compartilhados" acima. Os shapes estão copiados nas Interfaces desta task.
- R1, R2, R3 e R4: ver Review Focus. Os testes ficam nesta task.
- GC2/GC3: esta task não cria migração nem mexe em `schema.prisma`. A integração usa testcontainers.
- GC1: `timeout 600 gate --test <arquivo>` na iteração; `timeout 600 gate --changed --base origin/main` no fechamento; cwd `backend/`.
- GC9: testes com `createHarness()`/`member()`/`sector()`; integração só para select/gravação novos.

- [ ] **Step 1: fixtures**

`member()` ganha `shift: null` no default. `createHarness()` troca `repo.listIssues.mockResolvedValue([])` por `repo.listRecipients.mockResolvedValue([])`. Isso compila só depois do Step 4: escrever junto com os testes e aceitar o RED de compilação.

- [ ] **Step 2: testes RED**

`team-whatsapp.service.shift.spec.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import {
  ADMIN, MANAGER, SUPPRESSED, createHarness, member, sector, type Harness,
} from './team-whatsapp.test-fixtures';

const ana = member({ id: 'ana', name: 'Ana', shift: 'FIRST' });
const joao = member({ id: 'joao', name: 'João', shift: 'SECOND' });
const maria = member({ id: 'maria', name: 'Maria', shift: 'SECOND' });
const pedro = member({ id: 'pedro', name: 'Pedro', shift: 'SECOND', phoneE164: null });
const ze = member({ id: 'ze', name: 'Zé', shift: null });
const producao = (members = [ana, joao, maria, pedro, ze]) =>
  sector({ id: 's1', name: 'Produção', members });

let h: Harness;
beforeEach(() => {
  h = createHarness();
  h.repo.findActor.mockResolvedValue(ADMIN);
  h.repo.findSectorWithActiveMembers.mockResolvedValue(producao());
});

type SectorExtra = { shift?: 'FIRST' | 'SECOND'; userIds?: string[] };
const send = (extra: SectorExtra, actorId = ADMIN.id) =>
  h.service.dispatch(actorId, {
    channelId: 'c1', text: 'Oi',
    target: { type: 'sector', sectorId: 's1', ...extra },
  });
const created = () => h.repo.createDispatch.mock.calls[0][0];
const names = () => created().recipients.map((r) => r.userName);
const expectNothingCreated = () => {
  expect(h.repo.createDispatch).not.toHaveBeenCalled();
  expect(h.queue.addBulk).not.toHaveBeenCalled();
  expect(h.audit.log).not.toHaveBeenCalled();
};

// Três describes (≤ 50 linhas cada): filtro e rótulo / seleção inválida R1+R2 / R4 + alvo pessoa.
describe('dispatch — setor e turno: filtro e rótulo', () => {
  it('seleção João e Maria no 2º turno cria só os dois, com snapshot e rótulo', async () => {
    await send({ shift: 'SECOND', userIds: ['joao', 'maria'] });
    expect(names()).toEqual(['João', 'Maria']);
    expect(created()).toMatchObject({
      shift: 'SECOND', targetLabel: 'Produção · 2º turno · seleção de 2',
    });
    expect(created().recipients.map((r) => r.shift)).toEqual(['SECOND', 'SECOND']);
  });

  it('todos do 2º turno: os do turno entram e quem não tem telefone é pulado', async () => {
    const res = await send({ shift: 'SECOND' });
    expect(names()).toEqual(['João', 'Maria', 'Pedro']);
    expect(created().targetLabel).toBe('Produção · 2º turno');
    expect(res.skipped).toEqual([{ userId: 'pedro', name: 'Pedro', reason: 'NO_PHONE' }]);
  });

  it.each([
    [undefined, ['Ana', 'João', 'Maria', 'Pedro', 'Zé'], 'Produção · todos os turnos', null],
    ['FIRST' as const, ['Ana'], 'Produção · 1º turno', 'FIRST'],
  ])('filtro de turno %s (R3: sem turno só entra em "todos")', async (shift, expected, label, snap) => {
    await send(shift ? { shift } : {});
    expect(names()).toEqual(expected);
    expect(created()).toMatchObject({ targetLabel: label, shift: snap });
  });
});

describe('dispatch — setor e turno: seleção inválida (R1, R2)', () => {
  it.each([
    ['de outro setor', ['joao', 'fora-do-setor']],
    ['de outro turno', ['joao', 'ana']],
    ['inexistente', ['nao-existe']],
    ['inativo', ['inativo']],
  ])('seleção inválida (%s) → 422 sem efeito (R1)', async (_caso, userIds) => {
    h.repo.findSectorWithActiveMembers.mockResolvedValue(
      producao([ana, joao, maria, member({ id: 'inativo', shift: 'SECOND', isActive: false })]),
    );
    await expect(send({ shift: 'SECOND', userIds })).rejects.toMatchObject({
      code: 'team_whatsapp.invalid_selection',
    });
    expectNothingCreated();
  });

  it('gestor fora da política com userIds → 403 (R1)', async () => {
    h.repo.findActor.mockResolvedValue(MANAGER); // gerencia só s1
    h.repo.findSectorWithActiveMembers.mockResolvedValue(
      sector({ id: 's2', name: 'Outro', members: [joao] }),
    );
    await expect(
      h.service.dispatch(MANAGER.id, {
        channelId: 'c1', text: 'Oi',
        target: { type: 'sector', sectorId: 's2', userIds: ['joao'] },
      }),
    ).rejects.toMatchObject({ code: 'team_whatsapp.forbidden' });
    expectNothingCreated();
  });

  it('turno mudou depois de carregar a tela → 422, nada parcial (R2)', async () => {
    h.repo.findSectorWithActiveMembers.mockResolvedValue(
      producao([member({ ...joao, shift: 'FIRST' }), maria]),
    );
    await expect(send({ shift: 'SECOND', userIds: ['joao', 'maria'] })).rejects.toMatchObject({
      code: 'team_whatsapp.invalid_selection',
    });
    expectNothingCreated();
  });
});

describe('dispatch — setor e turno: sem telefone, suprimido e alvo pessoa (R4)', () => {
  it('seleção com sem telefone, suprimido e id repetido (R4)', async () => {
    const bia = member({ id: 'bia', name: 'Bia', shift: 'SECOND', phoneE164: SUPPRESSED });
    h.repo.findSectorWithActiveMembers.mockResolvedValue(producao([joao, pedro, bia]));
    const res = await send({ shift: 'SECOND', userIds: ['joao', 'pedro', 'bia', 'joao'] });
    expect(created().recipients).toHaveLength(3);
    expect(created().targetLabel).toBe('Produção · 2º turno · seleção de 3');
    expect(h.queue.addBulk.mock.calls[0][0]).toHaveLength(1);
    expect(res.skipped.map((s) => s.reason).sort()).toEqual(['NO_PHONE', 'SUPPRESSED']);
  });

  it('alvo pessoa grava dispatch.shift null e o turno atual do destinatário', async () => {
    h.repo.findTargetUser.mockResolvedValue(joao);
    await h.service.dispatch(ADMIN.id, {
      channelId: 'c1', text: 'Oi', target: { type: 'user', userId: 'joao' },
    });
    expect(created()).toMatchObject({ shift: null });
    expect(created().recipients[0].shift).toBe('SECOND');
  });
});
```

*A confirmar pelo implementador:*
- o matcher do erro (`toMatchObject({ code })`) segue o que `team-whatsapp.service.spec.ts` usa para `noRecipients`/`teamForbidden`; se o `DomainError` expõe o código em outro campo, ajustar;
- o `MANAGER` é `OPERATOR` com `managedSectorIds: ['s1']`, e `canSendToSector` olha `sector.id`;
- a ordem `['Ana', 'João', …]` assume que o fixture já vem ordenado (o repo ordena por nome) e que o service preserva a ordem.

`dto/create-team-dispatch.dto.spec.ts`, um `it.each` sobre `createTeamDispatchSchema.safeParse` com o alvo setor:
- `userIds: []` → inválido;
- 501 ids → inválido;
- `shift: 'THIRD'` → inválido;
- `{ shift: 'FIRST', userIds: ['u1'] }` → válido;
- sem extras → válido.

`team-whatsapp.service.list.spec.ts`: substituir os testes de `issues` por um só, "lista todos os destinatários com turno e situação":
- `listRecipients` devolve, para `d1`, quatro linhas:
  - `{ userName: 'Caio', status: 'SKIPPED', skipReason: 'NO_PHONE', shift: null }`;
  - `{ 'Bia', FAILED, errorCode: 'evolution.session_closed', shift: 'SECOND' }`;
  - `{ 'Ana', SENT, shift: 'SECOND' }`;
  - `{ 'Davi', QUEUED, shift: 'FIRST' }`.
- `recipients` esperado, com `reason` por C5 e ordenado por nome: `[Ana SENT null, Bia FAILED 'evolution.session_closed', Caio SKIPPED 'NO_PHONE', Davi QUEUED null]`.
- `listDispatches` devolve a linha com `shift: 'SECOND'` → `target.shift === 'SECOND'`.
- `listRecipients` é chamado uma vez, com os ids da página.
- `teamDispatchListResponseSchema.parse` aceita a resposta, e ela não tem a chave `issues`.

No mesmo arquivo, o teste de `targets` existente ganha um membro com `shift: 'FIRST'` e confere que ele passa intacto e que o `teamTargetsResponseSchema.parse` aceita.

`team-whatsapp.repository.integration.spec.ts`, um teste, "grava e lê o turno do envio e dos destinatários":
- seed de setor com dois usuários (`shift: 'SECOND'` e `null`);
- `findSectorWithActiveMembers` devolve `shift` nos membros;
- `createDispatch({ ..., shift: 'SECOND', recipients: [{ ..., shift: 'SECOND', status: 'QUEUED' }, { ..., shift: null, status: 'SKIPPED', skipReason: 'NO_PHONE' }] })`;
- `listDispatches(null)[0].shift === 'SECOND'`;
- `listRecipients([id])` devolve as duas linhas com `shift` e `userId`.

Se o spec já cobre `listIssues`, trocar esse caso por este.

- [ ] **Step 3:** `timeout 600 gate --test src/modules/team-whatsapp/team-whatsapp.service.shift.spec.ts` (e os outros três specs do Step 2) → FAIL.

- [ ] **Step 4: implementar**

- `errors.ts`: `invalidSelection()` conforme Interfaces.
- `selection.ts`: como nas Interfaces.
- Repository: como nas Interfaces (`shift: true` nos três selects, `listRecipients` no lugar de `listIssues`, `shift` em `NewTeamRecipient`/`NewTeamDispatch`).
- Service:

```ts
type SectorTargetInput = Extract<CreateTeamDispatchInput['target'], { type: 'sector' }>;

private resolveTarget(actor: TeamActor, target: CreateTeamDispatchInput['target']) {
  return target.type === 'user'
    ? this.resolveUser(actor, target.userId)
    : this.resolveSector(actor, target);
}

private async resolveUser(actor: TeamActor, userId: string): Promise<ResolvedTarget> {
  // ...igual a hoje, com shift: null
}

/** Política (403) antes da seleção (422): `userIds` não abre outro setor. */
private async resolveSector(actor: TeamActor, target: SectorTargetInput): Promise<ResolvedTarget> {
  const sector = await this.repo.findSectorWithActiveMembers(target.sectorId);
  if (!sector || !canSendToSector(actor, sector)) throw teamForbidden();
  // O repositório já filtra ativos; o filtro aqui protege contra um select mais largo.
  const active = sector.members.filter((m) => m.isActive);
  const members = selectMembers(active, target.shift, target.userIds);
  if (members === null) throw invalidSelection();
  const shift = target.shift ?? null;
  return {
    targetType: 'SECTOR',
    targetId: sector.id,
    targetLabel: sectorTargetLabel(sector.name, shift, target.userIds ? members.length : null),
    shift,
    members,
  };
}
```

Em `dispatch`, `createDispatch` recebe `shift: target.shift`. Em `classify`, `const base = { userId: m.id, userName: displayName(m), shift: m.shift };`. A ordem do POST continua: remetente → alvo + política (403) → seleção (422) → canal → destinatários (`noRecipients` 422) → grava → enfileira → auditoria. A auditoria não ganha campo novo (GC5).

Atualizar o docblock de ordem do POST em `team-whatsapp.service.ts:58-62`: a seleção (422 `invalid_selection`) passa a vir ANTES do canal, junto com a resolução do alvo, e a ordem acima passa a constar ali.

`listDispatches`/`toListItem`: `recipientsByDispatch(rows)` no lugar de `issuesByDispatch`:

```ts
type TeamRecipientItem = TeamDispatchListResponse['items'][number]['recipients'][number];

/** Todos os destinatários, por nome; reason = errorCode (FAILED) ou skipReason (SKIPPED). */
function recipientsByDispatch(rows: readonly TeamRecipientRow[]): Map<string, TeamRecipientItem[]> {
  const sorted = [...rows].sort((a, b) => a.userName.localeCompare(b.userName, 'pt-BR'));
  const byDispatch = new Map<string, TeamRecipientItem[]>();
  for (const r of sorted) {
    const list = byDispatch.get(r.dispatchId) ?? [];
    list.push({ userId: r.userId, name: r.userName, shift: r.shift, status: r.status, reason: reasonOf(r) });
    byDispatch.set(r.dispatchId, list);
  }
  return byDispatch;
}

function reasonOf(r: TeamRecipientRow): string | null {
  if (r.status === 'FAILED') return r.errorCode;
  if (r.status === 'SKIPPED') return r.skipReason;
  return null;
}
```

`toListItem` ganha `target: { ..., shift: row.shift }` e `recipients`, e perde `issues`.

- [ ] **Step 5:** os specs do Step 2 → PASS. Specs vizinhos do módulo verdes: `team-whatsapp.service.spec.ts`, `team-whatsapp.controller.spec.ts`, `team-whatsapp.policy.spec.ts` e `team-whatsapp-send.processor.spec.ts`, cada um com `timeout 600 gate --test <arquivo>`.
- [ ] **Step 6:** `timeout 600 gate --changed --base origin/main` (cwd `backend/`) → PASS.

---

### Task 3: front — turno no cadastro, na edição e na tabela de Usuários

Depende da T1 (contrato C1/C2). Pode rodar em paralelo com a T2.

**Não crítico** — formulário e coluna que espelham o contrato da T1; a regra "ausente mantém / null limpa" é garantida no back (R5, T1).

**Files:**
- Create: `frontend/src/lib/work-shift.ts` (compartilhado; a T4/T5 consomem)
- Modify: `frontend/src/features/users/schemas.ts`
- Create: `frontend/src/features/users/components/shift-select.tsx`
- Modify: `frontend/src/features/users/components/invite-user-dialog.tsx` e `edit-user-dialog.tsx`
- Modify: `frontend/src/features/users/edit-user-payload.ts`
- Modify: `frontend/src/routes/_authenticated/users/index.tsx` (coluna Turno)
- Test: `frontend/src/features/users/components/invite-user-dialog.spec.tsx`, `frontend/src/features/users/components/edit-user-dialog.shift.spec.tsx` (novo) e `frontend/src/routes/_authenticated/users/index.spec.tsx`
- Modify (só fixtures, se o `tsc -b` acusar): specs que montam `UserSummary`

**Interfaces (Produces):**
- `frontend/src/lib/work-shift.ts`:

```ts
import { z } from 'zod';

/** Espelha `workShiftSchema` de `backend/src/schemas/contracts/user.schema.ts`. */
export const workShiftSchema = z.enum(['FIRST', 'SECOND']);
export type WorkShift = z.infer<typeof workShiftSchema>;

export const SHIFT_LABEL: Record<WorkShift, string> = { FIRST: '1º turno', SECOND: '2º turno' };
export const NO_SHIFT_LABEL = 'Sem turno';

export function shiftLabel(shift: WorkShift | null): string {
  return shift ? SHIFT_LABEL[shift] : NO_SHIFT_LABEL;
}
```

- `userSummarySchema`: `+ shift: workShiftSchema.nullable().optional().default(null)`, tolerante como `sectorId`. `inviteUserSchema` e `editUserSchema` ganham `shift: workShiftSchema.nullable().optional()`.
- `ShiftSelect({ value, onChange, disabled }: { value: WorkShift | null; onChange: (v: WorkShift | null) => void; disabled?: boolean })`: Radix Select com `aria-label`/`Label` "Turno" e opções `Sem turno`, `1º turno`, `2º turno`, nessa ordem. O Radix não aceita `value=""`, então "Sem turno" usa o sentinela `'NONE'`, mapeado para `null`. *A confirmar:* se o `SectorSelect` (`role-sector-selects.tsx` L37) já tem um sentinela para "Sem setor", usar o mesmo padrão.
- Payloads: `POST /users` sempre envia `shift` (`null` quando "Sem turno"); `PATCH /users/:id` envia o `shift` do formulário.

**Contexto vinculado:**
- Spec §1: os diálogos "Cadastrar usuário" e "Editar usuário" ganham o campo **Turno**, um select com `Sem turno`, `1º turno` e `2º turno`, opcional, que começa em "Sem turno" no cadastro. A tabela de Usuários ganha a coluna **Turno**. Usuários antigos aparecem como "Sem turno".
- C1: `WorkShift = 'FIRST' | 'SECOND'`; `null` = sem turno.
- C2: o POST aceita `shift?: 'FIRST' | 'SECOND' | null`. O PATCH aceita o mesmo: ausente mantém, `null` limpa. `GET /users` traz `shift` em cada item.
- GC8: o front espelha o back à mão. `workShiftSchema` do front tem os mesmos literais do back.
- GC4: rótulos exatos `1º turno`, `2º turno` e `Sem turno`.
- Decisão do plano D3: na edição de si mesmo (`isSelf`), o turno também é editável e enviado (`editableUserPayload` inclui `shift` quando definido). Turno não é privilégio, e o back não bloqueia self-edit de `shift` (`assertSelfChangeAllowed` só barra `role` e `isActive=false`).
- GC10: esta task NÃO mexe em `release-notes.ts` (a T5 faz uma entrada única).
- GC1: `timeout 600 gate --test <arquivo>` na iteração; `timeout 600 gate --changed --base origin/main` no fechamento; cwd `frontend/`.
- GC9: Vitest + Testing Library com `vi.mock` dos hooks de `../api`, sem msw.

- [ ] **Step 1: testes RED**
  - `invite-user-dialog.spec.tsx`, novo caso "Turno começa em Sem turno e vai no cadastro": abrir o diálogo → o trigger "Turno" mostra `Sem turno`; preencher os obrigatórios, escolher `2º turno` e enviar → `mutateAsync` (mock de `useInviteUser`) recebe `expect.objectContaining({ shift: 'SECOND' })`. Interação com Radix Select: seguir `role-sector-selects.spec.tsx`.
  - `edit-user-dialog.shift.spec.tsx`, com setup copiado de `edit-user-dialog.phone.spec.tsx`. Um caso: usuário com `shift: 'FIRST'` → trigger "Turno" mostra `1º turno`; trocar para `Sem turno` e salvar → `mutateAsync` (mock de `useUpdateUser`) recebe `shift: null` no corpo. Com `isSelf: true`, o mesmo corpo também leva `shift` (D3); fazer isso com `it.each` sobre `isSelf`.
  - `users/index.spec.tsx`, novo caso "coluna Turno", ao lado de "coluna Telefone" (L154): cabeçalho `Turno`; linha com `shift: 'SECOND'` mostra `2º turno`; linha com `shift: null` mostra `Sem turno`.
- [ ] **Step 2:** `timeout 600 gate --test` em cada um dos três specs → FAIL.
- [ ] **Step 3: implementar**
  - `work-shift.ts` e `ShiftSelect` conforme Interfaces.
  - `invite-user-dialog.tsx`: `EMPTY_INVITE` ganha `shift: null`; `InviteAssignment` ganha `<ShiftSelect value={field.value ?? null} onChange={field.onChange} />` (via `Controller`/`FormField`, no padrão do `SectorSelect`); o submit envia `shift: data.shift ?? null`.
  - `edit-user-dialog.tsx`: o `reset` inclui `shift: user.shift`; `RoleAndSectorFields` (ou um bloco ao lado) ganha `ShiftSelect`, habilitado também em self.
  - `edit-user-payload.ts`: `const { phone, shift, ...rest } = data;`. A base continua como hoje e o retorno acrescenta `...(shift !== undefined ? { shift } : {})`.
  - `users/index.tsx`: `<TableHead>Turno</TableHead>` depois de `Setor`, e em `UserRow` uma célula `shiftLabel(user.shift)`.
- [ ] **Step 4:** specs → PASS. Vizinhos verdes: `role-sector-selects.spec.tsx`, `edit-user-dialog.phone.spec.tsx`, `edit-user-dialog-ui.spec.tsx` e `schemas.phone.spec.ts`.
- [ ] **Step 5:** `timeout 600 gate --changed --base origin/main` (cwd `frontend/`) → PASS.

---

### Task 4: front — contrato do WhatsApp da equipe e "Ver destinatários"

Depende da T2 (C3–C5) e da T3 (`frontend/src/lib/work-shift.ts`).

**Fronteira** — espelha o contrato da T2. Se o zod do front divergir do back, o parse falha e a tela de envios quebra. Também traduz o código novo `invalid_selection`.

**Files:**
- Modify: `frontend/src/features/team-whatsapp/schemas.ts` (só membros, lista e `CreateDispatchInput`; `SendTarget` fica para a T5)
- Modify: `frontend/src/features/team-whatsapp/error-messages.ts` + `error-messages.spec.ts`
- Modify: `frontend/src/features/team-whatsapp/components/recent-dispatches.tsx`
- Test: `frontend/src/routes/_authenticated/whatsapp-equipe/index.spec.tsx` (describe NOVO "Ver destinatários"; o "envios recentes" existente, L117–166, já tem 50 linhas e só perde os casos de "Ver motivos")
- Modify (só fixtures, para o `tsc -b`): `frontend/src/features/team-whatsapp/api.spec.ts`, `send-whatsapp-dialog.spec.tsx` e os fixtures de `index.spec.tsx` (membros com `shift`, itens com `recipients`)

**Interfaces:**
- Consumes: C3, C4, C5 (T2); `workShiftSchema`, `WorkShift` e `shiftLabel` de `@/lib/work-shift` (T3).
- Produces (`schemas.ts`):

```ts
export const teamMemberSchema = personSchema.extend({
  phoneE164: z.string().nullable(),
  isActive: z.boolean(),
  shift: workShiftSchema.nullable(),
});

export const dispatchRecipientSchema = z.object({
  userId: z.string().nullable(),
  name: z.string(),
  shift: workShiftSchema.nullable(),
  status: z.enum(['QUEUED', 'SENT', 'FAILED', 'SKIPPED']),
  // errorCode quando FAILED; 'NO_PHONE' | 'SUPPRESSED' quando SKIPPED; senão null.
  reason: z.string().nullable(),
});
// dispatchListSchema.items[]: target ganha `shift: workShiftSchema.nullable()`;
// `issues` sai, entra `recipients: dispatchRecipientSchema.array()` (por nome).
export type DispatchRecipient = z.infer<typeof dispatchRecipientSchema>;

/** Corpo de `POST /internal/team-whatsapp/dispatches`. */
export type CreateDispatchInput = {
  channelId: string;
  text: string;
  target:
    | { type: 'user'; userId: string }
    | { type: 'sector'; sectorId: string; shift?: WorkShift; userIds?: string[] };
};
```

`dispatchIssueSchema` sai.

- Produces (`error-messages.ts`):
  - `TEAM_ERROR_MESSAGES['team_whatsapp.invalid_selection'] = 'A lista de pessoas mudou. Atualize a página e confira de novo.'`;
  - `recipientStatusLabel(r: Pick<DispatchRecipient, 'status' | 'reason'>): string` no lugar de `issueLabel`:
    - QUEUED → `Na fila`;
    - SENT → `Enviado`;
    - FAILED → `Falhou: ${failureReasonLabel(reason)}`;
    - SKIPPED → `Pulado: ${SKIP_REASON_LABEL[reason]}`, com `Pulado` quando o `reason` é desconhecido ou `null`.
- `recent-dispatches.tsx`: na célula "Situação", abaixo das contagens, `<details><summary>Ver destinatários</summary><ul>…</ul></details>`, presente quando `recipients.length > 0`. Cada item é `${name} · ${shiftLabel(shift)} — ${recipientStatusLabel(r)}`, por exemplo `Bia · 2º turno — Falhou: Canal desconectado — reconecte em Números e canais`. A coluna Destino continua mostrando `target.label`.

**Contexto vinculado:**
- Spec §3: em "Envios recentes", "Ver motivos" vira **"Ver destinatários"**. A lista mostra todos os destinatários do envio, com nome, turno e situação (na fila, enviado, falhou com o motivo, pulado com o motivo), e nenhum telefone. O rótulo do envio já vem com setor e turno.
- Spec §4: o erro `team_whatsapp.invalid_selection` aparece como "A lista de pessoas mudou. Atualize a página e confira de novo."
- C3: `sectors[].members[]` ganha `shift: WorkShift | null`.
- C4: o alvo setor do POST aceita `shift?: 'FIRST' | 'SECOND'` e `userIds?: string[]` (de 1 a 500). Erro novo: 422 `team_whatsapp.invalid_selection`.
- C5: cada item tem `target.shift: WorkShift | null` e `recipients: { userId: string | null, name, shift: WorkShift | null, status: 'QUEUED' | 'SENT' | 'FAILED' | 'SKIPPED', reason: string | null }[]`, no lugar de `issues` e ordenado por nome.
- GC5: nenhum telefone na lista de destinatários.
- GC8: o front espelha o back à mão; front e back sobem juntos e `issues` sai sem compatibilidade.
- GC4: rótulos `1º turno`/`2º turno`/`Sem turno` via `shiftLabel` e o texto exato de `invalid_selection`.
- GC10: esta task NÃO mexe em `release-notes.ts`.
- GC1: `timeout 600 gate --test <arquivo>` na iteração; `timeout 600 gate --changed --base origin/main` no fechamento; cwd `frontend/`.
- GC9: `vi.mock` dos hooks de `../api`, sem msw.

- [ ] **Step 1: testes RED**
  - `error-messages.spec.ts`:
    - `it.each` de `recipientStatusLabel`:
      - `{QUEUED,null}` → `Na fila`;
      - `{SENT,null}` → `Enviado`;
      - `{FAILED,'evolution.session_closed'}` → `Falhou: Canal desconectado — reconecte em Números e canais`;
      - `{SKIPPED,'NO_PHONE'}` → `Pulado: sem telefone`;
      - `{SKIPPED,null}` → `Pulado`.
    - `teamErrorMessage('team_whatsapp.invalid_selection')` → o texto de GC4.
    - Remover os casos de `issueLabel`.
  - `index.spec.tsx`: remover os casos de "Ver motivos" do describe "envios recentes" (que não cresce) e criar o describe novo "Ver destinatários" (≤ 50 linhas, GC9) com:
    - item com `target.label 'Produção · 2º turno'` e quatro `recipients` (Ana SENT 2º turno; Bia FAILED `evolution.session_closed` 2º turno; Caio SKIPPED `NO_PHONE` sem turno; Davi QUEUED 1º turno);
    - a célula Destino mostra `Produção · 2º turno` (aceite 4);
    - `Ver destinatários` aparece e, aberto, lista as quatro linhas no formato acima, incluindo `Caio · Sem turno — Pulado: sem telefone`;
    - `Ver motivos` não aparece, e nenhum texto contém `+55`.
- [ ] **Step 2:** `timeout 600 gate --test` nos dois specs → FAIL.
- [ ] **Step 3:** implementar conforme Interfaces e ajustar os fixtures dos specs vizinhos (membros com `shift: null`, itens com `recipients: []`) só para o `tsc -b` passar. O diálogo continua mandando `{ type: 'sector', sectorId }`, que é compatível com o `CreateDispatchInput` novo. `SendTarget` e `team-sector-card.tsx` NÃO mudam aqui.
- [ ] **Step 4:** specs → PASS. Vizinhos verdes: `api.spec.ts`, `send-whatsapp-dialog.spec.tsx` e `channel-availability.spec.ts`.
- [ ] **Step 5:** `timeout 600 gate --changed --base origin/main` (cwd `frontend/`) → PASS.

---

### Task 5: front — seletores Setor/Turno, seleção, diálogo com nomes e Novidades

Depende da T4.

**Fronteira** — monta o `shift`/`userIds` do POST a partir da tela. A garantia de quem recebe é do servidor (GC7, T2); aqui o risco é só de UX (lista e contagens erradas).

**Files:**
- Modify: `frontend/src/features/team-whatsapp/schemas.ts` (só `SendTarget`)
- Create: `frontend/src/features/team-whatsapp/components/sector-shift-picker.tsx` (seletores Setor e Turno)
- Create: `frontend/src/features/team-whatsapp/components/member-selection.tsx` (lista com caixas, "Marcar todos", nota de sem turno e as duas ações)
- Create: `frontend/src/features/team-whatsapp/member-filter.ts` (puro: membros visíveis, contagens, montagem do `SendTarget`)
- Modify: `frontend/src/routes/_authenticated/whatsapp-equipe/index.tsx` (inclui o texto do `PageHeader`, L25)
- Delete: `frontend/src/features/team-whatsapp/components/team-sector-card.tsx` (*a confirmar:* `grep -r team-sector-card frontend/src` sem outro uso; não há spec dele no mapa)
- Modify: `frontend/src/features/team-whatsapp/components/send-whatsapp-dialog.tsx` (rótulo, listas de nomes, corpo do POST)
- Modify: `frontend/src/release-notes.ts`
- Test: `frontend/src/routes/_authenticated/whatsapp-equipe/index.spec.tsx` e `frontend/src/features/team-whatsapp/components/send-whatsapp-dialog.spec.tsx`

**Interfaces:**
- Consumes: `TeamSector`/`TeamMember` com `shift` e `CreateDispatchInput` (T4); `teamErrorMessage` com `invalid_selection` (T4); `WorkShift`, `SHIFT_LABEL` e `shiftLabel` (T3).
- Produces (`schemas.ts`):

```ts
export type RecipientPreview = { id: string; name: string };

export type SendTarget =
  | { type: 'user'; userId: string; label: string }
  | {
      type: 'sector';
      sectorId: string;
      /** "Produção · 2º turno" / "Produção · todos os turnos" / "… · seleção de 2" */
      label: string;
      shift: WorkShift | null;     // null = todos os turnos (não envia `shift`)
      userIds: string[] | null;    // null = todos do turno (não envia `userIds`)
      recipients: RecipientPreview[]; // vão receber (têm telefone)
      leftOut: RecipientPreview[];    // ficam de fora (sem telefone)
    };
```

`recipientCount` sai.

- `member-filter.ts`:
  - `type ShiftChoice = WorkShift | 'ALL'`;
  - `visibleMembers(sector: TeamSector, choice: ShiftChoice): TeamMember[]` → ativos com `choice === 'ALL' || m.shift === choice`, na ordem do back;
  - `unassignedCount(sector: TeamSector): number` → ativos com `shift === null`;
  - `canReceive(m: TeamMember): boolean` → `!!m.phoneE164`;
  - `buildSectorTarget(sector, choice, visible, selectedIds: string[] | null): SendTarget`. Rótulo: `[sector.name, choice === 'ALL' ? 'todos os turnos' : SHIFT_LABEL[choice], ...(selectedIds ? [`seleção de ${selectedIds.length}`] : [])].join(' · ')`, igual ao `targetLabel` do back (GC4). O nome de cada pessoa é `m.name ?? m.email`. Com `selectedIds`, `recipients` são os marcados e `leftOut` fica `[]`; sem seleção, `recipients` são os visíveis com telefone e `leftOut` os sem telefone.
- Corpo do POST no diálogo: `{ type: 'sector', sectorId, ...(target.shift ? { shift: target.shift } : {}), ...(target.userIds ? { userIds: target.userIds } : {}) }`.
- O alvo pessoa (usado pela tela Usuários) não muda.

**Contexto vinculado:**
- Spec §4:
  - no topo ficam dois seletores: **Setor**, com os setores que o usuário alcança (pré-selecionado se houver só um), e **Turno**, com `1º turno`, `2º turno` e `Todos os turnos`, sem valor padrão;
  - até escolher os dois, a lista mostra "Escolha o setor e o turno";
  - com os dois escolhidos, a lista mostra os **membros ativos** daquele setor e turno, com caixa de seleção, nome, turno e telefone (ou "sem telefone"); quem está sem telefone tem a caixa desabilitada;
  - com 1º ou 2º turno, a nota "N pessoa(s) deste setor estão sem turno definido — defina em Usuários" aparece quando houver alguém nessa situação;
  - "Marcar todos" marca ou desmarca os habilitados;
  - as ações são **"Enviar para todos do turno (N)"**, em que N conta quem tem telefone, e **"Enviar para selecionados (M)"**, desabilitada sem marcação.
- Spec §4, diálogo: o diálogo "Enviar WhatsApp" mostra o destino (setor e turno), os nomes que vão receber, "Ficam de fora (sem telefone)" quando houver, o canal e o texto. No sucesso, o toast atual com os pulados. O erro `invalid_selection` aparece com o texto de GC4.
- Spec §4, página: saem os cards por setor e o "Enviar" por pessoa. Ficam o estado vazio para quem não é ADMIN nem gestor e os "Envios recentes". Novidades: entrada no topo de `RELEASE_NOTES` com `where: '/whatsapp-equipe'`.
- Decisão M4 (controlador): ADMIN ou gestor com lista de setores vazia vê, no lugar dos seletores, `Nenhum setor ativo para envio. Cadastre setores em Setores.`; quem não é ADMIN nem gestor continua com o estado atual do 403 de `targets` (`TargetsError`, `index.tsx:52`).
- M3: o texto do `PageHeader` (`index.tsx:25`, hoje "para uma pessoa ou para o setor inteiro") fica inexato com o fluxo novo e passa a ser, por exemplo, `Escolha o setor e o turno e envie para todos ou só para quem você marcar.`
- GC9 (describe ≤ 50 linhas): casos novos entram em `describe` novos, sem crescer "setores e membros" (L84–115) nem os describes existentes do diálogo.
- GC7: o servidor refaz o filtro. A tela só monta `shift`/`userIds`, e "Todos os turnos" NÃO envia `shift`.
- GC4: textos exatos `Escolha o setor e o turno`, `N pessoa(s) deste setor estão sem turno definido — defina em Usuários`, `Marcar todos`, `Enviar para todos do turno (N)`, `Enviar para selecionados (M)`, `Ficam de fora (sem telefone)`. O seletor mostra `Todos os turnos`; o rótulo do destino usa `todos os turnos`, igual ao back.
- GC10: entrada nova no TOPO de `RELEASE_NOTES`, com `version`/`date` `2026.10.21`, texto pt-BR para o operador e `where: '/whatsapp-equipe'` nos itens da tela; o item de Usuários vai com `where: '/users'`. Cobre T3, T4 e T5.
- GC11: usar `select` e `checkbox` de `components/ui/`, sem componente novo nem dependência.
- Decisão do plano D4: trocar o setor ou o turno limpa a seleção.
- GC1: `timeout 600 gate --test <arquivo>` na iteração; `timeout 600 gate --changed --base origin/main` no fechamento; cwd `frontend/`.
- GC9: `index.spec.tsx` mocka `../api` e o diálogo (como hoje) e verifica o `target` passado ao diálogo mockado; `send-whatsapp-dialog.spec.tsx` testa o diálogo de verdade, com `vi.mock` de `../api`.

- [ ] **Step 1: testes RED**

Fixture de `index.spec.tsx`, setor `Produção` (`s1`):
- Ana: FIRST, com telefone;
- João: SECOND, com telefone;
- Maria: SECOND, com telefone;
- Pedro: SECOND, sem telefone;
- Zé: sem turno, com telefone;
- Lia: SECOND, inativa.

Mais um segundo setor `Expedição` para o caso dos dois seletores.

Em `index.spec.tsx`, os casos 1, 2 e 5 vão num describe NOVO "seletores" e os casos 3, 4 e 6 noutro NOVO "seleção e envio" (cada um ≤ 50 linhas; o caso 7 ajusta o que já existe). Em `send-whatsapp-dialog.spec.tsx`, os casos 8 e 9 vão num describe NOVO "diálogo: nomes".

  1. "pede setor e turno": com dois setores, `Escolha o setor e o turno` aparece até escolher os dois. Com um setor só (rerender com o fixture reduzido), o Setor vem pré-selecionado e a mensagem continua até escolher o turno.
  2. "2º turno lista só os ativos do turno" (aceite 2):
     - escolher `Produção` + `2º turno` → aparecem João, Maria e Pedro; Ana, Zé e Lia não aparecem;
     - a caixa do Pedro está desabilitada e a linha mostra `sem telefone`;
     - aparece a nota `1 pessoa(s) deste setor estão sem turno definido — defina em Usuários`;
     - os botões mostram `Enviar para todos do turno (2)` e `Enviar para selecionados (0)`, este desabilitado.
  3. "selecionados João e Maria" (aceite 2): marcar os dois (a ordem do clique não importa: `userIds` vem na ordem do back, `visible.filter(m => selected.has(m.id)).map(m => m.id)`) → `Enviar para selecionados (2)` → o diálogo mockado recebe `target` com `{ type: 'sector', sectorId: 's1', shift: 'SECOND', userIds: ['joao', 'maria'], label: 'Produção · 2º turno · seleção de 2', recipients: [{id:'joao',name:'João'},{id:'maria',name:'Maria'}], leftOut: [] }`.
  4. "todos do turno" (aceite 2): `Enviar para todos do turno (2)` → `target` com `userIds: null`, `shift: 'SECOND'`, `label: 'Produção · 2º turno'`, `recipients` João e Maria e `leftOut` Pedro.
  5. "Todos os turnos lista quem está sem turno" (R3, aceite 2): escolher `Todos os turnos` → aparecem Ana, João, Maria, Pedro e Zé, sem a nota de sem turno. "Enviar para todos do turno (4)" → `target.shift === null` e `label: 'Produção · todos os turnos'`.
  6. "Marcar todos marca só os habilitados": no 2º turno, `Marcar todos` → `Enviar para selecionados (2)`; de novo → `(0)`.
  7. Cards antigos sumiram: `Enviar ao setor` não aparece, e o `PageHeader` mostra o texto novo (M3). Estados vazios (M4), dois casos: (a) ADMIN ou gestor com `sectors: []` vê `Nenhum setor ativo para envio. Cadastre setores em Setores.` no lugar dos seletores; (b) quem não é ADMIN nem gestor (403 de `targets`) continua vendo o estado atual (`TargetsError`). Os "Envios recentes" continuam; manter os casos existentes.

`send-whatsapp-dialog.spec.tsx`:
  8. "lista quem recebe e quem fica de fora" (aceite 3): `target` setor com `recipients` João e Maria e `leftOut` Pedro → antes do botão `Enviar` aparecem o destino `Produção · 2º turno`, os nomes João e Maria e `Ficam de fora (sem telefone)` com Pedro. Ao enviar, `mutateAsync` recebe `target: { type: 'sector', sectorId: 's1', shift: 'SECOND' }`, sem `userIds`. Com `userIds: ['joao','maria']`, o corpo leva `userIds` e, com `leftOut: []`, o bloco "Ficam de fora" não aparece (`it.each` sobre os dois alvos).
  9. "invalid_selection": `mutateAsync` rejeita com um `HTTPError` de corpo `{ code: 'team_whatsapp.invalid_selection' }` → aparece `A lista de pessoas mudou. Atualize a página e confira de novo.` Copiar a montagem do `HTTPError` dos casos de erro existentes no spec.

Ajustar os casos existentes do diálogo que usam `recipientCount` para o `SendTarget` novo.

- [ ] **Step 2:** `timeout 600 gate --test` nos dois specs → FAIL.

- [ ] **Step 3: implementar**

`member-filter.ts` conforme Interfaces.

`sector-shift-picker.tsx`: dois Radix Select com `Label` "Setor" e "Turno". As opções de turno são `1º turno` (`FIRST`), `2º turno` (`SECOND`) e `Todos os turnos` (`ALL`), e o turno começa sem valor (`placeholder`).

`member-selection.tsx`: props `{ sector: TeamSector; choice: ShiftChoice; selected: ReadonlySet<string>; onToggle(id): void; onToggleAll(): void; onSendAll(): void; onSendSelected(): void }`. Uma linha por membro visível com `Checkbox` (desabilitado se `!canReceive`), nome, `shiftLabel(m.shift)` e `formatPhoneBR(m.phoneE164)` ou `sem telefone`. A nota de sem turno aparece quando `choice !== 'ALL' && unassignedCount(sector) > 0`.

Página `whatsapp-equipe/index.tsx`:

```tsx
const sectors = targets.data?.sectors ?? [];
const [sectorId, setSectorId] = useState<string | null>(null);
const [choice, setChoice] = useState<ShiftChoice | null>(null);
const [selected, setSelected] = useState<Set<string>>(new Set());
const effectiveSectorId = sectorId ?? (sectors.length === 1 ? sectors[0].id : null);
const sector = sectors.find((s) => s.id === effectiveSectorId) ?? null;
// trocar setor/turno: setSelected(new Set()) (D4)
```

`effectiveSectorId` é derivado, não sincronizado por `useEffect`.

- Sem `sector` ou sem `choice`, a página mostra `Escolha o setor e o turno`.
- Com os dois, mostra `<MemberSelection …/>`.
- `onSendAll` → `setTarget(buildSectorTarget(sector, choice, visible, null))`. `onSendSelected` → `const ids = visible.filter((m) => selected.has(m.id)).map((m) => m.id);` (ordem do back, não a do clique) e `setTarget(buildSectorTarget(sector, choice, visible, ids))`.
- `<RecentSection/>` e o `<SendWhatsappDialog/>` ficam onde estão.
- `PageHeader` (`index.tsx:25`): trocar o texto por `Escolha o setor e o turno e envie para todos ou só para quem você marcar.` (M3).
- Estado vazio (M4): se `targets` deu 403, quem não é ADMIN nem gestor continua com o estado atual (`TargetsError`, `index.tsx:52`). Se `targets` respondeu com `sectors: []` (ADMIN ou gestor sem setor ativo), mostrar no lugar dos seletores `Nenhum setor ativo para envio. Cadastre setores em Setores.`

`send-whatsapp-dialog.tsx`:
- a descrição passa a ser `target.label` nos dois tipos;
- para o alvo setor, abaixo da descrição, `Vão receber (N)` com `<ul>` dos nomes e, se `leftOut.length > 0`, `Ficam de fora (sem telefone)` com `<ul>`;
- o `body` vem de Interfaces;
- `notifyQueued` e o resto ficam iguais. A lista pode ser longa: `max-h-48 overflow-y-auto` no `<ul>`.

`release-notes.ts`, no topo:

```ts
{
  version: '2026.10.21',
  date: '2026-10-21',
  title: 'Turnos no WhatsApp da equipe',
  items: [
    { text: 'O cadastro de usuário ganhou o campo Turno (1º turno, 2º turno ou sem turno), e a lista de usuários mostra o turno de cada pessoa.', where: '/users' },
    { text: 'No WhatsApp da equipe, escolha o setor e o turno, marque as pessoas e envie para todos do turno ou só para as selecionadas. Antes de enviar, você confere os nomes de quem vai receber e de quem fica de fora por não ter telefone.', where: '/whatsapp-equipe' },
    { text: 'Em Envios recentes, "Ver destinatários" mostra todos que estavam no envio, com o turno e a situação de cada um.', where: '/whatsapp-equipe' },
  ],
},
```

*A confirmar:* o formato do campo `date` segue as entradas existentes.

- [ ] **Step 4:** specs → PASS. Vizinhos verdes: `release-notes.spec.ts`, `api.spec.ts`, `error-messages.spec.ts` e `routes/_authenticated/users/index.spec.tsx` (o "Enviar WhatsApp" da tela Usuários usa o alvo pessoa).
- [ ] **Step 5:** `timeout 600 gate --changed --base origin/main` (cwd `frontend/`) → PASS.

---

## Fechamento (principal)

- Gate completo em `backend/` e `frontend/` no estado final, comparado à baseline `a68a532`, sem piora (dívida legada conhecida registrada no ledger).
- Antes do PR: `prisma migrate diff` de drift (como o job `migration-drift`) e a suíte de integração do backend, se a T1 tiver registrado lacuna.
- QA local pelo `qa` (Playwright), com a stack dev:
  - em `/users`: cadastrar com turno, editar para "Sem turno" e conferir a coluna;
  - em `/whatsapp-equipe`: Produção + 2º turno, seleção de 2 → diálogo com nomes → envio → "Ver destinatários";
  - `userIds` adulterado via DevTools/curl → mensagem de lista mudada.
  - O telefone não aparece no histórico.
- Revisão independente por task (T1 e T2 críticas: `revisor` com `opus`). CI do PR: backend-tests, frontend-build, e2e e migration-drift.
