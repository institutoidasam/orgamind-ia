# Plano — telefone no cadastro de usuário e WhatsApp para a equipe

**Goal:** "Convidar usuário" vira "Cadastrar usuário" com telefone obrigatório (ligado a um `Contact`), e ADMIN/gestor do setor enviam WhatsApp em texto livre a um usuário ou setor pela tela nova `/whatsapp-equipe`, com envio assíncrono por fila própria; inclui a correção do "Ver" das Novidades salva do PR #3.

**Architecture:** Backend NestJS: `User.phoneE164`/`User.contactId` (migração aditiva) + `UserPhoneService` novo no módulo `users` (normalização, conflito por variantes BR, ligação via `ContactsService`); módulo novo `team-whatsapp` (modelos `TeamWhatsappDispatch`/`TeamWhatsappRecipient`, política ADMIN/gestor, 3 rotas `/internal/team-whatsapp/*`, fila BullMQ `team-whatsapp.send`), processor no worker e método público novo `ChatService.sendTeamMessage` que reaproveita o caminho de saída do Inbox. Frontend React + TanStack Router/Query: renomes e campo Telefone em Usuários, página `/whatsapp-equipe`, diálogo reutilizável "Enviar WhatsApp", `canAccessPath` no manifesto `NAV`.

**Tech Stack:** NestJS + nestjs-zod + Prisma (Postgres) + BullMQ (Redis) + vitest/vitest-mock-extended (backend); React + TanStack Router/Query + react-hook-form + zod + ky + vitest/testing-library + Playwright (frontend).

**Spec:** `docs/superpowers/specs/2026-10-16-orgamind-user-phone-whatsapp.md`. Mapas: `.superpowers/sdd/2026-10-16-orgamind-user-phone-whatsapp/maps/{users,send,permissions}.md`.

**Base Git:** `origin/main` = `dce9ef9805097a1c66648a4813019b5b8bf5ffcb`; branch `codex/user-phone-whatsapp`. **Projeto legado:** o gate completo tem dívida conhecida; cada task fecha com `timeout 600 gate --changed --base origin/main` no cwd do pacote tocado (`backend/` ou `frontend/`). Gate completo, suíte inteira, cobertura completa e e2e ficam com a principal, no fim da feature.

## Global Constraints

- **GC1 — Comandos.** Loop: `timeout 600 gate --test <arquivo>` (cwd `backend/` ou `frontend/`). Fechamento: `timeout 600 gate --changed --base origin/main` no pacote tocado (mede cobertura das linhas novas). Proibido prescrever/rodar suíte inteira, `test:cov`, `test:e2e`, `bun run test` sem arquivo. Sem commits (o controlador integra).
- **GC2 — Códigos de erro (exatos).** `user.invalid_phone` 400; `user.phone_taken` 409; `team_whatsapp.forbidden` 403; `team_whatsapp.no_recipients` 422; `team_whatsapp.channel_disconnected` 409; `team_whatsapp.channel_invalid` 422. Os existentes (`user.email_taken` 409, `user.sector_required` 409, `user.last_admin` 403 …) não mudam. 422 não tem classe própria: usar `new DomainError({ code, message, status: 422 })` (`backend/src/shared/errors/domain.error.ts`).
- **GC3 — Telefone.** Normalizar com `normalizeToE164(raw, 'BR')` (`backend/src/modules/contacts/phone.util.ts:9`, devolve `string | null`). Igualdade de titular = `brazilianPhoneVariants(e164)` (`phone.util.ts:55`, inclui o próprio número): `+55 92 9xxxx-xxxx` e `+55 92 xxxx-xxxx` são o mesmo número em cadastro, conflito e ligação ao contato. Nunca comparar string crua.
- **GC4 — Persistência de User.** `phoneE164 String? @unique` e `contactId String? @unique` com FK para `Contact` `onDelete: SetNull`. Migração `backend/prisma/migrations/20261016090000_user_phone_contact/` só adiciona colunas, índices e a FK; usuários existentes ficam `null`.
- **GC5 — Contrato de usuários.** `POST /users`: `phone` obrigatório (string). `PATCH /users/:id`: `phone` opcional, sem `null` (e sem string vazia). `GET /users`: cada item ganha `phoneE164: string | null`. `backend/src/schemas/contracts/user.schema.ts` e `frontend/src/features/users/schemas.ts` mudam juntos (T2 e T3).
- **GC6 — Ligação usuário→contato.** Contato existente em qualquer variante BR: o usuário aponta para ele; nome do contato só é preenchido se vazio; consentimento não é tocado. Senão cria por `ContactsService.create` (auditoria, reidratação de consentimento, ligação de conversas). Nome = nome do usuário ou o e-mail. Trocar o número religa ao contato do número novo; o antigo fica intacto.
- **GC7 — Rotas novas**, todas `@Roles('ADMIN','SUPERVISOR','OPERATOR')` (VIEWER barrado pelo `RolesGuard` global) e prefixo `internal/team-whatsapp`:
  - `GET /internal/team-whatsapp/targets` → `{ channels: [{ id, name, phoneE164, provider }], sectors: [{ id, name, code, members: [{ id, name, email, phoneE164, isActive }] }] }`;
  - `POST /internal/team-whatsapp/dispatches` body `{ channelId, text, target: { type: 'user', userId } | { type: 'sector', sectorId } }` → **202** `{ dispatchId, queued, skipped: [{ userId, name, reason }] }` (`reason` ∈ `NO_PHONE` | `SUPPRESSED`);
  - `GET /internal/team-whatsapp/dispatches` → `{ items: [{ id, createdAt, author: { id, name, email } | null, target: { type, id, label }, channel: { id, name } | null, counts: { queued, sent, failed, skipped } }] }`, 20 mais novos. `channel: null` = canal removido depois do envio (o front mostra "canal removido").
- **GC8 — Política (backend decide).** Remetente só com `role` ∈ {`ADMIN`,`SUPERVISOR`,`OPERATOR`} (gestor rebaixado a VIEWER perde o envio mesmo com `managerId` e JWT ainda válido). ADMIN ativo: qualquer usuário ativo e qualquer setor ativo. Gestor = usuário ativo que é `Sector.managerId` de ≥1 setor **ativo**: esses setores e usuários ativos com `sectorId` num deles **e cujo setor está ativo** (checado no alvo, não só no filtro de `findActor`). Demais (inclusive remetente inativo, alvo inexistente/inativo, setor inativo): 403 `team_whatsapp.forbidden`. Histórico: ADMIN vê todos; gestor vê os próprios (`authorId`).
- **GC9 — Destinatários.** Pessoa: o usuário-alvo. Setor: membros ativos (`User.sectorId`); o remetente entra se for membro. Sem telefone → `SKIPPED/NO_PHONE`; telefone em supressão (`ConsentService.isSuppressed`) → `SKIPPED/SUPPRESSED`. Alvo sem destinatário válido (zero enfileirados) → 422 `team_whatsapp.no_recipients` e nada é criado — vale para pessoa e para setor (spec atualizada).
- **GC10 — Canal e texto.** Só canais `isActive` com `provider` ∈ {`GOZAP`, `EVOLUTION`}; inexistente/inativo/outro provedor → 422 `team_whatsapp.channel_invalid`; último `connectionEvents.state` conhecido = `'close'` → 409 `team_whatsapp.channel_disconnected`. Texto livre 1–2000 caracteres (sem trim do conteúdo; só-espaços é inválido), sem template nem variáveis.
- **GC11 — Modelos/enum/fila.** Modelos `TeamWhatsappDispatch`, `TeamWhatsappRecipient`; enums `TeamWhatsappTargetType { USER SECTOR }`, `TeamWhatsappRecipientStatus { QUEUED SENT FAILED SKIPPED }`, `TeamWhatsappSkipReason { NO_PHONE SUPPRESSED }`; migração `backend/prisma/migrations/20261016100000_team_whatsapp/`. Fila `QUEUE_NAMES.TEAM_WHATSAPP_SEND = 'team-whatsapp.send'`, job `TeamWhatsappSendJob = { recipientId: string }`, `jobId = recipientId`, `attempts: 3`, `backoff: { type: 'exponential', delay: 5000 }`, `removeOnComplete: { age: 3600, count: 1000 }`, `removeOnFail: { age: 86400 }`. Uma `Message` por destinatário: criada uma vez e com `TeamWhatsappRecipient.messageId` gravado **antes** do envio; retentativa reaproveita a mesma linha. A fila retenta (1) falha `retryable` do provedor (`WhatsappSendError` com `fatal: false` e `providerErrorCode` presente e fora de `CHAT_INDETERMINATE_CODES`) e (2) qualquer exceção fora da última tentativa (banco/Redis/pacing: o catch relança). **Claim atômico:** `sendTeamMessage` só chama o provedor depois de mover a `Message` de `QUEUED`/`FAILED` para `SENDING` (com `sendingAt`) num `updateMany` condicional; `count === 0` lança `ConflictError` `team_whatsapp.not_claimed` sem enviar. **Reenvio ao provedor** só ocorre se a `Message` anterior estiver `QUEUED` (não começou) ou `FAILED` com `errorCode` não-nulo e redispatchável (`ChatService.isRedispatchableFailure`: fora de `CHAT_INDETERMINATE_CODES` e de `sending_stuck`); `SENDING`, `FAILED` sem código/indeterminado e demais status nunca reenviam (`SENT`/`DELIVERED`/`READ` → destinatário `SENT`; resto → `FAILED` `team_whatsapp.indeterminate`). Na última tentativa o destinatário nunca fica `QUEUED`: a exceção grava `FAILED`, salvo se a `Message` já estiver `SENT`/`DELIVERED`/`READ` (então grava `SENT`). `TeamWhatsappDispatch.channelId` é nullable com `onDelete: SetNull` (remover canal não apaga histórico nem é bloqueado). Fila de campanha (`WHATSAPP_SEND`) e `SendMessageProcessor` não mudam.
- **GC12 — Privacidade.** Texto da mensagem e telefones não vão para logs nem auditoria. Auditoria `team_whatsapp.dispatch` com `actorId`, `targetType`, `targetId`, `channelId`, `queued`, `skipped` (contagens). Consentimento de marketing não se aplica (recado interno, como a resposta do Inbox); supressão é respeitada sempre (no POST e de novo no processor).
- **GC13 — Inbox intocado.** `ChatService.sendReply` mantém o comportamento (characterization `chat/chat.send-reply.char.spec.ts` e `chat/chat.send.service.spec.ts` verdes). Fora do envio da equipe nada muda em campanha, consentimento, Inbox, webhooks ou contatos.
- **GC14 — Textos de UI (exatos).** "Cadastrar usuário" (botão da página e título do diálogo), "Cadastrar"/"Cadastrando...", "Telefone (WhatsApp)", coluna "Telefone" com número formatado ou "—", "Enviar WhatsApp", "WhatsApp da equipe", "Enviar ao setor", "Enviar", "sem telefone", estado vazio "Só o administrador e o gestor do setor enviam mensagens para a equipe.", toast "Mensagem enfileirada para N pessoa(s)" com a 1ª linha da descrição "Os envios saem aos poucos, no ritmo do canal; para um setor grande pode levar alguns minutos." (pacing compartilhado com campanha, jitter 10–45 s: setor de 30 pessoas ≈ 5–20 min), histórico com canal removido mostra "canal removido".
- **GC15 — Novidades.** Entrada nova no TOPO de `RELEASE_NOTES` (`frontend/src/release-notes.ts`), `version: '2026.10.16'`, `date: '2026-10-16'`, com item `where: '/whatsapp-equipe'`; PT-BR para o operador. Nada da novidade 2026.10.15 do PR #3. "Ver" só aparece se `canAccessPath(where, role)`.
- **GC16 — Qualidade.** Funções e blocos `describe` ≤ 50 linhas (vale para specs); ciclomática ≤ 10; cognitiva ≤ 15; cobertura das linhas novas ≥ 80%. Spec existente que já passa de 50 linhas por `describe` não pode piorar: casos novos vão em `describe` novo ou arquivo novo.

## Review Focus

| # | Risco (spec) | Teste que fixa | Task dona |
|---|---|---|---|
| R1 | 9º dígito: `+55 92 9xxxx-xxxx` ≡ `+55 92 xxxx-xxxx` em cadastro, conflito e ligação | `user-phone.service.spec.ts`: "acusa user.phone_taken quando outro usuário tem a variante de 8 dígitos" e "liga ao contato existente na outra grafia" | T2 |
| R2 | Contato preexistente: liga, não duplica, não sobrescreve nome nem consentimento | `user-phone.service.spec.ts`: "contato existente com nome: só devolve o id (sem create/update)" e "contato sem nome: preenche só o nome" | T2 |
| R3 | Fusão no deploy com usuário ligado ao descartado → vai para o sobrevivente; sobrevivente já com usuário → `conflicts`, sem falhar o deploy | `prisma/merge-duplicate-phone-contacts.spec.ts` (`describe` novo): "reaponta User.contactId do perdedor para o sobrevivente antes de apagar" e "sobrevivente já tem usuário: registra 'user' em conflicts, não reaponta e não falha" | T2 |
| R4 | Gestor fora do setor / usuário de outro setor por API → 403; gestor desativado, rebaixado a VIEWER ou setor desativado → recusado | `team-whatsapp.policy.spec.ts` (tabela de casos) + `team-whatsapp.service.spec.ts`: "gestor enviando a setor que não gerencia recebe 403" e "gestor → usuário de setor desativado → 403" | T4a |
| R5 | Supressão após enfileirar → pula; canal desconectado/erro do provedor → `FAILED` sem travar os outros e sem duplicar na retentativa; exceção não deixa `QUEUED` eterno | `team-whatsapp-send.processor.spec.ts`: "SAIR depois de enfileirar vira SKIPPED/SUPPRESSED", "status diferente de QUEUED não reenvia", "erro retentável relança e a última tentativa marca FAILED", "erro não retentável (fatal ou indeterminado) marca FAILED sem relançar", "retentativa reaproveita o messageId", "retentativa com Message FAILED por gozap.timeout não reenvia", "retentativa com Message SENDING não reenvia", "falha no settle após SENT não reenvia", "exceção na última tentativa marca FAILED", "exceção na última tentativa com Message já SENT grava SENT", "claim recusado (team_whatsapp.not_claimed) fora da última tentativa relança sem marcar"; `chat.service.team.spec.ts`: "claim com count 0 lança e não chama o provedor" | T4b |

## Estado

| Task | Nome | Pacote | Depende de | Risco | Status |
|---|---|---|---|---|---|
| T1 | "Ver" das Novidades por papel (`canAccessPath`) | frontend | — | médio | pendente |
| T2 | Telefone no usuário + ligação ao contato + script de fusão | backend | — | crítico | pendente |
| T3 | Tela "Cadastrar usuário" com Telefone | frontend | T2 | médio | pendente |
| T4a | Módulo team-whatsapp: modelos, política, rotas, enfileiramento | backend | T2 (schema.prisma) | crítico | pendente |
| T4b | `ChatService.sendTeamMessage` + processor da fila | backend | T4a | crítico | pendente |
| T5 | Página `/whatsapp-equipe`, diálogo, item em Usuários, novidade | frontend | T1, T3, T4a | médio | pendente |

Ondas: **1** = T1 ∥ T2; **2** = T3 ∥ T4a; **3** = T4b ∥ T5. Ownership é disjunto dentro de cada onda. `backend/prisma/schema.prisma` é tocado por T2 e T4a (serial: T4a só começa com T2 integrada; migrações em ordem `20261016090000` < `20261016100000`). `frontend/src/lib/nav.ts` é tocado por T1 e T5 (serial). `frontend/src/routes/_authenticated/users/index.tsx` é tocado por T3 e T5 (serial).

---

### Task 1: "Ver" das Novidades por papel (`canAccessPath`)

**Files**
- Modify: `frontend/src/lib/nav.ts`
- Modify: `frontend/src/components/layout/release-notes-dialog.tsx`
- Test: `frontend/src/lib/nav.spec.ts`, `frontend/src/components/layout/release-notes-dialog.spec.tsx`

**Ownership:** os 4 arquivos acima.

**Interfaces**
- Consumes: `NAV: NavItem[]`, `isNavActive(path, to)`, `NavRole` (`frontend/src/lib/nav.ts`); `useAuthStore` (`frontend/src/stores/auth.store.ts`, `user.role`); `RELEASE_NOTES`/`ReleaseNoteItem { text: string; where?: string }` (`frontend/src/release-notes.ts`).
- Produces: `export function canAccessPath(path: string, role?: NavRole): boolean` em `lib/nav.ts`; função privada `navItemFor(path: string): NavItem | undefined` (prefixo mais longo), reutilizada por `navLabelFor`; componente local `ReleaseItem` em `release-notes-dialog.tsx` que só renderiza o link "Ver" quando `canAccessPath(item.where, role)`.

**Risco:** médio — só esconde um link na UI; o acesso continua decidido pelas rotas/backend.

**Contexto vinculado**
- Spec §3 "Correção salva do PR #3": o diálogo de Novidades só mostra "Ver" quando o papel logado acessa a rota de `where`; decisão pelo manifesto `NAV`, prefixo mais longo; rota fora do `NAV` ou usuário sem papel fica sem "Ver". Origem: commit `13d18e4` e a parte `canAccessPath` de `a1c024e`, **sem** a seção WhatsApp do sidebar, sem `NavSection` `'whatsapp'` e sem a novidade de 2026-10-15.
- Aceite 5: VIEWER não vê "Ver" para `/contacts` e vê para `/dashboard`; ADMIN vê para `/contacts` e `/setores`; OPERATOR não vê para `/setores`. No `NAV` atual: `/contacts` tem `roles: LEGACY_ROLES` (`['ADMIN','OPERATOR']`) e `hideInSidebar: true` — continua no manifesto, então os casos valem; `/setores` é `['ADMIN']`; `/dashboard` é `ALL_INTERNAL_ROLES`.
- GC15: "Ver" só aparece se `canAccessPath(where, role)`; nada da novidade 2026.10.15.
- GC16: funções/`describe` ≤ 50 linhas; ciclomática ≤ 10.

**Steps**

1. **Verificar no Step 1.** `git cat-file -e 13d18e4 && git cat-file -e a1c024e` (branch `codex/whatsapp-menu-section`). Ler `git show 13d18e4` e `git show a1c024e -- frontend/src/lib/nav.ts frontend/src/lib/nav.spec.ts`. Extrair **só** `canAccessPath`, `navItemFor`, o `ReleaseItem` e os testes correspondentes; descartar qualquer `NavSection 'whatsapp'`, item de sidebar WhatsApp e entrada `2026.10.15`. Se os commits não existirem localmente, implementar pelo código abaixo.
2. **RED — `nav.spec.ts`** (novo `describe`, ≤ 50 linhas):
   ```ts
   describe('canAccessPath', () => {
     it.each([
       ['/contacts', 'VIEWER', false],
       ['/dashboard', 'VIEWER', true],
       ['/contacts', 'ADMIN', true],
       ['/setores', 'ADMIN', true],
       ['/setores', 'OPERATOR', false],
       ['/setores/abc', 'ADMIN', true],
       ['/rota-inexistente', 'ADMIN', false],
     ] as const)('%s para %s → %s', (path, role, expected) => {
       expect(canAccessPath(path, role)).toBe(expected);
     });
     it('sem papel nunca acessa', () => {
       expect(canAccessPath('/dashboard', undefined)).toBe(false);
     });
   });
   ```
   Rodar `cd frontend && timeout 600 gate --test src/lib/nav.spec.ts` → falha (função não existe).
3. **GREEN — `nav.ts`:**
   ```ts
   function navItemFor(path: string): NavItem | undefined {
     // Longest `to` first so `/campaigns` beats `/` on nested paths.
     return [...NAV]
       .sort((a, b) => b.to.length - a.to.length)
       .find((n) => isNavActive(path, n.to));
   }

   /** O papel acessa a rota? Decide pelo item do NAV de prefixo mais longo; fora do NAV ou sem papel → false. */
   export function canAccessPath(path: string, role?: NavRole): boolean {
     if (!role) return false;
     return Boolean(navItemFor(path)?.roles?.includes(role));
   }
   ```
   e `navLabelFor` passa a usar `navItemFor(path)?.label ?? '—'` (mantendo o caso `/campaigns/`). Rodar o mesmo comando → verde.
4. **RED — `release-notes-dialog.spec.tsx`** (novo `describe`): mockar `@/release-notes` com `vi.mock` para devolver uma nota com itens `where: '/contacts'`, `'/dashboard'` e `'/setores'`; setar `useAuthStore.setState({ user: { id: 'u', email: 'a@b.c', name: null, role } })` e renderizar `<ReleaseNotesDialog open onOpenChange={() => {}} />` com o wrapper de router já usado no arquivo. Casos: VIEWER → só 1 link "Ver" (dashboard); ADMIN → 3; OPERATOR → 2 (sem `/setores`); sem usuário → 0. Usar `screen.queryAllByRole('link', { name: /ver/i })`. Rodar `cd frontend && timeout 600 gate --test src/components/layout/release-notes-dialog.spec.tsx` → falha.
5. **GREEN — `release-notes-dialog.tsx`:** extrair o `<li>` do item para `function ReleaseItem({ item, onNavigate }: { item: ReleaseNoteItem; onNavigate: () => void })`, que lê `const role = useAuthStore((s) => s.user?.role) as NavRole | undefined` e renderiza o `<Link to={item.where}>` (mesmas classes de hoje) só se `item.where && canAccessPath(item.where, role)`. Rodar → verde.
6. **Fechamento:** `cd frontend && timeout 600 gate --changed --base origin/main` verde.

---

### Task 2: Telefone no usuário + ligação ao contato + script de fusão

**Files**
- Modify: `backend/prisma/schema.prisma` (model `User`; back-relation em `model Contact`)
- Create: `backend/prisma/migrations/20261016090000_user_phone_contact/migration.sql`
- Create: `backend/src/modules/users/user-phone.service.ts`
- Modify: `backend/src/modules/users/users.service.ts`, `users.repository.ts`, `users.module.ts`, `dto/create-user.dto.ts`, `dto/update-user.dto.ts`
- Modify: `backend/src/schemas/contracts/user.schema.ts`
- Modify: `backend/prisma/merge-duplicate-phone-contacts.ts`
- Test (create): `backend/src/modules/users/user-phone.service.spec.ts`, `backend/src/modules/users/users.service.phone.spec.ts`
- Test (modify): `backend/src/modules/users/dto/create-user.dto.spec.ts`; `backend/src/modules/users/users.service.spec.ts` (construtor ganha o mock de `UserPhoneService`; as chamadas de `createUser` das linhas ~112, 120, 132 passam a levar `phone` — com o mock de `phones.normalize`/`resolveContactId` — e as asserções `toHaveBeenCalledWith` do `repo.create` ganham `phoneE164`/`contact`); `backend/src/modules/users/users.controller.spec.ts` (a chamada de `createUser` da linha ~30 ganha `phone`; ajustar a asserção do body repassado); `backend/src/modules/users/users.repository.integration.spec.ts` (1 caso); `backend/prisma/merge-duplicate-phone-contacts.spec.ts` (`describe` novo no fim, antes de `maskPhonesInLog`)

**Ownership:** todos os arquivos acima (inclusive `schema.prisma` até T2 integrar).

**Interfaces**
- Consumes: `normalizeToE164(raw: string, defaultCountry = 'BR'): string | null`, `brazilianPhoneVariants(e164: string): string[]` (`contacts/phone.util.ts`); `ContactsService.create(input: CreateContact)` → `{ id, ... }` e `ContactsService.update(id: string, data: UpdateContact)` (`contacts/contacts.service.ts:61,156`); `ContactsRepository.findByAnyBrForm(phoneE164): Promise<Contact | null>` (`contacts/contacts.repository.ts:179`); `ContactPhoneConflictError` (`contacts/errors/contacts.errors.ts:14`); `ValidationError(message, detail?, code)` e `ConflictError(message, code)` (`shared/errors/domain.error.ts`). `ContactsModule` exporta `[ContactsService, ContactsRepository]`; nenhum módulo importa `UsersModule` além do `AppModule`, logo `UsersModule → ContactsModule` não fecha ciclo.
- Produces:
  - `UsersRepository.findIdByPhoneVariants(variants: string[]): Promise<string | null>`; `UsersRepository.findContactId(id: string): Promise<string | null>` (só para o PATCH com o mesmo número); `USER_SUMMARY_SELECT` com `phoneE164: true`; `UserSummary.phoneE164: string | null` (`contactId` **não** entra no summary nem no contrato).
  - `@Injectable() class UserPhoneService` com `normalize(raw: string): string` (lança `user.invalid_phone`), `assertAvailable(phoneE164: string, selfId?: string): Promise<void>` (lança `user.phone_taken`), `resolveContactId(phoneE164: string, displayName: string): Promise<string>`, `static isPhoneUniqueViolation(err: unknown): boolean`.
  - `UsersService.createUser(input: { email; name?; role; sectorId?; phone: string }, createdById)`; `UserPatch.phone?: string`.
  - Contrato `userSummarySchema.phoneE164: z.string().nullable()`.
  - `mergePair` reaponta `User.contactId` (perdedor → sobrevivente) dentro da transação do par, **só** se o sobrevivente não tiver usuário; se tiver, acrescenta `'user'` ao array `conflicts` que `mergePair` já devolve (vira `report.conflicts[].fields`), sem falhar o par.

**Risco:** `Crítico: contrato público + migração + transação com perda de dados — POST /users passa a exigir phone, a migração adiciona colunas/FK em User, e o script de deploy que APAGA contatos duplicados passa a reapontar User.contactId antes do delete.`

**Contexto vinculado**
- GC2: `user.invalid_phone` 400 (`new ValidationError('Telefone inválido', 'Use DDD + número, com ou sem +55', 'user.invalid_phone')`); `user.phone_taken` 409 (`new ConflictError('Phone already taken', 'user.phone_taken')`).
- GC3: normalizar com `normalizeToE164(raw, 'BR')`; igualdade de titular por `brazilianPhoneVariants(e164)` — as duas grafias do 9º dígito são o mesmo número em cadastro, conflito e ligação.
- GC4: `User.phoneE164 String? @unique`, `User.contactId String? @unique`, FK `Contact` `onDelete: SetNull`; migração `20261016090000_user_phone_contact` só aditiva; existentes `null`.
- GC5: `POST /users` `phone` obrigatório; `PATCH /users/:id` `phone` opcional sem `null`; `GET /users` item ganha `phoneE164: string | null`; contrato backend `user.schema.ts` atualizado (frontend na T3).
- GC6: contato existente em qualquer variante → aponta para ele; nome só se vazio; consentimento intocado; senão `ContactsService.create` (auditoria, reidratação, ligação de conversas); nome = nome do usuário ou e-mail; trocar número religa, contato antigo fica.
- Spec §1: edição — quem já tem telefone não pode apagá-lo (sem `null`/vazio no PATCH); usuário antigo sem telefone pode continuar sem ou ganhar um.
- Spec §1 / risco 3: `merge-duplicate-phone-contacts.ts` roda com `--apply` em todo deploy (`docker-compose.prod.yml:103`) e APAGA o contato perdedor; sem reapontar, `onDelete: SetNull` desligaria o usuário a cada deploy. O reapontamento entra em `mergePair`, na mesma transação, antes de `db.contact.delete`. Par em `failedPairs` faz o script sair com código ≠ 0 (`merge-duplicate-phone-contacts.ts:939-953`) e o compose encadeia com `&&` → **deploy bloqueado**; por isso o caso "sobrevivente já tem usuário" (o `@unique` de `contactId` recusaria) não pode virar exceção: vai para `conflicts` (relatório, exit 0) e o usuário do perdedor fica sem contato pelo `SetNull` (religa ao editar o telefone).
- Risco documentado (M7, sem reordenar): `createUser` cria/liga o contato **antes** de `repo.create`; numa corrida de e-mail (P2002 em `email`) o contato criado fica sem usuário. Aceito: é um `Contact` legítimo do número (o próximo cadastro com esse telefone liga a ele); inverter a ordem deixaria usuário gravado sem contato quando a ligação falha, e `ContactsService.create` não participa de transação com `repo.create`. Comentar isso no código junto do `resolveContactId`.
- GC12 (aplicado aqui por coerência): o telefone não entra na metadata de `user.invited`/`user.profile_updated` (a auditoria `contact.create` do caminho normal de contatos fica como está).
- GC16: specs existentes > 50 linhas por `describe` não crescem — casos novos em arquivos novos.

**Steps**

1. **Verificar no Step 1.**
   - `npx prisma --version` (no `backend/`): se ≥ 7, o diff usa `--from-schema`/`--to-schema` em vez de `--from-schema-datamodel`/`--to-schema-datamodel`.
   - Ler `dto/update-user.dto.ts:20-36` (o `refine` de "≥ 1 campo" precisa contar `phone`) e `users.service.ts` `toUpdateData` (não pode repassar `phone` cru ao Prisma).
   - Tipo `CreateContact`/`UpdateContact` (import em `contacts.service.ts`): se `tags` for obrigatório no tipo, passar `tags: []`; confirmar que `update(id, { name })` é aceito.
   - Nome do campo Prisma em `UsersRepository` (`this.prisma`?) e se `users.service.spec.ts` mocka `argon2` (copiar o `vi.mock` para o spec novo).
   - Confirmar que `vitest` do backend inclui `prisma/**/*.spec.ts` (o spec atual `prisma/merge-duplicate-phone-contacts.spec.ts` roda no gate).
2. **Schema + migração.**
   - `cp prisma/schema.prisma /tmp/schema.before-t2.prisma`.
   - Em `model User`: `phoneE164 String? @unique`, `contactId String? @unique`, `contact Contact? @relation("UserContact", fields: [contactId], references: [id], onDelete: SetNull)`. Em `model Contact`: `user User? @relation("UserContact")`.
   - `mkdir -p prisma/migrations/20261016090000_user_phone_contact && npx prisma migrate diff --from-schema-datamodel /tmp/schema.before-t2.prisma --to-schema-datamodel prisma/schema.prisma --script > prisma/migrations/20261016090000_user_phone_contact/migration.sql`. Conferir que o SQL tem só `ALTER TABLE "User" ADD COLUMN "phoneE164" TEXT, ADD COLUMN "contactId" TEXT`, dois `CREATE UNIQUE INDEX` e `ADD CONSTRAINT "User_contactId_fkey" ... ON DELETE SET NULL ON UPDATE CASCADE` — nenhum `DROP`/`ALTER COLUMN`.
   - `npx prisma validate && npx prisma generate`.
3. **RED — DTO** (`dto/create-user.dto.spec.ts`, `describe` novo):
   ```ts
   describe('createUserSchema — phone', () => {
     it('exige phone', () => {
       expect(createUserSchema.safeParse({ email: 'a@b.com' }).success).toBe(false);
     });
     it('aceita phone com DDD e apara espaços', () => {
       expect(createUserSchema.parse({ email: 'a@b.com', phone: ' (92) 99123-4567 ' }).phone).toBe('(92) 99123-4567');
     });
   });
   describe('updateUserSchema — phone', () => {
     it('aceita só phone como mudança', () => {
       expect(updateUserSchema.safeParse({ phone: '92991234567' }).success).toBe(true);
     });
     it.each([null, ''])('recusa phone %j (não dá para apagar)', (phone) => {
       expect(updateUserSchema.safeParse({ phone }).success).toBe(false);
     });
   });
   ```
   (importar `updateUserSchema` de `./update-user.dto`). `cd backend && timeout 600 gate --test src/modules/users/dto/create-user.dto.spec.ts` → falha.
4. **GREEN — DTO:** `create`: `phone: z.string().trim().min(1).max(40)`; `update`: `phone: z.string().trim().min(1).max(40).optional()` e o `refine` conta `v.phone !== undefined`. Verde.
5. **RED — `user-phone.service.spec.ts`** (≤ 50 linhas por `describe`):
   ```ts
   import { describe, it, expect, beforeEach } from 'vitest';
   import { mockDeep, type DeepMockProxy } from 'vitest-mock-extended';
   import { UserPhoneService } from './user-phone.service';
   import type { UsersRepository } from './users.repository';
   import type { ContactsService } from '../contacts/contacts.service';
   import type { ContactsRepository } from '../contacts/contacts.repository';
   import { ContactPhoneConflictError } from '../contacts/errors/contacts.errors';

   let users: DeepMockProxy<UsersRepository>;
   let contacts: DeepMockProxy<ContactsService>;
   let contactsRepo: DeepMockProxy<ContactsRepository>;
   let svc: UserPhoneService;
   const NINE = '+5592991234567';
   const EIGHT = '+559291234567';
   const caught = (fn: () => unknown) => { try { fn(); } catch (e) { return e; } return undefined; };

   beforeEach(() => {
     users = mockDeep(); contacts = mockDeep(); contactsRepo = mockDeep();
     svc = new UserPhoneService(users, contacts, contactsRepo);
   });

   describe('UserPhoneService.normalize/assertAvailable', () => {
     it('normaliza DDD sem +55 para E.164', () => {
       expect(svc.normalize('(92) 99123-4567')).toBe(NINE);
     });
     it('recusa número inválido com user.invalid_phone', () => {
       expect(caught(() => svc.normalize('123'))).toMatchObject({ code: 'user.invalid_phone', status: 400 });
     });
     it('acusa user.phone_taken quando outro usuário tem a variante de 8 dígitos', async () => {
       users.findIdByPhoneVariants.mockResolvedValue('u-other');
       await expect(svc.assertAvailable(NINE, 'u-self')).rejects.toMatchObject({ code: 'user.phone_taken', status: 409 });
       expect(users.findIdByPhoneVariants).toHaveBeenCalledWith(expect.arrayContaining([NINE, EIGHT]));
     });
     it('não acusa conflito com o próprio usuário', async () => {
       users.findIdByPhoneVariants.mockResolvedValue('u-self');
       await expect(svc.assertAvailable(NINE, 'u-self')).resolves.toBeUndefined();
     });
   });

   describe('UserPhoneService.resolveContactId', () => {
     it('contato existente com nome: só devolve o id (sem create/update)', async () => {
       contactsRepo.findByAnyBrForm.mockResolvedValue({ id: 'c1', name: 'Planilha', phoneE164: EIGHT } as never);
       await expect(svc.resolveContactId(NINE, 'Ana')).resolves.toBe('c1');
       expect(contacts.create).not.toHaveBeenCalled();
       expect(contacts.update).not.toHaveBeenCalled();
     });
     it('liga ao contato existente na outra grafia e preenche só o nome vazio', async () => {
       contactsRepo.findByAnyBrForm.mockResolvedValue({ id: 'c1', name: null, phoneE164: EIGHT } as never);
       await expect(svc.resolveContactId(NINE, 'Ana')).resolves.toBe('c1');
       expect(contactsRepo.findByAnyBrForm).toHaveBeenCalledWith(NINE);
       expect(contacts.update).toHaveBeenCalledWith('c1', { name: 'Ana' });
     });
     it('sem contato: cria pelo ContactsService', async () => {
       contactsRepo.findByAnyBrForm.mockResolvedValue(null);
       contacts.create.mockResolvedValue({ id: 'c2' } as never);
       await expect(svc.resolveContactId(NINE, 'Ana')).resolves.toBe('c2');
       expect(contacts.create).toHaveBeenCalledWith(expect.objectContaining({ phone: NINE, name: 'Ana' }));
     });
     it('corrida no create: relê o contato que venceu', async () => {
       contactsRepo.findByAnyBrForm.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'c3', name: 'x' } as never);
       contacts.create.mockRejectedValue(new ContactPhoneConflictError(NINE));
       await expect(svc.resolveContactId(NINE, 'Ana')).resolves.toBe('c3');
     });
   });
   ```
   `cd backend && timeout 600 gate --test src/modules/users/user-phone.service.spec.ts` → falha.
6. **GREEN — `user-phone.service.ts`** + `UsersRepository.findIdByPhoneVariants` + `users.module.ts` (`imports: [AuthModule, ContactsModule]`, `providers: [UsersService, UsersRepository, UserPhoneService]`):
   ```ts
   @Injectable()
   export class UserPhoneService {
     constructor(
       private readonly users: UsersRepository,
       private readonly contacts: ContactsService,
       private readonly contactsRepo: ContactsRepository,
     ) {}

     normalize(raw: string): string {
       const phoneE164 = normalizeToE164(raw, 'BR');
       if (!phoneE164) {
         throw new ValidationError('Telefone inválido', 'Use DDD + número, com ou sem +55', 'user.invalid_phone');
       }
       return phoneE164;
     }

     async assertAvailable(phoneE164: string, selfId?: string): Promise<void> {
       const ownerId = await this.users.findIdByPhoneVariants(brazilianPhoneVariants(phoneE164));
       if (ownerId && ownerId !== selfId) throw new ConflictError('Phone already taken', 'user.phone_taken');
     }

     async resolveContactId(phoneE164: string, displayName: string): Promise<string> {
       const existing = await this.contactsRepo.findByAnyBrForm(phoneE164);
       if (existing) {
         if (!existing.name) await this.contacts.update(existing.id, { name: displayName });
         return existing.id;
       }
       try {
         return (await this.contacts.create({ phone: phoneE164, name: displayName })).id;
       } catch (err) {
         if (!(err instanceof ContactPhoneConflictError)) throw err;
         const raced = await this.contactsRepo.findByAnyBrForm(phoneE164);
         if (!raced) throw err;
         return raced.id;
       }
     }

     /** P2002 em phoneE164/contactId (corrida entre dois cadastros) → user.phone_taken. */
     static isPhoneUniqueViolation(err: unknown): boolean {
       return err instanceof Prisma.PrismaClientKnownRequestError
         && err.code === 'P2002'
         && /phoneE164|contactId/.test(String(err.meta?.target ?? ''));
     }
   }
   ```
   ```ts
   // users.repository.ts
   async findIdByPhoneVariants(variants: string[]): Promise<string | null> {
     const row = await this.prisma.user.findFirst({ where: { phoneE164: { in: variants } }, select: { id: true } });
     return row?.id ?? null;
   }
   ```
   `async findContactId(id: string): Promise<string | null>` (`user.findUnique({ where: { id }, select: { contactId: true } })` → `?.contactId ?? null`, usado no passo 8) e `phoneE164: true` em `USER_SUMMARY_SELECT`. Verde.
7. **RED — `users.service.phone.spec.ts`** (mocks `repo`, `audit`, `refresh`, `phones: DeepMockProxy<UserPhoneService>`; `svc = new UsersService(repo, audit, refresh, phones)`; mesmo `vi.mock('argon2')` do spec existente):
   - "cadastra com telefone normalizado ligado ao contato": `phones.normalize` → `NINE`, `phones.resolveContactId` → `'c1'`; esperar `phones.assertAvailable` chamado com `NINE`, `resolveContactId(NINE, 'a@b.com')` (sem nome → e-mail), `repo.create` com `expect.objectContaining({ phoneE164: NINE, contact: { connect: { id: 'c1' } } })` e `JSON.stringify(audit.log.mock.calls)` sem `NINE`.
   - "telefone inválido não cria nada": `phones.normalize` lança `user.invalid_phone` → `repo.create` não chamado e `resolveContactId` não chamado.
   - "P2002 de phoneE164 no create vira user.phone_taken": `repo.create.mockRejectedValue(new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'x', meta: { target: ['phoneE164'] } }))` → `rejects.toMatchObject({ code: 'user.phone_taken' })`.
   - "PATCH troca o número e religa ao contato do número novo": `repo.findById` → usuário com `phoneE164: '+5592988887777'`; `updateUser('u1', { phone: '92991234567' }, 'admin')`; `repo.updateWithLastAdminGuard` com `expect.objectContaining({ phoneE164: NINE, contact: { connect: { id: 'c1' } } })`; `assertAvailable(NINE, 'u1')`.
   - "PATCH com o mesmo número e contato ligado não religa": `phones.normalize` devolve o `phoneE164` atual e `repo.findContactId` → `'c0'` → `resolveContactId` não chamado e o `data` não tem `phoneE164`/`contact`.
   - "PATCH com o mesmo número e contactId null religa ao contato": mesmo número, `repo.findContactId` → `null` (contato apagado, `SetNull`) → `resolveContactId(NINE, …)` chamado e `data` com `contact: { connect: { id: 'c1' } }`.
   - "usuário antigo sem telefone continua sem": `updateUser('u1', { name: 'X' }, 'admin')` → `phones.normalize` não chamado e o `data` não tem `phoneE164`.
   `cd backend && timeout 600 gate --test src/modules/users/users.service.phone.spec.ts` → falha.
8. **GREEN — `users.service.ts`:** construtor ganha `private readonly phones: UserPhoneService` (atualizar a instanciação e as chamadas de `createUser` sem `phone` em `users.service.spec.ts:~112,120,132` e `users.controller.spec.ts:~30`, conforme a lista de Test (modify)); `createUser`: `const phoneE164 = this.phones.normalize(input.phone)` antes de `findByEmail`; depois de `assertCreatable`, `await this.phones.assertAvailable(phoneE164)`; depois do hash, `const contactId = await this.phones.resolveContactId(phoneE164, input.name?.trim() || input.email)`; `createInvitation` recebe `{ phoneE164, contactId }` e grava `phoneE164` + `contact: { connect: { id: contactId } }`; envolver `repo.create` em `try/catch` que relança `ConflictError('Phone already taken','user.phone_taken')` quando `UserPhoneService.isPhoneUniqueViolation(err)`. `updateUser`: novo `private async phoneUpdate(user: UserSummary, raw: string | undefined): Promise<Prisma.UserUpdateInput>` (`undefined` → `{}`; normaliza; igual ao atual **e** `await this.repo.findContactId(user.id)` não-null → `{}`; igual ao atual com `contactId` null → só religa (`{ contact: { connect: { id } } }`, sem regravar `phoneE164`); `assertAvailable(phoneE164, user.id)`; `resolveContactId(phoneE164, user.name?.trim() || user.email)`; devolve `{ phoneE164, contact: { connect: { id } } }`), mesclado ao `data` de `toUpdateData` (que deixa de ver `phone`); a mesma tradução de P2002 em volta de `lastAdminGuard`. Auditoria sem telefone. Contrato `user.schema.ts`: `phoneE164: z.string().nullable()`; `toUserSummary` copia `phoneE164`. Verde; rodar também `timeout 600 gate --test src/modules/users/users.service.spec.ts` e `src/modules/users/users.controller.spec.ts`.
9. **RED — `describe` novo em `prisma/merge-duplicate-phone-contacts.spec.ts`** (no fim, antes de `describe('maskPhonesInLog')`; ≤ 50 linhas). Reaproveita o setup do arquivo em vez de mocks à mão — `collectEvidence` faz outras consultas (`conversation.findFirst`, `message.findFirst`, `conversation.findUnique`) que o `beforeEach` da linha 63 já arma:
   ```ts
   describe('mergeDuplicatePhoneContacts — usuário ligado ao contato descartado', () => {
     let db: DeepMockProxy<PrismaClient>;
     const pessoa = (id: string, phoneE164: string) => ({
       id, phoneE164, name: null, city: null, group: null, tags: [], whatsappValid: null,
       createdAt: new Date('2026-07-08T10:00:00Z'),
     });
     beforeEach(() => {
       db = mockDeep<PrismaClient>();
       db.contact.findMany.mockResolvedValue([pessoa('c9', '+5592991234567'), pessoa('c8', '+559291234567')] as never);
       db.importItem.count.mockResolvedValue(0 as never);
       db.message.count.mockResolvedValue(0 as never);
       db.conversation.findMany.mockResolvedValue([] as never);
       db.conversation.findFirst.mockResolvedValue(null as never);
       db.message.findFirst.mockResolvedValue(null as never);
       db.conversation.findUnique.mockResolvedValue(null as never);
       armaTransacaoEColisoes(db);
       db.user.findFirst.mockImplementation((async (a: { where: { contactId: string } }) =>
         (a.where.contactId === 'c8' ? { id: 'u-perdedor' } : null)) as never);
     });
     it('reaponta User.contactId do perdedor para o sobrevivente antes de apagar', async () => {
       const r = await mergeDuplicatePhoneContacts(db, { apply: true });
       expect(r.merges[0]).toMatchObject({ survivorId: 'c9', deletedId: 'c8' });
       expect(db.user.updateMany).toHaveBeenCalledWith({ where: { contactId: 'c8' }, data: { contactId: 'c9' } });
       expect(db.user.updateMany.mock.invocationCallOrder[0]).toBeLessThan(db.contact.delete.mock.invocationCallOrder[0]);
     });
     it("sobrevivente já tem usuário: registra 'user' em conflicts, não reaponta e não falha", async () => {
       db.user.findFirst.mockResolvedValue({ id: 'u-qualquer' } as never);
       const r = await mergeDuplicatePhoneContacts(db, { apply: true });
       expect(r.failedPairs).toHaveLength(0);
       expect(r.conflicts[0]?.fields).toContain('user');
       expect(db.user.updateMany).not.toHaveBeenCalled();
     });
     it('não toca User no dry-run', async () => {
       await mergeDuplicatePhoneContacts(db, { apply: false });
       expect(db.user.updateMany).not.toHaveBeenCalled();
     });
   });
   ```
   (empate sem evidência → `formato` → sobrevive o de 13 dígitos `c9`; se o critério real eleger outro, ajustar só os ids esperados). Se o detector de duplicação acusar o `beforeEach` repetido, extrair as linhas 64–72 para uma função de módulo `armaParSemEvidencia(db, contatos)` usada pelos dois `beforeEach`. `cd backend && timeout 600 gate --test prisma/merge-duplicate-phone-contacts.spec.ts` → falha.
10. **GREEN — script:** em `mergePair`, depois do `mergeFields` (≈ linha 790, que produz o array `conflicts` devolvido na linha ≈ 811) e antes de `db.contact.delete`:
    ```ts
    // O usuário da equipe ligado ao gêmeo segue a pessoa: User.contactId é
    // onDelete: SetNull — sem isto, todo deploy desligaria o usuário do contato.
    // Se o sobrevivente JÁ tem usuário, o @unique recusaria: não pode virar
    // failedPairs (exit != 0 bloqueia o deploy) — vai para conflicts e o
    // usuário do perdedor fica sem contato (religa ao editar o telefone).
    const loserUser = await db.user.findFirst({ where: { contactId: loser.id }, select: { id: true } });
    if (loserUser) {
      const survivorUser = await db.user.findFirst({ where: { contactId: survivor.id }, select: { id: true } });
      if (survivorUser) conflicts.push('user');
      else if (apply) await db.user.updateMany({ where: { contactId: loser.id }, data: { contactId: survivor.id } });
    }
    ```
    As leituras valem no dry-run (o relatório mostra o conflito antes do `--apply`); a escrita só com `apply`. Não alterar o tipo `MergeReport` nem o log (telefone continua mascarado; `conflicts` já é impresso nas linhas ≈ 884/916). Verde (o `describe` novo e os existentes do arquivo).
11. **Integração (repositório):** em `users.repository.integration.spec.ts`, `describe` novo ≤ 50 linhas: cria `Contact` (`+559291234567`) e `User` com `phoneE164: '+5592991234567'`, `contactId`; `findIdByPhoneVariants(['+5592991234567','+559291234567'])` devolve o id; `prisma.contact.delete` deixa `user.contactId === null` (FK SetNull). `cd backend && timeout 600 gate --test src/modules/users/users.repository.integration.spec.ts` — exige Docker (testcontainers); sem Docker, registrar como lacuna no relatório (o job `backend-tests` do CI roda).
12. **Fechamento:** `cd backend && timeout 600 gate --changed --base origin/main` verde.

---

### Task 3: Tela "Cadastrar usuário" com Telefone

**Files**
- Create: `frontend/src/lib/format-phone.ts`, `frontend/src/lib/format-phone.spec.ts`
- Create: `frontend/src/features/users/phone-errors.ts`, `frontend/src/features/users/phone-errors.spec.ts`
- Modify: `frontend/src/features/users/schemas.ts`, `frontend/src/features/users/components/invite-user-dialog.tsx`, `frontend/src/features/users/components/edit-user-dialog.tsx`, `frontend/src/features/users/edit-user-payload.ts`, `frontend/src/routes/_authenticated/users/index.tsx`
- Test (modify): `frontend/src/features/users/components/invite-user-dialog.spec.tsx`, `frontend/src/routes/_authenticated/users/index.spec.tsx`, spec existente do `edit-user-dialog`/`edit-user-payload` (se houver; senão criar `frontend/src/features/users/components/edit-user-dialog.phone.spec.tsx`)
- Create (e2e): `frontend/e2e/users-phone.spec.ts`

**Ownership:** arquivos acima.

**Interfaces**
- Consumes: contrato T2 (`POST /users` com `phone`, `PATCH /users/:id` com `phone?`, `GET /users` com `phoneE164: string | null`; erros `user.invalid_phone` 400 e `user.phone_taken` 409 no corpo `{ code, detail? }`); `useInviteUser`/`useUpdateUser` (`features/users/api.ts:69,80`); `HTTPError` do `ky`.
- Produces: `export function formatPhoneBR(e164: string | null | undefined): string` (usado também pela T5); `export async function userPhoneFieldError(err: unknown): Promise<string | null>`; `userSummarySchema.phoneE164: z.string().nullable()`; `inviteUserSchema.phone` obrigatório; `editUserSchemaFor(hadPhone: boolean)`.

**Risco:** médio — UI de cadastro consumindo o contrato novo; validação real é do backend.

**Contexto vinculado**
- GC5: `POST /users` `phone` obrigatório; `PATCH` `phone` opcional sem `null`; `GET /users` `phoneE164: string | null`; schema do frontend muda junto do contrato do backend.
- GC2: `user.invalid_phone` 400 e `user.phone_taken` 409 viram erro **no campo** Telefone (`form.setError('phone', …)`), como `contact-form-dialog.tsx:79-86` faz com `contact.phone_conflict`/`contact.invalid_phone`.
- GC14: "Cadastrar usuário" (botão da página e título), "Cadastrar"/"Cadastrando...", campo "Telefone (WhatsApp)", coluna "Telefone" com número formatado ou "—". O fluxo de senha temporária (`TemporaryPasswordModal`) não muda.
- Spec §1 edição: campo aparece preenchido; quem já tem telefone pode trocar, não apagar; usuário antigo sem telefone pode continuar sem ou ganhar um.
- Aceite 1–2.
- GC16: funções/`describe` ≤ 50 linhas.

**Steps**

1. **Verificar no Step 1.** Ler `edit-user-payload.ts` (assinatura e como compara com o original), o padrão de mocks de `invite-user-dialog.spec.tsx` (≈ linhas 90–140) e de `users/index.spec.tsx` (≈ 100), e se já existe helper de erro de API compartilhado (`grep -rn "readErrorBody\|HTTPError" frontend/src/lib`). Conferir que nenhum spec de `frontend/e2e` abre o diálogo de usuário (hoje: `auth.setup.ts`, `login.spec.ts`, `import-and-contacts.spec.ts`).
2. **RED — `format-phone.spec.ts`:**
   ```ts
   describe('formatPhoneBR', () => {
     it.each([
       ['+5592991234567', '(92) 99123-4567'],
       ['+559291234567', '(92) 9123-4567'],
       ['+14155550100', '+14155550100'],
       [null, '—'],
     ] as const)('%s → %s', (input, out) => expect(formatPhoneBR(input)).toBe(out));
   });
   ```
   GREEN:
   ```ts
   export function formatPhoneBR(e164: string | null | undefined): string {
     if (!e164) return '—';
     const m = /^\+55(\d{2})(\d{4,5})(\d{4})$/.exec(e164);
     return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164;
   }
   ```
   `cd frontend && timeout 600 gate --test src/lib/format-phone.spec.ts`.
3. **RED/GREEN — `phone-errors.ts`:** spec com `new HTTPError(new Response(JSON.stringify({ code: 'user.phone_taken' }), { status: 409 }), new Request('http://x'), {} as never)` → `'Este telefone já está em uso por outro usuário.'`; `user.invalid_phone` → `'Telefone inválido. Use DDD + número, com ou sem +55.'`; outro código/erro não-HTTP → `null`. Implementação: lê `err.response.clone().json().catch(() => null)` e mapeia os dois códigos. `cd frontend && timeout 600 gate --test src/features/users/phone-errors.spec.ts`.
4. **Schemas:** `userSummarySchema` ganha `phoneE164: z.string().nullable()`; `inviteUserSchema` ganha `phone: z.string().trim().min(1, 'Telefone obrigatório').refine((v) => { const d = v.replace(/\D/g, ''); return d.length >= 10 && d.length <= 13; }, 'Informe DDD + número')`; `editUserSchemaFor(hadPhone)` = `editUserSchema` + `phone: hadPhone ? <mesma regra do invite> : z.string().trim().optional().refine((v) => !v || <mesma contagem 10–13>, 'Informe DDD + número')`. Extrair a regra de dígitos para uma `const phoneDigitsOk = (v: string) => …` no próprio `schemas.ts`.
5. **RED — `invite-user-dialog.spec.tsx`:** trocar as asserções "Convidar"/"Convidando..." (linhas ~108, 121, 135) por "Cadastrar usuário"/"Cadastrar"/"Cadastrando..."; casos novos em `describe` novo: (a) enviar sem telefone mostra "Telefone obrigatório" e não chama a mutação; (b) a mutação recebe `phone` digitado; (c) a mutação rejeita com `HTTPError` `user.phone_taken` → texto "Este telefone já está em uso por outro usuário." aparece junto do campo. `cd frontend && timeout 600 gate --test src/features/users/components/invite-user-dialog.spec.tsx` → falha.
6. **GREEN — `invite-user-dialog.tsx`:** título "Cadastrar usuário", botão "Cadastrar"/"Cadastrando..."; `InviteIdentity` ganha `<Input type="tel" autoComplete="tel" placeholder="(92) 99999-9999">` com label "Telefone (WhatsApp)"; no `catch` do submit, `const msg = await userPhoneFieldError(err); if (msg) { form.setError('phone', { message: msg }); return; }` antes do toast atual. Verde.
7. **RED/GREEN — edição:** spec do diálogo de edição (existente ou `edit-user-dialog.phone.spec.tsx`): (a) usuário com `phoneE164: '+5592991234567'` abre com "(92) 99123-4567" no campo; apagar e salvar mostra "Telefone obrigatório" e não chama a mutação; (b) trocar o número envia `phone` no payload; (c) usuário com `phoneE164: null` salva só o nome sem `phone` no payload; (d) `user.phone_taken` aparece no campo. Implementação: `defaultValues.phone = user.phoneE164 ? formatPhoneBR(user.phoneE164) : ''`; resolver com `editUserSchemaFor(Boolean(user.phoneE164))`; `edit-user-payload.ts` inclui `phone` só quando o campo foi alterado (`formState.dirtyFields.phone`) e não está vazio; mesmo mapeamento de erro do passo 6. `timeout 600 gate --test <spec do passo>`.
8. **RED/GREEN — lista** (`users/index.spec.tsx`): botão "Cadastrar usuário" (trocar a asserção da linha ~102); coluna "Telefone" com "(92) 99123-4567" para quem tem e "—" para quem não tem. `users/index.tsx`: botão (linha 101) "Cadastrar usuário"; `<TableHead>Telefone</TableHead>` depois de Email e `<TableCell>{formatPhoneBR(user.phoneE164)}</TableCell>` em `UserRow`; fixtures de `UserSummary` nos specs ganham `phoneE164`. `cd frontend && timeout 600 gate --test src/routes/_authenticated/users/index.spec.tsx`.
9. **e2e — `frontend/e2e/users-phone.spec.ts`** seguindo `import-and-contacts.spec.ts` (storageState do `auth.setup.ts`): ADMIN abre `/users`, clica "Cadastrar usuário", preenche e-mail `e2e-phone-${Date.now()}@example.com`, nome, telefone `92 9${String(Date.now()).slice(-8)}`, perfil ADMIN (dispensa setor), clica "Cadastrar", fecha o modal de senha temporária e espera a linha do e-mail com o telefone formatado. Local só `cd frontend && npx playwright test e2e/users-phone.spec.ts --list` (roda no CI).
10. **Fechamento:** `cd frontend && timeout 600 gate --changed --base origin/main` verde.

---

### Task 4a: Módulo team-whatsapp — modelos, política, rotas, enfileiramento

**Files**
- Modify: `backend/prisma/schema.prisma` (enums + 2 modelos + back-relations em `User` e `Channel`)
- Create: `backend/prisma/migrations/20261016100000_team_whatsapp/migration.sql`
- Modify: `backend/src/modules/queue/queue.constants.ts`, `backend/src/modules/queue/queue.module.ts`
- Create: `backend/src/modules/team-whatsapp/team-whatsapp.module.ts`, `team-whatsapp.controller.ts`, `team-whatsapp.service.ts`, `team-whatsapp.repository.ts`, `team-whatsapp.policy.ts`, `team-whatsapp.errors.ts`, `dto/create-team-dispatch.dto.ts`
- Create: `backend/src/schemas/contracts/team-whatsapp.schema.ts`
- Modify: `backend/src/app.module.ts` (import `TeamWhatsappModule`)
- Test (create): `backend/src/modules/team-whatsapp/team-whatsapp.policy.spec.ts`, `team-whatsapp.service.spec.ts`, `team-whatsapp.service.list.spec.ts`, `team-whatsapp.controller.spec.ts`, `dto/create-team-dispatch.dto.spec.ts`, `team-whatsapp.repository.integration.spec.ts` (exige Docker; sem Docker vira lacuna registrada)

**Ownership:** arquivos acima. `schema.prisma` só depois de T2 integrada.

**Interfaces**
- Consumes: `User.phoneE164`, `User.contact` (T2); `Sector.managerId`/`isActive`, `User.managedSectors` (`schema.prisma:117-135`, `:69`); `Channel` (`provider`, `isActive`, `name`, `phoneE164`, `connectionEvents { state, occurredAt }`); `ConsentService.isSuppressed(phoneE164: string): Promise<boolean>` (`consent/consent.service.ts:350`, módulo `@Global`); `AuditService.log(action, entity, entityId?, metadata?)` (`@Global`); `@InjectQueue(QUEUE_NAMES.TEAM_WHATSAPP_SEND)` (QueueModule `@Global` exporta `BullModule`); `@Roles(...)` (`auth/decorators/roles.decorator.ts`); `DomainError`, `ForbiddenError`.
- Produces:
  - `QUEUE_NAMES.TEAM_WHATSAPP_SEND: 'team-whatsapp.send'`; `export type TeamWhatsappSendJob = { recipientId: string }`.
  - Prisma: `TeamWhatsappDispatch { id, authorId?, targetType, targetId, targetLabel, channelId?, channel? (onDelete: SetNull), text, createdAt, recipients }`, `TeamWhatsappRecipient { id, dispatchId, userId?, userName, status, skipReason?, messageId?, errorCode?, createdAt, updatedAt }` — **contrato para T4b**: o processor lê `recipient.{ status, messageId }`, `recipient.user.{ phoneE164, contact { id, phoneE164 } }`, `recipient.dispatch.{ authorId, text, channel { id, provider, isActive } | null }` e escreve `status`/`skipReason`/`errorCode` e `messageId` — este **antes** do envio (fase 1: `Message` criada, destinatário ainda `QUEUED`), para a retentativa reaproveitar a mesma `Message`. `channel: null` (canal removido) → T4b marca `FAILED` `team_whatsapp.channel_invalid`.
  - `export const TEAM_PROVIDERS = ['GOZAP', 'EVOLUTION'] as const` (em `team-whatsapp.policy.ts`, usado por T4b).
  - Rotas e shapes de GC7; contrato zod em `schemas/contracts/team-whatsapp.schema.ts` (`teamTargetsResponseSchema`, `createTeamDispatchResponseSchema`, `teamDispatchListResponseSchema`) — **contrato para T5**.

**Risco:** `Crítico: autenticação/autorização + contrato público + migração — rotas novas abertas a SUPERVISOR/OPERATOR com política própria de gestor (Sector.managerId), e duas tabelas novas.`

**Contexto vinculado**
- GC7 (rotas, `@Roles('ADMIN','SUPERVISOR','OPERATOR')`, shapes exatos; POST → 202).
- GC8: remetente só com `role` ∈ {`ADMIN`,`SUPERVISOR`,`OPERATOR`} (gestor rebaixado a VIEWER mantém `managerId` e o JWT vale até 15 min — a política recusa mesmo assim); ADMIN ativo → qualquer usuário ativo e setor ativo; gestor = ativo e `managerId` de ≥1 setor **ativo** → esses setores e usuários ativos cujo `sectorId` é um deles **com o setor do alvo ativo** (checado em `target.sector.isActive`, não só no filtro `managedSectors: { where: { isActive: true } }` de `findActor`, que os specs de serviço mockam); demais (inclusive remetente inativo, alvo inexistente/inativo, setor inativo) → 403 `team_whatsapp.forbidden`. Histórico: ADMIN todos, gestor os próprios. Não existe helper de gestor hoje (`internal-communications.policy.ts` não usa `managerId`): criar `team-whatsapp.policy.ts`.
- GC7 (histórico): `channel: { id, name } | null` — `TeamWhatsappDispatch.channelId` nullable com `onDelete: SetNull`; remover o canal não apaga nem bloqueia; o front mostra "canal removido".
- Decisão do plano: `GET targets` e `GET dispatches` para quem não é ADMIN nem gestor também devolvem 403 `team_whatsapp.forbidden` (o front mostra o estado vazio nesse 403) — assim o contrato de `targets` fica exatamente o da spec e um ADMIN sem setores não cai no texto de "sem permissão".
- GC9: pessoa = o usuário; setor = membros ativos (remetente incluído se membro); sem telefone → `SKIPPED/NO_PHONE`; suprimido → `SKIPPED/SUPPRESSED`; zero enfileirados → 422 `team_whatsapp.no_recipients`, nada criado.
- GC10: canal só `isActive` com `provider` GOZAP/EVOLUTION, senão 422 `team_whatsapp.channel_invalid`; último `connectionEvents.state === 'close'` → 409 `team_whatsapp.channel_disconnected`; texto 1–2000, só-espaços inválido.
- GC11: nomes de modelos/enums, migração `20261016100000_team_whatsapp`, fila `'team-whatsapp.send'` com `attempts: 3`, `backoff: { type: 'exponential', delay: 5000 }`, `removeOnComplete: { age: 3600, count: 1000 }`, `removeOnFail: { age: 86400 }`, `jobId = recipientId`; não mexer em `WHATSAPP_SEND`.
- GC12: auditoria `team_whatsapp.dispatch` com `actorId`, `targetType`, `targetId`, `channelId`, `queued`, `skipped`; texto e telefones fora de logs e auditoria; supressão sempre, sem consentimento de marketing.
- Telefone para supressão: `user.contact?.phoneE164 ?? user.phoneE164` (o contato carrega a grafia que o merge elegeu como a que entrega).
- Ordem de validação do POST (decisão do plano): remetente → alvo + política (403) → canal (422/409) → destinatários (422) → grava → enfileira. Política antes do canal para não revelar canais a quem não pode.
- GC16.

**Steps**

1. **Verificar no Step 1.** Em `users.controller.ts`, como o id do ator é obtido (`req.user.sub` via `@Req()` ou decorator) — copiar. Em `create-user.dto.ts`, o import de `createZodDto`. Em `schema.prisma`: nome do campo de nome em `Channel` (`name`), relação `connectionEvents` e o tipo de `state`. (`TeamWhatsappDispatch.channel` usa `onDelete: SetNull` — decisão do controlador; não copiar o `Cascade` de `Conversation.instance`, que apagaria o histórico.) `grep -rn "QUEUE_NAMES)" backend/src --include=*.spec.ts` — se algum spec (ex.: `chat/chat.module.queues.spec.ts`) enumera as filas registradas, incluí-lo nos testes do passo 4.
2. **Schema + migração.** `cp prisma/schema.prisma /tmp/schema.before-t4a.prisma`; acrescentar:
   ```prisma
   enum TeamWhatsappTargetType { USER SECTOR }
   enum TeamWhatsappRecipientStatus { QUEUED SENT FAILED SKIPPED }
   enum TeamWhatsappSkipReason { NO_PHONE SUPPRESSED }

   model TeamWhatsappDispatch {
     id          String                  @id @default(cuid())
     authorId    String?
     author      User?                   @relation("TeamWhatsappDispatchAuthor", fields: [authorId], references: [id], onDelete: SetNull)
     targetType  TeamWhatsappTargetType
     targetId    String
     targetLabel String
     channelId   String?
     channel     Channel?                @relation(fields: [channelId], references: [id], onDelete: SetNull)
     text        String
     createdAt   DateTime                @default(now())
     recipients  TeamWhatsappRecipient[]

     @@index([createdAt])
     @@index([authorId, createdAt])
   }

   model TeamWhatsappRecipient {
     id         String                      @id @default(cuid())
     dispatchId String
     dispatch   TeamWhatsappDispatch        @relation(fields: [dispatchId], references: [id], onDelete: Cascade)
     userId     String?
     user       User?                       @relation("TeamWhatsappRecipientUser", fields: [userId], references: [id], onDelete: SetNull)
     userName   String
     status     TeamWhatsappRecipientStatus @default(QUEUED)
     skipReason TeamWhatsappSkipReason?
     messageId  String?                     // gravado ANTES do envio (fase 1 do processor); a retentativa reaproveita a mesma Message
     errorCode  String?
     createdAt  DateTime                    @default(now())
     updatedAt  DateTime                    @updatedAt

     @@index([dispatchId, status])
   }
   ```
   com back-relations `teamWhatsappDispatches TeamWhatsappDispatch[] @relation("TeamWhatsappDispatchAuthor")` e `teamWhatsappRecipients TeamWhatsappRecipient[] @relation("TeamWhatsappRecipientUser")` em `User`, e `teamWhatsappDispatches TeamWhatsappDispatch[]` em `Channel`. Telefone **não** é copiado para o destinatário (o processor relê do usuário). Gerar com `npx prisma migrate diff --from-schema-datamodel /tmp/schema.before-t4a.prisma --to-schema-datamodel prisma/schema.prisma --script > prisma/migrations/20261016100000_team_whatsapp/migration.sql` (sintaxe conforme a versão do Prisma); conferir que só há `CREATE TYPE`/`CREATE TABLE`/`CREATE INDEX`/`ADD CONSTRAINT`. `npx prisma validate && npx prisma generate`.
3. **Fila.** `queue.constants.ts`: `TEAM_WHATSAPP_SEND: 'team-whatsapp.send',` em `QUEUE_NAMES` e `export type TeamWhatsappSendJob = { recipientId: string };`. `queue.module.ts`: `BullModule.registerQueue({ name: QUEUE_NAMES.TEAM_WHATSAPP_SEND, defaultJobOptions: { attempts: 3, backoff: { type: 'exponential', delay: 5000 }, removeOnComplete: { age: 3600, count: 1000 }, removeOnFail: { age: 86400 } } })`.
4. **RED — `team-whatsapp.policy.spec.ts`:**
   ```ts
   const admin = { id: 'a', role: 'ADMIN', isActive: true, managedSectorIds: [] } as const;
   const manager = { id: 'm', role: 'OPERATOR', isActive: true, managedSectorIds: ['s1'] } as const;
   const plain = { id: 'p', role: 'SUPERVISOR', isActive: true, managedSectorIds: [] } as const;
   const viewerManager = { ...manager, role: 'VIEWER' } as const; // rebaixado, ainda com managerId
   const on = { isActive: true }, off = { isActive: false };
   describe('team-whatsapp policy', () => {
     it.each([
       [admin, { id: 's9', isActive: true }, true],
       [admin, { id: 's9', isActive: false }, false],
       [manager, { id: 's1', isActive: true }, true],
       [manager, { id: 's2', isActive: true }, false],
       [{ ...manager, isActive: false }, { id: 's1', isActive: true }, false],
       [plain, { id: 's1', isActive: true }, false],
       [viewerManager, { id: 's1', isActive: true }, false],
     ])('canSendToSector #%#', (actor, sector, ok) => expect(canSendToSector(actor, sector)).toBe(ok));
     it.each([
       [admin, { isActive: true, sectorId: null, sector: null }, true],
       [admin, { isActive: false, sectorId: 's1', sector: on }, false],
       [manager, { isActive: true, sectorId: 's1', sector: on }, true],
       [manager, { isActive: true, sectorId: 's1', sector: off }, false],
       [manager, { isActive: true, sectorId: 's2', sector: on }, false],
       [plain, { isActive: true, sectorId: 's1', sector: on }, false],
       [viewerManager, { isActive: true, sectorId: 's1', sector: on }, false],
     ])('canSendToUser #%#', (actor, target, ok) => expect(canSendToUser(actor, target)).toBe(ok));
     it('isTeamSender: ADMIN ativo ou gestor ativo com papel de escrita', () => {
       expect([admin, manager, plain, viewerManager].map(isTeamSender)).toEqual([true, true, false, false]);
     });
   });
   ```
   `cd backend && timeout 600 gate --test src/modules/team-whatsapp/team-whatsapp.policy.spec.ts` → falha.
5. **GREEN — `team-whatsapp.policy.ts`:**
   ```ts
   import type { Role } from '@prisma/client';
   export const TEAM_PROVIDERS = ['GOZAP', 'EVOLUTION'] as const;
   /** `managedSectorIds` só traz setores ATIVOS em que o ator é `managerId`. */
   export type TeamActor = { id: string; role: Role; isActive: boolean; managedSectorIds: readonly string[] };
   /** Papéis de escrita: VIEWER nunca envia, mesmo que ainda seja `managerId` de um setor. */
   const SENDER_ROLES: readonly Role[] = ['ADMIN', 'SUPERVISOR', 'OPERATOR'];
   export type TeamTargetUser = { isActive: boolean; sectorId: string | null; sector: { isActive: boolean } | null };
   export function isTeamSender(a: TeamActor): boolean {
     if (!a.isActive || !SENDER_ROLES.includes(a.role)) return false;
     return a.role === 'ADMIN' || a.managedSectorIds.length > 0;
   }
   export function canSendToSector(a: TeamActor, s: { id: string; isActive: boolean }): boolean {
     if (!isTeamSender(a) || !s.isActive) return false;
     return a.role === 'ADMIN' || a.managedSectorIds.includes(s.id);
   }
   export function canSendToUser(a: TeamActor, t: TeamTargetUser): boolean {
     if (!isTeamSender(a) || !t.isActive) return false;
     if (a.role === 'ADMIN') return true;
     // O setor do ALVO tem de estar ativo: não confiar só no filtro de findActor.
     return t.sectorId !== null && t.sector?.isActive === true && a.managedSectorIds.includes(t.sectorId);
   }
   ```
   `team-whatsapp.errors.ts`: `teamForbidden() = new ForbiddenError('Fora da política de envio da equipe', 'team_whatsapp.forbidden')`; `noRecipients() = new DomainError({ code: 'team_whatsapp.no_recipients', message: 'Nenhum destinatário válido', status: 422 })`; `channelInvalid()` (422 `team_whatsapp.channel_invalid`); `channelDisconnected() = new ConflictError('Canal desconectado', 'team_whatsapp.channel_disconnected')`. Verde.
6. **RED/GREEN — DTO** (`dto/create-team-dispatch.dto.spec.ts`): aceita `{ channelId:'c', text:'oi', target:{ type:'user', userId:'u' } }` e `{ … target:{ type:'sector', sectorId:'s' } }`; recusa `text: ''`, `text: '   '`, `text: 'x'.repeat(2001)`, `target.type: 'all'`; aceita `'x'.repeat(2000)`. Implementação:
   ```ts
   export const createTeamDispatchSchema = z.object({
     channelId: z.string().min(1),
     text: z.string().min(1).max(2000).refine((s) => s.trim().length > 0, 'Texto vazio'),
     target: z.discriminatedUnion('type', [
       z.object({ type: z.literal('user'), userId: z.string().min(1) }),
       z.object({ type: z.literal('sector'), sectorId: z.string().min(1) }),
     ]),
   });
   export class CreateTeamDispatchDto extends createZodDto(createTeamDispatchSchema) {}
   export type CreateTeamDispatchInput = z.infer<typeof createTeamDispatchSchema>;
   ```
   `timeout 600 gate --test src/modules/team-whatsapp/dto/create-team-dispatch.dto.spec.ts`.
7. **Repositório** (`team-whatsapp.repository.ts`, `@Injectable`, `PrismaService`), métodos:
   - `findActor(id): Promise<TeamActor | null>` — `user.findUnique({ where: { id }, select: { id, role, isActive, managedSectors: { where: { isActive: true }, select: { id: true } } } })` → `managedSectorIds`.
   - `findTargetUser(id)` — `select: { id, name, email, isActive, sectorId, sector: { select: { isActive: true } }, phoneE164: true, contact: { select: { phoneE164: true } } }` (o `sector` alimenta `canSendToUser`).
   - `findSectorWithActiveMembers(id)` — `select: { id, name, isActive, members: { where: { isActive: true }, orderBy: { name: 'asc' }, select: <mesmo do findTargetUser> } }`.
   - `findChannel(id)` — `select: { id, name, provider, isActive, connectionEvents: { orderBy: { occurredAt: 'desc' }, take: 1, select: { state: true } } }`.
   - `listEligibleChannels()` — `where: { isActive: true, provider: { in: [...TEAM_PROVIDERS] } }`, `select: { id, name, phoneE164, provider }`, `orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }]`.
   - `listSectors(onlyIds: string[] | null)` — `where: { isActive: true, ...(onlyIds ? { id: { in: onlyIds } } : {}) }`, `orderBy: { name: 'asc' }`, `select: { id, name, code, members: { orderBy: { name: 'asc' }, select: { id, name, email, phoneE164, isActive } } }`.
   - `createDispatch(data: { authorId; targetType; targetId; targetLabel; channelId; text; recipients: Array<{ userId; userName; status; skipReason }> })` → `teamWhatsappDispatch.create({ data: { …, recipients: { create: recipients } }, select: { id: true, recipients: { select: { id: true, status: true } } } })`.
   - `markFailed(ids: string[], errorCode: string)` — `updateMany({ where: { id: { in: ids }, status: 'QUEUED' }, data: { status: 'FAILED', errorCode } })`.
   - `listDispatches(authorId: string | null)` — 20 mais novos (`orderBy: { createdAt: 'desc' }, take: 20`), `select: { id, createdAt, targetType, targetId, targetLabel, author: { select: { id, name, email } }, channel: { select: { id, name } } }`; e `countByStatus(ids)` — `teamWhatsappRecipient.groupBy({ by: ['dispatchId', 'status'], where: { dispatchId: { in: ids } }, _count: { _all: true } })`.
8. **RED — `team-whatsapp.service.spec.ts`** (mocks `repo`, `consent`, `audit`, `queue: mockDeep<Queue<TeamWhatsappSendJob>>()`; um `describe` por grupo, ≤ 50 linhas cada):
   - "gestor enviando a setor que não gerencia recebe 403" (`findActor` → gestor de `s1`; alvo `s2` ativo) → `rejects.toMatchObject({ code: 'team_whatsapp.forbidden', status: 403 })` e `repo.createDispatch`/`queue.addBulk` não chamados.
   - "gestor enviando a usuário de outro setor recebe 403"; "remetente inativo recebe 403"; "gestor rebaixado a VIEWER recebe 403" (`findActor` → `role: 'VIEWER'`, `managedSectorIds: ['s1']`); "setor desativado depois de carregar a tela recebe 403" (`isActive: false`).
   - "gestor → usuário de setor desativado → 403": `findActor` → gestor com `managedSectorIds: ['s1']` (o mock ignora o filtro do repositório); `findTargetUser` → `{ isActive: true, sectorId: 's1', sector: { isActive: false }, … }` → `rejects.toMatchObject({ code: 'team_whatsapp.forbidden', status: 403 })`, sem `createDispatch`.
   - "pessoa sem telefone → 422 no_recipients e nada criado".
   - "canal de outro provedor → 422 team_whatsapp.channel_invalid"; "último estado close → 409 team_whatsapp.channel_disconnected".
   - "setor sem destinatário válido → 422 no_recipients e nada criado" (membros sem telefone).
   - "setor: enfileira quem tem telefone e pula NO_PHONE/SUPPRESSED": 3 membros (com telefone; sem telefone; suprimido via `consent.isSuppressed.mockImplementation(async (p) => p === '+5592988887777')`) → resposta `{ dispatchId, queued: 1, skipped: [{ userId, name, reason: 'NO_PHONE' }, { …, reason: 'SUPPRESSED' }] }`; `queue.addBulk` com `[{ name: 'send', data: { recipientId }, opts: { jobId: recipientId } }]`; `audit.log('team_whatsapp.dispatch', 'TeamWhatsappDispatch', dispatchId, { actorId, targetType: 'SECTOR', targetId, channelId, queued: 1, skipped: 2 })`; e `JSON.stringify(audit.log.mock.calls)` não contém o texto nem nenhum telefone.
   - "ADMIN envia a um usuário sem setor" → `queued: 1`.
   - "falha ao enfileirar marca os QUEUED como FAILED e relança" (`queue.addBulk.mockRejectedValue(new Error('redis'))` → `repo.markFailed(ids, 'team_whatsapp.queue_unavailable')`).
   `cd backend && timeout 600 gate --test src/modules/team-whatsapp/team-whatsapp.service.spec.ts` → falha.
9. **GREEN — `team-whatsapp.service.ts`** (`@Injectable`; ctor `(repo: TeamWhatsappRepository, consent: ConsentService, audit: AuditService, @InjectQueue(QUEUE_NAMES.TEAM_WHATSAPP_SEND) queue: Queue<TeamWhatsappSendJob>)`). `dispatch(actorId: string, input: CreateTeamDispatchInput)` orquestra helpers privados curtos (cada um ≤ 50 linhas, ciclomática ≤ 10): `requireSender(actorId)` (null ou `!isTeamSender` → `teamForbidden()`); `resolveTarget(actor, input.target)` → `{ targetType, targetId, targetLabel, members }` (usuário: `findTargetUser`, null ou `!canSendToUser` → 403, label `name ?? email`, members `[user]`; setor: `findSectorWithActiveMembers`, null ou `!canSendToSector` → 403, label `sector.name`); `requireChannel(id)` (null, `!isActive` ou provider fora de `TEAM_PROVIDERS` → `channelInvalid()`; `connectionEvents[0]?.state === 'close'` → `channelDisconnected()`); `classify(members)` → por membro `phone = m.contact?.phoneE164 ?? m.phoneE164`; sem phone → `SKIPPED/NO_PHONE`; `await consent.isSuppressed(phone)` → `SKIPPED/SUPPRESSED`; senão `QUEUED`; zero `QUEUED` → `noRecipients()`. Grava com `createDispatch`, enfileira `queue.addBulk(queuedIds.map((id) => ({ name: 'send', data: { recipientId: id }, opts: { jobId: id } })))` (em `catch`: `markFailed(queuedIds, 'team_whatsapp.queue_unavailable')` e relança), audita (GC12) e devolve `{ dispatchId, queued, skipped: [{ userId, name, reason }] }`. Nenhum `logger` recebe texto ou telefone. Verde.
10. **RED/GREEN — `team-whatsapp.service.list.spec.ts`:** `targets(actorId)`: ADMIN → `listSectors(null)`; gestor → `listSectors(managedSectorIds)`; não-remetente → 403; `channels` = `listEligibleChannels()`; resultado passa em `teamTargetsResponseSchema.parse`. `listDispatches(actorId)`: ADMIN → `repo.listDispatches(null)`; gestor → `repo.listDispatches(actorId)`; não-remetente → 403; `counts` montado do `groupBy` com zeros onde faltar status; `target.type` em minúsculas (`'user' | 'sector'`); envio cujo canal foi removido devolve `channel: null`; passa em `teamDispatchListResponseSchema.parse`. `author` é `null` quando o autor foi apagado (extensão do contrato da spec, registrada aqui). `timeout 600 gate --test src/modules/team-whatsapp/team-whatsapp.service.list.spec.ts`.
11. **Contrato** `schemas/contracts/team-whatsapp.schema.ts` com os 3 schemas de resposta de GC7 (`provider: z.enum(['GOZAP','EVOLUTION'])`, `phoneE164: z.string().nullable()`, `reason: z.enum(['NO_PHONE','SUPPRESSED'])`, `channel: z.object({ id, name }).nullable()` no histórico, `createdAt: z.string()` ou `z.date()` conforme o que os outros contratos usam para datas serializadas).
12. **RED/GREEN — `team-whatsapp.controller.spec.ts`:** metadata `roles` dos 3 handlers = `['ADMIN','SUPERVISOR','OPERATOR']` (via `Reflect.getMetadata('roles', TeamWhatsappController.prototype.<handler>)`), `HTTP_CODE_METADATA` do POST = 202, e cada handler repassa o id do ator ao service. Controller `@Controller('internal/team-whatsapp')` com `@Get('targets')`, `@Post('dispatches') @HttpCode(202)`, `@Get('dispatches')`. Módulo: `@Module({ controllers: [TeamWhatsappController], providers: [TeamWhatsappService, TeamWhatsappRepository], exports: [TeamWhatsappRepository] })`; importar em `app.module.ts` junto de `InternalSectorsModule`. `timeout 600 gate --test src/modules/team-whatsapp/team-whatsapp.controller.spec.ts`.
12b. **Integração (repositório)** — `team-whatsapp.repository.integration.spec.ts`, seguindo o padrão testcontainers de `users.repository.integration.spec.ts` (`describe` ≤ 50 linhas): "findActor ignora setor desativado em managedSectorIds" (usuário `managerId` de `s1` ativo e `s2` inativo → `managedSectorIds` = `['s1']`) e "findTargetUser traz sector.isActive". `cd backend && timeout 600 gate --test src/modules/team-whatsapp/team-whatsapp.repository.integration.spec.ts` — exige Docker; sem Docker, lacuna no relatório (o job `backend-tests` do CI roda).
13. **Fechamento:** `cd backend && timeout 600 gate --changed --base origin/main` verde. Se o agente passar de ~80 chamadas antes do passo 10, parar e devolver o handoff (passos 10–12 viram task própria).

---

### Task 4b: `ChatService.sendTeamMessage` + processor da fila

**Files**
- Modify: `backend/src/modules/chat/chat.service.ts`
- Create: `backend/src/modules/team-whatsapp/team-whatsapp-send.processor.ts`
- Modify: `backend/src/worker.module.ts` (provider do processor)
- Test (create): `backend/src/modules/chat/chat.service.team.spec.ts`, `backend/src/modules/team-whatsapp/team-whatsapp-send.processor.spec.ts`
- Test (run): `backend/src/modules/chat/chat.send-reply.char.spec.ts`, `backend/src/modules/chat/chat.send.service.spec.ts`, `backend/src/worker.di.spec.ts`

**Ownership:** arquivos acima.

**Interfaces**
- Consumes: modelos e `QUEUE_NAMES.TEAM_WHATSAPP_SEND`/`TeamWhatsappSendJob`/`TEAM_PROVIDERS` (T4a); `resolveConversationForOutbound(db, { instanceId, contactId, phoneE164 }): Promise<ResolvedConversation>` (`chat/resolve-conversation.ts:154`, `ResolvedConversation = { id; contactId; lastMessageAt }`); privados de `ChatService`: `assertChatSendSupported(conv)` (`chat.service.ts:264`, lança `ChatProviderNoReplyError`), `dispatchOutbound(conv, messageId, text, quoted): Promise<boolean>` (`:174`, nunca lança: em erro chama `markChatFailed` e devolve `false`), `providerErrorCodeFor(err)` (`:230`), `CHAT_INDETERMINATE_CODES = new Set(['gozap.timeout','zernio.timeout','twilio.timeout'])` (`:62`, constante de módulo); `WhatsappSendError` (`whatsapp-providers/errors/whatsapp.errors.ts:3`, campos `providerErrorCode?: string` e `fatal: boolean` — **não existe** campo `indeterminate`: indeterminado = `providerErrorCode` em `CHAT_INDETERMINATE_CODES`); `ChatRepository.getConversationForSend(id)`, `createOutboundMessage({...}): Promise<string>` (cria `status: 'QUEUED'`), `setBotPaused(id)`, `touchConversationOutbound(id, preview)`, `markChatSent(messageId, instanceId, providerMessageId, sentAt)` e `markChatFailed(messageId, errorMessage, errorCode = null)` (`chat.repository.ts:168,182` — `message.update` incondicional por id, então re-despachar a mesma linha funciona); `ChatEventsService.publish`; `DelayedError` (bullmq); `DomainError.code` (`shared/errors/domain.error.ts`); `acquirePacingLock(redis, instanceId): Promise<{ acquired: true } | { acquired: false; retryDelayMs: number }>`, `releasePacingLock(redis, instanceId, logger?)` (`campaigns/pacing.helper.ts:104,132`); `isSessionProvider(provider)` (`schemas/contracts/channel-provider.schema.ts:93`, trait `sessionBased`); `REDIS_CLIENT` (`shared/redis/redis.module.ts`, `@Global`); `ConsentService.isSuppressed`.
- Produces:
  ```ts
  // chat.service.ts (exportado)
  export type TeamSendResult = { messageId: string; sent: boolean; errorCode: string | null; retryable: boolean };
  // ChatService (públicos) — duas fases, para o processor gravar o messageId ANTES do envio
  /** Fase 1: resolve/cria a conversa, recusa canal sem chat, grava a Message QUEUED (authorUserId) e pausa o bot. Não chama o provedor nem publica. */
  prepareTeamMessage(args: {
    instanceId: string; contactId: string | null; phoneE164: string; text: string; authorUserId: string | null;
  }): Promise<{ messageId: string }>
  /** Fase 2: marca a Message EXISTENTE como SENDING, envia (1ª vez ou re-despacho de uma linha FAILED), publica e devolve se vale retentar. */
  sendTeamMessage(args: { messageId: string; text: string }): Promise<TeamSendResult>
  /** Regra de "pode reenviar": errorCode não-nulo, fora de CHAT_INDETERMINATE_CODES e de 'sending_stuck'. Mantém a regra dentro do ChatService. */
  isRedispatchableFailure(code: string | null): boolean
  // retryable = !sent && err instanceof WhatsappSendError && !err.fatal && isRedispatchableFailure(err.providerErrorCode ?? null)
  ```
  e `@Processor(QUEUE_NAMES.TEAM_WHATSAPP_SEND, { concurrency: 2 }) class TeamWhatsappSendProcessor extends WorkerHost`. (O `existingMessageId?` sugerido na revisão virou a fase 2: no envio o id sempre existe, porque a fase 1 já o gravou no destinatário.)

**Risco:** `Crítico: concorrência + 2+ módulos — o processor decide reenvio/idempotência de mensagens reais (retentativa sem duplicar) e abre um caminho público novo no ChatService usado pelo worker.`

**Contexto vinculado**
- Spec §2 processor: (1) confere de novo a supressão → `SKIPPED/SUPPRESSED`; (2) em canal de sessão aguarda o pacing (mesmos helpers da campanha); (3) envia por método público novo do `ChatService` que resolve/cria a conversa (contato, canal), grava a saída com `authorUserId` do remetente, pausa o bot como na resposta humana, envia e publica `message.created` e `conversation.updated`; (4) `SENT` com `messageId` ou `FAILED` com o código; erro do provedor tem retentativa da fila; falha final fica `FAILED`.
- Risco 5: o job confere o status antes de enviar (só `QUEUED` envia) — retentativa não duplica; falha de um destinatário não trava os outros (cada um é um job).
- GC11: `attempts: 3`, `jobId = recipientId`. GC12: nenhum log com texto ou telefone (logar só `recipientId`, `dispatchId`, `errorCode`). GC13: `sendReply` mantém o comportamento — extrair o trecho comum para um helper privado é permitido desde que os specs de caracterização fiquem verdes sem edição.
- **Duas fases, uma `Message` por destinatário (GC11).** Fase 1 (só se `recipient.messageId` é null): `prepareTeamMessage` cria a `Message` QUEUED e pausa o bot **uma vez**; o processor grava `recipient.messageId` (destinatário ainda `QUEUED`) **antes** de chamar o provedor. Fase 2: `sendTeamMessage({ messageId, text })`. Antes do provedor, `sendTeamMessage` move a linha (`QUEUED`/`FAILED`) para `SENDING` (valores reais de `MessageStatus`, `schema.prisma:1091`: `QUEUED, WAITING_INSTANCE, SENDING, SENT, DELIVERED, READ, RECEIVED, FAILED, CANCELLED, SKIPPED_NO_OPTIN, SKIPPED_NO_CONSENT, SKIPPED_SUPPRESSED`); `markChatSent`/`markChatFailed` sobrescrevem `SENDING` por `update` incondicional. Assim `QUEUED` = "não começou" (reenviar é seguro, inclusive se o processo morreu entre gravar `messageId` e chamar o provedor, ou no restart do worker) e `SENDING` = "pode ter saído". Na retentativa, com `messageId` já gravado, o processor lê `Message.{status, errorCode}` (`priorOutcome`): `QUEUED` → segue e envia; `FAILED` com `errorCode` não-nulo e `chat.isRedispatchableFailure(errorCode)` → re-despacha a MESMA linha; `FAILED` sem código (ex. `markChatSent` falhou depois do aceite) ou com código indeterminado (`gozap.timeout`…) → destinatário `FAILED` `team_whatsapp.indeterminate`, **sem** reenviar; `SENDING` → `FAILED` `team_whatsapp.indeterminate`; `SENT`/`DELIVERED`/`READ` → destinatário `SENT`; `CANCELLED`/`WAITING_INSTANCE`/`RECEIVED`/`SKIPPED_*` → `FAILED` `team_whatsapp.indeterminate`; linha sumiu → `FAILED` `team_whatsapp.message_missing`. Assim: sem bolhas duplicadas, sem `setBotPaused` repetido e sem reenvio quando o provedor aceitou/pode ter aceitado mas o `finish` falhou (Risco 5).
- **Retentar só o retentável (reenvio ao provedor).** `dispatchOutbound` nunca lança. `retryable` só para `WhatsappSendError` com `fatal: false` e `providerErrorCode` presente e redispatchável (`isRedispatchableFailure`; timeout = "pode ter saído"); erro fatal (ex. `gozap.invalid_recipient`), indeterminado, sem código ou que não é `WhatsappSendError` (ex. falha de banco dentro do `markChatSent` depois do aceite) → `FAILED` direto. Retentável → relança para a fila; na última tentativa `FAILED`. (Falha sem código também não é retentada: sem código não há como provar que não saiu.)
- **Exceção nunca deixa `QUEUED` eterno (I1) e nunca rebaixa um envio já feito (N3).** `process` envolve tudo num `catch` que, se não for `DelayedError`, relança sempre; e, se for a última tentativa (`job.attemptsMade + 1 >= (job.opts.attempts ?? 1)`), antes de gravar `FAILED` consulta `lastAttemptData(id, err)`: se o destinatário já tem `messageId`, usa `priorOutcome(messageId)` — resultado não-nulo (`SENT` ou `indeterminate`) vence; senão `{ status: 'FAILED', errorCode: err instanceof DomainError ? err.code : 'team_whatsapp.send_failed' }`. A consulta é best-effort (se ela própria falhar, grava o `FAILED` padrão) e o `finish` também. Cobre `NotFoundError`, `ChatProviderNoReplyError` (`assertChatSendSupported`), erro de banco e Redis no pacing, e exceção em `events.publish`/settle depois de `SENT`. Resíduo: banco fora do ar na própria última tentativa deixa `QUEUED` — o polling da T5 é limitado a 60 min.
- Telefone de envio: `recipient.user.contact?.phoneE164 ?? recipient.user.phoneE164`; `contactId = recipient.user.contact?.id ?? null`; sem telefone → `SKIPPED/NO_PHONE`. Canal removido (`dispatch.channel === null`), inativo ou fora de `TEAM_PROVIDERS` → `FAILED` `team_whatsapp.channel_invalid`.
- Processor registrado **só** em `worker.module.ts` (`@Processor` duplicado em módulo de feature derruba o worker — comentário em `worker.module.ts:89-90,114-115`).

**Steps**

1. **Verificar no Step 1.** `isSessionProvider('GOZAP')` e `('EVOLUTION')` devolvem `true` (`PROVIDER_TRAITS.sessionBased`); se algum devolver `false`, o pacing vale só onde `true` (é o que a spec chama de "canal de sessão") e isso vai no relatório. Semântica de `job.attemptsMade` na versão do BullMQ instalada (no 1º processamento é `0`?) — conferir em `send-message.processor.ts` como ele detecta a última tentativa e copiar. Como `bot-reply.processor.ts` usa `ClsService` (`cls.run`) — copiar se a auditoria/Prisma dependerem de CLS. `resolveConversationForOutbound` aceita `PrismaService` como `db`. O fixture de conversa Evolution de `chat.send.service.spec.ts` (para reaproveitar no spec novo) e como ele constrói `WhatsappSendError` (ordem dos argumentos do construtor; `fatal` é o 4º, default `false`). No `schema.prisma`, `model Message`: se `conversationId` é nullable e se `failedAt`/`errorMessage`/`errorCode` aceitam `null` (os valores de `MessageStatus` já estão conferidos no Contexto vinculado). **`SENDING` e o reconciler (decidido na revisão R3):** `findStuckSending` (`campaigns.repository.ts:1275`) filtra `status: 'SENDING', sendingAt: { lt: cutoff }` e já trata linha sem campanha (`sending-reconciler.processor.ts:129`). Por isso o claim do passo 3 grava `sendingAt: new Date()`: uma linha da equipe presa em `SENDING` vira `FAILED` `sending_stuck` após 10 min, e `isRedispatchableFailure` exclui `'sending_stuck'` (nunca reenvia). Só confirmar que `Message.sendingAt` existe no `schema.prisma` com esse nome. Outros chamadores de `dispatchOutbound` (bot) — o wrapper do passo 3 preserva todos.
2. **RED — `chat.service.team.spec.ts`** (`vi.mock('./resolve-conversation', async (orig) => ({ ...(await orig<object>()), resolveConversationForOutbound: vi.fn() }))`; `new ChatService(repo, events, wa, prisma, audit)` com `mockDeep`):
   - `describe('ChatService.prepareTeamMessage')`:
     - "resolve a conversa, grava QUEUED com authorUserId e pausa o bot, sem chamar o provedor": `resolveConversationForOutbound` → `{ id: 'conv1', contactId: 'c1', lastMessageAt: null }`; `repo.getConversationForSend` → fixture Evolution; `repo.createOutboundMessage` → `'m1'`. Esperar `resolveConversationForOutbound(prisma, { instanceId: 'ch1', contactId: 'c1', phoneE164: '+5592991234567' })`, `createOutboundMessage` com `expect.objectContaining({ conversationId: 'conv1', authorUserId: 'u-admin', botId: null, content: 'Oi equipe' })`, `setBotPaused('conv1')`, `wa.sendChatText` e `events.publish` **não** chamados, retorno `{ messageId: 'm1' }`.
     - "canal sem chat recusa antes de gravar": `wa.supportsInboxChatFor` → `false` → `rejects.toBeInstanceOf(ChatProviderNoReplyError)` (importado de `./chat.service`, exportado no passo 3) e `createOutboundMessage` não chamado.
   - `describe('ChatService.sendTeamMessage')` (`prisma.message.findUnique` → `{ conversationId: 'conv1' }`; `repo.getConversationForSend` → fixture Evolution):
     - "envia a linha existente e publica": `wa.sendChatText` resolve `{ providerMessageId: 'p1', acceptedAt: new Date() }` → `repo.markChatSent('m1', …)`, `createOutboundMessage` e `setBotPaused` **não** chamados, `events.publish` com `message.created` e `conversation.updated`, retorno `{ messageId: 'm1', sent: true, errorCode: null, retryable: false }`.
     - Em todo este `describe`, `prisma.message.updateMany` → `mockResolvedValue({ count: 1 })` (o `mockDeep` devolve `undefined`), salvo no caso do claim recusado.
     - "marca a linha como SENDING antes do provedor e reaproveita o id (QUEUED ou FAILED)": `prisma.message.updateMany` chamado com `{ where: { id: 'm1', status: { in: ['QUEUED', 'FAILED'] } }, data: { status: 'SENDING', sendingAt: expect.any(Date), failedAt: null, errorMessage: null, errorCode: null } }` e `invocationCallOrder` antes de `wa.sendChatText`; `createOutboundMessage` não chamado.
     - "claim com count 0 lança e não chama o provedor": `prisma.message.updateMany` → `{ count: 0 }` → `rejects.toMatchObject({ code: 'team_whatsapp.not_claimed' })`; `wa.sendChatText`, `wa.sendChatTextVia`, `repo.markChatSent`/`markChatFailed` e `events.publish` não chamados.
     - `describe('ChatService.isRedispatchableFailure')`: `it.each` — `null` → `false`; `'gozap.timeout'`/`'zernio.timeout'`/`'twilio.timeout'` → `false`; `'sending_stuck'` → `false`; `'evolution.not_connected'` → `true`.
     - "falha transitória do provedor é retentável": `WhatsappSendError` com `providerErrorCode: 'evolution.not_connected'`, `fatal: false` → `{ sent: false, errorCode: 'evolution.not_connected', retryable: true }`; `markChatFailed('m1', …, 'evolution.not_connected')`; sem `conversation.updated`.
     - "timeout do GoZap não é retentável" (`'gozap.timeout'`, `fatal: false`) → `retryable: false`.
     - "erro fatal não é retentável" (`'gozap.invalid_recipient'`, `fatal: true`) → `retryable: false`.
     - "erro que não é WhatsappSendError não é retentável" (`new Error('db')`) → `retryable: false, errorCode: null`.
     - "WhatsappSendError sem providerErrorCode não é retentável" (`fatal: false`) → `retryable: false`.
   `cd backend && timeout 600 gate --test src/modules/chat/chat.service.team.spec.ts` → falha.
3. **GREEN — `chat.service.ts`:**
   - Exportar `ChatProviderNoReplyError` (`chat.service.ts:74`: `export class ChatProviderNoReplyError extends ConflictError`): os specs novos (`chat.service.team.spec.ts` e o do processor) o importam.
   - `dispatchOutbound` vira wrapper fino de um novo `private async dispatchOutboundResult(conv, messageId, text, quoted): Promise<OutboundResult>` (`type OutboundResult = { sent: true } | { sent: false; errorCode: string | null; retryable: boolean }`) que contém o corpo atual (comentários inclusive) com **duas** mudanças: (a) o `return true` do `try` (`:218`) vira `return { sent: true }`; (b) o `catch` passa a `const errorCode = this.providerErrorCodeFor(err); await this.repo.markChatFailed(messageId, this.chatFailureMessage(err, useRegistry), errorCode); return { sent: false, errorCode, retryable: this.isRetryableSendError(err) };` (mesmos argumentos de `markChatFailed` de hoje). `dispatchOutbound` = `return (await this.dispatchOutboundResult(conv, messageId, text, quoted)).sent;` — os chamadores `sendReply` (`:156`, `:410`) e o bot continuam no wrapper, sem mudança de comportamento.
   - `isRedispatchableFailure(code: string | null): boolean` (público) = `code !== null && !CHAT_INDETERMINATE_CODES.has(code) && code !== 'sending_stuck'` (constante local `CHAT_NEVER_REDISPATCH_CODES` se preferir um Set único); `private isRetryableSendError(err: unknown): boolean` = `err instanceof WhatsappSendError && !err.fatal && this.isRedispatchableFailure(this.providerErrorCodeFor(err))`.
   - Opcional (se o detector de duplicação acusar): `private async publishOutbound(conversationId, instanceId, messageId, text, sent)` com o trecho `message.created` → (se enviado) `touchConversationOutbound` + `conversation.updated`, usado por `sendReply` e `sendTeamMessage` na mesma ordem de efeitos.
   ```ts
   const NO_QUOTE: QuotedFields = { quotedWaMessageId: null, quotedPreview: null };

   /** Fase 1 do recado da equipe: conversa resolvida/criada, Message QUEUED gravada, bot pausado. Sem provedor. */
   async prepareTeamMessage(args: {
     instanceId: string; contactId: string | null; phoneE164: string; text: string; authorUserId: string | null;
   }): Promise<{ messageId: string }> {
     const resolved = await resolveConversationForOutbound(this.prisma, {
       instanceId: args.instanceId, contactId: args.contactId, phoneE164: args.phoneE164,
     });
     const conv = await this.repo.getConversationForSend(resolved.id);
     if (!conv) throw new NotFoundError('Conversation', resolved.id);
     this.assertChatSendSupported(conv);
     const messageId = await this.repo.createOutboundMessage({
       conversationId: resolved.id, instanceId: conv.instanceId, contactId: conv.contactId,
       content: args.text, authorUserId: args.authorUserId, botId: null, ...NO_QUOTE,
     });
     await this.repo.setBotPaused(resolved.id);
     return { messageId };
   }

   /** Fase 2: envia a Message existente. QUEUED/FAILED vai para SENDING ANTES do provedor:
    *  QUEUED = "não começou" (reenvio seguro); SENDING = "pode ter saído" e o processor não a reenvia. */
   async sendTeamMessage(args: { messageId: string; text: string }): Promise<TeamSendResult> {
     const msg = await this.prisma.message.findUnique({ where: { id: args.messageId }, select: { conversationId: true } });
     if (!msg?.conversationId) throw new NotFoundError('Message', args.messageId);
     const conv = await this.repo.getConversationForSend(msg.conversationId);
     if (!conv) throw new NotFoundError('Conversation', msg.conversationId);
     this.assertChatSendSupported(conv);
     // Claim atômico (como o da campanha): só quem move QUEUED/FAILED → SENDING envia.
     // count 0 = outra execução (job travado reexecutado em paralelo) já pegou a linha.
     // sendingAt permite ao sending-reconciler fechar como FAILED 'sending_stuck' uma linha presa > 10 min.
     const claim = await this.prisma.message.updateMany({
       where: { id: args.messageId, status: { in: ['QUEUED', 'FAILED'] } },
       data: { status: 'SENDING', sendingAt: new Date(), failedAt: null, errorMessage: null, errorCode: null },
     });
     if (claim.count === 0) throw new ConflictError('Team message already claimed', 'team_whatsapp.not_claimed');
     const out = await this.dispatchOutboundResult(conv, args.messageId, args.text, NO_QUOTE);
     await this.events.publish({ type: 'message.created', conversationId: msg.conversationId, instanceId: conv.instanceId, messageId: args.messageId });
     if (!out.sent) return { messageId: args.messageId, sent: false, errorCode: out.errorCode, retryable: out.retryable };
     await this.repo.touchConversationOutbound(msg.conversationId, args.text);
     await this.events.publish({ type: 'conversation.updated', conversationId: msg.conversationId, instanceId: conv.instanceId });
     return { messageId: args.messageId, sent: true, errorCode: null, retryable: false };
   }
   ```
   Sem `assertSessionWindowOpen` (só GOZAP/EVOLUTION chegam aqui; ambos sem janela). Rodar o spec novo + `timeout 600 gate --test src/modules/chat/chat.send-reply.char.spec.ts` + `timeout 600 gate --test src/modules/chat/chat.send.service.spec.ts` → verdes **sem editar** os specs existentes.
4. **RED — `team-whatsapp-send.processor.spec.ts`** (`vi.mock('../campaigns/pacing.helper', () => ({ acquirePacingLock: vi.fn(), releasePacingLock: vi.fn(), PACING_JITTER_MIN_MS: 10000 }))`; `prisma`, `chat`, `consent` com `mockDeep`; `job = { data: { recipientId: 'r1' }, attemptsMade: 0, opts: { attempts: 3 }, moveToDelayed: vi.fn() } as unknown as Job<TeamWhatsappSendJob>`; fixture `recipient` QUEUED com `messageId: null`, `user: { phoneE164: '+5592991234567', contact: { id: 'c1', phoneE164: '+5592991234567' } }`, `dispatch: { id: 'd1', authorId: 'u-admin', text: 'Oi equipe', channel: { id: 'ch1', provider: 'GOZAP', isActive: true } }`; `chat.prepareTeamMessage` → `{ messageId: 'm1' }`; `describe`s ≤ 50 linhas — um para pré-checagens, um para envio/retentativa, um para idempotência, um para exceções/log):
   - "status diferente de QUEUED não reenvia" (`status: 'SENT'`) → `prepareTeamMessage`/`sendTeamMessage` não chamados.
   - "SAIR depois de enfileirar vira SKIPPED/SUPPRESSED" (`consent.isSuppressed` → `true`) → `teamWhatsappRecipient.updateMany({ where: { id: 'r1', status: 'QUEUED' }, data: { status: 'SKIPPED', skipReason: 'SUPPRESSED' } })` e sem envio nem pacing.
   - "usuário perdeu o telefone vira SKIPPED/NO_PHONE".
   - "canal desativado ou removido vira FAILED channel_invalid" (`isActive: false`; e `channel: null`).
   - "envio ok: prepara uma vez, grava o messageId antes do envio, marca SENT e solta o pacing" (`acquirePacingLock` → `{ acquired: true }`; `sendTeamMessage` → `{ messageId: 'm1', sent: true, errorCode: null, retryable: false }`) → `prepareTeamMessage({ instanceId: 'ch1', contactId: 'c1', phoneE164: '+5592991234567', text: 'Oi equipe', authorUserId: 'u-admin' })`; `teamWhatsappRecipient.updateMany({ where: { id: 'r1', status: 'QUEUED', messageId: null }, data: { messageId: 'm1' } })` com `invocationCallOrder` **antes** de `sendTeamMessage({ messageId: 'm1', text: 'Oi equipe' })`; depois `data: { status: 'SENT', messageId: 'm1' }`; `releasePacingLock` chamado com `'ch1'`.
   - "pacing ocupado adia o job sem preparar nem enviar" (`{ acquired: false, retryDelayMs: 5000 }`) → `job.moveToDelayed` chamado e `rejects.toBeInstanceOf(DelayedError)`; sem `prepareTeamMessage`, sem `releasePacingLock`, sem `finish`.
   - "erro retentável relança e a última tentativa marca FAILED": `sent: false, errorCode: 'evolution.not_connected', retryable: true` com `attemptsMade: 0` → `rejects.toThrow()` e status não muda; com `attemptsMade: 2` → `data: { status: 'FAILED', errorCode: 'evolution.not_connected', messageId: 'm1' }` e resolve.
   - "erro não retentável (fatal ou indeterminado) marca FAILED sem relançar" (`retryable: false`, `errorCode: 'gozap.invalid_recipient'` e `'gozap.timeout'`, `attemptsMade: 0`).
   - "retentativa reaproveita o messageId": `recipient.messageId: 'm1'`, `prisma.message.findUnique` → `{ status: 'FAILED', errorCode: 'evolution.not_connected' }`, `chat.isRedispatchableFailure` (mock) → `true`, `attemptsMade: 1` → `prepareTeamMessage` **não** chamado; `sendTeamMessage({ messageId: 'm1', text: 'Oi equipe' })` chamado uma vez.
   - "retentativa com Message FAILED por gozap.timeout não reenvia": `recipient.messageId: 'm1'`, `prisma.message.findUnique` → `{ status: 'FAILED', errorCode: 'gozap.timeout' }`, `chat.isRedispatchableFailure('gozap.timeout')` → `false` → `data: { status: 'FAILED', errorCode: 'team_whatsapp.indeterminate' }`; `sendTeamMessage` **não** chamado. Variante `errorCode: null` (markChatSent falhou depois do aceite) → mesmo resultado.
   - "retentativa com Message SENDING não reenvia": `{ status: 'SENDING', errorCode: null }` → `FAILED` `team_whatsapp.indeterminate`, sem `sendTeamMessage`. `it.each` para `CANCELLED`/`WAITING_INSTANCE`/`RECEIVED` → mesmo resultado.
   - "falha no settle após SENT não reenvia": 1ª tentativa — `sendTeamMessage` → `sent: true`, mas o `updateMany` do `SENT` rejeita (`new Error('db')`) → `rejects.toThrow()`; 2ª tentativa — `recipient.messageId: 'm1'`, `prisma.message.findUnique` → `{ status: 'SENT', errorCode: null }` (também `DELIVERED`/`READ`) → `data: { status: 'SENT' }`; `sendTeamMessage` chamado **1 vez no total** e sem pacing na 2ª.
   - "retentativa com Message ainda QUEUED reenvia a mesma linha" (`{ status: 'QUEUED', errorCode: null }`, processo caiu antes do provedor) → `prepareTeamMessage` não chamado, `sendTeamMessage({ messageId: 'm1', … })` chamado; linha sumida (`null`) → `FAILED` `'team_whatsapp.message_missing'`.
   - "exceção na última tentativa marca FAILED": `prepareTeamMessage` rejeita `new ChatProviderNoReplyError('GOZAP')` com `attemptsMade: 2` e `recipient.messageId: null` → `rejects` com o mesmo erro e `data: { status: 'FAILED', errorCode: <code do erro> }`; com `new Error('redis')` → `errorCode: 'team_whatsapp.send_failed'`; com `attemptsMade: 0` → relança sem `finish`. `prisma.teamWhatsappRecipient.findUnique` rejeitando na última tentativa também chega ao `finish` com o `FAILED` padrão (usa `job.data.recipientId`).
   - "exceção na última tentativa com Message já SENT grava SENT": `attemptsMade: 2`; `load` (`teamWhatsappRecipient.findUnique`, 1ª chamada) devolve o fixture com `messageId: null` e `prepareTeamMessage` → `{ messageId: 'm1' }` (assim o `priorOutcome` inicial não encerra o fluxo); `sendTeamMessage` → `sent: true`; `teamWhatsappRecipient.updateMany` em sequência: gravação do `messageId` → `{ count: 1 }`, settle `SENT` → `mockRejectedValueOnce(new Error('db'))`, `finish` do catch → `{ count: 1 }`; `lastAttemptData` lê `teamWhatsappRecipient.findUnique` (2ª chamada, `mockResolvedValueOnce`) → `{ messageId: 'm1' }` e `prisma.message.findUnique` → `{ status: 'SENT', errorCode: null }` → o último `updateMany` tem `data: { status: 'SENT' }` (não `FAILED send_failed`) e o erro é relançado. Variante com `prisma.message.findUnique` → `{ status: 'SENDING', errorCode: null }` → `FAILED` `team_whatsapp.indeterminate`.
   - "claim recusado (team_whatsapp.not_claimed) fora da última tentativa relança sem marcar": `sendTeamMessage` rejeita com `ConflictError('…', 'team_whatsapp.not_claimed')`, `attemptsMade: 0` → `rejects.toThrow()` e nenhum `updateMany` com `status` (só a gravação do `messageId`).
   - "nenhum log leva texto ou telefone": espiar o `Logger` do processor e conferir que nenhuma chamada contém `'Oi equipe'` nem `'+5592991234567'`.
   `cd backend && timeout 600 gate --test src/modules/team-whatsapp/team-whatsapp-send.processor.spec.ts` → falha.
5. **GREEN — processor:**
   ```ts
   @Processor(QUEUE_NAMES.TEAM_WHATSAPP_SEND, { concurrency: 2 })
   export class TeamWhatsappSendProcessor extends WorkerHost {
     private readonly logger = new Logger(TeamWhatsappSendProcessor.name);
     constructor(
       private readonly prisma: PrismaService,
       private readonly chat: ChatService,
       private readonly consent: ConsentService,
       @Inject(REDIS_CLIENT) private readonly redis: Redis,
     ) { super(); }

     async process(job: Job<TeamWhatsappSendJob>, token?: string): Promise<void> {
       const id = job.data.recipientId;
       try {
         await this.deliver(job, token, id);
       } catch (err) {
         if (err instanceof DelayedError) throw err;
         if (this.isLastAttempt(job)) {
           // Nenhuma exceção deixa o destinatário QUEUED para sempre (contagem e polling),
           // mas também não rebaixa para FAILED um envio que a Message já prova feito (N3).
           const data = await this.lastAttemptData(id, err);
           await this.finish(id, data).catch(() => undefined);
           this.logger.warn({ recipientId: id, errorCode: data.errorCode }, 'team whatsapp send failed');
         }
         throw err;
       }
     }

     private async deliver(job: Job<TeamWhatsappSendJob>, token: string | undefined, id: string): Promise<void> {
       const r = await this.load(id);
       if (!r || r.status !== 'QUEUED') return;
       const pre = await this.precheck(r); // NO_PHONE / SUPPRESSED / channel_invalid (canal null, inativo ou fora de TEAM_PROVIDERS)
       if ('data' in pre) return this.finish(r.id, pre.data);
       if (r.messageId) {
         const prior = await this.priorOutcome(r.messageId);
         if (prior) return this.finish(r.id, prior);
       }
       const paced = isSessionProvider(pre.channel.provider);
       if (paced) await this.waitPacing(job, token, pre.channel.id); // antes da fase 1: adiar não deixa Message QUEUED
       try {
         const messageId = r.messageId ?? (await this.prepare(r, pre.channel.id, pre.phone));
         const res = await this.chat.sendTeamMessage({ messageId, text: r.dispatch.text });
         await this.settle(job, r.id, res);
       } finally {
         if (paced) await releasePacingLock(this.redis, pre.channel.id, this.logger);
       }
     }
   }
   ```
   com privados: `load(id)` (`teamWhatsappRecipient.findUnique` com o `select` do contrato de T4a, incluindo `messageId`); `precheck(r)` → `{ data }` (para `finish`) ou `{ phone, channel }`; `finish(id, data)` = `updateMany({ where: { id, status: 'QUEUED' }, data })` (transição condicional — idempotente); `prepare(r, instanceId, phone)` = `chat.prepareTeamMessage({ instanceId, contactId: r.user?.contact?.id ?? null, phoneE164: phone, text: r.dispatch.text, authorUserId: r.dispatch.authorId })` seguido de `teamWhatsappRecipient.updateMany({ where: { id: r.id, status: 'QUEUED', messageId: null }, data: { messageId } })` e devolve `messageId`; `priorOutcome(messageId)` (`prisma.message.findUnique({ where: { id }, select: { status: true, errorCode: true } })`; devolve `null` = "pode (re)enviar" ou os dados de `finish`: linha `null` → `{ status: 'FAILED', errorCode: 'team_whatsapp.message_missing' }`; `'QUEUED'` → `null`; `'FAILED'` → `this.chat.isRedispatchableFailure(errorCode) ? null : { status: 'FAILED', errorCode: 'team_whatsapp.indeterminate' }`; `'SENT' | 'DELIVERED' | 'READ'` → `{ status: 'SENT' }`; qualquer outro (`SENDING`, `CANCELLED`, `WAITING_INSTANCE`, `RECEIVED`, `SKIPPED_*`) → `{ status: 'FAILED', errorCode: 'team_whatsapp.indeterminate' }`); `lastAttemptData(id, err)` (best-effort, em `try/catch` que cai no padrão: `teamWhatsappRecipient.findUnique({ where: { id }, select: { messageId: true } })`; com `messageId`, `const prior = await this.priorOutcome(messageId); if (prior) return prior;`; padrão = `{ status: 'FAILED', errorCode: err instanceof DomainError ? err.code : 'team_whatsapp.send_failed' }`; o tipo de retorno é `{ status: 'SENT' | 'FAILED'; errorCode?: string }`); `waitPacing(job, token, instanceId)` (`acquirePacingLock`; se `!acquired`: `await job.moveToDelayed(Date.now() + lock.retryDelayMs, token); throw new DelayedError();`); `isLastAttempt(job)` = `job.attemptsMade + 1 >= (job.opts.attempts ?? 1)` (ajustar à semântica conferida no Step 1); `settle(job, id, res)` (`sent` → `SENT` + `messageId`; senão `final = !res.retryable || this.isLastAttempt(job)` → `FAILED` com `errorCode: res.errorCode ?? 'team_whatsapp.send_failed'` e `messageId`, e `logger.warn({ recipientId: id, errorCode }, 'team whatsapp send failed')`; não final → `throw new Error(\`team_whatsapp.retry:${res.errorCode ?? 'unknown'}\`)`). Cada função ≤ 50 linhas e ciclomática ≤ 10 (por isso `precheck`/`priorOutcome` separados). Resíduo aceito: se a gravação do `messageId` falhar depois do `prepareTeamMessage`, a retentativa cria outra `Message` (bolha QUEUED órfã, sem envio duplicado). Copiar o uso de `ClsService` do `BotReplyProcessor` se o Step 1 mostrar que é necessário. Registrar `TeamWhatsappSendProcessor` em `worker.module.ts` `providers` (só lá; `ChatModule`, `ConsentModule`, `RedisModule` e `QueueModule` já estão importados). Verde.
6. **DI do worker:** `cd backend && timeout 600 gate --test src/worker.di.spec.ts` verde (ajustar o spec só se ele enumera providers explicitamente).
7. **Fechamento:** `cd backend && timeout 600 gate --changed --base origin/main` verde.

---

### Task 5: Página `/whatsapp-equipe`, diálogo "Enviar WhatsApp", item em Usuários, novidade

**Files**
- Create: `frontend/src/features/team-whatsapp/schemas.ts`, `frontend/src/features/team-whatsapp/api.ts`, `frontend/src/features/team-whatsapp/error-messages.ts`, `frontend/src/features/team-whatsapp/components/send-whatsapp-dialog.tsx`, `frontend/src/features/team-whatsapp/components/team-sector-card.tsx`, `frontend/src/features/team-whatsapp/components/recent-dispatches.tsx`
- Create: `frontend/src/routes/_authenticated/whatsapp-equipe/index.tsx`
- Modify: `frontend/src/routeTree.gen.ts` (regenerado, não editado à mão), `frontend/src/lib/nav.ts`, `frontend/src/routes/_authenticated/users/index.tsx`, `frontend/src/release-notes.ts`
- Test (create): `frontend/src/features/team-whatsapp/error-messages.spec.ts`, `frontend/src/features/team-whatsapp/components/send-whatsapp-dialog.spec.tsx`, `frontend/src/routes/_authenticated/whatsapp-equipe/index.spec.tsx`
- Test (modify): `frontend/src/lib/nav.spec.ts`, `frontend/src/routes/_authenticated/users/index.spec.tsx`, `frontend/src/release-notes.spec.ts` (`describe` novo)

**Ownership:** arquivos acima (`nav.ts` e `users/index.tsx` só depois de T1 e T3 integradas).

**Interfaces**
- Consumes: contrato T4a (GC7; `backend/src/schemas/contracts/team-whatsapp.schema.ts` como referência); `api` (`@/lib/api-client`, ky); `formatPhoneBR` (T3, `@/lib/format-phone`); `canAccessPath`/`NAV` (T1); `useAuthStore`; `toast` (o mesmo import usado em `contact-form-dialog.tsx`).
- Produces: hooks `useTeamTargets()`, `useTeamDispatches()`, `useCreateTeamDispatch()`; `export type SendTarget = { type: 'user'; userId: string; label: string } | { type: 'sector'; sectorId: string; label: string; recipientCount: number }`; `<SendWhatsappDialog open onOpenChange target />`; `teamErrorMessage(code?: string): string`; `SKIP_REASON_LABEL`.

**Risco:** médio — tela e diálogo consumindo rotas que o backend já protege; o front só esconde o que o backend recusaria.

**Contexto vinculado**
- Spec §3: página "WhatsApp da equipe" (`/whatsapp-equipe`) no menu para ADMIN, SUPERVISOR e OPERATOR; mostra os setores alcançáveis e os membros (nome, telefone ou "sem telefone", ativo); ações "Enviar ao setor" e, por pessoa, "Enviar"; abaixo, envios recentes; dados de `GET /internal/team-whatsapp/targets` (o gestor não-ADMIN não acessa `/whatsapp/instances` nem `/users`).
- Estado vazio para quem não é ADMIN nem gestor: "Só o administrador e o gestor do setor enviam mensagens para a equipe." — decisão do plano (T4a): o backend responde 403 `team_whatsapp.forbidden` em `targets`; o front mostra esse texto no 403.
- Diálogo "Enviar WhatsApp" (reutilizado): destino (pessoa ou setor e quantos receberão), seletor de canal (pré-selecionado se houver um só), texto com contador (máx. 2000), botão "Enviar"; sucesso → toast "Mensagem enfileirada para N pessoa(s)" com a descrição começando por "Os envios saem aos poucos, no ritmo do canal; para um setor grande pode levar alguns minutos." (o pacing é o mesmo da campanha, jitter 10–45 s por mensagem: setor de 30 pessoas ≈ 5–20 min) + lista dos pulados e o motivo; 403/409/422 → PT-BR.
- Histórico: `channel` pode vir `null` (canal removido, `onDelete: SetNull` na T4a) → mostrar "canal removido".
- Polling do histórico: só enquanto há `counts.queued > 0` em envio criado há menos de 60 min (o backend marca `FAILED` toda exceção na última tentativa, mas banco fora do ar nesse instante ainda pode deixar `QUEUED`; o limite evita polling infinito).
- Usuários (ADMIN): item "Enviar WhatsApp" no menu "Ações" da linha; desabilitado com dica para usuário sem telefone ou inativo.
- GC2 (códigos), GC10 (texto 1–2000, canais GOZAP/EVOLUTION), GC14 (textos exatos), GC15 (novidade `'2026.10.16'` no topo com `where: '/whatsapp-equipe'`).
- Seção do NAV (decisão do plano): `'ops'` — é a seção das telas de comunicação do dia a dia (Visão geral, Caixa de entrada, Nova comunicação) e a única com itens para SUPERVISOR/OPERATOR além de `sys`; `'admin'` é só ADMIN. `roles: WRITE_INTERNAL_ROLES` (`['ADMIN','SUPERVISOR','OPERATOR']`).
- GC16.

**Steps**

1. **Verificar no Step 1.** Padrão de rota em `routes/_authenticated/setores/index.tsx` (`createFileRoute('/_authenticated/setores/')`) e como o `routeTree.gen.ts` é regenerado (plugin do Vite no `vite build`/`dev`, ou `npx tsr generate`); padrão de spec de rota em `users/index.spec.tsx`; import do `toast`; ícone disponível no `lucide-react` (`MessageCircle`).
2. **RED/GREEN — `error-messages.spec.ts`:**
   ```ts
   it.each([
     ['team_whatsapp.forbidden', 'Você não tem permissão para enviar a este destino.'],
     ['team_whatsapp.channel_disconnected', 'O canal escolhido está desconectado. Reconecte o número ou escolha outro canal.'],
     ['team_whatsapp.channel_invalid', 'Canal inválido: escolha um canal GoZap ou Evolution ativo.'],
     ['team_whatsapp.no_recipients', 'Ninguém neste destino tem telefone válido para receber.'],
     [undefined, 'Não foi possível enviar a mensagem.'],
   ])('%s', (code, msg) => expect(teamErrorMessage(code)).toBe(msg));
   ```
   e `SKIP_REASON_LABEL = { NO_PHONE: 'sem telefone', SUPPRESSED: 'pediu para não receber (SAIR)' }`. `cd frontend && timeout 600 gate --test src/features/team-whatsapp/error-messages.spec.ts`.
3. **Schemas + API.** `schemas.ts` espelha GC7 em zod (`teamTargetsSchema`, `dispatchResultSchema`, `dispatchListSchema`). `api.ts`: `useTeamTargets()` → `useQuery({ queryKey: ['team-whatsapp','targets'], queryFn: async () => teamTargetsSchema.parse(await api.get('internal/team-whatsapp/targets').json()), retry: false })`; `useTeamDispatches()` → `['team-whatsapp','dispatches']`, `refetchInterval: (q) => (q.state.data?.items.some((i) => i.counts.queued > 0 && Date.now() - Date.parse(i.createdAt) < 60 * 60_000) ? 10_000 : false)` (constante `POLL_WINDOW_MS = 60 * 60_000`); `dispatchListSchema` com `channel: z.object({ id: z.string(), name: z.string() }).nullable()`; `useCreateTeamDispatch()` → `api.post('internal/team-whatsapp/dispatches', { json })` + `dispatchResultSchema.parse`, `onSuccess` invalida `['team-whatsapp','dispatches']`.
4. **RED — `send-whatsapp-dialog.spec.tsx`** (mockar `../api` com `vi.mock`; `describe`s ≤ 50 linhas): (a) setor com `recipientCount: 3` mostra "Setor Compras · 3 pessoa(s)"; (b) com um só canal ele vem selecionado e o botão "Enviar" fica desabilitado até digitar; (c) contador "9/2000" após digitar "Oi equipe"; (d) "Enviar" chama a mutação com `{ channelId: 'ch1', text: 'Oi equipe', target: { type: 'sector', sectorId: 's1' } }`; (e) sucesso `{ dispatchId:'d1', queued: 2, skipped: [{ userId:'u3', name:'Rui', reason:'NO_PHONE' }] }` → `toast.success('Mensagem enfileirada para 2 pessoa(s)', …)` com a descrição começando por "Os envios saem aos poucos, no ritmo do canal; para um setor grande pode levar alguns minutos." e contendo "Rui: sem telefone"; (f) `HTTPError` 409 `team_whatsapp.channel_disconnected` → mensagem PT-BR visível no diálogo. `cd frontend && timeout 600 gate --test src/features/team-whatsapp/components/send-whatsapp-dialog.spec.tsx` → falha.
5. **GREEN — `send-whatsapp-dialog.tsx`:** props `{ open: boolean; onOpenChange: (o: boolean) => void; target: SendTarget }`; lê canais de `useTeamTargets().data?.channels ?? []`; `Select` de canal (`name` + `formatPhoneBR(phoneE164)`), pré-seleciona quando `channels.length === 1`; `Textarea` `maxLength={2000}` com contador `${text.length}/2000`; "Enviar" desabilitado se sem canal, `text.trim() === ''` ou mutação pendente; destino: pessoa → `${label}`, setor → `Setor ${label} · ${recipientCount} pessoa(s)`; erro: lê `code` do `HTTPError` (mesma leitura de corpo de `phone-errors.ts`) e mostra `teamErrorMessage(code)`; sucesso: toast GC14 com `description` = `[PACING_HINT, ...skipped.map((s) => \`${s.name}: ${SKIP_REASON_LABEL[s.reason]}\`)].join('\n')` (`PACING_HINT` = "Os envios saem aos poucos, no ritmo do canal; para um setor grande pode levar alguns minutos.", exportado de `error-messages.ts`) e fecha. Sem canais: texto "Nenhum canal GoZap ou Evolution ativo." e "Enviar" desabilitado. Verde.
6. **RED — `whatsapp-equipe/index.spec.tsx`:** (a) `useTeamTargets` em erro `HTTPError` 403 → mostra "Só o administrador e o gestor do setor enviam mensagens para a equipe."; (b) com 1 setor e 3 membros (um sem telefone, um inativo) → lista nomes, "(92) 99123-4567", "sem telefone", badge de inativo; "Enviar" desabilitado para o sem telefone e para o inativo; "Enviar ao setor" abre o diálogo com `recipientCount` = membros ativos com telefone; (c) envios recentes listam `target.label`, `author.name`, `channel.name` e as contagens; envio com `channel: null` mostra "canal removido". `cd frontend && timeout 600 gate --test src/routes/_authenticated/whatsapp-equipe/index.spec.tsx` → falha.
7. **GREEN — página:** `createFileRoute('/_authenticated/whatsapp-equipe/')({ component: TeamWhatsappPage })`; título "WhatsApp da equipe"; `TeamWhatsappPage` só decide estado (carregando / 403 → estado vazio / lista) e delega a `TeamSectorCard` (setor: nome, código, membros, "Enviar ao setor" desabilitado se `recipientCount === 0`; por membro: nome, `member.phoneE164 ? formatPhoneBR(member.phoneE164) : 'sem telefone'`, inativo, "Enviar") e `RecentDispatches` (tabela: data `pt-BR`, autor `author?.name ?? author?.email ?? '—'`, destino, canal `channel?.name ?? 'canal removido'`, "Enfileirados N · Enviados N · Falhas N · Pulados N"; vazio → "Nenhum envio ainda."). Um único `SendWhatsappDialog` controlado por `useState<SendTarget | null>`. Regenerar `routeTree.gen.ts` pelo gerador do projeto. Verde.
8. **RED/GREEN — NAV** (`nav.spec.ts`): `navSection('ops', 'SUPERVISOR')` inclui `/whatsapp-equipe`; `navSection('ops', 'VIEWER')` não; `canAccessPath('/whatsapp-equipe', 'OPERATOR') === true` e `'VIEWER' === false`; `navLabelFor('/whatsapp-equipe') === 'WhatsApp da equipe'`. Em `nav.ts`, depois de `/nova-comunicacao`: `{ to: '/whatsapp-equipe', label: 'WhatsApp da equipe', icon: MessageCircle, section: 'ops', roles: WRITE_INTERNAL_ROLES }`. Ajustar asserções existentes de listas exatas da seção `ops`. `cd frontend && timeout 600 gate --test src/lib/nav.spec.ts`.
9. **RED/GREEN — Usuários** (`users/index.spec.tsx`, `describe` novo): menu "Ações" tem "Enviar WhatsApp"; desabilitado com `title="Usuário sem telefone"` para `phoneE164: null` e `title="Usuário inativo"` para `isActive: false`; habilitado abre o diálogo com `target = { type: 'user', userId, label: name ?? email }`. Em `users/index.tsx`: `<DropdownMenuItem disabled={!user.phoneE164 || !user.isActive} title={…} onClick={() => dialogs.setWhatsappTarget(user)}>Enviar WhatsApp</DropdownMenuItem>` depois de "Ver permissões", e o estado `whatsappTarget` em `UserDialogState` renderizando `SendWhatsappDialog`. `cd frontend && timeout 600 gate --test src/routes/_authenticated/users/index.spec.tsx`.
10. **Novidade** — topo de `RELEASE_NOTES`:
    ```ts
    {
      version: '2026.10.16',
      date: '2026-10-16',
      title: 'Telefone no cadastro e WhatsApp para a equipe',
      items: [
        {
          text: '"Convidar usuário" agora se chama "Cadastrar usuário" e pede o telefone (WhatsApp) da pessoa. A lista de usuários mostra o telefone de cada um.',
          where: '/users',
        },
        {
          text: 'Nova tela "WhatsApp da equipe": o administrador e o gestor do setor mandam uma mensagem de WhatsApp para uma pessoa ou para o setor inteiro. As mensagens saem aos poucos, no ritmo do canal: para um setor grande pode levar alguns minutos. As respostas chegam no WhatsApp do número conectado.',
          where: '/whatsapp-equipe',
        },
        { text: 'O link "Ver" das Novidades só aparece quando você tem acesso à tela.' },
      ],
    },
    ```
    RED antes da entrada: `describe` novo em `release-notes.spec.ts` (o teste-lembrete existente não fixa o conteúdo):
    ```ts
    describe('novidade 2026.10.16', () => {
      it('é a primeira entrada e aponta para /whatsapp-equipe', () => {
        expect(RELEASE_NOTES[0].version).toBe('2026.10.16');
        expect(RELEASE_NOTES[0].items.some((i) => i.where === '/whatsapp-equipe')).toBe(true);
      });
    });
    ```
    `cd frontend && timeout 600 gate --test src/release-notes.spec.ts` → falha; com a entrada → verde.
11. **Fechamento:** `cd frontend && timeout 600 gate --changed --base origin/main` verde.

---

## Fechamento da feature (principal)

Depois das 6 tasks integradas: gate completo por pacote (`backend/` e `frontend/`) comparado à baseline de `dce9ef9` (dívida legada conhecida não bloqueia; regressão nova bloqueia); `prisma migrate diff`/migration-drift; e2e no CI (inclui `frontend/e2e/users-phone.spec.ts`); revisão independente por task (opus em T2, T4a, T4b). Pendências para o aceite em produção: o primeiro deploy roda `merge-duplicate-phone-contacts.ts --apply` com o reapontamento novo; conferir no log do job `migrate` que `pares que FALHARAM` não subiu e se algum conflito traz o campo `user` (usuário do perdedor ficou sem contato; religa ao editar o telefone).
