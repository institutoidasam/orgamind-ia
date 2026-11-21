# OrgaMind, Etapa 5 GBR, Lote K3: passagem de turno, etiquetas de envio e prova do robô (MSG-03). Implementation Plan

> **Para os agentes:** executar pela skill `sdd` (TDD, ledger em `.superpowers/sdd/2026-11-21-orgamind-gbr-etapa5-lote-k3-passagem-turno/progress.md`). **Sem commit/push**: nenhuma task commita; a principal integra e commita o lote. Branch `feat/passagem-turno`, criado de `feat/pendencias-equipe` depois do commit do K2. Fechamento de task por `gate --changed --base feat/pendencias-equipe`. Regras dos agentes: `.superpowers/sdd/2026-11-21-orgamind-gbr-etapa5-lote-k3-passagem-turno/{implementer-rules,reviewer-rules}.md` (criadas na Preparação). Linhas citadas são pistas e podem ter mudado.

**Goal:** (1) "Passar meu turno" e "Passar as conversas de {nome}" na caixa, conversa a conversa, com observação obrigatória, puladas com motivo e linha "passagem de turno" no histórico; (2) filtro "Recebidas na passagem de turno"; (3) "Passar minhas pendências" (e as de outro, pelo ADMIN) com destino que precisa ver cada pendência; (4) etiquetas de envio da equipe nas mensagens e "Último envio à equipe nesta conversa" no topo; (5) testes que provam K3-7 (a)–(e), com as correções que eles revelam; (6) Novidades.

**Architecture:** sem migração (spec, Restrições). Back — passagem de conversas num serviço novo do módulo `chat` que, para cada conversa, abre a **própria** transação curta do K1 (`runOwnershipTransaction` → `lockConversation` → decisão pura → `applyOwnershipChange`) e publica `conversation.updated` depois de cada commit; passagem de pendências num serviço novo do `team-whatsapp` que, para cada pendência, chama `runPendencyTransition` do K2 (conflito vira "pulada com motivo"). Filtro "Recebidas" por consulta crua que casa a linha `SHIFT_HANDOVER` com `Conversation.assignedAt`. Etiquetas por uma consulta crua por página em `listMessages`; topo por rota de leitura no `team-whatsapp` que reaproveita alcance e situação do K2. Robô: duas correções pequenas (mídia pausa sempre; nada relança depois de o Dify responder) e testes. Front — diálogo de passagem na caixa e na tela de pendências, aba nova na lista, etiqueta na bolha e faixa no topo da conversa.

**Tech Stack:** NestJS + Prisma 6 + Zod v4 + Vitest/testcontainers no back; React + TanStack Router/Query + ky 2 + Vitest/Testing Library no front. **Sem migração, sem dependência nova, sem runner novo, sem chave de permissão nova.**

**Spec:** `docs/superpowers/specs/2026-11-21-orgamind-gbr-etapa5-pendencias-caixa.md` (APROVADA) — K3-1..K3-7, Aceite 25–31, Restrições, "O que fica decidido" (K1-7, K1-9, K2-4, K2-7), Anti-objetivos, Limites conhecidos, "Para a GBR confirmar" 11–17. Mapas: `.superpowers/sdd/2026-11-21-orgamind-gbr-etapa5-lote-k3-passagem-turno/{map-back-posse-etiquetas,map-back-robo,map-front}.md`. Padrões: planos do K1 (`…-lote-k1-caixa.md`, Molde B) e do K2 (`…-lote-k2-pendencias.md`, DK10/DK24).

## Estado (21/11/2026)

- Plano escrito; nenhuma task começou. Base: commit do K2 em `feat/pendencias-equipe` (a registrar na Preparação). Não commitados de fora do lote: `.playwright-mcp/`, `reports/`, `research_notes/`, `tutoriais/` (preservar).
- 21/11: revisão 1 (opus) NEEDS_FIXES (`.superpowers/sdd/2026-11-21-orgamind-gbr-etapa5-lote-k3-passagem-turno/plan-review-1.md`); ajustes aplicados: I1 etiqueta e topo usam `COALESCE(d."firedAt", d."createdAt")` (DT6, DT7, CT1, T-B4a, T-B4b, teste de envio agendado); I2 `handleSendFailure` nunca relança (DT8, T-B6a, Review Focus 4, teste com `sendBotReply` e `setBotPaused` falhando); I3 passagem de pendências relê o ator e exige `equipe.enviar` logo depois de `isTeamSender` (DT4, GT4, T-B5b, 403 `auth.permission_denied`); M1 lembrete → pendência pelo `parentRecipientId` (DT7, "Não verificado"); M2 T-B4b troca o teste do SUPERVISOR por OPERATOR gestor do setor; M3 T-B2 K3-5 confere "nenhuma `Message` e nenhum job"; M4 pendência já com o destino devolve `already_with_target` (DT4.4, CT2, CT3, DT9, T-B1, T-B5b, T-F4, Dúvidas); M5 T-B2 ganha a corrida passagem × resolver; M6 `handover=true` força o atendente = quem olha (DT3, CT1, T-B3); M7 CT2 exporta `PendencyHandoverInput` (T-B1, T-B5b).
- 21/11: revisão 2 (opus) APPROVED (`plan-review-2.md`); 2 Minor aplicados pela principal: Interfaces da T-B5b com `current` no retorno de `runPendencyTransition`; texto de `other_handler` quando o responsável atual é nulo registrado em "Dúvidas de produto".
- 21/11: branch `feat/passagem-turno` a partir de `39be4e1` (K2). As 15 tasks do plano e a **T-B6c** foram aceitas em 4 ondas. A T-B6c nasceu de um ruling: a T-B6b achou mídia importada (sync de histórico e backfill) acionando o robô, contra K3-7(d), e a spec manda a correção entrar no K3. Isso explica a única exceção da GT1 (`chat-ingest.service.ts` e `chat-history-sync.service.ts`, +2/-2). Rulings, fix rounds (T-F4 e T-B4b, um cada, re-revisados) e o backlog de Minors estão no ledger (`progress.md`).
- Revisão final do conjunto (opus): APPROVED (`final-review.md`), contratos CT1/CT2/CT4/CT5 conferidos campo a campo. Conferências do Fechamento (item 2): GT3 uma transação por item; GT11 os `logger.warn` novos levam só ids.
- Gates completos contra `origin/main`, cada um sozinho. Back: 7803/7833. Front: 2760/2760. Comparados com o K2, houve um agravado no back (`chat.repository.spec.ts` 149→153, pelo mock da T-B4a) e um novo no front (`release-notes.passagem.spec.ts` com 55 linhas). Os dois foram corrigidos e conferidos por eslint focado. O `gate --changed` final passou nos dois lados.
- QA visual na stack local de QA (dados `qa_k3_*`, reversão em `qa/` do ledger): 3 rodadas, 11 critérios. A primeira achou a quarta aba cortada a 1280 px; a correção pôs as abas para quebrar linha (`flex-wrap`), e o reteste passou. O resto passou de primeira, e nenhuma mensagem foi enviada (contagem igual antes e depois).
- **Fechado (21/11):** commits do lote (docs, back, front) e PR rascunho sobre `feat/pendencias-equipe` (#24). Sem merge e sem deploy.

## Preparação (principal, antes da Onda 1)

1. K2 commitado; `git switch -c feat/passagem-turno feat/pendencias-equipe`; registrar o hash no ledger. Em worktree: `backend/.env` fictício e `node_modules` por symlink (memória "gate em worktree").
2. Criar `implementer-rules.md` e `reviewer-rules.md` no workspace do K3 copiando os do K2 e trocando: branch `feat/passagem-turno`, base `feat/pendencias-equipe`, este plano, ledger novo, "Lotes A–K2 prontos; não revisar nem mexer fora do ownership", referências `GTn`/`DTn`/`CTn` anexadas no fim do brief. Manter as lições do K2 (blocos de teste ≤ 50 linhas, `prettier --write` só em arquivo novo, nunca restaurar do git, `PrismaPromise` preguiçoso nas corridas, `waitForAnyLockWait` para `UPDATE` simples, `actorWith`/`permissionsWith`, `nameView`, provedor falso). Review Focus abaixo vai para o `reviewer-rules.md`.
3. Ledger `progress.md` com a referência de partida e os não commitados alheios.

## Decisões deste plano (o que a spec deixa com o construtor)

- **DT1. Rotas da passagem de conversas (K3-1, K3-2).**
  - **Listar as "Em atendimento" de quem sai:** sem rota nova. O front usa a lista atual: `GET chat/conversations?status=open&assignee={fromId}&pageSize=100` ("Em atendimento" = aberta e com atendente = quem sai; a caixa já é compartilhada entre ADMIN e OPERATOR). `total > 100` → aviso (DT5).
  - **Passar:** `POST chat/handover`, controller novo `ConversationHandoverController` (`@Controller('chat')`, sem `@Roles`: cai na regra padrão ADMIN/OPERATOR, como as rotas do K1), corpo CT1, resposta **200** `ShiftHandoverResult`. `actor = { id: req.user.sub, role: req.user.role }` (como o controller do K1).
  - **Destinos:** a rota do K1 `GET chat/assignees` (ADMIN/OPERATOR ativos e com acesso); a tela tira quem sai.
- **DT2. Algoritmo da passagem de conversas** (`ConversationHandoverService.handover(actor, input, now)`). Ordem: 400 (zod) → `from = input.fromUserId ?? actor.id`; `!canHandoverFrom(actor, from)` → **403 `chat.not_assignee`** (`notAssignee()` do K1; só o ADMIN passa as de outro) → destino: `toUserId === from` ou `!findEligibleAssignee(prisma, toUserId)` → **404 `NotFoundError('User', toUserId)`** para o pedido inteiro → para cada id, na ordem do pedido, **uma** `runOwnershipTransaction` curta:
  1. `lockConversation(tx, id)`; `NotFoundError` → pulada `not_found` (só esse erro vira pulo; o resto relança);
  2. `handoverSkipReason(locked, from, to)` (puro, nesta ordem): `resolvedAt` → `resolved` ("já resolvida"); `assignedUserId === to` → `already_with_target` ("já estava com {destino}"); `assignedUserId === null` → `unassigned` ("já sem atendente"); `≠ from` → `other_assignee` ("já com outro atendente");
  3. senão `applyOwnershipChange(tx, audit, handoverChange(locked, { actorId, to, note, now }))` com `actions: ['SHIFT_HANDOVER']`, `assignedUserId: to`, `resolved: false`, `note`, **`pauseBot: true`** (K1-7: "assumir, transferir e passar turno pausam o robô"), `now`. Isso grava a conversa, **uma** linha `SHIFT_HANDOVER` (autor = ator, de = `from`, para = `to`, observação) e a trilha `conversation.assign` (`metadata.kind` = última ação = `SHIFT_HANDOVER`, `conversation-ownership.repository.ts:123`);
  4. depois do commit dessa conversa, `events.publish({ type: 'conversation.updated', conversationId, instanceId })`.
  - Nunca uma transação com N travas. **Repetir o pedido não duplica**: a segunda passada encontra `assignedUserId === to` e pula com `already_with_target`, sem linha nova. Nenhuma mensagem é enviada (K3-5). Não retoma o robô.
- **DT3. Filtro "Recebidas na passagem de turno" (K3-3).** Parâmetro novo da lista `handover=true` (CT1). Regra: conversa aberta, `assignedUserId = quem olha` e **existe** linha de `ConversationHistoryEntry` com `action = 'SHIFT_HANDOVER'`, `toUserId = c.assignedUserId` e **`createdAt = c.assignedAt`**. Por quê: `assignedAt` só é regravado quando o atendente muda, com o mesmo `change.now` que vira o `createdAt` das linhas daquela ação (`conversation-ownership.repository.ts:83,102`); então "a última mudança de atendente foi a passagem" ⇔ essa igualdade, sem depender da ordem de linhas com o mesmo `createdAt` nem do cuid (mapa, item 2). Implementação: `findHandoverReceivedIds(db, userId): Promise<string[]>` com `$queryRaw` (`JOIN` por `conversationId`, `resolvedAt IS NULL`, `archivedAt IS NULL`), e a lista usa `where.id = { in: ids }` junto com `assignedUserId = userId`, combinando com busca, "Não lidas" e "Aguardando". Com `status=resolved` o resultado é vazio. **`handover=true` com `assignee` diferente de `me` (ou ausente):** o servidor força o atendente = quem olha e ignora `assignee` (em `ChatService.listConversations`; a aba do front sempre manda `me`). Front: quarta aba "Recebidas na passagem de turno" nas abas de atendente (só em "Abertas"), que manda `assignee=me&handover=true`.
- **DT4. Passagem de pendências (K3-4, K2-7 "Lista de destinos").** Controller novo `TeamPendencyHandoverController` (`@Controller('internal/team-whatsapp')`), as duas rotas com `@RequirePermission('equipe.enviar')` (a leitura é "para remetentes com `equipe.enviar`", K2-7; sem `@Roles` junto, regra do `route-parity.spec.ts`):
  - `GET pendency-handover/targets?fromUserId=` → `{ items: { id, name }[] }`: remetentes (`isTeamSender`) ativos, com acesso e com `equipe.enviar`, sem `from`, a partir de `listHandlerCandidates` (K2, CK5), nomes por `nameView`, ordem pt-BR.
  - **Lista das pendências de quem sai:** sem rota nova; a lista do K2 ganha o filtro `handlerId` (CT2; `pendencyHandlerId === handlerId`, dentro do alcance de quem olha). O diálogo pede `situations=IN_PROGRESS,OVERDUE&handlerId={eu}` (as minhas) ou `situations=UNASSIGNED,IN_PROGRESS,OVERDUE&handlerId={fromId}` (ADMIN, inclui responsável inativo ou fora do alcance), `pageSize=50`.
  - `POST pendency-handover` (200, `PendencyHandoverResult`). Ordem: 403 do guard → `findTeamActor(actor)`; `!isTeamSender` → 403 `team_whatsapp.forbidden` → `requireSendPermission(actor)`: o ator **relido do banco** sem `equipe.enviar` (o guard só olha o papel do token) → 403 `auth.permission_denied` (`permissionDenied('equipe.enviar')`, GK5/K2-7; função local no serviço novo com `hasPermission`, porque a do K2 não é exportada e `team-pendency-actions.service.ts` não muda) → `from = fromUserId ?? actor.id`; `from !== actor.id && role !== 'ADMIN'` → **403 `team_whatsapp.not_handler`** → destino `findTeamActor(toUserId)`: `!isPendencyHandoverTarget(dest, from)` (inexistente, inativo, sem acesso, não remetente, sem `equipe.enviar` ou igual a `from`) → **404 `NotFoundError('User')`** para o pedido inteiro → `fromActor = findTeamActor(from)` (pode ser nulo) → para cada id, na ordem:
    1. `findPendencyScopeFacts(prisma, id)`; nulo ou `!scopeAllows(pendencyScopeOf(actor), facts)` → pulada `not_found` ("não encontrada"; não revela pendência fora do alcance de quem pede, K2-4);
    2. `!canHandlePendency(dest, facts)` → pulada `out_of_scope_target` ("fora do alcance do destino"), continua com quem sai;
    3. `runPendencyTransition(prisma, audit, { recipientId: id, actorId, now, action: 'team_whatsapp.pendency_handover', kind: 'handover', expect: { handlerId: from, closed: false }, patch: { handlerId: to, assignedAt: now, dueAt: pendencyDueAt(now) }, note: { kind: 'HANDOVER', text: note }, handlerState: { before: handlerStateOf(fromActor, facts), after: 'active' } })`;
    4. conflito → pulada (`handoverSkipOf(conflict, current?.handlerId, to)`; `runPendencyTransition` devolve `{ ok: false, conflict, current }`): `acked` → `acked` ("já ciente"); `closed` → `closed` ("já encerrada"); `handler_changed` com `current.handlerId === to` → **`already_with_target`** ("já estava com {nome}", mesmo nome e texto da caixa, DT2.2); `handler_changed` com outro responsável → `other_handler` ("já com outro responsável"); `missing` → `not_found`.
  - Prazo recomeça (60 min); a anotação `HANDOVER` guarda só a observação (o prefixo "Passagem de turno: " é da tela, K2/DK19). Repetir o pedido: o responsável já é o destino → `handler_changed` com `current.handlerId === to` → pulada `already_with_target`, sem anotação nova. Sem mensagem a ninguém (K3-5).
- **DT5. Tamanhos.** Observação obrigatória, aparada, 1..200, comum a todos os itens. Teto por pedido = o maior `pageSize` da lista de origem: **100 conversas** (`HANDOVER_MAX_CONVERSATIONS`) e **50 pendências** (`PENDENCY_HANDOVER_MAX`); ids repetidos ou acima do teto → 400. Com mais itens, a tela avisa "Mostrando {n} de {total}. Passe estas e abra de novo para passar as demais." Por quê: N transações curtas em série; 100 cabem bem abaixo do timeout de HTTP e o diálogo mostra uma página só.
- **DT6. Etiquetas por mensagem (K3-6).** `ChatRepository.listMessages`, depois do `findMany`, faz **uma** consulta por página, `findTeamDispatchTags(db, conversationId, pageIds)` (`$queryRaw`): `TeamWhatsappRecipient r JOIN "Message" m ON m.id = r."messageId" JOIN "TeamWhatsappDispatch" d ON d.id = r."dispatchId" WHERE m."conversationId" = $conv AND (r."messageId" = ANY($ids) OR r."lastReplyMessageId" = ANY($ids) OR r."ackMessageId" = ANY($ids))`. Entra pela conversa (`Message.conversationId` e `@@index([messageId])`), nunca varre os destinatários por `lastReplyMessageId`/`ackMessageId` (sem índice; K3 não tem migração). Campo opcional `teamTag` em `ChatMessage` (CT1):
  - **Data do envio** = `COALESCE(d."firedAt", d."createdAt")` (`firedAt` é a hora real do disparo; o envio agendado nasce antes de sair, `schema.prisma:1852-1853`), em `sentAt` e `alertSentAt`.
  - mensagem que é `r.messageId`: `d.parentDispatchId` → `{ kind: 'reminder' }` ("Lembrete do alerta"); senão `{ kind: 'dispatch', purpose: fromDbPurpose(d.purpose), sentAt: <data do envio> }` ("Envio à equipe: {finalidade} · {dd/MM HH:mm}"; finalidade nula, envio antigo → "Envio à equipe · {dd/MM HH:mm}");
  - mensagem que é `lastReplyMessageId` ou `ackMessageId` de um alerta (`d.ackDeadlineMinutes` não nulo): `{ kind: 'alert_reply', alertSentAt: <data do envio> }` ("Resposta ao alerta de {HH:mm}"); se casar com mais de um alerta, o mais novo;
  - hora de Manaus no front. Sem `dispatchId` nem `canViewDispatch` na etiqueta: "Ver resultado" fica só no topo (DT7), o que dispensa o ator em `listMessages`.
- **DT7. "Último envio à equipe nesta conversa" (K3-6).** `GET internal/team-whatsapp/conversations/:conversationId/last-dispatch`, controller novo `TeamConversationDispatchController` com `@Roles('ADMIN','OPERATOR')` (quem tem acesso à caixa), serviço novo `TeamConversationDispatchService.lastDispatch(actorId, conversationId, now)`:
  - conversa inexistente → 404 `NotFoundError('Conversation')`; última linha de `TeamWhatsappRecipient` cuja mensagem é desta conversa (`ORDER BY m."createdAt" DESC, m.id DESC LIMIT 1`); nenhuma → `{ last: null }`;
  - `purpose`, `sentAt` (= `COALESCE(d."firedAt", d."createdAt")`, como DT6), `isReminder` (= `parentDispatchId` não nulo);
  - **alerta de referência** = o pai, se lembrete; senão o próprio envio, se tem `ackDeadlineMinutes`; senão nenhum. `dispatchId` = id do alerta de referência (ou do envio, se não é alerta) **só se** `canViewDispatch(actor, { authorId })` desse envio; senão `null` ("Ver resultado" só para quem vê o envio);
  - `pendency` = `{ situation }` **só se** há alerta de referência, a pendência é a linha do alerta (no lembrete, a linha apontada por `TeamWhatsappRecipient.parentRecipientId` do destinatário do lembrete, `schema.prisma:1967`, a mesma coluna de `alertOriginalOf`; nunca por `userId`) e `scopeAllows(pendencyScopeOf(actor), findPendencyScopeFacts(…))`; situação por `handlerStatesFor` + `pendencySituation(…, now)` (K2, CK4/CK5). OPERATOR que não é remetente nunca recebe `pendency` (o alcance começa por `isTeamSender`).
  - Texto da tela: "Último envio à equipe nesta conversa: {finalidade | Lembrete do alerta} · {dd/MM HH:mm}", com " · Pendência: {rótulo da situação}" e o link "Ver resultado" (`/whatsapp-equipe/$dispatchId`) quando vierem. Nunca "origem da resposta".
- **DT8. Prova do robô (K3-7) — o que é testado e o que muda.**
  - (a) pausa: **correção** — a resposta de mídia na conversa que já é do ator e aberta não pausa (`conversation-claim.ts:69-70`, `changed: false`); `ChatMediaService.sendMediaReply` passa a chamar `this.repo.setBotPaused(conversationId)` logo depois de `createOutboundMediaMessage`, como o texto faz (`chat.service.ts:186-187`). `sendTeamMessage` não pausa e não precisa: é a fase 2 e só roda depois de `prepareTeamMessage` (que pausa) ter criado a mensagem (`team-whatsapp-send.processor.ts:236-240`); re-despacho da mesma mensagem não pausa de novo (se alguém retomou o robô no meio, foi escolha manual, Limite conhecido 2).
  - (b) nada além de `resumeBot` zera `botPausedAt`: teste estático que varre `backend/src/**/*.ts` (sem specs nem fixtures) e só aceita `botPausedAt: null` em `chat.repository.ts` (`clearBotPaused`), chamado só por `ChatService.resumeBot`; e a passagem de turno não retoma (T-B2).
  - (c)/(e) **correção** — depois de o Dify responder, nada relança: `sendBotReply` da resposta (`bot-reply.service.ts:124`) fica num `try/catch` que chama `handleSendFailure` (método privado novo): pausa o robô (`setBotPaused`) e grava `bot.reply_failed` com `{ botId, stage: 'send' }` (sem contingência: a resposta pode ter saído). **`handleSendFailure` nunca lança:** pausa e trilha ficam cada uma em seu `try/catch` (se o banco cair logo depois do envio, a exceção não escapa e o BullMQ não retenta), log só com ids e `err.name`; a liberação da trava Redis no `finally` (`:127`) também não relança (a trava expira pelo TTL). `setDifyConversationId` (`:121`) roda antes do envio: se lançar, a retentativa chama o Dify de novo, mas nada saiu, então não duplica. Por quê: o BullMQ retenta (3 tentativas) e chamaria o Dify e o envio de novo, violando "no máximo uma resposta". Exceções antes do Dify continuam relançando (retentativa sem envio).
  - (c) enqueue antes da chave Redis (`chat-ingest.service.ts:788` × `:804`): **limite declarado, sem correção.** Se `botQueue.add` falha, a reentrega cai no P2002 e a mensagem fica sem resposta do robô (aparece na caixa como não lida); nunca duplica. Teste prova o lado "nunca duplica".
  - (c) sem loop, (d) não inicia conversa, (e) vazia: só testes (matriz na T-B6b).
- **DT9. Front — textos exatos.**
  - Caixa: botão "Passar meu turno" no topo da lista; ADMIN, no cabeçalho de conversa com atendente que não é ele: "Passar as conversas de {nome}". Diálogo (título igual ao botão): seção "Conversas em atendimento" (caixas marcadas, "{nome do contato}"); vazio "Nenhuma conversa em atendimento."; "Passar para" (destinos sem quem sai; placeholder "Escolha um colega"); "Observação" (obrigatória, até 200); "Cancelar"/"Confirmar" (desligado sem marcada, sem destino, sem observação ou durante o envio).
  - Pendências: botão "Passar minhas pendências" (com `equipe.enviar`); ADMIN, na linha com responsável que não é ele: "Passar as pendências de {nome}" (nome nulo → "Usuário removido"). Diálogo: "Pendências em tratativa" ("{pessoa} · Alerta de {dd/MM HH:mm} · {situação}"); vazio "Nenhuma pendência em tratativa."; "Passar para"; "Observação" com a dica "Vai para cada pendência como 'Passagem de turno: …'."
  - Resultado: toast "{n} conversa passada para {nome}." / "{n} conversas passadas para {nome}." (idem "pendência"/"pendências"); com puladas, o diálogo mostra "Não foram passadas:" e "{item}: {motivo}". Motivos: conversa `resolved` "já resolvida", `other_assignee` "já com outro atendente", `unassigned` "já sem atendente", `already_with_target` "já estava com {nome}", `not_found` "não encontrada"; pendência `out_of_scope_target` "fora do alcance do destino", `already_with_target` "já estava com {nome}" (igual ao da caixa), `other_handler` "já com outro responsável", `acked` "já ciente", `closed` "já encerrada", `not_found` "não encontrada".
  - Erros (`readApiErrorBody`): `user.not_found` → "Esta pessoa não pode receber {as conversas | as pendências}. Escolha outra."; `chat.not_assignee` → "Só um administrador pode passar as conversas de outra pessoa."; `team_whatsapp.not_handler` → "Só um administrador pode passar as pendências de outra pessoa."; outro → "Não foi possível passar o turno. Tente de novo."
  - Etiqueta: linha pequena acima da bolha (DT6). Faixa do topo: entre `ThreadTop` e `ThreadBody` (DT7); sem envio, nada.
- **DT10. Novidades (C2).** Topo de `RELEASE_NOTES`: `version: '2026.11.21.4'`, `date: '2026-11-21'`, `title: 'Passagem de turno'`; itens (texto final do implementador, curto, sem nome ou telefone): "Passar meu turno" na caixa, com observação, e o filtro "Recebidas na passagem de turno" (`where: '/inbox'`); "Passar minhas pendências" (`where: '/pendencias-equipe'`); etiquetas de envio à equipe e o último envio no topo da conversa (`where: '/inbox'`).
- **DT11. Corridas (GT10).** Molde B do K1 com as fixtures do K1/K2 (`holdConversationLock`, `holdRecipientLock`, `waitForBlocked`, `waitForAnyLockWait`). Cada teste diz no comentário qual implementação errada pega.

## Global Constraints

- **GT1. Escopo.** Back: `backend/src/schemas/contracts/{chat.schema.ts,team-pendency.schema.ts}` (só CT1/CT2), `backend/src/modules/chat/` (arquivos novos; `chat.repository.ts` só `listMessages`/`listConversations`; `chat.service.ts` só `listConversations`; `chat-media.service.ts` só a pausa; `chat.module.ts` só registro), `backend/src/modules/bots/bot-reply.service.ts` (só DT8), `backend/src/modules/team-whatsapp/` (arquivos novos; `team-pendency.service.ts`/`team-pendency.query.ts` só o filtro `handlerId`; `team-whatsapp.module.ts` só registro), `backend/src/modules/permissions/route-parity.spec.ts` (só linhas novas). Front: `frontend/src/features/chat/` e `frontend/src/features/team-pendencies/` (arquivos novos e as inserções que a task diz), `release-notes.ts`. **Não mudam:** `schema.prisma` e migrações, `conversation-ownership.repository.ts`, `conversation-claim.ts`, `conversation-assign.rules.ts`, `team-pendency-write.repository.ts`, `team-pendency.rules.ts`, `team-pendency-scope.repository.ts`, `team-actors.query.ts`, `canViewDispatch`, `isTeamSender`, `tracking/*`, `chat-ingest.service.ts`, `chat-history-sync.service.ts`, `chat-media-download.processor.ts`, `roles.guard.ts`, catálogo de permissões, `features/chat/history-text.ts`.
- **GT2. Spec:** "K3 não tem migração." "Nenhuma chave de permissão nova." "`canViewDispatch` não muda." "Testes nunca mandam WhatsApp real." Anti-objetivos: "Resolver, reabrir, transferir ou passar turno retomarem o robô." "O sistema mandar mensagem a alguém por conta de pendência, prazo ou passagem de turno." "Um SUPERVISOR ver pendência de pessoa fora dos setores que gere e de alerta que não enviou, por qualquer rota." "Texto de resposta, anotação, motivo, observação, nome ou telefone de pessoas da equipe em log. A trilha guarda ids e situações, não textos." K3-1/K3-4: "sempre ação manual: o sistema não detecta fim de turno, não lembra e não transfere sozinho."
- **GT3. Gravação condicional por item.** Cada conversa passa por `runOwnershipTransaction` + `lockConversation` + `applyOwnershipChange` (K1); cada pendência por `runPendencyTransition` (K2/DK10). Uma transação curta por item, em série; **nunca** uma transação com N travas, nunca `Promise.all` de itens. Nenhuma escrita de atendente, `pendency*` ou `TeamPendencyNote` fora desses dois caminhos. Evento `conversation.updated` só depois do commit de cada conversa transferida.
- **GT4. Papéis e códigos.** Caixa: rotas `chat/*` sem `@Roles` (regra padrão ADMIN/OPERATOR). Passar as de outro: só ADMIN (403 `chat.not_assignee` / 403 `team_whatsapp.not_handler`). Destino inválido: 404 `user.not_found` para o pedido inteiro. Pendências: 403 do guard (`equipe.enviar` do token) → 403 `team_whatsapp.forbidden` → 403 `auth.permission_denied` (ator relido sem `equipe.enviar`, K2-7 "Toda escrita exige `equipe.enviar`") → 403 `not_handler` → 404 destino → pulos. Alcance só pelas funções do K2 (`pendencyScopeOf`, `scopeAllows`, `canHandlePendency`, `findPendencyScopeFacts`); ator relido do banco (`findTeamActor`). 400 de validação (observação vazia ou > 200, lista vazia, repetida ou acima do teto).
- **GT5. Validação.** cwd `backend/` ou `frontend/`. Loop: `cd backend && TESTCONTAINERS_ENABLED=1 timeout 600 gate --test src/<arquivo>` (integração) ou sem a variável (unidade); `cd frontend && timeout 600 gate --test src/<arquivo>`. Tipos: back `npx tsc --noEmit -p tsconfig.build.json --tsBuildInfoFile /tmp/<task>.tsbuildinfo` (specs: `-p tsconfig.json`); front `npx tsc -b`. Fechamento: `cd backend && TESTCONTAINERS_ENABLED=1 timeout 600 gate --changed --base feat/pendencias-equipe`; `cd frontend && timeout 600 gate --changed --base feat/pendencias-equipe`. Nunca suíte inteira, gate completo, coverage ou e2e (são da principal). No máximo dois testcontainers ao mesmo tempo.
- **GT6. Compila entre tasks.** Tipo existente só ganha campo opcional (`teamTag?`, `handover?`, `handlerId?`); contrato tolerante no front (`.nullish()`). A principal roda os `tsc` depois de cada onda. Sem commit.
- **GT7. Tempo e dados.** `now` como parâmetro dos serviços novos (o controller passa `new Date()`); fixtures com `createdAt`/`assignedAt` explícitos (`T0`/`at`); nada de `vi.setSystemTime` com linha gravada pelo banco. Nomes e telefones fictícios. Provedor de WhatsApp e Dify sempre falsos.
- **GT8. Tamanho e legado.** Funções e callbacks de `describe`/`it` até 50 linhas, ciclomática 10, até 4 parâmetros; `describe` novos em arquivo novo; conferir com `npx eslint <arquivos> --rule '{"max-lines-per-function": ["error", 50], "max-params": ["error", 4], "complexity": ["error", 10], "max-depth": ["error", 4]}'`. `prettier --write` só em arquivo novo; nunca restaurar do git. **Legados** (só as inserções da task): `chat.schema.ts`, `chat.repository.ts`, `chat.service.ts`, `chat-media.service.ts`, `chat.module.ts`, `bot-reply.service.ts`, `team-pendency.schema.ts`, `team-pendency.service.ts`, `team-pendency.query.ts`, `team-whatsapp.module.ts`, `route-parity.spec.ts`; front `features/chat/{schemas.ts,api.ts,components/message-bubble.tsx,components/message-thread.tsx,components/conversations-list.tsx,components/assignee-tabs.tsx,components/conversation-actions.tsx}`, `features/team-pendencies/components/pendencies-page.tsx`, `release-notes.ts`.
- **GT9. Front.** Corpo de erro só por `readApiErrorBody` no `onError`/`queryFn` (ky 2). Textos exatamente como DT9/DT10. Filtros em estado local. Hora de Manaus (`America/Manaus`).
- **GT10. Concorrência.** Intercalação determinística contra o Postgres do testcontainer (Molde B: trava externa; comando 1 sem `await`, poll até 1 bloqueada; comando 2, poll até 2; solta; `await`), poll de 50 ms até 5 000 ms, `it` com 30 000 ms, `withConnectionLimit` 5, isolamento padrão. Nunca mock do repositório nem `Promise.all` solto.
- **GT11. Nada de texto em log nem trilha.** Trilha da passagem: ids, situações e datas (`conversation.assign` e `team_whatsapp.pendency_handover`), nunca a observação; logs novos do robô só com ids e `err.name`.

## Contratos compartilhados

**CT1. Chat** (T-B1; `backend/src/schemas/contracts/chat.schema.ts`).

```ts
export const HANDOVER_MAX_CONVERSATIONS = 100;
export const shiftHandoverSchema = z.object({
  toUserId: z.string().min(1),
  fromUserId: z.string().min(1).optional(),                 // ausente = quem pede (K3-1); outro = só ADMIN (K3-2)
  note: z.string().trim().min(1).max(200),
  conversationIds: z.array(z.string().min(1)).min(1).max(HANDOVER_MAX_CONVERSATIONS), // + refine: sem repetidos
});
export type ShiftHandoverInput = z.infer<typeof shiftHandoverSchema>;
export type HandoverSkipReason = 'resolved' | 'other_assignee' | 'unassigned' | 'already_with_target' | 'not_found';
export type ShiftHandoverResult = { transferred: { id: string }[]; skipped: { id: string; reason: HandoverSkipReason }[] };
// listConversationsQuerySchema ganha: handover: z.enum(['true', 'false']).optional()   // 'true' = Recebidas (DT3); o servidor força assignee = quem olha
export type ChatMessageTeamTag =
  | { kind: 'dispatch'; purpose: TeamPurpose | null; sentAt: string }   // TeamPurpose = o que fromDbPurpose devolve; sentAt = COALESCE(firedAt, createdAt)
  | { kind: 'reminder' }
  | { kind: 'alert_reply'; alertSentAt: string };                       // idem: hora real do disparo do alerta
// ChatMessage ganha: teamTag?: ChatMessageTeamTag | null   (listMessages sempre preenche; outros caminhos omitem)
// DTO: backend/src/modules/chat/dto/shift-handover.dto.ts (createZodDto)
```

**CT2. Pendências** (T-B1; `backend/src/schemas/contracts/team-pendency.schema.ts`).

```ts
export const PENDENCY_HANDOVER_MAX = 50;
// pendencyListQuerySchema ganha: handlerId: z.string().min(1).optional()
export const pendencyHandoverSchema = z.object({
  toUserId: z.string().min(1), fromUserId: z.string().min(1).optional(),
  note: z.string().trim().min(1).max(200),
  pendencyIds: z.array(z.string().min(1)).min(1).max(PENDENCY_HANDOVER_MAX),      // + refine: sem repetidos
});
export const pendencyHandoverTargetsQuerySchema = z.object({ fromUserId: z.string().min(1).optional() });
export type PendencyHandoverInput = z.infer<typeof pendencyHandoverSchema>;   // usado pelo serviço (CT4) e pelo DTO
export type PendencyHandoverSkipReason =
  'out_of_scope_target' | 'already_with_target' | 'other_handler' | 'acked' | 'closed' | 'not_found';
export type PendencyHandoverResult = { transferred: { id: string }[]; skipped: { id: string; reason: PendencyHandoverSkipReason }[] };
export type PendencyHandoverTargets = { items: { id: string; name: string }[] };
export type ConversationLastDispatch = { last: {
  purpose: TeamPurpose | null; sentAt: string; isReminder: boolean;
  dispatchId: string | null;                                 // só com canViewDispatch (DT7)
  pendency: { situation: PendencySituation } | null;         // só com a pendência no alcance K2-4 de quem olha
} | null };
// DTOs: team-whatsapp/dto/pendency-handover.dto.ts, dto/pendency-handover-targets-query.dto.ts
```

**CT3. Regras puras** (T-B1).

```ts
// backend/src/modules/chat/conversation-handover.rules.ts
export function canHandoverFrom(actor: ChatActor, fromId: string): boolean;          // fromId === actor.id || role ADMIN
export function handoverSkipReason(locked: Pick<LockedConversation, 'assignedUserId' | 'resolvedAt'>,
  fromId: string, toId: string): HandoverSkipReason | null;                          // ordem DT2.2
export function handoverChange(locked: LockedConversation,
  ctx: { actorId: string; toId: string; note: string; now: Date }): OwnershipChange;  // DT2.3
// backend/src/modules/team-whatsapp/team-pendency-handover.rules.ts
export function canHandoverPendenciesFrom(actor: { id: string; role: string }, fromId: string): boolean;
export function isPendencyHandoverTarget(dest: TeamActor | null, fromId: string): boolean; // ativo, acesso, remetente, equipe.enviar, ≠ from
export function handoverSkipOf(conflict: PendencyConflict, currentHandlerId: string | null | undefined,
  toId: string): PendencyHandoverSkipReason;   // DT4.4: handler_changed com currentHandlerId === toId → already_with_target
```

**CT4. Serviços** (back).

```ts
@Injectable() export class ConversationHandoverService {      // chat/conversation-handover.service.ts (T-B2)
  constructor(prisma: PrismaService, audit: AuditService, events: ChatEventsService);
  handover(actor: ChatActor, input: ShiftHandoverInput, now: Date): Promise<ShiftHandoverResult>;
}
export async function findHandoverReceivedIds(db: PrismaService, userId: string): Promise<string[]>; // chat/conversation-handover-received.query.ts (T-B3)
export async function findTeamDispatchTags(db: PrismaService, conversationId: string,
  messageIds: readonly string[]): Promise<Map<string, ChatMessageTeamTag>>;          // chat/message-team-tag.query.ts (T-B4a)
@Injectable() export class TeamPendencyHandoverService {     // team-whatsapp/team-pendency-handover.service.ts
  constructor(prisma: PrismaService, audit: AuditService);
  targets(actorId: string, fromUserId: string | undefined): Promise<PendencyHandoverTargets>;          // T-B5a
  handover(actorId: string, input: PendencyHandoverInput, now: Date): Promise<PendencyHandoverResult>; // T-B5b
}
@Injectable() export class TeamConversationDispatchService { // team-whatsapp/team-conversation-dispatch.service.ts (T-B4b)
  constructor(prisma: PrismaService);
  lastDispatch(actorId: string, conversationId: string, now: Date): Promise<ConversationLastDispatch>;
}
```

**CT5. Front** (T-F1 chat, T-F4 pendências).

```ts
// features/chat/schemas.ts: chatMessageSchema ganha teamTag (união por kind, .nullish())
// features/chat/team-dispatch.ts (novo)
export const conversationLastDispatchSchema;                       // tolerante
export function useConversationLastDispatch(conversationId: string); // ['chat','last-dispatch',id] (invalidateChat cobre)
export function teamTagText(tag: ChatMessageTeamTag): string;      // DT6
export function lastDispatchText(last: NonNullable<ConversationLastDispatch['last']>): string; // DT7
// features/chat/handover-api.ts (novo)
export function useHandoverConversations(fromId: string, enabled: boolean); // ['chat','handover-list',fromId]; status=open, assignee=fromId, pageSize=100
export function useShiftHandover();   // POST chat/handover; sucesso: toast DT9 e invalidateChat; erro: handoverErrorText
export function handoverSkipText(reason: HandoverSkipReason, targetName: string): string;
// features/chat/api.ts: assignee 'handover' → assignee=me&handover=true
// features/team-pendencies/handover-api.ts (novo)
export function usePendencyHandoverTargets(fromId: string, enabled: boolean); // [...PENDENCIES_KEY,'handover-targets',fromId]
export function usePendencyHandoverList(fromId: string, own: boolean, enabled: boolean); // DT4 (situations, handlerId, pageSize=50)
export function usePendencyHandover();  // POST; sucesso: toast DT9 e invalidatePendencies
export function pendencyHandoverSkipText(reason: PendencyHandoverSkipReason, targetName: string): string;
```

## Review Focus

1. **Autorização (T-B1, T-B2, T-B4b, T-B5a, T-B5b):** só o ADMIN passa as de outro (conversas e pendências); ator relido sem `equipe.enviar` → 403 antes de qualquer gravação (T-B5b); destino fora da regra → 404 para o pedido inteiro, nada gravado; pendência fora do alcance de quem pede → pulada `not_found`, sem revelar; a situação da pendência no topo só com a pendência no alcance; `dispatchId` só com `canViewDispatch`.
2. **Gravação por item (GT3):** uma transação curta por item, em série; pulada → nada gravado (nem histórico, nem anotação, nem trilha); repetir o pedido não duplica; `conversation.updated` só depois de cada commit.
3. **Corridas (DT11):** passagem × transferência/resolver na fila; duas passagens iguais simultâneas → uma linha `SHIFT_HANDOVER`/uma anotação `HANDOVER` por item; passagem de pendência × ciência automática.
4. **Robô (DT8):** mídia pausa sempre; nada relança depois de o envio começar (`handleSendFailure` não lança; `setDifyConversationId` falhar não duplica, nada saiu); nada além de `resumeBot` zera `botPausedAt`; passagem não retoma.
5. **Sem texto em log nem trilha (GT11)** e nenhuma mensagem enviada na passagem (K3-5).

## Rastreio (aceite → task → teste)

| Aceite | Task | Teste |
|---|---|---|
| 25 | T-B1, T-B2, T-F3b | T-B2 `aceite 25: transfere as marcadas, com SHIFT_HANDOVER, trilha e robô pausado`; `aceite 25: mudaram no meio — puladas com resolved / other_assignee / unassigned`; `aceite 25: repetir o pedido não duplica histórico` e a corrida `duas passagens iguais — uma linha por conversa`; T-F3b `aceite 25: marca todas, desmarca, exige observação e mostra as puladas` |
| 26 | T-B1, T-B2, T-F3b | T-B2 `aceite 26: ADMIN passa as conversas de atendente inativo; autor do histórico = ADMIN`; `OPERATOR pede as de outro — 403 chat.not_assignee, nada gravado`; T-F3b `aceite 26: Passar as conversas de {nome} só para ADMIN` |
| 27 | T-B3, T-F3a | T-B3 `aceite 27: Recebidas — só as abertas comigo cuja última mudança foi a passagem`; T-F3a `aceite 27: aba Recebidas manda assignee=me&handover=true` |
| 28 | T-B5a, T-B5b, T-F4 | T-B5a `aceite 28: destinos — remetentes ativos com equipe.enviar, sem quem sai`; T-B5b `aceite 28: transfere as que o destino vê; pula fora do alcance do destino; prazo recomeça; anotação HANDOVER`; `ator relido sem equipe.enviar — 403 auth.permission_denied`; `aceite 28: destino fora da regra — 404, nada gravado`; `aceite 28: ADMIN passa as de outro`; T-F4 `aceite 28: Passar minhas pendências` |
| 29 | T-B4a, T-B4b, T-F2 | T-B4a `aceite 29: etiquetas de envio, lembrete e resposta ao alerta`, `envio agendado — data do disparo`; T-B4b `envio agendado — data do disparo`; `aceite 29: sem a pendência no alcance, sem situação`; `aceite 29: dispatchId só com canViewDispatch`; T-F2 `aceite 29: etiqueta na bolha e faixa do topo com Ver resultado` |
| 30 | T-B6a, T-B6b, T-B2 | matriz K3-7 da T-B6b; T-B6a `K3-7(a)` e `K3-7(e)`; T-B2 `K3-7(b): passagem não retoma o robô` |
| 31 | T-F5 | `aceite 31: entrada K3 no topo, versão 2026.11.21.4` |

## Ordem e paralelismo

```
Onda 1:  T-B1 (contratos, regras)   T-B6a (robô: correções)   T-B6b (robô: testes)   T-F1 (front chat: contrato, hooks)   T-F4 (front pendências: passagem)   T-F5 (Novidades)
Onda 2:  T-B2 (passar conversas) <- T-B1 [tc]   T-B5a (destinos, filtro handlerId) <- T-B1 [tc]   T-F2 (etiquetas, topo) <- T-F1   T-F3a (aba Recebidas) <- T-F1
Onda 3:  T-B5b (passar pendências) <- T-B5a [tc]   T-B4a (etiquetas no listMessages) <- T-B1 [tc]   T-F3b (diálogo da caixa) <- T-F1, T-F3a
Onda 4:  T-B3 (filtro Recebidas) <- T-B2 [tc]   T-B4b (último envio) <- T-B5b [tc]
```

- **Ownership disjunto por onda.** Onda 1 — T-B1: `chat.schema.ts`, `team-pendency.schema.ts`, os três DTOs, os dois `*.rules.ts`; T-B6a: `bot-reply.service.ts`, `chat-media.service.ts`; T-B6b: só specs novos; T-F1: `features/chat/{schemas.ts,api.ts,team-dispatch.ts,handover-api.ts}`; T-F4: `features/team-pendencies/{handover-api.ts,components/pendency-handover-dialog.tsx,components/pendencies-page.tsx}`; T-F5: `release-notes.ts`. Onda 2 — T-B2: `conversation-handover.{service,controller}.ts`, `chat.module.ts`; T-B5a: `team-pendency-handover.{service,controller}.ts`, `team-pendency.{service,query}.ts`, `team-whatsapp.module.ts`, `route-parity.spec.ts`; T-F2: `message-bubble.tsx`, `message-thread.tsx`, componentes novos; T-F3a: `assignee-tabs.tsx`, `conversations-list.tsx` (só o tipo/validação do valor salvo). Onda 3 — T-B5b: `team-pendency-handover.{service,controller}.ts`, `route-parity.spec.ts`; T-B4a: `chat.repository.ts` (só `listMessages`), `message-team-tag.query.ts`; T-F3b: `shift-handover-dialog.tsx`, `conversations-list.tsx` (botão), `conversation-actions.tsx`. Onda 4 — T-B3: `chat.repository.ts` (só `listConversations`), `chat.service.ts`, `conversation-handover-received.query.ts`; T-B4b: `team-conversation-dispatch.{service,controller}.ts`, `team-whatsapp.module.ts`, `route-parity.spec.ts`.
- **Compartilhados em série:** `route-parity.spec.ts` e `team-whatsapp.module.ts` (Ondas 2, 3, 4); `chat.repository.ts` (Ondas 3 e 4); `conversations-list.tsx` (Ondas 2 e 3). T-B3 espera T-B2 porque semeia passagens pelo serviço real.
- **Testcontainers:** dois por onda nas Ondas 2–4; nenhum na Onda 1.
- **Gate conjunto:** a principal roda o `--changed` conjunto e os `tsc` depois de cada onda; falha só de arquivo alheio vai para o report.
- **Revisão** (SKILL do sdd, §Revisão por risco): `revisor` `opus` em **T-B1, T-B2, T-B4b, T-B5a, T-B5b** (`Risco: crítico (autorização)`, com a linha `Crítico:`). As demais com `revisor` `sonnet`. Implementador sempre `sonnet`. Total **15 tasks em 4 ondas**: 5 críticas; altas T-B4a, T-B6a, T-F1; médias T-B3, T-B6b, T-F2, T-F3a, T-F3b, T-F4; baixa T-F5.

---

## Task B1 — Contratos e regras puras da passagem (back)

**Arquivos:** modificar `backend/src/schemas/contracts/chat.schema.ts` (CT1: schema e tipos novos, `handover` na query da lista, `teamTag?` em `ChatMessage`), `backend/src/schemas/contracts/team-pendency.schema.ts` (CT2); criar `backend/src/modules/chat/dto/shift-handover.dto.ts`, `backend/src/modules/team-whatsapp/dto/{pendency-handover,pendency-handover-targets-query}.dto.ts`, `chat/conversation-handover.rules.ts`, `team-whatsapp/team-pendency-handover.rules.ts` (CT3); specs `chat/shift-handover.schema.spec.ts`, `chat/conversation-handover.rules.spec.ts`, `team-whatsapp/team-pendency-handover.rules.spec.ts`, `team-whatsapp/team-pendency-handover.schema.spec.ts`.

**Interfaces:** consome `ChatActor`, `LockedConversation`, `OwnershipChange` (`conversation-ownership.repository.ts:24-44`), `TeamActor`, `isTeamSender`, `hasPermission`, `PendencyConflict` (K2, CK4). Produz CT1, CT2 (inclui `PendencyHandoverInput`, que o CT4 usa em T-B5b) e CT3.

**Contexto vinculado:**
- K3-1: "Ele escolhe um colega (ativo, com acesso, ADMIN ou OPERATOR, diferente dele) e escreve uma observação obrigatória (até 200), comum a todas. O servidor transfere uma a uma, cada qual numa gravação condicional 'ainda aberta e ainda com quem sai'. As que mudaram são puladas." K3-2: "Passar as conversas de {nome}, só para o ADMIN, com as mesmas regras."
- K3-4: "O destino precisa ver cada pendência (K2-4) e ter `equipe.enviar`. (…) Outros motivos de pulo: 'já com outro responsável', 'já ciente', 'já encerrada'. (…) O ADMIN pode passar as de outro." K2-7: "Destino inativo, sem acesso, sem `equipe.enviar` ou igual a quem sai recusa o pedido inteiro com 404, como usuário inexistente."
- DT2 (ordem dos pulos: `resolved` → `already_with_target` → `unassigned` → `other_assignee`; `handoverChange` com `actions: ['SHIFT_HANDOVER']`, `pauseBot: true`, `resolved: false`); DT4.4 (`acked`→`acked`, `closed`→`closed`, `handler_changed`→`already_with_target` se o responsável atual já é o destino, senão `other_handler`, `missing`→`not_found`); DT5 (observação aparada 1..200; teto 100 conversas, 50 pendências; sem repetidos). GT6 (`teamTag`, `handover`, `handlerId` opcionais), GT8 (`chat.schema.ts` e `team-pendency.schema.ts` são legados: só as inserções).

**Passos:**
1. [ ] RED schemas: `it('observação só espaços falha; 201 falha; aparada')`; `it('lista vazia, repetida ou com 101 conversas / 51 pendências falha')`; `it('fromUserId opcional')`; `it('handover e handlerId opcionais na query; handover só true/false')`.
2. [ ] RED `conversation-handover.rules.spec.ts`: `it('canHandoverFrom — o próprio sim; ADMIN de outro sim; OPERATOR de outro não')`; `it('handoverSkipReason — resolvida antes de tudo; já com o destino; sem atendente; com outro; com quem sai → null')`; `it('handoverChange — SHIFT_HANDOVER, atendente = destino, pauseBot true, resolved false, observação')`.
3. [ ] RED `team-pendency-handover.rules.spec.ts`: `it('canHandoverPendenciesFrom — próprio; ADMIN de outro; SUPERVISOR de outro não')`; `it('isPendencyHandoverTarget — nulo, inativo, sem acesso, não remetente, sem equipe.enviar, igual a quem sai → falso; remetente ativo com equipe.enviar → verdadeiro')`; `it('handoverSkipOf — acked, closed, missing; handler_changed com responsável atual = destino → already_with_target; com outro ou null → other_handler')`.
4. [ ] GREEN; tipos; eslint (GT8); validação; `--changed`.

**Aceite:** base de 25, 26, 28. **Risco: crítico (autorização).**
**Crítico: autorização — define quem pode passar as conversas e as pendências de outra pessoa e quem pode recebê-las.** Revisão `opus`.

## Task B2 — Passar conversas (back)

**Arquivos:** criar `backend/src/modules/chat/conversation-handover.service.ts`, `conversation-handover.controller.ts` (`POST chat/handover`, 200), specs `conversation-handover.service.integration.spec.ts`, `conversation-handover.race.integration.spec.ts`, `conversation-handover.controller.spec.ts`; modificar `chat.module.ts` (só registro).

**Interfaces:** consome CT1, CT3, `runOwnershipTransaction`, `lockConversation`, `applyOwnershipChange`, `findEligibleAssignee` (`conversation-ownership.repository.ts:56-73,134,177`), `notAssignee` (`conversation-ownership.errors.ts`), `ChatEventsService.publish`, fixtures do K1 (`startOwnershipDb`, `newConversation`, `ownershipService`, `conversationRow`, `historyRows`, `auditRows`, `holdConversationLock`, `waitForBlocked`). Produz `ConversationHandoverService` (CT4).

**Contexto vinculado:**
- K3-1: "O servidor transfere uma a uma, cada qual numa gravação condicional 'ainda aberta e ainda com quem sai'. As que mudaram são puladas. A resposta traz as transferidas e as puladas com o motivo ('já resolvida', 'já com outro atendente'). Repetir o pedido não duplica nada. Cada conversa recebe sua linha 'passagem de turno' no histórico, com de, para e a observação." K3-2: "O histórico registra o ADMIN como autor." K3-5: "Nenhuma mensagem é enviada a ninguém na passagem."
- K1-7: "Robô: assumir, transferir e passar turno pausam o robô (…)." "Trilha: toda troca de atendente grava `conversation.assign`, com o novo atendente (…) (ao (…) passar turno também)." K1-10: "Toda mudança de situação ou atendente publica `conversation.updated`."
- DT1, DT2 inteiro (ordem 400 → 403 `chat.not_assignee` → 404 `user.not_found` → itens em série; `NotFoundError` da trava vira `not_found`; evento depois de cada commit). GT3 (uma transação curta por item; nunca N travas), GT10 (Molde B), GT11 (observação nunca na trilha).

**Passos:**
1. [ ] RED integração (`conversation-handover.service.integration.spec.ts`): `it('aceite 25: transfere as marcadas — atendente = destino, uma linha SHIFT_HANDOVER (autor, de, para, observação), conversation.assign sem observação, botPausedAt gravado, evento por conversa')`; `it('aceite 25: puladas — resolvida, com outro, sem atendente, inexistente; nada gravado nelas')`; `it('aceite 25: repetir o pedido — todas already_with_target, nenhuma linha nova')`; `it('aceite 26: ADMIN passa as de atendente inativo; autor = ADMIN, de = inativo')`; `it('OPERATOR pede as de outro — 403 chat.not_assignee; nada gravado')`; `it('destino SUPERVISOR, inativo, sem acesso ou igual a quem sai — 404 user.not_found; nada gravado')`; `it('K3-7(b): passagem não retoma — conversa pausada continua pausada; nenhum caminho grava botPausedAt null')`; `it('K3-5: nenhuma mensagem criada nem job enfileirado')` (o serviço não recebe o provedor, então o teste confere o banco e a fila: `Message` por conversa igual antes e depois, e nenhum job novo nas filas de envio da equipe e do robô, `getJobCounts()` ou `add` espiado no módulo de teste).
2. [ ] RED corrida (`conversation-handover.race.integration.spec.ts`, Molde B): `it('transferência do ADMIN na fila antes da passagem — pulada other_assignee, sem SHIFT_HANDOVER')` (pega: decisão lida fora da trava); `it('resolver na fila antes da passagem — pulada resolved, sem SHIFT_HANDOVER, resolvedAt preservado')` (pega: conferência de `resolvedAt` fora da trava); `it('duas passagens iguais simultâneas — uma transfere, a outra already_with_target; uma linha SHIFT_HANDOVER')` (pega: conferência sem trava); `it('passagem segura a conversa 1 — a conversa 2 não espera a 1 (transações separadas)')` (pega: uma transação com N travas: trava externa na conversa 2, a passagem grava a 1 antes de bloquear na 2).
3. [ ] RED controller (`conversation-handover.controller.spec.ts`): `it('400 sem observação')`; `it('VIEWER/SUPERVISOR — 403 do RolesGuard')`; `it('passa new Date() e o ator do token')`. Se `route-parity.spec.ts` exigir as rotas de `chat`, acrescentar só a linha e relatar.
4. [ ] GREEN; tipos; eslint; validação (`TESTCONTAINERS_ENABLED=1`); `--changed`.

**Aceite:** 25, 26, 30 (b). **Risco: crítico (autorização).**
**Crítico: autorização — decide quem passa as conversas de outra pessoa e para quem, e grava a troca de atendente em lote.** Revisão `opus`.

## Task B3 — Filtro "Recebidas na passagem de turno" (back)

**Arquivos:** criar `backend/src/modules/chat/conversation-handover-received.query.ts`, spec `conversation-handover-received.integration.spec.ts`; modificar `chat.service.ts` (só `listConversations`), `chat.repository.ts` (só `listConversations`: segundo parâmetro opcional `opts?: { ids?: string[] }` → `where.id = { in: ids }`).

**Interfaces:** consome CT1 (`handover`), `ConversationHandoverService` (T-B2, para semear), fixtures do K1. Produz `findHandoverReceivedIds` (CT4).

**Contexto vinculado:**
- K3-3: "Conversas abertas que estão com quem olha e cuja última mudança de atendente foi uma passagem de turno. Conversas 'Pendentes' não têm atendente e não entram."
- DT3 inteiro (igualdade `h."createdAt" = c."assignedAt"`, `h."toUserId" = c."assignedUserId"`, `action = 'SHIFT_HANDOVER'`, `resolvedAt IS NULL`, `archivedAt IS NULL`; por que não usar "a última linha"; combina com busca, "Não lidas" e "Aguardando"; com `status=resolved`, vazio). Mapa: `ASSUMED_ON_REPLY` também troca o atendente.
- GT8 (`chat.service.ts` e `chat.repository.ts` são legados: só as inserções), GT7.

**Passos:**
1. [ ] RED integração: `it('aceite 27: recebida por passagem e ainda comigo — entra')`; `it('recebida e depois assumida por outro ao responder (ASSUMED_ON_REPLY) — sai')`; `it('recebida e depois transferida de volta para mim — sai (a última mudança é TRANSFERRED)')`; `it('recebida e depois resolvida — sai')`; `it('passagem para outro — não entra na minha')`; `it('combina com unread e busca; status=resolved vazio')`; `it('sem handover — lista igual à de antes')`; `it('handover=true com assignee de outro, unassigned ou ausente — o servidor força o atendente = quem olha; nunca lista as recebidas por outro')`.
2. [ ] GREEN; tipos; eslint; validação; `--changed`.

**Aceite:** 27. **Risco: médio** (filtro de leitura numa caixa compartilhada; não decide acesso). Revisão `sonnet`.

## Task B4a — Etiquetas de envio por mensagem (back)

**Arquivos:** criar `backend/src/modules/chat/message-team-tag.query.ts`, spec `message-team-tag.integration.spec.ts`; modificar `chat.repository.ts` (só `listMessages`: depois do `findMany`, uma chamada a `findTeamDispatchTags` e `teamTag` em cada item, `null` quando não há).

**Interfaces:** consome CT1 (`ChatMessageTeamTag`), `fromDbPurpose` (`team-whatsapp/team-whatsapp.purpose-codes.ts:67-71`), fixtures do K2 (`newAlert`, `newPendency` com `messageId`/`lastReplyMessageId`) e do K1. Produz `findTeamDispatchTags` (CT4).

**Contexto vinculado:**
- K3-6: "Sem coluna nova: é consulta de leitura. Cada mensagem enviada que pertence a um envio da equipe leva 'Envio à equipe: {finalidade} · {dd/MM HH:mm}', ou 'Lembrete do alerta'. A mensagem recebida que o alerta registrou como resposta ou ciência leva 'Resposta ao alerta de {HH:mm}'." Limite conhecido: "A ligação de resposta a envio só existe no alerta."
- DT6 inteiro (uma consulta por página, pela conversa, sem varrer por `lastReplyMessageId`/`ackMessageId`; lembrete = `parentDispatchId`; resposta só de alerta, o mais novo; sem `dispatchId` na etiqueta). GT6 (`teamTag` opcional).

**Passos:**
1. [ ] RED integração: `it('aceite 29: mensagem do envio — dispatch com finalidade e data')`; `it('mensagem do lembrete — reminder')`; `it('resposta e ciência do alerta — alert_reply com a hora do alerta; de envio que não é alerta — sem etiqueta')`; `it('envio agendado — data do disparo')` (dispatch com `createdAt` = T0 e `firedAt` = T0+2h: `sentAt` da mensagem do envio e `alertSentAt` da resposta = `firedAt`; sem `firedAt` cai em `createdAt`); `it('mensagem comum — teamTag null')`; `it('destinatário de outra conversa não etiqueta esta')`; `it('uma consulta por página')` (espião no `$queryRaw`).
2. [ ] GREEN; tipos; eslint; validação (`TESTCONTAINERS_ENABLED=1`); `--changed`.

**Aceite:** 29 (etiquetas). **Risco: alto** (contrato público da conversa; leitura sem decisão de acesso). Revisão `sonnet`. **Foco da revisão:** consulta entra pela conversa; nenhuma outra informação do envio vaza (texto, autor, destinatários).

## Task B4b — "Último envio à equipe nesta conversa" (back)

**Arquivos:** criar `backend/src/modules/team-whatsapp/team-conversation-dispatch.service.ts`, `team-conversation-dispatch.controller.ts` (`GET internal/team-whatsapp/conversations/:conversationId/last-dispatch`, `@Roles('ADMIN','OPERATOR')`), specs `team-conversation-dispatch.integration.spec.ts`, `team-conversation-dispatch.controller.spec.ts`; modificar `team-whatsapp.module.ts` (registro), `route-parity.spec.ts` (só a linha nova).

**Interfaces:** consome CT2 (`ConversationLastDispatch`), `findTeamActor`, `canViewDispatch` (`team-whatsapp.policy.ts:80-85`), `pendencyScopeOf`, `scopeAllows`, `pendencySituation` (K2, CK4), `findPendencyScopeFacts`, `handlerStatesFor` (K2, CK5), `fromDbPurpose`, fixtures do K2. Produz CT4 `TeamConversationDispatchService`.

**Contexto vinculado:**
- K3-6: "No topo da conversa: 'Último envio à equipe nesta conversa', com finalidade e data; se for alerta e quem olha vê a pendência (K2-4, que já exige ser remetente), também a situação da pendência. 'Ver resultado' só para quem vê o envio (`canViewDispatch`). O texto diz 'último envio', nunca 'origem da resposta'."
- K2-4: "começa por `isTeamSender(ator)`: quem não é remetente não vê nenhuma pendência; o ADMIN vê todas; os demais veem as pendências dos alertas que enviaram e as das pessoas de setores ativos que gerem (…). Pendência fora do alcance responde 404 em qualquer rota." `canViewDispatch`: `actor.role === 'ADMIN' || dispatch.authorId === actor.id` (não muda).
- DT7 inteiro (alerta de referência = pai do lembrete; `dispatchId` só com `canViewDispatch`; `pendency` só no alcance; conversa inexistente 404). GT4, GT8.

**Passos:**
1. [ ] RED integração: `it('sem envio — last null'); it('conversa inexistente — 404')`; `it('aceite 29: ADMIN — finalidade, data, situação e dispatchId')`; `it('aceite 29: OPERATOR não remetente — sem situação; sem dispatchId se não é autor')`; `it('OPERATOR gestor do setor da pessoa, sem ser autor — situação sim, dispatchId null')` (`isTeamSender` aceita OPERATOR com setor gerido; o SUPERVISOR nem chega: `@Roles('ADMIN','OPERATOR')` barra, coberto no controller); `it('lembrete é o último — isReminder; situação pela linha do alerta pai (parentRecipientId) e dispatchId pelo alerta pai')`; `it('envio agendado — data do disparo')` (`sentAt` = `firedAt`, não `createdAt`); `it('envio que não é alerta — sem situação')`; `it('último = o de mensagem mais nova')`.
2. [ ] RED controller: `it('SUPERVISOR e VIEWER — 403 do RolesGuard')`; linha nova do `route-parity.spec.ts` verde.
3. [ ] GREEN; tipos; eslint; validação (`TESTCONTAINERS_ENABLED=1`); `--changed`.

**Aceite:** 29 (topo). **Risco: crítico (autorização).**
**Crítico: autorização — decide a quem mostrar a situação da pendência (alcance K2-4) e o link do resultado do envio (`canViewDispatch`).** Revisão `opus`.

## Task B5a — Destinos da passagem de pendências e filtro por responsável (back)

**Arquivos:** criar `backend/src/modules/team-whatsapp/team-pendency-handover.service.ts` (só `targets`), `team-pendency-handover.controller.ts` (`GET pendency-handover/targets`), specs `team-pendency-handover.targets.integration.spec.ts`, `team-pendency.handler-filter.integration.spec.ts`, `team-pendency-handover.controller.spec.ts`; modificar `team-pendency.service.ts`/`team-pendency.query.ts` (só o filtro `handlerId`), `team-whatsapp.module.ts` (registro), `route-parity.spec.ts` (linha nova com a rota GET).

**Interfaces:** consome CT2, CT3 (`canHandoverPendenciesFrom`, `isPendencyHandoverTarget`), `listHandlerCandidates`, `findTeamActor`, `teamForbidden`, `notHandler` (K2, CK3/CK5), fixtures do K2. Produz `targets` (CT4) e o filtro.

**Contexto vinculado:**
- K2-7: "A passagem de turno (K3-4) usa outra rota de leitura, para remetentes com `equipe.enviar`: devolve id e nome dos remetentes ativos, com acesso e com `equipe.enviar`, sem quem sai." Aceite 28: "A lista de destinos da passagem traz só remetentes ativos com `equipe.enviar`, sem quem sai."
- DT4 (rotas com `@RequirePermission('equipe.enviar')` sem `@Roles`; `fromUserId` de outro só ADMIN → 403 `team_whatsapp.not_handler`; não remetente → 403 `team_whatsapp.forbidden`; nomes por `nameView`, ordem pt-BR; filtro `handlerId` = `pendencyHandlerId === handlerId`, depois do alcance, combinando com `situations`, `sectorId` e `mine`). GT4.

**Passos:**
1. [ ] RED: `it('aceite 28: destinos — só remetentes ativos, com acesso e equipe.enviar; sem quem sai; VIEWER e SUPERVISOR sem setor fora')`; `it('fromUserId de outro — OPERATOR 403 not_handler; ADMIN tira o outro da lista')`; `it('não remetente — 403 forbidden')`; `it('lista com handlerId — só as daquele responsável, dentro do alcance de quem olha')`; controller: `it('sem equipe.enviar — 403 do guard')`.
2. [ ] GREEN; tipos; eslint; validação (`TESTCONTAINERS_ENABLED=1`); `--changed`.

**Aceite:** 28 (destinos). **Risco: crítico (autorização).**
**Crítico: autorização — define quem pode receber pendências na passagem e filtra a lista por responsável dentro do alcance.** Revisão `opus`.

## Task B5b — Passar pendências (back)

**Arquivos:** modificar `team-pendency-handover.service.ts` (`handover`), `team-pendency-handover.controller.ts` (`POST pendency-handover`, 200), `route-parity.spec.ts` (acrescenta a rota); criar specs `team-pendency-handover.integration.spec.ts`, `team-pendency-handover.race.integration.spec.ts`.

**Interfaces:** consome CT2 (`PendencyHandoverInput`, `PendencyHandoverResult`), CT3, `hasPermission`/`permissionDenied` (checagem local de `equipe.enviar`), `runPendencyTransition` (`team-pendency-write.repository.ts:237-251`, devolve `{ ok: false, conflict, current }` sem lançar; `current?.handlerId` alimenta `handoverSkipOf`, DT4.4), `findPendencyScopeFacts`, `pendencyScopeOf`, `scopeAllows`, `canHandlePendency`, `handlerStateOf`, `pendencyDueAt` (K2), `recordAlertReply` (só nos testes), fixtures do K2 (`newSector`, `newTeamUser`, `newAlert`, `newPendency`, `holdRecipientLock`). Produz `handover` (CT4).

**Contexto vinculado:**
- K3-4: "Faz o mesmo com as pendências que quem sai assumiu ('Em tratativa' e 'Em tratativa — atrasada'). O destino precisa ver cada pendência (K2-4) e ter `equipe.enviar`. As que ele não vê são puladas com o motivo 'fora do alcance do destino' e continuam com quem sai. Outros motivos de pulo: 'já com outro responsável', 'já ciente', 'já encerrada'. O prazo de tratativa recomeça nas transferidas. A observação vira uma anotação 'Passagem de turno: {observação}' em cada pendência transferida. O ADMIN pode passar as de outro."
- K2/DK10: `runPendencyTransition` trava a linha (`FOR NO KEY UPDATE`), confere `expect` e grava colunas, anotação e trilha na mesma transação; conflito devolve resultado, sem gravar. K2/DK16: trilha com `handlerId`, `situation`, `dueAt` antes/depois, nunca texto.
- K2-7: "Toda escrita exige `equipe.enviar`" do ator relido do banco (GK5: o guard só olha o papel do token).
- DT4 inteiro (ordem 403 guard → 403 forbidden → 403 `auth.permission_denied` do ator relido → 403 not_handler → 404 destino → por item: não encontrada → fora do alcance do destino → transição; mapa dos conflitos com `already_with_target`; repetir não duplica). GT3, GT10, GT11.

**Passos:**
1. [ ] RED integração: `it('aceite 28: transfere as que o destino vê — responsável, prazo now+60, anotação HANDOVER só com a observação, trilha pendency_handover sem texto')`; `it('aceite 28: fora do alcance do destino — pulada, continua com quem sai, sem anotação')`; `it('já ciente, já encerrada, já com outro — puladas com o motivo')`; `it('fora do alcance de quem pede ou inexistente — pulada not_found')`; `it('aceite 28: destino sem equipe.enviar, inativo, sem acesso ou igual a quem sai — 404; nada gravado')`; `it('aceite 28: ADMIN passa as de outro; SUPERVISOR pede as de outro — 403 not_handler')`; `it('repetir o pedido — puladas already_with_target (já estava com {nome}); uma anotação HANDOVER por pendência')`; `it('responsável atual é um terceiro — pulada other_handler, não already_with_target')`; `it('ator relido sem equipe.enviar (papel mudou, token antigo) — 403 auth.permission_denied, nada gravado')` (o guard passa, a chave sai da leitura do banco).
2. [ ] RED corrida (Molde B com `holdRecipientLock`): `it('ciência automática na fila antes da passagem — pulada acked')` (ciência por `$transaction((tx) => recordAlertReply(tx, …))`, como K2/DK23; pega: conferência sem trava); `it('duas passagens iguais simultâneas — uma anotação HANDOVER')`.
3. [ ] GREEN; tipos; eslint; validação (`TESTCONTAINERS_ENABLED=1`); `--changed`.

**Aceite:** 28. **Risco: crítico (autorização).**
**Crítico: autorização — aplica o alcance K2-4 de quem pede e do destino a cada pendência e decide quem passa as de outra pessoa.** Revisão `opus`.

## Task B6a — Robô: correções da pausa e do "no máximo uma resposta" (back)

**Arquivos:** modificar `backend/src/modules/chat/chat-media.service.ts` (uma linha: `await this.repo.setBotPaused(conversationId)` depois de `createOutboundMediaMessage`), `backend/src/modules/bots/bot-reply.service.ts` (`sendBotReply` da resposta em `try/catch` que chama um método privado novo `handleSendFailure`, que **nunca lança** (`setBotPaused` e `audit` cada um em `try/catch`; log só com ids e `err.name`); `finally` com a liberação da trava em `try/catch`); criar specs `chat/chat-media.bot-pause.spec.ts`, `bots/bot-reply.k3.spec.ts`.

**Interfaces:** consome `ChatRepository.setBotPaused` (`chat.repository.ts:140`), `AuditService.log`, os mocks dos specs vizinhos (`bot-reply.service.spec.ts`, `chat-media.claim.spec.ts`). Produz o comportamento de DT8.

**Contexto vinculado:**
- K3-7: "(a) o robô não responde com a conversa em pausa, e envio da equipe, atribuição e resposta de atendente pausam; (c) (…) cada mensagem recebida gera no máximo uma resposta, mesmo com evento repetido; (e) resposta vazia do serviço não é enviada, e em falha sai no máximo a contingência configurada e o robô pausa. Se um teste revelar que o código não garante o item, a correção entra no K3." K1 (O que já existe): "As duas [rotas de resposta] gravam a mensagem com o autor e pausam o robô."
- DT8 (mídia pausa sempre, como o texto; depois do Dify nada relança; falha de envio pausa e audita `bot.reply_failed` com `{ botId, stage: 'send' }`, sem contingência; antes do Dify continua relançando). GT11 (log só com ids e `err.name`), GT8 (dois legados: só essas inserções).

**Passos:**
1. [ ] RED `chat-media.bot-pause.spec.ts`: `it('K3-7(a): mídia na conversa que já é minha e aberta (claim changed false) — pausa o robô')`; `it('mídia de outro (409) — não pausa nem grava')`.
2. [ ] RED `bot-reply.k3.spec.ts`: `it('K3-7(a): conversa em pausa — Dify não é chamado')`; `it('K3-7(c): sendBotReply lança depois do Dify — handle não relança, pausa, audita stage send, sem contingência, um envio')`; `it('K3-7(c): sendBotReply e setBotPaused falham — handle não relança, um envio, sem nova chamada ao Dify')` (pega: `handleSendFailure` que lança e faz o BullMQ retentar); `it('K3-7(c): sendBotReply e audit falham — handle não relança')`; `it('K3-7(c): liberar a trava falha — handle não relança')`; `it('K3-7(e): resposta vazia ou só espaços — não envia nem pausa')`; `it('K3-7(e): Dify falha sem contingência — só pausa; contingência que lança — pausa, um envio, não relança')`; `it('falha antes do Dify (trava ocupada) — relança para retentativa, sem envio')`.
3. [ ] GREEN; tipos; eslint; validação; `--changed`.

**Aceite:** 30 (a, c, e). **Risco: alto** (robô fala com pessoas reais; sem categoria crítica). Revisão `sonnet`. **Foco da revisão:** nenhum `throw` alcançável depois de o envio começar (`sendBotReply` em diante, inclusive dentro de `handleSendFailure` e do `finally`); `setDifyConversationId` (`:121`) lançar retenta o Dify mas não duplica, pois nada saiu; mídia pausa no mesmo ponto do texto.

## Task B6b — Robô: testes de anti-loop, histórico e pausa (back, só specs)

**Arquivos:** criar specs `backend/src/modules/chat/chat-ingest.bot-guard.spec.ts`, `chat-media-download.bot-guard.spec.ts`, `chat-history-sync.bot.spec.ts`, `bot-paused-writers.spec.ts`. Nenhum arquivo de produção (se um teste revelar lacuna, devolver ao controlador com o caso; a correção vira task).

**Interfaces:** consome `ChatIngestService` (`chat-ingest.service.ts:385-386,770-804`), `ChatMediaDownloadProcessor` (`:93-100`), `ChatHistorySyncService` (`:154,175`), os mocks dos specs vizinhos (`chat-ingest.bot.spec.ts`, `chat-ingest.service.spec.ts`, `chat-media-download.processor.spec.ts`, `chat-history-sync.service.spec.ts`).

**Contexto vinculado:**
- K3-7: "(b) resolver, reabrir, transferir e passar turno não retomam o robô (só 'Retomar robô'); (c) sem loop: mensagem enviada (do robô, do atendente, da equipe ou eco do próprio número) nunca gera resposta do robô, e cada mensagem recebida gera no máximo uma resposta, mesmo com evento repetido; (d) o robô não inicia conversa: só responde a mensagem recebida ao vivo, nunca a histórico importado." "O conteúdo que o robô escreve vem de serviço externo e não é verificado por teste: é limite declarado."
- DT8 (enqueue antes da chave Redis = limite declarado; varredura de `botPausedAt: null`).
- **Matriz K3-7** (a task confirma por `grep` que os testes existentes têm esses nomes e passam; o que faltar ela escreve): (a) `bot-reply.guard.spec.ts` (pausa), `chat.service.team.spec.ts` "…e pausa o bot", `conversation-assign.integration.spec.ts` "aceite 9: assumir e transferir pausam…", resposta de texto (`chat.service.bot.spec.ts`; se não houver teste de pausa do texto, escrever), mídia (T-B6a); (b) `conversation-ownership.resolve.integration.spec.ts` "aceite 9…", `conversation-assign.integration.spec.ts`, T-B2 e o estático daqui; (c) daqui e T-B6a; (d) daqui e `chat-media-download.processor.spec.ts` "does NOT enqueue a bot reply for history-imported (old) inbound media"; (e) T-B6a e `bot-reply.service.spec.ts` "on Dify failure…".

**Passos:**
1. [ ] RED `chat-ingest.bot-guard.spec.ts`: `it('K3-7(c): eco fromMe — não enfileira')`; `it('K3-7(c): mesmo providerMessageId duas vezes (chave Redis) — um enqueue com jobId = message.id')`; `it('K3-7(c): reentrega que cai no P2002 — não enfileira (limite declarado: nunca duplica)')`; `it('K3-7(d): backfill de texto — não enfileira')`.
2. [ ] RED `chat-media-download.bot-guard.spec.ts`: `it('K3-7(c): mídia fromMe — não enfileira')`. `chat-history-sync.bot.spec.ts`: `it('K3-7(d): histórico Evolution importado — nenhum job bot.reply')` (fila espiã registrada no módulo de teste).
3. [ ] RED `bot-paused-writers.spec.ts` (lê os `.ts` de `backend/src`, sem `*.spec.ts` e `*.test-fixtures.ts`): `it('K3-7(b): só chat.repository.ts grava botPausedAt null')`; `it('K3-7(b): clearBotPaused só é chamado por resumeBot')`.
4. [ ] GREEN (os testes passam sem mudar produção; se não, BLOCKED com o caso); eslint; validação; `--changed`.

**Aceite:** 30 (b, c, d). **Risco: médio** (só testes). Revisão `sonnet`.

## Task F1 — Front: contrato e hooks da caixa (etiqueta, topo, passagem, filtro)

**Arquivos:** modificar `frontend/src/features/chat/schemas.ts` (`teamTag` em `chatMessageSchema`, `.nullish()`), `features/chat/api.ts` (só o mapeamento `assignee === 'handover'` → `assignee=me&handover=true`, ~L77-103); criar `features/chat/team-dispatch.ts`, `features/chat/handover-api.ts`, specs `team-dispatch.spec.ts`, `handover-api.spec.ts`, `api.handover-filter.spec.ts`.

**Interfaces:** consome CT1, CT2 (`ConversationLastDispatch`), `PURPOSE_LABEL` (`features/team-whatsapp/labels.ts:12`), `SITUATION_LABEL` (`features/team-pendencies/labels.ts`), `invalidateChat` (`api.ts:172-183`), `readApiErrorBody`, `api-client` (mockado nos specs, padrão `api.assign.spec.ts`). Produz CT5 (parte chat).

**Contexto vinculado:**
- K3-6 (textos: "Envio à equipe: {finalidade} · {dd/MM HH:mm}", "Lembrete do alerta", "Resposta ao alerta de {HH:mm}", "Último envio à equipe nesta conversa"; "O texto diz 'último envio', nunca 'origem da resposta'").
- DT6, DT7 (texto do topo; finalidade nula → "Envio à equipe · {dd/MM HH:mm}"), DT9 (motivos, toasts, erros), DT3 (aba manda `assignee=me&handover=true`). GT9 (hora de Manaus, `readApiErrorBody` fora da renderização), GT6 (tolerante).

**Passos:**
1. [ ] RED `team-dispatch.spec.ts`: `it('teamTagText — dispatch, dispatch sem finalidade, reminder, alert_reply em hora de Manaus')`; `it('lastDispatchText — com e sem pendência; lembrete; nunca contém origem')`; `it('schema tolera resposta antiga sem teamTag')`.
2. [ ] RED `handover-api.spec.ts`: `it('lista pede status=open, assignee={from}, pageSize=100')`; `it('passagem: sucesso — toast singular/plural e invalidateChat')`; `it('erros user.not_found e chat.not_assignee — textos de DT9')`; `it('handoverSkipText — os cinco motivos')`.
3. [ ] RED `api.handover-filter.spec.ts`: `it('aceite 27: assignee handover vira assignee=me&handover=true')`.
4. [ ] GREEN; `npx tsc -b`; eslint (GT8); validação; `--changed`.

**Aceite:** base de 25–27, 29. **Risco: alto** (contrato consumido pela caixa). Revisão `sonnet`.

## Task F2 — Front: etiqueta na mensagem e faixa do último envio

**Arquivos:** criar `features/chat/components/message-team-tag.tsx`, `features/chat/components/last-dispatch-banner.tsx`, specs `message-team-tag.spec.tsx`, `last-dispatch-banner.spec.tsx`; modificar `message-bubble.tsx` (só renderizar a etiqueta acima da bolha, dentro do wrapper, ~L37-38) e `message-thread.tsx` (só montar a faixa entre `ThreadTop` e `ThreadBody`, ~L190-197).

**Interfaces:** consome CT5 (`teamTagText`, `useConversationLastDispatch`, `lastDispatchText`), `Link` do TanStack Router (`/whatsapp-equipe/$dispatchId`).

**Contexto vinculado:**
- K3-6 (as três etiquetas; topo com finalidade e data e, se quem olha vê a pendência, a situação; "'Ver resultado' só para quem vê o envio"). Aceite 29: "A conversa mostra as etiquetas de K3-6, e 'Ver resultado' só para quem vê o envio. Sem a pendência no alcance, o topo não mostra a situação dela."
- DT6, DT7, DT9 (posições). GT8 (bolha e thread legados: só as inserções; specs existentes verdes).

**Passos:**
1. [ ] RED: `it('aceite 29: bolha com teamTag mostra a etiqueta; sem teamTag, nada')`; `it('aceite 29: faixa com situação e Ver resultado quando vêm; sem dispatchId, sem link; sem pendency, sem situação')`; `it('sem envio (last null) ou carregando — sem faixa')`.
2. [ ] GREEN; `npx tsc -b`; eslint; validação; `--changed`; smoke no navegador (≤ ~10 chamadas).

**Aceite:** 29 (tela). **Risco: médio.** Revisão `sonnet`.

## Task F3a — Front: aba "Recebidas na passagem de turno"

**Arquivos:** modificar `features/chat/components/assignee-tabs.tsx` (quarta aba, valor `'handover'`), `conversations-list.tsx` (só aceitar `'handover'` no valor salvo em `localStorage`, ~L29-57); criar spec `assignee-tabs.handover.spec.tsx`.

**Interfaces:** consome o mapeamento de T-F1 (`api.ts`), `assigneeForStatus` (`conversation-status.ts:10-14`, zera a aba em "Resolvidas").

**Contexto vinculado:**
- K3-3: "Conversas abertas que estão com quem olha e cuja última mudança de atendente foi uma passagem de turno." K1-10: "As abas de atendente (Todas, Minhas, Não atribuídas) valem só em 'Abertas' e somem em 'Resolvidas'."
- DT3 (rótulo exato "Recebidas na passagem de turno"; manda `assignee=me&handover=true`). GT8.

**Passos:**
1. [ ] RED: `it('aceite 27: aba Recebidas na passagem de turno em Abertas; some em Resolvidas')`; `it('escolher a aba — consulta com handover=true; valor salvo volta ao recarregar')`.
2. [ ] GREEN; `npx tsc -b`; eslint; validação; `--changed`.

**Aceite:** 27 (tela). **Risco: médio.** Revisão `sonnet`.

## Task F3b — Front: diálogo "Passar meu turno" e "Passar as conversas de {nome}"

**Arquivos:** criar `features/chat/components/shift-handover-dialog.tsx`, specs `shift-handover-dialog.spec.tsx`, `conversation-actions.handover.spec.tsx`; modificar `conversations-list.tsx` (botão "Passar meu turno" e montagem do diálogo), `conversation-actions.tsx` (ADMIN: "Passar as conversas de {nome}" quando a conversa tem atendente que não é ele).

**Interfaces:** consome CT5 (`useHandoverConversations`, `useShiftHandover`, `handoverSkipText`), `useChatAssignees` (`api.ts:148-155`), `useAuthStore`, modelo de diálogo `conversation-action-dialog.tsx` (`NOTE_MAX = 200`).

**Contexto vinculado:**
- K3-1: "Lista as conversas 'Em atendimento' de quem sai, todas marcadas e desmarcáveis. Ele escolhe um colega (ativo, com acesso, ADMIN ou OPERATOR, diferente dele) e escreve uma observação obrigatória (até 200), comum a todas. (…) A resposta traz as transferidas e as puladas com o motivo." "É sempre ação manual." K3-2: "só para o ADMIN (…) para atendente ausente ou inativo."
- DT1 (lista pela rota atual, destinos de `chat/assignees` sem quem sai), DT5 (aviso "Mostrando {n} de {total}. Passe estas e abra de novo para passar as demais."), DT9 inteiro (títulos, campos, botões, toasts, puladas, erros). GT8, GT9.

**Passos:**
1. [ ] RED `shift-handover-dialog.spec.tsx`: `it('aceite 25: todas marcadas; desmarcar tira do pedido')`; `it('Confirmar desligado sem marcada, sem destino ou sem observação; 200 no máximo')`; `it('destinos sem quem sai')`; `it('aceite 25: resultado com puladas — Não foram passadas: e os motivos')`; `it('acima de 100 — aviso')`; `it('404 user.not_found — Esta pessoa não pode receber as conversas. Escolha outra.')`.
2. [ ] RED `conversation-actions.handover.spec.tsx`: `it('aceite 26: ADMIN vê Passar as conversas de {nome} em conversa de outro; OPERATOR não')`; `it('Passar meu turno no topo da lista')`.
3. [ ] GREEN; `npx tsc -b`; eslint; validação; `--changed`; smoke no navegador (≤ ~10 chamadas).

**Aceite:** 25, 26 (tela). **Risco: médio** (a decisão é do servidor). Revisão `sonnet`.

## Task F4 — Front: "Passar minhas pendências" e "Passar as pendências de {nome}"

**Arquivos:** criar `features/team-pendencies/handover-api.ts`, `components/pendency-handover-dialog.tsx`, specs `handover-api.spec.ts`, `pendency-handover-dialog.spec.tsx`, `pendencies-page.handover.spec.tsx`; modificar `components/pendencies-page.tsx` (botão "Passar minhas pendências" no topo, com `equipe.enviar`; no `renderActions`, ADMIN ganha "Passar as pendências de {nome}" quando há responsável que não é ele).

**Interfaces:** consome CT2, `teamPendencyListSchema`, `PENDENCIES_KEY`, `invalidatePendencies`, `SITUATION_LABEL`, `manausTime` (K2, CK8), `pendency-text-dialog.tsx` (`PENDENCY_TEXT_MAX = 200`), `renderWithClient`/`httpError` (`pendency.test-support.tsx`), `pendencyItem` (`pendency.test-fixtures.ts`). Produz CT5 (parte pendências).

**Contexto vinculado:**
- K3-4: "Faz o mesmo com as pendências que quem sai assumiu ('Em tratativa' e 'Em tratativa — atrasada'). O destino precisa ver cada pendência (K2-4) e ter `equipe.enviar`. As que ele não vê são puladas com o motivo 'fora do alcance do destino' (…). Outros motivos de pulo: 'já com outro responsável', 'já ciente', 'já encerrada'. (…) O ADMIN pode passar as de outro." K3-1 ("faz o mesmo"): "Lista (…) todas marcadas e desmarcáveis. (…) observação obrigatória (até 200), comum a todas." K2-7: "A passagem de turno (K3-4) usa outra rota de leitura (…): devolve id e nome dos remetentes ativos, com acesso e com `equipe.enviar`, sem quem sai." Aceite 28: "'Passar minhas pendências' transfere as que o destino vê, pula as outras com 'fora do alcance do destino', recomeça o prazo e grava a anotação 'Passagem de turno: …'. O ADMIN passa as pendências de outro responsável com as mesmas regras."
- DT4 (lista: `situations=IN_PROGRESS,OVERDUE&handlerId={eu}` ou, ADMIN, `UNASSIGNED,IN_PROGRESS,OVERDUE&handlerId={from}`, `pageSize=50`; destinos `GET pendency-handover/targets?fromUserId=`), DT5 (teto 50 e aviso), DT9 (textos). GT8 (`pendencies-page.tsx` legado: só as inserções), GT9.

**Passos:**
1. [ ] RED `handover-api.spec.ts`: `it('lista própria e de outro — parâmetros de DT4')`; `it('destinos com fromUserId')`; `it('pendencyHandoverSkipText — os seis motivos, already_with_target com o nome do destino')`; `it('sucesso — toast singular/plural e invalida team-pendencies; 404 e 403 not_handler — textos de DT9')`.
2. [ ] RED `pendency-handover-dialog.spec.tsx`: `it('aceite 28: todas marcadas, destino e observação obrigatórios, dica da Passagem de turno')`; `it('aceite 28: puladas com fora do alcance do destino, já estava com {nome}, já ciente, já encerrada, já com outro responsável')`; `it('acima de 50 — aviso'); it('vazio — Nenhuma pendência em tratativa.')`.
3. [ ] RED `pendencies-page.handover.spec.tsx`: `it('Passar minhas pendências só com equipe.enviar')`; `it('aceite 28: ADMIN vê Passar as pendências de {nome} na linha de outro responsável; SUPERVISOR não')`.
4. [ ] GREEN; `npx tsc -b`; eslint; validação; `--changed`; smoke no navegador (≤ ~10 chamadas).

**Aceite:** 28 (tela). **Risco: médio.** Revisão `sonnet`.

## Task F5 — Front: Novidades do K3

**Arquivos:** modificar `frontend/src/release-notes.ts` (entrada nova no topo de `RELEASE_NOTES`); criar `frontend/src/release-notes.passagem.spec.ts`.

**Interfaces:** consome `ReleaseNote`/`ReleaseNoteItem` (`release-notes.ts:15-28`).

**Contexto vinculado:**
- C2: "Novidades. Uma entrada por lote." Aceite 31: "As Novidades têm a entrada de K3."
- `frontend/CLAUDE.md`: entrada nova no TOPO, ordem decrescente por `version`; texto em PT-BR para o operador; `where` só com tela. Topo atual: `2026.11.21.3` (K2). DT10 inteiro (versão `2026.11.21.4`, título "Passagem de turno", três itens).

**Passos:**
1. [ ] RED: `it('aceite 31: entrada K3 no topo, versão 2026.11.21.4, data 2026-11-21, título Passagem de turno, itens com /inbox e /pendencias-equipe')`; `release-notes.spec.ts` verde.
2. [ ] GREEN; `npx tsc -b`; validação; `--changed`.

**Aceite:** 31. **Risco: baixo.** Revisão `sonnet`.

---

## Fechamento (principal)

1. Ledger: 15 tasks aceitas; revisões conforme o risco; `tsc` de back e front depois de cada onda; testes do Rastreio presentes e verdes.
2. Conferências: `git diff --stat feat/pendencias-equipe` sem `schema.prisma`, `prisma/migrations/`, `conversation-ownership.repository.ts`, `conversation-claim.ts`, `team-pendency-write.repository.ts`, `team-pendency.rules.ts`, `team-pendency-scope.repository.ts`, `tracking/`, `chat-ingest.service.ts`, `chat-history-sync.service.ts`, catálogo de permissões (GT1); `grep -rn "\$transaction\|runOwnershipTransaction\|runPendencyTransition" backend/src/modules/chat/conversation-handover.service.ts backend/src/modules/team-whatsapp/team-pendency-handover.service.ts` mostra uma transação por item, dentro do laço (GT3); nenhum `logger` novo com observação (GT11).
3. Revisão final do conjunto com `opus` (diff inteiro contra `feat/pendencias-equipe`).
4. Gates completos, **um de cada vez**, nada mais rodando (memória "gate completo sozinho"): back com `NODE_OPTIONS=--max-old-space-size=6144` e `TESTCONTAINERS_ENABLED=1`, depois front, `--base origin/main`, no estado final; comparar com os logs finais do K2 em `.superpowers/sdd/2026-11-21-orgamind-gbr-etapa5-lote-k2-pendencias/`; bloquear violação nova ou agravada; conferir `max-lines-per-function` 50 dos specs novos.
5. QA visual (agente `qa`, roteiro Node com `@playwright/test`, senha lida no processo e nunca impressa, login 5/min) na stack `orgamind-turnos-qa` (sem worker nem Evolution: **o robô não roda no QA**; K3-7 fica provado pelos testes das T-B2, T-B6a e T-B6b). Dados fictícios por SQL com prefixo `qa_k3_` e reversão em `qa/qa-data.md`: ADMIN; dois OPERATOR (A e B); um OPERATOR inativo com conversas; SUPERVISOR gestor de S1; conversas "Em atendimento" de A (uma resolvida no meio do teste); alerta e lembrete com mensagens e resposta ligada numa conversa; pendências de A em S1 e S2. Até 5 critérios por despacho:
   - **QA-1:** A passa o turno para B com observação, desmarcando uma; uma resolvida antes aparece como pulada "já resolvida"; o histórico mostra a passagem.
   - **QA-2:** B vê a aba "Recebidas na passagem de turno" com as recebidas; ADMIN passa as conversas do inativo ("Passar as conversas de {nome}").
   - **QA-3:** A passa as pendências ao SUPERVISOR de S1: a de S2 volta "fora do alcance do destino"; anotação "Passagem de turno: …" e prazo novo.
   - **QA-4:** etiquetas "Envio à equipe: Urgência · …", "Lembrete do alerta", "Resposta ao alerta de …"; faixa do topo com situação e "Ver resultado" para o ADMIN; OPERATOR sem situação nem link.
   - **QA-5:** Novidades com a entrada K3; nenhuma mensagem nova no provedor falso.
6. Atualizar "Estado"; registrar na spec, em "Para a GBR confirmar", as decisões de "Dúvidas de produto".
7. Commits do lote (docs: plano; back; front), push e PR **rascunho** sobre `feat/pendencias-equipe` (C1), com os avisos: "Vai para produção junto com os Lotes F–K2"; "sem migração"; "resposta de mídia passa a pausar o robô também na conversa que já é do atendente"; "falha ao enviar a resposta do robô pausa o robô e não retenta (evita resposta duplicada)". **Sem merge, sem deploy.**

## Dúvidas de produto (decididas provisoriamente; para a GBR confirmar)

- **Pendência que ficou sem responsável durante a passagem (T-B1, `handoverSkipOf`):** acontece quando ela foi encerrada e reaberta no meio do caminho. Ela entra no pulo `other_handler`, que mostra "já com outro responsável". O texto não é exato, mas o caso é raro e quem sai continua sem a pendência. Recomendação: manter e revisar se a GBR estranhar.

- **Motivos de pulo além dos da spec (DT2, DT4.4):** "já sem atendente" e "já estava com {nome}" (este torna a repetição do pedido visível e inofensiva). Nas pendências, repetir o pedido (o responsável atual já é o destino) devolve `already_with_target`, "já estava com {nome}", como na caixa, e não "já com outro responsável". Recomendação: manter.
- **`handover=true` com `assignee` diferente de `me` (DT3):** o servidor ignora `assignee` e usa quem olha; "Recebidas" nunca mostra as de outra pessoa. Recomendação: manter.
- **Data da etiqueta e do topo (DT6/DT7):** a hora real do disparo (`firedAt`), não a de criação do envio agendado. Recomendação: manter.
- **Tetos por pedido (DT5):** 100 conversas e 50 pendências, com aviso para repetir. Recomendação: manter; medir.
- **ADMIN passa pendências de responsável inativo ou fora do alcance (DT4):** a lista do ADMIN inclui as "Sem responsável" cujo responsável gravado é quem sai. Recomendação: manter.
- **Etiqueta sem link; "Ver resultado" só no topo (DT6/DT7).** Recomendação: manter.
- **Envio antigo sem finalidade:** "Envio à equipe · {dd/MM HH:mm}". Recomendação: manter.
- **Falha ao enviar a resposta do robô pausa o robô e não manda contingência (DT8):** a resposta pode ter saído. Recomendação: manter.
- **Fila do robô indisponível no recebimento (DT8):** a mensagem fica sem resposta automática, nunca duplicada (limite declarado).

## Não verificado (conferir na task dona)

(Conferidos neste plano: `ConversationOwnershipService.command/assign` e `ChangePlan` (`conversation-ownership.service.ts:52-224`); `assignChange`/`canAssign` (`conversation-assign.rules.ts`); `claimForReply` com `changed: false` sem escrita (`conversation-claim.ts:55-84`); `ChatActor = { id, role }`, `OwnershipChange.actions: ConversationHistoryAction[]`, `assignedAt = now` quando há atendente e `createdAt: change.now` no histórico, `kind = actions.at(-1)` (`conversation-ownership.repository.ts:24-44,83,102,123`); `sendReply` pausa depois de criar a mensagem (`chat.service.ts:182-187`); `prepareTeamMessage` pausa e `sendTeamMessage` só roda depois dela (`chat.service.ts:210-269`, `team-whatsapp-send.processor.ts:236-240`); `sendMediaReply` sem pausa (`chat-media.service.ts:50-94`); `handle` e `handleFailure` do robô (`bot-reply.service.ts:34-177`); enqueue e chave Redis (`chat-ingest.service.ts:770-805`); `listConversationsQuerySchema` e `ChatMessage` (`chat.schema.ts:4-95`); `fromDbPurpose` (`team-whatsapp.purpose-codes.ts:67-71`); `PURPOSE_LABEL` no front (`features/team-whatsapp/labels.ts:12`).)

- Lembrete → pendência do alerta pai (DT7, T-B4b): decidido por `TeamWhatsappRecipient.parentRecipientId` (`schema.prisma:1967`, a coluna de `alertOriginalOf`); só confirmar que o destinatário de lembrete a preenche nas fixtures do K2. Sem casar por `userId`.
- `TeamWhatsappDispatch.firedAt` (hora real do disparo) e `createdAt` (T-B4a, T-B4b): confirmar nome e tipo da coluna e que `firedAt` é nula em envio imediato antigo (`COALESCE`).
- `ChatMediaService.repo` é `ChatRepository` com `setBotPaused` (T-B6a); senão, injetar.
- Precisão de `Conversation.assignedAt` e `ConversationHistoryEntry.createdAt` (ambas `TIMESTAMP(3)` na migração do K1) para a igualdade do DT3 (T-B3).
- Índice de `Message(conversationId, …)` para a consulta das etiquetas e do topo (T-B4a, T-B4b).
- Se `route-parity.spec.ts` cobre controllers de `chat` (T-B2) e o formato da linha de `@Roles('ADMIN','OPERATOR')` (T-B4b).
- `ChatHistorySyncService` e `ChatMediaDownloadProcessor` montáveis com fila espiã nos specs (T-B6b); se o processor de download já tiver teste de `fromMe`, só confirmar o nome.
- Valores de `assignee` aceitos no `localStorage` da lista (`conversations-list.tsx:29-57`) e o tipo da aba (`assignee-tabs.tsx:11-15`) (T-F3a).
- Onde `pendencies-page.tsx` monta `renderActions` e o papel do usuário (T-F4).
