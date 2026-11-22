# OrgaMind, Etapa 5 GBR, Lote K1: caixa — situação da conversa e um atendente por vez (MSG-03). Implementation Plan

> **Para os agentes:** executar pela skill `sdd` (TDD, ledger em `.superpowers/sdd/2026-11-21-orgamind-gbr-etapa5-lote-k1-caixa/progress.md`). **Sem commit/push**: nenhuma task commita; a principal integra e commita o lote. Branch `feat/caixa-situacao`, sobre `feat/panorama-estrutura` em `230c045` (Lote J, PR #22). Fechamento de task por `gate --changed --base feat/panorama-estrutura`. Regras dos agentes: `.superpowers/sdd/2026-11-21-orgamind-gbr-etapa5-lote-k1-caixa/{implementer-rules,reviewer-rules}.md` (criadas na Preparação). Linhas citadas são pistas e podem ter mudado.

**Goal:** (1) cada conversa da caixa tem situação calculada (Pendente, Em atendimento, Resolvida), a lista mostra "Abertas" por padrão e "Resolvidas" no seletor; (2) resolver e reabrir (manual e automático pela mensagem recebida ao vivo), com gravação condicional e 409; (3) só o atendente responde, por texto e por mídia, e a resposta numa conversa sem atendente a assume; (4) assumir, transferir e remover com gravação condicional, destino filtrado e rota nova de destinos; (5) histórico da conversa só de inclusão, visível na própria conversa; trilha `conversation.assign` em toda troca de atendente.

**Architecture:** back — migração aditiva: coluna `Conversation.resolvedAt` e tabela `ConversationHistoryEntry` (enum de ações já com a passagem de turno do K3, que não terá migração). Situação calculada no mapper do resumo. Toda mudança de atendente ou situação passa por um núcleo único (`conversation-ownership.repository.ts`): transação interativa que trava a linha da conversa (`SELECT … FOR NO KEY UPDATE`), confere o estado esperado, grava conversa + linhas do histórico + trilha `recordChange` na mesma transação, e só depois publica `conversation.updated`. Serviço e controller novos (`ConversationOwnershipService`, `ConversationOwnershipController`) com resolver, reabrir, atribuir (rota movida), histórico e destinos. A trava de resposta é uma função (`claimForReply`) chamada no texto e na mídia antes de gravar. A ingestão troca a última atualização da conversa por uma transação travada que avança `lastInboundAt` e reabre no mesmo passo. Front — contrato tolerante, hooks novos, mapa de mensagens por `code`, seletor Abertas/Resolvidas, cabeçalho com situação e ações, compositor travado, "Histórico da conversa" e Novidades.

**Tech Stack:** NestJS + Prisma 6 + Zod v4 + BullMQ + Vitest/testcontainers no back; React + TanStack Router/Query + ky 2 + Vitest/Testing Library no front. **Uma migração aditiva; sem dependência nova; sem chave de permissão nova.**

**Spec:** `docs/superpowers/specs/2026-11-21-orgamind-gbr-etapa5-pendencias-caixa.md` (APROVADA) — Intenção, Objetivos, Não objetivos, Anti-objetivos, Restrições, C1–C3, K1-1..K1-10, Limites conhecidos, "Para a GBR confirmar", Aceite K1 (1–11), "Fica com o construtor", Correções das revisões 1 e 2 (prevalecem). Sentença: `~/.claude/tribunais/2026-11-20/conselho-W/sentenca-W.md`. Mapas: `.superpowers/sdd/2026-11-21-orgamind-gbr-etapa5-lote-k1-caixa/{map-back-chat,map-front-chat}.md`.

## Estado (21/11/2026)

- Plano escrito; nenhuma task começou. Base `230c045` (`docs: add etapa 5 specs and lote J panorama/structure plan`) no branch `feat/caixa-situacao`.
- Não commitados de fora do lote: `.playwright-mcp/`, `reports/`, `research_notes/`, `tutoriais/` (preservar).
- 21/11: revisão 1 (opus) NEEDS_FIXES; ajustes aplicados (planejador sonnet). Mudanças: T4 dividida em T4a/T4b (13 tasks, 6 ondas); riscos reclassificados pela SKILL (crítico só T4a, T4b, T5); specs existentes nomeados em T4b/T5/T7; sem índice novo em `Conversation`; papel do ator por `req.user`; `OWNERSHIP_TX_OPTIONS` (DK22); `hasMore` no histórico.
- 21/11: revisão 2 do plano (opus) NEEDS_FIXES (1 Important, 5 Minor; os 12 da revisão 1 RESOLVIDOS); aplicados pela principal: DK22/GK11 sem `pg` cru (segundo `PrismaClient` dedicado com `connection_limit=2`, código sob teste com `connection_limit=5`), T6 para a Onda 6, teste de ALTER TABLE só com ADD, licença de ajuste de tipo na T2, teste de assumir numa resolvida na T4b, cosméticos. Re-revisão focada (opus): APPROVED; m6 aplicado (T6 × T5 pelo AppModule) e local do `connection_limit` explicitado. PLANO APROVADO.
- 21/11 (madrugada): Lote K1 implementado. 13 tasks aceitas (T3, T4a, T4b, T5 com revisão opus; demais sonnet); fix rounds: T3 (teste de hasAccess), T5 (max-params do ChatMediaService: desvio do DK10, ChatMediaService injeta ConversationOwnershipService e perde PrismaService), T9 e T10 (opus). T6 antecipada (só dependia da T4a) e extraiu `applyFinalUpdate` em vez da troca literal do bloco, para não piorar a complexidade do legado. Revisão final do conjunto (opus) APPROVED; um Minor reclassificado Important ("Assumir conversa" duplo no cabeçalho e no aviso) corrigido e re-revisado (opus). Gates completos sozinhos contra `origin/main`: back 7436/7466 (30 ignorados), coverage 95.5%, 0 novos depois de dividir dois `describe` longos; front 2595/2595, coverage 89.9%, 0 novos. QA visual: 10 critérios; o C10 (cabeçalho a 375 px) falhou e foi corrigido (flex-wrap). Limites conhecidos no ledger: falha da transação final da ingestão depois do INSERT, transação travada por mensagem recebida (observar P2028), publish depois do commit com Redis fora.
- **Próximo passo:** commits, push e PR rascunho sobre `feat/panorama-estrutura` (#22); depois K2 (pendências) e K3 (passagem de turno).

## Preparação (principal, antes da T1)

1. Conferir `git merge-base feat/caixa-situacao feat/panorama-estrutura` = `230c045` (senão o `--changed` mede o Lote J junto). Em worktree: `backend/.env` fictício e `node_modules` por symlink (memória "gate em worktree").
2. Criar `implementer-rules.md` e `reviewer-rules.md` em `.superpowers/sdd/2026-11-21-orgamind-gbr-etapa5-lote-k1-caixa/`, copiando os do Lote J e adaptando: branch `feat/caixa-situacao`, base `feat/panorama-estrutura`, este plano, a spec da Etapa 5 parte B, o ledger novo; referências `DKn`, `GKn` e `CKn` anexadas no fim do brief; "os Lotes A–J estão prontos no branch; não revisar nem mexer fora do ownership"; timeout de shell de no máximo 600 s em subagente. Riscos do lote no `reviewer-rules.md` (copiar o Review Focus abaixo).
3. Criar o ledger `progress.md` com a referência de partida (`230c045`) e os não commitados de fora do lote.
4. Depois da T1, rodar `cd backend && npx prisma generate` no checkout onde as tasks seguintes rodam (o cliente Prisma precisa dos tipos novos antes da Onda 2).

## Decisões deste plano (o que a spec deixa com o construtor)

- **DK1. Migração** `backend/prisma/migrations/20261121100000_conversation_situation_history/migration.sql`, aditiva, com `SET LOCAL lock_timeout = '15s';` no topo (padrão de `20261119110000_user_assignment_history/migration.sql:7-12`, com o comentário de por que e de `prisma migrate resolve --rolled-back` se estourar):
  - `CREATE TYPE "ConversationHistoryAction" AS ENUM ('ASSUMED', 'ASSUMED_ON_REPLY', 'TRANSFERRED', 'UNASSIGNED', 'RESOLVED', 'REOPENED', 'SHIFT_HANDOVER');` — `SHIFT_HANDOVER` entra já porque "K3 não tem migração" (spec, Restrições).
  - `ALTER TABLE "Conversation" ADD COLUMN "resolvedAt" TIMESTAMP(3);` (nula, sem default: nenhuma linha é reescrita; `archivedAt` não é tocado nem reutilizado, K1-1).
  - `CREATE TABLE "ConversationHistoryEntry"` com `id TEXT PK`, `conversationId TEXT NOT NULL`, `action "ConversationHistoryAction" NOT NULL`, `actorId TEXT` (nulo = "Sistema"), `fromUserId TEXT`, `toUserId TEXT`, `note VARCHAR(200)`, `createdAt TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP`.
  - FK só para a conversa: `conversationId → "Conversation"(id) ON DELETE CASCADE ON UPDATE CASCADE` (o reparo de duplicados apaga conversa perdedora, `chat-ingest.service.ts:737-741`; com RESTRICT ele quebraria; as mensagens já são Cascade, `schema.prisma` `Message.conversationId`). **Sem FK** em `actorId`, `fromUserId`, `toUserId`: o histórico sobrevive à exclusão do usuário, como `AuditEvent.subjectUserId` ("sem FK: o histórico sobrevive à exclusão", `schema.prisma:1262-1265`).
  - Índice: só `ConversationHistoryEntry(conversationId, createdAt)` (tabela nova, vazia: sem espera). **Nenhum índice novo em `Conversation`** (revisão 1, M3): `lock_timeout` limita só a espera, não a construção, e `CREATE INDEX CONCURRENTLY` não roda dentro da transação do `SET LOCAL`; sem o índice, a ingestão não fica travada durante o build. A lista sem `instanceId` usa os índices de hoje (`schema.prisma:962`); se a medição em produção pedir índice, vai em migração separada, com `CONCURRENTLY` e fora de transação (ver "Não verificado").
  - Nenhum `UPDATE`, `DELETE`, `DROP` ou backfill: conversas existentes ficam com `resolvedAt` nulo, portanto "Em atendimento" se têm atendente e "Pendente" se não (K1-1).
  - Prisma: `Conversation` ganha `resolvedAt DateTime?`, `history ConversationHistoryEntry[]` (sem `@@index` novo); modelo `ConversationHistoryEntry` com `@@index([conversationId, createdAt])`; enum `ConversationHistoryAction`. Só de inclusão: nenhum código faz `update`/`delete` nessa tabela (o repositório expõe só `create` e leitura; conferido por teste, T3).
  - **DDL:** o SQL sai do `prisma migrate diff` (do esquema anterior ao novo) e depois é editado à mão: o diff pode gerar um `DROP` de objeto de quarentena/deriva que **não** pertence a esta migração e deve ser removido; o SQL final não tem comando `UPDATE`, `DELETE FROM`, `DROP` nem `INSERT` (o teste estático olha comandos, não comentários e não o `ON DELETE CASCADE ON UPDATE CASCADE` da FK; T1).
- **DK2. Situação calculada (K1-1)** no mapper `conversation-summary.mapper.ts:30-65`: `status = row.resolvedAt ? 'RESOLVED' : row.assignedUserId ? 'IN_PROGRESS' : 'PENDING'`. O resumo ganha `status`, `resolvedAt` (ISO ou null), `lastInboundAt` (ISO ou null; o front devolve no "Resolver") e `assignedUserActive` (`assignedUser.isActive && assignedUser.hasAccess`; null sem atendente; K1-8). `conversationSummaryInclude.assignedUser` passa a `select: { name, isActive, hasAccess }` (`:16`).
- **DK3. Lista (K1-10)** `listConversationsQuerySchema` (`chat.schema.ts:4-20`) ganha `status: z.enum(['open', 'resolved']).default('open')`. Repositório (`chat.repository.ts:12`): `archivedAt: null` continua sempre; `open` → `resolvedAt: null`; `resolved` → `resolvedAt: { not: null }`. Filtros `filter`, `search`, `instanceId`, `assignee`, `provider` combinam com os dois; ordem e paginação iguais (`:50`). O servidor não recusa `assignee` com `resolved` (dá vazio ou todas; o front não manda, K1-10).
- **DK4. Núcleo de propriedade** (`backend/src/modules/chat/conversation-ownership.repository.ts`, CK4). Toda escrita de atendente ou situação (resolver, reabrir manual, atribuir, reivindicação na resposta) é uma transação interativa com isolamento padrão (READ COMMITTED, sem `isolationLevel`) e com `OWNERSHIP_TX_OPTIONS` fixo (`{ timeout: 10_000, maxWait: 5_000 }`, DK22; o padrão do Prisma, 5 s e 2 s, estoura sob espera de trava):
  1. `SELECT id, "instanceId", "assignedUserId", "resolvedAt", "lastInboundAt" FROM "Conversation" WHERE id = ${id} FOR NO KEY UPDATE` (`Conversation` não tem `@@map`, `schema.prisma:920-966`); linha ausente → `NotFoundError('Conversation', id)`;
  2. confere o estado esperado em TypeScript sobre a linha travada; divergência → lança o 409 dentro da transação (rollback: nada gravado);
  3. `applyOwnershipChange`: atualiza a conversa, insere as linhas do histórico e, se o atendente mudou, `audit.recordChange(tx, …)` (DK7), tudo no mesmo `tx`;
  4. depois do commit, `events.publish({ type: 'conversation.updated', conversationId, instanceId })`.
  Isso é a "gravação condicional" da spec: checagem e escrita atômicas sob a trava da linha. Ninguém mais grava `assignedUserId`, `assignedAt` ou `resolvedAt` fora deste núcleo (a gravação cega `chat.repository.ts:82-87` e `ChatService.assignConversation`, `chat.service.ts:157-173`, são removidas).
- **DK5. Resolver (K1-3)** `POST chat/conversations/:id/resolve`, corpo `{ expectedAssigneeId: string | null, expectedLastInboundAt: string | null, note? }` (os dois "expected" obrigatórios; ausente → 400). Ordem: trava → 404 → **403 `chat.not_assignee`** se o ator não é ADMIN e `expectedAssigneeId !== actorId` (portanto conversa Pendente só o ADMIN resolve) → **409 `chat.conversation_changed`** se `resolvedAt !== null` ou `assignedUserId !== expectedAssigneeId` ou `lastInboundAt` (ms) `!== expectedLastInboundAt` → grava `resolvedAt = now`, `assignedUserId = null`, `assignedAt = null`, linha `RESOLVED` (de = atendente anterior), trilha `conversation.assign` com atendente vazio se havia atendente. Não toca `botPausedAt`. Assim o ator na condição atômica é o próprio atendente (salvo ADMIN): um OPERATOR só grava se a linha travada ainda está com ele.
- **DK6. Atribuir (K1-7)** `POST chat/conversations/:id/assign` (rota movida de `chat.controller.ts:63-67` para o controller novo, mesmo caminho e status 200), corpo `{ userId: string | null, expectedAssigneeId: string | null, note? }`; `expectedAssigneeId` obrigatório (`z.string().nullable()` sem `.optional()`; ausente → 400). Tipo da ação: `userId === null` → remover; `userId === actorId` → assumir; outro → transferir. Ordem:
  1. destino (`userId` não nulo): `findEligibleAssignee` = usuário com `isActive: true`, `hasAccess: true`, `role in ['ADMIN','OPERATOR']`; senão `NotFoundError('User', userId)` (o mesmo 404 `user.not_found` de hoje, `chat.service.ts:160-166`), antes de travar;
  2. trava → 404 da conversa;
  3. **403 `chat.not_assignee`**: remover, se o ator não é ADMIN e `expectedAssigneeId !== actorId`; transferir, se o ator não é ADMIN e `expectedAssigneeId !== null` e `expectedAssigneeId !== actorId`; assumir, nunca (K1-7, K1-8: "qualquer um com acesso à caixa pode assumir");
  4. **409 `chat.conversation_changed`** se `assignedUserId !== expectedAssigneeId`, com `detail` do atendente atual (CK3);
  5. sem efeito (o pedido já é o estado: assumir o que já é meu e está aberto; remover sem atendente) → 200 com o resumo, nada gravado, nenhum evento;
  6. grava: assumir/transferir → `assignedUserId = userId`, `assignedAt = now`, `botPausedAt = now` (pausa o robô, K1-7); se estava resolvida, `resolvedAt = null` e uma linha `REOPENED` antes da linha `ASSUMED`/`TRANSFERRED` (K1-7: "Assumir e transferir numa conversa resolvida a reabrem"); remover → `assignedUserId = null`, `assignedAt = null`, linha `UNASSIGNED`, sem tocar `botPausedAt`. Trilha `conversation.assign` em toda troca.
  Resposta: o `ConversationSummary` atualizado (hoje é 200 sem corpo; o front de hoje não lê o corpo, `frontend/src/features/chat/api.ts:246-251`).
- **DK7. Trilha** `conversation.assign` continua com o mesmo nome, mas gravada por `audit.recordChange(tx, { action: 'conversation.assign', entity: 'Conversation', entityId, category: null, changes: [{ field: 'assignedUserId', before, after }], metadata: { assignedUserId: after, assignedBy: actorId, kind }, actorId })` — mesma chave `metadata` de hoje (`chat.service.ts:171`) mais `kind` (a ação do histórico), sem `note`, sem nome (Anti-objetivo: "A trilha guarda ids e situações, não textos"). Para isso `AuditChange.category` (`backend/src/shared/audit/audit-change.ts:16`) passa de `AuditCategory` a `AuditCategory | null` (o repositório já grava `null`, `audit.repository.ts:14,47`). Categoria nula como hoje (`audit.log` usa `categoryOfAction`, sem prefixo de conversa): o evento **não** aparece em `/trilha` (`audit-trail.service.ts:53,76` filtra `category: { not: null }`), como hoje. **Sem rótulo novo** em `features/audit-trail/labels.ts`: nenhuma ação nova entra na trilha visível; a tela de quem/quando/por quê é o "Histórico da conversa" (K1-2).
- **DK8. Reabrir manual (K1-4)** `POST chat/conversations/:id/reopen`, corpo `{ note? }`: quem tem acesso à caixa; trava → 404 → 409 `chat.conversation_changed` se `resolvedAt === null` → `resolvedAt = null`, linha `REOPENED` com o ator; não toca atendente (resolvida já não tem) nem `botPausedAt`.
- **DK9. Reabertura automática (K1-4)** em `backend/src/modules/chat/conversation-inbound.ts` (CK6). A atualização final da ingestão (`chat-ingest.service.ts:785-797`) passa a chamar `applyInboundUpdate(prisma, { conversationId, data, reopenIfResolved })` com `reopenIfResolved = isInbound && !backfill` (`backfill` em `:477`; ecos entram por `ingestOutboundEcho`, `:866-869`, com `direction` OUTBOUND, e não reabrem; a importação de histórico usa `backfill`). Com `reopenIfResolved` falso, é o mesmo `conversation.update` de hoje. Com verdadeiro, uma transação: trava a linha (`FOR NO KEY UPDATE`), aplica `data` (resumo, `lastInboundAt`, `unreadCount`) **e** `resolvedAt: null` no mesmo `UPDATE` se a linha travada estava resolvida, e insere a linha `REOPENED` com `actorId: null` ("Sistema"). Sem trilha (atendente não muda: resolvida não tem atendente). Depois do `message.created` (`:799`), publica `conversation.updated` se reabriu. Por que é atômico: o "Resolver" trava a mesma linha; ou ele grava antes (a ingestão encontra resolvida e reabre) ou depois (a linha já tem o `lastInboundAt` novo e o "Resolver" recebe 409). A mensagem nunca fica numa conversa resolvida.
- **DK10. Trava de resposta (K1-5)** `claimForReply(deps, conversationId, actorId)` em `backend/src/modules/chat/conversation-claim.ts` (CK5), com o núcleo DK4. Na linha travada:
  - com o ator e aberta → nada a gravar, segue (`{ changed: false }`);
  - sem atendente (aberta ou resolvida) → `assignedUserId = actor`, `assignedAt = now`, `botPausedAt = now`, `resolvedAt = null`; linhas `REOPENED` (se estava resolvida) e `ASSUMED_ON_REPLY`; trilha `conversation.assign`; `conversation.updated` depois do commit;
  - com outro (inclusive o ator ADMIN, W4) → **409 `chat.assigned_to_other`** com `detail` do atendente (CK3), nada gravado.
  Como a decisão é tomada na linha travada, o ramo "falhou porque ficou sem atendente ou foi resolvida" da spec cai sozinho no ramo de reivindicação. Lugar:
  - texto: `chat.service.ts` `sendReply`, entre `assertSessionWindowOpen` (`:184`) e `createOutboundMessage` (`:191`);
  - mídia: `chat-media.service.ts` `sendMediaReply`, logo depois de `assertProviderEnabled` (`:53`) e **antes** de montar a chave e de `store.put` (`:60-61`).
  A atribuição feita na reivindicação permanece se o envio falhar (K1-5).
  - **Janela residual aceita (revisão 1, M5):** a trava da linha é solta no commit do `claimForReply`, antes do `INSERT` da `Message` (`createOutboundMessage`). Uma transferência commitada entre os dois deixa a resposta do antigo atendente gravada depois da troca. A spec aceita: cada um assumiu de forma registrada no histórico (Anti-objetivo "sem que uma tenha assumido de forma registrada" fica satisfeito). Não se fecha a janela (seria segurar a trava durante o envio ao provedor); nenhum teste a prova, e o revisor não a trata como defeito.
  - `ChatService` usa `this.prisma`, `this.audit`, `this.events` (já injetados, `chat.service.ts:129-135`; construtor não muda); `ChatMediaService` ganha `AuditService` como **último** parâmetro do construtor (`chat-media.service.ts:16-22`).
- **DK11. O que não passa pela trava (K1-9):** `prepareTeamMessage` (`chat.service.ts:219-245`), `sendTeamMessage` (`:252-`), `sendBotReply` (`:604-626`), `markRead` (`:558`), `sendTyping`, `bot/pause` e `bot/resume` não chamam `claimForReply` e não tocam `assignedUserId`/`resolvedAt`. Conferido por teste (T5).
- **DK12. Papéis e rotas (GK4).** Nenhuma rota do chat tem `@Roles`; o `RolesGuard` cai no legado ADMIN/OPERATOR (`roles.guard.ts:9-20`, negado com `auth.insufficient_role`). O controller novo `ConversationOwnershipController` (`@Controller('chat')`) também fica **sem** `@Roles` e sem `@RequirePermission` (spec: "caixa pela regra de papel atual"; "Nenhuma chave de permissão nova"). `route-parity.spec.ts` **não muda**: a tabela `PARITY` (`:59`) só lista controllers com papel explícito e o teste de completude (`:260-269`) só varre os controllers da própria tabela; o chat nunca esteve nela. A recusa de SUPERVISOR e VIEWER nas rotas novas é provada no spec do controller novo com o `RolesGuard` real. O papel do ator (ADMIN ou não) vem de `req.user.role`, e o id de `req.user.sub`; o controller monta `ChatActor = { id, role }` e passa ao serviço (CK4). Não há consulta extra: a `jwt.strategy.ts:44-54` já relê papel, `isActive` e `hasAccess` do banco a cada request (revisão 1, M4), então o papel de `req.user` é o atual.
- **DK13. Rotas de leitura novas:** `GET chat/conversations/:id/history` → `{ items, hasMore }` com as 200 linhas mais recentes, da mais nova para a mais antiga (o repositório lê 201 e corta; `hasMore` = a 201ª existe, M8), nomes resolvidos por `user.findMany({ where: { id: { in } } })` (id sem usuário → nome `null`; o front mostra "Usuário removido"); conversa inexistente → 404. `GET chat/assignees` → `{ items: { id, name }[] }` dos ADMIN e OPERATOR com `isActive` e `hasAccess`, ordem por nome (K1-7: "devolve só id e nome").
- **DK14. Formato do `detail` dos 409 (C3):** `JSON.stringify({ assignee: { id, name, active } | null })` — só id, nome e se está ativo do usuário do sistema; nunca contato ou pessoa da equipe. O filtro de erro não loga `message` nem `detail` (`domain-exception.filter.ts:113`). O front lê com `readApiErrorBody` e `parseAssigneeDetail` (CK8), tolerante a `detail` ausente ou inválido.
- **DK15. Observação** (`note`): `z.string().trim().max(200).optional()`; vazia depois do `trim` → `null`. Gravada só no histórico (`VARCHAR(200)`), nunca na trilha nem em log. O front oferece observação em Resolver, Reabrir, Transferir e Remover; "Assumir conversa" é um clique, sem observação (a API aceita).
- **DK16. Front — situação e ações** (textos exatos):
  - situação: `PENDING` "Pendente", `IN_PROGRESS` "Em atendimento", `RESOLVED` "Resolvida"; sem `status` no resumo (contrato antigo), calcula pelos campos como DK2;
  - atendente: "{nome}" ou "{nome} (inativo)" com `assignedUserActive === false` (K1-8);
  - botões (função pura `conversationActions(conv, me)`): aberta e minha → "Resolver", "Transferir", "Remover atendente"; aberta e de outro → "Assumir conversa", e para o ADMIN também "Resolver", "Transferir", "Remover atendente"; Pendente → "Assumir conversa", "Transferir", e para o ADMIN "Resolver"; Resolvida → "Reabrir", "Assumir conversa", "Transferir". Um OPERATOR que não é o atendente não vê "Resolver" (aceite 2);
  - "Transferir" abre a lista de `GET chat/assignees` sem o atendente atual e sem quem olha;
  - diálogo de observação: título "Resolver conversa" / "Reabrir conversa" / "Transferir para {nome}" / "Remover atendente", campo "Observação (opcional)" com `maxLength` 200, botões "Cancelar" e "Confirmar";
  - mensagens por `code` (toast): `chat.not_assignee` → "Só quem está atendendo a conversa ou um administrador pode fazer isso."; `chat.conversation_changed` → "A conversa mudou enquanto você olhava. Ela foi recarregada; confira e tente de novo."; `user.not_found` → "Esta pessoa não pode receber a conversa. Escolha outra."; outro → "Não foi possível concluir a ação. Tente de novo." Em 403 e 409, a conversa, a lista e o histórico são invalidados (a tela recarrega, aceite 3).
- **DK17. Front — compositor (K1-6):** travado quando a conversa tem atendente diferente de quem olha e não está resolvida, ou depois de um 409 `chat.assigned_to_other` (até a conversa recarregada mostrar outro estado ou o "Assumir conversa" dar certo). Mostra "{Nome} está atendendo esta conversa." e o botão "Assumir conversa" (atribuir com `userId = eu`, `expectedAssigneeId` = atendente mostrado). O texto continua editável e é mantido; "Enviar", Enter e o clipe de anexo ficam desligados (a mídia também recebe 409). Conversa sem atendente ou resolvida: envio liberado (a resposta assume).
- **DK18. Front — lista (K1-10):** seletor "Abertas" (padrão) / "Resolvidas", botões com `aria-pressed`; em "Resolvidas" as abas de atendente somem e a consulta não manda `assignee`; "Todas / Não lidas / Aguardando" e a busca continuam. Cada linha mostra a situação. Filtros continuam em estado local (sem URL, sem `validateSearch`).
- **DK19. Front — histórico (K1-2):** seção recolhível "Histórico da conversa" na conversa; a consulta só roda ao abrir; linhas "{dd/MM HH:mm} · {texto}", hora de Manaus, textos: `ASSUMED` "{autor} assumiu a conversa"; `ASSUMED_ON_REPLY` "{autor} assumiu ao responder"; `TRANSFERRED` "{autor} transferiu para {para}" (com de: "{autor} transferiu de {de} para {para}"); `UNASSIGNED` "{autor} removeu o atendente {de}"; `RESOLVED` "{autor} resolveu a conversa"; `REOPENED` "{autor} reabriu a conversa", e sem autor "Sistema reabriu a conversa (nova mensagem recebida)"; `SHIFT_HANDOVER` "{autor} passou o turno de {de} para {para}". Autor nulo → "Sistema"; id sem nome → "Usuário removido". Com observação, segunda linha "Observação: {texto}". Com `hasMore` verdadeiro, rodapé da lista: "Mostrando as 200 mudanças mais recentes." (sem `hasMore`, sem rodapé; M8). Vazio → "Nenhuma mudança registrada." Carregando → "Carregando histórico…"; erro → "Não foi possível carregar o histórico" com "Tentar de novo".
- **DK20. Tempo real:** nenhum evento novo. `conversation.updated` já existe (`chat-events.service.ts:8-12`), e o stream do front invalida a conversa e a lista para qualquer evento (`use-chat-stream.ts:90-99`). O histórico usa a chave `['chat','conversations',id,'history']`, que `invalidateConversationThread` (`frontend/src/features/chat/api.ts:172-176`, predicado `queryKey[2] === conversationId`) já cobre. Os destinos usam `['chat-assignees']` (fora do prefixo `chat`, para não recarregar a cada evento).
- **DK21. Novidades (C2):** uma entrada K1 no topo de `RELEASE_NOTES`, versão `YYYY.MM.DD.n` do dia da implementação, maior que a do topo de hoje (`2026.11.21.1`, Lote J); data não futura. Avisa que conversas já atribuídas passam a exigir "Assumir conversa" de quem não é o atendente.

- **DK22. Prazos das transações (revisão 1, M6).** O Prisma dá às transações interativas `timeout` 5 s e `maxWait` 2 s por padrão; uma trava externa segurada por mais tempo gera P2028 e teste instável. Código: `export const OWNERSHIP_TX_OPTIONS = { timeout: 10_000, maxWait: 5_000 } as const;` em `conversation-ownership.repository.ts`, passado em **toda** `prisma.$transaction(fn, OWNERSHIP_TX_OPTIONS)` do núcleo, do `claimForReply` e do `applyInboundUpdate`. Testes de corrida (revisão 2, IMP-1): `pg` **não** é dependência direta do backend (`backend/package.json`, conferido em 21/11), então não há cliente cru. A trava externa e o poll usam um **segundo `PrismaClient` dedicado**, com `datasourceUrl` próprio e `connection_limit=2` (a trava segura `SELECT id FROM "Conversation" WHERE id = … FOR NO KEY UPDATE` dentro de `$transaction(fn, { timeout: 30_000, maxWait: 10_000 })` até o teste liberá-la por uma promessa; o poll de `pg_stat_activity` roda pela segunda conexão desse cliente). O código sob teste usa outro `PrismaClient` com `connection_limit=5` (ou mais) na URL, para que comando 1, comando 2 e o INSERT da `Message` nunca esperem conexão. Poll a cada 50 ms com limite de 5 000 ms; `it` com timeout de 30 000 ms. Sem dependência nova.

## Global Constraints

- **GK1. Escopo.** Back: `backend/prisma/schema.prisma` (só os campos e o modelo de DK1), a migração nova, `backend/src/schemas/contracts/chat.schema.ts`, `backend/src/modules/chat/` (mapper, repositório, `chat.service.ts`, `chat-media.service.ts`, `chat-ingest.service.ts`, `chat.controller.ts`, `chat.module.ts`, arquivos novos), `backend/src/shared/audit/audit-change.ts` (uma linha, DK7). Front: `frontend/src/features/chat/` e `frontend/src/release-notes.ts`. **Não mudam:** `route-parity.spec.ts`, catálogo de permissões, `roles.guard.ts`, `canViewDispatch`, team-whatsapp, bot, `features/audit-trail/labels.ts`, `features/users/`, `features/internal-communications/` (a `/caixa-de-entrada` é outra tela).
- **GK2. Restrições da spec:** "Migrações aditivas, com `lock_timeout`, sem mudar linha existente". "Nenhuma chave de permissão nova: caixa pela regra de papel atual". "`canViewDispatch` não muda." "Testes nunca mandam WhatsApp real." Anti-objetivos: "Duas pessoas responderem a mesma conversa sem que uma tenha assumido de forma registrada." "Uma resposta ser gravada ou enviada quando o servidor recusou a reivindicação." "Resolver, reabrir, transferir ou passar turno retomarem o robô." "Texto de resposta, anotação, motivo, observação, nome ou telefone de pessoas da equipe em log. A trilha guarda ids e situações, não textos."
- **GK3. Gravação condicional** (spec, Vocabulário): "uma escrita que só acontece se o estado ainda for o que a tela mostrava, num único comando atômico; se não bater, nada é gravado e a resposta é 409". Implementação única: DK4 (trava da linha + conferência + escrita + histórico + trilha na mesma transação; evento só depois do commit). Nenhuma escrita de `assignedUserId`, `assignedAt` ou `resolvedAt` fora do núcleo, salvo a reabertura da ingestão (DK9), que usa a mesma trava.
- **GK4. Papéis:** rotas do chat sem `@Roles`/`@RequirePermission` → `RolesGuard` legado: só ADMIN e OPERATOR (`roles.guard.ts:9-20`; SUPERVISOR e VIEWER recebem 403 `auth.insufficient_role`). "Quem tem acesso à caixa" = "ADMIN ou OPERATOR, ativo e com acesso ao sistema". `route-parity.spec.ts` não muda (DK12). Papel do ator de `req.user.role` (DK12, M4).
- **GK5. Códigos:** 403 `chat.not_assignee` (resolver, remover, transferir conversa com atendente, por quem não é o atendente nem ADMIN); 409 `chat.conversation_changed` (estado esperado diferente, `detail` DK14); 409 `chat.assigned_to_other` (resposta em conversa de outro, `detail` DK14); 404 `user.not_found` (destino inativo, sem acesso, SUPERVISOR ou VIEWER, ou inexistente); 400 de validação (campo `expected…` ausente, `note` > 200). Erros como `DomainError` com `code` (`shared/errors/domain.error.ts:1-21`; `detail` é `string`).
- **GK6. Validação:** cwd `backend/` ou `frontend/`. Loop: `cd backend && TESTCONTAINERS_ENABLED=1 timeout 600 gate --test src/<arquivo>` (integração) ou `cd backend && timeout 600 gate --test src/<arquivo>`; `cd frontend && timeout 600 gate --test src/<arquivo>`. Tipos: back `npx tsc --noEmit -p tsconfig.build.json --tsBuildInfoFile /tmp/<task>.tsbuildinfo`; front `npx tsc -b`. Fechamento: `cd backend && TESTCONTAINERS_ENABLED=1 timeout 600 gate --changed --base feat/panorama-estrutura`; `cd frontend && timeout 600 gate --changed --base feat/panorama-estrutura`. Nunca suíte inteira, gate completo, coverage ou e2e (são da principal). No máximo dois testcontainers ao mesmo tempo (a principal serializa). Se 600 s não bastarem, devolver ao controlador.
- **GK7. Compila entre tasks:** assinatura existente só ganha campo ou parâmetro opcional, salvo onde a task diz e ajusta chamadores e specs no próprio ownership. Campos novos de contrato: obrigatórios no back (quem cria preenche), tolerantes no front (`.nullish()`). A principal roda o `tsc` do back e do front depois de cada onda. Sem commit.
- **GK8. Tempo e dados nos testes:** fixtures gravam `createdAt`/`receivedAt` explícitos; nada de `vi.setSystemTime` com linha gravada pelo banco (memória "relógio falso × createdAt"). Nomes e telefones fictícios ("Atendente A", `+5592991110001`). `WhatsappProvidersService` e `MediaStore` sempre falsos nos testes.
- **GK9. Tamanho e legado:** funções e callbacks de `describe`/`it` até 50 linhas, ciclomática 10, cognitiva 15, profundidade 4, até 4 parâmetros; `describe` novos em arquivo novo (o que existe não cresce); conferir com `npx eslint <arquivos> --rule '{"max-lines-per-function": ["error", 50], "max-params": ["error", 4], "complexity": ["error", 10], "max-depth": ["error", 4]}'`. `prettier --write` só em arquivo novo; nunca em arquivo legado; nunca restaurar arquivo do git. **Legados** (só recebem as trocas que a task diz; lógica nova em arquivo novo): `schema.prisma`, `chat.schema.ts`, `conversation-summary.mapper.ts`, `chat.repository.ts`, `chat.service.ts`, `chat-media.service.ts`, `chat-ingest.service.ts`, `chat.controller.ts`, `chat.module.ts`, `audit-change.ts`; front `features/chat/api.ts`, `schemas.ts`, `components/conversations-list.tsx`, `conversation-row.tsx`, `message-thread.tsx`, `message-composer.tsx`, `assign-menu.tsx`, `release-notes.ts`.
- **GK10. Front:** corpo de erro HTTP só por `readApiErrorBody` (`lib/api-error.ts:44`, assíncrona; ky 2 consome o corpo, o `code` está em `HTTPError.data`; memória "ky 2 consome corpo do erro"). Textos exatamente como DK16–DK19. A caixa não ganha filtro na URL (DK18), então a regra do TanStack Router (`validateSearch` devolve as chaves com `undefined`, porque o router mescla a busca crua) não se aplica neste lote.
- **GK11. Concorrência:** prova por **intercalação determinística** contra o Postgres do testcontainer, nunca com mock do repositório nem `Promise.all` solto. Isolamento padrão (READ COMMITTED) em todas as transações.
  - **Molde A removido (revisão 1, M7):** nenhum teste o usava; todas as corridas do lote usam o Molde B, em que os dois comandos são reais (serviço, `claimForReply`, `applyInboundUpdate`) e a ordem da fila de trava decide quem vê o estado de quem. Decisão: não manter molde sem teste.
  - **Trava externa e prazos (M6, DK22):** a trava externa é uma `$transaction` de um **segundo `PrismaClient` dedicado** (`connection_limit=2`; `SELECT id FROM "Conversation" WHERE id = ${id} FOR NO KEY UPDATE`, solta ao resolver uma promessa do teste), e o código sob teste usa um `PrismaClient` com `connection_limit=5` ou mais (DK22) — nos specs que sobem o `AppModule`, acrescente `?connection_limit=5` ao `DATABASE_URL` montado a partir da URI do container (o setup de `chat-ingest.integration.spec.ts:46` usa a URI crua); poll de `pg_stat_activity` (`wait_event_type = 'Lock'`) a cada 50 ms, limite 5 000 ms; `it` com timeout 30 000 ms; as transações do código sob teste usam `OWNERSHIP_TX_OPTIONS` (`{ timeout: 10_000, maxWait: 5_000 }`).
  - **Molde B (fila FIFO):** (1) trava externa, como acima; (2) comando 1 sem `await`, poll até 1 sessão bloqueada; (3) comando 2 sem `await`, poll até 2; (4) solta; (5) `await` dos dois: o 1 grava, o 2 vê o estado do 1.
  Cada teste de corrida diz num comentário do `it` qual implementação errada ele pega.
- **GK12. Migração:** aditiva, `SET LOCAL lock_timeout = '15s';`, sem comando `UPDATE`/`DELETE FROM`/`DROP`/`INSERT`/backfill (o teste olha comandos por linha sem comentário, não o texto `ON DELETE CASCADE ON UPDATE CASCADE`), **sem índice novo em `Conversation`** (M3), DDL igual ao que o `prisma migrate diff` gera para os modelos de DK1, menos um eventual `DROP` de quarentena/deriva, removido à mão. Testes de integração aplicam todas as migrações como `chat-ingest.integration.spec.ts` (`:4,:31-46`).

## Contratos compartilhados

**CK1. Prisma** (T1; DK1).

```prisma
model Conversation { /* … campos atuais … */
  resolvedAt DateTime?                          // K1-1: marca de resolução; archivedAt não é reutilizado
  history    ConversationHistoryEntry[]       // sem @@index novo em Conversation (M3)
}
enum ConversationHistoryAction { ASSUMED ASSUMED_ON_REPLY TRANSFERRED UNASSIGNED RESOLVED REOPENED SHIFT_HANDOVER }
model ConversationHistoryEntry {
  id             String                    @id @default(cuid())
  conversationId String
  conversation   Conversation              @relation(fields: [conversationId], references: [id], onDelete: Cascade)
  action         ConversationHistoryAction
  actorId        String?                   // null = Sistema; sem FK (sobrevive à exclusão do usuário)
  fromUserId     String?
  toUserId       String?
  note           String?                   @db.VarChar(200)
  createdAt      DateTime                  @default(now())
  @@index([conversationId, createdAt])
}
```

**CK2. Contrato da API** (T2; `backend/src/schemas/contracts/chat.schema.ts`; o front espelha na T7).

```ts
export type ConversationStatus = 'PENDING' | 'IN_PROGRESS' | 'RESOLVED';
// ConversationSummary ganha (obrigatórios no back):
//   status: ConversationStatus; resolvedAt: string | null; lastInboundAt: string | null;
//   assignedUserActive: boolean | null;   // null sem atendente
// listConversationsQuerySchema ganha: status: z.enum(['open', 'resolved']).default('open')
export const conversationNoteSchema = z.string().trim().max(200).optional();
export const assignConversationSchema = z.object({
  userId: z.string().nullable(),
  expectedAssigneeId: z.string().nullable(),          // obrigatório: ausente → 400
  note: conversationNoteSchema,
});
export const resolveConversationSchema = z.object({
  expectedAssigneeId: z.string().nullable(),
  expectedLastInboundAt: z.iso.datetime().nullable(),  // obrigatório
  note: conversationNoteSchema,
});
export const reopenConversationSchema = z.object({ note: conversationNoteSchema });
export type ConversationHistoryAction = 'ASSUMED' | 'ASSUMED_ON_REPLY' | 'TRANSFERRED' | 'UNASSIGNED' | 'RESOLVED' | 'REOPENED' | 'SHIFT_HANDOVER';
export type ConversationHistoryItem = {
  id: string; action: ConversationHistoryAction; createdAt: string;
  actorId: string | null; actorName: string | null;
  fromUserId: string | null; fromUserName: string | null;
  toUserId: string | null; toUserName: string | null;
  note: string | null;
};
export type ConversationHistoryResponse = { items: ConversationHistoryItem[]; hasMore: boolean };  // hasMore: há mais de 200 (M8)
export type ChatAssignee = { id: string; name: string };
export type ChatAssigneesResponse = { items: ChatAssignee[] };
export type AssignConversationInput = z.infer<typeof assignConversationSchema>;
export type ResolveConversationInput = z.infer<typeof resolveConversationSchema>;
export type ReopenConversationInput = z.infer<typeof reopenConversationSchema>;
// DTOs: dto/assign-conversation.dto.ts (existente, passa a usar o schema novo), dto/resolve-conversation.dto.ts e
// dto/reopen-conversation.dto.ts (createZodDto, padrão do assign-conversation.dto.ts)
```

**CK3. Erros** (T3; `backend/src/modules/chat/conversation-ownership.errors.ts`).

```ts
export type AssigneeRef = { id: string; name: string; active: boolean };
export function assigneeDetail(ref: AssigneeRef | null): string;      // JSON.stringify({ assignee: ref }) (DK14)
export function notAssignee(): DomainError;            // 'chat.not_assignee', 403, 'Só o atendente ou um administrador pode fazer isso.'
export function conversationChanged(current: AssigneeRef | null): DomainError; // 'chat.conversation_changed', 409, 'A conversa mudou.', detail
export function assignedToOther(current: AssigneeRef): DomainError;   // 'chat.assigned_to_other', 409, 'Outra pessoa está atendendo esta conversa.', detail
```

**CK4. Núcleo de propriedade** (T3; `backend/src/modules/chat/conversation-ownership.repository.ts`; funções sobre `tx`/`db`, sem classe).

```ts
export const OWNERSHIP_TX_OPTIONS = { timeout: 10_000, maxWait: 5_000 } as const; // DK22: em toda $transaction do núcleo, da trava de resposta e da ingestão
export type ChatActor = { id: string; role: string };   // do req.user (sub, role); o controller monta (DK12)
export type LockedConversation = { id: string; instanceId: string; assignedUserId: string | null; resolvedAt: Date | null; lastInboundAt: Date | null };
export async function lockConversation(tx: Prisma.TransactionClient, id: string): Promise<LockedConversation>; // FOR NO KEY UPDATE; ausente → NotFoundError('Conversation', id)
export type OwnershipChange = {
  conversation: LockedConversation;
  actorId: string | null;                        // null = Sistema
  assignedUserId: string | null;                 // depois
  resolved: boolean;                             // depois
  actions: ConversationHistoryAction[];          // linhas, nesta ordem (from = antes, to = depois)
  note: string | null; pauseBot: boolean; now: Date;
};
export async function applyOwnershipChange(tx: Prisma.TransactionClient, audit: AuditService, change: OwnershipChange): Promise<void>;
//   update: assignedUserId; assignedAt = now se mudou para não nulo, null se nulo, igual se igual; resolvedAt = now se passa a resolvida,
//   null se deixa de ser, igual se igual; botPausedAt = now só com pauseBot; insere as linhas; se o atendente mudou e actorId não nulo,
//   recordChange (DK7). Nunca toca botPausedAt para null.
export async function findAssigneeRef(db: Pick<Prisma.TransactionClient, 'user'>, userId: string): Promise<AssigneeRef | null>; // active = isActive && hasAccess
export async function findEligibleAssignee(db: Pick<Prisma.TransactionClient, 'user'>, userId: string): Promise<ChatAssignee | null>; // DK6.1
export async function listEligibleAssignees(db: Pick<Prisma.TransactionClient, 'user'>): Promise<ChatAssignee[]>;             // DK13
export async function listConversationHistory(db: PrismaService, conversationId: string): Promise<{ items: ConversationHistoryItem[]; hasMore: boolean }>; // DK13: lê 201, devolve 200, mais nova primeiro
// audit-change.ts: AuditChange.category: AuditCategory | null
```

**CK5. Serviço, controller e trava** (T3 cria; T4a acrescenta `resolve` e `reopen`; T4b acrescenta `assign`; T5 a trava).

```ts
// conversation-ownership.service.ts
@Injectable() export class ConversationOwnershipService {
  constructor(prisma: PrismaService, audit: AuditService, events: ChatEventsService, repo: ChatRepository);
  history(conversationId: string): Promise<ConversationHistoryResponse>;                       // T3
  assignees(): Promise<ChatAssigneesResponse>;                                                 // T3
  resolve(id: string, actor: ChatActor, input: ResolveConversationInput): Promise<ConversationSummary>; // T4a, DK5
  reopen(id: string, actor: ChatActor, input: ReopenConversationInput): Promise<ConversationSummary>;   // T4a, DK8
  assign(id: string, actor: ChatActor, input: AssignConversationInput): Promise<ConversationSummary>;   // T4b, DK6
}
// conversation-ownership.controller.ts — @Controller('chat'), sem @Roles (DK12), actor = { id: req.user.sub, role: req.user.role } (sub como chat.controller.ts:47-48)
//   GET  conversations/:id/history (T3)   GET assignees (T3)
//   POST conversations/:id/resolve  @HttpCode(200) (T4a)   POST conversations/:id/reopen @HttpCode(200) (T4a)
//   POST conversations/:id/assign   @HttpCode(200) (T4b; removida de chat.controller.ts)
// conversation-claim.ts (T5)
export type ClaimDeps = { prisma: PrismaService; audit: AuditService; events: ChatEventsService };
export async function claimForReply(deps: ClaimDeps, conversationId: string, actorId: string): Promise<{ changed: boolean }>; // DK10
```

**CK6. Ingestão** (T6; `backend/src/modules/chat/conversation-inbound.ts`).

```ts
export type InboundUpdate = { conversationId: string; data: Prisma.ConversationUpdateInput; reopenIfResolved: boolean };
export async function applyInboundUpdate(prisma: PrismaService, args: InboundUpdate): Promise<{ reopened: boolean }>; // DK9
```

**CK7. Front — contrato e hooks** (T7).

```ts
// features/chat/schemas.ts (tolerante)
export const conversationStatusSchema = z.enum(['PENDING', 'IN_PROGRESS', 'RESOLVED']);
// conversationSummarySchema + status: conversationStatusSchema.nullish(), resolvedAt: z.string().nullish(),
//   lastInboundAt: z.string().nullish(), assignedUserActive: z.boolean().nullish()
export const historyActionSchema = z.enum(['ASSUMED','ASSUMED_ON_REPLY','TRANSFERRED','UNASSIGNED','RESOLVED','REOPENED','SHIFT_HANDOVER']);
export const conversationHistorySchema = z.object({ items: z.array(z.object({ id: z.string(), action: historyActionSchema, createdAt: z.string(),
  actorId: z.string().nullable(), actorName: z.string().nullable(), fromUserId: z.string().nullable(), fromUserName: z.string().nullable(),
  toUserId: z.string().nullable(), toUserName: z.string().nullable(), note: z.string().nullable() })), hasMore: z.boolean().nullish() });
export const chatAssigneesSchema = z.object({ items: z.array(z.object({ id: z.string(), name: z.string() })) });
// features/chat/api.ts
export type ConversationListParams = { filter: 'all' | 'unread' | 'awaiting'; search: string; status: 'open' | 'resolved';
  instanceId?: string; assignee?: string; provider?: ChannelProvider };
chatQueries.conversationList(params: ConversationListParams)   // chave ['chat','conversations',{ filter, search, status, ...opcionais }]
export function useConversationList(params: ConversationListParams);   // mesmas opções de useConversations (:94-107)
// useConversations(...) continua, delegando com status 'open'
export function useConversationHistory(conversationId: string, enabled: boolean); // ['chat','conversations',id,'history']
export function useChatAssignees(enabled: boolean);                              // ['chat-assignees'], staleTime 60_000
export function useResolveConversation(conversationId: string);  // input { expectedAssigneeId, expectedLastInboundAt, note? }
export function useReopenConversation(conversationId: string);   // input { note? }
export function useAssignConversation(conversationId: string);   // input { userId, expectedAssigneeId, note? } (muda)
//   sucesso → invalidateChat(qc, id); erro → await readApiErrorBody, toast DK16 e, em 403/409, invalidateChat(qc, id)
// useSendReply/useSendMedia: em 409 chat.assigned_to_other → invalidateChat(qc, id), sem toast (o compositor mostra o aviso)
```

**CK8. Front — funções puras** (T7).

```ts
// features/chat/situation.ts
export const SITUATION_LABEL: Record<'PENDING'|'IN_PROGRESS'|'RESOLVED', string>;   // DK16
export function situationOf(c: { status?: string | null; resolvedAt?: string | null; assignedUserId?: string | null }): 'PENDING'|'IN_PROGRESS'|'RESOLVED';
export function assigneeLabel(name: string | null | undefined, active: boolean | null | undefined): string | null; // '{nome} (inativo)'
export type Me = { id: string; role: string };
export function conversationActions(c: ConversationSummary, me: Me): { resolve: boolean; reopen: boolean; assume: boolean; transfer: boolean; remove: boolean }; // DK16
export function replyLock(c: ConversationSummary, meId: string): { locked: boolean; name: string | null }; // DK17 (sem o 409 local)
// features/chat/chat-errors.ts
export const CHAT_ACTION_ERROR_TEXT: Record<string, string>;      // DK16
export function chatActionErrorText(code: string | undefined): string;
export function parseAssigneeDetail(detail: string | undefined): { id: string; name: string; active: boolean } | null; // DK14, tolerante
// features/chat/history-text.ts (T11)
export const HISTORY_TRUNCATED_TEXT = 'Mostrando as 200 mudanças mais recentes.';   // rodapé quando hasMore (DK19, M8)
export function historyLine(item: ConversationHistoryItem): string;   // DK19
export function historyTime(iso: string): string;                    // 'dd/MM HH:mm' Manaus
```

**CK9. Novidades** (T12): `{ version: '<YYYY.MM.DD.n>', date: '<YYYY-MM-DD>', title: 'Caixa: situação da conversa e um atendente por vez', items: [...] }` no topo, itens com `where: '/inbox'`, sem nome ou telefone de exemplo.

## Review Focus

1. **Autorização na linha travada (T4a, T4b, T5):** `OPERATOR que não é o atendente — resolver 403 chat.not_assignee`; `OPERATOR com expectedAssigneeId = ele mas a conversa com outro — 409 e nada gravado`; `ADMIN responde conversa de outro — 409 chat.assigned_to_other`; `assumir não exige ser o atendente; transferir e remover exigem`.
2. **Nada gravado na recusa (T4a, T4b, T5):** `409/403 — nenhuma linha de histórico, nenhum AuditEvent, conversa igual`; `resposta recusada — nenhuma Message, provedor não chamado, store.put não chamado`.
3. **Corridas (GK11):** T5 `duas respostas numa conversa sem atendente — uma 200, outra 409, uma Message` (Molde B); `transferência na fila antes da resposta — 409 sem Message`; T6 `Resolver × mensagem recebida nas duas ordens — a mensagem nunca fica numa conversa resolvida`; T4b `dois Assumir — um grava, o outro 409 conversation_changed` e T4a `dois Resolver — um grava, o outro 409` (Molde B).
4. **Robô (K1-7, aceite 9):** `assumir e transferir pausam`; `resolver, reabrir e remover não mudam botPausedAt`; nenhum caminho põe `botPausedAt` em null.
5. **Sem texto na trilha nem no log (GK2):** `AuditEvent de conversation.assign sem note nem nome`; `detail só com id, nome e active`.
6. **Rota de atribuição sem caminho cego (aceite 8):** `sem expectedAssigneeId — 400` (T4b); `rota assign fora de ChatController` (T4b); `ChatRepository.assignConversation e ChatService.assignConversation removidos` (T5); grep sem `assignedUserId:` gravado fora do núcleo.
7. **Destino filtrado (aceite 8):** `destino inativo, sem acesso, SUPERVISOR, VIEWER — 404 user.not_found`; `GET assignees só ADMIN e OPERATOR ativos com acesso`.
8. **Migração (GK12):** `migration.sql só com CREATE/ALTER ADD/INDEX/CONSTRAINT e SET LOCAL lock_timeout`; `conversas existentes sem mudança`.
9. **Reabertura só ao vivo (aceite 4):** `backfill e eco não reabrem`.
10. **Front:** `compositor mantém o texto e desliga Enviar e o clipe`; `Resolver invisível para OPERATOR que não é o atendente`; `409 conversation_changed recarrega conversa, lista e histórico`.

## Rastreio (aceite → task → teste)

| Aceite | Task | Teste |
|---|---|---|
| 1 | T1, T2, T8 | T1 `aceite 1: conversa existente com e sem atendente — resolvedAt nulo depois da migração`; T2 `aceite 1: status PENDING/IN_PROGRESS/RESOLVED pelo mapper`; `aceite 1: lista padrão só abertas; status=resolved só resolvidas; archivedAt continua fora`; T8 `aceite 1: Abertas por padrão; Resolvidas troca a consulta; linha mostra a situação` |
| 2 | T4a, T8, T9 | T4a `aceite 2: atendente resolve com observação — RESOLVED, sem atendente, AuditEvent conversation.assign com after null`; `aceite 2: ADMIN resolve conversa de outro`; `aceite 2: OPERATOR que não é o atendente — 403 chat.not_assignee`; T8 `aceite 2: resolvida sai da lista Abertas`; T9 `aceite 2: OPERATOR que não é o atendente não vê Resolver` |
| 3 | T4a, T6, T9 | T4a `aceite 3: lastInboundAt diferente — 409 chat.conversation_changed`; `aceite 3: atendente trocado — 409`; T6 `aceite 3: Resolver bloqueado antes da mensagem — resolvida e reaberta pelo Sistema` e `aceite 3: mensagem bloqueada antes do Resolver — 409 e conversa aberta` (GK11); T9 `aceite 3: 409 conversation_changed — toast e recarga` |
| 4 | T6, T4a, T11 | T6 `aceite 4: mensagem ao vivo numa resolvida — Pendente, sem atendente, linha REOPENED sem autor`; `aceite 4: backfill não reabre`; `aceite 4: eco não reabre`; T4a `aceite 4: reabrir manual por OPERATOR`; T11 `aceite 4: Sistema reabriu a conversa (nova mensagem recebida)` |
| 5 | T5 | `aceite 5: resposta em conversa sem atendente — ASSUMED_ON_REPLY, atendente e conversation.updated publicado`; `aceite 5: resposta numa resolvida — REOPENED + ASSUMED_ON_REPLY, aberta, conversation.updated publicado` |
| 6 | T5, T10 | T5 `aceite 6: texto em conversa de outro (inclusive ADMIN) — 409 assigned_to_other com o nome, sem Message e sem provedor`; `aceite 6: mídia em conversa de outro — 409, store.put não chamado`; T10 `aceite 6: aviso com o nome, texto mantido, Enviar desligado até Assumir conversa` |
| 7 | T5 | `aceite 7: duas respostas simultâneas sem atendente — uma 200 e uma 409, uma Message` (Molde B); `aceite 7: transferência registrada no meio — 409 assigned_to_other, sem Message` |
| 8 | T3, T4a, T4b, T9 | T3 `aceite 8: GET assignees só ADMIN e OPERATOR ativos com acesso, id e nome`; T4b `aceite 8: assumir, transferir, remover com histórico e conversation.assign`; `aceite 8: expectedAssigneeId diferente — 409`; `aceite 8: destino inativo, sem acesso, SUPERVISOR, VIEWER — 404`; `aceite 8: sem expectedAssigneeId — 400`; `aceite 8: SUPERVISOR e VIEWER — 403 auth.insufficient_role nas rotas novas` (T3 nas leituras, T4a em resolve e reopen, T4b em assign; `resolve` sem `expected…` — 400 na T4a); T9 `aceite 8: Transferir lista os destinos da rota nova` |
| 9 | T4a, T4b, T5, T6 | T4a `aceite 9: resolver e reabrir não mudam botPausedAt`; T4b `aceite 9: assumir e transferir pausam; remover não muda botPausedAt; nada zera`; T5 `aceite 9: envio da equipe e resposta do robô não mudam situação nem atendente`; T6 `aceite 9: reabertura automática não muda botPausedAt` |
| 10 | T2, T4b, T9 | T2 `aceite 10: assignedUserActive false para inativo ou sem acesso`; T4b `aceite 10: OPERATOR assume conversa de atendente inativo`; T9 `aceite 10: nome com (inativo) e Assumir conversa` |
| 11 | T12 | `aceite 11: entrada K1 no topo com o aviso sobre Assumir conversa` + `release-notes.spec.ts` verde |

## Mapa de arquivos

- Criar (back): `conversation-ownership.rules.ts` (T4a), `conversation-assign.rules.ts` (T4b); `backend/prisma/migrations/20261121100000_conversation_situation_history/migration.sql`, `backend/src/modules/chat/conversation-situation.migration.spec.ts`, `conversation-situation.migration.integration.spec.ts` (T1); `dto/resolve-conversation.dto.ts`, `dto/reopen-conversation.dto.ts` (T2); `conversation-ownership.errors.ts`, `conversation-ownership.repository.ts`, `conversation-ownership.service.ts`, `conversation-ownership.controller.ts` (T3); `conversation-claim.ts` (T5); `conversation-inbound.ts` (T6). Specs novos em cada task.
- Modificar (back): `schema.prisma` (T1); `chat.schema.ts`, `conversation-summary.mapper.ts`, `chat.repository.ts` (só `listConversations`), `dto/assign-conversation.dto.ts` se precisar (T2); `chat.module.ts`, `shared/audit/audit-change.ts` (T3); `conversation-ownership.service.ts` e `conversation-ownership.controller.ts` (T4a: `resolve`/`reopen`; T4b: `assign`), `chat.controller.ts` e `chat.controller.spec.ts:28-36` (só T4b); `chat.service.ts`, `chat-media.service.ts`, `chat.repository.ts` (remove `assignConversation`), `chat.repository.spec.ts:95-106` (apagar o teste), `chat.service.bot.spec.ts:66-78` (apagar o teste), specs existentes de envio (só o `vi.mock` e o argumento do construtor), `chat.assign.service.spec.ts` (apagado) (T5); `chat-ingest.service.ts` (T6).
- Criar (front): `features/chat/situation.ts`, `chat-errors.ts` (T7); `components/conversation-status-filter.tsx`, `components/situation-badge.tsx` (T8); `components/conversation-actions.tsx`, `components/transfer-menu.tsx`, `components/conversation-action-dialog.tsx` (T9); `components/assignee-lock-banner.tsx` (T10); `history-text.ts`, `components/conversation-history.tsx` (T11); `frontend/src/release-notes.caixa.spec.ts` (T12). Specs novos em cada task.
- Modificar (front): `features/chat/schemas.ts`, `api.ts`, `api.assign.spec.ts:28,35` (reescrever as asserções), `components/assign-menu.tsx` (só a chamada) (T7); `components/conversations-list.tsx`, `components/conversation-row.tsx` (T8); `components/message-thread.tsx` (T11 monta o histórico; T9 o cabeçalho), `components/assign-menu.tsx` + spec (apagados na T9); `components/message-composer.tsx` (T10); `release-notes.ts` (T12).

## Ordem e paralelismo

```
Onda 1:  T1 (migração)                      T7 (front: contrato, hooks, erros)        T12 (Novidades)
Onda 2:  T2 (contrato e lista) <- T1        T8 (front: lista) <- T7                   T11 (front: histórico) <- T7
Onda 3:  T3 (núcleo e leituras) <- T2       T9 (front: cabeçalho e ações) <- T7, T11  T10 (front: compositor) <- T7
Onda 4:  T4a (resolver, reabrir) <- T3
Onda 5:  T4b (atribuir; rota movida) <- T4a
Onda 6:  T5 (trava de resposta) <- T4b       T6 (reabertura automática) <- T4a (revisão 2, m2: a T6 importa o serviço que a T4b edita; arquivos editados por T5 e T6 não se cruzam)
```

- **Ownership disjunto por onda:** Onda 1 — T1: `schema.prisma`, migração, specs de migração; T7: `features/chat/{schemas,api,situation,chat-errors}.ts`, `api.assign.spec.ts` (dono único), chamada em `assign-menu.tsx` (e, só se preciso, a prop em `message-thread.tsx:76-80`); T12: `release-notes.ts` e spec novo. Onda 2 — T2: `chat.schema.ts`, mapper, `chat.repository.ts` (`listConversations`), DTOs; T8: `conversations-list.tsx`, `conversation-row.tsx`, componentes novos da lista; T11: `history-text.ts`, `conversation-history.tsx`, `message-thread.tsx` (só a montagem). Onda 3 — T3: arquivos novos do núcleo, `chat.module.ts`, `audit-change.ts`; T9: `message-thread.tsx` (cabeçalho), componentes de ação, apaga `assign-menu.tsx`; T10: `message-composer.tsx`, `assignee-lock-banner.tsx` (lê a conversa por `useConversation(conversationId)`, sem editar `message-thread.tsx`). Onda 4 — T4a: `conversation-ownership.service.ts` e `.controller.ts` (`resolve`/`reopen`), `conversation-ownership.rules.ts` e specs novos. Onda 5 — T4b: os mesmos service e controller (`assign`; a T4a já terminou), `conversation-assign.rules.ts`, `chat.controller.ts`, `chat.controller.spec.ts` (só o teste de `assign`) e specs novos. Onda 6 — T5: `conversation-claim.ts`, `chat.service.ts`, `chat-media.service.ts`, `chat.repository.ts`, `chat.repository.spec.ts`, `chat.service.bot.spec.ts` (só os testes de `assignConversation`), specs de envio; T6: `conversation-inbound.ts`, `chat-ingest.service.ts`, specs de ingestão. **Colisão evitada:** `chat.controller.spec.ts` é só da T4b (é a T4b que tira a rota); a T5 não o toca.
- **Por que T4b espera a T4a:** as duas editam `conversation-ownership.service.ts` e `.controller.ts` (ownership sequencial, não paralelo). **Por que T5 espera a T4b:** a T4b tira a rota de atribuição de `chat.controller.ts` (e o teste dela em `chat.controller.spec.ts`); a T5 apaga `ChatService.assignConversation` e `ChatRepository.assignConversation` (e os testes em `chat.repository.spec.ts` e `chat.service.bot.spec.ts`), e o teste de corrida da T5 usa a transferência real da T4b. Na mesma onda o `tsc` quebraria entre as duas. A T6 precisa só do "Resolver" real (T4a) para o teste de corrida.
- **Arquivos compartilhados com dono único:** `chat.schema.ts` só a T2; `chat.module.ts` só a T3 (registra serviço e controller, que a T4a e a T4b só preenchem); `chat.repository.ts` T2 (lista) e depois T5 (remoção), em ondas diferentes; `message-thread.tsx` T11 (Onda 2) e T9 (Onda 3); `features/chat/api.ts` só a T7.
- **Front sem dependência de código do back:** T7–T11 espelham o contrato com campos tolerantes (GK7).
- **Testcontainers:** T1, T2 (Onda 2), T3, T4a, T4b, T5, T6 têm integração; no máximo dois ao mesmo tempo (a Onda 6 tem dois: T5 e T6).
- **Gate conjunto:** com tasks paralelas, o `--changed` de uma mede o diff das outras; falha só de arquivo alheio vai para o report. A principal roda o `--changed` conjunto e os `tsc` depois de cada onda.
- **Revisão** (SKILL.md do sdd, §Revisão por risco): pela definição de crítico da SKILL (autenticação/autorização, tenant, dinheiro, segredo, rota pública, dado pessoal em log, migração destrutiva ou dado de produção por script): `revisor` `opus` só em T4a, T4b e T5 (`Risco: crítico (autorização)`, cada uma com a linha `Crítico:`). Todas as outras: `revisor` `sonnet`, sem linha `Crítico:` e sem marca `fronteira`; migração não destrutiva (T1), contrato público (T2, T7) e transação/concorrência (T3, T6) e tela travada (T10) viram "Foco da revisão" no texto da task. Implementador sempre `sonnet` (opus só pela escalada de §Correções). Total **13 tasks** em 6 ondas: 3 `Risco: crítico` (T4a, T4b, T5), 5 altas (T1, T2, T3, T6, T10), 5 médias ou baixas.

---

## Task 1 — Migração: marca de resolução e histórico da conversa (back)

**Arquivos:** criar `backend/prisma/migrations/20261121100000_conversation_situation_history/migration.sql`, `backend/src/modules/chat/conversation-situation.migration.spec.ts` (estático), `backend/src/modules/chat/conversation-situation.migration.integration.spec.ts`; modificar `backend/prisma/schema.prisma` (só CK1: `Conversation` ~L920-966 ganha `resolvedAt` e `history`, **sem índice novo** (M3); enum e modelo novos perto de `Conversation`). Rodar `npx prisma generate`.

**Interfaces:** consome o modelo `Conversation` (`schema.prisma:920-966`). Produz CK1.

**Contexto vinculado:**
- Restrições: "Migrações aditivas, com `lock_timeout`, sem mudar linha existente: K1 (situação e histórico da conversa) e K2 (…). K3 não tem migração."
- K1-1: "Calculada, nunca gravada como texto: 'Resolvida': tem a marca de resolução (coluna nova; `archivedAt` não é reutilizado) (…). Conversas existentes ficam 'Em atendimento' se têm atendente e 'Pendente' se não, sem migrar dados."
- K1-2: "Tabela nova, só de inclusão. Cada linha guarda quem (ou 'Sistema'), quando, ação, de e para (usuários) e observação opcional (até 200). Ações: assumiu, assumiu ao responder, transferiu, removeu atendente, resolveu, reabriu e passagem de turno (K3)."
- DK1 inteiro (enum com `SHIFT_HANDOVER` já agora; FK só para a conversa, Cascade; sem FK nos usuários, como `AuditEvent.subjectUserId`; índice só na tabela nova, **nenhum índice novo em `Conversation`**: `lock_timeout` limita a espera, não a construção, e `CONCURRENTLY` não roda no `SET LOCAL`). GK12 (padrão de `20261119110000_user_assignment_history/migration.sql:7-12`: comentário + `SET LOCAL lock_timeout = '15s';`).
- GK9: `schema.prisma` é legado — só os campos de CK1, sem reformatar o resto.

**Passos:**
1. [ ] RED estático (`conversation-situation.migration.spec.ts`, lê o arquivo SQL pelo caminho): `it('GK12: começa por SET LOCAL lock_timeout')`; `it('GK12: sem comando UPDATE, DELETE FROM, DROP nem INSERT')`; `it('GK12: toda linha ALTER TABLE adiciona (ADD), nunca DROP/ALTER COLUMN')` (revisão 2, m1: pega `ALTER TABLE "X" DROP …` de deriva do `migrate diff`) (lê o SQL, tira os comentários `--` e testa **comandos** linha a linha com `/^\s*(UPDATE|DELETE\s+FROM|DROP|INSERT)\b/im`; o comentário copiado do precedente tem a palavra "DROP", e a FK gera `ON DELETE CASCADE ON UPDATE CASCADE`, que não pode reprovar o teste: inclua um caso que prova que a regex aceita essas duas linhas); `it('GK12: sem CREATE INDEX em "Conversation"')`; `it('cria o enum com as sete ações, inclusive SHIFT_HANDOVER')`; `it('ADD COLUMN resolvedAt nulo, sem DEFAULT')`; `it('FK do histórico só para Conversation, ON DELETE CASCADE')`. (Antes, `grep -rn "migration.sql" backend/src` para seguir precedente de leitura de migração, se houver.)
2. [ ] RED integração (`conversation-situation.migration.integration.spec.ts`, `describe.skipIf(!TESTCONTAINERS_ENABLED)`, setup de `chat-ingest.integration.spec.ts`): `it('aceite 1: conversas existentes com e sem atendente ficam iguais depois da migração, com resolvedAt nulo')` (**padrão de `backend/src/shared/audit/audit-category-migration.integration.spec.ts`**, conferido por Glob: aplicar as migrações **até a imediatamente anterior** à nova, inserir uma conversa com atendente e outra sem, aplicar a nova, ler as linhas e conferir que todas as colunas antigas são iguais e `resolvedAt` é nulo; copiar do spec o helper de aplicar até uma migração; os demais `it` abaixo rodam com todas as migrações aplicadas); `it('linha de histórico com actorId de usuário inexistente é aceita (sem FK)')`; `it('apagar a conversa apaga o histórico (Cascade)')`; `it('note com 201 caracteres é recusada pelo banco')`.
3. [ ] GREEN: DDL conferido com `npx prisma migrate diff` (do esquema anterior ao novo) e alinhado ao padrão; **remover à mão** qualquer `DROP` de quarentena/deriva que o diff gere e não seja desta migração (M1), e conferir que não há índice em `Conversation`; `npx prisma validate`; `npx prisma generate`; typecheck; eslint (GK9); validação (`TESTCONTAINERS_ENABLED=1`); `--changed`.

**Aceite:** base de 1. **Risco: alto** (migração não destrutiva em tabela de produção; não é categoria crítica da SKILL). Revisão `sonnet`; a principal confere o SQL no fechamento da onda.
**Foco da revisão:** só CREATE/ALTER ADD/FK/índice da tabela nova; `lock_timeout` no topo; nenhuma linha existente muda; nenhum índice novo em `Conversation`; nenhum `DROP` herdado do `migrate diff`; teste de "conversas existentes" aplica até a migração anterior.

## Task 2 — Contrato, situação no resumo e filtro Abertas/Resolvidas (back)

**Arquivos:** modificar `backend/src/schemas/contracts/chat.schema.ts` (CK2 inteiro: tipos, `status` da lista, schemas de corpo novos e o `assignConversationSchema` novo), `backend/src/modules/chat/conversation-summary.mapper.ts` (include `assignedUser` ~L16; quatro campos no retorno ~L47-52), `chat.repository.ts` (**só** `listConversations` ~L12: `resolvedAt` conforme `q.status`), `dto/assign-conversation.dto.ts` (se o DTO não herdar o schema sozinho); criar `dto/resolve-conversation.dto.ts`, `dto/reopen-conversation.dto.ts`, specs `chat.schema.k1.spec.ts`, `conversation-summary.situation.spec.ts`, `chat.repository.situation.integration.spec.ts`; ajustar **só** as asserções de forma do resumo que quebrarem em `conversation-summary.mapper.spec.ts`, `chat.conversation-summary.spec.ts`, `chat.repository.list.spec.ts` (listar no report).

**Interfaces:** consome CK1. Produz CK2. Revisão 2 (m3): depois da mudança, rode também `cd backend && npx tsc --noEmit -p tsconfig.json`; se `chat.controller.spec.ts:29,35` quebrar por `expectedAssigneeId` obrigatório, a T2 pode fazer o ajuste mínimo de tipo nesses dois testes (só o objeto passado), registrando no report — a T4b continua dona do arquivo e o reescreve depois. Atenção: `assignConversationSchema` muda e `ChatService.assignConversation` (`chat.service.ts:157`) lê `body.userId` pelo controller (`chat.controller.ts:65-66`): o campo `userId` continua, então compila; o caminho antigo é removido nas T4b (rota) e T5 (métodos).

**Contexto vinculado:**
- K1-1 (texto na T1) e DK2: `status = resolvedAt ? 'RESOLVED' : assignedUserId ? 'IN_PROGRESS' : 'PENDING'`; resumo ganha `status`, `resolvedAt`, `lastInboundAt`, `assignedUserActive` (`isActive && hasAccess`; null sem atendente).
- K1-8: "O nome aparece com '(inativo)'. A trava continua, e qualquer um com acesso à caixa pode assumir."
- K1-10: "Seletor novo de situação, 'Abertas' (padrão: 'Pendente' e 'Em atendimento') ou 'Resolvidas'. 'Todas / Não lidas / Aguardando' e a busca combinam com os dois." DK3: `archivedAt: null` continua sempre (`chat.repository.ts:12`).
- K1-3/K1-7: o corpo do resolver leva o atendente que a tela mostrava e o `lastInboundAt`; "`POST conversations/:id/assign` passa a exigir o atendente que a tela mostrava, como campo obrigatório: `null` explícito quando a tela mostrava a conversa sem atendente. Sem o campo, 400." DK15 (observação até 200, `trim`, vazia → null).
- "Fica com o construtor": "Se a situação da conversa vai como campo calculado na resposta da lista ou é calculada no front": decidido campo calculado (DK2).
- GK7 (campos obrigatórios no back), GK9 (legados: só as trocas ditas).

**Passos:**
1. [ ] RED unidade (`chat.schema.k1.spec.ts`): `it('aceite 8: assign sem expectedAssigneeId falha; com null passa')`; `it('resolve sem expectedLastInboundAt falha; com null passa; data inválida falha')`; `it('note com 201 caracteres falha; só espaços vira vazia')`; `it('lista: status padrão open; aceita resolved; recusa outro valor')`.
2. [ ] RED unidade (`conversation-summary.situation.spec.ts`): `it('aceite 1: sem resolvedAt e sem atendente — PENDING')`; `it('aceite 1: com atendente — IN_PROGRESS')`; `it('aceite 1: com resolvedAt — RESOLVED')`; `it('aceite 10: atendente inativo ou sem acesso — assignedUserActive false; sem atendente — null')`; `it('lastInboundAt e resolvedAt em ISO')`.
3. [ ] RED integração (`chat.repository.situation.integration.spec.ts`, banco real): `it('aceite 1: lista padrão traz Pendente e Em atendimento e não traz Resolvida')`; `it('aceite 1: status=resolved traz só resolvidas')`; `it('archivedAt preenchido fica fora nas duas')`; `it('filter=awaiting e search combinam com resolved')`.
4. [ ] GREEN; ajustar specs de forma; typecheck; eslint (GK9); validação (`TESTCONTAINERS_ENABLED=1`); `--changed`.

**Aceite:** 1, 10 (back). **Risco: alto** (contrato consumido pelo front; não é categoria crítica da SKILL). Revisão `sonnet`.
**Foco da revisão:** contrato público — o resumo da conversa ganha quatro campos e a lista passa a esconder resolvidas por padrão; o corpo de atribuição passa a exigir `expectedAssigneeId`; campos novos obrigatórios no back.

## Task 3 — Núcleo de propriedade, histórico e destinos (back)

**Arquivos:** criar `backend/src/modules/chat/conversation-ownership.errors.ts`, `conversation-ownership.repository.ts`, `conversation-ownership.service.ts` (só `history` e `assignees`), `conversation-ownership.controller.ts` (só as duas leituras), specs `conversation-ownership.errors.spec.ts`, `conversation-ownership.repository.integration.spec.ts`, `conversation-ownership.controller.spec.ts`; modificar `chat.module.ts` (**só** `ConversationOwnershipController` em `controllers` e `ConversationOwnershipService` em `providers`), `backend/src/shared/audit/audit-change.ts` (**só** `category: AuditCategory | null`, L16).

**Interfaces:** consome CK1, CK2, `AuditService.recordChange` (`audit.service.ts:114-132`), `AuditChange` (`audit-change.ts:12-23`), `ChatEventsService.publish`, `ChatRepository.findConversation` + `toConversationSummary`, `DomainError`/`NotFoundError` (`domain.error.ts:1-34`). Produz CK3, CK4 (inclui `OWNERSHIP_TX_OPTIONS` e `ChatActor`) e a parte T3 de CK5. Confere em `jwt.strategy.ts:44-54` e `AuthedRequest` os campos `sub` e `role` de `req.user`.

**Contexto vinculado:**
- Vocabulário: "'Gravação condicional' é uma escrita que só acontece se o estado ainda for o que a tela mostrava, num único comando atômico; se não bater, nada é gravado e a resposta é 409." DK4 inteiro (trava `FOR NO KEY UPDATE` em `"Conversation"`, conferência, `applyOwnershipChange`, evento depois do commit). GK3.
- K1-2: "Visível a quem tem acesso à caixa, na própria conversa, sob 'Histórico da conversa'. A trilha `conversation.assign` continua sendo gravada nas mudanças de atendente." K1-7 "Trilha": "toda troca de atendente grava `conversation.assign`, com o novo atendente ou vazio". DK7 (mesma ação, `recordChange` na transação, `category: null`, `metadata { assignedUserId, assignedBy, kind }`, sem `note` nem nome; não aparece em `/trilha`, como hoje).
- K1-7 "Lista de destinos": "rota nova de leitura, para quem tem acesso à caixa, que devolve só id e nome dos ADMIN e OPERATOR ativos e com acesso." DK13 (histórico: 200 mais recentes, mais nova primeiro, nomes por consulta; usuário removido → nome null).
- C3 e DK14: `detail` = `JSON.stringify({ assignee: { id, name, active } | null })`; "nunca dado de pessoa da equipe ou contato". GK2 (nada de texto em log ou trilha). GK4/DK12 (sem `@Roles`; `route-parity.spec.ts` não muda).
- DK22 (M6): "o Prisma dá `timeout` 5 s e `maxWait` 2 s às transações interativas; o núcleo passa `OWNERSHIP_TX_OPTIONS = { timeout: 10_000, maxWait: 5_000 }` em toda `$transaction`". Testes de corrida: trava externa e poll por um segundo `PrismaClient` dedicado (`connection_limit=2`), código sob teste com `connection_limit=5`; poll de 50 ms com limite de 5 000 ms, `it` de 30 000 ms (GK11).
- DK12 (M4): o papel do ator vem de `req.user.role`; `jwt.strategy.ts:44-54` já relê papel, `isActive` e `hasAccess` do banco a cada request. `ChatActor = { id, role }` é montado no controller; não existe `isAdmin(db, actorId)`.
- DK13 (M8): histórico lê 201 linhas e devolve 200 mais `hasMore` (verdadeiro se a 201ª existe).
- Estado de hoje: `audit.log` engole erro e não é transacional (`audit.service.ts:68-105`); `recordChange` propaga erro (`:107-132`); `AuditChange.category` hoje é obrigatório e não nulo (`audit-change.ts:16`).

**Passos:**
1. [ ] RED unidade (`conversation-ownership.errors.spec.ts`): `it('notAssignee — 403 chat.not_assignee')`; `it('conversationChanged — 409, detail JSON com assignee ou null')`; `it('assignedToOther — 409 chat.assigned_to_other, detail com id, nome e active')`.
2. [ ] RED integração (`conversation-ownership.repository.integration.spec.ts`, banco real, `AuditService` real): `it('lockConversation — conversa inexistente 404')`; `it('applyOwnershipChange assumir — atendente, assignedAt, botPausedAt, linha ASSUMED com de/para, AuditEvent conversation.assign com changes e sem note')`; `it('resolver — resolvedAt, sem atendente, linha RESOLVED, AuditEvent com after null, botPausedAt igual')`; `it('sem troca de atendente — nenhum AuditEvent')`; `it('falha do recordChange desfaz conversa e histórico')` (espiar para lançar); `it('duas ações — duas linhas na ordem')`; `it('findEligibleAssignee — ADMIN e OPERATOR ativos com acesso; SUPERVISOR, VIEWER, inativo, sem acesso → null')`; `it('aceite 8: listEligibleAssignees — só id e nome, ordem por nome')`; `it('listConversationHistory — mais nova primeiro, nomes resolvidos, ator nulo e usuário removido com nome null')`; `it('listConversationHistory — 200 linhas: hasMore false; 201 linhas: 200 itens e hasMore true, sem a mais antiga')`; `it('toda $transaction do núcleo usa OWNERSHIP_TX_OPTIONS')` (espião em `$transaction`); `it('histórico só de inclusão: o repositório não exporta update nem delete da tabela')` (conferir as chaves exportadas e um `grep` de `conversationHistoryEntry.(update|delete)` em `src/` vazio).
3. [ ] RED controller (`conversation-ownership.controller.spec.ts`, `RolesGuard` real como os specs de controller do projeto): `it('aceite 8: SUPERVISOR e VIEWER — 403 auth.insufficient_role em GET history e GET assignees')`; `it('OPERATOR e ADMIN — 200')`; `it('history de conversa inexistente — 404')`.
4. [ ] GREEN; módulo; typecheck; eslint (GK9); validação (`TESTCONTAINERS_ENABLED=1`); `--changed`.

**Aceite:** 8 (destinos), base de 2–10. **Risco: alto** (transação/concorrência; não é categoria crítica da SKILL). Revisão `sonnet`.
**Foco da revisão:** transação — o núcleo trava a linha da conversa e grava atendente, situação, histórico e trilha juntos; trilha fora da transação ou evento antes do commit deixaria troca de atendente sem registro; `OWNERSHIP_TX_OPTIONS` em toda transação; o histórico não exporta `update`/`delete`.

## Task 4a — Resolver e reabrir com gravação condicional (back)

**Arquivos:** modificar `conversation-ownership.service.ts` (`resolve`, `reopen`) e `conversation-ownership.controller.ts` (dois `POST`: `resolve` e `reopen`); criar `conversation-ownership.rules.ts` (`canResolve(actor, expectedAssigneeId)`, puro), specs `conversation-ownership.rules.spec.ts`, `conversation-ownership.resolve.integration.spec.ts`, `conversation-ownership.resolve.race.integration.spec.ts`, `conversation-ownership.resolve.controller.spec.ts`. **Não toca** `chat.controller.ts`, `chat.controller.spec.ts` nem a rota `assign` (T4b).

**Interfaces:** consome CK2, CK3, CK4 (T3: `lockConversation`, `applyOwnershipChange`, `findAssigneeRef`, `OWNERSHIP_TX_OPTIONS`, `ChatActor`). Produz `resolve` e `reopen` de CK5.

**Contexto vinculado:**
- K1-3: "Quem: o atendente ou o ADMIN. Observação opcional (até 200). Quem não é o atendente atual nem ADMIN recebe 403 `chat.not_assignee`. Resolver retira o atendente. Gravação condicional: ainda aberta, ainda com o atendente que a tela mostrava (que é o ator, salvo o ADMIN), e sem mensagem recebida depois da última que a tela mostrava (`lastInboundAt`). Se não bater: 409 `chat.conversation_changed`, e a tela recarrega a conversa."
- K1-4 "Manual": "quem tem acesso à caixa, observação opcional; volta a 'Pendente'." K1-7: "Remover, resolver e reabrir não pausam nem retomam" o robô. K1-10: "Toda mudança de situação ou atendente publica `conversation.updated`."
- DK5: `POST chat/conversations/:id/resolve`, corpo `{ expectedAssigneeId: string | null, expectedLastInboundAt: string | null, note? }` (os dois "expected" obrigatórios; ausente → 400). Ordem: trava → 404 → 403 `chat.not_assignee` se `actor.role !== 'ADMIN'` e `expectedAssigneeId !== actor.id` (conversa Pendente só o ADMIN resolve) → 409 `chat.conversation_changed` se `resolvedAt !== null` ou `assignedUserId !== expectedAssigneeId` ou `lastInboundAt` (ms) `!== expectedLastInboundAt` → grava `resolvedAt = now`, `assignedUserId = null`, `assignedAt = null`, linha `RESOLVED` (de = atendente anterior), trilha `conversation.assign` com atendente vazio se havia atendente; não toca `botPausedAt`.
- DK8: `POST chat/conversations/:id/reopen`, corpo `{ note? }`: trava → 404 → 409 `chat.conversation_changed` se `resolvedAt === null` → `resolvedAt = null`, linha `REOPENED` com o ator; não toca atendente nem `botPausedAt`.
- DK12 (M4): sem `@Roles`/`@RequirePermission`; papel do ator de `req.user.role` (controller monta `ChatActor = { id: req.user.sub, role: req.user.role }`; a `jwt.strategy.ts:44-54` já relê o papel do banco a cada request). DK22 (M6): `OWNERSHIP_TX_OPTIONS = { timeout: 10_000, maxWait: 5_000 }` em toda transação; trava externa dos testes por um segundo `PrismaClient` dedicado (`connection_limit=2`; código sob teste com `connection_limit=5`), poll de 50 ms até 5 000 ms, `it` de 30 000 ms.
- GK3 (gravação condicional: trava da linha + conferência + escrita + histórico + trilha na mesma transação; evento só depois do commit), GK5 (códigos 403 `chat.not_assignee`, 409 `chat.conversation_changed`, 400 de validação), GK11 (Molde B).

**Passos:**
1. [ ] RED puro (`conversation-ownership.rules.spec.ts`): `it('resolver: não ADMIN com expected diferente do ator — 403')`; `it('Pendente (expected null): não ADMIN 403; ADMIN permitido')`; `it('ADMIN com qualquer expected — permitido')`.
2. [ ] RED integração (`conversation-ownership.resolve.integration.spec.ts`, banco real, `ChatEventsService` falso com espião): `it('aceite 2: atendente resolve com observação — RESOLVED, sem atendente, linha com a observação, AuditEvent conversation.assign after null sem note, conversation.updated')`; `it('aceite 2: ADMIN resolve conversa de outro')`; `it('aceite 2: OPERATOR não atendente — 403 chat.not_assignee, nada gravado')`; `it('aceite 3: expectedLastInboundAt diferente — 409 chat.conversation_changed, nada gravado, nenhum evento')`; `it('aceite 3: atendente trocado — 409 com detail do atual')`; `it('Pendente: OPERATOR não resolve (403); ADMIN resolve')`; `it('aceite 4: reabrir manual por OPERATOR — Pendente, REOPENED com o ator, conversation.updated; aberta — 409')`; `it('aceite 9: resolver e reabrir não mudam botPausedAt')`.
3. [ ] RED corrida (`conversation-ownership.resolve.race.integration.spec.ts`, GK11 Molde B): `it('dois Resolver simultâneos na mesma conversa — o primeiro grava, o segundo 409 conversation_changed; uma linha RESOLVED')` (comentário: falha se a conferência ler a linha sem a trava).
4. [ ] RED controller (`conversation-ownership.resolve.controller.spec.ts`, `RolesGuard` real): `it('resolve sem expectedAssigneeId ou sem expectedLastInboundAt — 400')`; `it('aceite 8: SUPERVISOR e VIEWER — 403 auth.insufficient_role em resolve e reopen')`; `it('resolve responde 200 com o resumo')`.
5. [ ] GREEN; typecheck; eslint (GK9); validação (`TESTCONTAINERS_ENABLED=1`); `--changed`.

**Aceite:** 2, 3 (sequencial), 4 (manual), 9 (resolver e reabrir). **Risco: crítico (autorização).**
**Crítico: autorização — decide quem pode resolver (o atendente ou o ADMIN) na linha travada; concorrência — dois comandos na mesma conversa se serializam pela trava e o segundo recebe 409 sem gravar.** Revisão `opus`.

## Task 4b — Atribuir (assumir, transferir, remover) e mover a rota (back)

**Arquivos:** modificar `conversation-ownership.service.ts` (`assign`; a T4a já terminou) e `conversation-ownership.controller.ts` (`POST assign`), `chat.controller.ts` (**só** remover o handler `assign` ~L63-67 e o import do DTO se ficar sem uso), `chat.controller.spec.ts` (**só** apagar o teste da rota `assign`, `:28-36`, que passa a ser coberto pelo `conversation-assign.controller.spec.ts`; **dono único desse arquivo é a T4b**, a T5 não o toca; listar no report); criar `conversation-assign.rules.ts` (`assignKind`, regras de 403 e de "sem efeito", puras), specs `conversation-assign.rules.spec.ts`, `conversation-assign.integration.spec.ts`, `conversation-assign.race.integration.spec.ts`, `conversation-assign.controller.spec.ts`. `ChatService.assignConversation` e `ChatRepository.assignConversation` ficam órfãos mas compilam; a T5 os remove (e os testes deles).

**Interfaces:** consome CK2, CK3, CK4 (T3) e o serviço e o controller da T4a. Produz `assign` de CK5.

**Contexto vinculado:**
- K1-3 (parte que vale aqui): "Observação opcional (até 200). Quem não é o atendente atual nem ADMIN recebe 403 `chat.not_assignee`. A mesma regra vale para 'Remover atendente' e para transferir uma conversa que tem atendente (K1-7). Se a gravação condicional não bater: 409 `chat.conversation_changed`, e a tela recarrega a conversa."
- DK12 (M4): sem `@Roles`/`@RequirePermission`; papel do ator de `req.user.role` (controller monta `ChatActor = { id: req.user.sub, role: req.user.role }`; a `jwt.strategy.ts:44-54` já relê papel, `isActive` e `hasAccess` do banco a cada request). DK22 (M6): `OWNERSHIP_TX_OPTIONS = { timeout: 10_000, maxWait: 5_000 }` em toda transação; trava externa dos testes por um segundo `PrismaClient` dedicado (`connection_limit=2`; código sob teste com `connection_limit=5`), poll de 50 ms até 5 000 ms, `it` de 30 000 ms.
- K1-7: "Assumir (para si): qualquer um com acesso à caixa, observação opcional. Gravação condicional ao atendente que a tela mostrava; se mudou, 409 `chat.conversation_changed` com o atendente atual." "Transferir a outra pessoa: o atendente atual, o ADMIN, ou qualquer um quando a conversa está sem atendente. Mesma gravação condicional." "Destino: ativo, com acesso e ADMIN ou OPERATOR. Senão, o mesmo 404 de usuário inexistente da atribuição atual." "Remover atendente: o atendente ou o ADMIN, com a mesma gravação condicional; volta a 'Pendente'." "Robô: assumir, transferir e passar turno pausam o robô, como a atribuição já faz. Remover, resolver e reabrir não pausam nem retomam." "Trilha: toda troca de atendente grava `conversation.assign` (…)." "Assumir e transferir numa conversa resolvida a reabrem."
- K1-8: "A trava continua, e qualquer um com acesso à caixa pode assumir. Nada é desfeito sozinho ao inativar o usuário." K1-10: "Toda mudança de situação ou atendente publica `conversation.updated`."
- DK6 inteiro (ordem 404 destino → trava/404 conversa → 403 → 409 → sem efeito → grava; 403 pelo `expectedAssigneeId` do pedido: o OPERATOR só grava se a linha travada ainda está com ele; `expectedAssigneeId` obrigatório, ausente → 400; resposta 200 com o resumo). GK3 (gravação condicional: trava + conferência + escrita + histórico + trilha numa transação, evento depois do commit), GK5 (403 `chat.not_assignee`, 409 `chat.conversation_changed`, 404 `user.not_found`, 400), GK11 (Molde B).
- Estado de hoje: atribuição cega `chat.service.ts:157-173` (pausa só ao atribuir, `:170`; `audit.log` em `:171`; evento em `:172`); rota em `chat.controller.ts:63-67` com `req.user.sub`.

**Passos:**
1. [ ] RED puro (`conversation-assign.rules.spec.ts`): `it('assignKind: null remove, eu assumo, outro transfere')`; `it('remover: não ADMIN com expected diferente do ator — 403')`; `it('transferir: não ADMIN, expected de outro — 403; expected null — permitido')`; `it('assumir: nunca 403')`; `it('sem efeito: assumir o que já é meu e aberto; remover sem atendente')`.
2. [ ] RED integração (`conversation-assign.integration.spec.ts`, banco real, `ChatEventsService` falso com espião): `it('aceite 8: assumir, transferir e remover gravam histórico, conversation.assign e conversation.updated')`; `it('OPERATOR não atendente remove ou transfere conversa de outro — 403 chat.not_assignee, nada gravado')`; `it('aceite 8: expectedAssigneeId diferente — 409 com o atendente atual')`; `it('aceite 8: destino inativo, sem acesso, SUPERVISOR e VIEWER — 404 user.not_found')`; `it('aceite 8: transferir numa resolvida — REOPENED e TRANSFERRED, aberta')`; `it('assumir numa resolvida — REOPENED e ASSUMED, aberta')` (revisão 2, m4; K1-7/DK6); `it('aceite 9: assumir e transferir pausam; remover não muda botPausedAt; nada zera botPausedAt')`; `it('aceite 10: OPERATOR assume conversa de atendente inativo')`; `it('sem efeito — 200, nenhuma linha, nenhum evento')`.
3. [ ] RED corrida (`conversation-assign.race.integration.spec.ts`, GK11 Molde B): `it('dois Assumir na mesma conversa Pendente — o primeiro grava, o segundo 409 conversation_changed com o primeiro como atendente; uma linha ASSUMED')` (comentário: falha se a conferência ler a linha sem a trava); `it('Resolver (T4a) bloqueado × transferência na fila — a transferência vê resolvida e expected diferente: 409')`.
4. [ ] RED controller (`conversation-assign.controller.spec.ts`, `RolesGuard` real): `it('aceite 8: assign sem expectedAssigneeId — 400')`; `it('aceite 8: SUPERVISOR e VIEWER — 403 auth.insufficient_role em assign')`; `it('assign responde 200 com o resumo')`; `it('a rota assign não está mais em ChatController')`. Em `chat.controller.spec.ts:28-36`, apagar o teste da rota `assign` (substituído por estes).
5. [ ] GREEN; remover o handler antigo de `chat.controller.ts`; typecheck; eslint (GK9); validação (`TESTCONTAINERS_ENABLED=1`); `--changed`.

**Aceite:** 8, 9 (assumir, transferir, remover), 10 (back). **Risco: crítico (autorização).**
**Crítico: autorização — decide quem pode remover e transferir (atendente ou ADMIN) e quem pode assumir, na linha travada; concorrência — dois comandos na mesma conversa se serializam pela trava e o segundo recebe 409 sem gravar.** Revisão `opus`.

## Task 5 — Trava de resposta no texto e na mídia (back)

**Arquivos:** criar `backend/src/modules/chat/conversation-claim.ts`, specs `conversation-claim.integration.spec.ts`, `conversation-claim.race.integration.spec.ts`, `chat-media.claim.spec.ts`, `chat.k1-9.integration.spec.ts`; modificar `chat.service.ts` (`sendReply`: **uma** chamada `await claimForReply({ prisma: this.prisma, audit: this.audit, events: this.events }, conversationId, userId)` entre `:184` e `:191`; remover `assignConversation` `:157-173`), `chat-media.service.ts` (`AuditService` como último parâmetro do construtor; **uma** chamada depois de `assertProviderEnabled`, `:53`, antes de `:54-61`), `chat.repository.ts` (remover `assignConversation` `:82-87`); apagar `chat.assign.service.spec.ts` (coberto pela T4b). **Specs existentes que quebram com a remoção de `assignConversation` (nomeados; a T5 é a dona, I1):** `chat.repository.spec.ts:95-106` (**apagar** o teste de `repo.assignConversation`; a gravação de atribuição é coberta por `conversation-assign.integration.spec.ts`, T4b) e `chat.service.bot.spec.ts:66-78` (**apagar** o teste de `svc.assignConversation` pausando o robô; coberto por `aceite 9` da T4b). `chat.controller.spec.ts:28-36` **não é da T5**: o teste da rota `assign` sai na T4b, que remove a rota (um dono só, sem colisão). Nos demais specs existentes que exercitam `sendReply`/`sendMediaReply` com Prisma falso, **só** `vi.mock('./conversation-claim', () => ({ claimForReply: vi.fn().mockResolvedValue({ changed: false }) }))` e o argumento novo do construtor da mídia. Listar no report todo spec tocado, com a ação (apagar teste ou ajuste mínimo). O "só" vale para os specs de envio; nos dois arquivos nomeados acima a ação é apagar o teste do método removido.

**Interfaces:** consome CK3, CK4, `ChatService` (`chat.service.ts:127-208`), `ChatMediaService` (`chat-media.service.ts:14-92`). Produz `claimForReply` (CK5).

**Contexto vinculado:**
- K1-5: "Vale para todos, inclusive o ADMIN, e para as duas rotas de resposta, texto e mídia. O servidor faz a reivindicação depois das conferências de canal e de janela e antes de gravar a mensagem. Na mídia, antes de gravar o arquivo no armazenamento, junto da conferência do provedor." "Conversa sem atendente ou resolvida: gravação condicional 'ainda sem atendente' que põe quem responde como atendente, reabre se preciso e grava 'assumiu ao responder'." "Conversa dele: gravação condicional 'ainda com ele e aberta'. Se falhar porque a conversa ficou sem atendente ou foi resolvida, vale o ramo anterior; se está com outro, o ramo abaixo." "Conversa de outro, ou corrida perdida: nada é gravado nem enviado. A resposta é 409 `chat.assigned_to_other`, com `detail` de id e nome do atendente." "A atribuição feita na reivindicação permanece mesmo se o envio ao WhatsApp falhar."
- K1-9: "Envios da equipe (recado, alerta, lembrete) e respostas do robô. Eles não mudam situação nem atendente. Marcar como lida não muda." DK11 (lista dos caminhos que não chamam a trava).
- Anti-objetivos: "Duas pessoas responderem a mesma conversa sem que uma tenha assumido de forma registrada." "Uma resposta ser gravada ou enviada quando o servidor recusou a reivindicação."
- DK10, janela residual aceita (M5): "a trava é solta no commit do `claimForReply`, antes do `INSERT` da `Message`; uma transferência commitada entre os dois deixa a resposta do antigo atendente gravada depois da troca. A spec aceita (cada um assumiu de forma registrada); não há teste nem correção para isso." DK22: `claimForReply` usa `OWNERSHIP_TX_OPTIONS`; trava externa dos testes de corrida por um segundo `PrismaClient` dedicado (DK22).
- DK10 inteiro (decisão na linha travada; `REOPENED` + `ASSUMED_ON_REPLY` numa resolvida; pausa o robô ao assumir; `conversation.updated` depois do commit). K1-7: assumir pausa o robô. GK11, GK8 (provedor e `MediaStore` falsos).
- Estado de hoje: texto `getConversationForSend` → `assertChatSendSupported` (`:179`) → `assertSessionWindowOpen` (`:184`) → `createOutboundMessage` (`:191`) → `setBotPaused` (`:196`) → envio; mídia `getConversationForSend` (`:51`) → `assertProviderEnabled` (`:53`) → chave e `store.put` (`:60-61`) → `createOutboundMediaMessage` (`:66`) → envio. Nenhum confere atendente. Só a ingestão escreve `lastInboundAt` (grep no fechamento do plano).

**Passos:**
1. [ ] RED integração (`conversation-claim.integration.spec.ts`, banco real, `ChatService` real com `WhatsappProvidersService` falso): `it('aceite 5: resposta numa conversa sem atendente — 200, atendente = quem respondeu, linha ASSUMED_ON_REPLY, conversation.assign, botPausedAt, e conversation.updated publicado uma vez (espião de ChatEventsService, depois do commit)')`; `it('aceite 5: resposta numa resolvida — REOPENED e ASSUMED_ON_REPLY, aberta e com atendente, conversation.updated publicado')`; `it('resposta do atendente — nenhuma linha nova, nenhum AuditEvent, nenhum conversation.updated')`; `it('aceite 6: texto em conversa de outro — 409 chat.assigned_to_other com o nome no detail, nenhuma Message, provedor não chamado')`; `it('aceite 6: ADMIN em conversa de outro — 409 igual')`; `it('aceite 6: mídia em conversa de outro — 409, nenhuma Message, store.put não chamado')`; `it('envio falha no provedor — a atribuição permanece e a Message fica FAILED')`; `it('canal desligado ou janela fechada recusam antes da trava — nenhuma linha de histórico')`.
2. [ ] RED corrida (`conversation-claim.race.integration.spec.ts`, GK11): `it('aceite 7: duas respostas simultâneas numa conversa sem atendente — a primeira 200 e envia, a segunda 409 assigned_to_other com a primeira no detail; uma Message, provedor uma vez')` (Molde B; comentário: falha se a reivindicação não for gravação condicional na linha travada ou vier depois de gravar a Message); `it('aceite 7: transferência registrada no meio — resposta do antigo atendente 409, nenhuma Message')` (Molde B: transferência pela T4b primeiro na fila, resposta depois).
3. [ ] RED unidade (`chat-media.claim.spec.ts`): `it('ordem: assertProviderEnabled, claimForReply, depois store.put')`; `it('claim recusa — store.put, createOutboundMediaMessage e o provedor não são chamados')`.
4. [ ] RED integração (`chat.k1-9.integration.spec.ts`): `it('aceite 9: prepareTeamMessage numa conversa de outro — passa; atendente e resolvedAt iguais')`; `it('aceite 9: sendBotReply numa resolvida — continua resolvida e sem atendente')`; `it('markRead não muda situação nem atendente')`; `it('nenhuma escrita de assignedUserId fora do núcleo')` (`grep -rn "assignedUserId:" src/modules --include=*.ts` sem escrita fora de `conversation-ownership.repository.ts`, `conversation-summary.mapper.ts` e filtros de leitura; registrar a saída).
5. [ ] GREEN; remover o caminho antigo; ajustar specs; typecheck; eslint (GK9); validação (`TESTCONTAINERS_ENABLED=1`); `--changed`.

**Aceite:** 5, 6, 7, 9 (back). **Risco: crítico (autorização).**
**Crítico: autorização — a reivindicação decide quem pode enviar mensagem a uma pessoa (inclusive recusar o ADMIN); concorrência — duas respostas simultâneas se serializam na linha travada e só uma é gravada e enviada.** Revisão `opus`.

## Task 6 — Reabertura automática na ingestão (back)

**Arquivos:** criar `backend/src/modules/chat/conversation-inbound.ts`, specs `conversation-inbound.integration.spec.ts`, `chat-ingest.reopen.integration.spec.ts`; modificar `chat-ingest.service.ts` (**só** `:785-797` vira `const { reopened } = await applyInboundUpdate(this.prisma, { conversationId: conversation.id, data: { …o mesmo objeto de hoje… }, reopenIfResolved: isInbound && !backfill })` e, depois de `:799`, `if (reopened) await this.events.publish({ type: 'conversation.updated', conversationId: conversation.id, instanceId })`; nos specs unitários de ingestão que quebrarem por `$transaction` ausente no Prisma falso, **só** o stub mínimo ou `vi.mock('./conversation-inbound')` (listar no report).

**Interfaces:** consome CK4 (`lockConversation`), CK1, `OWNERSHIP_TX_OPTIONS` (DK22, na transação de `applyInboundUpdate`), `ConversationOwnershipService.resolve` (T4a, nos testes de corrida). Re-revisão (m6): a T6 roda junto da T5 (Onda 6) e o setup de `chat-ingest.integration.spec.ts` sobe o `AppModule`, que carrega `chat.service.ts` e `chat-media.service.ts` em edição pela T5. Falha de carga/injeção vinda desses arquivos não é da T6: registre no report, não toque neles, e rode o spec de novo quando a principal avisar que a T5 terminou. Produz CK6.

**Contexto vinculado:**
- K1-4 "Automático": "mensagem da pessoa recebida ao vivo numa conversa resolvida a devolve a 'Pendente', sem atendente, com autor 'Sistema'. É gravação condicional 'estava resolvida', e só ela grava a linha do histórico." "Ordem com o 'Resolver': a reabertura automática acontece no mesmo comando que avança `lastInboundAt`, ou depois dele. Assim, ou o 'Resolver' vê o `lastInboundAt` novo e recebe 409, ou a reabertura encontra a conversa resolvida e a reabre. A mensagem nunca fica numa conversa resolvida." "Importação de histórico e eco de mensagem enviada não reabrem."
- Aceite 3: "Teste de integração com banco real intercala 'Resolver' e uma mensagem recebida nas duas ordens: a mensagem nunca fica numa conversa resolvida."
- DK9 inteiro (transação travada; `resolvedAt: null` no mesmo `UPDATE` que avança `lastInboundAt`; linha `REOPENED` com `actorId: null`; sem trilha; sem tocar `botPausedAt`; `conversation.updated` depois). K1-7: "Remover, resolver e reabrir não pausam nem retomam." GK11.
- Estado de hoje: duas escritas separadas, sem `$transaction` no arquivo; a conversa é tocada antes (`:720-747`, `upsert`/`update` com `commonUpdate`), a `Message` é criada (`:751-764`) e a atualização final grava resumo, `lastInboundAt` (`:781-783,794`) e `unreadCount`. `backfill` em `:477`; ecos por `ingestOutboundEcho` (`:866-869`). O robô só para `isInbound && !backfill` (`:806`).
- GK9: `chat-ingest.service.ts` é legado (arquivo grande): só a troca do bloco `:785-797` e a publicação; a regra mora em `conversation-inbound.ts`.

**Passos:**
1. [ ] RED integração (`conversation-inbound.integration.spec.ts`, banco real): `it('reopenIfResolved falso — mesmo update de hoje, resolvida continua resolvida')`; `it('aceite 4: resolvida + ao vivo — resolvedAt nulo, lastInboundAt novo, linha REOPENED sem autor, reopened true')`; `it('aberta + ao vivo — nenhuma linha, reopened false')`; `it('aceite 9: botPausedAt não muda')`; `it('aceite 3: applyInboundUpdate bloqueado antes do Resolver — o Resolver com o lastInboundAt antigo recebe 409 e a conversa fica aberta')` (Molde B: `applyInboundUpdate` primeiro na fila, `ConversationOwnershipService.resolve` depois; comentário: falha se a reabertura não estiver na transação travada que avança `lastInboundAt`).
2. [ ] RED integração (`chat-ingest.reopen.integration.spec.ts`, setup de `chat-ingest.integration.spec.ts`, ingestão real pelo caminho de webhook): `it('aceite 4: mensagem ao vivo numa resolvida — Pendente, sem atendente, Sistema no histórico, conversation.updated publicado')`; `it('aceite 4: importação (backfill) numa resolvida — continua resolvida')`; `it('aceite 4: eco de mensagem enviada numa resolvida — continua resolvida')`; `it('aceite 3: Resolver bloqueado antes da mensagem — Resolver 200, depois a ingestão reabre; mensagem existe e conversa aberta')` (Molde B: `resolve` primeiro na fila, ingestão depois).
3. [ ] GREEN; ajustar specs; typecheck; eslint (GK9); validação (`TESTCONTAINERS_ENABLED=1`); `--changed`.

**Aceite:** 3 (corrida), 4 (automático), 9 (reabertura não retoma o robô). **Risco: alto** (concorrência; não é categoria crítica da SKILL). Revisão `sonnet`.
**Foco da revisão:** concorrência/transação — a reabertura e o avanço de `lastInboundAt` passam a uma transação travada na linha da conversa; fora dela, uma mensagem poderia ficar numa conversa resolvida sem ninguém ver; `OWNERSHIP_TX_OPTIONS`; backfill e eco não reabrem; `botPausedAt` intacto.

## Task 7 — Front: contrato, hooks, erros e funções de situação

**Arquivos:** modificar `frontend/src/features/chat/schemas.ts` (CK7, campos `.nullish()`), `api.ts` (CK7: `conversationList`, `useConversationList`, `useConversations` delegando, `useConversationHistory`, `useChatAssignees`, `useResolveConversation`, `useReopenConversation`, `useAssignConversation` novo, `onError` de `useSendReply`/`useSendMedia` para `chat.assigned_to_other`), `components/assign-menu.tsx` (**só** passar `expectedAssigneeId` nas chamadas `:49,:60` com o atendente que o componente já tem; se não tiver, prop opcional nova e passar em `message-thread.tsx:76-80`; se `assign-menu.spec.tsx` quebrar por isso, só o ajuste mínimo, a T9 apaga o arquivo); **`api.assign.spec.ts:28,35` (spec existente, dono único: T7)**: reescrever no lugar as duas asserções que esperam `{ json: { userId } }` para `{ json: { userId, expectedAssigneeId, note? } }` (o "só" do `api.ts` não vale para este spec; o `describe` não cresce, os casos novos ficam em `api.k1.spec.ts`; listar no report); criar `situation.ts`, `chat-errors.ts`, specs `situation.spec.ts`, `chat-errors.spec.ts`, `api.k1.spec.ts`, `schemas.k1.spec.ts`.

**Interfaces:** consome CK2 (espelho), `readApiErrorBody` (`lib/api-error.ts:44`), `invalidateChat`/`invalidateConversationThread` (`api.ts:131-176`), `toast`. Produz CK7 e CK8 (menos `history-text.ts`, da T11).

**Contexto vinculado:**
- K1-1 (situação), K1-8 ("(inativo)"), K1-10 (seletor), DK2, DK16 (rótulos, regras de botões e mensagens por `code`, textos exatos), DK17 (`replyLock`), DK20 (chaves `['chat','conversations',id,'history']` e `['chat-assignees']`; `invalidateConversationThread` já cobre o histórico).
- C3: "Os 409 levam `code` e, quando a tela precisa, `detail` com id e nome do usuário do sistema envolvido (…). O front lê pelo `readApiErrorBody`." DK14: `detail` = JSON `{ assignee: { id, name, active } | null }`; `parseAssigneeDetail` tolerante (inválido → null).
- K1-3: em 409 `chat.conversation_changed` "a tela recarrega a conversa". GK10 (ky 2: corpo só por `readApiErrorBody`, assíncrona; memória "ky 2 consome corpo do erro").
- Estado de hoje: `useAssignConversation` manda `{ userId }`, não lê corpo e mostra toast fixo (`api.ts:243-255`); `useSendReply` só trata `chat.twilio_window_closed` (`:189-195`); `useSendMedia` não tem `onError` (`:199-210`); a chave da lista é `['chat','conversations',{filter,search,…}]` (`:61-73`) e a invalidação da lista depende de `queryKey[2]` ser objeto (`:157-165`).
- GK9: `api.ts`, `schemas.ts`, `assign-menu.tsx` legados — só o dito; `useConversations` tem 5 parâmetros (legado): o novo hook recebe objeto.

**Passos:**
1. [ ] RED puro (`situation.spec.ts`): `it('situationOf: status do servidor; sem status, pelos campos')`; `it('assigneeLabel: Ana; Ana (inativo)')`; `it('conversationActions: minha aberta — Resolver, Transferir, Remover atendente; sem Assumir')`; `it('aceite 2: de outro, OPERATOR — só Assumir conversa'); it('de outro, ADMIN — Assumir, Resolver, Transferir, Remover')`; `it('Pendente — Assumir e Transferir; Resolver só ADMIN')`; `it('Resolvida — Reabrir, Assumir, Transferir')`; `it('replyLock: de outro e aberta — travado com o nome; minha, Pendente ou Resolvida — livre')`.
2. [ ] RED puro (`chat-errors.spec.ts`): `it('textos de chat.not_assignee, chat.conversation_changed, user.not_found e o genérico')`; `it('parseAssigneeDetail: JSON válido; ausente, inválido ou sem assignee — null')`.
3. [ ] RED (`schemas.k1.spec.ts`): `it('resumo antigo sem os campos novos continua válido')`; `it('histórico (com e sem hasMore) e destinos')`.
4. [ ] RED hooks (`api.k1.spec.ts`, fetch falso): `it('aceite 1: useConversationList manda status=open por padrão e status=resolved; chave com status')`; `it('useConversations continua mandando status open')`; `it('useAssignConversation manda userId, expectedAssigneeId e note')`; `it('useResolveConversation manda expectedAssigneeId e expectedLastInboundAt')`; `it('aceite 3: 409 chat.conversation_changed — toast e invalidação da conversa, da lista e do histórico')`; `it('403 chat.not_assignee — toast')`; `it('envio com 409 chat.assigned_to_other — invalida a conversa sem toast')`; `it('invalidateConversationThread invalida o histórico da conversa')`.
5. [ ] GREEN; `npx tsc -b`; eslint (GK9); validação; `--changed`.

**Aceite:** base de 1–10 (front). **Risco: médio.** Revisão `sonnet`.
**Foco da revisão:** contrato público — consome os campos e rotas novos de forma tolerante; a decisão de autorização é do servidor (T4a, T4b, T5); `api.assign.spec.ts` reescrito sem perder cobertura.

## Task 8 — Front: lista com Abertas/Resolvidas e situação na linha

**Arquivos:** criar `frontend/src/features/chat/components/conversation-status-filter.tsx`, `situation-badge.tsx`, specs `conversation-status-filter.spec.tsx`, `situation-badge.spec.tsx`, `conversations-list.k1.spec.tsx`; modificar `components/conversations-list.tsx` (estado `status`, `useConversationList`, `AssigneeTabs` só em "Abertas", sem `assignee` em "Resolvidas"), `components/conversation-row.tsx` (badge).

**Interfaces:** consome CK7 e CK8 (T7). Produz os dois componentes.

**Contexto vinculado:**
- K1-10: "Seletor novo de situação, 'Abertas' (padrão: 'Pendente' e 'Em atendimento') ou 'Resolvidas'." "'Todas / Não lidas / Aguardando' e a busca combinam com os dois. As abas de atendente (Todas, Minhas, Não atribuídas) valem só em 'Abertas' e somem em 'Resolvidas', que não têm atendente." "Cada linha mostra a situação."
- Aceite 1: "A lista mostra a situação de cada conversa e, por padrão, só 'Pendente' e 'Em atendimento'. O filtro 'Resolvidas' mostra as resolvidas." Aceite 2: resolvida "sai da lista padrão".
- DK16 (rótulos), DK18 (botões com `aria-pressed`; estado local, sem URL). GK10.
- Estado de hoje: `filter` (`conversations-list.tsx:43`, botões `:129-154`), busca com debounce (`:44,:18-25`), `assignee` com `AssigneeTabs` (`:48,:156`) persistido em localStorage (`:27-54`; a persistência continua, só não é enviada em "Resolvidas"); linha em `conversation-row.tsx` (avatar do atendente `:65-72`).
- GK9: os dois arquivos são legados — só as inserções.

**Passos:**
1. [ ] RED (`conversation-status-filter.spec.tsx`, `situation-badge.spec.tsx`): `it('Abertas marcada por padrão; clicar Resolvidas chama onChange')`; `it('badge Pendente, Em atendimento, Resolvida')`.
2. [ ] RED (`conversations-list.k1.spec.tsx`, `vi.mock('../api')` como os specs vizinhos): `it('aceite 1: consulta com status open por padrão')`; `it('aceite 1: Resolvidas — consulta com status resolved, sem assignee, abas de atendente somem')`; `it('Não lidas e busca combinam com Resolvidas')`; `it('voltar a Abertas — abas voltam com a escolha salva')`; `it('aceite 1: cada linha mostra a situação')`.
3. [ ] GREEN; `npx tsc -b`; eslint (GK9); validação; `--changed`.

**Aceite:** 1, 2 (lista). **Risco: médio.** Revisão `sonnet`.

## Task 9 — Front: cabeçalho da conversa com situação e ações

**Arquivos:** criar `frontend/src/features/chat/components/conversation-actions.tsx`, `transfer-menu.tsx`, `conversation-action-dialog.tsx`, specs `conversation-actions.spec.tsx`, `transfer-menu.spec.tsx`, `conversation-action-dialog.spec.tsx`; modificar `components/message-thread.tsx` (cabeçalho ~L50-80: situação, atendente com "(inativo)", `ConversationActions` no lugar de `AssignMenu`); apagar `components/assign-menu.tsx` e `assign-menu.spec.tsx`.

**Interfaces:** consome CK7, CK8, `useAuthStore` (id e papel de quem olha; mesmo uso de `features/team-panorama/components/factory-panorama.tsx`), `@/components/ui/alert-dialog` (ou o diálogo do padrão da caixa). Produz os três componentes.

**Contexto vinculado:**
- K1-3: quem resolve é "o atendente ou o ADMIN"; aceite 2: "Um OPERATOR que não é o atendente não vê 'Resolver'". K1-4 "Manual": "quem tem acesso à caixa (…); volta a 'Pendente'."
- K1-7: "Assumir (para si): qualquer um com acesso à caixa". "Transferir a outra pessoa: o atendente atual, o ADMIN, ou qualquer um quando a conversa está sem atendente." "Lista de destinos: (…) O menu de atribuição e a passagem de turno (K3) usam essa rota, e não mais `GET /users`." "Remover atendente: o atendente ou o ADMIN". K1-8: "O nome aparece com '(inativo)'."
- K1-3: em 409 `chat.conversation_changed` "a tela recarrega a conversa". DK16 inteiro (botões por situação e papel, diálogo com "Observação (opcional)" até 200, "Cancelar"/"Confirmar", títulos, mensagens por `code`); DK15 ("Assumir conversa" é um clique). Os `expected…` enviados são os da conversa mostrada: `expectedAssigneeId = conversation.assignedUserId ?? null`, `expectedLastInboundAt = conversation.lastInboundAt ?? null`.
- Estado de hoje: `AssignMenu` usa `useUsers(1, 100, { hasAccess: true })` (`assign-menu.tsx:27`, `GET /users`, só ADMIN) e é montado em `message-thread.tsx:76-80`; nome do atendente em `:50`.
- GK9: `message-thread.tsx` é legado — só a troca do cabeçalho.

**Passos:**
1. [ ] RED (`conversation-actions.spec.tsx`, hooks mockados): `it('aceite 2: OPERATOR atendente vê Resolver; OPERATOR não atendente não vê')`; `it('ADMIN vê Resolver em conversa de outro')`; `it('Resolver abre o diálogo e manda expectedAssigneeId, expectedLastInboundAt e a observação')`; `it('aceite 4: Resolvida — Reabrir com observação')`; `it('Assumir conversa — um clique, userId = eu, expected = atendente mostrado')`; `it('Remover atendente — expected = atendente; Pendente sem o botão')`; `it('aceite 10: atendente inativo — nome (inativo) e Assumir conversa para o OPERATOR')`; `it('aceite 3: 409 conversation_changed — toast com o texto e recarga')`.
2. [ ] RED (`transfer-menu.spec.tsx`): `it('aceite 8: lista de chat/assignees sem o atendente atual e sem quem olha; nenhuma chamada a /users')`; `it('escolher abre o diálogo Transferir para {nome}')`; `it('404 user.not_found — Esta pessoa não pode receber a conversa. Escolha outra.')`.
3. [ ] RED (`conversation-action-dialog.spec.tsx`): `it('observação limitada a 200; vazia não é enviada')`; `it('Cancelar fecha sem chamar')`.
4. [ ] GREEN; apagar `AssignMenu`; `npx tsc -b`; eslint (GK9); validação; `--changed`.

**Aceite:** 2, 3, 4 (manual), 8, 10 (tela). **Risco: médio** (a regra é do servidor; a tela só esconde). Revisão `sonnet`.

## Task 10 — Front: compositor travado quando outro atende

**Arquivos:** criar `frontend/src/features/chat/components/assignee-lock-banner.tsx`, specs `assignee-lock-banner.spec.tsx`, `message-composer.lock.spec.tsx`; modificar `components/message-composer.tsx` (lê a conversa por `useConversation(conversationId)`; trava por `replyLock` ou pelo 409 local; aviso acima do campo; "Enviar", Enter e clipe desligados; não edita `message-thread.tsx`).

**Interfaces:** consome CK7, CK8 (`replyLock`, `parseAssigneeDetail`, `assigneeLabel`), `useAssignConversation`, `useAuthStore`, `readApiErrorBody`. Produz `AssigneeLockBanner({ name, onAssume, pending })`.

**Contexto vinculado:**
- K1-6: "Quando a conversa aberta está com outro atendente, ou depois de um 409 `chat.assigned_to_other`: aparece '{Nome} está atendendo esta conversa.' com o botão 'Assumir conversa'; o campo de texto continua editável e o texto digitado é mantido, mas 'Enviar' fica desligado até assumir."
- Aceite 6: "A tela mostra '{Nome} está atendendo esta conversa.', mantém o texto e deixa 'Enviar' desligado até 'Assumir conversa'." K1-5: vale para texto e mídia. DK17 inteiro (clipe desligado junto; conversa Pendente ou Resolvida libera o envio; o 409 local vale até a conversa recarregada mostrar outro estado ou o "Assumir" dar certo). DK14/GK10 (`detail` lido de forma assíncrona por `readApiErrorBody`, num efeito, nunca na renderização).
- Estado de hoje: `restricted`/`attachRestricted` por `useProviderGate` (`message-composer.tsx:110-123`); `onChange` sai se `restricted` (`:196`) — a trava nova **não** bloqueia o `onChange`; `submit` (`:209`); textarea `disabled` (`:298`); Enviar (`:302`); clipe (`:287`); texto mantido após erro (`:211-222`); aviso genérico de falha (`:138,:309`) não aparece para `chat.assigned_to_other`.
- GK9: `message-composer.tsx` é legado (vários specs `.hardening`, `.media`, `.provider-gate`, `.window`): só as inserções; os specs existentes continuam verdes.

**Passos:**
1. [ ] RED (`assignee-lock-banner.spec.tsx`): `it('texto {Nome} está atendendo esta conversa. e botão Assumir conversa')`; `it('nome inativo com (inativo)')`.
2. [ ] RED (`message-composer.lock.spec.tsx`): `it('aceite 6: conversa de outro — aviso, textarea editável, Enviar e clipe desligados, Enter não envia')`; `it('aceite 6: 409 assigned_to_other no envio — aviso com o nome do detail e o texto mantido; sem o aviso genérico de falha')`; `it('aceite 6: Assumir conversa — manda userId = eu e expected = atendente; sucesso libera Enviar com o texto')`; `it('Pendente e Resolvida — envio liberado')`; `it('409 na mídia — mesmo aviso')`.
3. [ ] GREEN; specs existentes do compositor verdes; `npx tsc -b`; eslint (GK9); validação; `--changed`.

**Aceite:** 6 (tela). **Risco: alto** (o texto digitado não pode se perder e o envio não pode sair sem assumir na tela; a decisão de autorização é do servidor, não categoria crítica da SKILL aqui). Revisão `sonnet`.
**Foco da revisão:** a tela trava o envio, mas quem recusa é o servidor (T5); o risco aqui é perder texto, deixar Enviar/clipe/Enter ativos com a conversa de outro, ou mostrar o aviso errado.

## Task 11 — Front: "Histórico da conversa"

**Arquivos:** criar `frontend/src/features/chat/history-text.ts`, `components/conversation-history.tsx`, specs `history-text.spec.ts`, `components/conversation-history.spec.tsx`; modificar `components/message-thread.tsx` (**só** montar `<ConversationHistory conversationId={…} />` recolhido, no cabeçalho ou logo abaixo dele).

**Interfaces:** consome `useConversationHistory` e `conversationHistorySchema` (T7). Produz `historyLine`, `historyTime` (CK8) e `ConversationHistory({ conversationId })`.

**Contexto vinculado:**
- K1-2: "Cada linha guarda quem (ou 'Sistema'), quando, ação, de e para (usuários) e observação opcional (até 200). Ações: assumiu, assumiu ao responder, transferiu, removeu atendente, resolveu, reabriu e passagem de turno (K3). Visível a quem tem acesso à caixa, na própria conversa, sob 'Histórico da conversa'."
- Aceite 4: "com 'Sistema' no histórico". Aceite 8: "Cada mudança aparece no histórico".
- DK19 inteiro (textos exatos, consulta só ao abrir, carregando/erro/vazio, "Usuário removido", hora de Manaus `dd/MM HH:mm`). M8: o back devolve 200 itens e `hasMore`; com `hasMore` verdadeiro a tela mostra, abaixo da lista, "Mostrando as 200 mudanças mais recentes." (constante `HISTORY_TRUNCATED_TEXT` em `history-text.ts`). DK20 (a chave fica sob `['chat','conversations',id]`; o tempo real já a invalida).
- GK9: `message-thread.tsx` é legado — só a montagem.

**Passos:**
1. [ ] RED puro (`history-text.spec.ts`): um `it` por ação com o texto exato de DK19; `it('aceite 4: REOPENED sem autor — Sistema reabriu a conversa (nova mensagem recebida)')`; `it('nome nulo com id — Usuário removido')`; `it('historyTime em America/Manaus, dd/MM HH:mm')`.
2. [ ] RED (`conversation-history.spec.tsx`): `it('fechado — nenhuma chamada; abrir busca chat/conversations/:id/history')`; `it('linhas na ordem da resposta com Observação: …')`; `it('vazio — Nenhuma mudança registrada.')`; `it('erro — Não foi possível carregar o histórico e Tentar de novo')`; `it('M8: hasMore verdadeiro — rodapé "Mostrando as 200 mudanças mais recentes."; sem hasMore ou falso — sem rodapé')`.
3. [ ] GREEN; `npx tsc -b`; eslint (GK9); validação; `--changed`.

**Aceite:** 4, 8 (histórico na tela). **Risco: baixo.** Revisão `sonnet`.

## Task 12 — Front: Novidades do K1

**Arquivos:** modificar `frontend/src/release-notes.ts` (entrada nova no topo de `RELEASE_NOTES`, ~L32-33); criar `frontend/src/release-notes.caixa.spec.ts`.

**Interfaces:** consome `ReleaseNote`/`ReleaseNoteItem` (`release-notes.ts:12-31`). Produz CK9.

**Contexto vinculado:**
- C2: "Uma entrada por lote. A de K1 avisa que conversas já atribuídas passam a exigir 'Assumir conversa' de quem não é o atendente."
- `frontend/CLAUDE.md`: entrada nova sempre no TOPO, ordem decrescente por `version` (`'YYYY.MM.DD'` ou `'YYYY.MM.DD.n'`); texto em PT-BR para o operador; `where` só com tela para linkar. Topo de hoje: `2026.11.21.1` (Lote J). DK21: versão do dia da implementação, maior que o topo; data não futura; sem nome ou telefone de exemplo.
- Itens (texto final do implementador, curto, no tom das vizinhas, todos com `where: '/inbox'`): situação da conversa (Pendente, Em atendimento, Resolvida) e o seletor "Abertas/Resolvidas"; "Resolver" e "Reabrir", e a conversa resolvida volta sozinha quando a pessoa escreve; só quem está atendendo responde — **conversas já atribuídas passam a exigir "Assumir conversa" de quem não é o atendente**, e responder numa conversa sem atendente já assume; "Transferir" e "Remover atendente", com a lista de quem pode receber; "Histórico da conversa".

**Passos:**
1. [ ] RED (`release-notes.caixa.spec.ts`): `it('aceite 11: entrada K1 no topo, versão maior que 2026.11.21.1, data não futura, itens em /inbox com Assumir conversa, Resolvidas e Histórico da conversa')`; `cd frontend && timeout 600 gate --test src/release-notes.spec.ts` verde.
2. [ ] GREEN; `npx tsc -b`; validação; `--changed`.

**Aceite:** 11. **Risco: baixo.** Revisão `sonnet`.

---

## Fechamento (principal)

1. Conferir o ledger: 13 tasks aceitas (T1–T3, T4a, T4b, T5–T12); revisões conforme cada task; `tsc` de back e front depois de cada onda (GK7); os testes do Rastreio presentes e verdes.
2. Conferências do lote: `grep -rn "assignedUserId:\|resolvedAt:" backend/src/modules --include=*.ts` (escrita só no núcleo e na ingestão, GK3); `grep -rn "conversationHistoryEntry\.\(update\|delete\)" backend/src` vazio; `git diff --stat feat/panorama-estrutura` sem `route-parity.spec.ts`, `roles.guard.ts`, `features/audit-trail/labels.ts` (GK1, DK7, DK12); a migração com `SET LOCAL lock_timeout` e sem `UPDATE`/`DROP` (GK12).
3. Revisão final do conjunto com `opus` (diff inteiro contra `feat/panorama-estrutura`).
4. Gates completos, **um de cada vez**, nada mais rodando (sem stack de QA junto; memória "gate completo sozinho"): back com `NODE_OPTIONS=--max-old-space-size=6144` e `TESTCONTAINERS_ENABLED=1`, depois front, `--base origin/main`, no estado final; comparar com `.superpowers/sdd/2026-11-21-orgamind-gbr-etapa5-lote-j-panorama-estrutura/final-back-gate-full-detail.log` e `final-front-gate-full-detail.log` pelo script ancorado; bloquear violação nova ou agravada (lint, sonar, complexidade, duplicação); conferir `max-lines-per-function` 50 dos specs novos.
5. QA visual (agente `qa`, roteiro Node com `@playwright/test` do frontend, senha do seed lida no processo e nunca impressa, login 5/min) na stack `orgamind-turnos-qa` (sem worker nem Evolution: mensagem recebida ao vivo não acontece no QA; a reabertura automática fica provada só pelos testes da T6 — anotar). Dados fictícios por SQL com prefixo `qa_k1_` e a reversão em `qa/qa-data.md`: um ADMIN e dois OPERATOR com login (se o seed não tiver dois OPERATOR com senha conhecida, a principal cria pelo mesmo hash do seed e anota a reversão), um OPERATOR inativo, um SUPERVISOR; conversas Pendente, Em atendimento (de cada OPERATOR, uma do inativo) e Resolvida. O envio ao provedor falha no QA (sem provedor): conferir que a atribuição fica e a mensagem aparece como falha. Até 5 critérios por despacho:
   - **QA-1 (lista):** Abertas por padrão com a situação em cada linha; Resolvidas sem as abas de atendente; Não lidas combinada; conversas antigas como Pendente/Em atendimento.
   - **QA-2 (atendente):** OPERATOR A resolve a sua com observação (sai das Abertas; histórico mostra); OPERATOR A não vê "Resolver" na de B; ADMIN resolve a de B; Reabrir a resolvida; histórico com as linhas.
   - **QA-3 (trava):** OPERATOR A abre a de B: aviso "{B} está atendendo esta conversa.", digita, Enviar e clipe desligados, texto mantido; "Assumir conversa" libera e o texto continua; ADMIN também vê o aviso.
   - **QA-4 (transferir e remover):** menu Transferir do OPERATOR lista só ADMIN e OPERATOR ativos (rede: `GET chat/assignees`, nenhuma chamada a `/users`); transferir com observação; remover volta a Pendente; conversa do inativo com "(inativo)" e Assumir.
   - **QA-5 (corrida na tela):** duas abas (A e B) na mesma Pendente; A responde (assume); B tenta Resolver/Remover com a tela antiga → mensagem "A conversa mudou…" e recarga; B tenta responder → aviso com o nome de A; responder numa Pendente assume ("assumiu ao responder" no histórico).
6. Atualizar "Estado" deste plano; registrar na spec, em "Para a GBR confirmar", as decisões que mudam o que a GBR vê (as de "Dúvidas de produto", abaixo).
7. Commits do lote (docs: plano; back; front), push e PR **rascunho** sobre `feat/panorama-estrutura` (C1: empilhado sobre o #22), com os avisos: "Vai para produção junto com os Lotes F–J (PRs #18–#22)"; "migração aditiva: coluna `Conversation.resolvedAt` e tabela `ConversationHistoryEntry`, com `lock_timeout`"; "conversas já atribuídas passam a exigir 'Assumir conversa' de quem não é o atendente, inclusive o ADMIN"; "`POST chat/conversations/:id/assign` passa a exigir `expectedAssigneeId`". **Sem merge, sem deploy.**

## Dúvidas de produto (decididas provisoriamente; para a GBR confirmar)

- **Conversa Pendente só o ADMIN resolve (DK5):** a spec diz "o atendente ou o ADMIN"; sem atendente, o OPERATOR precisa assumir antes. Recomendação: manter.
- **Assumir ou transferir uma resolvida grava duas linhas (DK6, DK10):** "reabriu" e depois "assumiu"/"transferiu" (ou "assumiu ao responder"). Recomendação: manter.
- **Pedido que já é o estado (DK6):** assumir a própria conversa aberta ou remover sem atendente responde 200 sem gravar nada. Recomendação: manter.
- **"Assumir conversa" sem observação na tela (DK15):** um clique; a API aceita observação. Ligado à pergunta 7 da spec ("Assumir de outro e resolver exigem motivo?"). Recomendação: manter até a GBR responder.
- **Trilha `conversation.assign` fora de `/trilha` (DK7):** continua sem categoria, como hoje; quem/quando/por quê fica no "Histórico da conversa". Recomendação: manter; se a GBR quiser na trilha, é uma categoria nova (migração de enum) num lote seguinte.
- **Histórico mostra as 200 mudanças mais recentes (DK13), com o aviso "Mostrando as 200 mudanças mais recentes." quando há mais (M8).** Recomendação: manter.
- **Clipe de anexo desligado junto com "Enviar" (DK17).** Recomendação: manter (a mídia também recebe 409).
- **"Transferir" esconde quem olha e o atendente atual (DK16).** Recomendação: manter ("Assumir conversa" cobre o próprio).

## Não verificado (conferir na task dona)

(Conferidos neste plano: só a ingestão grava `lastInboundAt` — grep em `backend/src`; `AuditChange.category` não aceita `null` hoje, `audit-change.ts:16`, e o repositório aceita, `audit.repository.ts:14,47`; `/trilha` filtra categoria não nula, `audit-trail.service.ts:53,76`; o filtro de erro não loga `detail`, `domain-exception.filter.ts:113`; `DomainError.detail` é `string`, `domain.error.ts:5`; `route-parity.spec.ts` só varre os controllers de `PARITY`, `:59,:260-269`; `invalidateConversationThread` cobre `['chat','conversations',id,…]`, `api.ts:172-176`; `Conversation` sem `@@map`.)

- Como `chat-ingest.integration.spec.ts` aplica as migrações (`execFileSync`, `:4`) e se `backend/test/migrations.ts` é o helper (T1, e T2–T6 copiam o setup).
- Se existe precedente de spec que lê `migration.sql` em `backend/src` (T1).
- **Índice em `Conversation` (M3):** esta migração **não** cria índice novo na tabela (o `CREATE INDEX` sem `CONCURRENTLY` trava escrita durante a construção, e `lock_timeout` limita só a espera). Não medido: se a lista sem `instanceId` ficará lenta em produção com o tamanho atual de `Conversation`. Se for preciso, o índice vai em **migração separada**, com `CREATE INDEX CONCURRENTLY` fora de transação (sem `SET LOCAL`), decidida pela principal depois da medição.
- ~~Se `pg` é dependência direta do backend~~ — conferido em 21/11 (revisão 2): não é; vale DK22 (segundo `PrismaClient` dedicado com `connection_limit=2` para trava e poll; código sob teste com `connection_limit=5`).
- Quais specs fixam a forma exata do `ConversationSummary` no back (`conversation-summary.mapper.spec.ts`, `chat.conversation-summary.spec.ts`, `chat.repository.list.spec.ts`) e no front (`schemas.spec.ts`) (T2, T7).
- Nomes exatos dos campos de `req.user` (`sub` e `role`; `jwt.strategy.ts:44-54` relê papel, `isActive` e `hasAccess` do banco a cada request, DK12) e como os specs de controller do projeto montam o `RolesGuard` real (T3, T4a, T4b).
- Estilo de registro em `chat.module.ts` e se `AuditService` vem de módulo global (o `ChatService` já o injeta) (T3, T5).
- Quais specs constroem `ChatService`/`ChatMediaService` à mão ou com Prisma falso e quebram com a trava (T5); quais specs unitários de ingestão quebram com a transação nova (T6).
- Outros chamadores de `ChatService.assignConversation` e `ChatRepository.assignConversation` fora do controller (T5, por grep antes de apagar; os três specs que as testam já estão nomeados: `chat.controller.spec.ts:28-36` na T4b, `chat.repository.spec.ts:95-106` e `chat.service.bot.spec.ts:66-78` na T5; `api.assign.spec.ts:28,35` na T7 do front).
- `isEnabledChannelProvider` para o provedor do canal usado nas integrações da T5 (memória "Somente Evolution").
- Props de `MessageComposer` e se ele recebe só o `conversationId` (T10); props de `AssignMenu` (T7).
- Caminho e campos de `useAuthStore` (id e papel) e o diálogo padrão da caixa (T9, T10).
- Helper de data e hora em Manaus no front para `dd/MM HH:mm` (T11; senão `Intl.DateTimeFormat` com `timeZone: 'America/Manaus'`).
- Se o seed da stack de QA tem dois OPERATOR com senha conhecida (Fechamento, QA).
