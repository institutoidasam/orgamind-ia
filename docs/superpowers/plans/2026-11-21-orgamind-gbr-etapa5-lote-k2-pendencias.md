# OrgaMind, Etapa 5 GBR, Lote K2: pendências da equipe (INT-04). Implementation Plan

> **Para os agentes:** executar pela skill `sdd` (TDD, ledger em `.superpowers/sdd/2026-11-21-orgamind-gbr-etapa5-lote-k2-pendencias/progress.md`). **Sem commit/push**: nenhuma task commita; a principal integra e commita o lote. Branch `feat/pendencias-equipe`, sobre `feat/caixa-situacao` em `08e860d` (Lote K1). Fechamento de task por `gate --changed --base feat/caixa-situacao`. Regras dos agentes: `.superpowers/sdd/2026-11-21-orgamind-gbr-etapa5-lote-k2-pendencias/{implementer-rules,reviewer-rules}.md` (criadas na Preparação). Linhas citadas são pistas e podem ter mudado.

**Goal:** (1) cada destinatário de alerta urgente é uma pendência com situação calculada (Ciente, Encerrada sem ciência, Sem responsável, Em tratativa — atrasada, Em tratativa), responsável, prazo de tratativa de 60 min, anotações e encerramento; (2) uma única função de alcance no servidor decide quem vê cada pendência (ADMIN todas; os demais remetentes, as dos alertas que enviaram e as das pessoas dos setores ativos que gerem), usada pela lista, pelo contador, pelos destinos, pelas ações e pela ciência manual do Lote I; (3) tela "Pendências da equipe" com filtros, ordem, período e ações (assumir, assumir de outro, transferir, registrar contato, encerrar, reabrir, ciência manual); (4) contador no menu; (5) o painel do alerta mostra "Tratativa encerrada por {nome}: {motivo}" sem mudar o grupo.

**Architecture:** back — migração aditiva: seis colunas de pendência **no próprio** `TeamWhatsappRecipient` (a condição atômica fica na mesma linha que a ciência grava) e a tabela `TeamPendencyNote` (enum de tipos já com a passagem de turno do K3, que não terá migração). Regras puras num arquivo (`team-pendency.rules.ts`: situação, alcance, responsável válido, ordem, contador). O alcance é **um** descritor (`pendencyScopeOf`) com duas leituras do mesmo descritor: `scopeAllows` (em memória) e `pendencyScopeWhere` (Prisma), provadas equivalentes por teste. Escrita pelo padrão do K1: transação interativa que trava a linha do destinatário (`FOR NO KEY UPDATE`), confere o estado esperado em TypeScript, grava por `UPDATE` cru (sem tocar `updatedAt`), insere a anotação e grava a trilha por `AuditService.recordChange(tx, …)`, tudo na mesma transação; a função devolve um resultado (`ok` ou o conflito), que o serviço traduz em 409/422 e o K3 traduzirá em "pulada com motivo". Serviços e controller novos (`TeamPendencyService` de leitura, `TeamPendencyActionsService` de escrita, `TeamPendencyController`). A ciência manual do Lote I troca só a conferência de visibilidade. Front — feature nova `features/team-pendencies/` (contrato tolerante, hooks, rótulos, mensagens por `code`, ações puras), rota `/pendencias-equipe`, item de menu com contador, linha nova no painel do alerta e Novidades.

**Tech Stack:** NestJS + Prisma 6 + Zod v4 + Vitest/testcontainers no back; React + TanStack Router/Query + ky 2 + Vitest/Testing Library no front. **Uma migração aditiva; sem dependência nova; sem runner novo; sem chave de permissão nova.**

**Spec:** `docs/superpowers/specs/2026-11-21-orgamind-gbr-etapa5-pendencias-caixa.md` (APROVADA) — Intenção, Vocabulário, Não objetivos, Anti-objetivos, Restrições, C1–C3, K2-1..K2-9, Limites conhecidos, "Para a GBR confirmar", Aceite K2 (12–24), "Fica com o construtor", Correções das revisões 1 e 2 (prevalecem). Sentença: `~/.claude/tribunais/2026-11-20/conselho-W/sentenca-W.md`. Mapas: `.superpowers/sdd/2026-11-21-orgamind-gbr-etapa5-lote-k2-pendencias/{map-back-team,map-front-team}.md`. Modelo e padrões reaproveitados: plano do K1 (`docs/superpowers/plans/2026-11-21-orgamind-gbr-etapa5-lote-k1-caixa.md`), `backend/src/modules/chat/conversation-ownership.repository.ts` e `conversation-ownership.test-fixtures.ts`, `frontend/src/features/chat/components/conversation-action-dialog.tsx`.

## Estado (21/11/2026)

- Plano escrito; nenhuma task começou. Base `08e860d` (`docs: add lote K1 inbox situation plan`) no branch `feat/pendencias-equipe`, criado a partir de `feat/caixa-situacao`.
- Não commitados de fora do lote: `.playwright-mcp/`, `reports/`, `research_notes/`, `tutoriais/` (preservar).
- 21/11: revisão 1 (opus) NEEDS_FIXES (`.superpowers/sdd/2026-11-21-orgamind-gbr-etapa5-lote-k2-pendencias/plan-review-1.md`); ajustes aplicados: corridas "a ciência chega antes" com `recordAlertReply` dentro de `$transaction` no teste e o resultado de produção registrado no DK23 (I1); `PendencyExpectation` com `closed: boolean | 'any'` e `ignoreAck` para Registrar contato (I2, DK10/DK13, teste na T2 e na T8a); teto lido do mais novo para o mais antigo e contador sem teto, por lotes (I3, DK7, CK7, testes na T5a/T5b); divergência do aceite 18 removida (M1); "nada a fazer" do Assumir e do Transferir decidido na linha travada (M2); `team_whatsapp.pendency_handover` no tipo (M3); T5 dividida em T5a/T5b e T8 em T8a/T8b, 18 tasks em 8 ondas (M4); item do alerta agendado tirado de "Não verificado" (M5); T13 usa `alertActionErrorText` (M6); teste de K2-1 na T5a e limite da paleta/`canAccessPath` registrado no DK21 (M7).
- 21/11: revisão 2 (opus) APPROVED (`plan-review-2.md`); 3 Minor aplicados: `batchSize` opcional em `count` (CK7), `newPendency` com `assignedAt`/`closedById`/`closeReason` e `newPendencyNote` (T1), ciência das corridas em `$transaction(…, PENDENCY_TX_OPTIONS)` (T7/T8b).
- 21/11: as 18 tasks foram aceitas nas ondas 1 a 8, cada uma com revisão e com o gate conjunto da onda verde; os rulings e os Minors do backlog estão no ledger (`progress.md`).
- Revisão final do conjunto (opus): APPROVED (`final-review.md`). O único Minor com efeito visível (409 com nome vazio) foi reclassificado como Important, corrigido e aprovado na re-revisão (`final-fix-rereview.md`).
- Conferências do Fechamento, item 2:
  - GK3: só `team-pendency-write.repository.ts` grava `pendency*`.
  - Nenhum `update` ou `delete` de nota.
  - GK1: nenhum arquivo proibido no diff.
  - GK12: a migração tem `SET LOCAL lock_timeout` e nenhum `UPDATE` ou `DROP`.
  - GK13: nenhum `logger` novo.
- Gate completo do back contra `origin/main`: nada novo do K2. Os 30 achados de lint em `chat/chat-media.send.spec.ts` são dívida do K1 (arquivo que o K2 não toca).
- **Próximo passo:** gate completo do front (rodando sozinho), depois o QA visual (QA-1 a QA-5), depois commits e o PR rascunho sobre `feat/caixa-situacao`.

## Preparação (principal, antes da T1)

1. Conferir `git merge-base feat/pendencias-equipe feat/caixa-situacao` = `08e860d` (senão o `--changed` mede o K1 junto). Em worktree: `backend/.env` fictício e `node_modules` por symlink (memória "gate em worktree").
2. Criar `implementer-rules.md` e `reviewer-rules.md` em `.superpowers/sdd/2026-11-21-orgamind-gbr-etapa5-lote-k2-pendencias/`, copiando os do K1 e adaptando: branch `feat/pendencias-equipe`, base `feat/caixa-situacao`, este plano, a spec da Etapa 5 parte B, o ledger novo; referências `DKn`, `GKn` e `CKn` anexadas no fim do brief; "os Lotes A–K1 estão prontos no branch; não revisar nem mexer fora do ownership"; timeout de shell de no máximo 600 s em subagente. Riscos do lote no `reviewer-rules.md` (copiar o Review Focus abaixo).
3. Criar o ledger `progress.md` com a referência de partida (`08e860d`) e os não commitados de fora do lote.
4. Depois da T1, rodar `cd backend && npx prisma generate` no checkout onde as tasks seguintes rodam (as Ondas 2+ precisam dos tipos novos).

## Decisões deste plano (o que a spec deixa com o construtor)

- **DK1. Onde mora a pendência.** Colunas novas no próprio `TeamWhatsappRecipient` (spec K2-3: "no destinatário ou ao lado dele"), não tabela 1:1. Por quê: a ciência (`ackAt`) é gravada nessa linha por `recordAlertReply` e `markManualAck` com `updateMany … ackAt: null`; com a pendência na mesma linha, a trava `FOR NO KEY UPDATE` da ação e o `UPDATE` da ciência se serializam na mesma linha, e "encerrar × ciência chegando" tem uma ordem só (DK23). Migração `backend/prisma/migrations/20261121120000_team_pendency/migration.sql`, aditiva, com `SET LOCAL lock_timeout = '15s';` no topo (comentário de por quê e de `prisma migrate resolve --rolled-back` se estourar, como `20261121100000_conversation_situation_history`):
  - `CREATE TYPE "TeamPendencyNoteKind" AS ENUM ('CONTACT', 'ASSUME', 'CLOSE', 'HANDOVER');` — `HANDOVER` entra já porque "K3 não tem migração" (Restrições) e a K3-4 grava "Passagem de turno: {observação}" como anotação.
  - `ALTER TABLE "TeamWhatsappRecipient"` com seis `ADD COLUMN`, todas nulas e sem `DEFAULT` (nenhuma linha é reescrita): `"pendencyHandlerId" TEXT` (responsável), `"pendencyAssignedAt" TIMESTAMP(3)` (hora em que foi assumida/transferida), `"pendencyDueAt" TIMESTAMP(3)` (prazo da tratativa), `"pendencyClosedAt" TIMESTAMP(3)`, `"pendencyClosedById" TEXT`, `"pendencyCloseReason" VARCHAR(200)`. **Sem FK** em `pendencyHandlerId` e `pendencyClosedById` (como `ackByUserId`, "sem FK, como o histórico do envio", `schema.prisma:1956`).
  - `CREATE TABLE "TeamPendencyNote"`: `id TEXT PK`, `recipientId TEXT NOT NULL`, `kind "TeamPendencyNoteKind" NOT NULL`, `authorId TEXT NOT NULL` (sem FK), `text VARCHAR(200) NOT NULL`, `createdAt TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP`; FK `recipientId → "TeamWhatsappRecipient"(id) ON DELETE CASCADE ON UPDATE CASCADE` (o destinatário já é Cascade do envio); índice só `TeamPendencyNote(recipientId, createdAt)`.
  - **Nenhum índice novo em `TeamWhatsappRecipient` nem em `TeamWhatsappDispatch`** (mesmo motivo do K1, M3: `lock_timeout` limita a espera, não a construção; `CONCURRENTLY` não roda dentro do `SET LOCAL`). As consultas entram pelo envio (`ackDeadlineMinutes` não nulo) e pelos índices de hoje; medição em produção vai para "Não verificado".
  - Nenhum `UPDATE`, `DELETE`, `DROP`, `INSERT` ou backfill: destinatários existentes ficam sem responsável e abertos ("Sem responsável", ou "Ciente" se têm `ackAt`).
  - DDL: sai do `prisma migrate diff` e é editado à mão para tirar qualquer `DROP` de deriva/quarentena que não seja desta migração (como DK1 do K1).
- **DK2. Anotações.** `TeamPendencyNote` só de inclusão (nenhum código faz `update`/`delete`). Tipos: `CONTACT` ("Registrar contato", texto obrigatório); `ASSUME` (observação opcional de "Assumir"/"Assumir de outro", K2-7); `CLOSE` (o motivo do encerramento, gravado **também** como anotação para não se perder quando a tratativa é reaberta, que limpa as colunas de encerramento, DK14); `HANDOVER` (K3). O texto fica sempre até 200 (o prefixo é da tela, DK19).
- **DK3. Alcance (K2-4), uma regra só.** Em `team-pendency.rules.ts`:
  - `pendencyScopeOf(actor: TeamActor | null): PendencyScope` — `!actor || !isTeamSender(actor)` → `{ kind: 'none' }`; ADMIN → `{ kind: 'all' }`; senão `{ kind: 'limited', actorId, sectorIds: actor.managedSectorIds }` (`managedSectorIds` já só traz setores ATIVOS, `team-actor.query.ts:21`).
  - Fatos de uma pendência (`PendencyScopeFacts`): `isAlert` (o envio tem `ackDeadlineMinutes` não nulo; lembrete e outras finalidades não têm, `schema.prisma:1880-1882` e `loadAlertHeader`), `authorId` do envio, `sectorId` gravado no destinatário e `personSectorId` = `User.sectorId` atual da pessoa (`recipient.user.sectorId`; `userId` nulo → nulo). Setor efetivo = `sectorId ?? personSectorId` (K2-4: "se vazio (envio nominal), o setor principal atual da pessoa").
  - `scopeAllows(scope, facts)`: `none` → falso; `!isAlert` → falso; `all` → verdadeiro; `limited` → `authorId === actorId` ou setor efetivo em `sectorIds`. Setor sem gestor (K2-9) sai sozinho: ninguém o tem em `managedSectorIds`.
  - `pendencyScopeWhere(scope)` (T3) é a **mesma** regra em `Prisma.TeamWhatsappRecipientWhereInput`: `none` → `null` (o chamador devolve vazio sem consultar); `all` → `{ dispatch: { ackDeadlineMinutes: { not: null } } }`; `limited` → isso `AND OR [{ dispatch: { authorId } }, { sectorId: { in } }, { sectorId: null, user: { sectorId: { in } } }]`. Um teste parametrizado (T3) confere, para cada ator × pendência da massa, que a consulta e `scopeAllows(findPendencyScopeFacts(…))` concordam. Nenhum outro arquivo escreve regra de alcance.
- **DK4. Responsável válido (K2-2).** `handlerStateOf(handler: TeamActor | null, facts): HandlerState`:
  - `'inactive'` — usuário inexistente, `!isActive` ou `!hasAccess` (rótulo "{nome} (inativo)");
  - `'out_of_scope'` — `!canHandlePendency(handler, facts)`, isto é, deixou de ser remetente, perdeu `equipe.enviar` ou não vê mais a pendência pelo DK3 (rótulo "{nome} (fora do alcance)", K2-2 e revisão 2 N5);
  - `'active'` — o resto.
  - `canHandlePendency(actor, facts) = !!actor && isTeamSender(actor) && hasPermission(actor, 'equipe.enviar') && scopeAllows(pendencyScopeOf(actor), facts)`. É também a regra do destino de "Transferir" e da lista de destinos (K2-7), e será a do K3-4.
  - O rótulo "(fora do alcance)" é o de K2-2 e do aceite 18 da spec (já alinhados: "(fora do alcance)").
- **DK5. Situação (K2-2) e ordem (K2-5).** `pendencySituation(f, now)`, nesta ordem: `ackAt` → `'ACKED'`; `closedAt` → `'CLOSED'`; `handlerId` nulo ou `handlerState !== 'active'` → `'UNASSIGNED'`; `dueAt <= now` → `'OVERDUE'`; senão `'IN_PROGRESS'`. Ordem da lista (`comparePendencies`): posto 0 = `UNASSIGNED` com prazo de ciência vencido (`alertDeadlineAt(createdAt, ackDeadlineMinutes) <= now`, `team-alert.rules.ts:143`); posto 1 = `OVERDUE`; posto 2 = as demais; dentro do posto, alerta mais antigo primeiro (`dispatch.createdAt` asc), depois `id`. Contador (K2-6): `isUnassignedOverdue(p, now)` = situação `UNASSIGNED` e prazo de ciência vencido, no alcance, sem data.
- **DK6. Prazo (K2-8).** `PENDENCY_HANDLING_MINUTES = 60` (constante única, em `team-pendency.rules.ts`); `pendencyDueAt(now) = now + 60 min`, gravado em `pendencyDueAt` ao assumir, assumir de outro, transferir e reabrir com responsável. Só muda rótulo e ordem.
- **DK7. Lista (K2-5).** `GET internal/team-whatsapp/pendencies?situations=UNASSIGNED,IN_PROGRESS,OVERDUE&sectorId=&mine=false&days=7&page=1&pageSize=20`. Passos do serviço:
  1. ator (`findTeamActor`) → `!isTeamSender` → 403 `team_whatsapp.forbidden` (`teamForbidden()`);
  2. carrega no alcance (`pendencyScopeWhere`) os fatos leves: abertas (`ackAt` e `pendencyClosedAt` nulos) **sem limite de data**; e, só se `situations` tiver `ACKED` ou `CLOSED`, as cientes ou encerradas com `dispatch.createdAt >= now - days` (`days` ∈ {7, 30}, padrão 7, pela data do alerta);
  3. estados dos responsáveis em lote (`handlerStatesFor`, T3), situação, filtros (`situations`; `sectorId` pelo setor efetivo; `mine` = `pendencyHandlerId === actor.id`), ordem DK5, página em memória (`page` 1..10 000, `pageSize` 1..50, padrão 20, os limites de `dto/page-query.dto.ts:5-8`);
  4. detalhes **só da página** (anotações, última resposta, conversa, nomes);
  5. `sectors` = setores efetivos distintos das linhas no alcance antes do filtro de setor (`{ id, name }`, nome do envio ou do setor atual), para o seletor.
  - Teto de segurança da lista: cada consulta do passo 2 lê no máximo `PENDENCY_LIST_MAX_ROWS = 2000` linhas, **da mais nova para a mais antiga** (`orderBy: [{ createdAt: 'desc' }, { id: 'desc' }]` do destinatário, que nasce com o envio, `schema.prisma:1970`), pedindo `max + 1` para saber se passou; a ordem DK5 é feita depois, em memória, sobre o que foi lido. Passou do teto, `truncated: true` e a tela avisa (DK19): as que ficam de fora são as mais antigas (alerta que ninguém confirma fica aberto para sempre; as recentes são as que mais importam). `sectors` sai das linhas lidas. Paginação e teto ficam com o construtor ("Fica com o construtor": "Paginação da lista de pendências e índices novos").
  - **Contador sem teto (K2-6: "sem limite de data").** `count` não usa o teto da lista nem tem `truncated`: o banco filtra alcance (`pendencyScopeWhere`) e abertas (`ackAt` e `pendencyClosedAt` nulos) e devolve só os fatos leves (`id`, `dispatchId`, `createdAt` e `ackDeadlineMinutes` do envio, `pendencyHandlerId`, `sectorId`, `user.sectorId`, `dispatch.authorId`); a leitura é feita em lotes de `PENDENCY_LIST_MAX_ROWS` por cursor (`orderBy id`, `cursor`/`skip: 1`) até acabar; em cada lote, `handlerStatesFor` e `isUnassignedOverdue` em memória, somando. Memória limitada ao lote; o custo cresce com o número de abertas no alcance (medição em "Não verificado").
  - "As ações e a passagem de turno não olham período": nenhuma ação filtra por data.
- **DK8. Campos da linha (K2-5).** `TeamPendencyItem` (CK2):
  - pessoa: `userName` (por `nameView`, com a máscara se parecer telefone e o ator não tiver `telefone.ver_completo`), `sectorId`/`sectorName` e `shiftName` gravados no envio;
  - telefone: `phoneView(recipient.phoneE164, { full: hasPermission(actor, 'telefone.ver_completo') })` (`shared/authz/phone-visibility.ts:14-28`: completo só com a chave, senão `hasPhone` + `phoneMasked`; `phoneE164` do destinatário é o gravado no envio, nulo em envio antigo). O painel do alerta de hoje não devolve telefone (mapa back §7); a tela de pendências segue a regra de telefone do resto do WhatsApp da equipe (`team-whatsapp/schemas.ts:48` no front);
  - alerta: `text` do envio, `authorName` (nome do autor por `nameView`; autor removido → `null`), `sentAt` (`dispatch.createdAt`), `ackDeadlineAt`;
  - `group` = `alertGroupOf(factsOf(row))` (as mesmas regras do painel; T3 monta `AlertPersonRow` com os estados dos lembretes e chama `factsOf`, sem editar `team-alert.repository.ts`);
  - `situation`, `handler` (`{ id, name, state }` ou `null`), `assignedAt`, `dueAt`, `closure` (`{ byId, byName, at, reason }` ou `null`), `ack` (`{ kind, at }` ou `null`), `notes` (todas, mais antiga primeiro: `{ id, kind, authorName, at, text }`);
  - `lastReply` **só** quando `group === 'replied'` (K2-5, Anti-objetivo 2): a mensagem de `lastReplyMessageId`, com `text` só se `kind === 'TEXT'`; mídia vira `media` (`AUDIO` → `'audio'`; `IMAGE`, `STICKER` → `'image'`; `VIDEO`, `DOCUMENT`, `LOCATION`, `CONTACT`, `UNSUPPORTED` → `'file'`; enum `MessageKind`, `schema.prisma:1266-1276`), sem legenda; nos outros grupos, `null`. Nenhuma outra mensagem é lida;
  - `conversationId`: a conversa da mensagem do envio (`recipient.messageId` → `Message.conversationId`), **só** se o ator é ADMIN ou OPERATOR (acesso à caixa) e o envio gerou mensagem; senão `null` (K2-5, aceite 22). Abre em `/inbox/$conversationId` (rota existe);
  - `canViewDispatch` = `canViewDispatch(actor, dispatch)` (não muda; aceite 22: "só ao ADMIN e ao autor").
- **DK9. Rotas e papéis (K2-5, K2-7).** Controller novo `TeamPendencyController`, prefixo `internal/team-whatsapp` (como `team-alert.controller.ts:38`), `actorId = req.user.sub`:
  - leitura com `@Roles('ADMIN','SUPERVISOR','OPERATOR')`, sem `@RequirePermission` ("Ver não exige chave"): `GET pendencies`, `GET pendency-count` (fora de `pendencies/` para não colidir com `:id`), `GET pendencies/:id`, `GET pendencies/:id/handlers`;
  - escrita com `@RequirePermission('equipe.enviar')` e `@HttpCode(204)`: `POST pendencies/:id/assume`, `…/transfer`, `…/notes`, `…/close`, `…/reopen`. Respostas sem corpo: a tela recarrega (K2-5: "a tela recarrega após cada ação").
  - `route-parity.spec.ts` ganha a linha `{ controller: TeamPendencyController, routes: [...] }` com `ASO` em todas (padrão do Lote I, `:100-111`: leitura com `@Roles`, escrita só com `@RequirePermission`; "a mistura é barrada pelo teste abaixo"). T5a cria a linha com `GET /pendencies` e `GET /pendencies/:id`; T5b, T7, T8a e T8b acrescentam as suas.
  - Ordem das recusas (K2-7): 403 do guard (papel ou chave) → 403 `team_whatsapp.forbidden` (não remetente) → 404 `team_whatsapp.pendency_not_found` (inexistente ou fora do alcance) → 403 `team_whatsapp.not_handler` (pelo `expectedHandlerId` do pedido, como o K1 faz com `expectedAssigneeId`) → 404 `user.not_found` (destino de Transferir) → 409/422 na linha travada.
- **DK10. Núcleo de escrita** (`team-pendency-write.repository.ts`, CK6; padrão de `conversation-ownership.repository.ts`). `runPendencyTransition(prisma, audit, t)`:
  1. `prisma.$transaction(fn, PENDENCY_TX_OPTIONS)` com `PENDENCY_TX_OPTIONS = { timeout: 10_000, maxWait: 5_000 }` (DK22 do K1), isolamento padrão;
  2. `lockPendency(tx, id)`: `SELECT "id", "dispatchId", "ackAt", "pendencyHandlerId", "pendencyAssignedAt", "pendencyDueAt", "pendencyClosedAt", "pendencyClosedById", "pendencyCloseReason" FROM "TeamWhatsappRecipient" WHERE "id" = ${id} FOR NO KEY UPDATE` (modelo sem `@@map`); ausente → resultado `{ ok: false, conflict: 'missing' }`;
  3. `pendencyConflict(locked, t.expect)` (puro, T2), com `PendencyExpectation = { handlerId: string | null; closed: boolean | 'any'; ignoreAck?: boolean }`, nesta ordem: `ackAt` e `!expect.ignoreAck` → `'acked'`; `expect.closed === false` e encerrada → `'closed'`; `expect.closed === true` e aberta → `'not_closed'` (`'any'` não olha encerramento); `pendencyHandlerId !== expect.handlerId` → `'handler_changed'`. Expectativas por ação (as condições de K2-7): Assumir, Assumir de outro, Transferir e Encerrar `{ handlerId: expected, closed: false }`; Reabrir `{ handlerId: expected, closed: true }`; **Registrar contato `{ handlerId: expected, closed: 'any', ignoreAck: true }`** (DK13: "Condição: ainda é o responsável"). Conflito → devolve `{ ok: false, conflict, current }` sem gravar (rollback);
  4. com `patch` e `note` nulos, **só confere** (o "nada a fazer" de DK11/DK12): sem `UPDATE`, sem anotação, sem trilha, devolve `{ ok: true, before, after: before, noteId: null }`. Senão grava o estado seguinte por **`tx.$executeRaw` `UPDATE "TeamWhatsappRecipient" SET` as seis colunas `WHERE "id" = …`**, sem `updatedAt`: o `updateMany` do Prisma atualiza `@updatedAt`, e `[status, updatedAt]` é o índice do verificador de presos (H2, `schema.prisma:1976-1977`); a ação de pendência não pode adiar a reconciliação de um envio preso;
  5. insere a anotação (se houver) e grava a trilha `recordChange` (DK16), no mesmo `tx`;
  6. devolve `{ ok: true, before, after, noteId }` (fotos `{ handlerId, situation, dueAt }`).
  O resultado em vez de exceção é a interface do K3 (passagem de turno: conflito vira "pulada com motivo"). Ninguém mais grava as colunas `pendency*` nem `TeamPendencyNote`.
- **DK11. Assumir (K2-7, aceite 16–17)** `POST pendencies/:id/assume`, corpo `{ expectedHandlerId: string | null, note? }` (`expectedHandlerId` obrigatório; ausente → 400). Tipo (`assumeKind`, puro): `expectedHandlerId === actor.id` → `noop`; `null`, ou responsável com estado `inactive`/`out_of_scope` (lido antes da trava) → `assume`; responsável `active` → `take_over` ("Assumir de outro"). **O `noop` também passa pela linha travada** (`runPendencyTransition` com `patch` e `note` nulos, DK10.4): se ainda sou o responsável, sem ciência e aberta, 204 sem gravar nada (a observação é ignorada); se ficou ciente, foi encerrada ou transferida no meio, 409 `pendency_changed` — a API não devolve sucesso para um estado que já não é o mostrado. Na linha travada: `acked`/`closed` → 409 `team_whatsapp.pendency_changed`; `handler_changed` → em `assume` com responsável atual não nulo, 409 `team_whatsapp.pendency_taken` com o nome; nos demais casos, 409 `pendency_changed`. Grava `handlerId = actor`, `assignedAt = now`, `dueAt = now + 60 min`; com observação, anotação `ASSUME`. Quem: qualquer remetente com `equipe.enviar` que vê a pendência (sem 403 `not_handler`).
- **DK12. Transferir** `POST pendencies/:id/transfer`, corpo `{ toUserId: string, expectedHandlerId: string | null }` (sem observação: a spec não a prevê). Ordem: 403 `not_handler` se `actor.role !== 'ADMIN'` e `expectedHandlerId !== actor.id` → destino: `findTeamActor(toUserId)` e `canHandlePendency(destino, facts)` (ativo, com acesso, remetente, `equipe.enviar`, vê a pendência); senão `NotFoundError('User', toUserId)` (404 `user.not_found`, "como usuário inexistente") → `toUserId === expectedHandlerId` → `noop`: confere na linha travada como no DK11 (204 sem gravar, ou 409 `pendency_changed`) → trava: `acked`/`closed`/`handler_changed` → 409 `pendency_changed` → grava `handlerId = toUserId`, `assignedAt = now`, `dueAt = now + 60 min`. ADMIN transfere pendência sem responsável (`expectedHandlerId: null`).
- **DK13. Registrar contato** `POST pendencies/:id/notes`, corpo `{ expectedHandlerId: string | null, text }` (`text` aparado, 1..200). 403 `not_handler` (mesma regra) → trava com `expect = { handlerId: expectedHandlerId, closed: 'any', ignoreAck: true }` (DK10.3): só `handler_changed` → 409 `pendency_changed` (a condição "ainda é o responsável", K2-7; não olha ciência nem encerramento, para o contato feito no minuto em que a ciência chega não se perder) → anotação `CONTACT` (`patch: null`); colunas iguais (não muda situação nem prazo). A tela continua oferecendo o botão só nas abertas (DK20); o servidor aceita também em ciente ou encerrada.
- **DK14. Encerrar e reabrir.**
  - Encerrar `POST pendencies/:id/close`, corpo `{ expectedHandlerId, reason }` (`reason` 1..200). 403 `not_handler` → trava: `acked` → **422 `team_whatsapp.ack_exists`** (`ackExists()` de `team-alert.errors.ts:18`, o mesmo da ciência manual); `closed`/`handler_changed` → 409 `pendency_changed` → grava `closedAt = now`, `closedById = actor`, `closeReason = reason` (responsável e prazo ficam) e a anotação `CLOSE` com o motivo. ADMIN encerra pendência sem responsável.
  - Reabrir `POST pendencies/:id/reopen`, corpo `{ expectedHandlerId }`. 403 `not_handler` → trava (`expect.closed = true`): `acked`, `not_closed`, `handler_changed` → 409 `pendency_changed` → limpa as três colunas de encerramento; com responsável, `dueAt = now + 60 min` ("Volta a 'Em tratativa' com o mesmo responsável e prazo novo"); sem responsável (encerrada pelo ADMIN sem responsável), `dueAt` nulo e a situação volta a "Sem responsável".
- **DK15. Erros** (`team-pendency.errors.ts`, CK3; C3): `pendencyNotFound()` 404 `team_whatsapp.pendency_not_found`; `notHandler()` 403 `team_whatsapp.not_handler`; `pendencyTaken(handler)` 409 `team_whatsapp.pendency_taken`; `pendencyChanged(handler | null)` 409 `team_whatsapp.pendency_changed`; `detail = JSON.stringify({ handler: { id, name } | null })` — só id e nome do usuário do sistema, nunca pessoa da equipe ou contato. 422 `ack_exists` e 403 `team_whatsapp.forbidden` são os existentes; 404 do destino é `NotFoundError('User', id)`.
- **DK16. Trilha (K2-7, aceite 23).** `audit.recordChange(tx, { action, entity: 'TeamWhatsappRecipient', entityId: recipientId, category: null, changes, metadata, actorId })` (`AuditChange.category` já aceita `null` desde o K1). Ações: `team_whatsapp.pendency_assume` (`metadata.kind`: `assume` | `take_over`), `team_whatsapp.pendency_transfer`, `team_whatsapp.pendency_note`, `team_whatsapp.pendency_close`, `team_whatsapp.pendency_reopen`; o tipo `PendencyAuditAction` (CK6) já inclui `team_whatsapp.pendency_handover` para o K3 (só no tipo; nenhum código deste lote o usa). `changes` = sempre os três campos `handlerId`, `situation`, `dueAt` (ISO ou null) com antes e depois, mesmo iguais; `metadata = { dispatchId, recipientId, kind?, noteId? }`. **Nunca** texto de anotação, motivo, observação, nome ou telefone (Anti-objetivo 8). A situação de antes usa o estado do responsável lido antes da trava (vale porque a trava confirmou que o responsável é o esperado); a de depois, `'active'` para o novo responsável validado. Categoria nula: não aparece em `/trilha`, como as outras `team_whatsapp.*` (mapa back §5).
- **DK17. Ciência manual (K2-7, aceite 21).** Em `team-alert-ack.service.ts`, `requireAlertRecipient` troca **só** o passo 404: hoje `requireViewable` (só ADMIN ou autor); passa a ser `requireAckVisible(prisma, repo, actor, dispatchId, recipientId)` (arquivo novo `team-pendency-ack-access.ts`): vê se `canViewDispatch(actor, envio)` **ou** `scopeAllows(pendencyScopeOf(actor), findPendencyScopeFacts(recipientId))` com o destinatário pertencendo ao envio; senão o **mesmo** 404 de hoje (`dispatchNotFound()`). A ordem 403 remetente → 403 `equipe.urgencia` → 404 → 404 destinatário → 422 `not_an_alert` → 422 `ack_exists`/`ack_not_manual` não muda. Como o alcance exige `isAlert`, um gestor de setor não recebe 422 `not_an_alert` de envio que não vê (não vaza existência). `canViewDispatch` não muda.
- **DK18. Painel do alerta (K2-2, aceite 20).** `getPanel` acrescenta a cada pessoa `closure: { at, byName, reason } | null` (nome do usuário por `nameView`; usuário removido → `byName: null`), lido por uma função nova `loadAlertClosures(db, alertId)` em `team-alert-closure.ts`, sem editar `team-alert.repository.ts` nem `alertGroupOf`. O grupo não muda. Quem vê o painel continua sendo quem vê o envio.
- **DK19. Front — tela** (rota `/pendencias-equipe`, arquivo `routes/_authenticated/pendencias-equipe.tsx`; textos exatos):
  - título "Pendências da equipe"; situação: `UNASSIGNED` "Sem responsável", `IN_PROGRESS` "Em tratativa", `OVERDUE` "Em tratativa — atrasada", `ACKED` "Ciente", `CLOSED` "Encerrada sem ciência"; grupo com os rótulos do painel (`ALERT_GROUPS`);
  - filtros em estado local (sem URL, como a caixa no K1): "Situação" (cinco caixas; padrão as três abertas), "Setor" ("Todos os setores" + `sectors` da resposta), "Minhas"; "Período" (só aparece com "Ciente" ou "Encerrada sem ciência" marcadas): "Últimos 7 dias" (padrão) / "Últimos 30 dias"; trocar filtro volta à página 1; paginação "Anterior"/"Próxima";
  - linha: "{pessoa} · {setor} · {turno}" (setor ou turno ausente → "—"); telefone completo, ou mascarado, ou "Sem telefone"; "Alerta de {autor} em {dd/MM HH:mm}: {texto}" (autor nulo → "Usuário removido"); "Prazo de ciência: {dd/MM HH:mm}"; "Responsável: {nome}" com " (inativo)" ou " (fora do alcance)" pelo `state`, ou "Responsável: ninguém"; "Prazo da tratativa: {dd/MM HH:mm}" quando houver; com `closure`, "Tratativa encerrada por {nome}: {motivo}"; em "Respondeu, sem ciência", "Última resposta: {texto}" ou "Última resposta: Áudio" / "Imagem" / "Arquivo" (texto nulo sem mídia → "(Mensagem sem texto)"); anotações "{dd/MM HH:mm} · {autor} · {prefixo}{texto}", prefixos `CONTACT` "Contato: ", `ASSUME` "Ao assumir: ", `CLOSE` "Encerramento: ", `HANDOVER` "Passagem de turno: "; hora de Manaus;
  - "Abrir conversa" (link `/inbox/$conversationId`) só com `conversationId` e papel ADMIN/OPERATOR; "Ver resultado do alerta" (link `/whatsapp-equipe/$dispatchId`) só com `canViewDispatch`;
  - estados: carregando "Carregando pendências…"; erro "Não foi possível carregar as pendências" com "Tentar de novo"; vazio "Nenhuma pendência com estes filtros."; `null` (403 `team_whatsapp.forbidden`) "Esta tela é para quem envia mensagens à equipe."; `truncated` "A lista passou de 2.000 pendências; use os filtros para ver as demais.";
  - VIEWER não consulta (consulta desligada pelo papel); a lista recarrega ao abrir a tela (`refetchOnMount: 'always'`, `staleTime: 0`), sem polling nem refetch por foco.
- **DK20. Front — ações** (`pendencyActions(item, me)`, puro; `me = { id, role, canWrite: equipe.enviar, canUrgency: equipe.urgencia }`; sem `canWrite`, nenhuma ação de tratativa):
  - aberta e `UNASSIGNED` → "Assumir" (um clique; `expectedHandlerId` = responsável mostrado, inclusive o inativo/fora do alcance); ADMIN também "Transferir" e "Encerrar sem ciência";
  - aberta, responsável ativo = eu → "Transferir", "Registrar contato", "Encerrar sem ciência";
  - aberta, responsável ativo ≠ eu → "Assumir de outro" (diálogo com "Observação (opcional)"); ADMIN também "Transferir", "Registrar contato", "Encerrar sem ciência";
  - `CLOSED`, responsável = eu ou ADMIN → "Reabrir a tratativa";
  - ciência (com `canWrite` e `canUrgency`): sem `ack` → "Registrar ciência manual" (o `ManualAckDialog` do painel, observação obrigatória); `ack.kind === 'MANUAL'` → "Desfazer ciência manual"; automática, nada;
  - diálogos: "Assumir pendência de {nome}" (observação opcional, até 200); "Transferir" (menu com `GET pendencies/:id/handlers`, sem o responsável atual; escolher abre "Transferir para {nome}?" com "Cancelar"/"Confirmar"); "Registrar contato" (campo obrigatório "O que foi feito e por qual meio", até 200); "Encerrar sem ciência" (campo obrigatório "Motivo", até 200); "Reabrir a tratativa?" (confirmação). Botões "Cancelar" e "Confirmar"; "Confirmar" desligado com campo obrigatório vazio e durante o envio (`useIsMutating` pela `mutationKey`);
  - toasts de sucesso: "Pendência assumida", "Pendência transferida", "Contato registrado", "Pendência encerrada", "Tratativa reaberta";
  - erros por `code` (`readApiErrorBody`): `team_whatsapp.pendency_taken` → "{nome} assumiu esta pendência antes de você." (sem nome no `detail`: "Outra pessoa assumiu esta pendência antes de você."); `team_whatsapp.pendency_changed` → "A pendência mudou enquanto você olhava. A lista foi recarregada; confira e tente de novo."; `team_whatsapp.not_handler` → "Só o responsável pela pendência ou um administrador pode fazer isso."; `team_whatsapp.ack_exists` → "A pessoa já deu ciência; não é preciso encerrar."; `user.not_found` → "Esta pessoa não pode receber a pendência. Escolha outra."; `team_whatsapp.pendency_not_found` → "Pendência não encontrada."; outro → "Não foi possível concluir a ação. Tente de novo." Em 403, 404, 409 e 422, a lista e o contador são invalidados.
  - erros da ciência manual pela tela (`team_whatsapp.ack_exists`, `team_whatsapp.ack_not_manual`, 404 do envio): o mesmo texto do painel, por `alertActionErrorText` (`features/team-whatsapp/alert-actions-api.ts:80`, importado sem editar o arquivo); o texto de `ack_exists` acima ("não é preciso encerrar") vale só para Encerrar.
- **DK21. Front — menu (K2-6).** Item "Pendências da equipe" (`to: '/pendencias-equipe'`, papéis `WRITE_INTERNAL_ROLES`, sem `permission`) em `lib/nav.ts`, logo depois de "WhatsApp da equipe", com marca `requiresTeamSender: true`. O `Sidebar` chama `usePendencyCount(enabled)` com `enabled` só para ADMIN/SUPERVISOR/OPERATOR; resultado `null` (403 `team_whatsapp.forbidden`, padrão `fetchPanorama`, `features/team-panorama/api.ts:19-36`) ou ainda carregando → o item não aparece, sem erro; número → item com o badge (`badges['/pendencias-equipe']`, componente `UnreadBadge` de hoje; zero não mostra número, como hoje). Contagem ao abrir o sistema e ao abrir a tela: `staleTime: Infinity`, sem refetch por foco, reconexão ou intervalo; a tela invalida a chave ao montar e depois de cada ação.
  - **Limite conhecido (aceito):** a paleta de comandos e `canAccessPath` (`lib/nav.ts:158-163`) não conhecem `requiresTeamSender` e mostram/permitem `/pendencias-equipe` ao SUPERVISOR/OPERATOR não remetente. Quem abrir recebe o 403 `team_whatsapp.forbidden`, o hook devolve `null` e a tela mostra "Esta tela é para quem envia mensagens à equipe.", sem dado. `canAccessPath` e a paleta não mudam neste lote.
- **DK22. Novidades (C2).** Entrada no topo de `RELEASE_NOTES`: `version: '2026.11.21.3'`, `date: '2026-11-21'`, `title: 'Pendências da equipe'`, itens (texto final do implementador, curto, tom das vizinhas, sem nome ou telefone): a tela nova com responsável, prazo de 60 minutos, anotações e encerramento (`where: '/pendencias-equipe'`); o número no menu das pendências sem responsável com o prazo de ciência vencido (`where: '/pendencias-equipe'`); no resultado do alerta, a pessoa cuja tratativa foi encerrada mostra quem encerrou e o motivo, sem mudar de grupo (sem `where`).
- **DK23. Corridas (GK11).** Molde B do K1 com trava externa na linha do destinatário. Fixtures em `backend/src/modules/team-whatsapp/team-pendency.test-fixtures.ts` (T1), que **importam** de `../chat/conversation-ownership.test-fixtures` `startOwnershipDb`, `stopOwnershipDb`, `withConnectionLimit`, `waitForAnyLockWait`, `T0`, `at` e o tipo `ExternalLock` (sem copiar), e acrescentam `holdRecipientLock(db, recipientId)` (segundo `PrismaClient` dedicado, `connection_limit=2`, `SELECT id FROM "TeamWhatsappRecipient" WHERE id = … FOR NO KEY UPDATE`, como `holdConversationLock`) e as sementes `newSector`, `newTeamUser`, `newAlert`, `newPendency`. A ciência automática da corrida é a função real `recordAlertReply` (`tracking/team-alert-reply.ts:44`, `db: Pick<PrismaService, 'teamWhatsappRecipient'>`), que grava por `updateMany … ackAt: null`. **Atenção:** ela faz três `UPDATE` separados, sem transação (`:32-67`); só o primeiro (`lastReplyMessageId`) entra na fila da trava, e a ação que espera pega a linha entre o primeiro e o terceiro comando, lendo `ackAt` nulo.
  - **Ordem "ciência antes da ação" (testes):** a ciência entra atômica: `db.prisma.$transaction((tx) => recordAlertReply(tx, …))` (o `tx` satisfaz o `Pick`), que segura a linha do primeiro `UPDATE` ao commit; assim a ação lê `ackAt` gravado (Assumir → 409 `pendency_changed`; Encerrar → 422 `ack_exists`). Alternativa equivalente: a trava externa grava `ackAt` na própria conexão antes de soltar. Nenhuma das duas muda `tracking/*` (GK1).
  - **Em produção** a ciência roda sem transação; com ela na fila antes da ação, o resultado legítimo é "responsável gravado (ou encerrada) e depois Ciente" — as duas gravações ficam, nenhuma se perde, e a situação final é `ACKED` (K2-2: "A ciência vale mesmo se chegar depois do encerramento"). Os testes da ordem "ação antes da ciência" usam `recordAlertReply` sem transação, como em produção. Nenhum teste nem implementação "corrige" `tracking/*` para forçar o 409/422.
- **DK24. Interface pronta para o K3 (sem implementar K3).** O K3 vai usar, sem mudar assinatura: `pendencyScopeOf`, `scopeAllows`, `pendencyScopeWhere`, `findPendencyScopeFacts`, `canHandlePendency`, `handlerStateOf`/`handlerStatesFor`, `pendencySituation` (topo da conversa, K3-6, e "Passar minhas pendências", K3-4), `runPendencyTransition` com `PendencyConflict` (vira motivo de pulo: `acked` "já ciente", `closed` "já encerrada", `handler_changed` "já com outro responsável"; "fora do alcance do destino" é `canHandlePendency` antes da trava), `pendencyDueAt` e o tipo de anotação `HANDOVER`. Nenhuma rota, tela ou texto do K3 entra neste lote.

## Global Constraints

- **GK1. Escopo.** Back: `backend/prisma/schema.prisma` (só CK1), a migração nova, `backend/src/schemas/contracts/team-pendency.schema.ts` (novo), `backend/src/schemas/contracts/team-whatsapp.schema.ts` (só `closure` do painel, T9), `backend/src/modules/team-whatsapp/` (arquivos novos; `team-alert-ack.service.ts` só o passo 404, T4; `team-alert-panel.service.ts` só `closure`, T9; `team-whatsapp.module.ts` só registro), `backend/src/modules/permissions/route-parity.spec.ts` (só a linha nova). Front: `frontend/src/features/team-pendencies/` (novo), `routes/_authenticated/pendencias-equipe.tsx`, `routeTree.gen.ts` (gerado), `lib/nav.ts`, `components/layout/sidebar.tsx`, `features/team-whatsapp/{alert-schemas.ts,alert-labels.ts,components/alert-panel.tsx}` (só `closure`, T15), `release-notes.ts`. **Não mudam:** `canViewDispatch`, `isTeamSender`, `team-actor.query.ts`, `team-alert.repository.ts`, `team-alert.rules.ts`, `tracking/*`, `team-alert-manual-ack.ts`, `roles.guard.ts`, catálogo de permissões (back e front), `features/chat/`, `features/audit-trail/labels.ts`, `features/team-whatsapp/alert-actions-api.ts`.
- **GK2. Restrições da spec:** "Migrações aditivas, com `lock_timeout`, sem mudar linha existente." "Nenhuma chave de permissão nova: (…) pendências com `equipe.enviar` e `equipe.urgencia`." "`canViewDispatch` não muda." "Testes nunca mandam WhatsApp real." Não objetivos: "Atribuição, aviso ou escalonamento automático de pendências"; "Pendência para outras finalidades além do alerta urgente"; "Tempo real nas pendências". Anti-objetivos: "Um SUPERVISOR ver pendência de pessoa fora dos setores que gere e de alerta que não enviou, por qualquer rota." "Uma tela de pendências mostrar outra mensagem da conversa além da última resposta ligada ao alerta." "Encerrar uma pendência criar ciência, ou tirar a pessoa do grupo em que está no painel do alerta." "O sistema mandar mensagem a alguém por conta de pendência, prazo ou passagem de turno." "Texto de resposta, anotação, motivo, observação, nome ou telefone de pessoas da equipe em log. A trilha guarda ids e situações, não textos."
- **GK3. Gravação condicional** (Vocabulário): "uma escrita que só acontece se o estado ainda for o que a tela mostrava, num único comando atômico; se não bater, nada é gravado e a resposta é 409." Implementação única: DK10 (trava + conferência + escrita + anotação + trilha numa transação). Nenhuma escrita das colunas `pendency*` nem de `TeamPendencyNote` fora de `runPendencyTransition`. As gravações de ciência de hoje (`recordAlertReply`, `markManualAck`, `undoManualAck`) não mudam e não olham a pendência ("A ciência vale mesmo se chegar depois do encerramento").
- **GK4. Papéis e chaves:** "Quem não é remetente não vê nenhuma pendência" (`isTeamSender`); leitura com `@Roles('ADMIN','SUPERVISOR','OPERATOR')`; escrita com `@RequirePermission('equipe.enviar')`; ciência manual nas rotas do Lote I com `equipe.urgencia` (serviço). "Pendência fora do alcance responde 404 em qualquer rota." Ordem DK9. Ator sempre relido do banco (`findTeamActor`: papel, `isActive`, `hasAccess`, setores ativos geridos e permissões efetivas, sem cache).
- **GK5. Códigos:** 403 `team_whatsapp.forbidden` (não remetente); 403 do guard (sem `equipe.enviar`); 403 `team_whatsapp.not_handler`; 404 `team_whatsapp.pendency_not_found`; 404 `user.not_found` (destino); 409 `team_whatsapp.pendency_taken` e `team_whatsapp.pendency_changed` (`detail` DK15); 422 `team_whatsapp.ack_exists`; 400 de validação (`expectedHandlerId` ausente, texto vazio ou > 200, `days` fora de 7/30, situação desconhecida). Erros como `DomainError` com `code` (`shared/errors/domain.error.ts`; `detail` é `string`).
- **GK6. Validação:** cwd `backend/` ou `frontend/`. Loop: `cd backend && TESTCONTAINERS_ENABLED=1 timeout 600 gate --test src/<arquivo>` (integração) ou `cd backend && timeout 600 gate --test src/<arquivo>`; `cd frontend && timeout 600 gate --test src/<arquivo>`. Tipos: back `npx tsc --noEmit -p tsconfig.build.json --tsBuildInfoFile /tmp/<task>.tsbuildinfo` e, para specs, `npx tsc --noEmit -p tsconfig.json`; front `npx tsc -b`. Fechamento: `cd backend && TESTCONTAINERS_ENABLED=1 timeout 600 gate --changed --base feat/caixa-situacao`; `cd frontend && timeout 600 gate --changed --base feat/caixa-situacao`. Nunca suíte inteira, gate completo, coverage ou e2e (são da principal). No máximo dois testcontainers ao mesmo tempo (a principal serializa). Se 600 s não bastarem, devolver ao controlador.
- **GK7. Compila entre tasks:** assinatura existente só ganha campo ou parâmetro opcional, salvo onde a task diz. Contrato: campos obrigatórios no back (quem cria preenche), tolerantes no front (`.nullish()`). A principal roda o `tsc` do back e do front depois de cada onda. Sem commit.
- **GK8. Tempo e dados nos testes:** fixtures gravam `createdAt`/`ackAt`/`pendencyDueAt` explícitos a partir de `T0`/`at(minutos)`; serviços recebem `now` como parâmetro (o controller passa `new Date()`, como `markManual` recebe `input.now`); nada de `vi.setSystemTime` com linha gravada pelo banco (memória "relógio falso × createdAt"). Nomes e telefones fictícios ("Pessoa A", `+5592991110001`, "Gestor S1"). Provedor de WhatsApp sempre falso; nenhuma task envia mensagem.
- **GK9. Tamanho e legado:** funções e callbacks de `describe`/`it` até 50 linhas, ciclomática 10, cognitiva 15, profundidade 4, até 4 parâmetros (agrupar em objeto); `describe` novos em arquivo novo (o que existe não cresce); conferir com `npx eslint <arquivos> --rule '{"max-lines-per-function": ["error", 50], "max-params": ["error", 4], "complexity": ["error", 10], "max-depth": ["error", 4]}'`. `prettier --write` só em arquivo novo; nunca em legado; nunca restaurar arquivo do git. **Legados** (só recebem as trocas que a task diz; lógica nova em arquivo novo): `schema.prisma`, `team-whatsapp.schema.ts`, `team-whatsapp.module.ts`, `team-alert-ack.service.ts`, `team-alert-panel.service.ts`, `route-parity.spec.ts`; front `lib/nav.ts`, `components/layout/sidebar.tsx`, `features/team-whatsapp/{alert-schemas.ts,alert-labels.ts,components/alert-panel.tsx}`, `release-notes.ts`, `routeTree.gen.ts` (gerado; nunca formatar).
- **GK10. Front:** corpo de erro HTTP só por `readApiErrorBody` (`lib/api-error.ts`, assíncrona; ky 2 consome o corpo, o `code` está em `HTTPError.data`; memória "ky 2 consome corpo do erro"), lido no `queryFn`/`onError`, nunca na renderização. Textos exatamente como DK19–DK22. Filtros em estado local (sem `validateSearch`).
- **GK11. Concorrência:** prova por intercalação determinística contra o Postgres do testcontainer (Molde B do K1, DK23), nunca com mock do repositório nem `Promise.all` solto: (1) trava externa na linha do destinatário; (2) comando 1 sem `await`, poll até 1 sessão bloqueada; (3) comando 2 sem `await`, poll até 2; (4) solta; (5) `await` dos dois. Poll de `pg_stat_activity` (`wait_event_type = 'Lock'`) a cada 50 ms, limite 5 000 ms; `it` com timeout 30 000 ms; código sob teste com `connection_limit=5` (`withConnectionLimit`); transações do código com `PENDENCY_TX_OPTIONS`. Cada teste de corrida diz num comentário qual implementação errada ele pega. Isolamento padrão (READ COMMITTED).
- **GK12. Migração:** aditiva, `SET LOCAL lock_timeout = '15s';`, sem comando `UPDATE`/`DELETE FROM`/`DROP`/`INSERT`/backfill (o teste olha comandos por linha sem comentário, não o `ON DELETE CASCADE ON UPDATE CASCADE` da FK), sem índice novo em tabela existente, DDL igual ao do `prisma migrate diff` para CK1 menos `DROP` de deriva. Testes de integração aplicam todas as migrações pelo `startOwnershipDb` do K1.
- **GK13. Nada de texto em log nem trilha:** nenhum `logger.*` novo recebe anotação, motivo, observação, texto de resposta, nome ou telefone; o filtro de erro não loga `detail` (conferido no K1, `domain-exception.filter.ts:113`); `AuditEvent` das pendências só com ids, situações e datas (DK16).

## Contratos compartilhados

**CK1. Prisma** (T1; DK1, DK2).

```prisma
model TeamWhatsappRecipient { /* … campos atuais … */
  // Pendência do alerta (Lote K2, K2-3); tudo nulo = sem responsável e aberta.
  pendencyHandlerId   String?             // responsável; sem FK (sobrevive à exclusão, como ackByUserId)
  pendencyAssignedAt  DateTime?           // última vez que foi assumida ou transferida
  pendencyDueAt       DateTime?           // prazo da tratativa = assumida + 60 min (K2-8)
  pendencyClosedAt    DateTime?
  pendencyClosedById  String?             // sem FK
  pendencyCloseReason String?             @db.VarChar(200)
  pendencyNotes       TeamPendencyNote[]
}
enum TeamPendencyNoteKind { CONTACT ASSUME CLOSE HANDOVER }
model TeamPendencyNote {
  id          String                @id @default(cuid())
  recipientId String
  recipient   TeamWhatsappRecipient @relation(fields: [recipientId], references: [id], onDelete: Cascade)
  kind        TeamPendencyNoteKind
  authorId    String                // sem FK
  text        String                @db.VarChar(200)
  createdAt   DateTime              @default(now())
  @@index([recipientId, createdAt])
}
```

**CK2. Contrato da API** (T2; `backend/src/schemas/contracts/team-pendency.schema.ts`, arquivo novo; o front espelha na T11).

```ts
export const PENDENCY_SITUATIONS = ['UNASSIGNED', 'IN_PROGRESS', 'OVERDUE', 'ACKED', 'CLOSED'] as const;
export type PendencySituation = (typeof PENDENCY_SITUATIONS)[number];
export const OPEN_PENDENCY_SITUATIONS: readonly PendencySituation[] = ['UNASSIGNED', 'IN_PROGRESS', 'OVERDUE'];
export type HandlerState = 'active' | 'inactive' | 'out_of_scope';
export const pendencyListQuerySchema = z.object({
  situations: /* lista por vírgula de PENDENCY_SITUATIONS, sem repetição; ausente → OPEN_PENDENCY_SITUATIONS; valor desconhecido → 400 */,
  sectorId: z.string().min(1).optional(),
  mine: z.enum(['true', 'false']).optional(),                 // 'true' = Minhas
  days: z.coerce.number().pipe(z.union([z.literal(7), z.literal(30)])).default(7),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
});
const optionalNote = z.string().trim().max(200).optional();   // vazia depois do trim → sem anotação
const requiredText = z.string().trim().min(1).max(200);
export const assumePendencySchema = z.object({ expectedHandlerId: z.string().nullable(), note: optionalNote });
export const transferPendencySchema = z.object({ toUserId: z.string().min(1), expectedHandlerId: z.string().nullable() });
export const pendencyNoteSchema = z.object({ expectedHandlerId: z.string().nullable(), text: requiredText });
export const closePendencySchema = z.object({ expectedHandlerId: z.string().nullable(), reason: requiredText });
export const reopenPendencySchema = z.object({ expectedHandlerId: z.string().nullable() });
// expectedHandlerId sem .optional(): ausente → 400
export type PendencyNoteKind = 'CONTACT' | 'ASSUME' | 'CLOSE' | 'HANDOVER';
export type TeamPendencyItem = {
  id: string; dispatchId: string;                                        // id = recipientId
  person: { name: string; sectorId: string | null; sectorName: string | null; shiftName: string | null;
            phoneE164: string | null; hasPhone: boolean; phoneMasked: string | null };
  alert: { text: string; authorName: string | null; sentAt: string; ackDeadlineAt: string };
  group: 'no_delivery' | 'no_reply' | 'replied' | 'acked';              // os mesmos valores de alertGroupOf
  situation: PendencySituation;
  handler: { id: string; name: string | null; state: HandlerState } | null;
  assignedAt: string | null; dueAt: string | null;
  closure: { byId: string | null; byName: string | null; at: string; reason: string } | null;
  ack: { kind: 'KEYWORD' | 'MANUAL'; at: string } | null;
  lastReply: { text: string | null; media: 'audio' | 'image' | 'file' | null; at: string } | null; // só em 'replied'
  notes: { id: string; kind: PendencyNoteKind; authorName: string | null; at: string; text: string }[];
  conversationId: string | null;                                         // só ADMIN/OPERATOR e com mensagem do envio
  canViewDispatch: boolean;
};
export type TeamPendencyList = { items: TeamPendencyItem[]; total: number; page: number; pageSize: number;
  sectors: { id: string; name: string }[]; truncated: boolean };
export type TeamPendencyCount = { unassignedOverdue: number };
export type PendencyHandlersResponse = { items: { id: string; name: string }[] };
export type AssumePendencyInput = z.infer<typeof assumePendencySchema>; // idem Transfer, Note, Close, Reopen
// DTOs (createZodDto, padrão de dto/manual-ack.dto.ts): dto/pendency-list-query.dto.ts, dto/assume-pendency.dto.ts,
// dto/transfer-pendency.dto.ts, dto/pendency-note.dto.ts, dto/close-pendency.dto.ts, dto/reopen-pendency.dto.ts
```

(O valor exato dos grupos é o de `alertGroupOf`, `team-alert.rules.ts:92-101`; se diferir dos quatro acima, a T2 copia os de lá e registra.)

**CK3. Erros** (T2; `backend/src/modules/team-whatsapp/team-pendency.errors.ts`; DK15).

```ts
export type HandlerRef = { id: string; name: string };
export function handlerDetail(ref: HandlerRef | null): string;          // JSON.stringify({ handler: ref })
export function pendencyNotFound(): DomainError;                        // 404 'team_whatsapp.pendency_not_found', 'Pendência não encontrada.'
export function notHandler(): DomainError;                              // 403 'team_whatsapp.not_handler', 'Só o responsável ou um administrador pode fazer isso.'
export function pendencyTaken(current: HandlerRef): DomainError;        // 409 'team_whatsapp.pendency_taken', detail
export function pendencyChanged(current: HandlerRef | null): DomainError; // 409 'team_whatsapp.pendency_changed', detail
```

**CK4. Regras puras** (T2; `backend/src/modules/team-whatsapp/team-pendency.rules.ts`; DK3–DK6, DK10).

```ts
export const PENDENCY_HANDLING_MINUTES = 60;
export const PENDENCY_LIST_MAX_ROWS = 2000;
export function pendencyDueAt(now: Date): Date;
export type PendencyScope = { kind: 'none' } | { kind: 'all' } | { kind: 'limited'; actorId: string; sectorIds: readonly string[] };
export function pendencyScopeOf(actor: TeamActor | null): PendencyScope;
export type PendencyScopeFacts = { isAlert: boolean; authorId: string | null; sectorId: string | null; personSectorId: string | null };
export function effectiveSectorId(f: PendencyScopeFacts): string | null;
export function scopeAllows(scope: PendencyScope, f: PendencyScopeFacts): boolean;
export function canHandlePendency(actor: TeamActor | null, f: PendencyScopeFacts): boolean;
export function handlerStateOf(handler: TeamActor | null, f: PendencyScopeFacts): HandlerState;
export type PendencyStateFacts = { ackAt: Date | null; closedAt: Date | null; handlerId: string | null; handlerState: HandlerState | null; dueAt: Date | null };
export function pendencySituation(f: PendencyStateFacts, now: Date): PendencySituation;
export type SortablePendency = { id: string; situation: PendencySituation; alertCreatedAt: Date; ackDeadlineAt: Date };
export function isUnassignedOverdue(p: SortablePendency, now: Date): boolean;
export function comparePendencies(a: SortablePendency, b: SortablePendency, now: Date): number;
export function replyMediaOf(kind: MessageKind): 'audio' | 'image' | 'file' | null;   // TEXT → null
export type LockedPendency = { id: string; dispatchId: string; ackAt: Date | null; handlerId: string | null; assignedAt: Date | null;
  dueAt: Date | null; closedAt: Date | null; closedById: string | null; closeReason: string | null };
export type PendencyExpectation = { handlerId: string | null; closed: boolean | 'any'; ignoreAck?: boolean };
//   closed 'any' = não olha encerramento; ignoreAck = não olha ciência. Só Registrar contato usa os dois (DK10.3, DK13).
export type PendencyConflict = 'missing' | 'acked' | 'closed' | 'not_closed' | 'handler_changed';
export function pendencyConflict(locked: LockedPendency, expect: PendencyExpectation): Exclude<PendencyConflict, 'missing'> | null; // ordem DK10.3
export type AssumeKind = 'assume' | 'take_over' | 'noop';
export function assumeKind(actorId: string, expectedHandlerId: string | null, expectedState: HandlerState | null): AssumeKind; // DK11
export function requiresHandler(actor: { id: string; role: string }, expectedHandlerId: string | null): boolean; // true → 403 not_handler (DK12–DK14)
```

**CK5. Alcance no banco** (T3; `team-pendency-scope.repository.ts` e `team-actors.query.ts`).

```ts
export type PendencyDb = Pick<Prisma.TransactionClient, 'teamWhatsappRecipient' | 'teamWhatsappDispatch' | 'user'>;
export function pendencyScopeWhere(scope: PendencyScope): Prisma.TeamWhatsappRecipientWhereInput | null; // null = nenhum (DK3)
export async function findPendencyScopeFacts(db: PendencyDb, recipientId: string): Promise<(PendencyScopeFacts & { dispatchId: string }) | null>;
export async function requireVisiblePendency(prisma: PrismaService, actorId: string, recipientId: string):
  Promise<{ actor: TeamActor; facts: PendencyScopeFacts & { dispatchId: string } }>; // 403 teamForbidden → 404 pendencyNotFound
// team-actors.query.ts
export async function findTeamActors(prisma: PrismaService, ids: readonly string[]): Promise<Map<string, TeamActor & { name: string }>>;
//   mesmo formato de findTeamActor (team-actor.query.ts:10-31); permissões por findEffectivePermissions, uma vez por papel
export async function listHandlerCandidates(prisma: PrismaService): Promise<Array<TeamActor & { name: string }>>; // ADMIN/SUPERVISOR/OPERATOR ativos com acesso, ordem por nome
export async function handlerStatesFor(prisma: PrismaService, rows: ReadonlyArray<PendencyScopeFacts & { handlerId: string | null }>):
  Promise<Array<{ state: HandlerState; name: string | null } | null>>;  // null sem responsável; mesma ordem de rows
```

**CK6. Núcleo de escrita** (T6; `team-pendency-write.repository.ts`; DK10, DK16).

```ts
export const PENDENCY_TX_OPTIONS = { timeout: 10_000, maxWait: 5_000 } as const;
export async function lockPendency(tx: Prisma.TransactionClient, id: string): Promise<LockedPendency | null>;
export type PendencyAuditAction = 'team_whatsapp.pendency_assume' | 'team_whatsapp.pendency_transfer'
  | 'team_whatsapp.pendency_note' | 'team_whatsapp.pendency_close' | 'team_whatsapp.pendency_reopen'
  | 'team_whatsapp.pendency_handover';                        // só o tipo, para o K3 (DK16, DK24); sem uso neste lote
export type PendencyPatch = Partial<Pick<LockedPendency, 'handlerId' | 'assignedAt' | 'dueAt' | 'closedAt' | 'closedById' | 'closeReason'>>;
export type PendencyTransition = {
  recipientId: string; actorId: string; now: Date;
  action: PendencyAuditAction; kind?: string;                 // metadata.kind
  expect: PendencyExpectation;
  patch: PendencyPatch | null;                                // null = colunas iguais (só anotação; com note null, só conferência, DK10.4)
  note: { kind: PendencyNoteKind; text: string } | null;
  handlerState: { before: HandlerState | null; after: HandlerState | null }; // para a situação da trilha
};
export type PendencySnapshot = { handlerId: string | null; situation: PendencySituation; dueAt: string | null };
export type PendencyOutcome =
  | { ok: true; before: PendencySnapshot; after: PendencySnapshot; noteId: string | null }
  | { ok: false; conflict: PendencyConflict; current: LockedPendency | null };
export async function runPendencyTransition(prisma: PrismaService, audit: AuditService, t: PendencyTransition): Promise<PendencyOutcome>;
```

**CK7. Serviços e controller** (T5a cria a leitura de lista e item, o controller e o registro; T5b acrescenta contador e destinos; T7 cria o serviço de ações com `assume`; T8a acrescenta `transfer` e `addNote`; T8b, `close` e `reopen`).

```ts
@Injectable() export class TeamPendencyService {           // team-pendency.service.ts (T5a; T5b acrescenta count e handlers)
  constructor(prisma: PrismaService);
  list(actorId: string, query: PendencyListQuery, now: Date): Promise<TeamPendencyList>;  // T5a; teto da lista, mais novas primeiro (DK7)
  get(actorId: string, id: string, now: Date): Promise<TeamPendencyItem>;     // T5a; 404 fora do alcance
  count(actorId: string, now: Date, batchSize?: number): Promise<TeamPendencyCount>; // T5b; sem teto nem truncated, lotes por cursor (DK7); batchSize opcional (padrão PENDENCY_LIST_MAX_ROWS) para o teste "contador acima do teto" (revisão 2 M1)
  handlers(actorId: string, id: string): Promise<PendencyHandlersResponse>;   // T5b; canHandlePendency, sem o próprio filtro de "responsável atual"
}
@Injectable() export class TeamPendencyActionsService {    // team-pendency-actions.service.ts
  constructor(prisma: PrismaService, audit: AuditService);
  assume(actorId: string, id: string, input: AssumePendencyInput, now: Date): Promise<void>;     // T7
  transfer(actorId: string, id: string, input: TransferPendencyInput, now: Date): Promise<void>; // T8a
  addNote(actorId: string, id: string, input: PendencyNoteInput, now: Date): Promise<void>;      // T8a
  close(actorId: string, id: string, input: ClosePendencyInput, now: Date): Promise<void>;       // T8b
  reopen(actorId: string, id: string, input: ReopenPendencyInput, now: Date): Promise<void>;     // T8b
}
// team-pendency.controller.ts — @Controller('internal/team-whatsapp'), rotas DK9
// team-pendency.query.ts (T5a; T5b acrescenta a leitura em lotes do contador): leituras da lista e dos detalhes da página (DK7, DK8);
//   o teto é parâmetro opcional (padrão PENDENCY_LIST_MAX_ROWS) para os testes "acima do teto"
// team-pendency.view.ts (T5a): monta o item
// team-pendency-ack-access.ts (T4)
export async function requireAckVisible(deps: { prisma: PrismaService; repo: TeamWhatsappRepository }, actor: TeamActor,
  ref: { dispatchId: string; recipientId: string }): Promise<void>; // DK17: 404 dispatchNotFound() se não vê por nenhuma das duas
// team-alert-closure.ts (T9)
export async function loadAlertClosures(db: AlertDb, alertId: string): Promise<Map<string, { at: Date; byId: string | null; reason: string }>>;
```

**CK8. Front — contrato, hooks e funções puras** (T11; `frontend/src/features/team-pendencies/`).

```ts
// schemas.ts (tolerante: campos novos .nullish(); listas com .default([]))
export const pendencySituationSchema = z.enum(['UNASSIGNED', 'IN_PROGRESS', 'OVERDUE', 'ACKED', 'CLOSED']);
export const teamPendencyItemSchema; export const teamPendencyListSchema; export const teamPendencyCountSchema;
export const pendencyHandlersSchema;   // { items: { id, name }[] }
export type TeamPendencyItem = z.infer<typeof teamPendencyItemSchema>;
// api.ts
export const PENDENCIES_KEY = ['team-pendencies'] as const;
export type PendencyFilters = { situations: PendencySituation[]; sectorId: string | null; mine: boolean; days: 7 | 30; page: number };
export const DEFAULT_PENDENCY_FILTERS: PendencyFilters;   // as três abertas, sem setor, mine false, 7, página 1
export function usePendencyList(filters: PendencyFilters, enabled: boolean);   // [...KEY,'list',filters]; null = 403 forbidden
export function usePendencyCount(enabled: boolean);                             // [...KEY,'count']; number | null; staleTime Infinity
export function usePendencyHandlers(id: string, enabled: boolean);              // [...KEY,'handlers',id]
export type PendencyActionInput =
  | { kind: 'assume'; expectedHandlerId: string | null; note?: string }
  | { kind: 'transfer'; toUserId: string; expectedHandlerId: string | null }
  | { kind: 'note'; expectedHandlerId: string | null; text: string }
  | { kind: 'close'; expectedHandlerId: string | null; reason: string }
  | { kind: 'reopen'; expectedHandlerId: string | null };
export function usePendencyAction(id: string);   // mutationKey [...KEY,'action',id]; sucesso → toast DK20 e invalida KEY;
                                                  // erro → readApiErrorBody, toast DK20, invalida KEY em 403/404/409/422
export function invalidatePendencies(qc: QueryClient): Promise<void>;
// labels.ts
export const SITUATION_LABEL: Record<PendencySituation, string>;   // DK19
export function handlerLabel(h: TeamPendencyItem['handler']): string;  // 'Responsável: …' (DK19)
export function replyLabel(r: NonNullable<TeamPendencyItem['lastReply']>): string; // texto | 'Áudio' | 'Imagem' | 'Arquivo' | '(Mensagem sem texto)'
export function noteLine(n: TeamPendencyItem['notes'][number]): string;
export function closureLine(c: NonNullable<TeamPendencyItem['closure']>): string; // 'Tratativa encerrada por {nome}: {motivo}'
export function manausTime(iso: string): string;                     // 'dd/MM HH:mm'
// pendency-errors.ts
export function pendencyErrorText(code: string | undefined, detail: string | undefined): string; // DK20
export function parseHandlerDetail(detail: string | undefined): { id: string; name: string } | null; // tolerante
// pendency-actions.ts
export type PendencyMe = { id: string; role: string; canWrite: boolean; canUrgency: boolean };
export function pendencyActions(item: TeamPendencyItem, me: PendencyMe): { assume: boolean; takeOver: boolean; transfer: boolean;
  note: boolean; close: boolean; reopen: boolean; manualAck: boolean; undoManualAck: boolean };   // DK20
```

**CK9. Painel do alerta** (back T9, front T15): cada pessoa de `teamAlertPanelSchema` ganha `closure: { at: string; byName: string | null; reason: string } | null` (obrigatório no back, `.nullish()` no front).

**CK10. Novidades** (T16): DK22.

## Review Focus

1. **Alcance (T2, T3, T5a, T5b, T10):** `SUPERVISOR vê pessoa do setor que gere em alerta de outro autor e os próprios alertas; não vê o resto`; `envio nominal usa o setor principal atual`; `pendencyScopeWhere e scopeAllows concordam em toda a massa`; `404 fora do alcance em toda rota, inclusive ciência manual e desfazer`; contador não conta o que está fora.
2. **Nada gravado na recusa e condição atômica (T6, T7, T8a, T8b):** `409/422/403 — colunas iguais, nenhuma TeamPendencyNote, nenhum AuditEvent`; 403 `not_handler` decidido pelo `expectedHandlerId` e confirmado na linha travada; `updatedAt` intocado.
3. **Corridas (GK11):** `dois Assumir — um grava, o outro 409 pendency_taken com o nome`; `ciência automática × Assumir` e `ciência automática × Encerrar` nas duas ordens (`422 ack_exists` ou `Ciente` depois do encerramento); na ordem "ciência antes", a ciência do teste entra em `$transaction` (DK23) e `tracking/*` não muda.
4. **Ciência continua a única verdade (K2-2, aceite 19–20):** encerrar não cria ciência nem muda o grupo do painel; ciência depois do encerramento põe em "Ciente"; ordem 403 → 404 → 422 da ciência manual inalterada (T4).
5. **Sem texto em log nem trilha, sem outra mensagem na tela (GK13, Anti-objetivos 2 e 8):** `AuditEvent` só com ids, situações e datas; `lastReply` só no grupo "Respondeu, sem ciência" e mídia sem legenda; telefone pela chave `telefone.ver_completo`.

## Rastreio (aceite → task → teste)

| Aceite | Task | Teste |
|---|---|---|
| 12 | T2, T3, T5a, T5b, T10, T14 | T3 `aceite 12: SUPERVISOR vê as do setor que gere, inclusive em alerta de outro autor` e `aceite 12: vê as dos alertas que enviou; não vê as demais`; T5a e T5b `aceite 12: VIEWER e SUPERVISOR sem setor gerido que já enviou alerta — 403 team_whatsapp.forbidden` (lista e item; contador e destinos); T10 `aceite 12: fora do alcance — 404 em %s` (it.each) e `aceite 12: lista e contador não trazem a pendência fora do alcance`; T14 `aceite 12: 403 forbidden — item some sem erro; VIEWER não consulta` |
| 13 | T2, T3 | T2 `aceite 13: setor vazio usa personSectorId`; T3 `aceite 13: envio nominal usa o setor principal atual da pessoa (troca de setor depois do envio muda o alcance)` |
| 14 | T5a, T12 | T5a `aceite 14: linha com os campos de K2-5`; `aceite 14: Respondeu, sem ciência — só a última resposta ligada; mídia como audio/image/file sem legenda; outros grupos sem lastReply`; `aceite 14: telefone completo só com telefone.ver_completo`; T12 `aceite 14: linha mostra os campos; Última resposta: Áudio` |
| 15 | T2, T5a, T5b, T12 | T2 `aceite 15: ordem — Sem responsável vencida, atrasada, demais da mais antiga`; T5a `aceite 15: padrão sem limite de data`, `aceite 15: Ciente e Encerrada 7 dias; days=30 amplia`; T5b `aceite 15: contador só Sem responsável com prazo de ciência vencido`, `contador acima do teto — conta todas`; T12 `aceite 15: período só com Ciente ou Encerrada marcadas` |
| 16 | T7, T8a, T8b | T7 `aceite 16: assumir grava responsável e prazo de 60 min`; `aceite 16: dois Assumir simultâneos — um grava, o outro 409 pendency_taken com o nome` (Molde B); `aceite 16: responsável inativo ou fora do alcance — quem vê assume`; T8a e T8b `aceite 16: não responsável nem ADMIN — 403 not_handler em %s` |
| 17 | T7, T8a | T7 `aceite 17: assumir de outro com observação — prazo recomeça`; T8a `aceite 17: transferir — destino vira responsável, prazo recomeça`; `aceite 17: destino que não vê, sem equipe.enviar, inativo, sem acesso — 404 user.not_found` |
| 18 | T2, T5a, T8a, T8b | T8a `aceite 18: registrar contato`; T8b `aceite 18: encerrar com ciência — 422 ack_exists`, `aceite 18: reabrir`; T5a `aceite 18: responsável sem equipe.enviar ou sem setor gerido — Sem responsável, state out_of_scope` |
| 19 | T2, T7, T8b | T2 `aceite 19: prazo vencido — OVERDUE; ack depois do encerramento — ACKED`; T8b `aceite 19: Encerrar na fila antes da ciência automática — encerrada e depois Ciente` (Molde B) |
| 20 | T9, T15 | T9 `aceite 20: encerrada continua no mesmo grupo e traz closure com nome e motivo`; T15 `aceite 20: Tratativa encerrada por {nome}: {motivo}` |
| 21 | T4, T13 | T4 `aceite 21: SUPERVISOR com equipe.urgencia que vê a pendência, sem ver o envio — registra e desfaz`; `aceite 21: ordem 403 → 404 → 422 inalterada`; T13 `aceite 21: Registrar ciência manual e Desfazer ciência manual pela tela` |
| 22 | T5a, T12 | T5a `aceite 22: conversationId só para ADMIN e OPERATOR e com mensagem; canViewDispatch só ADMIN e autor`; T12 `aceite 22: Abrir conversa e Ver resultado do alerta` |
| 23 | T6, T7, T8b | T6 `aceite 23: AuditEvent com antes/depois de handlerId, situation e dueAt, sem texto`; T8b `aceite 23: nenhum AuditEvent contém texto, motivo, nome ou telefone` |
| 24 | T16 | `aceite 24: entrada K2 no topo, versão 2026.11.21.3` + `release-notes.spec.ts` verde |

## Mapa de arquivos

- Criar (back, `backend/src/modules/team-whatsapp/` salvo indicação): migração `backend/prisma/migrations/20261121120000_team_pendency/migration.sql`, `team-pendency.migration.spec.ts`, `team-pendency.migration.integration.spec.ts`, `team-pendency.test-fixtures.ts` (T1); `backend/src/schemas/contracts/team-pendency.schema.ts`, `dto/*-pendency*.dto.ts` (seis), `team-pendency.errors.ts`, `team-pendency.rules.ts` (T2); `team-pendency-scope.repository.ts`, `team-actors.query.ts` (T3); `team-pendency-ack-access.ts` (T4); `team-pendency.query.ts`, `team-pendency.view.ts`, `team-pendency.service.ts`, `team-pendency.controller.ts` (T5a); `team-pendency-write.repository.ts` (T6); `team-pendency-actions.service.ts` (T7); `team-alert-closure.ts` (T9). Specs novos em cada task.
- Modificar (back): `schema.prisma` (T1); `team-alert-ack.service.ts` (T4, só o passo 404); `team-whatsapp.module.ts` (T5a registra controller e serviço de leitura; T7 o serviço de ações); `route-parity.spec.ts` (T5a cria a linha; T5b, T7, T8a e T8b acrescentam rotas); `team-pendency.service.ts` e `team-pendency.query.ts` (T5b acrescenta contador e destinos); `team-pendency.controller.ts` (T5b, T7, T8a, T8b acrescentam handlers); `team-pendency-actions.service.ts` (T8a, T8b); `team-alert-panel.service.ts`, `team-whatsapp.schema.ts` (T9).
- Criar (front, `frontend/src/features/team-pendencies/` salvo indicação): `schemas.ts`, `api.ts`, `labels.ts`, `pendency-errors.ts`, `pendency-actions.ts` (T11); `routes/_authenticated/pendencias-equipe.tsx`, `components/pendencies-page.tsx`, `components/pendency-filters.tsx`, `components/pendency-row.tsx` (T12); `components/pendency-actions-bar.tsx`, `components/pendency-text-dialog.tsx`, `components/pendency-transfer-menu.tsx` (T13); `frontend/src/release-notes.pendencias.spec.ts` (T16). Specs novos em cada task.
- Modificar (front): `routeTree.gen.ts` (T12, gerado); `components/pendencies-page.tsx` (T13, só passar `renderActions`); `lib/nav.ts`, `components/layout/sidebar.tsx` (T14); `features/team-whatsapp/{alert-schemas.ts,alert-labels.ts,components/alert-panel.tsx}` (T15); `release-notes.ts` (T16).

## Ordem e paralelismo

```
Onda 1:  T1 (migração, fixtures) [tc]    T2 (contrato, erros, regras puras)    T11 (front: contrato, hooks, rótulos)   T15 (front: painel)   T16 (Novidades)
Onda 2:  T3 (alcance no banco) <- T1,T2 [tc]    T6 (núcleo de escrita) <- T1,T2 [tc]    T12 (front: tela) <- T11    T14 (front: menu) <- T11
Onda 3:  T4 (ciência manual) <- T3 [tc]    T5a (lista e item, controller) <- T3 [tc]    T13 (front: ações) <- T12
Onda 4:  T5b (contador e destinos) <- T5a [tc]    T9 (painel: encerramento, back) <- T1 [tc]
Onda 5:  T7 (assumir + corridas) <- T5b,T6 [tc]
Onda 6:  T8a (transferir, registrar contato) <- T7 [tc]
Onda 7:  T8b (encerrar, reabrir, corrida, trilha) <- T8a [tc]
Onda 8:  T10 (prova parametrizada do alcance) <- T4,T8b [tc]
```

- **Ownership disjunto por onda:** Onda 1 — T1: `schema.prisma`, migração, specs de migração, `team-pendency.test-fixtures.ts`; T2: `team-pendency.schema.ts`, DTOs, `team-pendency.errors.ts`, `team-pendency.rules.ts`; T11: `features/team-pendencies/{schemas,api,labels,pendency-errors,pendency-actions}.ts`; T15: `features/team-whatsapp/{alert-schemas.ts,alert-labels.ts,components/alert-panel.tsx}`; T16: `release-notes.ts` e spec novo. Onda 2 — T3: `team-pendency-scope.repository.ts`, `team-actors.query.ts`; T6: `team-pendency-write.repository.ts`; T12: rota, `routeTree.gen.ts`, `pendencies-page.tsx`, `pendency-filters.tsx`, `pendency-row.tsx`; T14: `lib/nav.ts`, `sidebar.tsx`. Onda 3 — T4: `team-alert-ack.service.ts`, `team-pendency-ack-access.ts`; T5a: `team-pendency.{query,view,service,controller}.ts`, `team-whatsapp.module.ts`, `route-parity.spec.ts`; T13: componentes de ação e a linha `renderActions` em `pendencies-page.tsx`. Onda 4 — T5b: `team-pendency.{query,service,controller}.ts`, `route-parity.spec.ts`; T9: `team-alert-closure.ts`, `team-alert-panel.service.ts`, `team-whatsapp.schema.ts`. Onda 5 — T7: `team-pendency-actions.service.ts` (novo), `team-pendency.controller.ts`, `team-whatsapp.module.ts`, `route-parity.spec.ts`. Onda 6 — T8a: `team-pendency-actions.service.ts`, `team-pendency.controller.ts`, `route-parity.spec.ts`. Onda 7 — T8b: os mesmos três. Onda 8 — T10: só spec novo.
- **Arquivos compartilhados com dono por onda:** `team-whatsapp.module.ts` T5a (Onda 3) e T7 (Onda 5); `route-parity.spec.ts` e `team-pendency.controller.ts` T5a, T5b, T7, T8a, T8b (Ondas 3 a 7, uma por onda); `team-pendency.service.ts` e `team-pendency.query.ts` T5a e T5b (Ondas 3 e 4); `team-pendency-actions.service.ts` T7, T8a, T8b (Ondas 5, 6, 7); `pendencies-page.tsx` T12 (Onda 2) e T13 (Onda 3). Nenhum é editado por duas tasks da mesma onda; por isso T5b, T7, T8a e T8b ficam em série.
- **Por que T7 espera T5b e T6:** usa o controller e o registro da T5a (com as rotas da T5b já na linha do `route-parity.spec.ts`), o núcleo da T6 e o `requireVisiblePendency` da T3. **Por que T8a espera T7 e T8b espera T8a:** mesmos service, controller e `route-parity.spec.ts`. **Por que T10 é a última:** prova todas as rotas (leitura, ações e ciência manual) juntas; se algum caso falhar, o defeito volta como correção da task dona (a T10 não corrige código de produção).
- **Front sem dependência de código do back:** T11–T15 espelham o contrato com campos tolerantes (GK7).
- **Testcontainers:** T1, T3, T4, T5a, T5b, T6, T7, T8a, T8b, T9, T10; no máximo dois por onda (Ondas 2, 3 e 4 têm dois).
- **Gate conjunto:** com tasks paralelas, o `--changed` de uma mede o diff das outras; falha só de arquivo alheio vai para o report. A principal roda o `--changed` conjunto e os `tsc` depois de cada onda.
- **Revisão** (SKILL.md do sdd, §Revisão por risco: crítico só se o delta decide autenticação/autorização, filtra/grava por tenant, dinheiro, segredo, rota pública, PII em log, migração destrutiva ou dado de produção por script): `revisor` `opus` em **T2, T3, T4, T5a, T5b, T7, T8a, T8b** (`Risco: crítico (autorização)`, cada uma com a linha `Crítico:`). As demais com `revisor` `sonnet` e "Foco da revisão" quando há risco não crítico: migração não destrutiva (T1), transação/concorrência sem decisão de acesso (T6), contrato público (T9, T11), teste de alcance (T10). Implementador sempre `sonnet` (opus só pela escalada de §Correções). Total **18 tasks** em 8 ondas: 8 críticas, 4 altas (T1, T6, T10, T11), 6 médias ou baixas (T9, T12–T16).

---

## Task 1 — Migração da pendência e fixtures de teste (back)

**Arquivos:** criar `backend/prisma/migrations/20261121120000_team_pendency/migration.sql`, `backend/src/modules/team-whatsapp/team-pendency.migration.spec.ts` (estático), `team-pendency.migration.integration.spec.ts`, `team-pendency.test-fixtures.ts` (DK23); modificar `backend/prisma/schema.prisma` (só CK1: `TeamWhatsappRecipient` ~L1911-1979 ganha as seis colunas e `pendencyNotes`; enum e modelo novos logo depois). Rodar `npx prisma generate`.

**Interfaces:** consome `TeamWhatsappRecipient` (`schema.prisma:1911-1979`) e as fixtures do K1 (`chat/conversation-ownership.test-fixtures.ts`: `startOwnershipDb`, `stopOwnershipDb`, `withConnectionLimit`, `waitForAnyLockWait`, `T0`, `at`, `ExternalLock`). Produz CK1 e as fixtures: `startPendencyDb()` (= `startOwnershipDb`), `holdRecipientLock(db, recipientId): Promise<ExternalLock>`, `newSector(db, { managerId?, isActive? })`, `newTeamUser(db, { role, sectorId?, isActive?, hasAccess?, name? })`, `newAlert(db, { authorId, createdAt, ackDeadlineMinutes = 15, purpose = 'URGENCY' })`, `newPendency(db, { dispatchId, userId?, sectorId?, sectorName?, ackAt?, handlerId?, assignedAt?, dueAt?, closedAt?, closedById?, closeReason?, messageId?, lastReplyMessageId? })`, `newPendencyNote(db, { recipientId, authorId, kind, text, createdAt })` (escrita direta só para semear testes de leitura da T5a/T9; revisão 2 M2), `grantPermission`/`revokePermission(db, role, key)` (pelo modelo que `findEffectivePermissions` lê; ver "Não verificado").

**Contexto vinculado:**
- Restrições: "Migrações aditivas, com `lock_timeout`, sem mudar linha existente: K1 (…) e K2 (pendência no destinatário e anotações). K3 não tem migração."
- K2-3: "Dados novos (migração aditiva, no destinatário ou ao lado dele): responsável, hora em que foi assumida, prazo de tratativa, encerramento (quem, quando, motivo até 200) e uma tabela de anotações (autor, hora, texto até 200)."
- K3-4 (só para o enum): "A observação vira uma anotação 'Passagem de turno: {observação}' em cada pendência transferida."
- DK1 inteiro (colunas no destinatário; nomes exatos; sem FK nos usuários; FK Cascade da anotação; nenhum índice em tabela existente; sem backfill; DDL do `migrate diff` sem `DROP` de deriva); DK2 (tipos `CONTACT`, `ASSUME`, `CLOSE`, `HANDOVER`); DK23 (fixtures importam as do K1, sem copiar; segundo `PrismaClient` dedicado com `connection_limit=2` para a trava). GK12. GK8 (datas explícitas; nomes e telefones fictícios). GK9 (`schema.prisma` é legado: só CK1).

**Passos:**
1. [ ] RED estático (`team-pendency.migration.spec.ts`, lê o SQL pelo caminho, tira comentários `--`): `it('GK12: começa por SET LOCAL lock_timeout')`; `it('GK12: sem comando UPDATE, DELETE FROM, DROP nem INSERT')` (com um caso provando que `ON DELETE CASCADE ON UPDATE CASCADE` não reprova); `it('GK12: toda linha ALTER TABLE adiciona (ADD), nunca DROP/ALTER COLUMN')`; `it('GK12: nenhum CREATE INDEX em TeamWhatsappRecipient nem TeamWhatsappDispatch')`; `it('cria o enum com CONTACT, ASSUME, CLOSE e HANDOVER')`; `it('seis ADD COLUMN pendency* nulas, sem DEFAULT, closeReason VARCHAR(200)')`; `it('FK da anotação só para TeamWhatsappRecipient, ON DELETE CASCADE; sem FK de usuário')`.
2. [ ] RED integração (`team-pendency.migration.integration.spec.ts`, `describe.skipIf(!TESTCONTAINERS_ENABLED)`): `it('destinatários existentes ficam iguais depois da migração, com as colunas de pendência nulas')` (padrão de `shared/audit/audit-category-migration.integration.spec.ts`, como a T1 do K1: aplicar até a migração anterior, inserir envio e destinatário com `ackAt` e outro sem, aplicar a nova, comparar todas as colunas antigas, inclusive `updatedAt`); `it('anotação com texto de 201 caracteres é recusada pelo banco')`; `it('apagar o destinatário apaga as anotações (Cascade)')`; `it('authorId e pendencyHandlerId de usuário inexistente são aceitos (sem FK)')`; `it('fixtures: holdRecipientLock bloqueia um UPDATE da linha até release')`.
3. [ ] GREEN: DDL do `npx prisma migrate diff` alinhado ao padrão, `DROP` de deriva removido à mão; `npx prisma validate`; `npx prisma generate`; typecheck; eslint (GK9); validação (`TESTCONTAINERS_ENABLED=1`); `--changed`.

**Aceite:** base de 12–23. **Risco: alto** (migração não destrutiva em tabela de produção; não é categoria crítica da SKILL). Revisão `sonnet`; a principal confere o SQL no fechamento da onda.
**Foco da revisão:** só `CREATE TYPE`/`ALTER TABLE … ADD COLUMN`/`CREATE TABLE`/FK/índice da tabela nova; `lock_timeout` no topo; nenhuma linha existente muda (nem `updatedAt`); nenhum índice em tabela existente; fixtures importam as do K1 em vez de copiar.

## Task 2 — Contrato, erros e regras puras da pendência (back)

**Arquivos:** criar `backend/src/schemas/contracts/team-pendency.schema.ts` (CK2), `backend/src/modules/team-whatsapp/dto/{pendency-list-query,assume-pendency,transfer-pendency,pendency-note,close-pendency,reopen-pendency}.dto.ts` (`createZodDto`, padrão de `dto/manual-ack.dto.ts`), `team-pendency.errors.ts` (CK3), `team-pendency.rules.ts` (CK4), specs `team-pendency.schema.spec.ts`, `team-pendency.errors.spec.ts`, `team-pendency.rules.spec.ts`, `team-pendency.scope-rules.spec.ts`.

**Interfaces:** consome `TeamActor`, `isTeamSender` (`team-whatsapp.policy.ts:25-51`), `hasPermission` (`shared/authz/permissions`), `alertDeadlineAt` (`team-alert.rules.ts:143`), `MessageKind` (`@prisma/client`), `DomainError`. Não depende da T1 (nenhum tipo de coluna nova; `LockedPendency` é tipo próprio). Produz CK2, CK3, CK4.

**Contexto vinculado:**
- K2-2: "Situação da pendência. Calculada, nesta ordem: 'Ciente': tem ciência (…). A ciência vale mesmo se chegar depois do encerramento. 'Encerrada sem ciência': encerrada. 'Sem responsável': sem responsável, ou com responsável inativo ou sem acesso ao sistema (o nome aparece como '{nome} (inativo)'). Também quando o responsável perdeu `equipe.enviar` ou deixou de ver a pendência pela função de alcance K2-4 aplicada a ele; o nome aparece como '{nome} (fora do alcance)'. (…) 'Em tratativa — atrasada': com responsável e prazo de tratativa vencido. 'Em tratativa': com responsável e prazo em dia."
- K2-4: "Uma única função no servidor, usada pela lista, pelo contador, pela lista de destinos, pela ciência manual e por todas as ações: começa por `isTeamSender(ator)`: quem não é remetente não vê nenhuma pendência; o ADMIN vê todas; os demais veem as pendências dos alertas que enviaram e as das pessoas de setores ativos que gerem, mesmo em alerta de outro autor; o setor da pessoa é o gravado no destinatário na hora do envio; se vazio (envio nominal), o setor principal atual da pessoa." K2-9: "Setor sem gestor. Só o ADMIN e quem enviou veem as pendências." K2-1: "Cada destinatário de alerta urgente que o painel do alerta mostra (não os destinatários de lembrete) é uma pendência."
- K2-5 "Ordem": "'Sem responsável' com prazo de ciência vencido; depois 'Em tratativa — atrasada'; depois as demais, da mais antiga para a mais nova." K2-6: "Número de pendências 'Sem responsável' com prazo de ciência vencido, no alcance de quem olha, sem limite de data." K2-8: "60 minutos desde que a pendência foi assumida (constante única do sistema)."
- K2-7 (condições e quem): "Assumir: quem vê a pendência. Condição: o responsável que a tela mostrava (nenhum, ou o id do inativo ou sem acesso), sem ciência e não encerrada." "Quem não é o responsável atual nem ADMIN recebe 403 `team_whatsapp.not_handler` em Transferir, Registrar contato, Encerrar e Reabrir." "Registrar contato: (…) anotação obrigatória (até 200)". "Encerrar sem ciência: (…) motivo obrigatório (até 200)."
- C3: "Os 409 levam `code` e, quando a tela precisa, `detail` com id e nome do usuário do sistema envolvido (nunca dado de pessoa da equipe ou contato)."
- K2-7 "Registrar contato": "Condição: ainda é o responsável; senão 409 `team_whatsapp.pendency_changed`."
- DK10.3 (`pendencyConflict`): `PendencyExpectation = { handlerId, closed: boolean | 'any', ignoreAck? }`; ordem: `ackAt` e `!ignoreAck` → `acked`; `closed === false` e encerrada → `closed`; `closed === true` e aberta → `not_closed`; `'any'` não olha encerramento; responsável diferente → `handler_changed`. Só Registrar contato usa `{ closed: 'any', ignoreAck: true }`; Assumir, Assumir de outro, Transferir e Encerrar `{ closed: false }`; Reabrir `{ closed: true }`.
- DK3, DK4 (rótulo "(fora do alcance)", o de K2-2 e do aceite 18), DK5, DK6, DK11 (`assumeKind`), DK12–DK14 (`requiresHandler`: `role !== 'ADMIN' && expectedHandlerId !== actor.id`), DK15, DK8 (mapa de `MessageKind`). GK5, GK9.

**Passos:**
1. [ ] RED (`team-pendency.schema.spec.ts`): `it('situations ausente vira as três abertas; valor desconhecido falha; repetido falha')`; `it('days aceita 7 e 30; 14 falha; padrão 7')`; `it('pageSize acima de 50 falha')`; `it('assume sem expectedHandlerId falha; com null passa; note só espaços vira vazia')`; `it('note de contato e motivo: vazios falham; 201 caracteres falham')`; `it('transfer exige toUserId')`.
2. [ ] RED (`team-pendency.errors.spec.ts`): `it('pendencyTaken — 409 com detail { handler: { id, name } }')`; `it('pendencyChanged — 409; detail com handler null')`; `it('notHandler — 403 team_whatsapp.not_handler'); it('pendencyNotFound — 404')`.
3. [ ] RED (`team-pendency.scope-rules.spec.ts`): `it('K2-4: não remetente (VIEWER, sem setor gerido, inativo, sem acesso) — scope none, scopeAllows falso')`; `it('K2-4: ADMIN — all; envio que não é alerta — falso mesmo para ADMIN')`; `it('aceite 12: limited — autor vê qualquer setor; gestor vê setor efetivo gerido; outro setor de outro autor — falso')`; `it('aceite 13: setor vazio usa personSectorId')`; `it('K2-9: setor sem gestor — só autor e ADMIN')`; `it('canHandlePendency exige remetente, equipe.enviar e alcance')`; `it('handlerStateOf — null, inativo, sem acesso → inactive; sem equipe.enviar, sem setor gerido, fora do setor → out_of_scope; senão active')`.
4. [ ] RED (`team-pendency.rules.spec.ts`): `it('K2-2: ordem ACKED > CLOSED > UNASSIGNED > OVERDUE > IN_PROGRESS')`; `it('aceite 19: ack depois do encerramento — ACKED; prazo vencido — OVERDUE')`; `it('responsável inactive ou out_of_scope — UNASSIGNED')`; `it('aceite 15: ordem — Sem responsável vencida, atrasada, demais da mais antiga; empate por id')`; `it('isUnassignedOverdue — só UNASSIGNED com prazo de ciência vencido')`; `it('K2-8: pendencyDueAt = now + 60 min')`; `it('pendencyConflict — acked antes de closed antes de handler_changed; not_closed quando espera encerrada')`; `it('DK13: pendencyConflict de Registrar contato (closed any, ignoreAck) — ciente, encerrada ou ciente e encerrada com o mesmo responsável: null; responsável trocado: handler_changed')`; `it('pendencyConflict de Assumir, Transferir e Encerrar (closed false) continua acked em ciente e closed em encerrada; de Reabrir (closed true), acked e not_closed')`; `it('assumeKind — eu noop; null, inactive, out_of_scope assume; active take_over')`; `it('requiresHandler — ADMIN nunca; outro com expected diferente sim')`; `it('replyMediaOf — AUDIO audio; IMAGE e STICKER image; demais file; TEXT null')`.
5. [ ] GREEN; typecheck; eslint (GK9); validação; `--changed`.

**Aceite:** base de 12, 13, 15, 16, 18, 19. **Risco: crítico (autorização).**
**Crítico: autorização — define a única regra de alcance (quem vê cada pendência, K2-4) e a regra de quem pode tratar (`canHandlePendency`, `requiresHandler`) que todas as rotas aplicam.** Revisão `opus`.

## Task 3 — Alcance no banco, responsáveis e destinos (back)

**Arquivos:** criar `backend/src/modules/team-whatsapp/team-pendency-scope.repository.ts`, `team-actors.query.ts`, specs `team-pendency-scope.repository.integration.spec.ts`, `team-pendency-scope.equivalence.integration.spec.ts`, `team-actors.query.integration.spec.ts`.

**Interfaces:** consome CK1, CK4, `findTeamActor`/`findEffectivePermissions` (`team-actor.query.ts:10-31`), `teamForbidden` (`team-whatsapp.errors.ts`), `pendencyNotFound` (CK3), fixtures da T1. Produz CK5.

**Contexto vinculado:**
- K2-4 (texto na T2) e "Pendência fora do alcance responde 404 em qualquer rota." K2-1: "Cada destinatário de alerta urgente que o painel do alerta mostra (não os destinatários de lembrete) é uma pendência daquele alerta. Dois alertas para a mesma pessoa são duas pendências."
- K2-7 "Lista de destinos": "devolve só id e nome dos usuários que podem recebê-la (a regra do destino acima)" — "outro usuário ativo, com acesso, com `equipe.enviar` e que veja aquela pendência".
- K2-2: "A lista e o contador fazem esse cálculo para o responsável de cada pendência."
- DK3 (a consulta é a mesma regra do descritor; `none` → `null` sem consulta; alerta = `dispatch.ackDeadlineMinutes` não nulo; lembrete fica fora porque o envio do lembrete não tem prazo), DK4. `findTeamActor` relê papel, `isActive`, `hasAccess`, setores ATIVOS geridos e permissões efetivas a cada chamada (GK4); `findTeamActors` repete o formato em lote, chamando `findEffectivePermissions` uma vez por papel.
- Anti-objetivo 1: "Um SUPERVISOR ver pendência de pessoa fora dos setores que gere e de alerta que não enviou, por qualquer rota."
- GK8, GK9.

**Passos:**
1. [ ] RED integração (`team-pendency-scope.repository.integration.spec.ts`): `it('K2-1: ADMIN — todas as pendências de alerta; destinatário de lembrete e de envio sem prazo de ciência fora')`; `it('aceite 12: SUPERVISOR vê as do setor que gere, inclusive em alerta de outro autor')`; `it('aceite 12: vê as dos alertas que enviou; não vê as demais')`; `it('aceite 13: envio nominal usa o setor principal atual da pessoa (troca de setor depois do envio muda o alcance)')`; `it('K2-9: setor sem gestor — só ADMIN e autor')`; `it('setor gerido inativo não dá alcance')`; `it('pessoa removida (userId nulo) em envio nominal — só ADMIN e autor')`; `it('findPendencyScopeFacts — inexistente null; isAlert, authorId, sectorId e personSectorId')`; `it('requireVisiblePendency — não remetente 403 team_whatsapp.forbidden; fora do alcance e inexistente 404 pendency_not_found; no alcance devolve ator e fatos')`.
2. [ ] RED equivalência (`team-pendency-scope.equivalence.integration.spec.ts`): `it.each(atores)('DK3: pendencyScopeWhere e scopeAllows concordam para %s em toda a massa')` — massa com ADMIN, SUPERVISOR de S1, OPERATOR de S2, autor sem setor gerido, VIEWER; pendências em S1, S2, setor sem gestor, nominal com pessoa em S1, nominal com pessoa removida, lembrete e envio que não é alerta (comentário: pega a consulta e a regra em memória divergindo).
3. [ ] RED (`team-actors.query.integration.spec.ts`): `it('findTeamActors — mesmo formato de findTeamActor; setores geridos só ativos; permissões do papel')`; `it('uma chamada de findEffectivePermissions por papel')` (espião); `it('listHandlerCandidates — só ADMIN, SUPERVISOR e OPERATOR ativos com acesso, ordem por nome')`; `it('handlerStatesFor — sem responsável null; inexistente, inativo, sem acesso inactive; sem equipe.enviar e fora do setor out_of_scope; nome do usuário')`.
4. [ ] GREEN; typecheck; eslint (GK9); validação (`TESTCONTAINERS_ENABLED=1`); `--changed`.

**Aceite:** 12, 13 (base de alcance), base de 16–18. **Risco: crítico (autorização).**
**Crítico: autorização — a consulta filtra no banco quais pendências cada ator vê (lista e contador) e decide o 403/404 de toda rota de pendência.** Revisão `opus`.

## Task 4 — Ciência manual pela pendência no alcance (back)

**Arquivos:** criar `backend/src/modules/team-whatsapp/team-pendency-ack-access.ts`, specs `team-pendency-ack-access.integration.spec.ts`, `team-alert-ack.scope.integration.spec.ts`; modificar `team-alert-ack.service.ts` (**só** a linha de `requireViewable` em `requireAlertRecipient`, ~L91, e o import; o comentário da ordem no topo do arquivo ganha "ou tem a pendência no alcance").

**Interfaces:** consome CK4 (`pendencyScopeOf`, `scopeAllows`), CK5 (`findPendencyScopeFacts`), `canViewDispatch`, `requireViewable`/`TeamWhatsappRepository.findDispatchForActor` (`team-alert-access.ts:14-24`), `dispatchNotFound`, fixtures da T1. Produz `requireAckVisible` (CK7).

**Contexto vinculado:**
- K2-7 "Ciência manual e desfazer": "continuam nas rotas do Lote I (`POST` e `DELETE dispatches/:id/recipients/:recipientId/ack`), com `equipe.urgencia` (conselho U). A conferência de visibilidade das duas passa a aceitar quem vê o envio **ou** tem a pendência no alcance K2-4. A ordem 403 → 404 → 422 do Lote I não muda."
- Aceite 21: "Ciência manual e desfazer pela tela de pendências funcionam para quem tem `equipe.urgencia` e vê a pendência, mesmo sem ver o envio, nas rotas do Lote I com a ordem 403 → 404 → 422."
- Restrição: "`canViewDispatch` não muda."
- Estado de hoje (`team-alert-ack.service.ts:83-96`): 403 remetente (`:89`) → 403 chave `equipe.urgencia` (`requireUrgencyKey`, `:90`) → 404 `requireViewable` (`:91`) → 404 `isRecipientOf` (`:93`) → 422 `not_an_alert` (`loadAlertHeader`, `:94`). DK17 (troca só o passo 404; o 404 continua `dispatchNotFound()`, indistinguível; o alcance exige `isAlert`, então gestor não recebe 422 de envio que não vê).
- GK9 (`team-alert-ack.service.ts` é legado: só a troca dita); os specs existentes da ciência manual continuam verdes sem alteração.

**Passos:**
1. [ ] RED (`team-pendency-ack-access.integration.spec.ts`): `it('autor ou ADMIN (vê o envio) — passa')`; `it('gestor do setor da pessoa, sem ver o envio — passa')`; `it('gestor de outro setor, sem ver o envio — 404 dispatchNotFound')`; `it('envio que não é alerta, pessoa do setor gerido, sem ver o envio — 404, não 422')`; `it('destinatário de outro envio — 404')`.
2. [ ] RED serviço (`team-alert-ack.scope.integration.spec.ts`, `TeamAlertAckService` real): `it('aceite 21: SUPERVISOR com equipe.urgencia que vê a pendência, sem ver o envio — registra e desfaz a ciência manual')`; `it('aceite 21: ordem 403 → 404 → 422 inalterada — sem equipe.urgencia e fora do alcance: 403 da chave; fora do alcance: 404; no alcance com ciência: 422 ack_exists')`; `it('ciência manual numa pendência encerrada — registra; colunas de encerramento intactas')`.
3. [ ] GREEN; rodar os specs existentes da ciência manual (`grep -l "TeamAlertAckService\|requireAlertRecipient" backend/src` e `gate --test` em cada) sem editá-los; typecheck; eslint (GK9); validação; `--changed`.

**Aceite:** 21 (back). **Risco: crítico (autorização).**
**Crítico: autorização — amplia quem pode registrar e desfazer ciência manual (de "vê o envio" para "vê o envio ou tem a pendência no alcance"), mantendo a ordem 403 → 404 → 422.** Revisão `opus`.

## Task 5a — Leituras: lista e item; controller (back)

**Arquivos:** criar `backend/src/modules/team-whatsapp/team-pendency.query.ts` (leituras DK7/DK8 da lista e da página), `team-pendency.view.ts` (monta `TeamPendencyItem`, puro), `team-pendency.service.ts` (`TeamPendencyService` com `list` e `get`), `team-pendency.controller.ts` (só `GET pendencies` e `GET pendencies/:id`), specs `team-pendency.view.spec.ts`, `team-pendency.list.integration.spec.ts`, `team-pendency.controller.spec.ts`; modificar `team-whatsapp.module.ts` (**só** `TeamPendencyController` em `controllers` e `TeamPendencyService` em `providers`), `backend/src/modules/permissions/route-parity.spec.ts` (**só** o import e a linha `{ controller: TeamPendencyController, routes: [['GET /pendencies', ASO], ['GET /pendencies/:id', ASO]] }`).

**Interfaces:** consome CK2–CK5, `alertGroupOf`/`factsOf`/`AlertPersonRow` (`team-alert.rules.ts:92`, `team-alert.repository.ts:78-120`), `alertDeadlineAt`, `phoneView`/`nameView` (`shared/authz/phone-visibility.ts`), `canViewDispatch`, `seesFullPhone` (`team-whatsapp.name-view.ts:13-14`). Produz `list` e `get` de CK7, o controller e o registro no módulo. Confere em `team-alert.controller.ts` como o controller lê `req.user.sub` e monta `@Roles`.

**Contexto vinculado:**
- K2-5: "Tela 'Pendências da equipe' (rota nova no front e rotas novas no back, com papel ADMIN, SUPERVISOR ou OPERATOR e exigência de ser remetente). Quem não é remetente recebe 403 (…). SUPERVISOR/OPERATOR sem setor gerido recebe o 403 (…)." "Cada linha mostra: pessoa, setor e turno gravados no envio; telefone como o painel do alerta mostra (completo com `telefone.ver_completo`, mascarado sem); texto do alerta, quem enviou e quando; grupo do painel, prazo de ciência, responsável, situação e anotações; em 'Respondeu, sem ciência', o texto da última resposta ligada ao alerta (mídia só como 'Áudio', 'Imagem' ou 'Arquivo'). Nenhuma outra mensagem da conversa aparece." "Filtros: situação, setor e 'Minhas' (em que sou o responsável). Por padrão: 'Sem responsável', 'Em tratativa' e 'Em tratativa — atrasada'." "Período: as abertas aparecem sem limite de data (…). 'Ciente' e 'Encerrada sem ciência' mostram os alertas dos últimos 7 dias, com opção de 30." "'Abrir conversa' aparece só a quem tem acesso à caixa e só quando o alerta gerou mensagem. 'Ver resultado do alerta' aparece só a quem vê o envio (`canViewDispatch`)." "Sem tempo real."
- K2-1: "Cada destinatário de alerta urgente que o painel do alerta mostra (não os destinatários de lembrete) é uma pendência daquele alerta. Dois alertas para a mesma pessoa são duas pendências."
- Aceite 12: "VIEWER não consulta. SUPERVISOR ou OPERATOR sem setor gerido não vê o item de menu nem erro, mesmo tendo enviado alertas antes." Aceite 18 (parte): "Responsável que perde `equipe.enviar` ou o setor gerido faz a pendência voltar a 'Sem responsável'" (rótulo pelo DK4).
- Anti-objetivo 2: "Uma tela de pendências mostrar outra mensagem da conversa além da última resposta ligada ao alerta." GK13 (nada de texto em log).
- DK7 (passos; abertas sem limite de data; Ciente/Encerrada por `days` pela data do alerta; setores da resposta; **teto**: cada consulta lê no máximo `PENDENCY_LIST_MAX_ROWS = 2000` linhas da mais nova para a mais antiga, `orderBy: [{ createdAt: 'desc' }, { id: 'desc' }]` do destinatário, pedindo `max + 1`; passou, `truncated: true`, ficam de fora as mais antigas; a ordem DK5 é feita em memória depois; o teto é parâmetro opcional da consulta para o teste), DK8 (campos; `lastReply` só em `replied`; mídia sem legenda; `conversationId` só ADMIN/OPERATOR e com `messageId`; telefone por `phoneView`), DK9 (rotas, `@Roles('ADMIN','SUPERVISOR','OPERATOR')` nas leituras sem `@RequirePermission`, linha no `route-parity.spec.ts` com `ASO`). GK4, GK8 (`now` por parâmetro), GK9 (legados: `team-whatsapp.module.ts` e `route-parity.spec.ts` só as linhas ditas).

**Passos:**
1. [ ] RED puro (`team-pendency.view.spec.ts`): `it('aceite 14: monta pessoa, alerta, grupo, prazo de ciência, responsável com state, situação e anotações')`; `it('aceite 14: lastReply só no grupo replied; mídia sem texto')`; `it('aceite 22: conversationId só para ADMIN e OPERATOR e com mensagem; canViewDispatch só ADMIN e autor')`; `it('telefone e nome por phoneView/nameView conforme a chave')`.
2. [ ] RED integração (`team-pendency.list.integration.spec.ts`, banco real, `now` fixo): `it('aceite 15: padrão traz Sem responsável, Em tratativa e atrasada, inclusive alerta de 90 dias')`; `it('aceite 15: Ciente e Encerrada só dos últimos 7 dias; days=30 amplia')`; `it('aceite 15: ordem DK5 na resposta')`; `it('filtros setor (setor efetivo, inclusive nominal) e mine')`; `it('aceite 14: Respondeu, sem ciência — só a última resposta ligada; mídia como audio/image/file sem legenda; outros grupos sem lastReply')`; `it('aceite 14: telefone completo só com telefone.ver_completo; senão mascarado')`; `it('aceite 18: responsável sem equipe.enviar ou sem setor gerido — Sem responsável, state out_of_scope; inativo — inactive')`; `it('aceite 12: VIEWER e SUPERVISOR sem setor gerido que já enviou alerta — 403 team_whatsapp.forbidden em lista e item')`; `it('item fora do alcance — 404 pendency_not_found')`; `it('K2-1: dois alertas para a mesma pessoa — duas pendências, cada uma com o seu alerta e id próprio')`; `it('DK7: acima do teto — truncated true; ficam as mais novas (as mais antigas saem) e a ordem DK5 vale entre as lidas')` (teto injetável, por exemplo 3, com 5 abertas de datas diferentes; comentário: pega leitura do mais antigo para o mais novo); `it('sectors traz os setores efetivos no alcance antes do filtro de setor')`.
3. [ ] RED controller (`team-pendency.controller.spec.ts`, `RolesGuard` real como os specs de controller do módulo): `it('VIEWER — 403 auth.insufficient_role nas duas leituras')`; `it('query inválida (days=14) — 400')`; `route-parity.spec.ts` verde.
4. [ ] GREEN; typecheck; eslint (GK9); validação (`TESTCONTAINERS_ENABLED=1`); `--changed`.

**Aceite:** 12 (lista e item), 14, 15 (lista), 18 (rótulo), 22 (back). **Risco: crítico (autorização).**
**Crítico: autorização — aplica o alcance à lista e ao item, decide o 403 de não remetente e o que cada papel recebe (telefone pela chave, `conversationId` só a quem tem a caixa).** Revisão `opus`.

## Task 5b — Leituras: contador e lista de destinos (back)

**Arquivos:** criar specs `team-pendency.count.integration.spec.ts`, `team-pendency.handlers.integration.spec.ts`, `team-pendency.count.controller.spec.ts`; modificar `team-pendency.query.ts` (leitura em lotes do contador), `team-pendency.service.ts` (`count`, `handlers`), `team-pendency.controller.ts` (`GET pendency-count` e `GET pendencies/:id/handlers`, `@Roles('ADMIN','SUPERVISOR','OPERATOR')`), `route-parity.spec.ts` (**só** `['GET /pendency-count', ASO]` e `['GET /pendencies/:id/handlers', ASO]` na linha de `TeamPendencyController`).

**Interfaces:** consome CK2–CK5 (`pendencyScopeWhere`, `requireVisiblePendency`, `handlerStatesFor`, `listHandlerCandidates`, `canHandlePendency`, `isUnassignedOverdue`, `alertDeadlineAt`), o serviço e o controller da T5a, fixtures da T1. Produz `count` e `handlers` de CK7.

**Contexto vinculado:**
- K2-6: "Número de pendências 'Sem responsável' com prazo de ciência vencido, no alcance de quem olha, sem limite de data. Calculado ao abrir o sistema e ao abrir a tela, sem tempo real. Só para remetentes."
- K2-7 "Lista de destinos": "devolve só id e nome dos usuários que podem recebê-la (a regra do destino acima)" — "outro usuário ativo, com acesso, com `equipe.enviar` e que veja aquela pendência". K2-2: "A lista e o contador fazem esse cálculo para o responsável de cada pendência" (responsável inativo ou fora do alcance conta como "Sem responsável").
- Aceite 12: "SUPERVISOR ou OPERATOR sem setor gerido não vê o item de menu nem erro, mesmo tendo enviado alertas antes" (403 `team_whatsapp.forbidden`, que o front transforma em `null`).
- DK7 "Contador sem teto": `count` não usa o teto da lista nem tem `truncated`; o banco filtra alcance e abertas (`ackAt` e `pendencyClosedAt` nulos) e devolve só fatos leves; leitura em lotes de `PENDENCY_LIST_MAX_ROWS` por cursor (`orderBy id`, `cursor`/`skip: 1`) até acabar; em cada lote, `handlerStatesFor` e `isUnassignedOverdue` em memória, somando. DK4 (`canHandlePendency` = remetente, `equipe.enviar` e alcance). DK9 (`pendency-count` fora de `pendencies/` para não colidir com `:id`; leitura só com `@Roles`). GK4, GK8, GK9 (`route-parity.spec.ts` só as duas rotas).

**Passos:**
1. [ ] RED integração (`team-pendency.count.integration.spec.ts`): `it('aceite 15: contador conta só Sem responsável com prazo de ciência vencido no alcance, sem limite de data')`; `it('não conta prazo de ciência em dia, responsável ativo, ciente, encerrada, fora do alcance')`; `it('responsável inativo ou fora do alcance conta como Sem responsável')`; `it('DK7: contador acima do teto — conta todas (lotes por cursor), sem truncated')` (lote injetável, por exemplo 2, com 5 pendências que contam; comentário: pega contador com o teto da lista); `it('aceite 12: não remetente — 403 team_whatsapp.forbidden')`.
2. [ ] RED integração (`team-pendency.handlers.integration.spec.ts`): `it('destinos — só ativos com acesso, equipe.enviar e que veem a pendência; id e nome; ordem por nome')`; `it('destinos — fora do alcance 404 pendency_not_found; não remetente 403 forbidden')`.
3. [ ] RED controller (`team-pendency.count.controller.spec.ts`, `RolesGuard` real): `it('VIEWER — 403 auth.insufficient_role em pendency-count e handlers')`; `it('GET pendency-count não colide com pendencies/:id')`; `route-parity.spec.ts` verde.
4. [ ] GREEN; typecheck; eslint (GK9); validação (`TESTCONTAINERS_ENABLED=1`); `--changed`.

**Aceite:** 12 (contador e destinos), 15 (contador), base de 17 (destinos). **Risco: crítico (autorização).**
**Crítico: autorização — aplica o alcance ao contador e decide quem aparece como destino de Transferir (`canHandlePendency`: remetente com `equipe.enviar` que vê a pendência).** Revisão `opus`.

## Task 6 — Núcleo de escrita da pendência (back)

**Arquivos:** criar `backend/src/modules/team-whatsapp/team-pendency-write.repository.ts` (CK6), specs `team-pendency-write.repository.integration.spec.ts`, `team-pendency-write.lock.integration.spec.ts`.

**Interfaces:** consome CK1, CK4 (`pendencyConflict`, `pendencySituation`, `LockedPendency`), `AuditService.recordChange(tx, change)` (`audit.service.ts:114-132`; `AuditChange` em `audit-change.ts:12-23`, `category: AuditCategory | null` desde o K1), fixtures da T1. Produz CK6. Modelo: `chat/conversation-ownership.repository.ts` (`lockConversation`, `applyOwnershipChange`, `OWNERSHIP_TX_OPTIONS`).

**Contexto vinculado:**
- Vocabulário: "'Gravação condicional' é uma escrita que só acontece se o estado ainda for o que a tela mostrava, num único comando atômico; se não bater, nada é gravado e a resposta é 409." K2-7: "Todas as ações gravam de forma condicional e entram na trilha do WhatsApp da equipe, com antes e depois de responsável, situação e prazo, sem os textos."
- K2-2: "A ciência continua sendo a única verdade sobre 'ciente'. Encerrar não cria ciência (…)." Anti-objetivo 8: "A trilha guarda ids e situações, não textos."
- DK10 inteiro (transação com `PENDENCY_TX_OPTIONS = { timeout: 10_000, maxWait: 5_000 }`; `SELECT … FOR NO KEY UPDATE` no `"TeamWhatsappRecipient"`; conferência pura por `pendencyConflict` com `PendencyExpectation = { handlerId, closed: boolean | 'any', ignoreAck? }`; `patch` e `note` nulos = só conferência, sem `UPDATE`, anotação nem trilha, `ok: true` com `after = before` (o "nada a fazer" de Assumir e Transferir); `UPDATE` cru das seis colunas **sem `updatedAt`** por causa do índice `[status, updatedAt]` do verificador de presos; anotação e trilha no mesmo `tx`; resultado em vez de exceção, para o K3), DK16 (ações, `changes` sempre com `handlerId`, `situation`, `dueAt`; `metadata { dispatchId, recipientId, kind?, noteId? }`), DK24. GK3, GK11, GK13.

**Passos:**
1. [ ] RED integração (`team-pendency-write.repository.integration.spec.ts`, banco real, `AuditService` real): `it('lockPendency — inexistente null')`; `it('aceite 23: transição de assumir — grava responsável, assignedAt e dueAt; AuditEvent team_whatsapp.pendency_assume com antes/depois de handlerId, situation e dueAt, sem texto')`; `it('conflitos acked, closed, not_closed, handler_changed — colunas iguais, nenhuma anotação, nenhum AuditEvent')`; `it('ausente — conflict missing')`; `it('só conferência (patch e note nulos) — ok sem UPDATE, anotação nem AuditEvent; com estado diferente do esperado, o conflito volta')`; `it('expectativa de contato (closed any, ignoreAck) — grava a anotação em pendência ciente e em encerrada')`; `it('anotação — TeamPendencyNote com kind e autor; metadata com noteId e sem o texto')`; `it('não muda updatedAt, status, ackAt nem campos de rastreio')`; `it('falha do recordChange desfaz colunas e anotação')` (espiar para lançar); `it('toda $transaction usa PENDENCY_TX_OPTIONS')` (espião).
2. [ ] RED trava (`team-pendency-write.lock.integration.spec.ts`, GK11): `it('com a linha travada por fora, a transição espera e depois confere o estado novo (handler_changed)')` (comentário: pega a conferência feita sobre leitura sem trava); `it('recordAlertReply (sem transação, como em produção) na fila depois da transição grava ackAt; situação ACKED')`.
3. [ ] GREEN; `grep -rn "pendencyHandlerId\|pendencyClosedAt\|teamPendencyNote\." backend/src --include=*.ts` mostra escrita só neste arquivo (fora specs e fixtures); typecheck; eslint (GK9); validação (`TESTCONTAINERS_ENABLED=1`); `--changed`.

**Aceite:** base de 16–19, 23. **Risco: alto** (transação/concorrência sem decisão de acesso; a autorização fica nas T7, T8a e T8b). Revisão `sonnet`.
**Foco da revisão:** conferência sobre a linha travada; nada gravado no conflito; trilha dentro da transação e sem textos; `updatedAt` intocado; resultado sem exceção usável pelo K3.

## Task 7 — Assumir e assumir de outro, com corridas (back)

**Arquivos:** criar `backend/src/modules/team-whatsapp/team-pendency-actions.service.ts` (`TeamPendencyActionsService` com `assume`), specs `team-pendency.assume.integration.spec.ts`, `team-pendency.assume.race.integration.spec.ts`, `team-pendency.assume.controller.spec.ts`; modificar `team-pendency.controller.ts` (`POST pendencies/:id/assume`, `@RequirePermission('equipe.enviar')`, `@HttpCode(204)`), `team-whatsapp.module.ts` (**só** o provider novo), `route-parity.spec.ts` (**só** `['POST /pendencies/:id/assume', ASO]`).

**Interfaces:** consome CK2–CK6, `requireVisiblePendency`, `handlerStatesFor`/`findTeamActors` (T3), `runPendencyTransition` (T6), `recordAlertReply` (`tracking/team-alert-reply.ts:44`, nas corridas), fixtures da T1. Produz `assume` de CK7.

**Contexto vinculado:**
- K2-7 "Assumir": "quem vê a pendência. Condição: o responsável que a tela mostrava (nenhum, ou o id do inativo ou sem acesso), sem ciência e não encerrada. Se outro assumiu antes: 409 `team_whatsapp.pendency_taken`, com o nome do responsável. Se ficou ciente ou foi encerrada: 409 `team_whatsapp.pendency_changed`." "Assumir de outro: quem vê, com observação opcional. Condição: o responsável que a tela mostrava, sem ciência e não encerrada; senão 409 `team_whatsapp.pendency_changed`. O prazo recomeça." "Ordem das recusas: 403 (chave) → 404 (fora do alcance) → 409/422 (estado), como no Lote I." "Toda escrita exige `equipe.enviar`."
- K2-8: "60 minutos desde que a pendência foi assumida (constante única do sistema), gravado na pendência nesse momento."
- Aceite 16: "Assumir grava responsável e prazo de 60 min. Dois 'Assumir' simultâneos: um vence e o outro recebe 409 `team_whatsapp.pendency_taken` com o nome (teste com banco real). Pendência com responsável inativo ou fora do alcance pode ser assumida por quem a vê." Aceite 17: "Assumir de outro (…) com 409 `team_whatsapp.pendency_changed` (…). O prazo recomeça."
- DK9 (ordem; `@RequirePermission` só na escrita; linha do `route-parity.spec.ts`), DK11 inteiro (tipos `assume`/`take_over`/`noop`; observação vira anotação `ASSUME`; `pendency_taken` só em `assume` com responsável atual não nulo; **`noop` passa pela linha travada** com `patch` e `note` nulos: ainda meu, sem ciência e aberta → 204 sem gravar; ciente, encerrada ou transferida no meio → 409 `pendency_changed`), DK15, DK16 (`team_whatsapp.pendency_assume`, `metadata.kind`).
- DK23 (corridas): Molde B com `holdRecipientLock`; ciência automática pela função real `recordAlertReply`, que são três `UPDATE` sem transação — só o primeiro entra na fila da trava. Na ordem "ciência antes do Assumir", o teste chama `db.prisma.$transaction((tx) => recordAlertReply(tx, …))` (ou a trava externa grava `ackAt` antes de soltar), para a ciência entrar atômica; na ordem "Assumir antes", `recordAlertReply` sem transação, como em produção. Em produção, com a ciência na fila antes, o resultado legítimo é "responsável gravado e depois Ciente". `tracking/*` não muda (GK1).
- GK3, GK5, GK8 (`now` por parâmetro), GK11, GK13.

**Passos:**
1. [ ] RED integração (`team-pendency.assume.integration.spec.ts`): `it('aceite 16: assumir sem responsável — responsável, dueAt = now + 60 min, Em tratativa, trilha kind assume')`; `it('aceite 16: responsável inativo ou fora do alcance — quem vê assume com expected = id dele')`; `it('aceite 17: assumir de outro com observação — prazo recomeça, anotação ASSUME, trilha kind take_over sem o texto')`; `it('assumir com outro já responsável — 409 pendency_taken com id e nome')`; `it('assumir de outro com responsável trocado — 409 pendency_changed')`; `it('ciente ou encerrada — 409 pendency_changed, nada gravado')`; `it('expected = eu, ainda meu e aberta — 204 sem gravar nem AuditEvent')`; `it('expected = eu, mas ficou ciente, foi encerrada ou transferida — 409 pendency_changed (conferido na linha travada)')`; `it('fora do alcance — 404 pendency_not_found antes de olhar o estado; não remetente — 403 forbidden')`.
2. [ ] RED corrida (`team-pendency.assume.race.integration.spec.ts`, Molde B): `it('aceite 16: dois Assumir simultâneos — um grava, o outro 409 pendency_taken com o nome; um AuditEvent')` (comentário: pega conferência sem trava ou `updateMany` sem a condição do responsável); `it('ciência automática (em $transaction) na fila antes do Assumir — 409 pendency_changed, sem responsável')` (comentário: pega conferência sem trava; a ciência entra em `$transaction(…, PENDENCY_TX_OPTIONS)` — prazo maior que o padrão de 5 s, revisão 2 M3 — porque `recordAlertReply` são três comandos, DK23); `it('Assumir na fila antes da ciência automática (sem transação, como em produção) — responsável gravado e depois Ciente')`.
3. [ ] RED controller (`team-pendency.assume.controller.spec.ts`, `RolesGuard` real): `it('sem equipe.enviar — 403 do guard antes do serviço')`; `it('sem expectedHandlerId — 400')`; `it('sucesso — 204 sem corpo')`; `route-parity.spec.ts` verde.
4. [ ] GREEN; typecheck; eslint (GK9); validação (`TESTCONTAINERS_ENABLED=1`); `--changed`.

**Aceite:** 16 (assumir e corrida), 17 (assumir de outro). **Risco: crítico (autorização).**
**Crítico: autorização — decide quem pode assumir uma pendência (remetente com `equipe.enviar` que a vê) e grava o responsável na linha travada; concorrência — dois Assumir e a ciência se serializam pela trava, sem gravação perdida.** Revisão `opus`.

## Task 8a — Transferir e registrar contato (back)

**Arquivos:** modificar `team-pendency-actions.service.ts` (`transfer`, `addNote`), `team-pendency.controller.ts` (`POST pendencies/:id/transfer` e `POST pendencies/:id/notes`, `@RequirePermission('equipe.enviar')`, `@HttpCode(204)`), `route-parity.spec.ts` (**só** `['POST /pendencies/:id/transfer', ASO]` e `['POST /pendencies/:id/notes', ASO]` na linha de `TeamPendencyController`); criar specs `team-pendency.transfer.integration.spec.ts`, `team-pendency.note.integration.spec.ts`, `team-pendency.handling.controller.spec.ts`.

**Interfaces:** consome CK2–CK6, `requireVisiblePendency`, `findTeamActor`, `canHandlePendency`, `requiresHandler`, `handlerStatesFor`, `NotFoundError` (`shared/errors/domain.error.ts`), `runPendencyTransition` (T6), o serviço e o controller da T7, fixtures da T1. Produz `transfer` e `addNote` de CK7.

**Contexto vinculado:**
- K2-7: "Transferir: o responsável ou o ADMIN passa a outro usuário ativo, com acesso, com `equipe.enviar` e que veja aquela pendência (senão 404, como usuário inexistente). Mesma condição; o prazo recomeça." "Registrar contato: o responsável grava anotação obrigatória (até 200: o que fez e por qual meio). Condição: ainda é o responsável; senão 409 `team_whatsapp.pendency_changed`. Não muda situação nem prazo." "Quem não é o responsável atual nem ADMIN recebe 403 `team_whatsapp.not_handler` em Transferir, Registrar contato, Encerrar e Reabrir. A condição atômica de cada uma inclui o responsável que a tela mostrava; se mudou no meio, 409 `team_whatsapp.pendency_changed`."
- Aceite 17: "Assumir de outro e transferir seguem K2-7, com 409 `team_whatsapp.pendency_changed` e 404 para destino que não vê a pendência ou não tem `equipe.enviar`. O prazo recomeça." Aceite 18 (parte): "Registrar contato exige texto, só pelo responsável, e não muda situação nem prazo."
- DK9 (ordem: 403 guard → 403 forbidden → 404 alcance → 403 `not_handler` → 404 destino → 409/422). DK12 (Transferir: `requiresHandler` → destino por `findTeamActor` + `canHandlePendency`, senão `NotFoundError('User', toUserId)` → `toUserId === expectedHandlerId` é `noop` conferido na linha travada, 204 ou 409 → `expect = { handlerId: expected, closed: false }`: `acked`/`closed`/`handler_changed` → 409 `pendency_changed` → grava `handlerId = toUserId`, `assignedAt = now`, `dueAt = now + 60 min`; ADMIN transfere sem responsável). DK13 (Registrar contato: `requiresHandler` → `expect = { handlerId: expected, closed: 'any', ignoreAck: true }`: só `handler_changed` → 409 → anotação `CONTACT` com `patch: null`; vale também em ciente ou encerrada). DK15, DK16 (`team_whatsapp.pendency_transfer`, `team_whatsapp.pendency_note` com `noteId`, sem texto). GK3, GK5, GK13.

**Passos:**
1. [ ] RED integração (`team-pendency.transfer.integration.spec.ts`): `it('aceite 17: transferir pelo responsável — destino responsável, prazo recomeça, trilha pendency_transfer')`; `it('aceite 17: destino inativo, sem acesso, sem equipe.enviar, que não vê a pendência ou inexistente — 404 user.not_found, nada gravado')`; `it.each(['transfer','addNote'])('aceite 16: não responsável nem ADMIN — 403 not_handler em %s')`; `it('ADMIN transfere pendência de outro e sem responsável')`; `it('transferir para o próprio responsável mostrado — 204 sem gravar; se mudou no meio, 409 pendency_changed')`; `it('transferir ciente, encerrada ou com responsável trocado — 409 pendency_changed')`; `it('ações valem para pendência fora do período de 7 dias')`.
2. [ ] RED integração (`team-pendency.note.integration.spec.ts`): `it('aceite 18: registrar contato grava anotação CONTACT; situação e prazo iguais; trilha pendency_note sem o texto')`; `it('aceite 18: responsável trocado — 409 pendency_changed, nada gravado')`; `it('DK13: registrar contato pelo responsável em pendência ciente ou encerrada — grava a anotação')` (comentário: pega `pendencyConflict` olhando ciência ou encerramento no contato).
3. [ ] RED controller (`team-pendency.handling.controller.spec.ts`, `RolesGuard` real): `it('sem equipe.enviar — 403 do guard em transfer e notes')`; `it('texto vazio ou toUserId ausente — 400')`; `it('sucesso — 204')`; `route-parity.spec.ts` verde.
4. [ ] GREEN; typecheck; eslint (GK9); validação (`TESTCONTAINERS_ENABLED=1`); `--changed`.

**Aceite:** 16 (403 em transferir e contato), 17 (transferir), 18 (contato). **Risco: crítico (autorização).**
**Crítico: autorização — decide quem trata a pendência (responsável ou ADMIN, 403 `not_handler`) e quem pode recebê-la (destino filtrado pelo alcance e por `equipe.enviar`).** Revisão `opus`.

## Task 8b — Encerrar e reabrir, corrida com a ciência e trilha (back)

**Arquivos:** modificar `team-pendency-actions.service.ts` (`close`, `reopen`), `team-pendency.controller.ts` (`POST pendencies/:id/close` e `POST pendencies/:id/reopen`, `@RequirePermission('equipe.enviar')`, `@HttpCode(204)`), `route-parity.spec.ts` (**só** `['POST /pendencies/:id/close', ASO]` e `['POST /pendencies/:id/reopen', ASO]`); criar specs `team-pendency.close.integration.spec.ts`, `team-pendency.close.race.integration.spec.ts`, `team-pendency.close.controller.spec.ts`, `team-pendency.audit.integration.spec.ts`.

**Interfaces:** consome CK2–CK6, `requireVisiblePendency`, `requiresHandler`, `handlerStatesFor`, `ackExists()` (`team-alert.errors.ts:18`), `runPendencyTransition` (T6), `recordAlertReply` (`tracking/team-alert-reply.ts:44`, na corrida), o serviço e o controller da T8a, fixtures da T1. Produz `close` e `reopen` de CK7.

**Contexto vinculado:**
- K2-7: "Encerrar sem ciência: o responsável ou o ADMIN, motivo obrigatório (até 200). Condição: o mesmo responsável, sem ciência e não encerrada. Se a ciência chegou antes: 422 `team_whatsapp.ack_exists` (…). Se já foi encerrada ou mudou de responsável: 409 `team_whatsapp.pendency_changed`." "Reabrir a tratativa: o responsável ou o ADMIN. Condição: o mesmo responsável, encerrada e sem ciência; senão 409 `team_whatsapp.pendency_changed`. Volta a 'Em tratativa' com o mesmo responsável e prazo novo." "Quem não é o responsável atual nem ADMIN recebe 403 `team_whatsapp.not_handler` (…)."
- K2-2: "A ciência vale mesmo se chegar depois do encerramento." "Encerrar não cria ciência, e o painel do alerta mantém a pessoa no grupo em que está."
- Aceite 18 (parte): "Encerrar exige motivo; com ciência já registrada dá 422 `team_whatsapp.ack_exists`. Reabrir só vale para encerrada sem ciência e volta a 'Em tratativa' com prazo novo." Aceite 19: "Ciência depois do encerramento põe a pendência em 'Ciente'." Aceite 23: "A trilha registra assumir, transferir, registrar contato, encerrar e reabrir com ids e situações, sem textos. Nenhum log tem texto, nome ou telefone."
- DK9 (ordem), DK14 (Encerrar: `expect = { handlerId: expected, closed: false }`; `acked` → 422 `ack_exists`; `closed`/`handler_changed` → 409; grava `closedAt`, `closedById`, `closeReason`, responsável e prazo ficam, anotação `CLOSE` com o motivo. Reabrir: `expect = { handlerId: expected, closed: true }`; `acked`/`not_closed`/`handler_changed` → 409; limpa as três colunas de encerramento; com responsável, `dueAt = now + 60 min`; sem responsável, `dueAt` nulo e volta a "Sem responsável"), DK15, DK16 (ações e `changes` sempre com `handlerId`, `situation`, `dueAt`; nunca texto).
- DK23 (corridas): Molde B com `holdRecipientLock`; `recordAlertReply` são três `UPDATE` sem transação — na ordem "ciência antes do Encerrar", o teste chama `db.prisma.$transaction((tx) => recordAlertReply(tx, …))` (ou a trava externa grava `ackAt` antes de soltar); na ordem "Encerrar antes", sem transação, como em produção. Em produção, com a ciência na fila antes, o resultado legítimo é "encerrada e depois Ciente". `tracking/*` não muda (GK1). GK3, GK5, GK11, GK13.

**Passos:**
1. [ ] RED integração (`team-pendency.close.integration.spec.ts`): `it.each(['close','reopen'])('aceite 16: não responsável nem ADMIN — 403 not_handler em %s')`; `it('ADMIN encerra pendência de outro e sem responsável')`; `it('aceite 18: encerrar grava encerramento e anotação CLOSE; Encerrada sem ciência; ackAt continua nulo')`; `it('aceite 18: encerrar com ciência — 422 ack_exists; já encerrada ou responsável trocado — 409 pendency_changed')`; `it('aceite 18: reabrir encerrada sem ciência — Em tratativa, mesmo responsável, prazo novo, encerramento limpo, anotação CLOSE mantida')`; `it('reabrir encerrada pelo ADMIN sem responsável — Sem responsável, dueAt nulo')`; `it('reabrir aberta ou ciente — 409 pendency_changed')`.
2. [ ] RED corrida (`team-pendency.close.race.integration.spec.ts`, Molde B): `it('aceite 19: Encerrar na fila antes da ciência automática (sem transação, como em produção) — encerrada e depois Ciente')` (comentário: pega ciência condicionada ao encerramento); `it('ciência automática (em $transaction) na fila antes do Encerrar — 422 ack_exists, nada encerrado')` (comentário: pega conferência sem trava; a ciência entra em `$transaction(…, PENDENCY_TX_OPTIONS)` — prazo maior que o padrão de 5 s, revisão 2 M3 — porque `recordAlertReply` são três comandos, DK23).
3. [ ] RED trilha (`team-pendency.audit.integration.spec.ts`): `it('aceite 23: trilha de assumir, transferir, registrar contato, encerrar e reabrir com antes/depois de handlerId, situation e dueAt')`; `it('aceite 23: nenhum AuditEvent contém o texto da anotação, o motivo, nome ou telefone')` (`JSON.stringify` de todas as linhas).
4. [ ] RED controller (`team-pendency.close.controller.spec.ts`, `RolesGuard` real): `it('sem equipe.enviar — 403 do guard em close e reopen')`; `it('motivo vazio — 400')`; `it('sucesso — 204')`; `route-parity.spec.ts` verde.
5. [ ] GREEN; typecheck; eslint (GK9); validação (`TESTCONTAINERS_ENABLED=1`); `--changed`.

**Aceite:** 16 (403 em encerrar e reabrir), 18 (encerrar e reabrir), 19, 23. **Risco: crítico (autorização).**
**Crítico: autorização — decide quem encerra e reabre a pendência (responsável ou ADMIN, 403 `not_handler`); concorrência — encerrar × ciência sem perda de nenhuma das duas.** Revisão `opus`.

## Task 9 — Painel do alerta: "Tratativa encerrada por" (back)

**Arquivos:** criar `backend/src/modules/team-whatsapp/team-alert-closure.ts` (`loadAlertClosures`), specs `team-alert-closure.integration.spec.ts`, `team-alert-panel.closure.integration.spec.ts`; modificar `team-alert-panel.service.ts` (**só** ler os encerramentos e acrescentar `closure` em `personView`, ~L97-156, com os nomes no mesmo lote de nomes de `:80-83`), `backend/src/schemas/contracts/team-whatsapp.schema.ts` (**só** `closure` na pessoa de `teamAlertPanelSchema`, ~L599, e o tipo ~L709).

**Interfaces:** consome CK1, `AlertDb` (`team-alert.repository.ts:16-19`), `nameView`. Produz CK9.

**Contexto vinculado:**
- K2-2: "Encerrar não cria ciência, e o painel do alerta mantém a pessoa no grupo em que está, com a marca 'Tratativa encerrada por {nome}: {motivo}'."
- Aceite 20: "O painel do alerta mantém a pessoa no grupo e mostra 'Tratativa encerrada por {nome}: {motivo}'." Anti-objetivo: "Encerrar uma pendência criar ciência, ou tirar a pessoa do grupo em que está no painel do alerta."
- Restrição: "`canViewDispatch` não muda" (quem vê o painel continua igual). DK18. GK9 (`team-alert-panel.service.ts` e `team-whatsapp.schema.ts` são legados: só as inserções; `team-alert.repository.ts` e `alertGroupOf` não mudam). GK13 (o motivo vai na resposta, nunca em log).

**Passos:**
1. [ ] RED (`team-alert-closure.integration.spec.ts`): `it('mapa só com os destinatários encerrados do alerta; motivo, hora e quem')`; `it('reaberta — fora do mapa')`.
2. [ ] RED (`team-alert-panel.closure.integration.spec.ts`, `getPanel` real): `it('aceite 20: encerrada continua no mesmo grupo e traz closure com nome e motivo')`; `it('ciente depois do encerramento — grupo Ciente e closure mantido')`; `it('sem encerramento — closure null')`; `it('quem encerrou removido — byName null; nome que parece telefone mascarado sem a chave')`.
3. [ ] GREEN; specs existentes do painel verdes (ajustar só asserções de forma exata que quebrarem com o campo novo, listando no report); typecheck; eslint (GK9); validação (`TESTCONTAINERS_ENABLED=1`); `--changed`.

**Aceite:** 20 (back). **Risco: médio** (leitura nova num contrato existente; quem vê o painel não muda). Revisão `sonnet`.
**Foco da revisão:** contrato público do painel ganha um campo obrigatório; grupo inalterado; nada em log.

## Task 10 — Prova parametrizada do alcance em todas as rotas (back)

**Arquivos:** criar `backend/src/modules/team-whatsapp/team-pendency.scope-routes.integration.spec.ts` (só teste; **não** edita código de produção).

**Interfaces:** consome `TeamPendencyService`, `TeamPendencyActionsService`, `TeamAlertAckService` reais e as fixtures da T1.

**Contexto vinculado:**
- Aceite 12: "ADMIN vê todas as pendências. SUPERVISOR que gere um setor vê as das pessoas daquele setor, inclusive em alerta de outro autor, e as dos alertas que enviou; não vê as demais. Um teste parametrizado prova o 404 fora do alcance em toda rota de pendência (lista por id, ações, lista de destinos, ciência manual e desfazer), e o contador não conta o que está fora."
- K2-4: "Pendência fora do alcance responde 404 em qualquer rota." Anti-objetivo 1 (texto na T3). Ordem DK9 e DK17: o ator do teste tem `equipe.enviar` e `equipe.urgencia` (concedidas pela fixture) e é remetente, para que o 404 seja do alcance, não do 403.
- Se algum caso falhar, a T10 para e reporta: a correção é da task dona (T4, T5a, T5b, T7, T8a ou T8b), não desta.

**Passos:**
1. [ ] RED/verde: `it.each(['get','handlers','assume','transfer','addNote','close','reopen','markManual','undoManual'])('aceite 12: fora do alcance — 404 em %s')` (SUPERVISOR de S1 diante de pendência de S2 em alerta de outro autor; `pendency_not_found` nas rotas de pendência e o 404 de envio nas de ciência; comentário: pega rota nova sem `requireVisiblePendency`); `it('aceite 12: lista e contador não trazem a pendência fora do alcance')`; `it('aceite 12: a mesma pendência no setor gerido — nenhuma rota devolve 404')` (controle positivo); `it('aceite 12: ADMIN alcança todas')`.
2. [ ] Typecheck; eslint (GK9); validação (`TESTCONTAINERS_ENABLED=1`); `--changed`.

**Aceite:** 12 (prova completa). **Risco: alto** (só teste, mas é a prova do Anti-objetivo 1). Revisão `sonnet`.
**Foco da revisão:** cada rota de pendência e de ciência manual coberta; o ator tem as chaves (o 404 não é mascarado por 403); controle positivo presente.

## Task 11 — Front: contrato, hooks, rótulos, mensagens e ações puras

**Arquivos:** criar `frontend/src/features/team-pendencies/{schemas,api,labels,pendency-errors,pendency-actions}.ts` (CK8), specs `schemas.spec.ts`, `api.spec.ts`, `labels.spec.ts`, `pendency-errors.spec.ts`, `pendency-actions.spec.ts`.

**Interfaces:** consome `api` (`lib/api-client`), `readApiErrorBody` (`lib/api-error.ts`), o padrão de `fetchPanorama` (`features/team-panorama/api.ts:19-54`: 403 `team_whatsapp.forbidden` → `null`; `retry: false`; `refetchOnMount: 'always'`), `ALERT_GROUPS`/rótulos do painel (`features/team-whatsapp/alert-schemas.ts`), `toast` como em `features/chat/api.ts` (`useConversationAction`, `:305-320`). Produz CK8.

**Contexto vinculado:**
- K2-2 (rótulos de situação e "(inativo)"/"(fora do alcance)"), K2-5 ("mídia só como 'Áudio', 'Imagem' ou 'Arquivo'"; "Sem tempo real: a tela recarrega após cada ação e ao voltar a ela"), K2-6 ("Calculado ao abrir o sistema e ao abrir a tela, sem tempo real. Só para remetentes."), K2-7 (códigos `pendency_taken`, `pendency_changed`, `not_handler`, `ack_exists`; destino 404 "como usuário inexistente").
- C3: "Os 409 levam `code` e, quando a tela precisa, `detail` com id e nome (…). O front lê pelo `readApiErrorBody`."
- DK19 (rótulos e linhas), DK20 (matriz de ações, toasts de sucesso e de erro, invalidação em 403/404/409/422), DK21 (contador: `staleTime: Infinity`, sem refetch por foco/reconexão/intervalo; `null` em 403 forbidden). CK2 (forma da API). GK7 (tolerante: `.nullish()`), GK10.

**Passos:**
1. [ ] RED (`schemas.spec.ts`): `it('aceita o item completo de CK2')`; `it('tolera campos novos ausentes (closure, notes, lastReply, conversationId)')`.
2. [ ] RED (`labels.spec.ts`): um `it` por situação com o texto exato; `it('handlerLabel — (inativo), (fora do alcance), ninguém, Usuário removido')`; `it('replyLabel — texto, Áudio, Imagem, Arquivo, (Mensagem sem texto)')`; `it('noteLine — prefixos Contato:, Ao assumir:, Encerramento:, Passagem de turno:')`; `it('closureLine — Tratativa encerrada por {nome}: {motivo}')`; `it('manausTime — dd/MM HH:mm em America/Manaus')`.
3. [ ] RED (`pendency-errors.spec.ts`): um `it` por código de DK20; `it('pendency_taken sem detail — Outra pessoa assumiu…')`; `it('parseHandlerDetail tolera detail ausente ou inválido')`.
4. [ ] RED (`pendency-actions.spec.ts`): `it('Sem responsável — Assumir; ADMIN também Transferir e Encerrar sem ciência')`; `it('minha — Transferir, Registrar contato, Encerrar sem ciência')`; `it('de outro ativo — Assumir de outro; ADMIN também as três')`; `it('responsável inativo ou fora do alcance — Assumir')`; `it('Encerrada — Reabrir a tratativa só para responsável ou ADMIN')`; `it('Ciente — nenhuma de tratativa')`; `it('sem equipe.enviar — nenhuma ação'); it('ciência manual só com equipe.enviar e equipe.urgencia; Desfazer só em MANUAL')`.
5. [ ] RED (`api.spec.ts`, `ky` mockado): `it('lista serializa situations, sectorId, mine, days e page')`; `it('403 team_whatsapp.forbidden — lista e contador resolvem null')`; `it('contador sem refetch por foco')`; `it('ação: sucesso invalida team-pendencies; 409 — toast do code e invalida')`.
6. [ ] GREEN; `npx tsc -b`; eslint (GK9); validação; `--changed`.

**Aceite:** base de 12, 14–18, 21, 22 (tela). **Risco: alto** (contrato consumido pela tela; não é categoria crítica: a regra é do servidor). Revisão `sonnet`.
**Foco da revisão:** contrato tolerante; textos exatos; `readApiErrorBody` fora da renderização; matriz de ações coerente com DK11–DK14.

## Task 12 — Front: tela "Pendências da equipe" (rota, filtros, linhas)

**Arquivos:** criar `frontend/src/routes/_authenticated/pendencias-equipe.tsx` (`createFileRoute('/_authenticated/pendencias-equipe')`, só renderiza `PendenciesPage`, como `caixa-de-entrada.tsx`), `features/team-pendencies/components/{pendencies-page,pendency-filters,pendency-row}.tsx`, specs `pendencies-page.spec.tsx`, `pendency-filters.spec.tsx`, `pendency-row.spec.tsx`; modificar `frontend/src/routeTree.gen.ts` (gerado pelo `TanStackRouterVite`, `vite.config.ts:5`; ver "Não verificado").

**Interfaces:** consome CK8 (T11), `useAuthStore` (papel e id), `usePermission`. Produz `PendenciesPage()` e `PendencyRow({ item, me, renderActions? })` (`renderActions?: (item: TeamPendencyItem) => ReactNode`, preenchido pela T13).

**Contexto vinculado:**
- K2-5 inteiro (campos da linha, filtros, padrão, período, ordem feita pelo servidor, "Abrir conversa" só a quem tem acesso à caixa e com mensagem, "Ver resultado do alerta" só com `canViewDispatch`, sem tempo real: recarrega ao voltar). "Nenhuma outra mensagem da conversa aparece."
- Aceite 14: "A linha mostra os campos de K2-5. Em 'Respondeu, sem ciência', aparece só o texto da última resposta ligada ao alerta, e mídia aparece como 'Áudio', 'Imagem' ou 'Arquivo'. O telefone segue `telefone.ver_completo`." Aceite 15: "Abertas aparecem sem limite de data; 'Ciente' e 'Encerrada sem ciência' mostram 7 dias, ou 30 na opção." Aceite 22: "'Abrir conversa' só aparece a ADMIN e OPERATOR e só quando há mensagem do envio. 'Ver resultado do alerta' só ao ADMIN e ao autor." Aceite 12: "VIEWER não consulta."
- DK19 inteiro (textos exatos, estados de carregando/erro/vazio/não remetente/`truncated`, filtros em estado local, página volta a 1 ao trocar filtro), DK8 (rotas dos links: `/inbox/$conversationId`, `/whatsapp-equipe/$dispatchId`). GK10.

**Passos:**
1. [ ] RED (`pendency-filters.spec.tsx`): `it('padrão — Sem responsável, Em tratativa e Em tratativa — atrasada marcadas')`; `it('aceite 15: Período só aparece com Ciente ou Encerrada sem ciência e troca 7/30')`; `it('Setor lista Todos os setores e os setores da resposta; Minhas alterna')`; `it('trocar filtro volta à página 1')`.
2. [ ] RED (`pendency-row.spec.tsx`): `it('aceite 14: pessoa, setor e turno do envio; telefone; alerta com autor e hora; prazo de ciência; grupo; responsável; situação; anotações')`; `it('aceite 14: Respondeu, sem ciência — Última resposta: Áudio; outros grupos sem a linha')`; `it('aceite 14: telefone completo quando vem phoneE164; senão mascarado; sem telefone')`; `it('aceite 22: Abrir conversa só com conversationId e papel ADMIN/OPERATOR')`; `it('aceite 22: Ver resultado do alerta só com canViewDispatch')`; `it('closure — Tratativa encerrada por {nome}: {motivo}')`.
3. [ ] RED (`pendencies-page.spec.tsx`, hooks mockados): `it('título Pendências da equipe e a lista na ordem da resposta')`; `it('aceite 12: VIEWER — nenhuma consulta')`; `it('403 forbidden — Esta tela é para quem envia mensagens à equipe.')`; `it('carregando, erro com Tentar de novo, vazio')`; `it('truncated — aviso dos 2.000')`; `it('paginação Anterior/Próxima')`; `it('ao montar invalida o contador')`.
4. [ ] GREEN; regenerar `routeTree.gen.ts`; `npx tsc -b`; eslint (GK9); validação; `--changed`; smoke no navegador (≤ ~10 chamadas, uma passada na rota).

**Aceite:** 12 (VIEWER), 14, 15 (tela), 22. **Risco: médio** (a regra de alcance é do servidor; a tela só exibe). Revisão `sonnet`.

## Task 13 — Front: ações da tela de pendências

**Arquivos:** criar `frontend/src/features/team-pendencies/components/{pendency-actions-bar,pendency-text-dialog,pendency-transfer-menu}.tsx`, specs `pendency-actions-bar.spec.tsx`, `pendency-text-dialog.spec.tsx`, `pendency-transfer-menu.spec.tsx`; modificar `components/pendencies-page.tsx` (**só** passar `renderActions` à `PendencyRow`).

**Interfaces:** consome CK8 (`pendencyActions`, `usePendencyAction`, `usePendencyHandlers`, `invalidatePendencies`, `pendencyErrorText`), `ManualAckDialog` (`features/team-whatsapp/components/manual-ack-dialog.tsx`), `useManualAck`/`useUndoManualAck` (`features/team-whatsapp/alert-actions-api.ts:47,60`, usados sem editar o arquivo: a invalidação da lista vai no `onSettled` da chamada `mutate`), `useIsMutating`, `alertActionErrorText` (`features/team-whatsapp/alert-actions-api.ts:80`, importado sem editar o arquivo). Modelo de diálogo: `features/chat/components/conversation-action-dialog.tsx`.

**Contexto vinculado:**
- K2-7 (ações e quem; "Registrar contato: (…) anotação obrigatória (até 200: o que fez e por qual meio)"; "Encerrar sem ciência: (…) motivo obrigatório (até 200)"; "Assumir de outro: (…) com observação opcional"; "A tela de pendências oferece 'Registrar ciência manual' e 'Desfazer ciência manual', com as mesmas regras do painel"). K2-5: "a tela recarrega após cada ação".
- Aceite 21: "Ciência manual e desfazer pela tela de pendências funcionam para quem tem `equipe.urgencia` e vê a pendência, mesmo sem ver o envio (…)."
- Erros da ciência manual pela tela (DK20): `team_whatsapp.ack_exists`, `team_whatsapp.ack_not_manual` e o 404 do envio usam o mesmo texto do painel, por `alertActionErrorText`; se `useManualAck`/`useUndoManualAck` já mostram o toast por ele, não duplicar; o texto "A pessoa já deu ciência; não é preciso encerrar." é só do Encerrar.
- DK20 inteiro (botões, diálogos, textos, toasts, erros por `code`, invalidação), DK11–DK14 (o que cada pedido leva: `expectedHandlerId` = responsável mostrado na linha). Painel de hoje: ciência manual exige `equipe.enviar` **e** `equipe.urgencia` (`alert-panel.tsx:244-249`); observação obrigatória de 1 a 200 (`manual-ack-dialog.tsx:18,30`). GK10.

**Passos:**
1. [ ] RED (`pendency-text-dialog.spec.tsx`): `it('obrigatório — Confirmar desligado vazio; 200 no máximo; manda aparado')`; `it('opcional — vazio não manda note')`; `it('Cancelar fecha sem chamar')`.
2. [ ] RED (`pendency-transfer-menu.spec.tsx`): `it('lista de pendencies/:id/handlers sem o responsável atual')`; `it('escolher abre Transferir para {nome}? e manda toUserId e expectedHandlerId')`; `it('404 user.not_found — Esta pessoa não pode receber a pendência. Escolha outra.')`.
3. [ ] RED (`pendency-actions-bar.spec.tsx`, hooks mockados): `it('aceite 16: Assumir — um clique com expectedHandlerId do inativo')`; `it('aceite 17: Assumir de outro — diálogo com Observação (opcional)')`; `it('aceite 18: Registrar contato e Encerrar sem ciência exigem texto')`; `it('Reabrir a tratativa — confirmação')`; `it('aceite 21: Registrar ciência manual e Desfazer ciência manual pela tela, com recarga da lista')`; `it('erro da ciência manual (ack_exists, ack_not_manual, 404) — texto de alertActionErrorText, o mesmo do painel')`; `it('409 pendency_taken — toast com o nome e recarga')`; `it('botões desligados durante o envio')`.
4. [ ] GREEN; `npx tsc -b`; eslint (GK9); validação; `--changed`; smoke no navegador (≤ ~10 chamadas).

**Aceite:** 16–18, 21 (tela). **Risco: médio** (a decisão é do servidor; a tela só oferece). Revisão `sonnet`.

## Task 14 — Front: item de menu com contador

**Arquivos:** modificar `frontend/src/lib/nav.ts` (item novo em `NAV` depois de "WhatsApp da equipe", ~L88; campo opcional `requiresTeamSender?: true` em `NavItem`; `navSection` ganha o 4º parâmetro opcional `opts?: { teamSender?: boolean }` que esconde itens com a marca quando `teamSender` não é verdadeiro), `components/layout/sidebar.tsx` (chama `usePendencyCount`, passa `teamSender` e o badge `'/pendencias-equipe'`); criar specs `lib/nav.pendencies.spec.ts`, `components/layout/sidebar.pendencies.spec.tsx`.

**Interfaces:** consome `usePendencyCount` (T11), `navSection`/`itemAllows`/`NavItem` (`lib/nav.ts:54,149-178`), `badges`/`UnreadBadge` (`sidebar.tsx:49,93-130`). Produz o item de menu.

**Contexto vinculado:**
- K2-6: "Contador no menu. Número de pendências 'Sem responsável' com prazo de ciência vencido, no alcance de quem olha, sem limite de data. Calculado ao abrir o sistema e ao abrir a tela, sem tempo real. Só para remetentes."
- K2-5: "Quem não é remetente recebe 403 e não vê o item de menu. A tela do VIEWER não consulta. SUPERVISOR/OPERATOR sem setor gerido recebe o 403 e o item some sem erro, como no panorama." Aceite 12: "SUPERVISOR ou OPERATOR sem setor gerido não vê o item de menu nem erro, mesmo tendo enviado alertas antes."
- DK21 inteiro (item escondido enquanto carrega e com `null`; `enabled` só para ADMIN/SUPERVISOR/OPERATOR). Limite conhecido e aceito: a paleta de comandos e `canAccessPath` (`lib/nav.ts:158-163`) não olham `requiresTeamSender` e continuam mostrando/permitindo `/pendencias-equipe` ao não remetente; a tela trata o `null` ("Esta tela é para quem envia mensagens à equipe."). Não mexer em `canAccessPath` nem na paleta. GK9 (`nav.ts` e `sidebar.tsx` são legados: só as inserções; `navSection` só ganha parâmetro opcional; specs existentes verdes).

**Passos:**
1. [ ] RED (`nav.pendencies.spec.ts`): `it('item Pendências da equipe para ADMIN, SUPERVISOR e OPERATOR quando teamSender; nunca para VIEWER')`; `it('sem teamSender — item escondido; outros itens iguais')`.
2. [ ] RED (`sidebar.pendencies.spec.tsx`): `it('remetente — item com o número do contador')`; `it('aceite 12: 403 forbidden (null) — item some, sem erro nem toast')`; `it('aceite 12: VIEWER — nenhuma consulta')`; `it('carregando — item escondido')`; `it('zero — item sem número')`.
3. [ ] GREEN; specs existentes de `nav` e `sidebar` verdes; `npx tsc -b`; eslint (GK9); validação; `--changed`.

**Aceite:** 12 (menu), 15 (contador na tela). **Risco: médio.** Revisão `sonnet`.

## Task 15 — Front: painel do alerta mostra a tratativa encerrada

**Arquivos:** modificar `frontend/src/features/team-whatsapp/alert-schemas.ts` (pessoa ganha `closure` `.nullish()`, ~L43-48), `alert-labels.ts` (função `closureText`, perto de `personDetails` ~L107-118), `components/alert-panel.tsx` (`PersonItem` ~L81-106 mostra a linha); criar specs `alert-closure.spec.ts`, `components/alert-panel.closure.spec.tsx`.

**Interfaces:** consome CK9. Produz `closureText(closure): string | null`.

**Contexto vinculado:**
- K2-2: "o painel do alerta mantém a pessoa no grupo em que está, com a marca 'Tratativa encerrada por {nome}: {motivo}'." Aceite 20 (mesmo texto).
- DK18 (nome nulo → "Usuário removido"). GK7 (tolerante), GK9 (três legados: só as inserções; specs existentes do painel verdes).

**Passos:**
1. [ ] RED (`alert-closure.spec.ts`): `it('aceite 20: Tratativa encerrada por {nome}: {motivo}')`; `it('byName nulo — Usuário removido')`; `it('sem closure — null')`.
2. [ ] RED (`alert-panel.closure.spec.tsx`): `it('aceite 20: pessoa encerrada aparece no mesmo grupo com a linha')`; `it('resposta sem closure (back antigo) — nada muda')`.
3. [ ] GREEN; `npx tsc -b`; eslint (GK9); validação; `--changed`.

**Aceite:** 20 (tela). **Risco: baixo.** Revisão `sonnet`.

## Task 16 — Front: Novidades do K2

**Arquivos:** modificar `frontend/src/release-notes.ts` (entrada nova no topo de `RELEASE_NOTES`, ~L32-33); criar `frontend/src/release-notes.pendencias.spec.ts`.

**Interfaces:** consome `ReleaseNote`/`ReleaseNoteItem` (`release-notes.ts:21-36`). Produz CK10.

**Contexto vinculado:**
- C2: "Novidades. Uma entrada por lote." Aceite 24: "As Novidades têm a entrada de K2."
- `frontend/CLAUDE.md`: entrada nova sempre no TOPO, ordem decrescente por `version` (`'YYYY.MM.DD.n'`); texto em PT-BR para o operador; `where` só com tela para linkar. Topo de hoje: `2026.11.21.2` (K1). DK22 (versão `2026.11.21.3`, data `2026-11-21`, título "Pendências da equipe", três itens, sem nome ou telefone de exemplo).

**Passos:**
1. [ ] RED (`release-notes.pendencias.spec.ts`): `it('aceite 24: entrada K2 no topo, versão 2026.11.21.3, data 2026-11-21, título Pendências da equipe, item com where /pendencias-equipe')`; `cd frontend && timeout 600 gate --test src/release-notes.spec.ts` verde.
2. [ ] GREEN; `npx tsc -b`; validação; `--changed`.

**Aceite:** 24. **Risco: baixo.** Revisão `sonnet`.

---

## Fechamento (principal)

1. Conferir o ledger: 18 tasks aceitas; revisões conforme cada task; `tsc` de back e front depois de cada onda (GK7); os testes do Rastreio presentes e verdes.
2. Conferências do lote: `grep -rn "pendencyHandlerId\|pendencyClosedAt\|pendencyDueAt" backend/src --include=*.ts` (escrita só em `team-pendency-write.repository.ts`, GK3); `grep -rn "teamPendencyNote\.\(update\|delete\)" backend/src` vazio; `git diff --stat feat/caixa-situacao` sem `team-whatsapp.policy.ts`, `team-actor.query.ts`, `team-alert.repository.ts`, `team-alert.rules.ts`, `tracking/`, `team-alert-manual-ack.ts`, catálogo de permissões, `features/chat/` (GK1); a migração com `SET LOCAL lock_timeout` e sem `UPDATE`/`DROP` (GK12); nenhum `logger` novo com texto (GK13).
3. Revisão final do conjunto com `opus` (diff inteiro contra `feat/caixa-situacao`).
4. Gates completos, **um de cada vez**, nada mais rodando (memória "gate completo sozinho"): back com `NODE_OPTIONS=--max-old-space-size=6144` e `TESTCONTAINERS_ENABLED=1`, depois front, `--base origin/main`, no estado final; comparar com os logs finais do K1 em `.superpowers/sdd/2026-11-21-orgamind-gbr-etapa5-lote-k1-caixa/`; bloquear violação nova ou agravada; conferir `max-lines-per-function` 50 dos specs novos.
5. QA visual (agente `qa`, roteiro Node com `@playwright/test`, senha do seed lida no processo e nunca impressa, login 5/min) na stack `orgamind-turnos-qa` (sem worker nem Evolution: a ciência automática não acontece no QA; fica provada pelos testes das T6, T7 e T8b). Dados fictícios por SQL com prefixo `qa_k2_` e reversão em `qa/qa-data.md`: ADMIN; SUPERVISOR gestor de S1 com `equipe.urgencia` concedida; OPERATOR gestor de S2; OPERATOR sem setor gerido que já enviou alerta; dois alertas (autor ADMIN) com pessoas em S1, S2 e uma nominal; pendências sem responsável vencidas, em tratativa, atrasada, encerrada e ciente; uma resposta de áudio ligada. Até 5 critérios por despacho:
   - **QA-1 (alcance e menu):** SUPERVISOR de S1 vê só as de S1 e o contador certo; OPERATOR sem setor gerido não vê o item nem erro; VIEWER sem item.
   - **QA-2 (linha):** campos de K2-5; "Última resposta: Áudio"; telefone mascarado sem a chave; "Abrir conversa" para OPERATOR e não para SUPERVISOR; "Ver resultado do alerta" só para o autor/ADMIN.
   - **QA-3 (tratativa):** Assumir, Registrar contato, Encerrar sem ciência (motivo), Reabrir; rótulos e prazos; painel do alerta com "Tratativa encerrada por …" no mesmo grupo.
   - **QA-4 (conflito na tela):** duas abas na mesma pendência; A assume; B tenta Assumir com a tela antiga → "{A} assumiu esta pendência antes de você." e recarga.
   - **QA-5 (ciência manual pela tela):** SUPERVISOR de S1, sem ver o envio, registra e desfaz a ciência manual; filtros e período 7/30.
6. Atualizar "Estado" deste plano; registrar na spec, em "Para a GBR confirmar", as decisões de "Dúvidas de produto".
7. Commits do lote (docs: plano; back; front), push e PR **rascunho** sobre `feat/caixa-situacao` (C1), com os avisos: "Vai para produção junto com os Lotes F–K1"; "migração aditiva: seis colunas `pendency*` em `TeamWhatsappRecipient` e tabela `TeamPendencyNote`, com `lock_timeout`"; "ciência manual passa a valer para quem tem a pendência no alcance, sem ver o envio". **Sem merge, sem deploy.**

## Dúvidas de produto (decididas provisoriamente; para a GBR confirmar)

- **Registrar contato em pendência ciente ou encerrada (DK13):** o servidor aceita (K2-7: a condição é só "ainda é o responsável"), para o contato feito no minuto em que a ciência chega não se perder; a tela oferece o botão só nas abertas (DK20). Recomendação: manter.
- **"Assumir" de quem já é o responsável e "Transferir" para o próprio responsável (DK11, DK12):** conferidos na linha travada; 204 sem gravar se nada mudou, 409 `pendency_changed` se ficou ciente, foi encerrada ou transferida. Recomendação: manter.
- **Paleta e `canAccessPath` mostram a rota ao não remetente (DK21, limite conhecido):** a tela trata o 403 com "Esta tela é para quem envia mensagens à equipe.", sem dado. Recomendação: aceitar neste lote.
- **Motivo do encerramento também vira anotação (DK2, DK14):** para não se perder ao reabrir. Recomendação: manter.
- **Observação de "Assumir"/"Assumir de outro" vira anotação "Ao assumir: …" (DK2, DK11).** Recomendação: manter.
- **Transferir sem observação (DK12):** a spec não prevê. Recomendação: manter.
- **Encerrada pelo ADMIN sem responsável, ao reabrir, volta a "Sem responsável" (DK14).** Recomendação: manter.
- **Telefone da linha vem do número gravado no envio (DK8):** o painel do alerta não mostra telefone hoje; segue a regra de telefone do WhatsApp da equipe. Envio antigo sem número gravado mostra "Sem telefone".
- **Período pela data do alerta; teto de 2.000 linhas por consulta da lista, lidas da mais nova para a mais antiga, com aviso; contador sem teto, por lotes (DK7).** Recomendação: manter; medir em produção.
- **Contador sem número quando é zero; item some enquanto carrega (DK21).** Recomendação: manter.

## Não verificado (conferir na task dona)

(Conferidos neste plano: campos de `TeamWhatsappRecipient` e `TeamWhatsappDispatch`, sem `@@map` (`schema.prisma:1820-1979`); `MessageKind` (`:1266-1276`); `TeamActor`, `isTeamSender`, `canViewDispatch` (`team-whatsapp.policy.ts:25-85`); `findTeamActor` (`team-actor.query.ts:10-31`); ordem de `requireAlertRecipient` (`team-alert-ack.service.ts:83-96`); `loadAlertHeader` = 422 sem `ackDeadlineMinutes` e `AlertPersonRow`/`factsOf` exportados (`team-alert.repository.ts:35-120`); `alertDeadlineAt` e `alertGroupOf` exportados (`team-alert.rules.ts:92,143`); `phoneView` (`phone-visibility.ts:14-28`); `recordChange(tx, change)` sem filtrar campos iguais (`audit.service.ts:114-132`); `route-parity.spec.ts` lista `TeamAlertController` e `TeamPanoramaController` em `PARITY` (`:100-112`); fixtures do K1 exportam `startOwnershipDb`, `withConnectionLimit`, `waitForAnyLockWait`, `ExternalLock`, `T0`, `at`; padrão de 403 → `null` em `features/team-panorama/api.ts:19-36`; rota `/inbox/$conversationId` existe; `TanStackRouterVite` em `vite.config.ts:5`; urgência só dispara "agora" (`team-whatsapp.purpose.ts:94`, `when: ['now']`), então não há alerta agendado ou cancelado; `recordAlertReply(db: Pick<PrismaService, 'teamWhatsappRecipient'>, input)` com três `UPDATE` sem transação (`tracking/team-alert-reply.ts:32-67`); `TeamWhatsappRecipient.createdAt` (`schema.prisma:1970`); `alertActionErrorText` exportado (`alert-actions-api.ts:80`).)

- Nome do modelo/tabela que `findEffectivePermissions` lê (para `grantPermission`/`revokePermission` das fixtures, T1) e se o seed dos testcontainers já popula a matriz padrão (`permissions/permissions.query.ts`).
- `User.sectorId` como setor principal atual (inferido de `TeamTargetUser.sectorId` e `canSendToUser`, `team-whatsapp.policy.ts:37-73`; T2/T3 confirmam no `model User`).
- Valores exatos de `AlertGroup` (CK2 assume `'no_delivery' | 'no_reply' | 'replied' | 'acked'`; T2 copia de `team-alert.rules.ts`).
- Campo de texto e de tipo de `Message` usados pelo painel em `messageView` (`team-alert-panel.service.ts:176-187`) e `Message.conversationId` (T5a).
- Campos de `input` de `recordAlertReply` além de `originalId`, `messageId`, `receivedAt`, `isAck` (`tracking/team-alert-reply.ts:44-68`) para as corridas (T6, T7, T8b); se o `tx` da `$transaction` não satisfizer o `Pick` no `tsc`, ajustar o tipo só no spec, nunca em `tracking/*`.
- Como os specs de controller do módulo montam o `RolesGuard` real e o `req.user` (T5a, T5b, T7, T8a, T8b), e o teste de "mistura" `@Roles`/`@RequirePermission` em `route-parity.spec.ts` (T5a).
- Ordenação por relação/cursor no Prisma 6 para a leitura do contador em lotes (DK7, T5b); se `cursor` com `where` relacional ficar caro, paginar por `id > último` no `where`.
- Como os lotes anteriores regeneraram `routeTree.gen.ts` (`git log -p -- frontend/src/routeTree.gen.ts`); sem comando próprio, subir o `vite` de desenvolvimento por alguns segundos para o plugin gerar, ou editar à mão espelhando as entradas de `whatsapp-equipe` (T12). Sem runner novo.
- Formatador de telefone usado pela tabela de destinatários do envio (`features/team-whatsapp/components/recipient-table.tsx`) para a linha (T12).
- Caminho e campos de `useAuthStore` (id e papel) e assinaturas de `useManualAck`/`useUndoManualAck` (T12, T13).
- Volume em produção de `TeamWhatsappRecipient` de alertas abertos (a consulta sem índice novo e o teto de 2.000, DK1/DK7); índice, se preciso, em migração separada com `CONCURRENTLY`.
