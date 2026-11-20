# OrgaMind, Etapa 4 GBR, Lote H: rastreio do envio — hora da conferência do número, destinatário preso, mensagem pulada cancelada, "Quando" e repetições, demonstração de T08 (INT-01, INT-02, INT-03). Implementation Plan

> **Para os agentes:** executar pela skill `sdd` (TDD, ledger em `.superpowers/sdd/2026-11-20-orgamind-gbr-etapa4-lote-h-rastreio/progress.md`). **Sem commit/push**: nenhuma task commita; a principal integra e commita o lote. Branch `feat/envio-rastreavel`, criado de `feat/agendamento-reconferencia` em `68f9abd` (Lote G, PR #19). Fechamento de task por `gate --changed --base feat/agendamento-reconferencia`. Regras dos agentes: `.superpowers/sdd/2026-11-20-orgamind-gbr-etapa4-lote-h-rastreio/{implementer-rules,reviewer-rules}.md` (criadas na Preparação). Linhas citadas são pistas e podem ter mudado.

**Goal:** o resultado de cada envio diz a verdade sobre cada pessoa: o número mostra a hora da conferência de conexão que liberou a mensagem; nenhum destinatário fica "Na fila" para sempre (um verificador no worker fecha o preso sem job pela leitura da `Message`, sem nunca reenfileirar); a `Message` preparada e depois pulada vira `CANCELLED`; a tabela mostra "Quando" e "· repetido n×"; e uma suíte de integração com banco real demonstra T08 (cenário 9).

**Architecture:** no back, módulo `backend/src/modules/team-whatsapp/`: o processor de envio grava `channelCheckedAt` (hora do `checkedAt` da porta ao vivo, só com `open`) na mesma gravação que conta a tentativa, e o pulo com `Message` preparada passa por uma transação nova (`team-recipient-finish.ts`) que cancela a `Message` `QUEUED`; o verificador de presos é uma função pura de classificação (`stuck-recipients.ts`), um repositório novo com a troca condicional (`team-stuck-recipients.repository.ts`), um serviço que consulta o job no BullMQ (`team-stuck-reconciler.service.ts`) e uma fila repetível nova no worker (5 min). Uma migração aditiva (uma coluna, um índice). A API de destinatários passa a devolver `channelCheckedAt` e `manualRetries`. No front, `frontend/src/features/team-whatsapp/`: colunas "Quando" e hora da conferência, "· repetido n×", rótulo de "saiu da fila sem envio" e a entrada de Novidades.

**Tech Stack:** NestJS + Prisma 6 + Zod v4 + BullMQ + Vitest/testcontainers no back; React + TanStack Query + Vitest/Testing Library no front. **Sem dependência nova.**

**Spec:** `docs/superpowers/specs/2026-11-20-orgamind-gbr-etapa4-envio-urgencia.md` — Restrições, Anti-objetivos, C1–C3, "Lote H" (H1–H6), "Para a GBR confirmar" (linha do Lote H), aceites 1–5 e 21 (o 21 é do Lote H, apesar de listado depois). Mapas: `.superpowers/sdd/2026-11-20-orgamind-gbr-etapa4-envio/fontes/` (`mapa-canal-fila-back.md`, `mapa-estados-respostas-back.md`, `mapa-front.md`). Plano do G: `docs/superpowers/plans/2026-11-20-orgamind-gbr-etapa3-lote-g-agendamento.md` (DG7 telefone congelado e GG1–GG14 continuam valendo; aqui só se repete o que a task usa). **Lote I fora deste plano** (ciência, prazo, lembrete, `equipe.urgencia`): nenhuma task cria coluna, enum, rota ou rótulo dele.

## Estado (20/11/2026)

- **Lote H implementado e fechado (20/11/2026).** 8/8 tasks aceitas em 4 ondas (revisão opus em T1–T6, sonnet em T7–T8; um fix round na T4: teste de corrida com o claim real do chat). Revisão final do conjunto (opus) APPROVED; 4 Minor corrigidos (texto DH2 na spec, Novidade, rótulo de `message_missing`, timeout de `waitFor`).
- **Gates completos no estado final, contra `origin/main`, comparados com o fim do Lote G:** back 7080/7110 (30 ignorados), coverage 95,2/87,1, lint/sonar/complexidade sem nada novo nem agravado (o eslint do back precisou de `NODE_OPTIONS=--max-old-space-size=6144`); front 2351/2351, coverage 88,6/82,6, sem nada novo nem agravado.
- **QA local:** migração aplicada no banco de QA (99 destinatários antes e depois, coluna nula, índice criado); boot real do worker com o repetível registrado uma vez em dois boots e um preso semeado trocado para "Falhou: Saiu da fila sem envio" com a hora da conferência preservada; QA visual C1–C5 PASS.
- **Não verificado:** exibição no chat da `Message` `CANCELLED`/`FAILED queue_lost` só por leitura de `chat-status.tsx` ("Cancelada"/"Falhou"), sem Message de equipe no QA local; `@updatedAt` do Prisma em `updateMany` não medido isoladamente (o job vivo protege).
- **Backlog:** T6-m (nome do teste em `release-notes.spec.ts:34`); T5-m (`err.name` no catch de `settleLost`); T8-m3 (`vi.mock` do `sleepFn` duplicado entre os dois specs T08).
- **Próximo passo:** commits, push e PR rascunho sobre `feat/agendamento-reconferencia` (PR #19); depois o plano do Lote I (MSG-02).

## Preparação (principal, antes da T1)

1. Conferir `git merge-base feat/envio-rastreavel feat/agendamento-reconferencia` = `68f9abd` (senão o `--changed` mede o Lote G junto). Em worktree: `backend/.env` fictício e `node_modules` por symlink (memória "gate em worktree").
2. Criar `implementer-rules.md` e `reviewer-rules.md` copiando os do Lote G e adaptando: branch, base `feat/agendamento-reconferencia`, este plano, a spec da Etapa 4, o ledger novo; referências `DHn`, `GHn` e `CHn` anexadas no fim do brief; "o Lote G está pronto no branch; não revisar nem mexer fora do ownership; o Lote I não é deste plano". Riscos do lote no `reviewer-rules.md`: verificador que reenfileira ou reenvia; job vivo (esperando por pacing, atrasado, em andamento) tocado pelo verificador; "Repetir" ou processor perdendo a corrida para o verificador; "Aceito" falso (destinatário `SENT` sem `Message` aceita); timeout virando "Falhou" repetível; `Message` cancelada que estava saindo; hora de conferência gravada sem `open`; nome, telefone ou texto em log ou trilha.
3. Criar o ledger `progress.md` com a referência Git de partida (`68f9abd`) e os arquivos não commitados de fora do lote.

## Decisões deste plano (o que a spec deixa com o construtor)

- **DH1. Uma migração aditiva** `20261120140000_team_recipient_tracking`: `TeamWhatsappRecipient` + `channelCheckedAt DateTime?` (hora da conferência de conexão que liberou a mensagem; `null` = anterior a esta versão, pulado ou falho antes da conferência, ou sem `open`) e `@@index([status, updatedAt])` (consulta do verificador). Nenhum enum muda: `team_whatsapp.queue_lost` e `team_whatsapp.stuck` são `errorCode` (texto livre). Nenhuma linha alterada. **Sem `CONCURRENTLY` (decisão conferida):** `prisma migrate deploy` roda cada migração numa transação e `CREATE INDEX CONCURRENTLY` não roda em transação (mesma conclusão já registrada em `20260819010000_message_one_live_row_per_campaign_contact/migration.sql:145-146` e no cabeçalho de `20261120130000_...`); não há migração do repositório que use `CONCURRENTLY`. Mantém-se o `CREATE INDEX` comum, com `lock_timeout` de 15 s, e o risco (bloqueio de escrita em `TeamWhatsappRecipient` enquanto o índice é criado) vai para a linha "Crítico" da T1 e para o Fechamento (migração fora do horário de envio).
- **DH2. Quando o processor grava e limpa `channelCheckedAt` (H1).** `liveBlock` passa a devolver o `LiveCheck`; com `state = 'open'`, o `checkedAt` vai no mesmo `updateMany` que conta a tentativa (`countAttempt(id, channelCheckedAt)`), imediatamente antes da chamada ao provedor. Todo desfecho gravado **antes da chamada ao provedor na tentativa atual** (pulo ou falha do `precheck`, `FAILED` do `liveBlock` com `close`/`connecting`/`unknown`) grava `channelCheckedAt: null` junto, para que uma conferência de tentativa anterior não apareça num destinatário que não saiu por ela. Desfechos depois do provedor (`settle`) e o `priorOutcome` (a `Message` já gravada decide) não mexem na coluna. Em cache (até 15 s), o `checkedAt` é o da consulta original (contrato da porta): é a hora mostrada. O "Repetir" (`requeueFailed`) não limpa: a próxima tentativa grava ou limpa.
- **DH3. Pulo com `Message` preparada (H3, T9-m1) numa transação nova**, `finishSkipped(prisma, { recipientId, messageId, skipReason })` em `team-recipient-finish.ts`: `$transaction` interativa, nesta ordem: **primeiro a `Message`** (só se há `messageId`: `updateMany` `{ id: messageId, status: 'QUEUED' }` → `CANCELLED`) e **depois o destinatário** (`updateMany` `{ id, status: 'QUEUED' }` → `SKIPPED` + `skipReason` + `channelCheckedAt: null`); se o do destinatário der `count 0` (a linha já não está `QUEUED`), a transação se desfaz (erro sentinela capturado; devolve `{ skipped: false, messageCancelled: false }`) e a `Message` volta a `QUEUED`. Motivo da ordem: uma execução paralela do mesmo job (prevista em `chat.service.ts:303-304`) pode pegar a `Message` entre as duas gravações; cancelar primeiro, com a troca condicional, fecha a janela em que o destinatário ficaria "Pulado" com a mensagem enviada. `count 0` na `Message` (não estava `QUEUED`) não impede o pulo do destinatário. `Message` em qualquer outro estado (`FAILED` reenviável de uma tentativa anterior, `SENDING`) não muda: só `QUEUED` prova que nada saiu e ninguém a está mandando (o claim do chat é `QUEUED|FAILED → SENDING`). O `skipReason` é o tipo do motivo do processor, para o Lote I acrescentar `ACKED` sem mudar a função. `FAILED` antes do provedor com `Message` `QUEUED` (canal inválido, provedor desligado, número desconectado) **não** cancela: o "Repetir" reaproveita a mesma `Message`.
- **DH4. Verificador numa fila repetível nova** `team-whatsapp.stuck-reconciler` (`QUEUE_NAMES.TEAM_WHATSAPP_STUCK_RECONCILER`): `attempts: 1`, `removeOnComplete { age: 3600, count: 12 }`, `removeOnFail { age: 86400 }`; job repetível `repeat: { every: 300_000 }` com `jobId` determinístico `team-whatsapp-stuck-reconciler` e `REPEATABLE_JOB_CLEANUP_OPTS` (padrão de `worker.ts:~295-305`); processor com `concurrency: 1`, registrado **só** no `WorkerModule`. Limiar `STUCK_AFTER_MS = 30 min` sobre `updatedAt`; lote `STUCK_BATCH = 200` por ciclo, por `updatedAt` asc e `id` asc (o resto fica para o ciclo seguinte). Fila separada da do agendado para um ciclo lento não atrasar o disparo do agendado.
- **DH5. "Job não existe mais ou já terminou"** = `queue.getJob(teamSendJobId(id, manualRetries))` devolve `undefined`/`null`, ou `job.getState()` ∈ `completed | failed | unknown`. **Qualquer outro valor devolvido por `getState`** (`waiting`, `delayed`, `active`, `prioritized`, `waiting-children` e qualquer estado que uma versão futura do BullMQ acrescente) conta como vivo → **não toca** (pacing, backoff, em andamento): um estado novo nunca vira perda. Erro ao consultar o Redis → não toca o destinatário naquele ciclo e loga só `recipientId` e o nome do erro. O `manualRetries` é o lido da linha na mesma leitura do candidato. O envio "agora" e o agendado usam `jobId = recipientId` (`enqueueTeamSend`, `service.ts:701-705`), igual a `teamSendJobId(id, 0)`.
- **DH6. Classificação do preso (H2), função pura `stuckOutcome`**, na ordem:
  1. `messageId` nulo → `queue_lost` (destinatário `FAILED` `team_whatsapp.queue_lost`, repetível);
  2. `messageId` gravado e `Message` inexistente → `missing` (`FAILED` `team_whatsapp.message_missing`, não repetível: está em `NOT_REPEATABLE_CODES`);
  3. `Message` `QUEUED` → `queue_lost` com `cancelMessage` (destinatário como no 1; a `Message` vai a `FAILED` com `errorCode = 'team_whatsapp.queue_lost'` e `failedAt = now`, reenviável: o código não está em `TEAM_NEVER_REDISPATCH_CODES` nem termina em `.timeout`, e o claim do chat aceita `FAILED`, então o "Repetir" a reaproveita sem criar outra);
  4. `Message` `SENT | DELIVERED | READ` → `sent` (`SENT`, `acceptedAt = message.sentAt ?? now`);
  5. `Message` `FAILED` com `isRedispatchableFailure(errorCode)` → `failed` com o código da `Message` (repetível pela regra de hoje: `isRepeatable`/`requeueFailed` deixam de fora `NOT_REPEATABLE_CODES` e `*.timeout`);
  6. qualquer outro (`SENDING`, `FAILED` não reenviável — timeout, `evolution.unknown`, `sending_stuck`, sem código —, `CANCELLED`, `WAITING_INSTANCE`, `RECEIVED`, `SKIPPED_*`) → `uncertain` (`UNCERTAIN` `team_whatsapp.stuck`, não repetível: não é `FAILED`).
  É a mesma leitura do `priorOutcome` do processor (`processor.ts:341-357`), com os códigos próprios do verificador. A `Message` presa em `SENDING` há mais de 10 min já vira `FAILED sending_stuck` pelo reconciliador de campanhas (`sending-reconciler.processor.ts`), que cai no ramo 6: continua "Situação incerta".
- **DH7. Troca condicional do preso**, `settle(candidate, outcome, now)` numa `$transaction` interativa: destinatário `updateMany` com `where { id, status: 'QUEUED', messageId: <lido>, manualRetries: <lido>, updatedAt: { lt: now − STUCK_AFTER_MS } }`; `count 0` → perdeu (processor, "Repetir" ou prepare no meio) e nada mais acontece. No ramo `queue_lost` com `cancelMessage`, na mesma transação, `message.updateMany({ id: messageId, status: 'QUEUED' })` → `FAILED queue_lost`; `count 0` (a `Message` saiu de `QUEUED` depois da leitura) → a transação se desfaz (erro sentinela capturado) e o destinatário fica para o próximo ciclo. O verificador **nunca** chama `add`/`addBulk` nem toca `attempts`, `manualRetries` ou `channelCheckedAt`.
- **DH8. Trilha `team_whatsapp.stuck_reconciled`**, uma por envio com algum destinatário trocado no ciclo, no padrão de `team_whatsapp.scheduled_fire` (`team-whatsapp-schedule.service.ts:99-108`: `audit.log(ação, 'TeamWhatsappDispatch', dispatchId, payload)`): `{ dispatchId, queueLost, missing, sent, failed, uncertain }`. Sem nome, telefone, texto nem `recipientId` na trilha. Log do ciclo só com contagens.
- **DH9. API de destinatários** (`GET dispatches/:id/recipients`): item + `channelCheckedAt: string | null` (ISO) e `manualRetries: number`, **obrigatórios** no contrato do back (a T2 preenche os dois). O front os lê como `channelCheckedAt: .nullish()` e `manualRetries: .default(0)`, para não quebrar fixtures e tolerar API antiga.
- **DH10. Tela (H1, H4).** Ordem das colunas: Nome, Telefone usado, Situação, **Quando**, Número, Tentativas, Motivo, Ações. "Quando" = `acceptedAt` em `SENT`, `deliveredAt` em `DELIVERED`, `readAt` em `READ`, `repliedAt` em `REPLIED`, formato `dd/mm HH:mm` em America/Manaus; "—" em qualquer outro estado ou com a hora nula. "Número": `channelLabel(channel)` e, com `channelCheckedAt`, uma segunda linha menor "conexão conferida às HH:mm:ss" (Manaus); sem ela, só o número. "Tentativas": `attempts > 0 ? attempts : '—'` e, com `manualRetries > 0`, ` · repetido {n}×` (ex.: "2 · repetido 1×"; "— · repetido 1×" quando a repetição ainda não chegou ao provedor). Rótulo de falha `team_whatsapp.queue_lost` → "Saiu da fila sem envio" (a tela mostra "Falhou: Saiu da fila sem envio", na capitalização dos rótulos de hoje); `team_whatsapp.stuck` é `UNCERTAIN` e já mostra a explicação fixa da situação incerta.
- **DH11. Suíte T08 (H6): o que é real e o que é falso.** Reais: Postgres do testcontainer, `TeamWhatsappService`/`TeamAudienceService` (cenário 1, pelo `deps` dos fixtures de serviço), `TeamWhatsappRepository`, `TeamWhatsappRetryService`, `TeamWhatsappSendProcessor`, `ChatService` + `ChatRepository` (Message de verdade, claim de verdade), `TeamRecipientTrackingService`, o verificador (T4/T5). Falsos: a **porta do provedor** = `WhatsappProvidersService` injetado no `ChatService` (anota cada chamada; responde aceito, erro de número desconectado ou timeout) e a **porta ao vivo** `ChannelLiveStateService.check` (estado controlado por cenário, com `checkedAt`); fila em memória que imita o BullMQ no que importa (`addBulk` ignora `jobId` repetido, `attempts: 3` com reexecução enquanto o processor lança, `getJob`/`getState`; cada job precisa de `job.opts.attempts = 3` e `attemptsMade`, que `isLastAttempt` lê em `team-whatsapp-send.processor.ts:433-435`); Redis falso para o pacing; `ConsentService` e `AuditService` falsos. O recibo (cenário 4) entra por `TeamRecipientTrackingService.applyReceipt` + a atualização da `Message` como o webhook faz (o dedupe Redis do webhook já tem teste próprio).
- **DH12. Corrida "dois Repetir ao mesmo tempo" (cenário 5)** = duas chamadas de `TeamWhatsappRetryService.retry` com `Promise.all` sobre o mesmo envio: o `UPDATE ... RETURNING` atômico de `requeueFailed` devolve as linhas a só uma delas; a fila recebe um job por pessoa; o provedor, uma chamada por pessoa.
- **DH13. `updatedAt` do claim do agendado explícito.** O claim do agendado (`team-whatsapp.repository.ts`, `updateMany` `SCHEDULED → QUEUED` em ~L1438-1441, função privada `queueActive(tx, dispatchId)` em ~L1421, chamada só por `claimScheduled` em ~L991; `claimScheduled(id, now, recheck?)` NÃO muda de assinatura: só a chamada em ~L991 passa `now` como 3º parâmetro de `queueActive`) passa a gravar `updatedAt: now` (o `now` do disparo) no `data`, em vez de depender do `@updatedAt` do Prisma em `updateMany`; o `now` é propagado dos chamadores no mesmo arquivo (até 4 parâmetros, GH6). Motivo: o destinatário agendado tem `updatedAt` antigo (da criação) e o verificador de presos (DH4, limiar de 30 min sobre `updatedAt`) não pode ver um agendado recém-disparado como antigo e marcá-lo "saiu da fila" entre a gravação do `QUEUED` e o `addBulk`. **Dona: T3** (onda 2; o arquivo já passa por T3 e T2, em ondas diferentes, sem edição concorrente). O "Repetir" não tem esse risco (`requeueFailed` já grava `"updatedAt" = now()`); a troca do verificador também renova `updatedAt` (teste na T4).

## Global Constraints

- **GH1. Escopo:** back só `backend/src/modules/team-whatsapp/`, `backend/src/modules/queue/queue.constants.ts`, `backend/src/modules/queue/queue.module.ts`, `backend/src/worker.ts`, `backend/src/worker.module.ts`, `backend/src/worker.stuck-reconciler.di.spec.ts` (novo), `backend/src/schemas/contracts/team-whatsapp.schema.ts`, `backend/prisma/`; front só `frontend/src/features/team-whatsapp/` e `frontend/src/release-notes.ts`. **Não mudam:** `chat.service.ts`, webhooks, `channel-live-state.service.ts`, `sending-reconciler.processor.ts` (campanhas), o adaptador da Evolution. Nenhuma chamada nova ao provedor (spec Restrições: "nenhuma chamada nova ao provedor além das que já existem"). Nada do Lote I (ciência, prazo, lembrete, `ACKED`, `parentRecipientId`, `equipe.urgencia`).
- **GH2. Nunca reenviar sozinho (spec Anti-objetivos):** "Um timeout ou um job perdido ser reenviado sozinho" é falha. O verificador nunca enfileira, nunca chama o chat nem o provedor; só o "Repetir" (ação de quem envia) põe de volta na fila.
- **GH3. Dado pessoal (spec Restrições):** "trilhas (`AuditService`) levam ids e contagens". Nome, telefone e texto nunca em log, erro lançado, `failedReason` do BullMQ ou trilha. Logs do verificador e do processor: só `recipientId`, `dispatchId`, `errorCode` e contagens.
- **GH4. Validação:** cwd `backend/` ou `frontend/`. Loop `timeout 600 gate --test src/<arquivo>`; integração `TESTCONTAINERS_ENABLED=1 timeout 600 gate --test src/<arquivo>`. Tipos: back `npx tsc --noEmit -p tsconfig.build.json --tsBuildInfoFile /tmp/<task>.tsbuildinfo`; front `npx tsc -b`. Fechamento: back `TESTCONTAINERS_ENABLED=1 timeout 600 gate --changed --base feat/agendamento-reconferencia`; front `timeout 600 gate --changed --base feat/agendamento-reconferencia`. Nunca suíte inteira, gate completo, coverage ou e2e (são da principal). No máximo dois testcontainers ao mesmo tempo (a principal serializa).
- **GH5. Tempo nos testes:** o verificador recebe `now` explícito (`reconcile(now)`, `findCandidates(now)`, `settle(..., now)`); `updatedAt` das fixtures gravado por SQL cru (`UPDATE "TeamWhatsappRecipient" SET "updatedAt" = $1`), porque o `@updatedAt` do Prisma sobrescreve; nada de `vi.setSystemTime` com linha gravada pelo banco (memória "relógio falso × createdAt"). Telefones e nomes fictícios (`+5592991110001`, "Pessoa A").
- **GH6. Tamanho e legado:** funções e callbacks de `describe`/`it` até 50 linhas, complexidade 10, até 4 parâmetros; `describe` novos em arquivo novo (o que existe não cresce); conferir com `npx eslint <arquivos> --rule '{"max-lines-per-function": ["error", 50], "max-params": ["error", 4], "complexity": ["error", 10], "max-depth": ["error", 4]}'`. `prettier --write` só em arquivo novo; nunca restaurar arquivo do git. `team-whatsapp.repository.ts`, `team-whatsapp-send.processor.ts` e `worker.ts` só recebem o que a task diz; lógica nova em arquivo novo.
- **GH7. Migração:** só aditiva, SQL escrito à mão com o cabeçalho do G (`backend/prisma/migrations/20261120130000_team_dispatch_schedule_recheck/migration.sql`: comentário do que faz e do lock, `SET LOCAL lock_timeout = '15s';`, DDL igual ao que `prisma migrate diff` gera); nome posterior a `20261120130000`; nunca `prisma migrate dev`/`reset` contra banco real; banco só o do testcontainer.
- **GH8. Compila entre tasks:** assinatura existente só ganha parâmetro/campo opcional, salvo onde a task diz e ajusta chamadores e specs no próprio ownership. Sem commit.
- **GH9. Nunca WhatsApp real:** porta do provedor e porta ao vivo falsas em todo teste; o verificador e a suíte T08 são provados por integração, não por QA visual.

## Contratos compartilhados

**CH1. Prisma** (T1): DH1.

```prisma
// TeamWhatsappRecipient
// Hora da conferência de conexão (estado `open`) que liberou a mensagem (H1); null = anterior a esta
// versão, pulado/falho antes da conferência ou sem `open`.
channelCheckedAt DateTime?
@@index([status, updatedAt])   // verificador de presos (H2)
```

**CH2. API de destinatários** (`backend/src/schemas/contracts/team-whatsapp.schema.ts`, `teamDispatchRecipientPageSchema` ~L490; T2).

```ts
// item += 
channelCheckedAt: z.string().nullable(),   // ISO; H1
manualRetries: countSchema,                // H4: repetições pedidas na tela
// front (schemas.ts, T6): channelCheckedAt: z.string().nullish(); manualRetries: z.number().int().nonnegative().default(0)
```

**CH3. Processor** (T3, `team-whatsapp-send.processor.ts` e `team-whatsapp.repository.ts`).

```ts
// repository: countAttempt(recipientId: string, channelCheckedAt?: Date): Promise<void>
//   data = { attempts: { increment: 1 }, ...(channelCheckedAt ? { channelCheckedAt } : {}) }; where { id, status: 'QUEUED' } (igual a hoje)
// processor (privado): liveBlock(job, channel): Promise<{ blocked: FailedData } | { checkedAt: Date }>
// FinishData dos desfechos antes do provedor leva channelCheckedAt: null (DH2)
// team-recipient-finish.ts (novo):
export type SkipReasonOf = 'NO_PHONE' | 'PHONE_CHANGED' | 'SUPPRESSED' | 'NOT_AUTHORIZED';  // o Lote I acrescenta ACKED
export async function finishSkipped(
  prisma: Pick<PrismaService, '$transaction'>,
  input: { recipientId: string; messageId: string | null; skipReason: SkipReasonOf },
): Promise<{ skipped: boolean; messageCancelled: boolean }>;
```

**CH4. Verificador** (T4 puro e repositório; T5 serviço, fila e worker).

```ts
// stuck-recipients.ts (puro)
export const STUCK_AFTER_MS = 30 * 60 * 1000;
export const STUCK_BATCH = 200;
export const QUEUE_LOST_CODE = 'team_whatsapp.queue_lost';
export const STUCK_CODE = 'team_whatsapp.stuck';
export type StuckCandidate = { id: string; dispatchId: string; messageId: string | null; manualRetries: number };
export type StuckMessage = { status: MessageStatus; errorCode: string | null; sentAt: Date | null } | null; // null = apagada
export type StuckOutcome =
  | { kind: 'queueLost'; cancelMessage: boolean }
  | { kind: 'missing' }
  | { kind: 'sent'; acceptedAt: Date }
  | { kind: 'failed'; errorCode: string }
  | { kind: 'uncertain' };
export function stuckOutcome(input: { messageId: string | null; message: StuckMessage; now: Date;
  redispatchable: (code: string | null) => boolean }): StuckOutcome;   // DH6
export function recipientDataOf(outcome: StuckOutcome): Prisma.TeamWhatsappRecipientUpdateManyMutationInput;

// team-stuck-recipients.repository.ts (novo, @Injectable)
findCandidates(now: Date, limit?: number): Promise<StuckCandidate[]>;      // QUEUED, updatedAt < now − STUCK_AFTER_MS, updatedAt asc, id asc
loadMessage(messageId: string): Promise<StuckMessage>;                   // select status, errorCode, sentAt
settle(c: StuckCandidate, outcome: StuckOutcome, now: Date): Promise<boolean>;   // DH7; true = trocou

// team-stuck-reconciler.service.ts (novo, @Injectable)
export type StuckCounts = { queueLost: number; missing: number; sent: number; failed: number; uncertain: number };
reconcile(now: Date): Promise<{ checked: number; alive: number; lost: number; counts: StuckCounts }>;
// queue.constants.ts: QUEUE_NAMES.TEAM_WHATSAPP_STUCK_RECONCILER = 'team-whatsapp.stuck-reconciler'
```

**CH5. Front** (T6). `recipientWhen(item): string | null` (DH10, ISO da hora do estado ou null); `attemptsText(attempts, manualRetries): string`; `failureReasonLabel('team_whatsapp.queue_lost') = 'Saiu da fila sem envio'`; texto da conferência `conexão conferida às HH:mm:ss`.

## Review Focus

1. **Reenvio automático ou job vivo tocado (GH2, H2):** T5 `nunca chama add nem addBulk`; `job waiting, delayed, active ou prioritized: não toca`; `erro ao consultar o job: não toca`; T8 cenário 6 `nada é reenviado sozinho`.
2. **Corrida do verificador:** T4 `Repetir entre a leitura e a troca vence`; `processor que termina entre a leitura e a troca vence`; `messageId gravado depois da leitura vence`; `Message que saiu de QUEUED depois da leitura: nada muda e o destinatário segue QUEUED`.
3. **"Aceito" falso ou timeout repetível:** T4 os seis ramos de DH6; T7 cenários 2 e 3.
4. **`Message` cancelada que podia sair (H3):** T3 `Message SENDING ou FAILED não é cancelada no pulo`; `pulo que perde a troca (linha já não QUEUED) desfaz a transação e não cancela a Message`; ordem Message-primeiro (DH3).
5. **Hora de conferência mentirosa (H1):** T3 `close, connecting e unknown não gravam hora`; `pulo e falha antes do provedor limpam a hora de tentativa anterior`.
6. **Dado pessoal:** T5 `trilha stuck_reconciled só com dispatchId e contagens`; T3 nenhum log novo com telefone.
7. **Agendado recém-disparado visto como antigo (DH13):** T3 `claim do agendado grava updatedAt com o now do disparo`; T4 `settle renova updatedAt`.

## Rastreio (aceite → task → teste)

| Aceite / item | Task | Teste |
|---|---|---|
| 1 (T08, cenário 9) | T7, T8 | as duas suítes T08 inteiras com banco real |
| 2 | T3, T6, T7 | T3 `open grava channelCheckedAt = checkedAt na contagem da tentativa`; `pulado antes da conferência: channelCheckedAt nulo`; `close: FAILED channel_disconnected sem hora`; T6 `Número com conexão conferida às HH:mm:ss; sem hora só o número`; T7 `cenário 2: enviados com hora, falhos sem hora` |
| 3 | T4, T5, T8 | T4 ramos `queueLost`, `sent`, `uncertain` e corrida com "Repetir"; T5 `job esperando há mais de 30 min não muda`; T8 `cenário 6` (Repetir manda uma vez, sem segunda `Message`; `SENDING` fora do Repetir) |
| 4 | T3 | `aceite 4: pulado na 2ª tentativa depois de a 1ª preparar — Message CANCELLED` (1ª tentativa deixa a `Message` `QUEUED`: `sendTeamMessage` do falso lança antes de marcá-la); par `Message FAILED por falha do provedor não é cancelada` |
| 5 | T2, T6 | T2 `item traz manualRetries e channelCheckedAt`; T6 `Quando com a hora do estado`; `Tentativas 2 · repetido 1×` |
| 21 | T4, T8 | T4 `Message FAILED reenviável — FAILED com o código dela`; `Message QUEUED vira FAILED queue_lost na mesma transação`; T8 `cenário 6: falha certa entra no Repetir; Message do nada saiu não fica na fila` |
| H1 | T1, T2, T3, T6 | aceite 2 |
| H2 | T1 (índice), T4, T5, T8 | aceites 3, 21; trilha (Review Focus 6) |
| H3 / backlog T9-m1 do G | T3 | aceite 4; T3 `Message cancelada antes do destinatário; destinatário count 0 desfaz a transação` (DH3) |
| DH7 (verificador não toca `channelCheckedAt`) | T8 | `cenário 6: o verificador preserva a hora da conferência (channelCheckedAt)` |
| DH13 (`updatedAt` do claim do agendado) | T3, T4 | T3 `claim do agendado grava updatedAt com o now do disparo`; T4 `settle renova updatedAt` |
| H4 | T2, T6 | aceite 5; T6 `Quando — nos estados sem hora` |
| H5 | — | nada a implementar; segue em "Para a GBR confirmar" (Fechamento) |
| H6 | T7, T8 | cenários 1–3 (T7), 4–6 (T8) |
| DH5 ("terminou") | T5 | `job completed, failed ou unknown conta como perdido; job ausente também`; `estado fora da lista conta como vivo` |
| T5 no `WorkerModule` | T5 | `worker.stuck-reconciler.di.spec.ts`: o módulo resolve o processor e o serviço novos |
| DH8 trilha | T5 | `uma trilha por envio, só com contagens` |

## Mapa de arquivos

- Criar (back, `backend/src/modules/team-whatsapp/`): `team-recipient-finish.ts` (T3), `stuck-recipients.ts` (T4), `team-stuck-recipients.repository.ts` (T4), `team-stuck-reconciler.service.ts` (T5), `team-whatsapp-stuck.processor.ts` (T5), specs: `team-recipient-finish.spec.ts`, `team-whatsapp-send.processor.tracking.spec.ts`, `team-whatsapp.send-tracking.integration.spec.ts`, `team-whatsapp.claim-updated-at.integration.spec.ts` (T3); `stuck-recipients.spec.ts`, `team-stuck-recipients.integration.spec.ts` (T4); `team-stuck-reconciler.service.spec.ts`, `team-whatsapp-stuck.processor.spec.ts` (T5) e `backend/src/worker.stuck-reconciler.di.spec.ts` (T5); `team-whatsapp.schema.tracking.spec.ts` em `backend/src/schemas/contracts/` (T2); `team-whatsapp.t08.test-fixtures.ts`, `team-whatsapp.t08.integration.spec.ts` (T7); `team-whatsapp.t08-stuck.integration.spec.ts` (T8); `team-recipient-tracking.migration.integration.spec.ts` (T1). Migração `backend/prisma/migrations/20261120140000_team_recipient_tracking/migration.sql`.
- Modificar (back): `backend/prisma/schema.prisma`; `schemas/contracts/team-whatsapp.schema.ts`; `team-whatsapp.repository.ts` (`countAttempt` e o claim do agendado, DH13, na T3; `recipientRowSelect`/`DispatchRecipientRow`/mapeamento na T2); `team-whatsapp-results.service.ts`; `team-whatsapp-send.processor.ts`; `backend/src/modules/queue/queue.constants.ts`, `queue.module.ts`; `backend/src/worker.ts`, `backend/src/worker.module.ts`; fábricas de `DispatchRecipientRow` em `team-whatsapp-results.service.spec.ts`, `team-whatsapp-results.service.search.spec.ts`, `team-whatsapp.name-view.spec.ts` (T2, só os campos novos).
- Modificar (front, `frontend/src/features/team-whatsapp/`): `schemas.ts`, `error-messages.ts`, `components/recipient-table.tsx`; criar `recipient-tracking.ts` (helpers de CH5) e specs `recipient-tracking.spec.ts`, `components/recipient-table.tracking.spec.tsx`; `frontend/src/release-notes.ts`.

## Ordem e paralelismo

```
Onda 1:  T1 (migração)   T4 (verificador: classificação e troca condicional)   T6 (front: tabela, rótulos, Novidades)
Onda 2:  T3 (processor: hora da conferência e pulo que cancela) <- T1    T5 (verificador: serviço, fila, worker) <- T4
Onda 3:  T2 (contrato e API de destinatários) <- T1, T3    T7 (T08, cenários 1–3, e fixtures) <- T3
Onda 4:  T8 (T08, cenários 4–6) <- T4, T5, T7
```

- **Ownership disjunto por onda:** Onda 1 — T1: `prisma/schema.prisma`, pasta da migração, `team-recipient-tracking.migration.integration.spec.ts`; T4: `stuck-recipients.ts`, `team-stuck-recipients.repository.ts` e specs; T6: `schemas.ts`, `error-messages.ts`, `recipient-tracking.ts` (novo), `components/recipient-table.tsx`, `release-notes.ts` e specs. Onda 2 — T3: `team-whatsapp-send.processor.ts`, `team-recipient-finish.ts` (novo), em `team-whatsapp.repository.ts` **só** `countAttempt` e o `updateMany` `SCHEDULED → QUEUED` do claim do agendado (`updatedAt: now`, DH13, com o `now` propagado dos chamadores no mesmo arquivo), specs novos e, no `team-whatsapp-send.processor.spec.ts` existente, só as asserções de `countAttempt`/`liveBlock` que a mudança de assinatura quebrar (listar no report); T5: `team-stuck-reconciler.service.ts`, `team-whatsapp-stuck.processor.ts`, `queue.constants.ts`, `queue.module.ts`, `worker.ts`, `worker.module.ts`, specs e o `worker.stuck-reconciler.di.spec.ts` novo. Onda 3 — T2: `schemas/contracts/team-whatsapp.schema.ts` (+ spec novo), em `team-whatsapp.repository.ts` **só** `recipientRowSelect`, `DispatchRecipientRow` e o mapeamento (~L216, ~L422-460), `team-whatsapp-results.service.ts` (`toRecipientItem`), as três fábricas de `DispatchRecipientRow`; T7: `team-whatsapp.t08.test-fixtures.ts`, `team-whatsapp.t08.integration.spec.ts`. Onda 4 — T8: `team-whatsapp.t08-stuck.integration.spec.ts` (e só acréscimos ao fixture da T7, listados no report).
- **Por que T2 depois de T3:** as duas mexem em `team-whatsapp.repository.ts` (T3 em `countAttempt` e no claim do agendado, T2 no select de destinatários); em ondas diferentes não há edição concorrente no mesmo arquivo. A T4 não toca esse arquivo.
- **T4 na Onda 1 com a T1:** a integração da T4 aplica todas as migrações no testcontainer; se a pasta da T1 estiver pela metade, a falha é de arquivo alheio: registrar no report e rodar de novo quando a T1 entrar. A T4 não usa a coluna nova: nenhum teste dela lê nem grava `channelCheckedAt` (compila sem o client da T1; o índice só acelera). A preservação da hora da conferência pelo verificador é provada na T8 (onda 4, depois da T1).
- **T6 na Onda 1:** o front espelha CH2 com campos tolerantes (DH9); não depende do back no código.
- **Compila entre tasks (GH8):** T1 só acrescenta coluna nula (nenhum chamador quebra); T3 deixa o parâmetro novo de `countAttempt` opcional; T4 e T5 só criam arquivos e registram fila nova; T2 torna os campos obrigatórios no contrato do back e ajusta, na mesma task, o `toRecipientItem` e as três fábricas de teste.
- **Gate conjunto:** com tasks paralelas, o `--changed` de uma mede o diff das outras; falha só de arquivo alheio vai para o report. A principal roda o `--changed` conjunto (back e front) e o `tsc` do back depois de cada onda.
- **Revisão** (SKILL.md do sdd, §Revisão por risco): `opus` em T1, T2, T3, T4, T5 (linha "Crítico") e T6 (`fronteira`); `sonnet` em T7 e T8 (só teste). Total **8 tasks** (7 altas — T1 a T5 com linha "Crítico", T7 e T8 só de teste — e 1 média, T6 `fronteira`) em 4 ondas.

---

## Task 1 — Migração: hora da conferência e índice do verificador (back)

**Arquivos:** modificar `backend/prisma/schema.prisma` (`model TeamWhatsappRecipient`, ~L1859-1904); criar `backend/prisma/migrations/20261120140000_team_recipient_tracking/migration.sql` e `backend/src/modules/team-whatsapp/team-recipient-tracking.migration.integration.spec.ts`.

**Interfaces:** consome o modelo `TeamWhatsappRecipient`. Produz CH1 e o client gerado.

**Contexto vinculado:**
- DH1: `TeamWhatsappRecipient` + `channelCheckedAt DateTime?` com o comentário de CH1 (o que é; quando é `null`), logo abaixo do bloco "Rastreio (D5/D11)"; `@@index([status, updatedAt])`. Nenhum enum muda (`team_whatsapp.queue_lost` e `team_whatsapp.stuck` são `errorCode`, texto).
- GH7: só aditiva; SQL à mão com o cabeçalho de `20261120130000_team_dispatch_schedule_recheck/migration.sql` adaptado: comentário do que faz ("uma coluna nula em TeamWhatsappRecipient e um índice; nenhuma linha alterada; destinatário anterior fica com a coluna nula"), o parágrafo do `ADD COLUMN` (ACCESS EXCLUSIVE curto, coluna nula sem default não reescreve a tabela), o do `CREATE INDEX` sem `CONCURRENTLY` (bloqueia escrita em "TeamWhatsappRecipient" enquanto cria; a tabela tem uma linha por pessoa por envio, maior que a de envios: estimar o tamanho no banco de QA no Fechamento), o do `lock_timeout` e do `migrate resolve --rolled-back`, e `SET LOCAL lock_timeout = '15s';`. DDL igual ao `prisma migrate diff` (nome do índice `TeamWhatsappRecipient_status_updatedAt_idx`).
- Nunca `prisma migrate dev`/`reset`; banco só o do testcontainer.

**Passos:**
1. [ ] RED (padrão de `team-dispatch-schedule.migration.integration.spec.ts`): `it('destinatário anterior fica com channelCheckedAt nulo')`; `it('channelCheckedAt não é obrigatório e aceita data')`; `it('índice de status e updatedAt existe')` (consulta `pg_indexes`).
2. [ ] GREEN: schema e SQL.
3. [ ] `npx prisma generate`; `npx prisma validate`; teste de integração; typecheck; `--changed`.

**Aceite:** base de 2 e 3. **Risco: alto** (migração não destrutiva).
**Crítico: migração — acrescenta uma coluna nula e um índice em `TeamWhatsappRecipient`, sem tocar linha existente; o `CREATE INDEX` sem `CONCURRENTLY` (não roda na transação do `migrate deploy`, DH1) bloqueia escrita nessa tabela enquanto o índice é criado.**

## Task 2 — Contrato e API de destinatários: `channelCheckedAt` e `manualRetries` (back)

**Arquivos:** modificar `backend/src/schemas/contracts/team-whatsapp.schema.ts` (só o item de `teamDispatchRecipientPageSchema`, ~L490-515; nunca `prettier --write`, é legado); criar `backend/src/schemas/contracts/team-whatsapp.schema.tracking.spec.ts`; em `backend/src/modules/team-whatsapp/team-whatsapp.repository.ts` **só** `DispatchRecipientRow` (~L216), `recipientRowSelect` (~L422-436) e o mapeamento (~L455); `team-whatsapp-results.service.ts` (`toRecipientItem`, ~L141-163); nas fábricas de `DispatchRecipientRow` de `team-whatsapp-results.service.spec.ts` (~L65), `team-whatsapp-results.service.search.spec.ts` (~L57) e `team-whatsapp.name-view.spec.ts` (~L289), só os dois campos novos com valor padrão (`channelCheckedAt: null`, `manualRetries: 0`); `describe` novo em arquivo novo `team-whatsapp-results.service.tracking.spec.ts`.

**Interfaces:** consome T1 (client com `channelCheckedAt`) e T3 (já integrada: `countAttempt` mudou no mesmo arquivo). Produz CH2.

**Contexto vinculado:**
- DH9: item + `channelCheckedAt: z.string().nullable()` (ISO, pelo `iso()` de `results.service.ts:130`) e `manualRetries: countSchema`, obrigatórios; comentário no contrato: "channelCheckedAt = hora da conferência de conexão (`open`) que liberou a mensagem (H1); null = sem conferência. manualRetries = repetições pedidas na tela (H4)".
- H4 da spec: "A coluna 'Tentativas' mostra também as repetições manuais: '2 · repetido 1×'. A API passa a devolver `manualRetries`." "O resultado continua sem total e sem exportação."
- C2 da spec: a visibilidade não muda (ADMIN vê todos; os demais, só os próprios); os campos novos não são dado pessoal.
- GH6: a mudança no repositório é só o select, o tipo e o mapeamento; `countAttempt` é da T3 (onda anterior), não mexer.
- `listAllDispatchRecipients` (busca por nome, DG13 do G) usa o mesmo `recipientRowSelect`: os campos novos aparecem também com `q`.

**Passos:**
1. [ ] RED: em `team-whatsapp.schema.tracking.spec.ts`, `it('item de destinatário exige channelCheckedAt (nulo ou ISO) e manualRetries')`; em `team-whatsapp-results.service.tracking.spec.ts`, `it('item traz manualRetries e channelCheckedAt em ISO')`, `it('channelCheckedAt nulo vira null')`, `it('busca por nome também devolve os campos novos')`.
2. [ ] GREEN; typecheck (as três fábricas compilam); validação; `--changed`.

**Aceite:** 5 (contrato), 2 (contrato). **Risco: alto** (contrato público).
**Crítico: contrato público de API — `GET dispatches/:id/recipients` ganha `channelCheckedAt` e `manualRetries`, consumidos pela tabela do front.**

## Task 3 — Processor: hora da conferência (H1) e pulo que cancela a mensagem preparada (H3) (back)

**Arquivos:** modificar `backend/src/modules/team-whatsapp/team-whatsapp-send.processor.ts` (`FinishData`/`FailedData` ~L69-81, `deliver` ~L186-200, `sendPaced` ~L202-228, `liveBlock` ~L248-259, `finishFailed`, `finish` ~L425); em `team-whatsapp.repository.ts` **só** `countAttempt` (~L1027-1032) e o `updateMany` `SCHEDULED → QUEUED` do claim do agendado (~L1438-1441, DH13); criar `team-recipient-finish.ts`, `team-recipient-finish.spec.ts`, `team-whatsapp-send.processor.tracking.spec.ts`, `team-whatsapp.send-tracking.integration.spec.ts` e `team-whatsapp.claim-updated-at.integration.spec.ts`; no `team-whatsapp-send.processor.spec.ts` existente, só as asserções que a assinatura nova de `countAttempt`/o retorno de `liveBlock` quebrar (listar no report).

**Interfaces:** consome T1 (client com `channelCheckedAt`), `LiveCheck` de `channel-live-state.service.ts:13-18` (`{ channelId, state, checkedAt }`). Produz CH3.

**Contexto vinculado:**
- H1 da spec: "Ao mandar cada mensagem, o processor grava no destinatário a hora da conferência de conexão que liberou aquela mensagem (`channelCheckedAt`, o `checkedAt` da porta ao vivo), **só quando o estado conferido foi `open`**." "Destinatário anterior a esta versão, pulado antes da conferência ou que falhou com o número desconectado ou sem conferência mostra só o número."
- DH2 inteiro: `liveBlock` devolve `{ blocked }` ou `{ checkedAt }`; com `open`, `this.repo.countAttempt(r.id, checkedAt)` (mesmo `updateMany` da contagem, antes de `chat.sendTeamMessage`); desfechos antes do provedor na tentativa atual (`precheck` com `SKIPPED`/`FAILED`, `liveBlock` com `FAILED`) gravam `channelCheckedAt: null` junto; `settle` e `priorOutcome` não mexem na coluna; o "Repetir" não limpa. `unknown` que relança (`channel_unverified` antes da última tentativa) não grava nada (comportamento de hoje).
- H3 da spec: "Quando uma tentativa posterior pula o destinatário (telefone mudou, sem telefone, bloqueado, sem autorização) depois de uma tentativa anterior ter preparado a `Message`, essa `Message` passa de `QUEUED` para `CANCELLED` na mesma gravação. Nada mais muda no chat."
- DH13: o claim do agendado (`updateMany` `SCHEDULED → QUEUED`, ~L1438-1441) grava `updatedAt: now` (o `now` do disparo) explicitamente, para o verificador de presos (limiar de 30 min sobre `updatedAt`) não ver um agendado recém-disparado como antigo; propagar o `now` dos chamadores no mesmo arquivo (até 4 parâmetros).
- DH3 inteiro: `finishSkipped` em `team-recipient-finish.ts` (transação interativa; **primeiro a `Message`** `QUEUED` → `CANCELLED` (só se há `messageId`), **depois o destinatário** condicional a `QUEUED`; destinatário com `count 0` desfaz a transação, e a `Message` volta a `QUEUED`; `count 0` na `Message` não impede o pulo); motivo da ordem: execução paralela do mesmo job (`chat.service.ts:303-304`) não pode pegar a `Message` entre as duas gravações; `Message` `FAILED`/`SENDING` não muda; `FAILED` antes do provedor não cancela (o "Repetir" reaproveita). `deliver` passa a chamar `finishSkipped` quando `pre.data.status === 'SKIPPED'` (com `r.messageId`, nulo ou não); os demais desfechos seguem pelo `finish` de hoje. O tipo do motivo fica aberto para o Lote I acrescentar `ACKED`.
- Ordem de hoje do `deliver` (não muda): `priorOutcome` da `Message` gravada vem **antes** do `precheck` — `Message` `QUEUED` ou `FAILED` reenviável devolve `null` e cai no `precheck`; é aí que o pulo encontra a `Message` preparada.
- GH3: nenhum log novo com telefone (o `resolveSendPhone` de hoje não loga; manter). GH6: o `processor.ts` só recebe a troca de chamadas; a transação mora no arquivo novo.

**Passos:**
1. [ ] RED unidade (`team-recipient-finish.spec.ts`, prisma falso com `$transaction` que registra a ordem das chamadas): `it('cancela a Message QUEUED antes de pular o destinatário, na mesma transação')`; `it('linha que já não está QUEUED: a transação se desfaz e a Message não é cancelada')` (destinatário `count 0` → erro sentinela, `{ skipped: false, messageCancelled: false }`); `it('Message que já não está QUEUED (count 0): o destinatário ainda é pulado')`; `it('sem messageId: só o pulo')`.
2. [ ] RED unidade (`team-whatsapp-send.processor.tracking.spec.ts`): `it('open grava channelCheckedAt = checkedAt na contagem da tentativa, antes do provedor')` (ordem: `countAttempt(id, checkedAt)` antes de `sendTeamMessage`); `it('close e connecting: FAILED channel_disconnected com channelCheckedAt nulo, sem contar tentativa')`; `it('unknown na última tentativa: FAILED channel_unverified sem hora')`; `it('pulado no precheck: channelCheckedAt nulo, sem consultar a porta ao vivo')`; `it('priorOutcome SENT não mexe em channelCheckedAt')`; `it('PHONE_CHANGED com messageId chama finishSkipped com o messageId')`.
3. [ ] RED integração (`team-whatsapp.send-tracking.integration.spec.ts`, banco real, porta ao vivo e chat falsos como em `team-whatsapp.phone-frozen.integration.spec.ts:183-200`; `Message` semeada por `prisma.message.create` com os campos mínimos): `it('aceite 4: pulado na 2ª tentativa depois de a 1ª preparar — Message CANCELLED')` (a 1ª tentativa deixa a `Message` `QUEUED`: o chat real prepara, e o `sendTeamMessage` do falso lança antes de marcar a `Message` `SENDING`, como numa queda do worker entre preparar e enviar; troca o telefone; 2ª tentativa → `SKIPPED PHONE_CHANGED`, `Message` `CANCELLED`, uma `Message` só); `it('Message SENDING ou FAILED não é cancelada no pulo')` (par do aceite 4: a 1ª tentativa chega ao provedor, que falha com erro reenviável e deixa a `Message` `FAILED`; no pulo seguinte ela continua `FAILED` e o destinatário vai a `SKIPPED`; e `Message` `SENDING` semeada continua `SENDING`); `it('aceite 2: enviado grava a hora da conferência; pulado antes da conferência fica sem hora')`; `it('falha de tentativa anterior com hora, repetida com o número desconectado: hora apagada')`.
4. [ ] RED integração em arquivo novo (`team-whatsapp.claim-updated-at.integration.spec.ts`, banco real, DH13): `it('claim do agendado grava updatedAt com o now do disparo')` (destinatário `SCHEDULED` com `updatedAt` antigo por SQL cru, GH5; dispara o claim com um `now` fixo; o destinatário fica `QUEUED` com `updatedAt` exatamente igual ao `now`, não à hora real do banco).
5. [ ] GREEN; typecheck; eslint dos arquivos (GH6); validação; `--changed`.

**Aceite:** 2, 4. **Risco: alto** (o que sai e o que o chat mostra).
**Crítico: transação com risco de perda de dados — pulo do destinatário e cancelamento da `Message` numa transação condicional; uma condição errada cancelaria mensagem que está saindo.**

## Task 4 — Verificador de presos: classificação e troca condicional (back)

**Arquivos:** criar `backend/src/modules/team-whatsapp/stuck-recipients.ts`, `stuck-recipients.spec.ts`, `team-stuck-recipients.repository.ts` e `team-stuck-recipients.integration.spec.ts`. **Não toca** `team-whatsapp.repository.ts`, o processor nem o chat.

**Interfaces:** consome `MessageStatus` do client, `NOT_REPEATABLE_CODES`/`isRepeatable` de `team-whatsapp.outcome.ts` (só nos testes, para provar o "Repetir"), `TeamWhatsappRepository.requeueFailed` (só nos testes de corrida). Produz CH4 (puro e repositório).

**Contexto vinculado:**
- H2 da spec: "Um verificador no worker, a cada 5 minutos, olha destinatários `QUEUED` com `updatedAt` há mais de 30 minutos cujo job (...) **não existe mais na fila ou já terminou**. (...) Para cada preso, o verificador aplica a mesma leitura da mensagem que o processor usa numa tentativa repetida (`priorOutcome`)". "A troca é condicional a `status = QUEUED` e aos mesmos `messageId` e `manualRetries` lidos (um job que termina ao mesmo tempo ou um 'Repetir' no meio ganham). O verificador nunca põe nada de volta na fila."
- DH6 inteiro (seis ramos, códigos `team_whatsapp.queue_lost`, `team_whatsapp.message_missing`, `team_whatsapp.stuck`; `acceptedAt = sentAt ?? now`; `redispatchable` é o `ChatService.isRedispatchableFailure`, recebido como função para o módulo puro não depender do chat).
- DH7 inteiro (`where` com `status`, `messageId`, `manualRetries` e `updatedAt < now − STUCK_AFTER_MS`; ramo `queueLost` com `cancelMessage` muda a `Message` `QUEUED` → `FAILED` `queue_lost` + `failedAt = now` na mesma transação; `Message` que saiu de `QUEUED` desfaz tudo; nunca toca `attempts`, `manualRetries`, `channelCheckedAt`).
- `recipientDataOf`: `queueLost` → `{ status: 'FAILED', errorCode: QUEUE_LOST_CODE }`; `missing` → `{ status: 'FAILED', errorCode: 'team_whatsapp.message_missing' }`; `sent` → `{ status: 'SENT', acceptedAt }`; `failed` → `{ status: 'FAILED', errorCode }`; `uncertain` → `{ status: 'UNCERTAIN', errorCode: STUCK_CODE }`.
- `findCandidates`: `status = 'QUEUED' AND updatedAt < now − STUCK_AFTER_MS`, `orderBy [{ updatedAt: 'asc' }, { id: 'asc' }]`, `take = STUCK_BATCH`; select `id, dispatchId, messageId, manualRetries`. Só `QUEUED`: `SCHEDULED` (agendado ainda não disparado) nunca entra.
- GH5: `now` explícito; `updatedAt` das fixtures por SQL cru. Telefones fictícios.

**Passos:**
1. [ ] RED puro (`stuck-recipients.spec.ts`): `it('sem messageId — queueLost sem cancelar Message')`; `it('Message apagada — missing')`; `it('Message QUEUED — queueLost cancelando a Message')`; `it('Message SENT, DELIVERED ou READ — sent com acceptedAt = sentAt; sem sentAt usa now')`; `it('Message FAILED reenviável — failed com o código dela')`; `it('Message FAILED evolution.timeout, evolution.unknown, sending_stuck ou sem código — uncertain')`; `it('Message SENDING, CANCELLED ou WAITING_INSTANCE — uncertain')`; `it('recipientDataOf de cada ramo')`; `it('queue_lost é repetível e message_missing não (isRepeatable)')`.
2. [ ] RED integração (`team-stuck-recipients.integration.spec.ts`, banco real): `it('findCandidates: só QUEUED com updatedAt antes de now − 30 min, em ordem, até o lote')` (linha com 29 min e linha `SCHEDULED` antigas não entram); `it('aceite 3: sem mensagem — FAILED queue_lost')`; `it('aceite 21: Message QUEUED — destinatário FAILED queue_lost e Message FAILED queue_lost na mesma transação')`; `it('Message aceita — SENT com acceptedAt da Message')`; `it('Message SENDING — UNCERTAIN stuck')`; `it('aceite 21: Message FAILED reenviável — FAILED com o código dela; requeueFailed a pega')`; `it('aceite 3: Repetir entre a leitura e a troca vence')` (lê o candidato; a linha vai a `FAILED` e `requeueFailed` a devolve a `QUEUED` com `manualRetries 1`; `settle` → `false`; linha `QUEUED`, `manualRetries 1`); `it('processor que termina entre a leitura e a troca vence')` (linha vai a `SENT` antes do `settle` → `false`, segue `SENT`); `it('messageId gravado depois da leitura vence')`; `it('Message que saiu de QUEUED depois da leitura: nada muda e o destinatário segue QUEUED')`; `it('settle não muda attempts nem manualRetries')` (nenhum teste da T4 lê `channelCheckedAt`: a hora da conferência preservada é provada na T8); `it('settle renova updatedAt')` (linha com `updatedAt` 31 min antes do `now` por SQL cru; depois da troca, `updatedAt` é posterior ao valor gravado; DH13).
3. [ ] GREEN; eslint (GH6); validação; `--changed`.

**Aceite:** 3, 21 (regra e gravação). **Risco: alto** (decide o desfecho de quem não saiu da fila).
**Crítico: concorrência/transação com risco de perda de dados — troca condicional do destinatário e da `Message` contra o processor e o "Repetir"; perder a corrida errado apagaria um envio em andamento.**

## Task 5 — Verificador de presos: serviço, fila repetível e worker (back)

**Arquivos:** criar `backend/src/modules/team-whatsapp/team-stuck-reconciler.service.ts`, `team-stuck-reconciler.service.spec.ts`, `team-whatsapp-stuck.processor.ts`, `team-whatsapp-stuck.processor.spec.ts`; modificar `backend/src/modules/queue/queue.constants.ts` (nome da fila), `backend/src/modules/queue/queue.module.ts` (`registerQueue`), `backend/src/worker.module.ts` (processor, serviço e repositório da T4, só aqui), `backend/src/worker.ts` (agendamento do repetível); criar `backend/src/worker.stuck-reconciler.di.spec.ts` (arquivo novo, GH6).

**Interfaces:** consome T4 (`TeamStuckRecipientsRepository`, `stuckOutcome`, constantes), `teamSendJobId` (`team-whatsapp.service.ts:720-725`), `ChatService.isRedispatchableFailure` (`chat.service.ts:417-423`), `AuditService`, `Queue<TeamWhatsappSendJob>` da fila `TEAM_WHATSAPP_SEND` (`getJob`, `Job.getState`). Produz o serviço de CH4 e a fila `team-whatsapp.stuck-reconciler`.

**Contexto vinculado:**
- DH4: fila nova, `attempts: 1`, `removeOnComplete { age: 3600, count: 12 }`, `removeOnFail { age: 86400 }`; repetível `every: 300_000` com `jobId: 'team-whatsapp-stuck-reconciler'` e `...REPEATABLE_JOB_CLEANUP_OPTS` (padrão de `worker.ts:~295-305`, falha logada sem parar o boot); `@Processor(QUEUE_NAMES.TEAM_WHATSAPP_STUCK_RECONCILER, { concurrency: 1 })` registrado **só** no `WorkerModule` ("um @Processor duplicado derruba o worker"). O processor chama `reconcile(new Date())` — o único `new Date()`; o serviço recebe `now`.
- DH5: perdido = `getJob` vazio ou `getState()` ∈ `completed | failed | unknown`; qualquer outro valor de `getState` (inclusive estado que não está na lista de hoje) conta como vivo → não toca; erro na consulta → não toca, log só com `recipientId` e o nome do erro. `jobId = teamSendJobId(c.id, c.manualRetries)`.
- `reconcile(now)`: `findCandidates(now)` → para cada um, consulta o job; se perdido, `loadMessage` (quando há `messageId`), `stuckOutcome`, `settle`; conta por `kind` só quando `settle` devolve `true`; ao fim, uma trilha por envio com alguma troca (DH8) e um log `info` com `{ checked, alive, lost, counts }`. Um candidato que lança (erro de banco) não para o ciclo: conta como não trocado e loga só o `recipientId`.
- DH8: `audit.log('team_whatsapp.stuck_reconciled', 'TeamWhatsappDispatch', dispatchId, { dispatchId, queueLost, missing, sent, failed, uncertain })`, no padrão de `team_whatsapp.scheduled_fire` (`team-whatsapp-schedule.service.ts:99-108`; `audit.log` recebe ação, entidade, id e payload, sem ator).
- GH2: o serviço não tem acesso a `add`/`addBulk` no uso (só `getJob`); teste com fila falsa que falha se `add`/`addBulk` forem chamados. GH3: trilha e logs sem nome, telefone, texto.
- GH1: o reconciliador de campanhas (`campaign.sending-reconciler`) e o do canal não mudam.

**Passos:**
1. [ ] RED serviço (`team-stuck-reconciler.service.spec.ts`, repositório e fila falsos): `it('job ausente — perdido; job completed, failed ou unknown também')`; `it('aceite 3: job waiting, delayed, active ou prioritized há mais de 30 min — não toca')`; `it('estado fora da lista (ex.: um valor novo do BullMQ) conta como vivo — não toca')`; `it('consulta o job pelo teamSendJobId com o manualRetries lido')` (`-r2` para `manualRetries 2`); `it('erro ao consultar o job: não toca e segue o ciclo')`; `it('nunca chama add nem addBulk')`; `it('settle perdido não conta')`; `it('uma trilha por envio, só com dispatchId e contagens')`; `it('ciclo sem troca não grava trilha')`; `it('log do ciclo sem nome, telefone ou texto')`.
2. [ ] RED processor, fila e worker (`team-whatsapp-stuck.processor.spec.ts`): `it('process chama reconcile uma vez com a hora atual (new Date())')` (o processor é o único que lê o relógio, DH4; o serviço recebe `now`); `it('fila registrada com attempts 1')` (ou conferência da opção no `queue.module` pelo padrão dos specs vizinhos); e, se `worker.ts` tiver spec de agendamento, `it('agenda o repetível a cada 5 min com jobId fixo')` — senão, registrar no report que a conferência fica para o boot do Fechamento. Em arquivo novo `backend/src/worker.stuck-reconciler.di.spec.ts`, no padrão de `backend/src/worker.di.spec.ts` (conferir como ele monta o `WorkerModule` e substitui Redis/filas): `it('WorkerModule resolve TeamWhatsappStuckProcessor e TeamStuckReconcilerService com as dependências')`.
3. [ ] GREEN; typecheck; eslint (GH6); validação; `--changed`.

**Aceite:** 3 (job vivo intocado), H2 (trilha). **Risco: alto** (decide se um job está vivo).
**Crítico: concorrência — a decisão "job perdido" é o que impede o verificador de tocar um envio ainda na fila ou em andamento.**

## Task 6 — Tabela do resultado: "Quando", hora da conferência, repetições, rótulo e Novidades (front)

**Arquivos:** modificar `frontend/src/features/team-whatsapp/schemas.ts` (item de destinatário), `error-messages.ts` (`CHANNEL_REASON_LABEL` ou mapa equivalente: `team_whatsapp.queue_lost`), `components/recipient-table.tsx` (colunas e células, ~L46-63 e ~L155-160); criar `recipient-tracking.ts`, `recipient-tracking.spec.ts`, `components/recipient-table.tracking.spec.tsx`; modificar `frontend/src/release-notes.ts` (entrada nova no topo) e manter `release-notes.spec.ts` verde.

**Interfaces:** consome CH2 (espelhado com DH9), `channelLabel` (`error-messages.ts:192-198`), os formatadores de data de Manaus que a feature já usa (achar com `rg -n "America/Manaus|formatDayMonth|toLocale" frontend/src/features/team-whatsapp`; reutilizar, sem formatador novo de fuso). Produz CH5.

**Contexto vinculado:**
- H4 da spec: "A tabela de destinatários ganha a coluna 'Quando': a hora do estado de entrega que a linha mostra (`acceptedAt` em 'Aceito', `deliveredAt` em 'Entregue', `readAt` em 'Lido', `repliedAt` em 'Respondeu'). Formato `dd/mm HH:mm`; '—' nos estados sem hora gravada (Na fila, Falhou, Situação incerta, Pulado, Agendado, Cancelado)." "A coluna 'Tentativas' mostra também as repetições manuais: '2 · repetido 1×'." "O resultado continua sem total e sem exportação."
- H1 da spec: "Na tabela do resultado, a coluna 'Número' mostra o número e, embaixo, 'conexão conferida às HH:mm:ss'." Sem `channelCheckedAt`, só o número.
- DH10 inteiro (ordem das colunas; `recipientWhen`; `attemptsText`; segunda linha do número; "Saiu da fila sem envio"; `team_whatsapp.stuck` é `UNCERTAIN` e usa a explicação fixa de hoje).
- DH9: `channelCheckedAt: z.string().nullish()`, `manualRetries: z.number().int().nonnegative().default(0)`; fixtures existentes continuam válidas.
- C3 da spec: nenhuma situação nova de envio; o polling de hoje (`api.ts:29-30`, QUEUED dentro de 60 min) não muda: o preso vira `FAILED` em 30–35 min e a tela o vê.
- frontend/CLAUDE.md: "Todo PR com mudança visível ao operador (...) adiciona uma entrada em `frontend/src/release-notes.ts`"; "Texto em PT-BR, escrito para o operador"; "`where` só quando existe uma tela específica"; "Entrada nova sempre no TOPO do array `RELEASE_NOTES` — a ordem é decrescente por `version` ('YYYY.MM.DD' ou 'YYYY.MM.DD.n')" (versão maior que a do topo de hoje).
- Itens da nota: no resultado do envio, cada pessoa mostra a hora em que a situação aconteceu ("Quando"), o número mostra a hora em que a conexão foi conferida antes de mandar, e "Tentativas" diz quantas vezes ela foi repetida; quem ficou "Na fila" por mais de 30 minutos sem a mensagem sair passa sozinho para "Falhou: Saiu da fila sem envio" (dá para Repetir), "Aceito pelo WhatsApp" (se saiu) ou "Situação incerta" (se pode ter saído) — o sistema nunca reenvia sozinho; a mensagem que não saiu porque a pessoa foi pulada deixa de aparecer "na fila" no chat. `where: '/whatsapp-equipe'`. Sem nome ou telefone de exemplo.
- GH6: `recipient-table.tsx` é legado; as funções novas moram em `recipient-tracking.ts`; `describe` novo em arquivo novo.

**Passos:**
1. [ ] RED puro (`recipient-tracking.spec.ts`): `it('recipientWhen: hora de cada estado (SENT, DELIVERED, READ, REPLIED)')`; `it('recipientWhen: null em QUEUED, FAILED, UNCERTAIN, SKIPPED, SCHEDULED, CANCELLED e com a hora nula')`; `it('attemptsText: 2 · repetido 1×; 3 sem repetição; — · repetido 1×; —')`; `it('failureReasonLabel de team_whatsapp.queue_lost: Saiu da fila sem envio')`; `it('esquema aceita item sem channelCheckedAt e sem manualRetries (manualRetries 0)')`.
2. [ ] RED tela (`recipient-table.tracking.spec.tsx`): `it('aceite 5: coluna Quando com dd/mm HH:mm da hora do estado em Manaus')` (ex.: `acceptedAt '2026-11-20T13:05:00.000Z'` → "20/11 09:05"); `it('Quando — nos estados sem hora')`; `it('aceite 2: Número com conexão conferida às HH:mm:ss; sem hora só o número')`; `it('aceite 5: Tentativas 2 · repetido 1× depois de um Repetir')`; `it('Falhou: Saiu da fila sem envio com Repetir')` (`repeatable: true`); `it('ordem das colunas: Nome, Telefone usado, Situação, Quando, Número, Tentativas, Motivo')`.
3. [ ] Novidades: entrada no topo; `timeout 600 gate --test src/release-notes.spec.ts`.
4. [ ] GREEN; `npx tsc -b`; eslint (GH6); validação; `--changed`.

**Aceite:** 2 e 5 (tela), Novidades do lote. **Risco: médio** (exibição).
**fronteira: contrato público consumido pelo front — só espelha CH2 com campos tolerantes e exibe; não muda contrato nem regra de envio.**

## Task 7 — Demonstração de T08, cenários 1 a 3, e fixtures da suíte (back, só teste)

**Arquivos:** criar `backend/src/modules/team-whatsapp/team-whatsapp.t08.test-fixtures.ts` e `team-whatsapp.t08.integration.spec.ts`. Nenhum arquivo de produção.

**Interfaces:** consome T3 (processor final), os fixtures de serviço de hoje (`team-whatsapp.sector-send.test-fixtures.ts`/`team-audience.test-fixtures.ts`, o `deps` usado por `team-dispatch-history.e2e.integration.spec.ts:100-178`), `ChatService` real (construtor `chat.service.ts:129-135`: `ChatRepository`, `ChatEventsService`, `WhatsappProvidersService`, `PrismaService`, `AuditService`; montagem como em `chat.service.team.spec.ts:50`, com `ChatRepository` real sobre o prisma do testcontainer), `TeamWhatsappRetryService`. Produz o harness de DH11 para a T8.

**Contexto vinculado:**
- H6 da spec: "Uma suíte de integração com banco real, só com a porta do provedor falsa, cobre de ponta a ponta: 1. número desconectado na confirmação: 409 e nenhuma linha criada; 2. número cai no meio da fila: os restantes ficam 'Falhou: número desconectado', nenhum 'Aceito' falso; depois de reconectar, 'Repetir' manda só os falhos, uma vez cada; 3. timeout do provedor: 'Situação incerta', fora do 'Repetir', sem segunda chamada ao provedor".
- DH11 inteiro (o que é real e o que é falso). A fila em memória: `addBulk` guarda por `jobId` e ignora repetido; `drain(processor)` roda cada job com `attemptsMade` 0, 1, 2 enquanto o processor lançar algo que não seja `DelayedError` (imita `attempts: 3`), e marca o estado (`completed`/`failed`); `getJob`/`getState` para a T8. Redis falso que atende o pacing (`acquirePacingLock`/`releasePacingLock`/`del`) sem esperar: conferir em `campaigns/pacing.helper.ts` os comandos usados e registrar no report.
- Porta do provedor: conferir no `chat.service.ts` qual método do `WhatsappProvidersService` o `sendTeamMessage` chama e como o timeout chega (`WhatsappSendError` com código `evolution.timeout`, `fatal`?); a falsa anota cada chamada (por `messageId`) e responde por roteiro. Registrar no report.
- Regras de hoje provadas aqui, sem mudar código: canal `close` na confirmação → 409 (`requireOpenNumbers`, `team-whatsapp.channels.ts:124-142`); `close` no processor → `FAILED team_whatsapp.channel_disconnected` sem tentativa contada (DH2: e sem hora); `evolution.timeout` não é reenviável (`chat.service.ts:76-81`) → `UNCERTAIN`, `isRepeatable` falso, `requeueFailed` não o pega, `priorOutcome` da reexecução não chama o provedor.
- GH5/GH9: telefones fictícios; nenhuma chamada real; `now` explícito onde houver.
- GH6: callbacks até 50 linhas; o harness fica no fixture.

**Passos:**
1. [ ] Fixture: `buildT08World()` com três pessoas autorizadas num setor com número EVOLUTION, fila em memória, porta do provedor e porta ao vivo falsas, processor e `ChatService` reais.
2. [ ] RED/GREEN (a regra já existe; o teste prova): `it('cenário 1: número desconectado na confirmação — 409 e nenhuma linha de envio ou destinatário')`; `it('cenário 2: número cai depois da 1ª pessoa — a 1ª Aceito com hora, as outras Falhou: número desconectado sem hora; nenhum SENT sem Message aceita')`; `it('cenário 2: reconecta e Repetir manda só os falhos, uma chamada ao provedor cada, sem Message nova')`; `it('cenário 3: timeout do provedor — Situação incerta, repeatable false, Repetir devolve 0; reexecutar o job com o destinatário QUEUED e a Message FAILED evolution.timeout não chama o provedor de novo')`. Roteiro: com o timeout, `settle` grava `UNCERTAIN` já na 1ª execução, sem lançar (`team-whatsapp-send.processor.ts:391-404`), então o `drain` não roda três tentativas; para provar a reexecução, o teste recoloca o destinatário em `QUEUED` por SQL cru (queda do worker entre a `Message` `FAILED evolution.timeout` e a gravação do destinatário), roda o processor de novo com `attemptsMade` 1 e confere `UNCERTAIN` e uma só chamada ao provedor no total.
3. [ ] Validação (`TESTCONTAINERS_ENABLED=1`); eslint (GH6); `--changed`.

**Aceite:** 1 (parte), 2. **Risco: alto** (é a demonstração de T08 para a GBR).

## Task 8 — Demonstração de T08, cenários 4 a 6 (back, só teste)

**Arquivos:** criar `backend/src/modules/team-whatsapp/team-whatsapp.t08-stuck.integration.spec.ts`; no fixture da T7, só acréscimos (listados no report). Nenhum arquivo de produção.

**Interfaces:** consome T7 (harness), T4/T5 (`TeamStuckReconcilerService` real sobre o repositório da T4, com a fila em memória do harness), `TeamRecipientTrackingService.applyReceipt` (`tracking/team-recipient-tracking.service.ts:38-60`), `TeamWhatsappRetryService`.

**Contexto vinculado:**
- H6 da spec: "4. recibo repetido e fora de ordem (lido antes de entregue, entregue duas vezes): o estado não volta e nenhuma mensagem nova é criada; 5. dois 'Repetir' ao mesmo tempo: uma chamada ao provedor por pessoa; 6. job perdido (H2), nos quatro ramos: sem mensagem ou com a `Message` `QUEUED` → 'Falhou: saiu da fila sem envio', repetível, sem segunda `Message`; `Message` aceita → 'Aceito pelo WhatsApp'; `Message` `SENDING` ou com falha indeterminada → 'Situação incerta'; `Message` com falha certa e reenviável → 'Falhou' com o código dela, repetível. Nada é reenviado sozinho."
- Aceite 3: "Destinatário com job esperando há mais de 30 min (fila com pacing) não muda; um 'Repetir' entre a leitura e a troca vence o verificador." Aceite 21: "a `Message` `QUEUED` do ramo 'nada saiu' fica `FAILED`, sem continuar 'na fila' no chat."
- DH11 (recibo por `applyReceipt` + atualização da `Message` como o webhook faz); DH12 (dois `retry` em `Promise.all`).
- Como produzir cada preso: rodar o envio pelo harness e "perder" o job (tirar da fila em memória, ou deixá-lo `failed`), com a `Message` no estado do ramo (sem `Message`; `QUEUED` por uma 1ª tentativa que preparou e lançou; `SENT`; `SENDING`; `FAILED evolution.timeout`; `FAILED` reenviável); `updatedAt` 31 min antes do `now` por SQL cru (GH5).
- GH2: nenhum `addBulk` novo depois do `reconcile`; nenhuma chamada nova ao provedor até o "Repetir".

**Passos:**
1. [ ] RED/GREEN: `it('cenário 4: lido antes de entregue e entregue duas vezes — segue Lido, deliveredAt não regride, nenhuma Message nova')`; `it('cenário 5: dois Repetir ao mesmo tempo — um job e uma chamada ao provedor por pessoa')`; `it('cenário 6: sem Message e com Message QUEUED — Falhou: saiu da fila sem envio; Repetir manda uma vez, sem segunda Message; a Message QUEUED virou FAILED antes do Repetir')`; `it('cenário 6: Message aceita — Aceito pelo WhatsApp, sem chamada ao provedor')`; `it('cenário 6: Message SENDING e FAILED por timeout — Situação incerta, fora do Repetir')`; `it('cenário 6: Message FAILED reenviável — Falhou com o código dela, Repetir a reaproveita')`; `it('aceite 3: job esperando (delayed) há mais de 30 min não muda')`; `it('cenário 6: o verificador não enfileira nem chama o provedor')`; `it('cenário 6: o verificador preserva a hora da conferência (channelCheckedAt)')` (destinatário preso com `channelCheckedAt` gravado antes do `reconcile`; depois da troca a coluna segue igual; a T4 não lê essa coluna, DH7).
2. [ ] Validação (`TESTCONTAINERS_ENABLED=1`); eslint (GH6); `--changed`.

**Aceite:** 1 (resto), 3, 21. **Risco: alto** (demonstração de T08 e prova do verificador ponta a ponta).

---

## Fechamento (principal)

1. Conferir o ledger: 8 tasks aceitas; revisões `opus` em T1–T6; `tsc` do back conferido depois de cada onda (GH8); os testes do Rastreio presentes e verdes.
2. Gates completos, **um de cada vez**, nada mais rodando (sem stack de QA junto): back e depois front, `--base origin/main`, no estado final; comparar com o fim do Lote G (back 6994/7024, coverage 95,2/87,1; front 2335/2335, coverage 88,6/82,6) pelo script ancorado; bloquear violação nova ou agravada; conferir `max-lines-per-function` 50 dos specs novos.
3. Migração no banco local de QA (stack `orgamind-turnos-qa`, seed fictício): `count(*)` de `TeamWhatsappRecipient` antes e depois; `prisma migrate deploy`; coluna nula nas linhas antigas; índice criado; tempo do `CREATE INDEX` anotado. **O deploy deve rodar a migração fora do horário de envio** (o `CREATE INDEX` sem `CONCURRENTLY` bloqueia escrita em `TeamWhatsappRecipient`, DH1): avisar a principal/GBR no PR.
4. Boot real do worker: o repetível `team-whatsapp-stuck-reconciler` aparece em `getRepeatableJobs` uma vez só (dois boots seguidos não duplicam); um destinatário `QUEUED` semeado com `updatedAt` antigo e sem job vira `FAILED queue_lost` no ciclo seguinte (o worker local não tem Evolution: conferir só as linhas e a trilha).
5. QA visual (agente `qa`, roteiro Node com `@playwright/test`, senha do seed lida no processo, login 5/min): tabela com "Quando", "conexão conferida às", "· repetido 1×" e "Falhou: Saiu da fila sem envio" com "Repetir" (dados semeados por SQL no banco de QA); conferir também que a `Message` `CANCELLED` (H3) e a `FAILED queue_lost` (H2) aparecem no chat sem "na fila" (ver "Não verificado").
6. Revisão final do conjunto com `opus`.
7. Atualizar "Estado" deste plano; registrar na spec, em "Para a GBR confirmar" (linha do Lote H, que já tem H2 e H5), as decisões que mudam o que a GBR vê: DH2 (a hora some de quem não saiu na última tentativa, mesmo que uma anterior tenha conferido), DH3 (só a mensagem que ainda estava "na fila" é cancelada; a que já tinha falhado continua "falhou" no chat), DH6 (a mensagem presa que o reconciliador de campanhas fechou como `sending_stuck` aparece como "Situação incerta"), DH10 (o preso leva de 30 a 35 minutos para sair de "Na fila"; rótulo "Saiu da fila sem envio").
8. Commits do lote, push e PR **rascunho** sobre `feat/agendamento-reconferencia` (C1: um PR por lote, empilhados), com o aviso "Vai para produção junto com os Lotes F e G (PRs #18 e #19)". **Sem merge, sem deploy.** O Lote I segue no mesmo branch depois.

## Dúvidas de produto (decididas provisoriamente; para a GBR confirmar)

- **Hora da conferência em quem não saiu (DH2):** some quando a última tentativa não chegou ao provedor. Recomendação: manter (a hora mostrada é sempre a da conferência que liberou a mensagem que saiu ou tentou sair).
- **Mensagem já falha e depois pulada (DH3):** continua "falhou" no chat, não "cancelada". Recomendação: manter (a spec H3 fala de `QUEUED`).
- **Atraso do preso (DH4):** entre 30 e 35 minutos sem job. Recomendação: manter; envio grande com pacing nunca é tocado enquanto o job existe.

## Não verificado (conferir na task dona)

- Se o `@updatedAt` do Prisma é atualizado por `updateMany` nos demais caminhos (`countAttempt`, `prepare`, `finish`): o claim do agendado não depende disso (DH13, explícito, teste na T3) e a troca do verificador tem teste (T4); se algum desses caminhos não renovar, uma linha em andamento pode ter `updatedAt` antigo — o job vivo (DH5) continua protegendo; a T4 registra o comportamento observado.
- Método do `WhatsappProvidersService` usado pelo `sendTeamMessage` e a forma do erro de timeout (T7).
- Comandos Redis do pacing para o Redis falso (`campaigns/pacing.helper.ts`; T7).
- Campos obrigatórios de `Message` para semear direto pelo prisma (T3, T4).
- Formatadores de data de Manaus da feature no front e a versão do topo de `RELEASE_NOTES` (T6).
- Como o chat exibe `Message` `CANCELLED` e `FAILED queue_lost` (H3: "Nada mais muda no chat"); conferir no QA do Fechamento, sem mudar `chat`.
- Se existe spec do agendamento de repetíveis em `worker.ts` (T5; senão, o boot do Fechamento confere). A resolução de dependências do `WorkerModule` é coberta pelo spec novo da T5 (`worker.stuck-reconciler.di.spec.ts`).
