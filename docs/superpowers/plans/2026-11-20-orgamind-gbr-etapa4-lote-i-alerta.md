# OrgaMind, Etapa 4 GBR, Lote I: alerta urgente com ciência — permissão `equipe.urgencia`, linha de confirmação, prazo, ciência automática e manual, painel de pendências, lembrete aos pendentes (MSG-02). Implementation Plan

> **Para os agentes:** executar pela skill `sdd` (TDD, ledger em `.superpowers/sdd/2026-11-20-orgamind-gbr-etapa4-lote-i-alerta/progress.md`). **Sem commit/push**: nenhuma task commita; a principal integra e commita o lote. Branch `feat/alerta-urgente`, criado de `feat/envio-rastreavel` em `79b33b1` (Lote H, PR #20). Fechamento de task por `gate --changed --base feat/envio-rastreavel`. Regras dos agentes: `.superpowers/sdd/2026-11-20-orgamind-gbr-etapa4-lote-i-alerta/{implementer-rules,reviewer-rules}.md` (criadas na Preparação). Linhas citadas são pistas e podem ter mudado.

**Goal:** no alerta urgente (finalidade Urgência criada a partir desta versão), cada pessoa confirma que recebeu respondendo "OK"; quem envia vê, por nome e com prazo de 15 min, quem confirmou, quem respondeu sem confirmar e quem não respondeu; pode mandar até 3 lembretes só aos pendentes e registrar a ciência dada por ligação; criar alerta passa a exigir a chave `equipe.urgencia`. T09 / cenário 10 demonstrados por uma suíte de integração com banco real.

**Architecture:** no back, módulo `backend/src/modules/team-whatsapp/`: uma migração aditiva (colunas de ciência e de lembrete, enum `TeamAlertAckKind`, motivo de pulo `ACKED`); regras puras do alerta num arquivo novo (`team-alert.rules.ts`: linha fixa, palavras de ciência, grupos, elegíveis, limites); a chave nova no catálogo (`shared/authz/permissions.ts`) e um portão por finalidade (`team-alert.policy.ts`) chamado na criação e na prévia; a ciência automática entra pelo rastreio da resposta (`tracking/team-recipient-tracking.service.ts` + `tracking/team-alert-reply.ts`), com a ingestão do chat passando a mensagem recebida; ciência manual, painel e lembrete em serviços novos atrás de um controller novo (`team-alert.controller.ts`, mesmo prefixo `internal/team-whatsapp`); o processor de envio pula o destinatário de lembrete cujo original já tem ciência (`ACKED`, pelo `finishSkipped` do Lote H). No front, `frontend/src/features/team-whatsapp/` e `frontend/src/features/permissions/`: chave e rótulo novos, finalidade Urgência escondida sem a chave, linha fixa e contador, painel com polling, coluna "Ciência", diálogos de lembrete e de ciência manual, "Lembrete do alerta de …" no histórico e a entrada de Novidades.

**Tech Stack:** NestJS + Prisma 6 + Zod v4 + BullMQ + Vitest/testcontainers no back; React + TanStack Query + Vitest/Testing Library no front. **Sem dependência nova.**

**Spec:** `docs/superpowers/specs/2026-11-20-orgamind-gbr-etapa4-envio-urgencia.md` — Restrições, Anti-objetivos, C1–C3, "Lote I" (I1–I9), "Para a GBR confirmar" (linha do Lote I e Transição), aceites 6–20 e 22 (o 21 é do Lote H, já entregue), "Fica com o construtor". Mapas: `.superpowers/sdd/2026-11-20-orgamind-gbr-etapa4-envio/fontes/` (`mapa-i-permissoes.md`, `mapa-i-resposta-rastreio.md`, `mapa-i-urgencia-back.md`, `mapa-i-front.md`, e os gerais `mapa-estados-respostas-back.md`, `mapa-canal-fila-back.md`, `mapa-front.md`). Plano do H: `docs/superpowers/plans/2026-11-20-orgamind-gbr-etapa4-lote-h-rastreio.md` (DH2, DH3, DH11 e GH1–GH9 continuam valendo; aqui só se repete o que a task usa).

## Estado (20/11/2026)

- **Plano escrito e ajustado após a revisão 1** (`.superpowers/sdd/2026-11-20-orgamind-gbr-etapa4-lote-i-alerta/plan-review-1.md`, 3 Important + 7 Minor aplicados: specs de contagem de chaves na T2/T11 e no GI1; lembrete grava o telefone atual da pessoa; DI12 e a extração da área do "Repetir" numa task própria, T14, na Onda 3; `ackMessageAt` e cast no desfazer; `loadAlertHeader` e `getPanel` no CI5; T4/T8 como `fronteira`; T9 com `createMany` e timeout da transação); **nada implementado**. Branch `feat/alerta-urgente` @ `79b33b1` (= ponta de `feat/envio-rastreavel`, Lote H, PR #20).
- **Próximo passo:** Preparação; depois Onda 1.
- **Lote I implementado e fechado (20/11/2026).** 14/14 tasks aceitas em 5 ondas (revisão opus em T1, T2, T4–T9 e T11–T14; sonnet em T3 e T10), sem fix round. Rulings no ledger: o painel troca a tabela por `AlertAndRecipients` quando há prazo (T12), `TeamAlertController` na lista PARITY a partir da T6, corridas da ordem (b)→(c) provadas na T6, `/* prettier-ignore */` na chamada de `trackTeamReply` (`chat-ingest.service.ts`) para não crescer `persistChatMessage`, ordem 404 antes do 422 na ciência manual (GI4), `no_recipients` no lembrete. Revisão final do conjunto (opus) APPROVED; 1 Minor corrigido (texto de `channel_disconnected` nas ações do alerta).
- **Gates no estado final:**
  - completos, contra `origin/main`, comparados com o fim do Lote H: back 7233/7263 (30 ignorados), coverage 95,4/87,2; front 2418/2418, coverage 88,9/83,0. Lint, sonar e complexidade sem nada novo nem agravado, depois de dois ajustes: o describe de `chat-ingest.service.spec.ts` voltou a 633 linhas, e saíram 3 linhas de prettier em `team-whatsapp.t08-stuck.integration.spec.ts` que vinham do Lote H;
  - `--changed` contra `feat/envio-rastreavel`: back 2821/2821, 99,5% das linhas novas; front 792/792, 99,2%.
- **QA local:**
  - migração aplicada no banco de QA em 16 ms, com 28 envios, 101 destinatários e 20 RolePermission antes e depois;
  - dados fictícios `qa_i_*`, com a reversão em `qa/qa-data.md`;
  - QA visual C1–C8 PASS (Marina ADMIN e Rafael SUPERVISOR sem a chave);
  - a trilha da ciência manual guarda só ids.
- **Não verificado:** conferência com WhatsApp real (resposta, reação e lembrete), porque o QA local não tem provedor; versão do Postgres da produção nova (a migração exige 12 ou mais novo); efeito do `@updatedAt` da ciência manual num destinatário `QUEUED` sobre o verificador de presos (no máximo adia 30 min; aceito).
- **Backlog (Minor):**
  - aspas duplas nos arquivos novos do front;
  - comentário de lock na migração;
  - integrações sem RED (T2, T6, T14);
  - título de `permissions.spec.ts:41`;
  - `toContain('falha marcando')` acoplado ao texto do warn;
  - desfazer ciência manual sem diálogo de confirmação: não foi pedido e a ação é reversível.
- **Próximo passo:** commits, push e PR rascunho sobre `feat/envio-rastreavel` (PR #20). Sem merge e sem deploy.

## Preparação (principal, antes da T1)

1. Conferir `git merge-base feat/alerta-urgente feat/envio-rastreavel` = `79b33b1` (senão o `--changed` mede o Lote H junto). Em worktree: `backend/.env` fictício e `node_modules` por symlink (memória "gate em worktree").
2. Criar `implementer-rules.md` e `reviewer-rules.md` copiando os do Lote H e adaptando: branch, base `feat/envio-rastreavel`, este plano, a spec da Etapa 4, o ledger novo; referências `DIn`, `GIn` e `CIn` anexadas no fim do brief; "o Lote H está pronto no branch; não revisar nem mexer fora do ownership". Riscos do lote no `reviewer-rules.md` (copiar o Review Focus abaixo): "Ciente" sem confirmação (resposta qualquer, resposta a outro envio, de outro número, reação, figurinha, imagem com legenda); corrida ciência automática × manual × desfazer; dois lembretes por dois cliques; lembrete a quem confirmou depois da lista ou a quem não era do alerta; 403 da chave depois de alguma leitura de pessoas ou depois do 404; texto de resposta, observação, nome ou telefone em log, trilha, erro lançado ou `failedReason`; mensagem saindo sozinha por prazo.
3. Criar o ledger `progress.md` com a referência Git de partida (`79b33b1`) e os arquivos não commitados de fora do lote (`.playwright-mcp/`, `reports/`, `research_notes/`, `tutoriais/`).

## Decisões deste plano (o que a spec deixa com o construtor)

- **DI1. Uma migração aditiva** `20261120150000_team_alert_ack`:
  - enum novo `TeamAlertAckKind { KEYWORD MANUAL }`; `TeamWhatsappSkipReason` + `ACKED` (`ALTER TYPE … ADD VALUE`, aceito dentro da transação do `migrate deploy` em Postgres ≥ 12; o valor não é usado na própria migração — conferir a versão da imagem do Postgres no `docker-compose` e no testcontainer);
  - `TeamWhatsappDispatch` + `ackDeadlineMinutes Int?` (prazo do alerta; `null` = não é alerta), `parentDispatchId String?` (lembrete → alerta, FK `ON DELETE SET NULL`), `reminderCount Int @default(0)`, `lastReminderAt DateTime?`, `@@index([parentDispatchId])`;
  - `TeamWhatsappRecipient` + `ackAt DateTime?`, `ackKind TeamAlertAckKind?`, `ackByUserId String?` (sem FK, como `authorId` no detalhe: nome buscado na leitura), `ackNote String? @db.VarChar(200)`, `ackMessageId String?`, `ackMessageAt DateTime?` (hora de recebimento da mensagem de `ackMessageId`, gravada junto com ela; o desfazer da manual usa esta coluna e não lê a `Message`, que é apagada em cascata com a conversa, `schema.prisma:1058`), `lastReplyMessageId String?` (sem FK: a `Message` pode sumir; o painel trata como "sem texto"), `parentRecipientId String?` (FK `ON DELETE SET NULL`), `@@index([parentRecipientId])`;
  - relações Prisma nomeadas `"AlertReminders"` (dispatch) e `"ReminderRecipients"` (recipient).
  - **Nenhuma linha existente muda**: colunas nulas; `reminderCount` com default constante não reescreve a tabela (Postgres ≥ 11 grava o default no catálogo). **Nenhuma linha de `RolePermission`** (a chave nova não é semeada; I1). Cabeçalho como o de `20261120140000_team_recipient_tracking/migration.sql` (o que faz, locks, `SET LOCAL lock_timeout = '15s';`). Os dois `CREATE INDEX` e as FKs autorreferentes bloqueiam escrita nas duas tabelas por instantes (sem `CONCURRENTLY`, mesma conclusão do DH1): deploy fora do horário de envio.
- **DI2. Chave `equipe.urgencia` (I1).** Back: no fim de `PERMISSION_KEYS`; `PERMISSION_DENIED_TEXT['equipe.urgencia'] = 'Você não tem permissão para criar alerta urgente.'`; `DEFAULT_MATRIX` **não muda** (SUPERVISOR e OPERATOR não a listam → padrão desligado; linha ausente no banco cai no padrão, `permissions.ts:84`); ADMIN a recebe por `[...PERMISSION_KEYS]`. Front: espelho em `features/permissions/keys.ts` (mesma ordem; matriz padrão sem ela; `PERMISSION_LABELS['equipe.urgencia'] = { name: 'Criar alerta urgente', description: 'Enviar alerta urgente com motivo e prazo de ciência, mandar lembrete aos pendentes e registrar ciência manual. Sem ela, a finalidade Urgência não aparece.' }`). Portão no servidor, em `team-alert.policy.ts`: `requireUrgencyFor(actor, purpose)` (lança `permissionDenied('equipe.urgencia')` só quando `purpose === 'urgency'` e falta a chave) e `requireUrgencyKey(actor)` (incondicional, para lembrete e ciência manual). Ordem na criação e na prévia: guard `equipe.enviar` (403) → `requireSender` (403 `team_whatsapp.forbidden`, só lê o ator) → `requireUrgencyFor` (403) → qualquer leitura de setores/pessoas. O "Repetir" não muda (I1).
- **DI3. Linha fixa e limite (I2).** `ALERT_CONFIRM_LINE = 'Responda OK para confirmar que recebeu.'`; `ALERT_CONFIRM_SUFFIX = '\n\n' + ALERT_CONFIRM_LINE` (41 caracteres); texto gravado = `text + ALERT_CONFIRM_SUFFIX`, exatamente, sem aparar (o contador do front soma o mesmo). DTO de criação: com `purpose === 'urgency'` e `text.length + 41 > 2000` → issue no caminho `text` ("Com a linha de confirmação, o texto passa de 2000 caracteres") → 400. Na Urgência, o texto do usuário vai até 1959. A prévia não muda (não cobre o texto). Lembrete: `REMINDER_PREFIX = 'Lembrete: '` + texto do alerta (até 2010, permitido).
- **DI4. Prazo (I3).** `ALERT_ACK_DEADLINE_MINUTES = 15`, gravado em `ackDeadlineMinutes` na criação do alerta (só Urgência; o lembrete grava `null`). `ackDeadlineAt = createdAt + ackDeadlineMinutes` (a Urgência só tem "agora": `createdAt` = confirmação). Ciência "após o prazo" = `ackAt > ackDeadlineAt`. O front espelha a constante para a revisão (padrão de `MAX_TEXT`), com comentário de sincronia; o resto da tela usa o `ackDeadlineAt` da API.
- **DI5. Palavra de ciência (I4), `isAckWord({ kind, text })`.** Só `kind === 'TEXT'` com `text` não nulo. Normalização: `text.normalize('NFD').replace(/\p{M}/gu, '')` (tira acentos e o seletor de variação U+FE0F) → apara nas pontas `/^[\s\p{P}]+|[\s\p{P}]+$/gu` → `toLowerCase()`. Vale se o resultado é `ok`, `ciente`, `confirmo`, `recebido` ou casa `/^👍[\u{1F3FB}-\u{1F3FF}]?$/u` (joinha com ou sem tom de pele). Casos do aceite 7: "Ok!", "OK", "Ciente.", "👍🏽" → sim; "ok, mas não vou", "não entendi" → não; IMAGE/VIDEO com legenda "ok", AUDIO, STICKER, UNSUPPORTED (reação) → não.
- **DI6. Ligação da resposta ao alerta (I4).** `applyReply` ganha `message?: { id; kind; text }` (opcional, GI8). Fluxo: (1) busca do destinatário mais recente como hoje (canal, contatos, `acceptedAt < receivedAt`, `REPLY_CANDIDATES`, `acceptedAt desc, id desc`), agora selecionando também `acceptedAt`, `parentRecipientId` e `dispatch.{ackDeadlineMinutes, parentDispatchId}`; (2) estado de entrega como hoje: só se não está `REPLIED`, `updateMany` → `REPLIED` (o retorno antecipado de hoje passa a valer **só** para esta gravação); (3) com `message`, `recordAlertReply` (arquivo novo `tracking/team-alert-reply.ts`): original = `latest.parentRecipientId` quando `latest.dispatch.parentDispatchId` não é nulo (lembrete), senão `latest.id` quando `latest.dispatch.ackDeadlineMinutes` não é nulo (alerta), senão nada; e só se `receivedAt − latest.acceptedAt ≤ 24 h` (inclusive; `ACK_REPLY_WINDOW_MS`). Gravações no original, **nesta ordem e separadas** (sem transação): (a) `lastReplyMessageId = message.id` (sempre; a última gravada vence); (b) se `isAckWord`: `updateMany { id, ackMessageId: null } → { ackMessageId: message.id, ackMessageAt: receivedAt }` (as duas colunas na mesma gravação condicional); (c) depois, `updateMany { id, ackAt: null } → ackAt = receivedAt, ackKind = 'KEYWORD'`. **A ordem (b) antes de (c) é obrigatória**: com (c) primeiro, um desfazer da manual entre (c) e (b) apagaria a ciência e o "OK" ficaria sem efeito (aceite 22). O valor devolvido continua o id que virou `REPLIED` (ou `null`). Nenhum log novo; o `trackTeamReply` continua o único `catch` (best-effort).
- **DI7. Ciência manual e desfazer (I5).** Marcar: `updateMany { id: recipientId, dispatchId, ackAt: null } → { ackAt: now, ackKind: 'MANUAL', ackByUserId: actor.id, ackNote: note }`; `count 0` → 422 `team_whatsapp.ack_exists`. Desfazer: **um único `UPDATE` SQL** (`$queryRaw`), `WHERE id = $recipientId AND "dispatchId" = $dispatchId AND "ackKind" = 'MANUAL'`, que grava `"ackAt" = "ackMessageAt"`, `"ackKind" = CASE WHEN "ackMessageAt" IS NOT NULL THEN 'KEYWORD'::"TeamAlertAckKind" ELSE NULL END` (o cast é obrigatório: sem ele o `CASE` sai como `text`), `"ackByUserId" = NULL`, `"ackNote" = NULL`, e `RETURNING "ackKind"`; nenhuma linha → 422 `team_whatsapp.ack_not_manual`. **Sem leitura da `Message`**: ela é apagada em cascata com a conversa e um "OK" real voltaria à pendência; como `ackMessageId` e `ackMessageAt` são gravados juntos (DI6 (b)), o valor da própria linha no instante do `UPDATE` decide automática ou pendência. `ackMessageId`, `ackMessageAt` e `lastReplyMessageId` nunca são apagados. A observação é aparada, 1–200 caracteres (DTO). Resposta `204` nas duas rotas.
- **DI8. Grupo, melhor estado e elegíveis (I6, I7), funções puras sobre `{ ackAt, lastReplyMessageId, statuses }`** (`statuses` = estado do original seguido dos estados dos destinatários de lembrete com `parentRecipientId` = original):
  - grupo: `ackAt` → `acked`; senão `lastReplyMessageId` ou algum `REPLIED` → `replied`; senão algum `SENT|DELIVERED|READ` → `no_reply`; senão → `no_delivery`;
  - melhor estado (exibição): o primeiro presente na ordem `REPLIED, READ, DELIVERED, SENT, UNCERTAIN, QUEUED, SCHEDULED, FAILED, SKIPPED, CANCELLED`;
  - elegível ao lembrete: sem `ackAt` e grupo `no_reply` ou `replied`, ou grupo `no_delivery` com algum `UNCERTAIN` (então `mayHaveReceived = true`, "pode já ter recebido"); `no_delivery` só com `FAILED`, `SKIPPED`, `QUEUED`, `SCHEDULED` ou `CANCELLED` não entra.
- **DI9. Painel (I6): rota de leitura própria** `GET /internal/team-whatsapp/dispatches/:id/alert` (`@Roles('ADMIN','SUPERVISOR','OPERATOR')`, sem a chave nova). Visibilidade igual ao `requireVisible` de `team-whatsapp-results.service.ts:301-313` (ator não remetente → 403; não vê → o mesmo 404); envio sem `ackDeadlineMinutes` (outra finalidade, urgência antiga, lembrete) → 422 `team_whatsapp.not_an_alert`. Contrato CI5. Pessoas ordenadas por grupo na ordem da spec (Sem entrega, Sem resposta, Respondeu sem ciência, Ciente) e por nome (`localeCompare('pt-BR')`). Textos das respostas = `Message.content` (de `ackMessageId` e de `lastReplyMessageId`), com `kind` e hora (`receivedAt ?? createdAt`); `Message` ausente → `null`. Nomes do autor da ciência manual e dos autores dos lembretes por um `user.findMany` só. Sem telefone no painel. Lembretes: todos os envios com `parentDispatchId` = alerta (mesmo de outro autor, I7), com hora, nome do autor e quantos destinatários. `reminders.nextAllowedAt = (lastReminderAt ?? createdAt) + 5 min`, `null` quando `reminderCount ≥ 3`.
- **DI10. Lembrete (I7).** Rota `POST /internal/team-whatsapp/dispatches/:id/reminders` (`@RequirePermission('equipe.enviar')`, `202`), corpo `{ recipientIds }` (1 a 500 ids, sem repetição), resposta `{ reminderId, queued }`. Fluxo, nesta ordem: ator (`findActor`; nulo → 403 `team_whatsapp.forbidden`) → `requireUrgencyKey` (403) → visível (`findDispatchForActor` + `canViewDispatch`, senão o 404 de hoje) → `isTeamSender` (403 `team_whatsapp.forbidden`) e a checagem de área do "Repetir" (`team-dispatch-area.ts`, extraída pela T14 de `team-whatsapp-retry.service.ts:76-91` sem mudar o corpo; CI10) → `loadAlertHeader` (CI5; sem `ackDeadlineMinutes` → 422 `not_an_alert`) → **pré-checagem fora da transação**: elegíveis ∩ pedidos vazia → 422 `reminder_empty`; `reminderCount ≥ 3` → 409 `reminder_limit`; `now < (lastReminderAt ?? createdAt) + 5 min` → 409 `reminder_too_soon` → telefone atual das pessoas escolhidas (a leitura do envio "agora", DG7) → número dos setores das pessoas escolhidas (`findSectorChannels` + `requireSectorNumbers`, 422 de hoje) e conferência ao vivo (`requireOpenNumbers`, 409 `channel_disconnected`/`channel_unverified`; nenhuma chamada ao provedor dentro de transação) → **transação interativa com `timeout` explícito** (`$transaction(fn, { timeout: 15_000 })`; o padrão de 5 s do Prisma não basta para 500 destinatários): relê cabeçalho (`loadAlertHeader(tx, …)`) e elegíveis (`loadAlertPeople(tx, …)`), refaz as três recusas (mesmos códigos), troca condicional `updateMany { id: alertId, reminderCount: <lido>, lastReminderAt: <lido> } → { reminderCount: { increment: 1 }, lastReminderAt: now }` (`count 0` → 409 `reminder_too_soon`: outro pedido venceu) e cria o envio do lembrete (`create`, sem gravação aninhada) e as linhas de setor e os destinatários por `createMany` (ids gerados antes da gravação para servirem de `jobId`, ou `createManyAndReturn`; seguir o padrão de id do schema e registrar no report) → fora da transação, `enqueueTeamSend` (`team-whatsapp.service.ts:~695`, `jobId = recipientId`; falha de fila = regra de hoje: `FAILED queue_unavailable` e 500, o lembrete fica consumido) → trilha. Pedido recusado ou vazio não consome lembrete.
  - Envio do lembrete: `purpose URGENCY`, mesmo `urgencyReason`, `audienceBase`, `targetType`, `targetId`, `targetLabel`, snapshot de turno e `rosterDate` do alerta; as mesmas linhas de `TeamWhatsappDispatchSector`; `audienceRule`, `audienceExcluded`, `roster` nulos; `includeOff false`; `parentDispatchId = alertId`; `ackDeadlineMinutes null`; `authorId = actor.id`; `text = REMINDER_PREFIX + alert.text`; `channelId` como `singleChannelId`.
  - Destinatário do lembrete: copia do original `userId`, `userName`, `shiftId/Name`, `sectorId/Name` e `levelName`; `phoneE164` = **telefone atual da pessoa na criação do lembrete**, lido como o envio "agora" lê (I7: "Telefone, número e a conferência na hora seguem as regras do envio 'agora' (inclusive telefone gravado, Lote G)"; no "agora" o telefone gravado é o atual na criação, DG7, `team-whatsapp-send.processor.ts:42`). Quem trocou de número depois do alerta recebe o lembrete no número novo; o processor só aplica `PHONE_CHANGED` se o telefone mudar entre a criação do lembrete e a saída (regra do Lote G). Pessoa sem telefone atual, suprimida ou sem autorização: a mesma regra do envio "agora" — `phoneE164 = sendPhoneOf(pessoa)` e `phoneSkipReason` na criação (`recipient-skip.ts:12-30`, como em `team-whatsapp.service.ts:684-686`): quem tem motivo nasce `SKIPPED` com ele e não conta em `queued`; os demais nascem `QUEUED`. **Nunca** reaproveitar o telefone do alerta como reserva (o painel e o `AlertPersonRow` não carregam telefone). Número = o número **atual** da área do setor (`channelId/Name/PhoneE164`); `status QUEUED` (ou `SKIPPED` com o motivo de `phoneSkipReason`, acima); `parentRecipientId = original.id`.
  - Trilha `team_whatsapp.reminder`: `audit.log('team_whatsapp.reminder', 'TeamWhatsappDispatch', alertId, { actorId, alertId, reminderId, queued })`.
- **DI11. "Pulado: já confirmou" no processor (I7).** O `recipientSelect` do processor ganha `parentRecipientId`. Em `sendPaced`, **depois do pacing e antes do `liveBlock`** (dentro do `try`, para o `finally` soltar o pacing), se há `parentRecipientId`, uma leitura nova de `ackAt` do original (`parentAcked(prisma, id)`, arquivo novo `team-alert-send.ts`); com ciência → `finishSkipped(prisma, { recipientId, messageId: r.messageId, skipReason: 'ACKED' })` (cancela a `Message` `QUEUED` preparada, DH3) e retorna, sem consultar a porta ao vivo nem o provedor. Vale para o "Repetir" do lembrete (mesmo processor). `priorOutcome` continua antes de tudo: uma `Message` que já saiu continua `SENT`. Janela residual aceita: ciência que chega entre essa leitura e a chamada ao provedor (milissegundos) não segura o lembrete.
- **DI12. Histórico e detalhe.** Pelo `dispatch-purpose-view.ts` (que já monta finalidade, base e motivo para a lista e o detalhe): item da lista e detalhe + `ackDeadlineMinutes: number | null`, `ackDeadlineAt: string | null` (ISO) e `reminderOf: { dispatchId: string; createdAt: string } | null` (do `parentDispatch`). Front: "Lembrete do alerta de dd/mm HH:mm" (Manaus) na célula de finalidade e no cabeçalho do resultado; "Prazo de ciência: 15 min" na célula de finalidade do alerta. Urgência antiga: os três campos nulos → tela de hoje (I8).
- **DI13. Controller novo** `team-alert.controller.ts` com `@Controller('internal/team-whatsapp')` (mesmos guards globais; rotas de escrita só com `@RequirePermission('equipe.enviar')`, leitura só com `@Roles(...)`, nunca os dois na mesma rota — `route-parity.spec.ts:256`). `TeamWhatsappController` não muda. Se algum spec enumerar todos os controllers e reclamar, as rotas novas entram em `NEW_ROUTES` de `route-parity.spec.ts:120-123` (registrar no report).
- **DI14. Erros novos** em `team-alert.errors.ts` (padrão de `team-whatsapp.errors.ts`): `not_an_alert` 422, `ack_exists` 422, `ack_not_manual` 422, `reminder_empty` 422, `reminder_limit` 409, `reminder_too_soon` 409, todos `team_whatsapp.<código>`. Textos do front (`error-messages.ts`): "Este envio não é um alerta urgente."; "Esta pessoa já tem ciência registrada."; "Só a ciência manual pode ser desfeita."; "Nenhuma das pessoas escolhidas está pendente. Atualize a lista."; "Este alerta já teve 3 lembretes, o máximo."; "Espere 5 minutos desde o alerta ou o último lembrete."; `SKIP_REASON_LABEL.ACKED = 'já confirmou'` ("Pulado: já confirmou").
- **DI15. Tela (I6).** Painel acima de `RecipientTable` no resultado do alerta. Cabeçalho: "Prazo de ciência: 15 min — vence às HH:mm" (antes) ou "— vencido às HH:mm" (depois); contagem de cada grupo; grupos na ordem da spec, nomes com o rótulo da ciência; abaixo do nome: ciência automática → texto da mensagem que deu a ciência; manual → "Obs.: <observação> — <autor>" e, se houver, a última resposta abaixo; sem ciência → texto da última resposta. Sem texto (áudio, figurinha, reação, imagem sem legenda) → "(Áudio)", "(Imagem)", "(Vídeo)", "(Figurinha)", "(Documento)", "(Mensagem sem texto)". Rótulos: "Ciente às HH:mm", "Ciente (manual) às HH:mm", "Ciente (após o prazo) às HH:mm", "Ciente (manual, após o prazo) às HH:mm", "Pendente · há N min" (N = minutos inteiros desde o `createdAt`; abaixo de 1, "Pendente · há menos de 1 min") até o prazo e "Pendente — prazo vencido" depois. Lista de lembretes: "HH:mm · <autor> · N pessoas". Coluna "Ciência" na tabela só no alerta, depois de "Quando", com o mesmo rótulo (mapa `recipientId → rótulo` vindo do painel; a API de destinatários não muda). Polling do painel: 10 s (`POLL_INTERVAL_MS`) enquanto houver pendência (`noDelivery + noReply + replied > 0`) e `now − createdAt < 2 h`. Horas em America/Manaus (`manausDateTime`).
- **DI16. Demonstração de T09 (aceite 6) com o harness do T08** (`team-whatsapp.t08.test-fixtures.ts`: `buildT08World`, fila em memória, provedor e porta ao vivo falsos, processor e `ChatService` reais). A resposta entra pela ingestão real quando o `ChatIngestService` puder ser montado com Redis/filas/eventos falsos; senão, o teste grava a `Message` `INBOUND` como `persistChatMessage` grava e chama `applyReply` com os mesmos argumentos que a ingestão passa (a passagem é provada por unidade na T5). A T10 registra no report qual caminho usou.

## Global Constraints

- **GI1. Escopo:** back só `backend/src/modules/team-whatsapp/` (inclui `tracking/` e `dto/`), `backend/src/modules/chat/chat-ingest.service.ts` (só a assinatura e a chamada de `trackTeamReply`) e specs novos de `chat/`, `backend/src/shared/authz/permissions.ts`, os specs que fixam as chaves listados na T2 (`backend/src/shared/authz/permissions.spec.ts`, `backend/src/modules/permissions/role-permissions-migration.integration.spec.ts`, `backend/src/modules/permissions/permissions.repository.integration.spec.ts`, `backend/src/modules/sector-people/sector-people.repository.integration.spec.ts`), `backend/src/modules/permissions/route-parity.spec.ts` (só `NEW_ROUTES`, se preciso), `backend/src/schemas/contracts/team-whatsapp.schema.ts`, `backend/prisma/`, e um spec novo de teste do adaptador Evolution (só teste, T5). Front só `frontend/src/features/team-whatsapp/`, `frontend/src/features/permissions/` (inclui os specs que fixam as chaves listados na T11: `permissions-matrix.spec.tsx`, `access.spec.ts`), `frontend/src/release-notes.ts` e um spec novo dele. **Não mudam:** adaptador da Evolution, webhooks, `chat.service.ts`, `channel-live-state.service.ts`, worker e filas (nenhuma fila nova), o verificador de presos do Lote H. Nenhuma chamada nova ao provedor (spec Restrições: "nenhuma chamada nova ao provedor além das que já existem (estado da conexão e envio de texto)").
- **GI2. Nunca ciência falsa (Anti-objetivos):** "Uma pessoa aparecer como 'Ciente' sem ter confirmado (resposta qualquer, resposta a outro envio, resposta de outro número, reação)" é falha. "Um lembrete chegar a quem já confirmou, a quem não era do alerta, ou sair duas vezes por dois cliques" é falha. O prazo só muda rótulo e ordem: nenhuma mensagem sai sozinha (I3). O rastreio é best-effort: falha nele deixa a pessoa pendente, nunca ciente, e não perde a mensagem recebida (I4).
- **GI3. Dado pessoal (spec Restrições e Anti-objetivos):** "trilhas (`AuditService`) levam ids e contagens; texto da resposta e observação da ciência manual ficam só nas colunas do destinatário e na tela de quem vê o envio." Nome, telefone, texto de resposta e observação nunca em log, trilha, erro lançado ou `failedReason`.
- **GI4. Recusas e chave (I1, I5, I7):** sem `equipe.enviar`, o 403 é do guard, com o texto de `equipe.enviar` (o de hoje; o teste não exige o texto da urgência); com `equipe.enviar` e sem `equipe.urgencia`, 403 com o texto "Você não tem permissão para criar alerta urgente." (código `auth.permission_denied`); os dois **antes** de qualquer leitura de pessoas e **antes** do 404 (aceite 12: "inclusive para alerta que não veem"). Ordem da ciência manual: 403 → 404 (envio invisível ou destinatário de outro envio) → 422 (`not_an_alert`, `ack_exists`, `ack_not_manual`). Ordem do lembrete: 403 chaves → 404 → 403 remetente e área → 422 `not_an_alert` → 422 `reminder_empty` → 409 `reminder_limit` → 409 `reminder_too_soon` → 409 canal → gravação. Ver o painel não exige a chave. O "Repetir" segue `equipe.enviar` e a área, sem a chave nova.
- **GI5. Visibilidade (C2):** "ADMIN vê todos; os demais veem só os próprios envios. Telefone completo só com `telefone.ver_completo`." O painel de um alerta mostra os lembretes de qualquer autor a quem vê o alerta; o detalhe do lembrete segue a regra de hoje (autor ou ADMIN).
- **GI6. Urgência antiga (I8):** "Envio de Urgência sem prazo gravado e sem `parentDispatchId` (anterior a esta versão) aparece como hoje: sem painel, sem ciência, sem lembrete." Alerta = `ackDeadlineMinutes` não nulo; lembrete = `parentDispatchId` não nulo.
- **GI7. Validação:** cwd `backend/` ou `frontend/`. Loop `timeout 600 gate --test src/<arquivo>`; integração `TESTCONTAINERS_ENABLED=1 timeout 600 gate --test src/<arquivo>`. Tipos: back `npx tsc --noEmit -p tsconfig.build.json --tsBuildInfoFile /tmp/<task>.tsbuildinfo`; front `npx tsc -b`. Fechamento: back `TESTCONTAINERS_ENABLED=1 timeout 600 gate --changed --base feat/envio-rastreavel`; front `timeout 600 gate --changed --base feat/envio-rastreavel`. Nunca suíte inteira, gate completo, coverage ou e2e (são da principal). No máximo dois testcontainers ao mesmo tempo (a principal serializa).
- **GI8. Compila entre tasks:** assinatura existente só ganha parâmetro/campo opcional, salvo onde a task diz e ajusta chamadores e specs no próprio ownership. Campos novos de contrato: obrigatórios no back (a task que os cria os preenche), tolerantes no front (`.nullish()`/`.default(...)`). Sem commit.
- **GI9. Tempo nos testes:** serviços recebem `now` explícito (o controller lê o relógio); `createdAt`, `acceptedAt`, `receivedAt` gravados explícitos; `updatedAt` por SQL cru quando importar; nada de `vi.setSystemTime` com linha gravada pelo banco (memória "relógio falso × createdAt"). Telefones e nomes fictícios (`+5592991110001`, "Pessoa A").
- **GI10. Tamanho e legado:** funções e callbacks de `describe`/`it` até 50 linhas, complexidade 10, até 4 parâmetros; `describe` novos em arquivo novo (o que existe não cresce); conferir com `npx eslint <arquivos> --rule '{"max-lines-per-function": ["error", 50], "max-params": ["error", 4], "complexity": ["error", 10], "max-depth": ["error", 4]}'`. `prettier --write` só em arquivo novo; nunca restaurar arquivo do git. **Legados** (`team-whatsapp.repository.ts`, `team-whatsapp-send.processor.ts`, `team-whatsapp.service.ts`, `chat-ingest.service.ts`, `send-whatsapp-dialog.tsx`, `dispatch-result.tsx`, e também `team-whatsapp.controller.ts`, `team-audience.service.ts`, `team-whatsapp.schema.ts`) só recebem a troca de chamadas/campos que a task diz; lógica nova em arquivo novo.
- **GI11. Migração:** só aditiva, SQL escrito à mão com o cabeçalho do H (`SET LOCAL lock_timeout = '15s';`), DDL igual ao que `prisma migrate diff` gera; nome posterior a `20261120140000`; nunca `prisma migrate dev`/`reset` contra banco real; banco só o do testcontainer.
- **GI12. Nunca WhatsApp real:** porta do provedor e porta ao vivo falsas em todo teste; "a ciência é provada por integração com mensagens recebidas simuladas" (spec Restrições).

## Contratos compartilhados

**CI1. Prisma** (T1): DI1.

```prisma
enum TeamAlertAckKind { KEYWORD MANUAL }
// TeamWhatsappSkipReason += ACKED
// TeamWhatsappDispatch
ackDeadlineMinutes Int?        // prazo de ciência do alerta (I3); null = não é alerta
parentDispatchId   String?     // lembrete → alerta (I7)
parentDispatch     TeamWhatsappDispatch?  @relation("AlertReminders", fields: [parentDispatchId], references: [id], onDelete: SetNull)
reminders          TeamWhatsappDispatch[] @relation("AlertReminders")
reminderCount      Int       @default(0)
lastReminderAt     DateTime?
@@index([parentDispatchId])
// TeamWhatsappRecipient
ackAt              DateTime?
ackKind            TeamAlertAckKind?
ackByUserId        String?
ackNote            String?   @db.VarChar(200)
ackMessageId       String?   // 1ª mensagem recebida com palavra de ciência
ackMessageAt       DateTime? // hora de recebimento dessa mensagem, gravada junto (DI6 (b)); o desfazer usa esta coluna (DI7)
lastReplyMessageId String?   // última resposta ligada ao alerta
parentRecipientId  String?   // destinatário de lembrete → destinatário do alerta
parentRecipient    TeamWhatsappRecipient?  @relation("ReminderRecipients", fields: [parentRecipientId], references: [id], onDelete: SetNull)
reminderRecipients TeamWhatsappRecipient[] @relation("ReminderRecipients")
@@index([parentRecipientId])
```

Contrato: `teamSkipReasonSchema` + `'ACKED'` (T1). Repositório: `NewTeamDispatch` + `ackDeadlineMinutes?: number | null`, gravado por `createDispatch` (T1).

**CI2. Regras puras** (T3, `team-alert.rules.ts`; `team-alert.errors.ts`).

```ts
export const ALERT_ACK_DEADLINE_MINUTES = 15;
export const ALERT_CONFIRM_LINE = 'Responda OK para confirmar que recebeu.';
export const ALERT_CONFIRM_SUFFIX = `\n\n${ALERT_CONFIRM_LINE}`;          // 41
export const REMINDER_PREFIX = 'Lembrete: ';
export const MAX_REMINDERS = 3;
export const REMINDER_INTERVAL_MS = 5 * 60_000;
export const ACK_REPLY_WINDOW_MS = 24 * 3_600_000;
export function alertText(text: string): string;                        // text + SUFFIX
export function reminderText(alertText: string): string;                // PREFIX + alertText
export function isAckWord(m: { kind: MessageKind; text: string | null }): boolean;   // DI5
export function withinReplyWindow(acceptedAt: Date, receivedAt: Date): boolean;    // ≤ 24 h
export type AlertGroup = 'no_delivery' | 'no_reply' | 'replied' | 'acked';
export type AlertPersonFacts = { ackAt: Date | null; lastReplyMessageId: string | null;
  statuses: readonly TeamWhatsappRecipientStatus[] };                    // original primeiro, depois lembretes
export function alertGroupOf(f: AlertPersonFacts): AlertGroup;           // DI8
export function bestStatusOf(statuses: readonly TeamWhatsappRecipientStatus[]): TeamWhatsappRecipientStatus;
export function reminderEligibility(f: AlertPersonFacts): { eligible: boolean; mayHaveReceived: boolean };
export function alertDeadlineAt(createdAt: Date, minutes: number): Date;
export function reminderBlock(i: { reminderCount: number; lastReminderAt: Date | null;
  alertCreatedAt: Date; now: Date }): 'reminder_limit' | 'reminder_too_soon' | null;  // limite antes de intervalo
// team-alert.errors.ts: notAnAlert(), ackExists(), ackNotManual(), reminderEmpty(), reminderLimit(), reminderTooSoon()
```

**CI3. Portão da chave** (T2, `team-alert.policy.ts`).

```ts
export function requireUrgencyFor(actor: TeamActor, purpose: TeamPurpose | undefined): void; // 403 só na Urgência
export function requireUrgencyKey(actor: TeamActor): void;                                    // 403 sempre sem a chave
```

**CI4. Rastreio da resposta** (T5).

```ts
// TeamRecipientTrackingService
applyReply(input: { channelId: string; contactIds: readonly string[]; receivedAt: Date;
  message?: { id: string; kind: MessageKind; text: string | null } }): Promise<string | null>;
// tracking/team-alert-reply.ts
export type AlertReplyTarget = { id: string; acceptedAt: Date; parentRecipientId: string | null;
  dispatch: { ackDeadlineMinutes: number | null; parentDispatchId: string | null } };
export function alertOriginalOf(latest: AlertReplyTarget, receivedAt: Date): string | null;   // DI6, puro
export async function recordAlertReply(db: Pick<PrismaService, 'teamWhatsappRecipient'>,
  input: { originalId: string; messageId: string; receivedAt: Date; isAck: boolean }): Promise<void>;
// chat-ingest.service.ts (privado)
trackTeamReply(m: InboundChatMessage, link: { messageId: string; instanceId: string;
  twinIds: readonly string[] }, opts: { direction: MessageDirection; backfill?: boolean }): Promise<void>;
```

**CI5. Painel** (T7; contrato em `team-whatsapp.schema.ts`; front espelha em `alert-schemas.ts` na T12).

```ts
const alertMessageSchema = z.object({ text: z.string().nullable(), kind: <enum MessageKind>, at: z.string() });
export const teamAlertPanelSchema = z.object({
  dispatchId: z.string(), createdAt: z.string(),
  ackDeadlineMinutes: z.number().int(), ackDeadlineAt: z.string(),
  counts: z.object({ noDelivery: countSchema, noReply: countSchema, replied: countSchema, acked: countSchema }),
  people: z.array(z.object({
    recipientId: z.string(),            // destinatário do alerta original
    userName: z.string(),
    group: z.enum(['no_delivery', 'no_reply', 'replied', 'acked']),
    status: <enum de status do item de destinatário>,   // bestStatusOf
    ack: z.object({ at: z.string(), kind: z.enum(['keyword', 'manual']), late: z.boolean(),
      byName: z.string().nullable(), note: z.string().nullable() }).nullable(),
    ackReply: alertMessageSchema.nullable(),   // Message de ackMessageId
    lastReply: alertMessageSchema.nullable(),  // Message de lastReplyMessageId
    eligible: z.boolean(), mayHaveReceived: z.boolean(),
  })),
  reminders: z.object({ count: countSchema, max: z.number().int(), nextAllowedAt: z.string().nullable(),
    items: z.array(z.object({ dispatchId: z.string(), createdAt: z.string(),
      authorName: z.string().nullable(), recipients: countSchema })) }),
});
// lista e detalhe (DI12): ver CI10 (T14)
// team-alert.repository.ts
export type AlertDb = Pick<Prisma.TransactionClient, 'teamWhatsappRecipient' | 'teamWhatsappDispatch'>;
export type AlertPersonRow = { id: string; userId: string | null; userName: string;
  status: TeamWhatsappRecipientStatus; sectorId: string | null; sectorName: string | null;
  shiftId: string | null; shiftName: string | null; levelName: string | null;
  ackAt: Date | null; ackKind: TeamAlertAckKind | null; ackByUserId: string | null; ackNote: string | null;
  ackMessageId: string | null; lastReplyMessageId: string | null;
  reminderStatuses: TeamWhatsappRecipientStatus[] };
export async function loadAlertPeople(db: AlertDb, alertId: string): Promise<AlertPersonRow[]>;
export function factsOf(row: AlertPersonRow): AlertPersonFacts;
// team-alert-access.ts
export async function requireViewable(repo: TeamWhatsappRepository, actor: TeamActor, dispatchId: string): Promise<DispatchForActor>; // 404
// team-alert.repository.ts — única leitura do cabeçalho do alerta (DispatchForActor, repository.ts:196-203, não traz estes campos)
export type AlertHeader = { id: string; createdAt: Date; ackDeadlineMinutes: number;
  reminderCount: number; lastReminderAt: Date | null };
export async function loadAlertHeader(db: AlertDb, dispatchId: string): Promise<AlertHeader>;
//   ackDeadlineMinutes nulo (outra finalidade, urgência antiga, lembrete) → notAnAlert() (422); linha ausente → o 404 de hoje
//   consumida por T7 (painel), T6 (ciência manual) e T9 (lembrete, fora e dentro da transação); nenhuma delas relê por conta própria
// team-alert-panel.service.ts
export type TeamAlertPanel = z.infer<typeof teamAlertPanelSchema>;
export class TeamAlertPanelService {
  getPanel(actorId: string, dispatchId: string): Promise<TeamAlertPanel>;   // findActor → requireViewable → loadAlertHeader → loadAlertPeople; nada depende de now
}
```

**CI6. Ciência manual** (T6). Rotas no `team-alert.controller.ts`: `POST` e `DELETE /internal/team-whatsapp/dispatches/:id/recipients/:recipientId/ack`, `@RequirePermission('equipe.enviar')`, `@HttpCode(204)`; corpo do POST `manualAckSchema = z.object({ note: z.string().trim().min(1).max(200) })` (`dto/manual-ack.dto.ts`).

```ts
// team-alert-manual-ack.ts
export async function markManualAck(db, i: { dispatchId; recipientId; actorId; note; now: Date }): Promise<boolean>; // false = ack_exists
export async function undoManualAck(db, i: { dispatchId; recipientId }): Promise<'pending' | 'keyword' | null>;    // null = ack_not_manual
// TeamAlertAckService
markManual(actorId: string, dispatchId: string, recipientId: string, input: { note: string; now: Date }): Promise<void>;
undoManual(actorId: string, dispatchId: string, recipientId: string): Promise<void>;
// trilhas: team_whatsapp.ack_manual { actorId, dispatchId, recipientId }; team_whatsapp.ack_manual_undo { actorId, dispatchId, recipientId, result }
```

**CI7. Lembrete** (T9). `sendReminderSchema = z.object({ recipientIds: z.array(z.string().min(1)).min(1).max(500) })` + recusa de repetidos (`dto/send-reminder.dto.ts`); resposta `teamReminderResponseSchema = z.object({ reminderId: z.string(), queued: countSchema })`. `TeamAlertReminderService.send(actorId, alertId, input: { recipientIds: string[] }, now: Date): Promise<{ reminderId: string; queued: number }>`. A checagem de área vem de CI10 (T14). Transação com `{ timeout: 15_000 }` e `createMany` para setores e destinatários (DI10).

**CI8. Processor** (T8). `SkipReasonOf` += `'ACKED'`; `team-alert-send.ts`: `parentAcked(prisma: Pick<PrismaService, 'teamWhatsappRecipient'>, parentRecipientId: string): Promise<boolean>`.

**CI9. Front** (T11–T13). `alert-text.ts`: `ALERT_CONFIRM_LINE`, `ALERT_CONFIRM_SUFFIX_LENGTH = 41`, `ALERT_ACK_DEADLINE_MINUTES = 15` (espelhos com comentário de sincronia), `finalTextLength(text, purpose)`; `alert-labels.ts`: `ackLabel(person, panel, now)`, `deadlineText(panel, now)`, `replyText(msg)`, `alertPollInterval(panel, now)`, `GROUP_LABEL`; `alert-api.ts`: `useAlertPanel(dispatchId, enabled)`; `alert-actions-api.ts`: `useSendReminder(alertId)`, `useManualAck(alertId)`, `useUndoManualAck(alertId)` (invalidam o painel, `dispatchKey(id)` e `['team-whatsapp','dispatches']`).

**CI10. Histórico, detalhe e área do "Repetir"** (T14).

```ts
// item da lista e detalhe (team-whatsapp.schema.ts, obrigatórios no back; o front espelha em schemas.ts na T12, .nullish())
ackDeadlineMinutes: number | null;
ackDeadlineAt: string | null;                                    // ISO; createdAt + ackDeadlineMinutes (alertDeadlineAt)
reminderOf: { dispatchId: string; createdAt: string } | null;    // do parentDispatch
// team-dispatch-area.ts: a checagem de área extraída de team-whatsapp-retry.service.ts:76-91, sem mudar o corpo
//   (assinatura conforme o corpo atual; registrar no report); o retry passa a chamá-la; a T9 a reutiliza
```

## Review Focus

1. **Ciência falsa (GI2):** T3 `isAckWord` (todos os casos do aceite 7 e reação/figurinha/imagem com legenda); T5 `OK depois de envio de rotina mais novo — nada muda no alerta`; `OK 25 h depois — só Respondeu`; `OK de outro número — nada`; `reação UNSUPPORTED e imagem com legenda ok — Respondeu, sem ciência`; `reunião com OK — só Respondeu`; `situação incerta sem recibo — continua pendente`.
2. **Corrida automática × manual × desfazer (I4, I5, DI6, DI7):** T5 `ordem: ackMessageId gravado antes de ackAt`; T6 `manual e OK ao mesmo tempo — uma ciência; OK guarda ackMessageId`; `desfazer e OK ao mesmo tempo — ciência automática`; `desfazer com ackMessageId — automática com a hora do OK`; `manual sobre manual — ack_exists`.
3. **Dois lembretes simultâneos (I7, DI10):** T9 `dois pedidos com Promise.all — um lembrete, o outro 409 reminder_too_soon`; `pedido vazio, recusado ou com canal fechado não consome lembrete`.
4. **Lembrete a quem confirmou ou não era do alerta:** T9 `ids fora dos elegíveis ficam de fora; só fora → 422`; `ciência entre a lista e a confirmação — sai`; T8 `original com ciência — Pulado: já confirmou, Message cancelada, sem porta ao vivo nem provedor`; `Repetir do lembrete também pula`.
5. **Resposta ao lembrete ligada ao original:** T5 `OK ao lembrete — ciência no original`; `não entendi ao lembrete — lastReplyMessageId no original`.
6. **Retorno antecipado do `applyReply`:** T5 `destinatário já Respondeu: um OK seguinte ainda dá ciência`.
7. **Best-effort:** T5 `falha ao gravar a ciência — pendente, mensagem gravada e publicada` (aceite 17).
8. **403 antes de qualquer leitura e antes do 404 (GI4):** T2 `prévia e criação sem a chave — 403 sem ler setores nem pessoas`; T6/T9 `sem a chave num alerta invisível — 403, não 404`; T7 `painel sem a chave — 200`.
9. **Testes que fixam a contagem de chaves:** T2 e T11 (lista em cada task).
10. **Linha fixa no limite:** T4 `1959 + linha = 2000 aceito; 1960 → 400`; T11 `2001 somados trava o botão`.
11. **Dado pessoal (GI3):** T6/T9 trilhas só com ids e contagens; T10 `nenhum log nem trilha do cenário contém texto, observação, nome ou telefone` (aceite 15).

## Rastreio (aceite → task → teste)

| Aceite / item | Task | Teste |
|---|---|---|
| 6 (T09, cenário 10) | T10, T7, T11, T12 | T10 `cenário 10 ponta a ponta`; T11 `revisão da Urgência mostra o prazo`; T12 `Ciente às HH:mm com o texto; Sem resposta; passado o prazo, Pendente — prazo vencido` |
| 7 | T3, T5, T12 | T3 casos de `isAckWord`; T5 `não entendi seguido de Ok! — ciente, lastReply antes era não entendi`; `áudio, imagem com legenda ok e reação — sem ciência`; T12 `sem texto mostra (Áudio)` |
| 8 | T5 | `rotina mais nova`; `25 h — só Respondeu`; `24 h exatas — ciente`; `contato gêmeo — ciente` |
| 9 | T9, T8, T5, T7, T10 | T9 elegíveis e interseção; T8 `ACKED`; T5 `OK e não entendi ao lembrete`; T7 `incerto que recebeu o lembrete sai de Sem entrega`; T5 `incerto sem recibo continua pendente`; T10 cenário |
| 10 | T9 | `4º lembrete — 409 reminder_limit`; `antes de 5 min — 409 reminder_too_soon`; `dois cliques — um lembrete`; `canal fechado — 409 e nada criado`; `autor que deixou de gerir o setor — 403` |
| 11 | T6, T13 | T6 marcar, desfazer, desfazer com OK, desfazer automática 422, corrida; trilha sem observação; T13 `Ciente (manual), autor e hora` |
| 12 | T2, T6, T7, T9, T11, T13 | T2 `prévia e criação 403 com o texto`; `com a chave ligada na matriz, SUPERVISOR cria`; T6/T9 `403 antes de 404`; T7 `painel sem a chave`; T11 `Urgência some sem a chave`; T13 `sem a chave, sem botões de lembrete e ciência` |
| 13 | T4, T11 | T4 `texto gravado termina com a linha`; `2000 aceito, 2001 → 400`; T11 `contador soma a linha; 2001 trava` |
| 14 | T5, T7, T12, T14 | T5 `reunião com OK — só Respondeu`; T7 `urgência antiga → 422 not_an_alert`; T12 `sem ackDeadlineMinutes, sem painel nem coluna Ciência`; T14 `urgência antiga e reunião — os três campos nulos na lista e no detalhe` |
| 15 | T5, T6, T9, T10 | trilhas e logs; T10 varredura |
| 16 | T7, T12, T10 | T7 `ack.late` quando `ackAt > ackDeadlineAt`; `lembrete não muda ackDeadlineAt`; T12 `Ciente (após o prazo) às HH:mm` |
| 17 | T5 | `falha ao gravar — pendente e mensagem no chat` |
| 18 | T11 | `release-notes.spec.ts` verde com a entrada no topo; `release-notes.alert.spec.ts` `aceite 18: entrada no topo cita a linha fixa e o aviso da chave` |
| 19 | T9, T6 | T9 `Repetir das falhas do alerta sem equipe.urgencia — funciona`; `só ids fora → 422 reminder_empty`; T6 `ciência manual em reunião → 422 not_an_alert` |
| 20 | T7, T14 | T7 `lembrete do ADMIN no alerta do SUPERVISOR aparece no painel do SUPERVISOR`; T14 `detalhe do lembrete do ADMIN — 404 para o SUPERVISOR` |
| 21 | — | Lote H (já entregue) |
| 22 | T5, T6, T10 | T5 ordem (b) → (c); T6 corridas e `desfazer com a Message do OK apagada — continua KEYWORD`; T10 `OK durante a manual e desfazer` |
| I1 | T2, T11 | aceite 12; specs que fixam as chaves (T2: `permissions.spec.ts`, `role-permissions-migration`, `permissions.repository`, `sector-people.repository`; T11: `permissions-matrix.spec.tsx`, `access.spec.ts`) verdes |
| I2 | T3, T4, T9, T11 | aceite 13; T9 `texto do lembrete = Lembrete: + texto do alerta` |
| I3 | T1, T4, T7, T12, T14 | aceites 6, 16; T14 prazo na lista e no detalhe |
| I4 | T3, T5 | aceites 7, 8, 17 |
| I5 | T6, T7, T13 | aceites 11, 22 |
| I6 | T3, T7, T12 | aceites 6, 9 |
| I7 | T3, T8, T9, T13, T14 | aceites 9, 10, 19, 20; T14 `reminderOf` na lista e no detalhe; T9 `telefone atual da pessoa` |
| I8 | T7, T12, T14 | aceite 14 |
| I9 | T11 | aceite 18 |
| DI1 (migração) | T1 | `linhas antigas com colunas nulas e reminderCount 0`; `nenhuma linha de RolePermission nova` |
| DI11 (ponto do pulo) | T8 | `depois do pacing e antes da porta ao vivo` |
| DI12 (histórico e detalhe) | T14, T12 | T14 integração de lista e detalhe; T12 `histórico: Lembrete do alerta de dd/mm HH:mm` |

## Mapa de arquivos

- Criar (back, `backend/src/modules/team-whatsapp/`): `team-alert.rules.ts`, `team-alert.errors.ts` (T3); `team-alert.policy.ts` (T2); `team-alert-create.ts` (T4); `tracking/team-alert-reply.ts` (T5); `team-alert.repository.ts`, `team-alert-access.ts`, `team-alert-panel.service.ts`, `team-alert.controller.ts` (T7); `team-alert-manual-ack.ts`, `team-alert-ack.service.ts`, `dto/manual-ack.dto.ts` (T6); `team-alert-send.ts` (T8); `team-dispatch-area.ts` (T14); `team-alert-reminder.repository.ts`, `team-alert-reminder.service.ts`, `dto/send-reminder.dto.ts` (T9); `team-whatsapp.t09.test-fixtures.ts` (T10). Specs novos listados em cada task. Migração `backend/prisma/migrations/20261120150000_team_alert_ack/migration.sql`.
- Modificar (back): `backend/prisma/schema.prisma` (T1); `schemas/contracts/team-whatsapp.schema.ts` (T1 só `teamSkipReasonSchema`; T7 painel; T14 lista e detalhe; T9 resposta do lembrete); `team-whatsapp.repository.ts` (T1 `NewTeamDispatch` e, só se o `...dispatch` de `createDispatch` ~L835 não repassar o campo, o mapeamento; T14 `dispatchListSelect`/`dispatchDetailSelect`); `dispatch-purpose-view.ts` (T14); `team-whatsapp.service.ts` (T2 uma chamada em `dispatch()`; T4 o `text:` de `sectorDraft`); `team-audience.service.ts` (T2 uma chamada em `preview`, ~L157); `dto/create-team-dispatch.dto.ts`, `team-whatsapp.sector-dispatch.ts` (T4); `tracking/team-recipient-tracking.service.ts`, `chat/chat-ingest.service.ts` (T5); `team-whatsapp-send.processor.ts`, `team-recipient-finish.ts` (T8); `team-whatsapp-retry.service.ts` (T14); `team-whatsapp.module.ts` (T7, T6, T9, em ondas diferentes); `shared/authz/permissions.ts` e os specs que fixam as chaves (T2, GI1).
- Modificar (front): `features/permissions/keys.ts` e specs (T11); `features/team-whatsapp/`: `components/purpose-fields.tsx`, `components/send-whatsapp-dialog.tsx`, `error-messages.ts`, `schemas.ts` (só o motivo de pulo, se for enum) (T11); `schemas.ts` (lista e detalhe), `components/dispatch-result.tsx`, `components/recipient-table.tsx`, `components/recent-dispatches.tsx` (T12); `components/alert-panel.tsx` (T12 cria, T13 acrescenta ações); criar `alert-text.ts`, `components/alert-confirm-line.tsx` (T11), `alert-schemas.ts`, `alert-labels.ts`, `alert-api.ts`, `components/alert-panel.tsx` (T12), `alert-actions-api.ts`, `components/reminder-dialog.tsx`, `components/manual-ack-dialog.tsx` (T13); `frontend/src/release-notes.ts` (T11).

## Ordem e paralelismo

```
Onda 1:  T1 (migração)   T2 (chave e portão, back)   T3 (regras puras e erros)   T11 (front: chave, finalidade, linha fixa, erros, Novidades)
Onda 2:  T4 (criação do alerta) <- T1,T2,T3   T5 (ciência automática) <- T1,T3   T7 (painel e controller) <- T1,T3   T12 (front: painel, coluna, histórico) <- T11
Onda 3:  T6 (ciência manual) <- T2,T5,T7   T8 (processor: já confirmou) <- T1   T14 (histórico/detalhe e área do Repetir) <- T1,T3   T13 (front: lembrete e ciência manual) <- T12
Onda 4:  T9 (lembrete) <- T3,T4,T7,T8,T14
Onda 5:  T10 (demonstração T09) <- todas as do back
```

- **Ownership disjunto por onda:** Onda 1 — T1: `schema.prisma`, pasta da migração, `teamSkipReasonSchema` no contrato, `NewTeamDispatch` (~L292-320) e, só se preciso, o mapeamento de `createDispatch` (~L835) em `team-whatsapp.repository.ts`, spec da migração; T2: `permissions.ts`, `team-alert.policy.ts`, uma linha em `team-whatsapp.service.ts` (`dispatch()`) e uma em `team-audience.service.ts` (`preview`, ~L157), os specs que fixam as chaves no back (GI1); T3: arquivos novos; T11: front base (inclui os specs que fixam as chaves no front). Onda 2 — T4: DTO, `sector-dispatch.ts`, o `text:` de `sectorDraft`, `team-alert-create.ts` e specs; T5: `tracking/`, `chat-ingest.service.ts`, specs; T7: `team-alert.repository.ts`, `team-alert-access.ts`, `team-alert-panel.service.ts`, `team-alert.controller.ts` (cria), `team-whatsapp.module.ts`, contrato (só o painel); T12: front painel. Onda 3 — T6: `team-alert-manual-ack.ts`, `team-alert-ack.service.ts`, DTO, rotas no controller, módulo; T8: processor (`recipientSelect`, `sendPaced`), `team-recipient-finish.ts` (tipo), `team-alert-send.ts`; T14: `dispatch-purpose-view.ts` (+ fábricas de lista/detalhe que quebrarem), selects de lista e detalhe em `team-whatsapp.repository.ts`, contrato (lista e detalhe), `team-dispatch-area.ts`, `team-whatsapp-retry.service.ts`; T13: front ações. Onda 4 — T9: arquivos do lembrete, rota no controller, módulo, resposta no contrato. Onda 5 — T10: suíte e fixture novos.
- **`team-whatsapp.repository.ts`** passa por T1 (onda 1) e T14 (onda 3); **`team-whatsapp.service.ts`** por T2 (onda 1) e T4 (onda 2); **controller novo e módulo** por T7, T6 e T9 em ondas 2, 3 e 4; **contrato** por T1, T7, T14 e T9 em ondas 1, 2, 3 e 4; **`team-whatsapp-retry.service.ts`** só pela T14. Nenhum arquivo é editado por duas tasks da mesma onda (se uma fábrica de lista/detalhe que a T14 ajusta morar num spec da T6 ou da T8, a T14 registra no report e a principal serializa).
- **T14 na Onda 3:** o contrato e o `team-whatsapp.repository.ts` já estão livres (T1 e T7 fecharam); a checagem de área sai extraída antes da T9, que só a chama.
- **T5 e T7 na Onda 2 sem dependência entre si:** o painel lê as colunas de ciência gravadas por SQL/prisma nas fixtures; a T5 grava pelo rastreio. A T10 junta os dois.
- **T6 na Onda 3:** prova as corridas contra o `recordAlertReply` real da T5 e acrescenta rotas ao controller da T7.
- **Front:** T11/T12/T13 espelham os contratos com campos tolerantes (GI8); não dependem do código do back.
- **Integração de testcontainers:** T1, T2, T4, T5, T7 (Ondas 1 e 2) e T6, T8, T14 (Onda 3) têm integração; a principal serializa (máximo dois ao mesmo tempo). A integração de uma task aplica todas as migrações: se a pasta da T1 estiver pela metade, a falha é de arquivo alheio (registrar e rodar de novo).
- **Gate conjunto:** com tasks paralelas, o `--changed` de uma mede o diff das outras; falha só de arquivo alheio vai para o report. A principal roda o `--changed` conjunto (back e front) e o `tsc` do back depois de cada onda.
- **Revisão** (SKILL.md do sdd, §Revisão por risco): `opus` em T2, T5, T6, T7, T9 (`Risco: crítico`, linha "Crítico"), T1, T4, T8, T14 (`Risco: alto` com linha `fronteira`) e T11, T12, T13 (`fronteira`); `sonnet` em T3 (regras puras, sem categoria crítica; o efeito é revisto em T5/T7/T9) e T10 (só teste). Total **14 tasks** em 5 ondas: 5 `Risco: crítico` (T2, T6, T7, T9 autorização; T5 entrada de rota pública), 6 altas (T1, T3, T4, T8, T10, T14) e 3 médias (T11–T13, `fronteira`).

---

## Task 1 — Migração: ciência, lembrete e motivo `ACKED` (back)

**Arquivos:** modificar `backend/prisma/schema.prisma` (`enum TeamWhatsappSkipReason` ~L1741, `model TeamWhatsappDispatch` ~L1779, `model TeamWhatsappRecipient` ~L1859, enum novo); criar `backend/prisma/migrations/20261120150000_team_alert_ack/migration.sql` e `backend/src/modules/team-whatsapp/team-alert.migration.integration.spec.ts`; em `backend/src/schemas/contracts/team-whatsapp.schema.ts` **só** `teamSkipReasonSchema` + `'ACKED'`; em `team-whatsapp.repository.ts` **só** `NewTeamDispatch` (~L292, campo opcional `ackDeadlineMinutes?: number | null`) e, **só se** o `...dispatch` de `createDispatch` (~L835) não repassar o campo novo, o mapeamento dele (`ackDeadlineMinutes: dispatch.ackDeadlineMinutes ?? null`); a ~L515 é `purposeColumns` e não muda.

**Interfaces:** produz CI1 e o client gerado.

**Contexto vinculado:**
- DI1 inteiro (colunas, enums, FKs `SET NULL`, índices, nenhuma linha muda, nenhuma `RolePermission`, `ALTER TYPE … ADD VALUE` em transação exige Postgres ≥ 12, bloqueio curto de escrita).
- Spec Restrições: "Migrações só aditivas, com o cabeçalho das anteriores (`SET LOCAL lock_timeout = '15s'`); nenhuma linha existente muda." I1: "o padrão é desligado e nenhuma linha é semeada."
- I3: "Coluna nova no envio: `ackDeadlineMinutes` (nulo = não é alerta: outras finalidades, urgência antiga e lembrete)." I4: "Colunas novas no destinatário: `ackAt`, `ackKind` (`KEYWORD` | `MANUAL`), `ackByUserId` (manual), `ackNote` (manual, até 200), `ackMessageId` (a primeira mensagem recebida com palavra de ciência) e `lastReplyMessageId` (a última resposta da pessoa ligada ao alerta). (…) o destinatário do lembrete guarda `parentRecipientId`". I7: "o alerta guarda `reminderCount` e `lastReminderAt`"; "`parentDispatchId` = alerta".
- GI11 (cabeçalho como `20261120140000_team_recipient_tracking/migration.sql`, DDL do `prisma migrate diff`). GI8: `ackDeadlineMinutes` opcional em `NewTeamDispatch` (nenhum chamador quebra).
- Se existir teste que compara `teamSkipReasonSchema` com o enum do Prisma, ele passa a exigir `ACKED` — é o motivo de o contrato entrar aqui.

**Passos:**
1. [ ] RED (`team-alert.migration.integration.spec.ts`, padrão de `team-recipient-tracking.migration.integration.spec.ts`): `it('envio e destinatário anteriores ficam com as colunas novas nulas e reminderCount 0')` (linhas semeadas antes da última migração); `it('ACKED e TeamAlertAckKind aceitos')`; `it('apagar o alerta deixa parentDispatchId e parentRecipientId nulos no lembrete')`; `it('índices de parentDispatchId e parentRecipientId existem')` (`pg_indexes`); `it('a migração não cria linha em RolePermission')`; `it('createDispatch grava ackDeadlineMinutes; sem o campo, null')`.
2. [ ] GREEN: schema, SQL, contrato, repositório.
3. [ ] `npx prisma generate`; `npx prisma validate`; integração; typecheck; `--changed`.

**Aceite:** base de 6–20. **Risco: alto** (migração não destrutiva).
**fronteira: migração — só aditiva (colunas nulas, default constante, enum com valor novo, FKs `SET NULL` e índices); nenhuma linha muda; os índices e as FKs bloqueiam escrita em `TeamWhatsappDispatch`/`TeamWhatsappRecipient` por instantes. Revisão `opus`.**

## Task 2 — Chave `equipe.urgencia` e portão por finalidade (back)

**Arquivos:** modificar `backend/src/shared/authz/permissions.ts` (`PERMISSION_KEYS` ~L10-21, `PERMISSION_DENIED_TEXT` ~L98-115); criar `backend/src/modules/team-whatsapp/team-alert.policy.ts`, `team-alert.policy.spec.ts`, `team-whatsapp.urgency-permission.integration.spec.ts`; em `team-whatsapp.service.ts` **só** uma chamada em `dispatch()` (~L221, depois de `requireSender`); em `team-audience.service.ts` **só** uma chamada em `preview` (~L157, depois de `requireSender`; a ~L231 é o corpo de `requireSender`). Specs que fixam as chaves (só o necessário; todos no GI1): `backend/src/shared/authz/permissions.spec.ts` (~L42 `.at(-1)` → `equipe.urgencia`; título ~L137 "11 chaves"; ~L97-104 o esperado do SUPERVISOR, `PERMISSION_KEYS.filter(...)`, passa a excluir também `equipe.urgencia`, que não está no padrão); `backend/src/modules/permissions/permissions.repository.integration.spec.ts` (~L62-71: o `beforeEach` faz `rolePermission.update` em cada chave e `equipe.urgencia` não é semeada → P2025 derruba a suíte; trocar o `update` por `upsert` ou pular a chave não semeada); `backend/src/modules/permissions/role-permissions-migration.integration.spec.ts` (`EXPECTED_ROWS` ~L24 passa a excluir `equipe.urgencia` — ela não é semeada —, `toHaveLength(20)` ~L72/~L100 continua 20, mais uma asserção "nenhuma linha de equipe.urgencia"); `backend/src/modules/sector-people/sector-people.repository.integration.spec.ts` (~L411 `toHaveLength(10)` → 11).

**Interfaces:** consome `TeamActor.permissions` (`team-whatsapp.policy.ts:25-33`), `hasPermission`/`permissionDenied` (`permissions.ts:117-123`), o tipo da finalidade da API (`teamPurposeSchema`). Produz CI3.

**Contexto vinculado:**
- I1 (conselho U): "Chave nova `equipe.urgencia` ('Criar alerta urgente'), exigida junto com `equipe.enviar`. ADMIN tem sempre. SUPERVISOR e OPERATOR só têm quando o ADMIN ligar na matriz de permissões; o padrão é desligado e nenhuma linha é semeada. Sem a chave, a finalidade Urgência não aparece na tela e o servidor recusa com 403 a prévia, a criação, o lembrete e a ciência manual, com o texto 'Você não tem permissão para criar alerta urgente.'. Ver o painel de pendências não exige a chave." "A checagem é por finalidade dentro do servidor (a rota é a mesma das outras finalidades) e vem antes de qualquer leitura de pessoas, junto das outras recusas 403 do envio."
- DI2 inteiro (texto exato; `DEFAULT_MATRIX` não muda; ordem guard → `requireSender` → `requireUrgencyFor` → leituras). GI4 (403 antes de qualquer leitura e antes do 404).
- Ordem de hoje na criação (mapa-i-permissoes §3): `requireSender` (403 `team_whatsapp.forbidden`) → `audience.resolve` (403 por setor) → `requireBroadSendAllowed` → 409/422. A chave entra entre o primeiro e o segundo. Alvo pessoa não tem finalidade: `requireUrgencyFor(actor, input.purpose)` com `undefined` não recusa.
- O "Repetir" (`team-whatsapp-retry.service.ts`) não muda (I1: "segue a regra de hoje (`equipe.enviar` e a área), sem a chave nova").
- GI10: `team-whatsapp.service.ts` e `team-audience.service.ts` são legados: uma linha de chamada em cada; a regra mora em `team-alert.policy.ts`.

**Passos:**
1. [ ] RED unidade (`team-alert.policy.spec.ts`): `it('Urgência sem a chave — 403 auth.permission_denied com o texto da chave')`; `it('Urgência com a chave, e outras finalidades sem ela — passa')`; `it('requireUrgencyKey sem a chave — 403')`; `it('ADMIN tem a chave pelo catálogo (defaultPermissionsFor)')`; `it('SUPERVISOR e OPERATOR não têm a chave no padrão')`.
2. [ ] RED integração (`team-whatsapp.urgency-permission.integration.spec.ts`, banco real, fixtures de serviço de hoje): `it('aceite 12: SUPERVISOR sem a chave — prévia e criação de Urgência 403 com o texto, sem ler setores nem pessoas')` (espiar `audience.resolve`/repositório de setores: zero chamadas); `it('reunião sem a chave — segue')`; `it('aceite 12: com linha RolePermission (SUPERVISOR, equipe.urgencia, granted) — a prévia de Urgência passa do portão')`; `it('aceite 12: com linha RolePermission (SUPERVISOR, equipe.urgencia, granted) — SUPERVISOR cria a Urgência (envio gravado com purpose URGENCY)')` (porta ao vivo `open`, fixtures de serviço de hoje); `it('matriz aceita gravar equipe.urgencia para SUPERVISOR')` (pelo serviço de permissões, se o teste vizinho já o monta; senão, registrar).
3. [ ] GREEN; ajustar os quatro specs que fixam as chaves (rodar `permissions.repository.integration.spec.ts` com `TESTCONTAINERS_ENABLED=1`); typecheck; eslint (GI10); validação; `--changed`.

**Aceite:** 12 (back: prévia e criação). **Risco: crítico (autorização).**
**Crítico: autorização — cria a chave e o portão que decide quem pode criar alerta urgente; um portão no lugar errado deixaria SUPERVISOR/OPERATOR criar alerta ou vazaria leitura de pessoas antes do 403.**

## Task 3 — Regras puras do alerta e erros (back)

**Arquivos:** criar `backend/src/modules/team-whatsapp/team-alert.rules.ts`, `team-alert.rules.spec.ts`, `team-alert.errors.ts`, `team-alert.errors.spec.ts`. Nenhum arquivo existente.

**Interfaces:** consome `MessageKind` e `TeamWhatsappRecipientStatus` do client (já existem), o padrão de `DomainError` de `team-whatsapp.errors.ts`. Produz CI2.

**Contexto vinculado:**
- DI3 (linha, sufixo de 41, prefixo), DI4 (15 min, `ackDeadlineAt`), DI5 inteiro (normalização e casos), DI8 inteiro (grupo, melhor estado, elegíveis), DI14 (códigos e status HTTP).
- I4: "Ciência automática: mensagem de texto da pessoa cujo conteúdo inteiro, sem diferença de maiúsculas e acentos e sem espaços ou pontuação nas pontas, seja 'ok', 'ciente', 'confirmo', 'recebido' ou o emoji de joinha." "O 'joinha' aceito é o texto 👍, com ou sem modificador de tom de pele." "Imagem ou vídeo com legenda 'ok', áudio, figurinha e reação (…) contam como resposta, nunca como ciência."
- I6 (grupo): "com `ackAt` → 'Ciente'; sem ciência, com `lastReplyMessageId` ou com 'Respondeu' no original ou num lembrete → 'Respondeu, sem ciência'; sem ciência e sem resposta, com o melhor estado de entrega entre o original e os lembretes em Aceito, Entregue ou Lido → 'Sem resposta'; o resto (Na fila, Falhou, Situação incerta, Pulado em todos) → 'Sem entrega'." "O lembrete e a ciência manual usam a mesma função de grupo."
- I7 (elegíveis): "pessoa do alerta sem ciência cujo grupo (…) é 'Sem resposta' ou 'Respondeu, sem ciência', ou cujo grupo é 'Sem entrega' com 'Situação incerta' no original ou em algum lembrete (marcada 'pode já ter recebido'). Quem está em 'Sem entrega' só com Falhou, Pulado ou Na fila não entra." Limites: "no máximo 3 lembretes por alerta, com 5 minutos de intervalo desde o alerta ou o lembrete anterior".
- I4: "a resposta chegar em até 24 horas do aceite" (`withinReplyWindow`, inclusive).

**Passos:**
1. [ ] RED (`team-alert.rules.spec.ts`): `it('alertText acrescenta linha em branco e a linha fixa; 41 caracteres')`; `it('reminderText prefixa Lembrete:')`; `it('aceite 7: Ok!, OK, Ciente., confirmo, Recebido, 👍, 👍🏽 e 👍 com FE0F — ciência')`; `it('aceite 7: ok, mas não vou; não entendi; okay; texto vazio — não')`; `it('IMAGE e VIDEO com legenda ok, AUDIO, STICKER e UNSUPPORTED — não')`; `it('janela: 24 h exatas vale, 24 h e 1 ms não')`; `it('grupo de cada caso de I6, inclusive incerto que recebeu lembrete → no_reply')`; `it('bestStatusOf segue a ordem de DI8')`; `it('elegíveis: no_reply, replied e incerto (mayHaveReceived); falhou, pulado, na fila e ciente não')`; `it('reminderBlock: limite antes do intervalo; 5 min contam do alerta e depois do último lembrete')`; `it('alertDeadlineAt = createdAt + 15 min')`.
2. [ ] RED (`team-alert.errors.spec.ts`): `it('cada erro tem o código team_whatsapp.<x> e o status de DI14')`.
3. [ ] GREEN; eslint (GI10); validação; `--changed`.

**Aceite:** 7 (regra), base de 9, 10, 16. **Risco: alto** (decide quem fica "Ciente" e quem entra no lembrete). Revisão `sonnet` (sem categoria crítica no delta: funções puras; as gravações e recusas são revistas em T5, T6, T7 e T9).

## Task 4 — Criação do alerta: linha fixa, limite de 2000 e prazo (back)

**Arquivos:** modificar `backend/src/modules/team-whatsapp/dto/create-team-dispatch.dto.ts` (regra nova encadeada em `createTeamDispatchSchema` ~L186-189); `team-whatsapp.sector-dispatch.ts` (`sectorDispatchFields` ~L211-233: `ackDeadlineMinutes`); em `team-whatsapp.service.ts` **só** o `text: input.text` de `sectorDraft` (~L313) → `text: dispatchTextOf(input)`; criar `team-alert-create.ts` (`dispatchTextOf(input)` = `alertText(input.text)` na Urgência, senão `input.text`; `alertFieldsOf(purpose)` = `{ ackDeadlineMinutes: 15 | null }`; a T3 fica fechada), `dto/create-team-dispatch.dto.alert.spec.ts`, `team-whatsapp.alert-create.integration.spec.ts`.

**Interfaces:** consome CI1 (T1: `NewTeamDispatch.ackDeadlineMinutes`), CI2 (T3), CI3 (T2, já na criação). Produz o alerta gravado (texto com a linha, `ackDeadlineMinutes = 15`).

**Contexto vinculado:**
- I2 (conselho U): "Todo alerta urgente termina com a linha fixa 'Responda OK para confirmar que recebeu.', acrescentada pelo servidor, visível na prévia e contada no limite do texto." "O servidor acrescenta a linha depois de uma linha em branco, na criação; o texto gravado no envio já a inclui. O limite de 2000 caracteres vale para o texto final: na Urgência, o DTO recusa (400) texto que, somado à linha em branco e à linha fixa, passe de 2000". "A impressão do público (prévia × confirmação) não muda: ela não cobre o texto."
- DI3 inteiro (sufixo exato, sem aparar; mensagem do issue). DI4: `ackDeadlineMinutes = ALERT_ACK_DEADLINE_MINUTES` só com `purpose === 'urgency'`; demais finalidades e alvo pessoa → `null`.
- A linha entra **depois** das travas que leem `request.text` (`blocksFor`, `empty_text` com `trim`): o texto vazio continua recusado como hoje.
- Envio a pessoa não tem finalidade (mapa-i-urgencia-back §2): `userDraft` não muda.
- GI10: `team-whatsapp.service.ts` só a troca do `text:`; `sector-dispatch.ts` ganha um spread (`...alertFieldsOf(input.purpose)`), lógica em `team-alert-create.ts`.

**Passos:**
1. [ ] RED DTO (`create-team-dispatch.dto.alert.spec.ts`): `it('aceite 13: Urgência com 1959 caracteres — aceito (2000 com a linha)')`; `it('aceite 13: Urgência com 1960 — 400 no caminho text')`; `it('reunião com 2000 — aceito, como hoje')`.
2. [ ] RED integração (`team-whatsapp.alert-create.integration.spec.ts`, banco real, fixtures de serviço de hoje, ator ADMIN, porta ao vivo `open`): `it('aceite 13: texto gravado do alerta termina com linha em branco e a linha fixa')`; `it('alerta grava ackDeadlineMinutes 15; reunião grava null')`; `it('texto vazio na Urgência continua 422 empty_text')`; `it('prévia da Urgência não muda (mesma impressão)')`.
3. [ ] GREEN; typecheck; eslint (GI10); validação; `--changed`.

**Aceite:** 13 (back), base de 6 e 16. **Risco: alto.**
**fronteira: contrato público — a criação passa a recusar (400) texto de Urgência acima de 1959 caracteres e grava um texto diferente do enviado pela tela. Revisão `opus`.**

## Task 5 — Ciência automática pela resposta (back)

**Arquivos:** modificar `backend/src/modules/team-whatsapp/tracking/team-recipient-tracking.service.ts` (`applyReply` ~L68-91); criar `tracking/team-alert-reply.ts`, `tracking/team-alert-reply.spec.ts`, `tracking/team-recipient-tracking.alert.integration.spec.ts`; em `backend/src/modules/chat/chat-ingest.service.ts` **só** a assinatura de `trackTeamReply` (~L837-857) e a chamada (~L798) — CI4; criar `backend/src/modules/chat/chat-ingest.service.alert.spec.ts`; no `chat-ingest.service.spec.ts` existente, **só** as asserções dos argumentos de `applyReply` (~L69-88) que passam a incluir `message` (listar no report); criar, se o parse for alcançável sem rede, `backend/src/modules/whatsapp-providers/adapters/evolution-api.adapter.reaction.spec.ts` (só teste; o adaptador não muda).

**Interfaces:** consome CI1, CI2 (`isAckWord`, `withinReplyWindow`), `InboundChatMessage` (`kind`, `text`, `receivedAt`). Produz CI4.

**Contexto vinculado:**
- I4 (conselho U): "Ciência é um fato separado de 'Respondeu': fica gravada com hora, forma (automática ou manual) e autor, e não muda o estado de entrega." "Enquanto não houver ciência, toda mensagem seguinte da pessoa é avaliada: um 'OK' depois de um 'não entendi' vale. A ciência automática só vale se o alerta, ou um lembrete dele, for o último envio da equipe aceito para aquela pessoa naquele número e a resposta chegar em até 24 horas do aceite; fora disso a resposta só marca 'Respondeu'. Resposta a um lembrete conta para o alerta original."
- I4 (ligação): "a ingestão do chat passa ao rastreio a mensagem recebida (id, tipo, texto) além de canal, contatos e hora. O rastreio acha o destinatário mais recente aceito para aquele número e contatos (regra de hoje). Se ele é de um alerta (ou de um lembrete, e então vale o destinatário original) e a resposta chegou até 24 h depois do aceite desse destinatário mais recente: grava `lastReplyMessageId` no original, com ou sem ciência já registrada; se o texto é palavra de ciência e o original ainda não tem `ackMessageId`, grava `ackMessageId`; se o original está sem ciência, grava também `ackAt` (hora do recebimento) e `ackKind = KEYWORD`." "O retorno antecipado do `applyReply` quando o destinatário já está 'Respondeu' deixa de impedir a avaliação de ciência: ele continua valendo só para o estado de entrega." "Toda gravação de ciência é condicional a `ackAt` nulo (…). A gravação de `ackMessageId` é separada e condicional a `ackMessageId` nulo". "Quem está em 'Situação incerta' sem recibo não tem `acceptedAt` e não é candidato a resposta (regra de hoje)". "O rastreio continua best-effort: uma falha nele deixa a pessoa pendente, nunca ciente, e não perde a mensagem recebida."
- DI5, DI6 inteiros (ordem (a) `lastReplyMessageId` → (b) `ackMessageId` → (c) `ackAt`; (b) antes de (c) obrigatório; original por `parentDispatchId`/`ackDeadlineMinutes`; janela sobre o `acceptedAt` do mais recente).
- Estado de hoje (mapa-i-resposta-rastreio §1–2): `trackTeamReply` retorna cedo sem `INBOUND`, com `backfill` ou sem `twinIds`; `try/catch` com `logger.warn({ err, instanceId }, …)`; `applyReply` sem `try/catch`. A reação chega como `UNSUPPORTED` com `content = null` (sem extrator para `reactionMessage`).
- GI3: nenhum log novo; o `warn` existente segue só com `err` e `instanceId` (conferir que nenhum erro lançado nas gravações novas carrega o texto). GI10: `chat-ingest.service.ts` só a assinatura (3 parâmetros, CI4) e a chamada (`messageId: message.id`, `text: m.text ?? null`, `kind: m.kind`).

**Passos:**
1. [ ] RED unidade (`team-alert-reply.spec.ts`): `it('alertOriginalOf: destinatário do alerta → ele; do lembrete → parentRecipientId; de outro envio → null')`; `it('fora de 24 h do aceite do mais recente → null')`; `it('recordAlertReply grava lastReplyMessageId, depois ackMessageId, depois ackAt (ordem)')` (db falso que registra a ordem); `it('sem palavra de ciência — só lastReplyMessageId')`.
2. [ ] RED integração (`team-recipient-tracking.alert.integration.spec.ts`, banco real; alerta semeado com `ackDeadlineMinutes 15`, destinatários `SENT` com `acceptedAt` explícito, `Message` `INBOUND` gravada antes de cada `applyReply`): `it('aceite 6: OK — ciência KEYWORD com ackAt = receivedAt, ackMessageId, ackMessageAt = receivedAt e lastReplyMessageId; estado REPLIED')`; `it('aceite 7: não entendi seguido de Ok! — depois do 1º, Respondeu sem ciência com lastReply = não entendi; depois do 2º, ciente')`; `it('aceite 7: ok, mas não vou — sem ciência')`; `it('aceite 7: áudio, imagem com legenda ok, figurinha e reação (UNSUPPORTED) — Respondeu, sem ciência')`; `it('aceite 8: OK depois de um envio de rotina mais novo — rotina REPLIED, alerta sem mudança')`; `it('aceite 8: OK 25 h depois — só REPLIED, sem lastReplyMessageId')`; `it('24 h exatas — ciente')`; `it('aceite 8: OK de contato gêmeo (9º dígito) — ciente')`; `it('aceite 9: OK ao lembrete — ciência no original; lembrete REPLIED')`; `it('aceite 9: não entendi ao lembrete — lastReplyMessageId no original')`; `it('aceite 9: OK de quem está UNCERTAIN sem recibo — alerta sem mudança')`; `it('aceite 14: reunião com OK — só REPLIED')`; `it('já REPLIED: um OK seguinte ainda dá ciência')`; `it('segundo OK depois da ciência — ackAt e ackMessageId não mudam; lastReplyMessageId muda')`; `it('ciência manual já gravada: OK guarda ackMessageId e não mexe na ciência')`.
3. [ ] RED chat (`chat-ingest.service.alert.spec.ts`, padrão de `chat-ingest.service.spec.ts:66-106`): `it('passa ao rastreio a mensagem gravada: id, kind e texto')`; `it('aceite 17: rastreio lança — mensagem gravada e publicada; log sem o texto')`; e o caso integrado de falha: em `team-recipient-tracking.alert.integration.spec.ts`, `it('aceite 17: falha ao gravar lastReplyMessageId — nenhuma ciência gravada')` (db que lança na 1ª gravação).
4. [ ] RED adaptador (se alcançável): `it('reação da Evolution vira UNSUPPORTED sem texto e isAckWord falso')`; senão, registrar no report e a T10 cobre pela ingestão.
5. [ ] GREEN; ajustar as asserções de `applyReply` no spec existente; typecheck; eslint (GI10); validação; `--changed`.

**Aceite:** 7, 8, 14 (back), 17, 22 (ordem), base de 6 e 9. **Risco: crítico (entrada de rota pública)** — o delta muda o que uma mensagem recebida pelo webhook público grava.
**Crítico: rota pública e concorrência — a mensagem que chega pelo webhook passa a decidir "Ciente"; ordem e condição das gravações decidem a corrida com a ciência manual; texto da resposta não pode ir a log.**

## Task 6 — Ciência manual e desfazer (back)

**Arquivos:** criar `backend/src/modules/team-whatsapp/team-alert-manual-ack.ts`, `team-alert-ack.service.ts`, `dto/manual-ack.dto.ts`, `team-alert-ack.service.spec.ts`, `team-alert-manual-ack.integration.spec.ts`; modificar `team-alert.controller.ts` (rotas `POST`/`DELETE …/ack`, criado pela T7) e `team-whatsapp.module.ts` (provider `TeamAlertAckService`); `route-parity.spec.ts` só `NEW_ROUTES`, se preciso (DI13).

**Interfaces:** consome CI1, CI2 (`notAnAlert`, `ackExists`, `ackNotManual`), CI3 (`requireUrgencyKey`), CI5 (`requireViewable`, `loadAlertHeader` para o 422 `not_an_alert` — sem releitura própria do cabeçalho —, controller), CI4 (`recordAlertReply`, só nos testes de corrida), `AuditService`, `TeamWhatsappRepository.findActor`. Produz CI6.

**Contexto vinculado:**
- I5 (conselho U): "Quem tem a permissão de alerta urgente e vê o envio no histórico pode marcar qualquer pessoa do alerta como ciente, com observação obrigatória de até 200 caracteres (ex.: 'confirmou por ligação'); ficam gravados autor e hora, e a ação vai para a trilha. A ciência manual pode ser desfeita por quem pode registrá-la, com registro na trilha; a automática não."
- I5 (rotas e recusas): "`POST /internal/team-whatsapp/dispatches/:id/recipients/:recipientId/ack` (`{ note }`) e `DELETE` na mesma rota. Ordem das recusas: 403 (sem `equipe.enviar` ou `equipe.urgencia`) → 404 (envio invisível ao ator ou destinatário de outro envio) → 422 (`team_whatsapp.not_an_alert` (…); `team_whatsapp.ack_exists` (…); `team_whatsapp.ack_not_manual`: desfazer automática ou inexistente)."
- I5 (desfazer): "se o original já tem `ackMessageId` (um 'OK' chegou enquanto a ciência manual valia), a ciência passa a automática com essa mensagem (`ackKind = KEYWORD`, `ackAt` = hora dela) e autor e observação são apagados; senão, a ciência inteira é apagada e a pessoa volta à pendência. O desfazer é uma única gravação condicional a `ackKind = MANUAL`, que decide na própria gravação (…) conforme o `ackMessageId` daquele instante".
- I4: "Toda gravação de ciência é condicional a `ackAt` nulo: (…) a manual não sobrescreve a automática e vice-versa (a segunda recebe `ack_exists`)."
- I5 (trilhas): "`team_whatsapp.ack_manual` e `team_whatsapp.ack_manual_undo` com os ids do envio e do destinatário; sem observação, nome ou telefone."
- DI7 inteiro (SQL único do desfazer; `ackMessageId`/`lastReplyMessageId` nunca apagados; 204). DI13 (controller, só `@RequirePermission('equipe.enviar')`). GI4, GI3.
- Lembrete não é alerta (`ackDeadlineMinutes null`): ciência manual num envio de lembrete → 422 `not_an_alert`; destinatário de lembrete na rota do alerta → 404 (outro envio).

**Passos:**
1. [ ] RED unidade (`team-alert-ack.service.spec.ts`, repositório e db falsos): `it('aceite 12: sem a chave — 403 antes de buscar o envio')`; `it('sem a chave num alerta invisível — 403, não 404')`; `it('invisível — 404; destinatário de outro envio — 404')`; `it('aceite 19: reunião ou lembrete — 422 not_an_alert')`; `it('trilha ack_manual só com actorId, dispatchId e recipientId (sem observação)')`; `it('trilha ack_manual_undo com result pending ou keyword')`.
2. [ ] RED integração (`team-alert-manual-ack.integration.spec.ts`, banco real): `it('aceite 11: marcar — MANUAL com autor, hora e observação')`; `it('aceite 11: marcar de novo ou sobre automática — 422 ack_exists')`; `it('aceite 11: desfazer sem ackMessageId — volta à pendência')`; `it('aceite 11/22: desfazer com ackMessageId — KEYWORD com ackAt = ackMessageAt (hora do OK); autor e observação apagados')`; `it('desfazer com a Message do OK apagada — continua KEYWORD com a hora do OK (não lê a Message)')`; `it('aceite 11: desfazer automática ou inexistente — 422 ack_not_manual')`; `it('aceite 11/22: manual e recordAlertReply(OK) ao mesmo tempo — uma ciência; a perdedora não grava; ackMessageId guardado')` (`Promise.all`, repetir algumas vezes); `it('aceite 22: desfazer e recordAlertReply(OK) ao mesmo tempo — sempre termina KEYWORD')`; `it('observação com 201 caracteres — 400; só espaços — 400')` (DTO).
3. [ ] GREEN; rotas; módulo; typecheck; eslint; `route-parity.spec.ts` verde; validação; `--changed`.

**Aceite:** 11, 22, 12 (ciência manual), 19 (`not_an_alert`). **Risco: crítico (autorização).**
**Crítico: autorização e concorrência — portão da chave antes da visibilidade, e a gravação condicional/SQL único do desfazer contra a ciência automática; um erro dá ciência a quem não confirmou ou apaga um "OK".**

## Task 7 — Painel de pendências (back)

**Arquivos:** criar `backend/src/modules/team-whatsapp/team-alert.repository.ts`, `team-alert-access.ts`, `team-alert-panel.service.ts`, `team-alert.controller.ts` (rota `GET dispatches/:id/alert`), `team-alert-panel.integration.spec.ts`, `team-alert-panel.service.spec.ts`, `team-whatsapp.schema.alert.spec.ts` (em `backend/src/schemas/contracts/`); modificar `team-whatsapp.module.ts` (controller, serviço) e `backend/src/schemas/contracts/team-whatsapp.schema.ts` (**só** `teamAlertPanelSchema` e o tipo). Lista, detalhe, `dispatch-purpose-view.ts` e os selects de `team-whatsapp.repository.ts` (DI12) são da T14, na Onda 3.

**Interfaces:** consome CI1, CI2 (`alertGroupOf`, `bestStatusOf`, `reminderEligibility`, `alertDeadlineAt`, `notAnAlert`), `isTeamSender`/`canViewDispatch` (`team-whatsapp.policy.ts`), `TeamWhatsappRepository.findActor`/`findDispatchForActor`, o 404 de `requireVisible` (`team-whatsapp-results.service.ts:301-313`). Produz CI5 (`loadAlertHeader`, `loadAlertPeople`, `factsOf`, `requireViewable`, `TeamAlertPanelService.getPanel`) e o controller que T6 e T9 estendem.

**Contexto vinculado:**
- I6 (conselho U): "O resultado do alerta urgente tem um painel nominal, visível a quem já vê o envio no histórico, em quatro grupos: 'Sem entrega' (na fila, falhou, situação incerta, pulado), 'Sem resposta' (aceito, entregue ou lido), 'Respondeu, sem ciência' e 'Ciente'. Os três primeiros são pendências." "Grupo de cada pessoa (…) calculado no servidor, na leitura, sobre o destinatário original e os destinatários dos lembretes dele". "O painel fica acima da tabela de destinatários, com o prazo (…), a contagem de cada grupo, o texto da resposta que deu a ciência (ou da última resposta) e a lista dos lembretes do alerta (hora, autor, quantas pessoas). A ordem dos grupos é a da frase; dentro do grupo, por nome."
- I3: "Ciência dada depois do prazo aparece como 'Ciente (após o prazo)', com a hora. Lembrete não reinicia o prazo. Alertas anteriores a esta versão aparecem sem prazo." I5: "A tela mostra o texto da resposta que deu a ciência e, sem ciência, o da última resposta." "O texto das respostas vem da mensagem gravada no chat; quem vê o envio vê esse texto".
- I7: "O painel do alerta mostra os lembretes a quem vê o alerta, mesmo quando outro os mandou".
- I1: "Ver o painel de pendências não exige a chave." Aceite 12: "se o ADMIN desligar a chave depois, ele continua vendo o painel do próprio alerta".
- DI8, DI9, DI13 inteiros. GI5 (C2), GI6 (I8), GI3 (sem telefone no painel; nenhum log com texto).
- `loadAlertPeople(db, alertId)` recebe o client ou a transação (a T9 a chama dentro da transação do lembrete); seleciona os destinatários do alerta com `reminderRecipients: { select: { status: true } }`.
- `loadAlertHeader(db, dispatchId)` (CI5) é a **única** leitura do cabeçalho do alerta (`createdAt`, `ackDeadlineMinutes`, `reminderCount`, `lastReminderAt`): o painel, a ciência manual (T6) e o lembrete (T9, também com o `tx`) a usam e não releem por conta própria; `DispatchForActor` (`team-whatsapp.repository.ts:196-203`) não traz esses campos. `ackDeadlineMinutes` nulo → `notAnAlert()`.

**Passos:**
1. [ ] RED contrato (`team-whatsapp.schema.alert.spec.ts`): `it('painel exige os campos de CI5')`.
2. [ ] RED unidade (`team-alert-panel.service.spec.ts`, repositório falso): `it('getPanel: ator e visibilidade na ordem de requireVisible (403/404) antes de loadAlertHeader; nenhuma leitura de pessoas antes')`; `it('getPanel monta counts, reminders.count/max/nextAllowedAt a partir do cabeçalho e das pessoas')`.
3. [ ] RED integração (`team-alert-panel.integration.spec.ts`, banco real, colunas de ciência semeadas): `it('aceite 6: quatro grupos na ordem e por nome; contagens')`; `it('aceite 6: ciência KEYWORD traz ackReply com o texto e a hora')`; `it('manual traz byName, note e a última resposta')`; `it('aceite 16: ciência depois do prazo — late true; lembrete criado aos 10 min não muda ackDeadlineAt')`; `it('aceite 9: incerto que recebeu lembrete aceito — no_reply, eligible; falhou e pulado — no_delivery, não elegíveis; incerto — mayHaveReceived')`; `it('aceite 20: lembrete do ADMIN aparece no painel do SUPERVISOR com o nome do autor e quantas pessoas')`; `it('nextAllowedAt = último lembrete + 5 min; null com 3 lembretes')`; `it('Message apagada — ackReply null')`; `it('aceite 12: SUPERVISOR autor sem a chave — 200')`; `it('outro SUPERVISOR — 404; VIEWER/sem remetente — 403')`; `it('aceite 14: urgência antiga, reunião e lembrete — 422 not_an_alert')`; `it('loadAlertHeader devolve createdAt, ackDeadlineMinutes, reminderCount e lastReminderAt; com o client e dentro de uma transação')`.
4. [ ] GREEN; módulo; typecheck; eslint (GI10); `route-parity.spec.ts` verde; validação; `--changed`.

**Aceite:** 6, 9, 16, 20 (back), 12 (painel sem a chave), 14 (sem painel). **Risco: crítico (autorização).**
**Crítico: autorização (visibilidade) e contrato público — rota nova que mostra nomes e textos de resposta a quem vê o envio; a regra de visibilidade decide quem lê esse dado pessoal.**

## Task 8 — Processor: "Pulado: já confirmou" no lembrete (back)

**Arquivos:** modificar `backend/src/modules/team-whatsapp/team-whatsapp-send.processor.ts` (**só** `recipientSelect` + `parentRecipientId` e, em `sendPaced` ~L217-244, a chamada nova depois de `waitPacing` e antes de `liveBlock`); `team-recipient-finish.ts` (**só** `SkipReasonOf` + `'ACKED'` e o comentário); criar `team-alert-send.ts`, `team-whatsapp-send.processor.ack.spec.ts`, `team-whatsapp.reminder-acked.integration.spec.ts`.

**Interfaces:** consome CI1 (`parentRecipientId`, `ACKED`), `finishSkipped` (CH3 do Lote H). Produz CI8.

**Contexto vinculado:**
- I7: "Quem confirma depois da lista não recebe: ao mandar cada mensagem de lembrete, o processor confere o destinatário original; se ele já tem ciência, o destinatário do lembrete fica 'Pulado: já confirmou' (motivo novo `ACKED`), sem chamada ao provedor, e a `Message` preparada, se houver, vira `CANCELLED` (como no H3). Vale também para o 'Repetir' de um lembrete."
- DI11 inteiro (leitura nova do `ackAt` do original depois do pacing; dentro do `try` para o `finally` soltar o pacing; sem porta ao vivo nem provedor; `priorOutcome` antes de tudo).
- DH3 do Lote H (`finishSkipped`): transação interativa — "primeiro a `Message`" `QUEUED → CANCELLED` (só se há `messageId`), "depois o destinatário" condicional a `QUEUED` → `SKIPPED` + `skipReason` + `channelCheckedAt: null`; destinatário `count 0` desfaz tudo; `Message` `FAILED`/`SENDING` não muda.
- GI10: o processor só recebe o campo no select e uma chamada; a leitura mora em `team-alert-send.ts`. GI3: nenhum log novo com telefone.

**Passos:**
1. [ ] RED unidade (`team-whatsapp-send.processor.ack.spec.ts`): `it('lembrete com original ciente — finishSkipped ACKED, sem liveState.check nem sendTeamMessage')`; `it('lembrete com original pendente — segue o envio')`; `it('destinatário sem parentRecipientId — nenhuma leitura extra')`; `it('a leitura acontece depois do pacing e o pacing é solto')`; `it('priorOutcome SENT vem antes: lembrete que já saiu continua SENT')`.
2. [ ] RED integração (`team-whatsapp.reminder-acked.integration.spec.ts`, banco real, porta ao vivo e chat falsos como no H): `it('aceite 9: original ciente com o lembrete na fila — Pulado: já confirmou, sem chamada ao provedor')`; `it('Message do lembrete preparada por tentativa anterior — CANCELLED')`; `it('Repetir do lembrete com o original ciente — pula também')`.
3. [ ] GREEN; typecheck; eslint (GI10); validação; `--changed`.

**Aceite:** 9 (parte "ainda na fila"). **Risco: alto.**
**fronteira: concorrência/transação — o pulo `ACKED` cancela a `Message` preparada na transação do H; condição errada mandaria lembrete a quem confirmou ou cancelaria mensagem que está saindo. Revisão `opus`.**

## Task 9 — Lembrete aos pendentes (back)

**Arquivos:** criar `backend/src/modules/team-whatsapp/team-alert-reminder.repository.ts`, `team-alert-reminder.service.ts`, `dto/send-reminder.dto.ts`, `team-alert-reminder.service.spec.ts`, `team-alert-reminder.integration.spec.ts`; modificar `team-alert.controller.ts` (rota `POST dispatches/:id/reminders`), `team-whatsapp.module.ts` (provider), `backend/src/schemas/contracts/team-whatsapp.schema.ts` (**só** `teamReminderResponseSchema`); `route-parity.spec.ts` só `NEW_ROUTES`, se preciso. A checagem de área já chega extraída pela T14 (`team-dispatch-area.ts`); `team-whatsapp-retry.service.ts` não muda aqui.

**Interfaces:** consome CI2 (`reminderEligibility`, `reminderBlock`, `reminderText`, erros), CI3 (`requireUrgencyKey`), CI5 (`loadAlertHeader` fora e dentro da transação, `loadAlertPeople`, `factsOf`, `requireViewable`, controller), CI8 (o processor pula `ACKED`), CI10 (checagem de área, T14), a leitura do telefone atual da pessoa que o envio "agora" usa (DG7; conferir onde o público de hoje lê o telefone e registrar), `enqueueTeamSend` (`team-whatsapp.service.ts:~695`), `TeamWhatsappRepository.findSectorChannels`, `requireSectorNumbers`/`requireOpenNumbers` (`team-whatsapp.channels.ts:124-142`; conferir assinaturas e registrar), `isTeamSender`, `AuditService`, a fila `TEAM_WHATSAPP_SEND`. Produz CI7.

**Contexto vinculado:**
- I7 (conselho U): "A ação 'Enviar lembrete aos pendentes' exige a permissão de alerta urgente: mostra a lista nominal, da qual quem envia pode tirar nomes, confere o canal na hora e manda o texto original precedido de 'Lembrete:', com a mesma linha de confirmação. Entram no lembrete só pessoas do alerta original ainda sem ciência (…). O servidor refaz a lista ao confirmar e nunca acrescenta ninguém. 'Falhou' usa o 'Repetir' que já existe; 'pulado' e quem continuar sem entrega ficam como 'tratar por outro meio', com ciência manual. Limites: no máximo 3 lembretes por alerta, com 5 minutos de intervalo desde o alerta ou o lembrete anterior; dois pedidos ao mesmo tempo geram um lembrete só. O lembrete fica ligado ao alerta original e não tem painel nem lembrete próprios."
- I7 (rota e recusas): "`POST /internal/team-whatsapp/dispatches/:id/reminders` com `{ recipientIds }` (…; 1 a 500 ids, sem repetição (…)). O servidor recalcula os elegíveis do alerta e envia à interseção; ninguém de fora entra. Interseção vazia → 422 `team_whatsapp.reminder_empty`." "Ordem das recusas: 403 (chaves) → 404 (alerta invisível) → 403 remetente e área, como no 'Repetir' (`isTeamSender`, `requireAreaOf`) → 422 `not_an_alert` → 422 `reminder_empty` → 409 `team_whatsapp.reminder_limit` (3 lembretes) → 409 `team_whatsapp.reminder_too_soon` (menos de 5 min) → 409 canal desconectado/sem conferência (regras de hoje) → gravação. A interseção, os dois 409 do limite e a troca de `reminderCount` ficam na mesma transação: pedido vazio ou recusado não consome lembrete".
- I7 (pedido único): "o alerta guarda `reminderCount` e `lastReminderAt`; o lembrete só é gravado se a troca condicional desses dois campos vencer, na mesma transação que cria o envio do lembrete. O segundo pedido simultâneo recebe 409 `reminder_too_soon`".
- I7 (envio do lembrete): "finalidade Urgência, o mesmo motivo, o mesmo alvo (`targetType`, `targetId`) e as mesmas linhas de setor do alerta (para o 'Repetir' do lembrete passar pela checagem de área), `parentDispatchId` = alerta, `ackDeadlineMinutes` nulo e destinatários com `parentRecipientId`. Telefone, número e a conferência na hora seguem as regras do envio 'agora' (inclusive telefone gravado, Lote G). Texto: `Lembrete: ` + texto do alerta". Trilha: "`team_whatsapp.reminder` com ids do alerta e do lembrete e a contagem."
- I1: "O 'Repetir' das falhas de um alerta segue a regra de hoje (`equipe.enviar` e a área), sem a chave nova".
- DI10 inteiro (pré-checagem fora da transação, canal fora da transação, transação que refaz e troca, cópia dos campos, enfileiramento depois). GI4, GI3, GI12.

**Passos:**
1. [ ] RED unidade (`team-alert-reminder.service.spec.ts`, colaboradores falsos): `it('aceite 12: sem a chave — 403 antes de buscar o alerta, inclusive invisível')`; `it('invisível — 404; não remetente — 403; aceite 10: autor que deixou de gerir o setor — 403')`; `it('reunião, urgência antiga ou lembrete — 422 not_an_alert')`; `it('ordem: reminder_empty antes de reminder_limit antes de reminder_too_soon antes do canal')`; `it('canal fechado — 409 sem abrir a transação')`; `it('trilha reminder com actorId, alertId, reminderId e queued, sem nome')`.
2. [ ] RED integração (`team-alert-reminder.integration.spec.ts`, banco real, fila e porta ao vivo falsas): `it('aceite 9: entram Sem resposta, Respondeu sem ciência e incerto; ciente, Falhou e pulado não')`; `it('aceite 19: só ids fora dos elegíveis — 422 reminder_empty e reminderCount não muda')`; `it('aceite 9: ciência gravada entre a pré-checagem e a transação — a pessoa sai')`; `it('aceite 10: 4º lembrete — 409 reminder_limit')`; `it('aceite 10: antes de 5 min do alerta ou do anterior — 409 reminder_too_soon')`; `it('aceite 10: dois pedidos ao mesmo tempo — um lembrete; o outro 409 reminder_too_soon')` (`Promise.all`); `it('aceite 10: número desconectado — 409, nenhum envio criado, reminderCount igual')`; `it('lembrete: Urgência, mesmo motivo, alvo e setores, parentDispatchId, ackDeadlineMinutes null, texto Lembrete: + texto do alerta, destinatários com parentRecipientId e o telefone atual da pessoa')`; `it('I7: pessoa que trocou de telefone depois do alerta — o lembrete grava o número novo e sai, sem Pulado: telefone mudou')`; `it('500 pessoas elegíveis — lembrete criado por createMany dentro do timeout da transação')`; `it('um job por destinatário do lembrete')`; `it('aceite 19: Repetir das falhas do alerta por SUPERVISOR sem equipe.urgencia — funciona')`; `it('aceite 20: lembrete do ADMIN em alerta do SUPERVISOR — autor ADMIN')`.
3. [ ] GREEN; rota; módulo; typecheck; eslint (GI10); validação; `--changed`.

**Aceite:** 9, 10, 19, 20 (back), 12 (lembrete). **Risco: crítico (autorização).**
**Crítico: autorização e concorrência — portão da chave e da área antes de enviar a pessoas reais, e a troca condicional que impede dois lembretes; um erro manda WhatsApp a quem não devia ou duas vezes.**

## Task 10 — Demonstração de T09 / cenário 10 (back, só teste)

**Arquivos:** criar `backend/src/modules/team-whatsapp/team-whatsapp.t09.test-fixtures.ts` e `team-whatsapp.t09.integration.spec.ts`. Nenhum arquivo de produção; o fixture do T08 só por import (acréscimos, se inevitáveis, listados no report).

**Interfaces:** consome T4 (criação), T5 (`applyReply`), T6 (`TeamAlertAckService`), T7 (`TeamAlertPanelService`), T8 (processor), T9 (`TeamAlertReminderService`), o harness do H (`buildT08World`, DH11). Produz a demonstração de T09.

**Contexto vinculado:**
- Aceite 6: "(T09, cenário 10) Alerta com motivo, duas pessoas, agora: a revisão mostra os nomes e o prazo; uma responde 'OK' e aparece 'Ciente' com a hora e o texto; a outra aparece em 'Sem resposta' e, passados 15 min, 'Pendente — prazo vencido'." (No back: grupo `acked` com `ackReply`; a outra `no_reply` com `ackDeadlineAt` = criação + 15 min; o rótulo "prazo vencido" é da tela, T12.)
- Aceite 9 (trechos): "quem dá ciência com o lembrete ainda na fila fica 'Pulado: já confirmou', sem chamada ao provedor; 'OK' ao lembrete deixa a pessoa ciente no alerta original". Aceite 16: "ciência 20 min depois do alerta → 'Ciente (após o prazo) às HH:mm'; um lembrete aos 10 min não muda o 'vence às' do alerta." Aceite 22: "'OK' que chega ao mesmo tempo que a ciência manual: a manual vale e o `ackMessageId` fica guardado; desfazer a manual passa a ciência para automática". Aceite 15: "Nenhum log ou trilha nova contém texto de resposta, observação, nome ou telefone."
- DI16 (ingestão real se der; senão `Message` `INBOUND` + `applyReply` com os argumentos da ingestão; registrar). GI9 (`now` explícito nos serviços; horas gravadas explícitas). GI12.

**Passos:**
1. [ ] Fixture: `buildT09World()` sobre `buildT08World()` — duas pessoas autorizadas num setor com número EVOLUTION, ator ADMIN, serviços reais de criação, painel, ciência manual e lembrete; helper `reply(person, text, kind, at)`; espiões de `AuditService` e do logger.
2. [ ] RED/GREEN (a regra já existe; o teste prova): `it('cenário 10: alerta com motivo a duas pessoas — texto com a linha fixa, prazo de 15 min; A responde OK — Ciente com hora e texto; B em Sem resposta')`; `it('cenário 10: lembrete a B aos 10 min — ackDeadlineAt igual; B responde não entendi ao lembrete — Respondeu, sem ciência; Ok! aos 20 min — Ciente após o prazo')`; `it('aceite 9: A dá ciência com o lembrete na fila — Pulado: já confirmou, uma chamada ao provedor a menos')`; `it('aceite 22: OK e ciência manual juntos; desfazer — automática com a hora do OK')`; `it('aceite 15: nenhuma trilha nem log do cenário contém os textos, a observação, os nomes ou os telefones')`.
3. [ ] Validação (`TESTCONTAINERS_ENABLED=1`); eslint (GI10); `--changed`.

**Aceite:** 6 (back, ponta a ponta), 9, 15, 16, 22 (demonstração). **Risco: alto** (é a demonstração de T09 para a GBR). Revisão `sonnet`.

## Task 11 — Front: chave, finalidade escondida, linha fixa e prazo na revisão, erros, Novidades

**Arquivos:** modificar `frontend/src/features/permissions/keys.ts` (`PERMISSION_KEYS` ~L4-17, matriz padrão ~L26-43, `DEFAULT_PERMISSIONS` ~L46-50, `PERMISSION_LABELS` ~L52-97) e specs que fixam a contagem: `features/permissions/components/permissions-matrix.spec.tsx` (~L88 `toHaveLength(10)` → 11), `features/permissions/access.spec.ts` (~L13 última chave → `equipe.urgencia`; ~L34 penúltima → `pessoas.importar`; ~L47 `toHaveLength(PERMISSION_KEYS.length - 3)` → `- 4`, porque o SUPERVISOR continua com 7); criar `frontend/src/release-notes.alert.spec.ts`; `features/team-whatsapp/components/purpose-fields.tsx` (lista de finalidades ~L45/~L93-120); `components/send-whatsapp-dialog.tsx` (**só** trocas: contador ~L459, trava ~L106/~L119-121, linha fixa depois do textarea ~L458, prazo na revisão `AudienceReview` ~L87-98); `error-messages.ts` (`TEAM_ERROR_MESSAGES`, `SKIP_REASON_LABEL`); `schemas.ts` (só o motivo de pulo, se for enum); `frontend/src/release-notes.ts`; criar `alert-text.ts`, `alert-text.spec.ts`, `components/alert-confirm-line.tsx`, `components/purpose-fields.urgency.spec.tsx`, `components/send-whatsapp-dialog.alert.spec.tsx`.

**Interfaces:** consome `usePermission` (`features/permissions/use-permission.ts:5-7`), `PURPOSE_RULES`, CI9. Produz a base do front.

**Contexto vinculado:**
- I1: "Sem a chave, a finalidade Urgência não aparece na tela". "A chave entra no catálogo (`PERMISSION_KEYS`), no texto de recusa, nas chaves do front e na tela da matriz." DI2 (rótulo e descrição exatos; `PERMISSION_LABELS` é `Record`, chave sem rótulo não compila; `toPermissionKeys` descarta chave desconhecida).
- I2: "o front mostra a linha fixa embaixo da caixa de texto, sem edição, e desconta o tamanho dela do contador." Aceite 13: "com 2001 caracteres somados, o botão trava no front". DI3 (41 caracteres; `maxLength` do textarea continua 2000; a trava e o contador usam `finalTextLength`; o corpo enviado continua o texto cru — o servidor acrescenta a linha).
- I3: "O prazo aparece na confirmação e no histórico." Aceite 6: "a revisão mostra os nomes e o prazo" → na revisão da Urgência, "Prazo de ciência: 15 min, contado da confirmação do envio".
- DI14 (textos de erro e `ACKED` → "já confirmou").
- I9: "Entrada nova em `release-notes.ts` dizendo: alerta urgente com confirmação 'OK', painel de pendências, lembrete e ciência manual; a linha fixa 'Responda OK para confirmar que recebeu.' no fim de todo alerta; e que, até o ADMIN ligar a chave 'Criar alerta urgente' para outros papéis, só ele cria alerta (quem tem `equipe.enviar` continua usando as outras finalidades)." Transição (spec): "se o Lote F for à produção antes da Etapa 4, SUPERVISOR e OPERATOR perdem a Urgência na atualização seguinte; a nota de versão precisa dizer isso."
- frontend/CLAUDE.md: entrada nova sempre no TOPO de `RELEASE_NOTES`, ordem decrescente por `version` (`'YYYY.MM.DD'` ou `'YYYY.MM.DD.n'`; o topo hoje é `2026.11.20.2`); texto em PT-BR para o operador; `where: '/whatsapp-equipe'`; sem nome ou telefone de exemplo.
- GI10: `send-whatsapp-dialog.tsx` é legado: só trocas de chamada; `describe` novos em arquivo novo.

**Passos:**
1. [ ] RED puro (`alert-text.spec.ts`): `it('finalTextLength soma 41 só na Urgência')`; `it('constantes espelham o servidor: linha e 15 min')`.
2. [ ] RED tela: `it('aceite 12: sem equipe.urgencia a Urgência não aparece; com ela, aparece')`; `it('aceite 13: Urgência mostra a linha fixa sob a caixa e o contador soma 41')`; `it('aceite 13: 1960 caracteres na Urgência — botão travado; 1959 — liberado')`; `it('aceite 6: revisão da Urgência mostra o prazo de 15 min')`; `it('reunião: sem linha fixa, contador como hoje')`; `it('Pulado: já confirmou')`; `it('erros novos com os textos de DI14')`; permissões: `it('matriz mostra Criar alerta urgente; SUPERVISOR e OPERATOR desligados no padrão')`.
3. [ ] RED Novidades (`release-notes.alert.spec.ts`, arquivo novo): `it('aceite 18: entrada no topo com where /whatsapp-equipe cita a linha fixa Responda OK para confirmar que recebeu. e avisa que, até o ADMIN ligar Criar alerta urgente, só ele cria alerta')`; entrada no topo; `timeout 600 gate --test src/release-notes.spec.ts` e `timeout 600 gate --test src/release-notes.alert.spec.ts`.
4. [ ] GREEN; ajustar os specs de contagem; `npx tsc -b`; eslint (GI10); validação; `--changed`.

**Aceite:** 12 (tela), 13 (tela), 18, 6 (revisão). **Risco: médio.**
**fronteira: autorização — esconde a finalidade sem a chave e espelha o catálogo; a recusa de verdade é do servidor (T2). Revisão `opus`.**

## Task 12 — Front: painel de pendências, coluna "Ciência" e histórico

**Arquivos:** criar `frontend/src/features/team-whatsapp/alert-schemas.ts`, `alert-labels.ts`, `alert-api.ts`, `components/alert-panel.tsx`, specs `alert-labels.spec.ts`, `components/alert-panel.spec.tsx`, `components/recipient-table.ack.spec.tsx`, `components/recent-dispatches.alert.spec.tsx`; modificar `schemas.ts` (lista ~L208-245 e detalhe ~L264-289: campos de DI12, `.nullish()`), `components/dispatch-result.tsx` (**só** inserir `<AlertPanel>` antes de `RecipientTable` ~L176, passar o mapa de rótulos à tabela e o "Lembrete do alerta de …" no cabeçalho), `components/recipient-table.tsx` (prop opcional `ackLabels?: ReadonlyMap<string, string>`; coluna "Ciência" depois de "Quando" só com a prop), `components/recent-dispatches.tsx` (`PurposeCell` ~L55-65).

**Interfaces:** consome CI5 e CI10 (espelho tolerante; os campos de lista e detalhe vêm da T14 no back, sem dependência de código), `manausDateTime` (`labels.ts:147-164`), `POLL_INTERVAL_MS` (`api.ts:30`), `RECIPIENT_STATUS_LABEL`. Produz `alert-panel.tsx` (T13 acrescenta as ações) e CI9 (labels, `useAlertPanel`).

**Contexto vinculado:**
- I6: "O resultado do alerta urgente tem um painel nominal, visível a quem já vê o envio no histórico, em quatro grupos: 'Sem entrega' (…), 'Sem resposta' (…), 'Respondeu, sem ciência' e 'Ciente'." "o rótulo da ciência aparece ao lado do nome no painel e numa coluna 'Ciência' que a tabela de destinatários ganha só no alerta: 'Ciente às HH:mm', 'Ciente (manual) às HH:mm', 'Ciente (após o prazo) às HH:mm', 'Ciente (manual, após o prazo) às HH:mm', 'Pendente · há N min' ou 'Pendente — prazo vencido'. Na ciência manual, o painel mostra a observação e o autor no lugar do texto da resposta (e, se houver, a última resposta abaixo). Nas outras finalidades a tabela não muda." "O painel fica acima da tabela de destinatários, com o prazo ('Prazo de ciência: 15 min — vence às HH:mm' ou 'vencido às HH:mm'), a contagem de cada grupo, o texto da resposta (…) e a lista dos lembretes do alerta (hora, autor, quantas pessoas)." "A tela relê o painel a cada 10 s enquanto houver pendência e o alerta tiver menos de 2 horas".
- I7: "Na lista do histórico o lembrete aparece como envio próprio, com 'Lembrete do alerta de dd/mm HH:mm'". I3: "O prazo aparece (…) no histórico." I8: urgência antiga sem painel, sem ciência.
- DI12, DI15 inteiros (rótulos, "(Áudio)" etc., polling, Manaus). C3: nenhuma situação nova de envio. GI8: campos novos `.nullish()`; fixtures de hoje continuam válidas.
- Memória "ky 2 consome corpo do erro": erros pela `readApiErrorBody`/`apiErrorText` de hoje.
- GI10: `dispatch-result.tsx` é legado (só inserção); a lógica em `alert-labels.ts` e `alert-panel.tsx`.

**Passos:**
1. [ ] RED puro (`alert-labels.spec.ts`): `it('ackLabel: as quatro formas de Ciente com HH:mm de Manaus')`; `it('Pendente · há N min antes do prazo; menos de 1 min; Pendente — prazo vencido depois')`; `it('deadlineText: vence às / vencido às')`; `it('replyText: texto; sem texto → (Áudio), (Figurinha), (Mensagem sem texto)')`; `it('alertPollInterval: 10 s com pendência e < 2 h; false sem pendência ou ≥ 2 h')`.
2. [ ] RED tela: `it('aceite 6: painel com Ciente às HH:mm e o texto OK; Sem resposta com Pendente · há N min; passados 15 min, Pendente — prazo vencido')`; `it('aceite 16: Ciente (após o prazo) às HH:mm')`; `it('aceite 11: manual mostra Obs. e autor e a última resposta abaixo')`; `it('aceite 20: lista de lembretes com hora, autor e quantas pessoas')`; `it('aceite 7: Respondeu, sem ciência com o texto da última resposta')`; `it('coluna Ciência só no alerta; reunião sem coluna')`; `it('aceite 14: urgência antiga — sem painel e sem coluna')`; `it('histórico: Lembrete do alerta de dd/mm HH:mm; alerta com Prazo de ciência: 15 min')`; `it('esquemas aceitam resposta sem os campos novos')`.
3. [ ] GREEN; `npx tsc -b`; eslint (GI10); validação; `--changed`.

**Aceite:** 6, 7, 11, 14, 16, 20 (tela). **Risco: médio.**
**fronteira: contrato público consumido pelo front e dado pessoal na tela — só espelha CI5 e exibe o que o servidor já decidiu mostrar a quem vê o envio. Revisão `opus`.**

## Task 13 — Front: lembrete aos pendentes e ciência manual

**Arquivos:** criar `frontend/src/features/team-whatsapp/alert-actions-api.ts`, `components/reminder-dialog.tsx`, `components/manual-ack-dialog.tsx`, specs `components/reminder-dialog.spec.tsx`, `components/manual-ack-dialog.spec.tsx`, `components/alert-panel.actions.spec.tsx`; modificar `components/alert-panel.tsx` (botões "Enviar lembrete aos pendentes", "Registrar ciência" por pessoa pendente, "Desfazer ciência manual" na manual).

**Interfaces:** consome CI5/CI6/CI7 (rotas e corpos), CI9 (T12), `usePermission`, `apiErrorText`. Produz as ações.

**Contexto vinculado:**
- I7: "A ação 'Enviar lembrete aos pendentes' exige a permissão de alerta urgente: mostra a lista nominal, da qual quem envia pode tirar nomes (…). Entram no lembrete só pessoas do alerta original ainda sem ciência: as de 'Sem resposta', as de 'Respondeu, sem ciência' e as de 'situação incerta', estas marcadas na lista como 'pode já ter recebido'. (…) 'Falhou' usa o 'Repetir' que já existe; 'pulado' e quem continuar sem entrega ficam como 'tratar por outro meio', com ciência manual. Limites: no máximo 3 lembretes por alerta, com 5 minutos de intervalo".
- I5: "pode marcar qualquer pessoa do alerta como ciente, com observação obrigatória de até 200 caracteres (ex.: 'confirmou por ligação') (…). A ciência manual pode ser desfeita por quem pode registrá-la (…); a automática não."
- I1: sem `equipe.urgencia` (ou sem `equipe.enviar`), sem botões de lembrete e de ciência; o painel continua visível (aceite 12).
- DI10/CI7 (corpo `{ recipientIds }`, resposta `{ reminderId, queued }`); DI7/CI6 (`{ note }`, 204); DI14 (textos dos erros); DI9 (`eligible`, `mayHaveReceived`, `reminders.count/max/nextAllowedAt`).
- Diálogo do lembrete: lista dos elegíveis com caixa marcada por padrão, "pode já ter recebido" nos incertos; abaixo, "Não entram": Falhou → "use Repetir na tabela"; pulado e na fila → "tratar por outro meio (registrar ciência)"; "Lembrete n de 3"; botão desligado com 3 lembretes ou antes de `nextAllowedAt` ("disponível às HH:mm"); erro do servidor por `apiErrorText`. Depois de enviar, invalida painel, detalhe e lista.

**Passos:**
1. [ ] RED: `it('aceite 9: diálogo lista só os elegíveis, com pode já ter recebido nos incertos, e Falhou/pulado em Não entram')`; `it('tirar um nome manda só os marcados')`; `it('aceite 10: com 3 lembretes ou antes de 5 min, botão desligado com o motivo')`; `it('erro 409 reminder_too_soon mostra o texto')`; `it('aceite 11: registrar ciência exige observação de 1 a 200; envia note')`; `it('desfazer só aparece na manual')`; `it('aceite 12: sem equipe.urgencia, painel sem botões')`.
2. [ ] GREEN; `npx tsc -b`; eslint (GI10); validação; `--changed`.

**Aceite:** 9, 10, 11, 12 (tela). **Risco: médio.**
**fronteira: autorização — só mostra ou esconde as ações; a recusa é do servidor (T6, T9). Revisão `opus`.**

## Task 14 — Histórico e detalhe do alerta e do lembrete; checagem de área extraída (back, Onda 3)

**Arquivos:** modificar `backend/src/modules/team-whatsapp/dispatch-purpose-view.ts` (view e mapeamentos de lista e detalhe); em `team-whatsapp.repository.ts` **só** `dispatchListSelect` (~L122-146) e `dispatchDetailSelect` (~L163-190) (+ `ackDeadlineMinutes`, `parentDispatch: { select: { id: true, createdAt: true } }`); em `backend/src/schemas/contracts/team-whatsapp.schema.ts` **só** o item da lista e o detalhe (+ os três campos de CI10); as fábricas de linha de lista/detalhe nos specs que o tipo quebrar (só os campos novos; listar no report); `team-whatsapp-retry.service.ts` (**só** a troca do método privado da checagem de área pela função extraída, sem mudar o corpo); criar `team-dispatch-area.ts`, `team-whatsapp.alert-history.integration.spec.ts`, `backend/src/schemas/contracts/team-whatsapp.schema.alert-history.spec.ts`.

**Interfaces:** consome CI1 (`ackDeadlineMinutes`, relação `parentDispatch`), CI2 (`alertDeadlineAt`), a visibilidade de hoje do detalhe (`requireVisible`, `team-whatsapp-results.service.ts:301-313`). Produz CI10: os campos de lista e detalhe que a T12 espelha e `team-dispatch-area.ts`, que a T9 chama.

**Contexto vinculado:**
- DI12 (back): "Pelo `dispatch-purpose-view.ts` (que já monta finalidade, base e motivo para a lista e o detalhe): item da lista e detalhe + `ackDeadlineMinutes: number | null`, `ackDeadlineAt: string | null` (ISO) e `reminderOf: { dispatchId: string; createdAt: string } | null` (do `parentDispatch`). (…) Urgência antiga: os três campos nulos → tela de hoje (I8)." A parte de tela de DI12 é da T12.
- I3: "O prazo aparece na confirmação e no histórico." I7: "Na lista do histórico o lembrete aparece como envio próprio, com 'Lembrete do alerta de dd/mm HH:mm', e o detalhe dele segue a visibilidade de hoje (autor ou ADMIN)."
- GI6 (I8): "Envio de Urgência sem prazo gravado e sem `parentDispatchId` (anterior a esta versão) aparece como hoje: sem painel, sem ciência, sem lembrete." Alerta = `ackDeadlineMinutes` não nulo; lembrete = `parentDispatchId` não nulo. GI5 (C2): "ADMIN vê todos; os demais veem só os próprios envios." O detalhe do lembrete segue essa regra (autor ou ADMIN).
- GI8: campos novos de contrato obrigatórios no back (esta task os cria e os preenche em lista e detalhe), tolerantes no front (T12).
- Extração (DI10, CI10): a checagem de área do "Repetir" (`team-whatsapp-retry.service.ts:76-91`) vai para `team-dispatch-area.ts` **sem mudar o corpo**; o retry passa a chamá-la; a T9 a reutiliza no lembrete. I1: "O 'Repetir' das falhas de um alerta segue a regra de hoje (`equipe.enviar` e a área), sem a chave nova."
- GI10: `team-whatsapp.repository.ts` e `team-whatsapp.schema.ts` são legados: só os campos novos; o cálculo de `ackDeadlineAt` e `reminderOf` mora em `dispatch-purpose-view.ts`.

**Passos:**
1. [ ] RED contrato (`team-whatsapp.schema.alert-history.spec.ts`): `it('item da lista e detalhe exigem ackDeadlineMinutes, ackDeadlineAt e reminderOf (nulos ou preenchidos)')`.
2. [ ] RED integração (`team-whatsapp.alert-history.integration.spec.ts`, banco real; alerta e lembrete semeados com `createdAt` explícito, GI9): `it('alerta: lista e detalhe com ackDeadlineMinutes 15 e ackDeadlineAt = createdAt + 15 min')`; `it('lembrete: reminderOf com id e createdAt do alerta; ackDeadlineMinutes e ackDeadlineAt nulos')`; `it('aceite 14: urgência antiga e reunião — os três campos nulos')`; `it('aceite 20: detalhe do lembrete do ADMIN — 404 para o SUPERVISOR autor do alerta')`; `it('detalhe do lembrete (audienceRule, audienceExcluded e roster nulos) responde sem erro')`.
3. [ ] Extrair a checagem de área para `team-dispatch-area.ts` sem mudar o corpo; specs do retry existentes verdes **sem alteração**; registrar a assinatura no report (CI10).
4. [ ] GREEN; ajustar as fábricas de lista/detalhe; typecheck; eslint (GI10); validação (`TESTCONTAINERS_ENABLED=1`); `--changed`.

**Aceite:** base de 6 e 16 (prazo no histórico), 14 (histórico da urgência antiga), 20 (detalhe do lembrete), I7 (lembrete na lista). **Risco: alto** (contrato público: lista e detalhe ganham campos obrigatórios).
**fronteira: autorização — move, sem mudar o corpo, a checagem de área do "Repetir" que a T9 reutiliza no lembrete; os specs do retry sem alteração provam o comportamento. Revisão `opus`.**

---

## Fechamento (principal)

1. Conferir o ledger: 14 tasks aceitas; revisões conforme cada task; `tsc` do back conferido depois de cada onda (GI8); os testes do Rastreio presentes e verdes.
2. Gates completos, **um de cada vez**, nada mais rodando (sem stack de QA junto; memória "gate completo sozinho"): back com `NODE_OPTIONS=--max-old-space-size=6144`, depois front, `--base origin/main`, no estado final; comparar com o fim do Lote H (`.superpowers/sdd/2026-11-20-orgamind-gbr-etapa4-lote-h-rastreio/final-back-gate-full-detail.log` e `final-front-gate-full-detail.log`) pelo script ancorado; bloquear violação nova ou agravada; conferir `max-lines-per-function` 50 dos specs novos.
3. Migração no banco local de QA (stack `orgamind-turnos-qa`, seed fictício): `count(*)` de `TeamWhatsappDispatch`, `TeamWhatsappRecipient` e `RolePermission` antes e depois (iguais); `prisma migrate deploy`; colunas nulas e `reminderCount 0` nas linhas antigas; tempo da migração anotado. **Deploy fora do horário de envio** (índices e FKs bloqueiam escrita por instantes): avisar no PR.
4. QA visual (agente `qa`, roteiro Node com `@playwright/test`, senha do seed lida no processo, login 5/min; dados semeados por SQL no banco de QA): ADMIN cria alerta (linha fixa, contador, prazo na revisão); painel com os quatro grupos, rótulos, "Ciente (manual)", lista de lembretes; diálogo do lembrete; registrar e desfazer ciência; histórico com "Lembrete do alerta de …"; SUPERVISOR sem a chave não vê a Urgência nem os botões, vê o painel do próprio alerta; matriz com "Criar alerta urgente".
5. Revisão final do conjunto com `opus`.
6. Atualizar "Estado" deste plano; registrar na spec, em "Para a GBR confirmar" (linha do Lote I), as decisões que mudam o que a GBR vê (as mesmas de "Dúvidas de produto", abaixo): DI6 (24 h contadas do aceite do envio mais recente, inclusive; reação e figurinha marcam "Respondeu"), DI10 (lembrete usa o número atual da área e o telefone atual da pessoa; falha da fila consome o lembrete), DI11 (pessoa que confirma no instante em que o lembrete sai pode recebê-lo; lembrete em que todos foram pulados por "já confirmou" aparece no histórico como "Ninguém recebeu", C3), DI15 ("há menos de 1 min"; textos "(Áudio)" etc.).
7. Commits do lote, push e PR **rascunho** sobre `feat/envio-rastreavel` (C1: um PR por lote, empilhados), com os avisos: "Vai para produção junto com os Lotes F, G e H (PRs #18, #19 e #20)"; "migração fora do horário de envio"; Transição: "até o ADMIN ligar a chave, só ele cria alerta urgente". **Sem merge, sem deploy.**

## Dúvidas de produto (decididas provisoriamente; para a GBR confirmar)

- **Reação e figurinha (DI5/DI6):** contam como "Respondeu, sem ciência". Recomendação: manter (já está na lista da spec para a GBR).
- **Janela da ciência automática (DI6):** 24 h contadas do aceite do envio mais recente para a pessoa naquele número, inclusive (24 h exatas valem; 24 h e 1 ms, só "Respondeu"). Recomendação: manter.
- **Número e telefone do lembrete (DI10):** o número atual da área, não o do alerta; o telefone da pessoa é o atual na criação do lembrete, como no envio "agora" (I7, DG7): quem trocou de número depois do alerta recebe o lembrete no número novo. Recomendação: manter.
- **Fila indisponível no lembrete (DI10):** o lembrete conta no limite e as pessoas ficam "Falhou", repetíveis. Recomendação: manter (regra de hoje do envio).
- **Ciência no instante do envio do lembrete (DI11):** quem confirma nos milissegundos entre a conferência e a chamada ao provedor recebe o lembrete. Recomendação: manter.
- **Lembrete em que todos já confirmaram (DI11, C3):** se todos os destinatários são pulados por "já confirmou" antes de sair, o lembrete aparece no histórico como "Ninguém recebeu" (situação de hoje de envio só com pulados; C3: nenhuma situação nova). Recomendação: manter.
- **Rótulos da tela (DI15):** "Pendente · há menos de 1 min" no primeiro minuto; resposta sem texto como "(Áudio)", "(Imagem)", "(Vídeo)", "(Figurinha)", "(Documento)" ou "(Mensagem sem texto)". Recomendação: manter.
- **Lembrete sem ninguém com telefone válido (ruling da T9):** se todos os marcados seriam pulados pelo telefone (sem número, sem autorização), o lembrete é recusado com o texto de "ninguém para enviar" (`team_whatsapp.no_recipients`) e **não** consome um dos 3 lembretes; é a mesma trava do envio "agora". Recomendação: manter.
- **Dois "OK" quase juntos (revisão T5, DI6 literal):** se a pessoa manda dois "OK" com segundos de diferença, a hora da ciência pode ser a de um e a mensagem guardada a do outro; as duas valem como ciência. Recomendação: manter.
- **Desfazer a ciência manual no instante do lembrete (revisão T8):** quem tem a ciência manual desfeita nos milissegundos em que o lembrete está saindo pode ficar "Pulado: já confirmou" nesse lembrete (simétrico ao caso de quem confirma no instante do envio). Recomendação: manter.
- **Pessoa desativada depois do alerta (revisão T9):** continua elegível ao lembrete e recebe no telefone atual; o processor e o "Repetir" também não conferem se a pessoa está ativa. Recomendação: manter por ora; se a GBR quiser excluir, entra como regra nova (pulo "inativo") no lembrete e no "Repetir".
- **Deploy (revisão T1):** a migração segura as duas tabelas do envio da equipe até terminar (não só "por instantes"): rodar fora do horário de envio, com um container só da API/worker (o código antigo não lê o motivo "já confirmou").

## Não verificado (conferir na task dona)

- Versão do Postgres (produção, QA e testcontainer) para `ALTER TYPE … ADD VALUE` dentro da transação (T1).
- Se algum teste compara `teamSkipReasonSchema` com o enum do Prisma (T1).
- Se `TeamWhatsappDispatch`/`TeamWhatsappRecipient` são apagados em algum caminho (efeito do `ON DELETE SET NULL`) (T1).
- Se o serviço de permissões aceita gravar a chave nova pela matriz sem mudança (validação por `PERMISSION_KEYS`) (T2).
- `InboundChatMessage.kind` com o mesmo tipo de `MessageKind`; se o parse do adaptador é alcançável num spec sem rede (T5).
- Se o `@updatedAt` do Prisma muda em `updateMany` de ciência num destinatário `QUEUED` (ciência manual em "Sem entrega"): no máximo adia o verificador de presos do H em 30 min; não é corrigido aqui (T6).
- Se algum spec enumera todos os controllers (rotas novas em `NEW_ROUTES`) (T6, T7, T9).
- Assinatura da checagem de área do retry (T14) e de `requireSectorNumbers`/`requireOpenNumbers` (T9).
- Pessoa que saiu do cadastro (sem `userId` atual) entre o alerta e o lembrete: confirmar na T9 que `sendPhoneOf`/`phoneSkipReason` cobrem o caso como no "agora" (telefone e pulo já decididos no DI10).
- Como `createDispatch` gera os ids dos destinatários (para o `createMany` do lembrete ter os `jobId`) (T9).
- Se o detalhe de um envio a setor com `audienceRule` nulo (o lembrete) renderiza sem erro no back (T14) e no front (T12).
- Se o `ChatIngestService` pode ser montado na integração com Redis/filas/eventos falsos (T10).
- Se o motivo de pulo no `schemas.ts` do front é enum (T11) e a assinatura de `sendBlocks` (recebe a finalidade?) (T11).
