# OrgaMind, Etapa 3 GBR, Lote G: agendamento em data e hora, reconferência no disparo, telefone congelado e histórico com busca (MSG-01, DAT-01). Implementation Plan

> **Para os agentes:** executar pela skill `sdd` (TDD, ledger em `.superpowers/sdd/2026-11-20-orgamind-gbr-etapa3-lote-g-agendamento/progress.md`). **Sem commit/push**: nenhuma task commita; a principal integra e commita o lote. Branch `feat/agendamento-reconferencia`, criado de `feat/publico-finalidade` em `8e25cec` (Lote F, PR rascunho #18). Fechamento de task por `gate --changed --base feat/publico-finalidade`. Regras dos agentes: `.superpowers/sdd/2026-11-20-orgamind-gbr-etapa3-lote-g-agendamento/{implementer-rules,reviewer-rules}.md` (criadas na Preparação). Linhas citadas são pistas e podem ter mudado.

**Goal:** quem envia para a equipe agenda em data e hora livres (até 30 dias, menos Urgência) e monta o texto a partir dos dados da atividade; o agendado é congelado na criação e reconferido no disparo, só para retirar (Férias, Folga, Saiu do setor ou turno, Inativa), dentro do claim atômico e com teto de 2 horas; o telefone de cada destinatário é gravado na criação e a mensagem não sai se ele mudou; o histórico filtra por período, finalidade e situação, busca por nome no detalhe e mostra a reconferência, quem entrou depois e "ninguém recebeu".

**Architecture:** no back, módulo `backend/src/modules/team-whatsapp/`: uma função pura de reconferência (`scheduled-recheck.ts`), o `claimScheduled` passa a receber a reconferência como função chamada dentro da transação, depois de vencer o `updateMany` e antes de `failUnavailable`/`queueActive`; um caminho de vencimento (`expireScheduled`) com estado `EXPIRED`; a classificação do público sai de `team-audience.service.ts` para `audience-people.ts`, usada pela prévia, pelo envio e pela reconferência; o processor de envio compara o telefone gravado. Uma migração aditiva (valores de enum, três colunas, dois índices). No front, `frontend/src/features/team-whatsapp/`: momento "Data e hora" no estado dos filtros (a prévia passa a levar o momento), rascunho do texto na página, filtros do histórico, bloco da reconferência no detalhe.

**Tech Stack:** NestJS + Prisma 6 + Zod v4 + BullMQ + Vitest/testcontainers no back; React + TanStack Router/Query + ky 2 + Radix + Vitest/Testing Library no front. **Sem dependência nova.**

**Spec:** `docs/superpowers/specs/2026-11-20-orgamind-gbr-etapa3-publico.md` — Restrições, Anti-objetivos, C1–C5, "Lote G" (G1–G5), aceites 20–39, "Fica com o construtor". Sentença: `~/.claude/tribunais/2026-11-20/conselho-T/sentenca-T.md` ("Consequências", itens 2–5 e 9). Mapas: `.superpowers/sdd/2026-11-20-orgamind-gbr-etapa3-publico/fontes-g/` (`mapa-disparo-back-g.md`, `mapa-historico-back-g.md`, `mapa-front-g.md`) e `fontes/` (Lote F). Plano do F: `docs/superpowers/plans/2026-11-20-orgamind-gbr-etapa3-lote-f-finalidade.md` (DF1–DF13, GF1–GF17 e CF1–CF10 continuam valendo; aqui só se repete o que a task usa).

## Estado (20/11/2026)

- **Implementado (20/11/2026), branch `feat/agendamento-reconferencia` sobre `8e25cec`:** as 20 tasks (T1–T18, com T6a/T6b e T10a/T10b) aceitas, cada uma com revisão independente (opus em T1, T2, T3, T5, T6b, T7, T8, T9, T10a, T10b, T11, T12; sonnet nas demais), mais duas varreduras de minors (back e front) e os ajustes da revisão final. Um fix round (T10b: teste vacuo de seleção nominal, provado por mutação). Ledger: `.superpowers/sdd/2026-11-20-orgamind-gbr-etapa3-lote-g-agendamento/progress.md`.
- **Gates completos** (sozinhos, `--base origin/main`): back TESTES 6994/7024 (30 skip, 0 falha), coverage 95,2/87,1; front 2335/2335, coverage 88,6/82,6; comparação ancorada com o fim do Lote F: 0 violação nova ou agravada nos dois.
- **Revisão final do conjunto (opus):** APPROVED; minors m1, m2, m4 corrigidos; m3 (ordem do deploy) registrado na spec.
- **Spec:** "Para a GBR confirmar" com as decisões do lote (DG3, DG4, DG7, DG9, DG12, DG15, DG16 e textos novos) e "Requisito de ambiente de produção (Lote G)" (`connection_limit`, ordem do deploy).
- **Backlog do lote:** estreitar o enum de pulos da resposta da criação (T8-m1, exige mexer no guard do service); `Message` QUEUED órfã em pulos entre tentativas (dívida comum, T9-m1); `shiftName` nulo de quem entrou depois com todos os turnos (T6b-m2); teste de Férias × Folga simultâneas (T10b); bordas excluídas do período no e2e e telefone usado após troca na tela (T12); período invertido segura também finalidade/situação (varredura front).
- **Revisão 1 aplicada** (`.superpowers/sdd/2026-11-20-orgamind-gbr-etapa3-lote-g-agendamento/plan-review-1.md`): GG13 conferido task a task (`EXPIRED` do contrato na T1; `recheck`/`phone` opcionais na T2; `rechecked` opcional na T5; `filters` opcional na T13; o spec do scheduler na T6b; T9 semeia sem depender da T8; helper de render do diálogo na T14/T15); `recheckAudience` recebe o `now` do tick (DG2); T6 dividida em T6a (Onda 2) e T6b (Onda 4); `LoadedRecipient` na T9; linha "Crítico" na T3; DG7 (telefone apagado), DG4 (troca de nível), DG16 (vencido derivado na tela) e DG15 (tensão com férias) registrados. 20 tasks.
- **Revisão 2 aplicada** (`.superpowers/sdd/2026-11-20-orgamind-gbr-etapa3-lote-g-agendamento/plan-review-2.md`): (A) `team-whatsapp.schema.ts` inteiro, com `EXPIRED` e o spec dele, passa para a T2; a T1 sai do contrato e registra como esperado o erro de tipo em `results.service.ts:182` até a T2 entrar; Onda 1 continua paralela e a principal confere o `tsc` no fim dela. (B) agendado em "data e hora" com vários ou todos os turnos: `shift` nulo no contrato da lista de agendados (T2), `toScheduledItem` sem exigir turno (T6b, com integração "aparece na lista e cancela"), esquema do front e `whenText` dos agendados com `scheduledFor` (T13; teste da lista na T16); `rosterDate` conferido: sempre gravado (`sector-dispatch.ts:225`). (C) T12 ganha os dois testes ponta a ponta do telefone; a T9 unifica os dois `sendPhoneOf`; Rastreio 28/38 corrigido. (m1) conta de conexões refeita. (m2) `cancelScheduled` com `timeout: 25_000` e teste (T5). (m3) `recheckAudience` em `scheduled-recheck.runner.ts` (T6b); `scheduled-recheck.ts` fica puro.
- Do Lote F já existem (não reimplementar): `TeamAudienceService.resolve/preview`, `team-whatsapp.sector-dispatch.ts`, colunas `purpose`/`audienceBase`/`audienceRule`/`audienceExcluded`/`schedulePolicy` (nunca escrita), `dispatch-purpose-view.ts`, prévia com `audienceKey` e 409, `RulePanel`, `ExcludedGroups`, `policyLabel`.
- Herdados do F que entram aqui, com teste: `PHONE_EXCLUSIONS` × pulados da reconferência (T17, DG10); painel "Agora" ao agendar (T14, DG11); data passada do aceite 12 (T12); `policyLabel` de `frozen_recheck` (T13); `notifyDone` com a data e hora livres (T14).
- **Próximo passo:** QA local (ensaio do disparo e QA visual), commits, push e PR rascunho sobre `feat/publico-finalidade`. Sem merge e sem deploy.

## Preparação (principal, antes da T1)

1. Criar `feat/agendamento-reconferencia` a partir de `feat/publico-finalidade` (`8e25cec`); conferir que `git merge-base` dá `8e25cec` (senão o `--changed` mede o Lote F junto). Em worktree: `backend/.env` fictício e `node_modules` por symlink (memória "gate em worktree").
2. Criar `implementer-rules.md` e `reviewer-rules.md` copiando os do Lote F e adaptando: branch, base `feat/publico-finalidade`, este plano, a spec, o ledger novo; referências `DGn`, `GGn` e `CGn` anexadas no fim do brief; "o Lote F está pronto no branch; não revisar nem mexer fora do ownership". Riscos do lote no `reviewer-rules.md`: dois ticks enviando duas vezes; reconferência parcial (parte enviada, parte não); pessoa de férias ou fora do setor recebendo agendado; linha de destinatário inserida no disparo; mensagem para telefone trocado; filtro ou busca que mostre envio de outro autor ou nome mascarado; envio sem ninguém recebendo aparecendo como sucesso; nome ou telefone em log ou trilha.
3. Criar o ledger `progress.md` com a referência Git de partida.

## Decisões deste plano (o que a spec deixa com o construtor)

- **DG1. Uma migração aditiva** `20261120130000_team_dispatch_schedule_recheck`: `TeamWhatsappDispatchState` + `EXPIRED`; `TeamWhatsappSkipReason` + `VACATION`, `DAY_OFF`, `LEFT_SECTOR`, `PHONE_CHANGED`, `EXPIRED`; `TeamWhatsappDispatch` + `recheckedAt DateTime?` (hora da reconferência) e `audienceLateJoined Json?` ("entraram depois", sem telefone); `TeamWhatsappRecipient` + `phoneE164 String?` (telefone da pessoa gravado na criação; nulo = envio antigo); índices `TeamWhatsappDispatch(state, createdAt)` e `(purpose, createdAt)`. Nenhum valor ou coluna removido; nenhuma linha alterada.
- **DG2. A reconferência roda dentro da transação do `claimScheduled`, depois que o `updateMany` condicional venceu e antes de `failUnavailable` e `queueActive`.** O repositório recebe a reconferência como função (`RecheckFn`), chamada só por quem venceu; se ela lança, a transação inteira se desfaz: o envio volta a `SCHEDULED`, sem `firedAt`, sem destinatário mudado e nada enfileirado, e o tick seguinte tenta de novo. Como o `updateMany` trava a linha até o commit, outro tick e o cancelamento esperam e depois veem `count 0`. A reconferência vem antes de `failUnavailable` para quem entrou de férias ficar `SKIPPED VACATION`, nunca `FAILED channel_unavailable` (que o "Repetir" reenviaria). Transação com `timeout: 20_000`, `maxWait: 5_000`; a reconferência não chama o provedor nem o `ConsentService` (só classifica). A reconferência usa o `now` do tick, nunca o relógio: `recheckAudience(repo, claimed, now)` repassa `todayIn(now)` como `today` de `loadDayPeopleMany` (`repository.ts:548-551`, que sem o parâmetro usa `todayIn(new Date())` para escolher entre o vínculo da data passada e o cadastro).
  - **A leitura das pessoas sai fora da transação, por outra conexão do pool (só leitura).** Decisão: a `RecheckFn` chama `this.repo.loadDayPeopleMany`, que usa o `prisma` comum do repositório e o `StaffScheduleService.listVisitorIdsBySector` (módulo de escala, fora do GG1). Fazer a leitura pelo `tx` exigiria abrir um parâmetro de cliente nas duas funções e no módulo de escala, e a transação interativa do Prisma só inclui as consultas feitas pelo `tx` (sequenciais numa conexão); consulta pelo `prisma` comum vai por outra conexão e não vê o que o `tx` ainda não commitou.
  - **Por que a leitura não vê estado inconsistente e o claim continua sendo o único a decidir:** (a) a leitura só toca cadastro, vínculo e escala, nunca `TeamWhatsappDispatch`/`TeamWhatsappRecipient`; a lista congelada, a regra e quem tem linha vêm de `loadClaimed(tx)`, dentro da transação e depois do lock; (b) o cadastro lido é o confirmado (READ COMMITTED) no instante da reconferência, que é o que "reconferir no disparo" pede; uma mudança confirmada um instante depois vale para o próximo envio, como em qualquer leitura; (c) a leitura não escreve: o `updateMany` condicional já venceu antes dela, e o lock da linha segura outro tick e o cancelamento até o commit; os pulos são gravados pelo `tx`.
  - **Custo:** cada disparo segura duas conexões (a da transação e a da leitura). O `fireDue` dispara um envio por vez (`for` sequencial, `schedule.service.ts:61`) e o scheduler tem `concurrency: 1`, então o scheduler usa no máximo duas; o worker divide o pool com o processor de envio (`team-whatsapp-send.processor.ts:126`, `concurrency: 2`) e os demais processors. O pool padrão do Prisma é 2×vCPU+1 (5 no VPS de 2 vCPU). Requisito de ambiente: `connection_limit ≥ 2 do scheduler + concorrência do envio + demais processors` (ver "Não verificado" e Fechamento). Com o pool esgotado, a leitura cai em P2024 no `pool_timeout` ou a transação no `timeout` de 20 s; nos dois casos tudo se desfaz, o enfileiramento só ocorre depois do commit (`schedule.service.ts:80-84`) e o tick seguinte tenta de novo (nada sai).
  - **Cancelamento durante a reconferência:** o cancelamento espera o lock da linha que o claim segura por até 20 s; com o `timeout` padrão de 5 s cairia em P2028 e devolveria 500. Por isso `cancelScheduled` (`repository.ts:817-834`) passa a `$transaction(fn, { timeout: 25_000, maxWait: 5_000 })`, maior que o do claim: espera o commit ou o rollback do claim e então vê `count 0` (409, já disparado) ou vence (cancelado). Teste na T5. Cliente: o `ky` do front usa `timeout: 15_000` (`frontend/src/lib/api-client.ts:101`); um cancelamento que espere mais que isso durante uma reconferência lenta pode dar erro de tempo na tela com o resultado certo no banco (409 ou cancelado). Raro; aceito sem mudança — a tela relê a lista de agendados ao errar (revisão 3, m-b).
- **DG3. A reconferência não usa ator.** Usa a regra gravada (setores de `TeamWhatsappDispatchSector`, turnos, níveis, sem nível e seleção do `audienceRule`, base, `includeOff`, `rosterDate`), sem validar setor, turno ou nível ativos e sem as portas de alcance, `equipe.disparo_amplo` e permissão do autor, que valeram na criação. Hoje o agendado já dispara sem conferir o autor; isso não muda (autor desativado ou sem permissão: o agendado sai; ver "Dúvidas de produto"). Telefone, bloqueio e autorização de contato não entram na reconferência: continuam no processor, por mensagem.
- **DG4. Motivos da reconferência**, para cada destinatário ainda `SCHEDULED`, nesta precedência: sem usuário ou usuário inativo → `INACTIVE` ("Inativa"); entre os incluídos do público recalculado → fica; excluído com `vacation` → `VACATION` ("Férias"); com `day_off` → `DAY_OFF` ("Folga"); com `other_sector`, `other_shift` ou `not_selected`, ou ausente do público recalculado → `LEFT_SECTOR` ("Saiu do setor ou turno"). O público recalculado é o da regra, **antes** da divisão por telefone. "Entraram depois" só quando a seleção gravada é nula ("todos os aptos"): incluídos do público recalculado sem nenhuma linha de destinatário no envio (de qualquer situação), gravados em `audienceLateJoined` com nome, setor, turno e nível, sem telefone, ordenados pelo nome. **Troca de nível depois do agendamento:** quem saiu do filtro de nível gravado fica ausente do público recalculado (ou `not_selected`) e sai como `LEFT_SECTOR` "Saiu do setor ou turno"; a spec só tem quatro motivos e não se cria um quinto (teste na T4; vai para "Para a GBR confirmar").
- **DG5. Teto de 2 horas na condição atômica.** `claimScheduled` só pega `state = SCHEDULED AND scheduledFor <= now AND scheduledFor >= now − 2h`. `expireScheduled` pega `state = SCHEDULED AND scheduledFor < now − 2h` e grava `state = EXPIRED`; os destinatários `SCHEDULED` viram `SKIPPED EXPIRED`. Exatamente 2 h de atraso ainda dispara. `fireOne` tenta o claim e, se não venceu, o vencimento. Vale para agendados antigos (política nula). Trilha nova `team_whatsapp.scheduled_expired`.
- **DG6. Política gravada:** alvo setor "agora" → `IMMEDIATE`; "início do turno" e "data e hora" → `FROZEN_RECHECK`. Alvo pessoa continua com política nula (não tem finalidade; C5). Agendado com `FROZEN_RECHECK` sem `RecheckFn` → o claim lança e nada muda (nunca dispara congelado sem reconferir). Política nula → regra antiga (`failUnavailable` + `queueActive`), sem reconferência.
- **DG7. Telefone congelado:** na criação (setor e pessoa, agora e agendado, inclusive as linhas `SKIPPED` de telefone), `phoneE164 = sendPhoneOf(member)` de `recipient-skip.ts` (`contact.phoneE164 ?? user.phoneE164`, o mesmo que entra na impressão). No processor, a ordem do `precheck` passa a ser: sem telefone atual → `SKIPPED NO_PHONE`; gravado não nulo e diferente do atual → `SKIPPED PHONE_CHANGED`, sem `Message`; depois supressão, autorização e canal como hoje. A mensagem sai para o telefone gravado (igual ao atual nesse ponto). Gravado nulo (envio antigo) → telefone atual, como hoje, inclusive no "Repetir". O `sendPhoneOf` do processor e o de `recipient-skip.ts` passam a ser o mesmo. **Telefone apagado depois da criação** (gravado não nulo, atual nulo) = `SKIPPED NO_PHONE` "Sem telefone", não `PHONE_CHANGED`: a G4 fala em telefone "que não é o gravado", e o resultado é o mesmo (pulado, sem "Repetir", nada sai); muda só o rótulo. Teste na T9; vai para "Para a GBR confirmar".
- **DG8. Data e hora livres:** `when: 'at'` com `at: { date: CivilDate; time: 'HH:mm' }` em Manaus; `scheduledFor = zonedStart(at.date, at.time)`. "Até 30 dias à frente" = `at.date <= hoje(Manaus) + 30 dias`. Trava nova `schedule_too_far`; `schedule_in_past` ganha texto próprio para "data e hora". Urgência com `'at'` → 422 `when_not_allowed` (a matriz não tem `'at'` na Urgência). `'at'` só no alvo setor (alvo pessoa com `'at'` → 400 no DTO). O momento vai gravado em `audienceRule.when` (JSON, campo opcional; ausente = `scheduledFor ? 'shift_start' : 'now'`).
- **DG9. "Ninguém recebeu" é derivado na tela**, sem coluna: envio `DISPATCHED` em que `queued + scheduled + sent + delivered + read + replied + uncertain = 0`. O filtro "Situação" do histórico é o estado gravado: Agendado, Enviado, Cancelado, Não enviado: passou da hora (o agendado vencido com o worker parado: DG16).
- **DG10. Contagem do detalhe de envio reconferido (herdado 1):** "No público (n)" é a foto da criação = soma das situações − excluídos de telefone gravados em `audienceExcluded` (regra de hoje; `PHONE_EXCLUSIONS` **não cresce**). Pulados da reconferência e `PHONE_CHANGED` estavam na foto: contam em "No público", aparecem com o motivo na tabela de destinatários e no bloco da reconferência, e **não** entram em "Ficaram de fora" (que é só `audienceExcluded`). Ninguém conta duas vezes.
- **DG11. O momento sobe para o estado dos filtros (herdado 2):** `when` e `at` ficam em `use-send-filters.ts` e vão no corpo da prévia; o painel, as travas, o `audienceKey` e o aviso de agendado vêm da prévia com o momento escolhido. O toast de agendado usa `rule.scheduledFor` da prévia confirmada (herdado 5). Trocar a finalidade volta o momento para "Agora".
- **DG12. Texto e rascunho sobem para a página:** o texto e a marca do preenchimento passam do diálogo para um hook da página (`message-draft.ts`), senão o aviso do G2 nunca aparece (os campos da atividade ficam na página e o diálogo é modal e desmonta ao fechar). Fechar o diálogo deixa de perder o texto; sair da página perde (spec G2: "fechar a tela perde o texto"); envio aceito limpa. Texto do preenchimento: `{Finalidade} em {dd/mm/aaaa} às {HH:mm}` + ` — {local}` se houver + `.` + linha em branco. Preencher com texto vazio põe o cabeçalho; com texto que começa pelo último cabeçalho preenchido, troca só o cabeçalho; senão, põe o cabeçalho antes do texto.
- **DG13. Busca por nome no detalhe:** com `q`, o servidor carrega todos os destinatários do envio (limitado pelo `DAY_PEOPLE_LIMIT` de 2000 da criação), aplica `nameView` do ator, compara sem acento e sem diferença de maiúsculas no **nome exibido** e pagina em memória; sem `q`, caminho de hoje. A busca nunca acha pelo nome real um nome que a tela mostra mascarado. Excluídos e "entraram depois" (vêm inteiros no detalhe) são filtrados na tela com a mesma normalização.
- **DG14. Filtros da lista:** `from`/`to` (dia civil de Manaus, sobre `createdAt`, inclusive), `purpose` (uma das 6) e `state` (`SCHEDULED | DISPATCHED | CANCELLED | EXPIRED`), todos opcionais e combinados com E; `from > to` → 400. Sempre somados à regra "não ADMIN vê só os próprios" (`authorId`), inclusive no `count`. Paginação por offset de hoje (20).
- **DG15. "Repetir" não reconfere a regra** (como hoje); só o telefone (DG7). Tensão registrada: **"Repetir" dias depois pode chegar a quem entrou de férias depois do disparo** (anti-objetivo "pessoa de férias receber mensagem de qualquer finalidade"). A G4 só exige reconferir o telefone; fica para "Para a GBR confirmar". Ver "Dúvidas de produto".
- **DG16. Agendado vencido com o worker parado é derivado na tela.** O envio só vira `EXPIRED` quando um tick roda; enquanto o worker está parado, o agendado com `state = SCHEDULED` e `scheduledFor < agora − 2 h` aparece como "Não enviado: passou da hora" na lista do histórico, na lista de agendados e no detalhe. É só o rótulo: o filtro "Situação" continua pelo estado gravado (esse envio sai em "Agendado"), as ações de hoje não mudam, e o worker grava `EXPIRED` quando volta (DG5). A regra mora em `dispatchSituation` (T13, com `SCHEDULE_GRACE_MS` de 2 h no front).

## Global Constraints

- **GG1. Escopo:** só `backend/src/modules/team-whatsapp/`, `backend/src/schemas/contracts/team-whatsapp.schema.ts`, `backend/prisma/`, `frontend/src/features/team-whatsapp/`, as rotas `frontend/src/routes/_authenticated/whatsapp-equipe/` e `frontend/src/release-notes.ts`. Sem chave de permissão nova: `equipe.enviar`, `equipe.disparo_amplo`, `telefone.ver_completo`. Envio direto a uma pessoa não ganha finalidade nem "data e hora".
- **GG2. Agendamento (spec G1):** "Novo momento 'Data e hora': qualquer data e hora futura, até 30 dias à frente, em todas as finalidades menos Urgência. O disparo precisa ser antes do início da atividade. Urgência agendada: 422. 'Início do turno' continua só no Aviso de turno com um turno." Fuso America/Manaus (`zonedStart`, `todayIn` de `backend/src/modules/staff-schedule/civil-date.ts`).
- **GG3. Política do agendamento (conselho T, spec G3):** "O público de um envio agendado é congelado na criação, em todas as finalidades: é a lista que o operador conferiu na prévia. Na hora do disparo o sistema reconfere essa lista com as mesmas regras da prévia, sobre a mesma data de referência, e só pode retirar pessoas, nunca acrescentar. Quem deixou de se enquadrar é pulado com o motivo: 'Férias', 'Folga', 'Saiu do setor ou turno' ou 'Inativa'. [...] Quem passou a se enquadrar depois do agendamento não recebe; quando o envio era para 'todos os aptos', o histórico lista essas pessoas como 'entraram depois do agendamento, não receberam'. [...] Se todos forem pulados, o histórico mostra 'ninguém recebeu', nunca sucesso. Se a reconferência falhar, nada é enviado e o sistema tenta de novo no minuto seguinte. Agendados criados antes desta versão disparam pela regra antiga." "Folga" só retira quem não estava de folga na criação e a folga não foi incluída; quem entrou por "Incluir folga" continua.
- **GG4. Invariantes do disparo (sentença T, consequência 3; spec G3):** só quem ganha o claim do agendado reconfere; só destinatários ainda `SCHEDULED` mudam de estado; nenhuma linha de destinatário é inserida (quem entrou depois fica em `audienceLateJoined`); dois ticks ao mesmo tempo resultam em um envio só; erro na reconferência não envia nada, nem parte, e o envio continua `SCHEDULED`. Teto: "agendado que não disparou até 2 horas depois da hora marcada não sai mais. O teto entra na mesma condição atômica que pega o agendado para disparar". Vale também para os antigos.
- **GG5. Antigos (spec Restrições):** "para disparar pela regra antiga, é o agendado sem política gravada (campo nulo)"; "Destinatário de envio antigo, sem telefone gravado, continua usando o telefone atual (inclusive no 'Repetir')".
- **GG6. Telefone (spec G4):** "No envio de cada mensagem (inclusive no 'Repetir'), se o telefone atual da pessoa não for o gravado, a mensagem não sai e o destinatário fica pulado com 'Telefone mudou depois da criação do envio'. Pulado não é falha: o 'Repetir' não o pega, e o histórico sugere criar um envio novo. O histórico mostra o número usado conforme `telefone.ver_completo`." Bloqueio e autorização continuam conferidos no envio.
- **GG7. Histórico (spec G5):** "Filtros no histórico: período (data de criação), finalidade e situação. Quem não é ADMIN continua vendo só os próprios. Paginação como hoje (20 por página). No detalhe: busca por nome entre os destinatários e os excluídos. A data de referência (`rosterDate`) aparece na lista." Sem busca no texto nem filtro por autor.
- **GG8. Dado pessoal:** nome, telefone, texto, local e motivo da urgência nunca em log, erro lançado ou trilha (`AuditService`). Trilhas levam ids e contagens. `audienceLateJoined` e `audienceExcluded` nunca levam telefone.
- **GG9. Validação:** cwd `backend/` ou `frontend/`. Loop `timeout 600 gate --test src/<arquivo>`; integração `TESTCONTAINERS_ENABLED=1 timeout 600 gate --test src/<arquivo>`. Tipos: back `npx tsc --noEmit -p tsconfig.build.json --tsBuildInfoFile /tmp/<task>.tsbuildinfo`; front `npx tsc -b`. Fechamento: back `TESTCONTAINERS_ENABLED=1 timeout 600 gate --changed --base feat/publico-finalidade`; front `timeout 600 gate --changed --base feat/publico-finalidade`. Nunca suíte inteira, gate completo, coverage ou e2e (da principal). No máximo dois testcontainers ao mesmo tempo (a principal serializa).
- **GG10. Tempo nos testes:** o disparo recebe `now` explícito (`fireDue(now)`, `claimScheduled(id, now, …)`); nada de `vi.setSystemTime` com linha gravada pelo banco; fixtures de período gravam `createdAt` explícito (bordas de dia em Manaus, `-04:00`). Telefones e nomes fictícios (`+5592991110001`, "Pessoa A").
- **GG11. Tamanho e legado:** funções e callbacks de `describe`/`it` até 50 linhas, complexidade 10, até 4 parâmetros; `describe` novos em arquivo novo ou irmãos (o que existe não cresce); conferir com `npx eslint <arquivos> --rule '{"max-lines-per-function": ["error", 50], "max-params": ["error", 4], "complexity": ["error", 10], "max-depth": ["error", 4]}'`. `prettier --write` só em arquivo novo; nunca restaurar arquivo do git. `team-whatsapp.service.ts` e `team-whatsapp.repository.ts` só recebem o que a task diz; lógica nova em arquivo novo.
- **GG12. Migração:** só aditiva, SQL escrito à mão com o cabeçalho do F (`backend/prisma/migrations/20261120120000_team_dispatch_purpose/migration.sql`: comentário do que faz, `SET LOCAL lock_timeout = '15s';`, DDL igual ao que `prisma migrate diff` gera); nome posterior a `20261120120000`; nunca `prisma migrate dev`/`reset` contra banco real; banco só o do testcontainer.
- **GG13. Compila entre tasks:** assinatura existente só ganha parâmetro/campo opcional, salvo onde a task diz e ajusta chamadores e specs no próprio ownership. Sem commit.
- **GG14. Nunca enviar WhatsApp real:** fila e porta do número falsas nos testes; o disparo do agendado é provado por integração, não por QA visual.

## Contratos compartilhados

**CG1. Rotas** (controller `team-whatsapp.controller.ts`; permissões e papéis de hoje).

| Rota | Muda |
|---|---|
| `POST /internal/team-whatsapp/dispatches/preview` e `POST dispatches` | corpo aceita `when: 'at'` + `at` (CG2); travas novas (CG4) |
| `GET dispatches` | query `from`, `to`, `purpose`, `state` (CG2); item com `state` incluindo `EXPIRED` |
| `GET dispatches/:id` | + `recheck` (CG3); `rule.when` pode ser `'at'` |
| `GET dispatches/:id/recipients` | query + `q`; item + `phone` (CG3) |

**CG2. Entradas** (`dto/create-team-dispatch.dto.ts`, `dto/dispatch-list-query.dto.ts` novo, `dto/dispatch-recipients-query.dto.ts`; o front espelha em `schemas.ts`).

```ts
// prévia e envio: when?: 'now' | 'shift_start' | 'at'
at?: { date: CivilDate; time: string /* HH:mm */ };   // obrigatório com when 'at'; proibido sem ele (400)
// alvo 'user' com when 'at' → 400. shift_start: regras de hoje.
// audienceRuleSnapshotSchema (JSON gravado) ganha when?: 'now' | 'shift_start' | 'at' (opcional; ausente = inferido, DG8)
// audienceLateJoinedSnapshotSchema = teamAudiencePersonSchema.array()   (parse descarta chaves fora do contrato, inclusive telefone)
dispatchListQuerySchema = pageQuerySchema.extend({
  from: civilDateSchema.optional(), to: civilDateSchema.optional(),
  purpose: teamPurposeSchema.optional(), state: teamDispatchStateSchema.optional(),
}).refine(from <= to quando os dois vêm)                                   // 400
dispatchRecipientsQuerySchema += { q?: string /* trim, 1..80; vazio depois do trim = ausente */ }
```

**CG3. Respostas** (`backend/src/schemas/contracts/team-whatsapp.schema.ts`).

```ts
teamDispatchStateSchema = z.enum(['DISPATCHED','SCHEDULED','CANCELLED','EXPIRED']);   // + EXPIRED: na T2 (o z.enum não depende do Prisma; o state: row.state de results.service.ts:182 só passa a incluir EXPIRED com o prisma generate da T1: erro de tipo esperado até as duas entrarem, Onda 1)
// lista de agendados (teamScheduledListResponseSchema, ~L484-490): item.shift passa a .nullable() (T2) — agendado em "data e hora" com vários ou todos os turnos não grava turno (sector-dispatch.ts:223); rosterDate continua obrigatório (sempre gravado no alvo setor, sector-dispatch.ts:225)
// motivo de pulo do destinatário (reason = skipReason ?? errorCode): + 'VACATION','DAY_OFF','LEFT_SECTOR','PHONE_CHANGED','EXPIRED'
// (conferir na T2 onde o contrato enumera os pulos — `dispatchResultSchema.skipped.reason` no front é NO_PHONE|SUPPRESSED|INACTIVE|NOT_AUTHORIZED)
teamAudienceRuleViewSchema.when = z.enum(['now','shift_start','at']);   // schedulePolicy já existe
// detalhe: + recheck: z.object({ at: z.string() /* ISO */, skipped: z.number().int(), lateJoined: teamAudiencePersonSchema.array() }).nullable().optional()
//   null = envio não reconferido (imediato, antigo, cancelado, vencido ou ainda agendado); skipped = destinatários com VACATION|DAY_OFF|LEFT_SECTOR|INACTIVE
// destinatário: + phone: z.string().nullable().optional()   // phoneView(phoneE164, { full: telefone.ver_completo }); null = não gravado (envio antigo)
// recheck e phone entram opcionais na T2 só para compilar entre tasks (GG13: detail() e recipients() de results.service.ts:165,200
// são tipados pelo contrato); a T11 preenche os dois sempre (nulo quando não há). O front trata ausente como nulo (.nullish()).
```

**CG4. Travas e erros novos** (`team-whatsapp.errors.ts`, `BLOCK_TEXT`).
- `schedule_in_past` com `when: 'at'`: "A data e a hora do envio já passaram." (no "início do turno" continua "O início deste turno já passou").
- `schedule_too_far` (nova trava, logo depois de `schedule_in_past`): "O envio pode ser agendado para até 30 dias à frente."
- `after_activity_start` vale também para "data e hora": "A mensagem precisa sair antes do início da atividade."
- Urgência com `'at'`: 422 `when_not_allowed` "Esta finalidade não pode ser enviada nesse momento." (já existe).

**CG5. Prisma** (T1): DG1.

**CG6. Reconferência pura** (`scheduled-recheck.ts`, T4).

```ts
export const SCHEDULE_GRACE_MS = 2 * 60 * 60 * 1000;
export type RecheckSkipReason = 'VACATION' | 'DAY_OFF' | 'LEFT_SECTOR' | 'INACTIVE';   // mesmos nomes do enum Prisma
export type FrozenRecipient = { id: string; userId: string | null; userActive: boolean };
export type LateJoinedPerson = { userId: string; name: string; sectorId: string; sectorName: string;
  shiftName: string | null; levelName: string | null };                           // sem telefone
export type RecheckPlan = { skips: { recipientId: string; reason: RecheckSkipReason }[]; lateJoined: LateJoinedPerson[] };
export function planRecheck(input: { frozen: readonly FrozenRecipient[]; recipientUserIds: ReadonlySet<string>;
  audience: Audience /* buildAudience, antes do telefone */; selectionWasAll: boolean }): RecheckPlan;
```

**CG7. Repositório do disparo** (T5, `team-whatsapp.repository.ts`).

```ts
export type ClaimedDispatch = { id: string; schedulePolicy: TeamSchedulePolicy | null; audienceBase: TeamAudienceBase | null;
  includeOff: boolean; rosterDate: CivilDate | null; sectors: { id: string; name: string }[]; audienceRule: unknown /* Json cru */;
  frozen: FrozenRecipient[] /* só SCHEDULED */; recipientUserIds: string[] /* todas as linhas */ };
export type RecheckFn = (claimed: ClaimedDispatch) => Promise<RecheckPlan>;   // quem passa fecha sobre o now do tick (T6b)
claimScheduled(id: string, now: Date, recheck?: RecheckFn): Promise<(ClaimResult & { rechecked?: { skipped: number; lateJoined: number } | null }) | null>;
//   rechecked opcional (GG13: o mock de team-whatsapp-scheduler.processor.spec.ts:50 devolve só { queuedIds, skipped, failed })
expireScheduled(id: string, now: Date): Promise<{ skipped: number } | null>;
cancelScheduled(id, actorId, now): Promise<boolean>;   // assinatura igual; transação passa a { timeout: 25_000, maxWait: 5_000 } (DG2, maior que os 20 s do claim)
// NewTeamDispatch + schedulePolicy?: TeamSchedulePolicy | null; NewTeamRecipient + phoneE164?: string | null;
// (o select do destinatário que o processor carrega, LoadedRecipient, fica em team-whatsapp-send.processor.ts:36-61: T9)
```

**CG8. Repositório do histórico** (T7).

```ts
export type DispatchListFilter = { createdFrom?: Date; createdBefore?: Date; purpose?: TeamDispatchPurpose; state?: TeamWhatsappDispatchState };
listDispatches(authorId: string | null, page: PageQuery, filter?: DispatchListFilter);      // where = authorId E filtro, no findMany e no count
listAllDispatchRecipients(dispatchId: string, status?: TeamWhatsappRecipientStatus);        // ordem userName asc, id asc; sem paginação
countRecheckSkips(dispatchId: string): Promise<number>;                                    // VACATION|DAY_OFF|LEFT_SECTOR|INACTIVE
// detalhe: select + recheckedAt, audienceLateJoined; destinatários: select + phoneE164
```

**CG9. Front** (T13). `DISPATCH_STATE_LABEL` = Enviado, Agendado, Cancelado, "Não enviado: passou da hora". `SKIP_REASON_LABEL` + `VACATION` "Férias", `DAY_OFF` "Folga", `LEFT_SECTOR` "Saiu do setor ou turno", `PHONE_CHANGED` "Telefone mudou depois da criação do envio", `EXPIRED` "Não enviado: passou da hora" (`INACTIVE` = "Inativa"). `dispatchSituation(item: { state; counts; scheduledFor }, now: Date)`: `EXPIRED`, ou `SCHEDULED` com `scheduledFor < now − SCHEDULE_GRACE_MS` (DG16, 2 h), → "Não enviado: passou da hora"; `DISPATCHED` com DG9 → "Ninguém recebeu"; senão o de hoje. `policyLabel(when, policy)`: `now` → "Envio imediato"; `frozen_recheck` → "Lista conferida agora; no disparo, quem deixar de se enquadrar é pulado e ninguém é acrescentado"; política nula com momento agendado → "Regra anterior: sai para a lista da criação, sem reconferência". `whenText`: `now` "Agora"; `shift_start` como hoje; `at` "Em {dd/mm/aaaa} às {HH:mm}" (de `scheduledFor`, Manaus). Lista de agendados: `ScheduledDispatch.shift` nulo (CG3); o `whenText` local de `scheduled-dispatches.tsx:18-20` usa data da escala + `shift.startTime` quando há turno e `scheduledFor` em Manaus ("dd/mm HH:mm") quando o turno é nulo. `useTeamDispatches(page, filters?)` com `queryKey ['team-whatsapp','dispatches', page, filters ?? {}]` (`filters` opcional, GG13: hoje é `(page)` em `api.ts:116` e `index.tsx` só passa filtros na T16); `useDispatchRecipients(id, { status, page, q })` com `q` opcional (o objeto já existe, `api.ts:203`).

## Review Focus

1. **Dois envios ou envio parcial no disparo:** reconferência dentro do claim; erro desfaz tudo. Testes: T5 `dois claims concorrentes: um vence e a reconferência roda uma vez`; `reconferência que lança: nada muda, segue SCHEDULED`; `claim e vencimento concorrentes: no máximo um vence`; T6b `erro na reconferência: nada enfileirado; o tick seguinte dispara`.
2. **Pessoa que deixou de se enquadrar recebendo:** T4 (cada motivo e a precedência); T6b `recheckAudience repassa todayIn(now)`; T10a/T10b (cenários T07 ponta a ponta, inclusive o disparo no dia seguinte ao `rosterDate`).
3. **Linha inserida ou linha não agendada mudando:** T5 `só linhas SCHEDULED mudam; nenhuma é inserida`.
4. **Telefone trocado:** T9 `PHONE_CHANGED sem Message`; `Repetir não pega o pulado`; `envio antigo usa o telefone atual`.
5. **Filtro ou busca furando o escopo:** T7 `gestor com filtros nunca vê envio de outro autor (findMany e count)`; T11 `busca sem telefone.ver_completo não acha nome mascarado pelo número`.
6. **"Ninguém recebeu" como sucesso:** T13 `dispatchSituation`; T10a `aceite 24`; T16/T17 rótulo.
7. **Dado pessoal em trilha/log:** T6b `trilhas scheduled_fire e scheduled_expired só com ids e contagens`; T9 nenhum telefone no log do pulo.

## Rastreio (aceite → task → teste)

| Aceite / item | Task | Teste |
|---|---|---|
| 20 | T8, T10b | T8 `data e hora grava scheduledFor em Manaus e FROZEN_RECHECK`; T10b `aceite 20: reunião daqui a 3 dias às 9h sai na hora para a lista da criação` |
| 21 | T4, T10a | `aceite 21: férias lançadas depois — pulado com Férias; os outros recebem; recheckedAt gravado` |
| 22 | T4, T10a | `aceite 22: todos os aptos — quem entrou depois não recebe e fica em audienceLateJoined` |
| 23 | T4, T10b | `aceite 23: reunião com Incluir folga e folga lançada depois — continua recebendo` |
| 24 | T10a, T13, T16, T17 | T10a `aceite 24: todos pulados — nada enfileirado, situações só SKIPPED`; T13 `dispatchSituation: Ninguém recebeu` |
| 25 | T5, T6b | Review Focus 1 |
| 26, 36 | T5, T6b, T13, T16, T17 | T5 `vencido há mais de 2 h: claim null`; T6b `aceite 26/36: vira EXPIRED, destinatários SKIPPED EXPIRED, nada enfileirado (novo e antigo)`; T13 `dispatchSituation: agendado vencido há mais de 2 h com o worker parado — passou da hora` (DG16); T16/T17 rótulo derivado |
| 27 | T5, T6b | `aceite 27: política nula dispara pela regra antiga, sem chamar a reconferência` |
| 28 | T9, T12 | T9 `aceite 28: agendado, pessoa troca de telefone, disparo — PHONE_CHANGED e os outros recebem`; `aceite 28: Repetir não pega o PHONE_CHANGED; FAILED repetido depois da troca vira PHONE_CHANGED`; T12 `aceite 28 ponta a ponta: criado pelo serviço, telefone igual — o processor envia para o gravado`; `aceite 28 ponta a ponta: troca depois da criação — PHONE_CHANGED, sem Message` |
| 29 | T15 | `aceite 29: preencher, mudar a hora — aviso; botão só libera com Preencher de novo ou Conferi o texto` |
| 30 | T3, T8, T14 | `aceite 30: reunião agendada para depois do início — after_activity_start` |
| 31 | T7, T11, T12, T16, T17 | `aceite 31: filtra por finalidade, período e situação; busca uma pessoa no detalhe` |
| 32 | T4, T10a | `aceite 32: troca de turno lançada depois — Saiu do setor ou turno` |
| 33 | T10b | `aceite 33: reunião e hora extra nominal com férias lançadas depois — Férias` |
| 34 | T4, T10b | `aceite 34: transferência de setor depois, envio por vínculo — Saiu do setor ou turno` |
| 35 | T6b, T10a | T6b `recheckAudience repassa todayIn(now) a loadDayPeopleMany`; T10a `aceite 35: turno noturno reconferido na data de referência gravada`; `aceite 35: disparo no dia seguinte ao rosterDate usa o vínculo da data de referência` |
| 37 | T2, T3, T8, T14 | T3 `schedule_too_far e urgência com at`; T8 `aceite 37: 422 com o texto` |
| 38 | T9 | T9 `aceite 38: Repetir em envio antigo sem telefone gravado usa o atual` |
| 39 | T4, T10a | `aceite 39: folga lançada depois no aviso de turno — Folga` |
| Herdado 1 (`PHONE_EXCLUSIONS`) | T17 | `DG10: No público conta a foto da criação; pulados da reconferência não entram em Ficaram de fora` |
| Herdado 2 (painel "Agora") | T14 | `painel mostra a data e hora escolhidas` |
| Herdado 3 (aceite 12 com data passada) | T12 | `aceite 12: muda vínculo e nome do turno depois — detalhe igual` |
| Herdado 4 (`policyLabel`) | T13 | `policyLabel nas três políticas` |
| Herdado 5 (`notifyDone`) | T14 | `aviso de agendado com a data e hora da prévia confirmada` |
| Sentença 2 (schema) | T1 | migração |
| Sentença 3 (invariantes) | T5, T6b | Review Focus 1 e 3 |
| Sentença 4 (T07, um teste cada) | T10a, T10b | aceites 21–24, 32–35, 39 |
| Sentença 5 (antigo pendente) | T5, T6b | aceite 27 |
| Sentença 9 (teto) | T5, T6b | aceites 26, 36 |
| Extração da classificação (prévia e envio iguais) | T6a | `classifyPeople dá o mesmo resultado que a prévia`; specs do F sem mudar asserção |
| DG4 troca de nível | T4 | `troca de nível depois — LEFT_SECTOR` |
| DG7 telefone apagado | T9 | `telefone apagado depois da criação — NO_PHONE, não PHONE_CHANGED` |
| G3 "envio agora grava a política" | T8 | `agora grava IMMEDIATE` |
| G4 telefone gravado na criação | T8 | `grava phoneE164 de cada destinatário (setor e pessoa)` |
| G5 `rosterDate` na lista | T16 | `coluna Data de referência` |
| G1/G3 "só cancelar e criar de novo" (agendado em data e hora sem turno) | T2, T6b, T13, T16 | T2 `item da lista de agendados aceita shift nulo`; T6b `agendado em data e hora com todos os turnos aparece na lista e cancela`; T13 `whenText dos agendados: com turno e sem turno (scheduledFor em Manaus)`; T16 `agendado em data e hora na lista de agendados` |
| DG7 um `sendPhoneOf` só | T9, T12 | T9 `processor usa o sendPhoneOf de recipient-skip: contato ligado vale por cima do usuário`; T12 `aceite 28 ponta a ponta: criado pelo serviço…` (pessoa com contato ligado e telefone de usuário diferentes) |
| DG2 cancelamento durante a reconferência | T5 | `cancelar durante uma reconferência lenta (6 s) devolve false e o envio fica DISPATCHED, sem P2028` |

## Mapa de arquivos

- Criar (back, `backend/src/modules/team-whatsapp/`): `scheduled-recheck.ts` (T4, puro), `scheduled-recheck.runner.ts` (T6b, `recheckAudience`), `audience-people.ts`, `dto/dispatch-list-query.dto.ts` e specs; `team-whatsapp.schedule-claim.integration.spec.ts`, `team-whatsapp-schedule.recheck.spec.ts`, `team-whatsapp.schedule-recheck.integration.spec.ts`, `team-whatsapp.schedule-recheck.test-fixtures.ts`, `team-whatsapp.recheck-on-duty.integration.spec.ts`, `team-whatsapp.recheck-assigned.integration.spec.ts`, `team-whatsapp.phone-frozen.integration.spec.ts`, `team-dispatch-history.integration.spec.ts`, `team-dispatch-schedule.migration.integration.spec.ts`, `team-whatsapp.service.schedule-at.spec.ts`, `team-whatsapp-results.service.search.spec.ts`, `team-whatsapp.service.list-filters.spec.ts`; `backend/src/schemas/contracts/team-whatsapp.schema.expired.spec.ts` (T2); migração `backend/prisma/migrations/20261120130000_team_dispatch_schedule_recheck/migration.sql`.
- Modificar (back): `backend/prisma/schema.prisma`; `schemas/contracts/team-whatsapp.schema.ts`; `dto/create-team-dispatch.dto.ts`, `dto/dispatch-recipients-query.dto.ts`; `team-whatsapp.errors.ts`; `team-whatsapp.purpose.ts`; `team-whatsapp.purpose-codes.ts`; `team-whatsapp.repository.ts`; `team-whatsapp-schedule.service.ts`; `team-whatsapp-scheduler.processor.spec.ts` (T6b, só a asserção da chamada); `team-audience.service.ts`; `team-whatsapp.sector-dispatch.ts`; `team-whatsapp.service.ts`; `team-whatsapp-send.processor.ts`; `recipient-skip.ts`; `team-whatsapp-results.service.ts`; `dispatch-purpose-view.ts`; `team-whatsapp.controller.ts`; specs citados nas tasks.
- Criar (front, `frontend/src/features/team-whatsapp/`): `components/send-moment.tsx`, `message-draft.ts`, `name-search.ts`, `components/recheck-summary.tsx` e specs; specs novos `send-whatsapp-dialog.schedule.spec.tsx`, `send-whatsapp-dialog.draft.spec.tsx`, `recent-dispatches.filters.spec.tsx`, `dispatch-result.recheck.spec.tsx`.
- Modificar (front): `schemas.ts`, `api.ts`, `labels.ts`, `error-messages.ts`, `purpose.ts`, `use-send-filters.ts`, `use-audience-preview.ts` (se preciso), `components/{send-whatsapp-dialog,rule-panel,recent-dispatches,dispatch-result,recipient-table,scheduled-dispatches}.tsx`, `routes/_authenticated/whatsapp-equipe/index.tsx`, `release-notes.ts`, specs.

## Ordem e paralelismo

```
Onda 1:  T1 (migração)   T2 (contrato, DTOs, erros)   T4 (reconferência pura)   T13 (front: esquemas, api, rótulos)
Onda 2:  T3 (regras: data e hora) <- T2    T5 (repositório do disparo) <- T1, T2, T4
         T6a (extração de audience-people.ts) <- nenhuma
         T14 (front: momento e prévia com momento) <- T13    T17 (front: detalhe) <- T13
Onda 3:  T7 (repositório do histórico) <- T1, T2, T5    T8 (envio: data e hora, política, telefone) <- T2, T3, T5, T6a
         T9 (processor: telefone congelado) <- T1, T5    T15 (front: rascunho do texto) <- T14    T18 (Novidades)
Onda 4:  T6b (reconferência no disparo e vencimento) <- T4, T5, T6a, T8    T11 (histórico: filtros, busca, reconferência) <- T2, T7
         T16 (front: lista com filtros) <- T13, T15
Onda 5:  T10a (cenários T07, base em serviço) <- T6b, T8    T10b (cenários T07, base vinculada) <- T6b, T8
Onda 6:  T12 (ponta a ponta do histórico e do telefone) <- T6b, T8, T9, T11
```

- **T1 × T2 na Onda 1 (decisão da coordenação, revisão 2):** a Onda 1 continua paralela e `team-whatsapp.schema.ts` é **só da T2** (inclusive o `EXPIRED` de `teamDispatchStateSchema` e o spec dele). Acrescentar valor a um `z.enum` compila com o client antigo; só o `prisma generate` da T1 exige o valor no contrato. Por isso a T1 roda sem tocar no contrato e **registra como esperado** no report o erro de tipo em `team-whatsapp-results.service.ts:182` (`state: row.state` com `EXPIRED` contra o enum do contrato) enquanto a T2 não entrou; nenhuma das duas corrige arquivo da outra. A principal confere o `tsc` do back no fim da Onda 1, com as duas integradas, e só então abre a Onda 2.
- **Compila entre tasks (GG13), conferido task a task sobre o estado das ondas anteriores:** T1 não toca no contrato (erro esperado acima, só dentro da Onda 1); T2 leva o `EXPIRED` do contrato, deixa `recheck`/`phone` opcionais e `shift` nulo no item da lista de agendados (o `toScheduledItem` de hoje devolve turno não nulo, que cabe no tipo mais largo); T3 só acrescenta entradas opcionais ao `blocksFor`; T5 deixa `rechecked` opcional e não afirma o estado do "vencido há 3 h" (a T6b passa a vencê-lo); T6a não muda assinatura pública; T8 grava `FROZEN_RECHECK` antes da T6b ligar a reconferência, sem quebrar nada: os specs que disparam (`schedule.integration.spec.ts`) semeiam por `seedScheduled` com política nula, e o processor do scheduler usa mocks; T9 semeia o telefone gravado direto no banco (não depende da T8, da mesma onda); T6b é dona de `team-whatsapp-scheduler.processor.spec.ts` (asserção `['d1', NOW]` em `:60-62`); T13 deixa `filters` e `q` opcionais e, como o `shift` nulo no esquema quebra `item.shift.startTime` de `scheduled-dispatches.tsx:19`, troca na mesma task o `whenText` local (CG9); T14 e T15 acrescentam props ao diálogo e ajustam só o helper de render de `send-whatsapp-dialog.spec.tsx`. Entre T3 e T8 a matriz já aceita `'at'` e o serviço ainda o trataria como "agora": nada é publicado entre ondas, e a T8 fecha o caminho.
- **Ownership disjunto por onda:** Onda 1 — T1: `prisma/schema.prisma`, pasta da migração, `team-dispatch-schedule.migration.integration.spec.ts` (e só as entradas novas em mapas exaustivos que o `tsc` acusar fora do contrato, listadas no report); T2: `schemas/contracts/team-whatsapp.schema.ts` inteiro (+ spec e o novo `team-whatsapp.schema.expired.spec.ts`), `dto/create-team-dispatch.dto.ts`, `dto/dispatch-recipients-query.dto.ts`, `dto/dispatch-list-query.dto.ts` (novo) e specs, `team-whatsapp.errors.ts` (+ spec); T4: `scheduled-recheck.ts` e spec; T13: `schemas.ts`, `api.ts`, `labels.ts`, `error-messages.ts`, `purpose.ts` e specs, e só a troca de `STATE_LABEL` por `DISPATCH_STATE_LABEL` em `recent-dispatches.tsx` e `dispatch-result.tsx`, e só o `whenText` local de `scheduled-dispatches.tsx` (+ spec). Nenhum arquivo em duas tasks da Onda 1. Onda 2 — T3: `team-whatsapp.purpose.ts` e spec; T5: `team-whatsapp.repository.ts` (inclui o `timeout` do `cancelScheduled`), `team-whatsapp.purpose-codes.ts` (+ spec), `team-whatsapp.schedule-claim.integration.spec.ts` (novo), em `team-whatsapp.schedule.integration.spec.ts` só o `it` do vencido há 3 h (e, se o grep da T5 achar, só a data de fixture vencida há mais de 2 h em outro `it`, listada no report); T6a: `audience-people.ts` (novo) e `audience-people.spec.ts`, `team-audience.service.ts` (só troca `classifyAll`/`shiftNamesOf` pela função extraída); T14: `use-send-filters.ts`, `use-audience-preview.ts`, `components/send-whatsapp-dialog.tsx`, `components/send-moment.tsx` (novo), `components/rule-panel.tsx`, `routes/.../whatsapp-equipe/index.tsx` (só o repasse do momento ao diálogo), em `send-whatsapp-dialog.spec.tsx` só o helper de render (props novas) e specs novos; T17: `components/dispatch-result.tsx`, `components/recipient-table.tsx`, `components/recheck-summary.tsx` (novo), `name-search.ts` (novo) e specs. Onda 3 — T7: `team-whatsapp.repository.ts` e `team-dispatch-history.integration.spec.ts` (novo); T8: `team-whatsapp.sector-dispatch.ts`, `team-whatsapp.service.ts` (só `sectorDraft`, `scheduled`, `dispatchNow` e a montagem do destinatário do alvo pessoa), `team-audience.service.ts` (só `scheduledForOf`/`ruleViewOf`; a T6a já passou por ele na Onda 2), `team-whatsapp.service.schedule-at.spec.ts` (novo) e as asserções de `schedulePolicy` nulo listadas na task; T9: `team-whatsapp-send.processor.ts` (inclui o `recipientSelect`/`LoadedRecipient`, `:36-61`), `recipient-skip.ts` (só se o tipo do `sendPhoneOf` precisar abrir), specs, `team-whatsapp.phone-frozen.integration.spec.ts` (novo); T15: `message-draft.ts` (novo), `components/send-whatsapp-dialog.tsx`, `routes/.../whatsapp-equipe/index.tsx` (só o hook do rascunho), em `send-whatsapp-dialog.spec.tsx` só o helper de render (props novas) e specs novos; T18: `frontend/src/release-notes.ts` (+ spec se precisar). Onda 4 — T6b: `team-whatsapp-schedule.service.ts` (`fireDue`, `fireOne`, `toScheduledItem`), `scheduled-recheck.runner.ts` (novo, `recheckAudience`; `scheduled-recheck.ts` não muda), `team-whatsapp-scheduler.processor.spec.ts` (só a asserção da chamada ao `claimScheduled`), specs novos e `team-whatsapp.schedule-recheck.test-fixtures.ts`; T11: `team-whatsapp.controller.ts`, `team-whatsapp.service.ts` (só `listDispatches`), `team-whatsapp-results.service.ts`, `dispatch-purpose-view.ts` e specs novos; T16: `components/recent-dispatches.tsx`, `components/scheduled-dispatches.tsx` (o `whenText` já veio da T13; aqui só o rótulo DG16 e os testes da lista), `routes/.../whatsapp-equipe/index.tsx` (só `RecentSection`) e specs. Onda 5 — T10a e T10b: um arquivo de integração cada. Onda 6 — T12: `team-dispatch-history.e2e.integration.spec.ts` (novo).
- **Gate conjunto:** com tasks paralelas, o `--changed` de uma mede o diff das outras; falha só de arquivo alheio vai para o report. A principal roda o `--changed` conjunto (back e front) depois de cada onda. A T1 roda `npx prisma generate`, que muda os tipos para todos: o erro de `results.service.ts:182` é esperado no report da T1 enquanto a T2 não entrou; a principal confere o `tsc` do back depois da Onda 1 (zero erro com T1 e T2 integradas).
- **Revisão** (SKILL.md do sdd, §Revisão por risco): críticas com revisor `opus` — T7, T11. Altas com `opus` (decisão da coordenação: migração, contrato público e concorrência do disparo) — T1, T2, T5, T6b. Altas com `sonnet` — T3, T4, T8, T9, T10a, T10b, T12, T14. Médias — T6a, T13, T15, T16, T17. Baixa — T18 (`mecanico`). Total **20 tasks** (2 críticas, 12 altas, 5 médias, 1 baixa) em 6 ondas.

---

## Task 1 — Migração do agendamento e do telefone (back)

**Arquivos:** modificar `backend/prisma/schema.prisma`; criar `backend/prisma/migrations/20261120130000_team_dispatch_schedule_recheck/migration.sql` e `backend/src/modules/team-whatsapp/team-dispatch-schedule.migration.integration.spec.ts`. **Não toca** `backend/src/schemas/contracts/team-whatsapp.schema.ts` (é da T2, inteiro).

**Interfaces:** consome os modelos `TeamWhatsappDispatch` (~L1769), `TeamWhatsappRecipient` (~L1843) e os enums `TeamWhatsappDispatchState` (~L1713) e `TeamWhatsappSkipReason` (~L1736). Produz CG5/DG1 e o client gerado.

**Contexto vinculado:**
- DG1: `TeamWhatsappDispatchState` + `EXPIRED`; `TeamWhatsappSkipReason` + `VACATION`, `DAY_OFF`, `LEFT_SECTOR`, `PHONE_CHANGED`, `EXPIRED`; `TeamWhatsappDispatch` + `recheckedAt DateTime?`, `audienceLateJoined Json?`; `TeamWhatsappRecipient` + `phoneE164 String?`; `@@index([state, createdAt])` e `@@index([purpose, createdAt])` no `TeamWhatsappDispatch`. Comentário curto em cada coluna (o que é; `null` = envio antigo ou não reconferido).
- GG12: só aditiva; SQL à mão com o cabeçalho do F (comentário do que faz, `SET LOCAL lock_timeout = '15s';`, DDL igual ao `prisma migrate diff`); nunca `migrate dev`/`reset`.
- `ALTER TYPE ... ADD VALUE` exige Postgres ≥ 12 dentro de transação e o valor novo não pode ser usado na mesma transação: conferir a versão da imagem do testcontainers e do `docker-compose` e registrar no report; a migração não usa os valores novos.
- `CREATE INDEX` (sem `CONCURRENTLY`, dentro da transação) bloqueia escrita na tabela enquanto cria; a tabela é pequena; o `lock_timeout` cobre a espera. Escrever isso no cabeçalho.
- GG13 (assinatura existente só ganha parâmetro/campo opcional; a task ajusta o que quebra no próprio ownership) e decisão da Onda 1: depois do `prisma generate`, `state: row.state` de `team-whatsapp-results.service.ts:182` passa a incluir `EXPIRED`, que o contrato só aceita com o enum novo. O `EXPIRED` de `teamDispatchStateSchema` é da **T2**, em paralelo nesta onda: se a T2 ainda não entrou, esse erro de tipo é **esperado** — registrar no report ("erro esperado em results.service.ts:182 até a T2") e não corrigir; nenhum outro erro de `tsc` é aceito. A principal confere o `tsc` do back no fim da Onda 1. Se o `tsc` acusar outro mapa ou `switch` exaustivo sobre `TeamWhatsappSkipReason`/`TeamWhatsappDispatchState` fora do contrato, acrescentar só a entrada nova (mesmo texto em maiúsculas do valor) e listar no report.
- O `--changed` desta task pode acusar o mesmo erro de tipo (e o diff da T2, se já estiver na árvore): falha só por isso vai para o report, não bloqueia a task.

**Passos:**
1. [ ] RED (padrão de `team-dispatch-purpose.migration.integration.spec.ts`): `it('envio e destinatário anteriores ficam com recheckedAt, audienceLateJoined e phoneE164 nulos')`; `it('aceita EXPIRED no envio e os cinco motivos novos no destinatário')`; `it('nenhuma coluna nova é obrigatória')`; `it('índices de state e purpose com createdAt existem')` (consulta `pg_indexes`).
2. [ ] GREEN: schema e SQL.
3. [ ] `npx prisma generate`; `npx prisma validate`; teste de integração; typecheck (único erro tolerado: `results.service.ts:182`, se a T2 ainda não entrou; registrar); `--changed`.

**Aceite:** sentença item 2; base de 21–39. **Risco: alto** (migração não destrutiva).
**Crítico: migração — acrescenta 6 valores de enum, 3 colunas nulas e 2 índices, sem tocar linha existente.**

## Task 2 — Contrato, DTOs e travas novas (back)

**Arquivos:** modificar `backend/src/schemas/contracts/team-whatsapp.schema.ts` inteiro (+ spec), inclusive o enum `teamDispatchStateSchema` (~L45-51) e o item de `teamScheduledListResponseSchema` (~L484-490); criar `backend/src/schemas/contracts/team-whatsapp.schema.expired.spec.ts`; `dto/create-team-dispatch.dto.ts` e spec (`describe` novo irmão), `dto/dispatch-recipients-query.dto.ts` e spec; criar `dto/dispatch-list-query.dto.ts` e spec; modificar `team-whatsapp.errors.ts` (+ spec).

**Interfaces:** consome `civilDateSchema`, `pageQuerySchema` (`dto/page-query.dto.ts`), `teamPurposeSchema`. Produz CG2, CG3, CG4 (`BLOCK_TEXT` com `schedule_too_far` e o texto de `schedule_in_past` para `'at'`; `DispatchListQueryDto`), `audienceLateJoinedSnapshotSchema` e o campo `when` opcional em `audienceRuleSnapshotSchema`.

**Contexto vinculado:**
- DG8: `when: 'at'` + `at: { date, time 'HH:mm' }`; `at` obrigatório com `'at'` e proibido sem ele (400); alvo pessoa com `'at'` → 400; o momento fica gravado em `audienceRule.when` (opcional; ausente = `scheduledFor ? 'shift_start' : 'now'`).
- DG14: `from`/`to` dia civil, opcionais; `from > to` → 400; `purpose` uma das 6; `state` `SCHEDULED | DISPATCHED | CANCELLED | EXPIRED`; `page`/`pageSize` como `pageQuerySchema`.
- DG13: `q` aparado, 1..80; vazio depois de aparar = ausente.
- CG3 inteiro: `teamDispatchStateSchema = z.enum(['DISPATCHED','SCHEDULED','CANCELLED','EXPIRED'])` com o comentário "EXPIRED = agendado que não disparou até 2 horas depois da hora marcada"; motivos novos; `rule.when` com `'at'`; `recheck` no detalhe; `phone` no destinatário; `shift` `.nullable()` no item de `teamScheduledListResponseSchema` (agendado em "data e hora" com vários ou todos os turnos não grava turno, `sector-dispatch.ts:223`; `rosterDate` continua obrigatório: o alvo setor sempre o grava, `sector-dispatch.ts:225`). Nunca `prettier --write` no arquivo (legado).
- Onda 1: o `z.enum` com `EXPIRED` compila com o client antigo; a T1 (paralela) roda o `prisma generate` e, até esta task entrar, tem um erro de tipo esperado em `results.service.ts:182`. Esta task não toca `prisma/` nem `results.service.ts`.
- GG13: `recheck` (`.nullable().optional()`) e `phone` (`.nullable().optional()`) entram **opcionais**, porque `detail()` e `recipients()` de `team-whatsapp-results.service.ts:165,200` são tipados pelo contrato e só os preenchem na T11 (Onda 4). Comentário no contrato: "opcional só até a T11; a API devolve sempre, nulo quando não há".
- CG4: textos exatos. GG8: `audienceLateJoinedSnapshotSchema` descarta telefone.
- O serviço de hoje não trata `'at'`: até a T3, `assertPurposeRules` recusa `'at'` com 422 `when_not_allowed` (a matriz ainda não o tem), então nada agenda errado no meio do caminho.

**Passos:**
1. [ ] RED DTO de envio: `it('when at exige at com data e HH:mm; at sem when at é recusado')`; `it('alvo pessoa com when at é 400')`; `it('prévia aceita when at')`.
2. [ ] RED query: `it('lista aceita from, to, purpose e state, inclusive EXPIRED; from depois de to é 400')`; `it('state desconhecido é 400')`; `it('q aparado; só espaços vira ausente; 81 caracteres é 400')`.
3. [ ] RED contrato e erros: em `team-whatsapp.schema.expired.spec.ts`, `it('teamDispatchStateSchema aceita EXPIRED')`; `it('item da lista de agendados aceita shift nulo')`; `it('detalhe valida recheck ausente, nulo e preenchido')`; `it('destinatário aceita phone ausente e nulo')`; `it('audienceLateJoinedSnapshotSchema descarta telefone')`; `it('audienceRuleSnapshotSchema aceita when ausente')`; `it('BLOCK_TEXT tem schedule_too_far e o texto de data e hora já passadas')`.
4. [ ] GREEN; validação; `--changed`.

**Aceite:** contrato de 20, 26, 31, 37. **Risco: alto** (contrato público).
**Crítico: contrato público de API — corpo do envio e da prévia com "data e hora", query nova da lista e da busca, campos novos no detalhe e nos destinatários.**

## Task 3 — Regras de "data e hora" e travas (back, puro)

**Arquivos:** modificar `backend/src/modules/team-whatsapp/team-whatsapp.purpose.ts` e `team-whatsapp.purpose.spec.ts` (`describe` novo irmão).

**Interfaces:** consome T2 (`BLOCK_TEXT`, tipos), `zonedStart`/`todayIn`. Produz `PURPOSE_RULES[*].when` com `'at'` (todas menos `urgency`), `scheduledForOf(input: { request: TeamAudienceRequest; date: CivilDate; shifts: readonly ShiftRef[] }): Date | null` (agora → null; `shift_start` → `zonedStart(date, shift.startTime)` do único turno; `at` → `zonedStart(at.date, at.time)`), `policyOf(when): 'immediate' | 'frozen_recheck'` e `blocksFor` com as travas novas.

**Contexto vinculado:**
- GG2: "qualquer data e hora futura, até 30 dias à frente, em todas as finalidades menos Urgência. O disparo precisa ser antes do início da atividade. Urgência agendada: 422."
- DG8: 30 dias = `at.date <= todayIn(now) + 30` (Manaus); `schedule_in_past` quando `scheduledFor <= now` com o texto do momento (CG4); `schedule_too_far` logo depois de `schedule_in_past`; Urgência com `'at'` → `when_not_allowed` (já sai de `assertPurposeRules` pela matriz).
- DG6: `policyOf('now') = 'immediate'`; `shift_start` e `at` → `'frozen_recheck'`.
- CF4 do F (ordem das travas): `empty_text`, `missing_activity`, `missing_urgency_reason`, `overtime_without_selection`, `schedule_in_past`, (`schedule_too_far`), `after_activity_start`, `no_recipients`, `sector_without_number`.
- `blocksFor` continua puro (sem banco); `now` vem do chamador.
- GG13: o que o `blocksFor` precisar a mais para `schedule_too_far` (data do `at`) entra como campo **opcional** da entrada ou é derivado do `request` que ele já recebe; os chamadores de hoje (serviço e prévia) compilam sem mudança até a T8. Entre esta task e a T8 a matriz já aceita `'at'` e o serviço ainda o trataria como "agora"; nada é publicado entre ondas e a T8 fecha o caminho (registrar no report).

**Passos:**
1. [ ] RED: `it('PURPOSE_RULES: at em todas menos Urgência')`; `it('aceite 37: urgência com at — when_not_allowed')`; `it('scheduledForOf: agora null; início do turno; at em Manaus (-04:00)')`; `it('at no passado trava com A data e a hora do envio já passaram.')`; `it('aceite 37: at.date = hoje + 31 trava schedule_too_far; hoje + 30 às 23:59 passa')`; `it('aceite 30: reunião com at depois do início da atividade trava after_activity_start; igual ao início também')`; `it('policyOf nos três momentos')`; `it('ordem das travas com schedule_too_far')`.
2. [ ] GREEN; validação; `--changed`.

**Aceite:** 30, 37 (regra). **Risco: alto** (decide o que trava o agendamento).
**Crítico: validação de rota pública — travas do agendamento (422 de `POST dispatches` e da prévia: `schedule_in_past`, `schedule_too_far`, `after_activity_start`, `when_not_allowed`).**

## Task 4 — Plano da reconferência (back, puro)

**Arquivos:** criar `backend/src/modules/team-whatsapp/scheduled-recheck.ts` e `scheduled-recheck.spec.ts` (`describe` irmãos: motivos, precedência, entraram depois).

**Interfaces:** consome `Audience`/`AudienceEntry` (`team-whatsapp.audience.ts`, `audience-classify.ts`; CF6 do F). Produz CG6 (`planRecheck`, `SCHEDULE_GRACE_MS`, tipos).

**Contexto vinculado:**
- DG4 inteiro (precedência `INACTIVE` → fica se incluído → `VACATION` → `DAY_OFF` → `LEFT_SECTOR` para `other_sector`/`other_shift`/`not_selected` ou ausente; público antes do telefone; "entraram depois" só com `selectionWasAll`, só quem não tem nenhuma linha no envio, sem telefone, ordenado pelo nome).
- GG3: "só pode retirar pessoas, nunca acrescentar"; "Folga só retira quem não estava de folga na criação e a folga não foi incluída; quem entrou por 'Incluir folga' continua" (com `includeOff`, quem está de folga vem entre os incluídos do público recalculado e fica).
- GG4: o plano só cita `recipientId` de `frozen` (linhas `SCHEDULED`); nunca cria pessoa nova para receber.
- Função pura, sem I/O; `AudienceEntry.member` tem `id` e `name`.
- DG4 (troca de nível): quem trocou de nível depois do agendamento e saiu do filtro de nível gravado fica ausente do público recalculado (ou `not_selected`) e sai como `LEFT_SECTOR` "Saiu do setor ou turno"; sem quinto motivo.

**Passos:**
1. [ ] RED: `it('aceite 21: incluído na criação e de férias agora — VACATION')`; `it('troca de nível depois, fora do filtro gravado — LEFT_SECTOR')`; `it('aceite 39: de folga agora sem includeOff — DAY_OFF')`; `it('aceite 23: de folga agora com includeOff — fica')`; `it('aceite 32: outro turno — LEFT_SECTOR')`; `it('aceite 34: ausente do público — LEFT_SECTOR')`; `it('inativo ou sem usuário — INACTIVE, antes de qualquer outro motivo')`; `it('excluído por telefone no recálculo não é pulado aqui')` (o recálculo é antes do telefone: entrada incluída fica); `it('aceite 22: todos os aptos — incluído novo sem linha vai para lateJoined, sem telefone, ordenado')`; `it('seleção nominal — lateJoined vazio')`; `it('quem já tem linha SKIPPED de telefone não entra em lateJoined')`; `it('nenhum skip cita recipientId fora de frozen')`.
2. [ ] GREEN; validação; `--changed`.

**Aceite:** 21, 22, 23, 32, 34, 39 (regra). **Risco: alto** (decide quem é retirado).

## Task 5 — Repositório do disparo: claim com reconferência, teto e vencimento (back)

**Arquivos:** modificar `backend/src/modules/team-whatsapp/team-whatsapp.repository.ts` (`claimScheduled`, `expireScheduled` novo, `applyRecheck` e `loadClaimed` privados, `NewTeamDispatch`/`NewTeamRecipient`, gravação do envio, só as opções da transação de `cancelScheduled` ~L817-834) e `team-whatsapp.purpose-codes.ts` (+ spec: `toDbPolicy`); criar `team-whatsapp.schedule-claim.integration.spec.ts`; em `team-whatsapp.schedule.integration.spec.ts`, **só** o `it` "worker fora, vencido há 3 h dispara no próximo tick" (`describe('hora do disparo')`, ~L300-308), que vira "vencido há 3 h não dispara": `fireDue(tick)` → `{ fired: 0 }` e nada enfileirado, **sem afirmar o estado do envio** (a T6b passa a vencê-lo para `EXPIRED`). Antes do RED, `rg -n "seedScheduled|scheduledFor" team-whatsapp.schedule.integration.spec.ts` para achar outro `it` com agendado vencido há mais de 2 h; se houver, mudar só a data da fixture e listar no report.

**Interfaces:** consome T1 (client), T2 (`audienceLateJoinedSnapshotSchema`), T4 (`RecheckPlan`, `FrozenRecipient`, `SCHEDULE_GRACE_MS`). Produz CG7. `fireOne` continua chamando `claimScheduled(id, now)` sem a função (GG13; a T6b passa a função). O select do destinatário que o processor carrega (`LoadedRecipient`) **não** é desta task: fica em `team-whatsapp-send.processor.ts:36-61` (T9).

**Contexto vinculado:**
- DG2: dentro do `$transaction(fn, { timeout: 20_000, maxWait: 5_000 })`: (1) `updateMany where { id, state: 'SCHEDULED', scheduledFor: { lte: now, gte: now − SCHEDULE_GRACE_MS } }` → `DISPATCHED`, `firedAt: now`; `count 0` → `null`; (2) `loadClaimed(tx, id)` (política, base, `includeOff`, `rosterDate`, setores de `TeamWhatsappDispatchSector` com nome, `audienceRule` cru, `frozen` = destinatários `SCHEDULED` com `userId` e `user.isActive`, `recipientUserIds` de todas as linhas); (3) política `FROZEN_RECHECK`: sem `recheck` → lança; com → `plan = await recheck(claimed)` e `applyRecheck(tx, id, plan, now)`; política nula → pula; (4) `failUnavailable`; (5) `queueActive`. Lançou em qualquer passo → rollback inteiro.
- `applyRecheck`: por motivo, `updateMany where { dispatchId: id, status: 'SCHEDULED', id: { in } }` → `SKIPPED` + `skipReason`; envio `recheckedAt: now`, `audienceLateJoined: plan.lateJoined` (validado por `audienceLateJoinedSnapshotSchema`). Nunca `create`.
- DG5: `expireScheduled(id, now)` em transação: `updateMany where { id, state: 'SCHEDULED', scheduledFor: { lt: now − SCHEDULE_GRACE_MS } }` → `EXPIRED`; destinatários `SCHEDULED` → `SKIPPED EXPIRED`; devolve `{ skipped }` ou `null`. Exatamente 2 h de atraso ainda é claim.
- GG4: só quem ganha o claim do agendado reconfere; só destinatários ainda `SCHEDULED` mudam de estado; nenhuma linha de destinatário é inserida (quem entrou depois fica em `audienceLateJoined`); dois ticks ao mesmo tempo resultam em um envio só; erro na reconferência não envia nada, nem parte, e o envio continua `SCHEDULED`; teto de 2 h na mesma condição atômica, vale também para os antigos.
- DG6: `FROZEN_RECHECK` sem `RecheckFn` → o claim lança e nada muda; política nula → regra antiga (`failUnavailable` + `queueActive`), sem reconferência. DG7: `NewTeamRecipient.phoneE164` gravado como vier.
- GG13: `rechecked` entra **opcional** no retorno do `claimScheduled` (o mock de `team-whatsapp-scheduler.processor.spec.ts:50` devolve só `{ queuedIds, skipped, failed }`); o parâmetro `recheck` também é opcional.
- DG2 (leitura fora da transação): a `RecheckFn` pode consultar por outra conexão; o repositório não passa o `tx` para ela e só grava os pulos pelo `tx`.
- DG2 (cancelamento durante a reconferência): o cancelamento espera o lock da linha que o claim segura por até 20 s; com o `timeout` padrão de 5 s cairia em P2028 e a rota devolveria 500 em vez de 409. `cancelScheduled` passa a `$transaction(fn, { timeout: 25_000, maxWait: 5_000 })` (maior que o do claim); corpo e assinatura iguais.
- `queueActive` (`:1115-1137`) filtra o último `updateMany` só por `id in queuedIds`; dentro da transação continua seguro (mapa); não mexer além do necessário.
- GG10: `now` explícito; GG11.

**Passos:**
1. [ ] RED (`team-whatsapp.schedule-claim.integration.spec.ts`, Postgres real, `describe` irmãos de até 50 linhas): `it('dois claims concorrentes: um vence e a reconferência roda uma vez')` (função com espera de 200 ms; `Promise.all`; espião chamado 1 vez); `it('reconferência que lança: envio SCHEDULED sem firedAt, destinatários iguais, recheckedAt nulo; o claim seguinte vence')`; `it('só linhas SCHEDULED mudam; nenhuma é inserida')` (plano cita uma linha `SKIPPED` de telefone: ela não muda; contagem de linhas igual); `it('aplica os pulos antes de failUnavailable: canal inativo e férias — SKIPPED VACATION, não FAILED')`; `it('grava recheckedAt e audienceLateJoined sem telefone')`; `it('FROZEN_RECHECK sem função: lança e nada muda')`; `it('aceite 27: política nula dispara pela regra antiga sem chamar a função')`; `it('exatamente 2 h de atraso: claim vence; 2 h e 1 ms: claim null')`; `it('expireScheduled: EXPIRED e destinatários SKIPPED EXPIRED; envio já disparado ou cancelado não muda')`; `it('claim e vencimento concorrentes em torno do teto: no máximo um vence')`; `it('grava schedulePolicy e phoneE164 quando passados')`; `it('cancelar durante uma reconferência lenta (6 s) devolve false e o envio fica DISPATCHED, sem P2028')` (claim com função que espera 6 s, acima do `timeout` padrão de 5 s; `cancelScheduled` disparado 200 ms depois; `Promise.all`; o cancelamento resolve `false` e não lança; com a reconferência lançando depois de 6 s, o mesmo cancelamento resolve `true` e o envio fica `CANCELLED`).
2. [ ] RED: virar o `it` do vencido há 3 h no spec existente.
3. [ ] GREEN; `toDbPolicy` em `purpose-codes.ts` com spec; validação (`TESTCONTAINERS_ENABLED=1`); typecheck; eslint dos limites; `--changed`.

**Aceite:** 25, 26, 27, 36 (repositório). **Risco: alto** (concorrência do disparo).
**Crítico: concorrência/transação — o claim atômico passa a reconferir e aplicar pulos na mesma transação; erro desfaz tudo; teto de 2 h na condição.**

## Task 6a — Extração da classificação do público para `audience-people.ts` (back, refatoração)

**Arquivos:** criar `backend/src/modules/team-whatsapp/audience-people.ts` e `audience-people.spec.ts`; modificar `team-audience.service.ts` (só trocar `classifyAll`/`shiftNamesOf` privados pela função extraída). **Nenhuma asserção de spec existente muda.**

**Interfaces:** consome o que `team-audience.service.ts` usa hoje para classificar (`buildAudience`, `classifySector`, `LevelFilter`/`passesLevel` de `team-whatsapp.roster.ts` ~L265-292, `TeamMemberWithSchedule`). Produz:

```ts
// audience-people.ts (extraído de team-audience.service.ts, sem mudar comportamento)
export function classifyPeople(input: { base: AudienceBase; includeOff: boolean; date: CivilDate;
  sectors: readonly { id: string; name: string }[]; shiftIds: readonly string[] | null; shiftNames: ReadonlyMap<string, string>;
  level: LevelFilter | null; people: ReadonlyMap<string, TeamMemberWithSchedule[]> }): AudienceEntry[][];
export function shiftNamesOf(active: readonly { id: string; name: string }[], people: readonly TeamMemberWithSchedule[]): Map<string, string>;
```

**Contexto vinculado:**
- A classificação sai do serviço para uma função pura, usada pela prévia, pelo envio e (na T6b) pela reconferência; a prévia e o envio do Lote F continuam iguais: os specs de `team-audience.service*`, `team-whatsapp.service.purpose*` e `team-audience.e2e.integration.spec.ts` ficam verdes **sem mudar asserção**.
- Sem ator, sem banco e sem portas de alcance dentro de `classifyPeople` (DG3: a reconferência usa só a regra gravada); quem consulta pessoas e níveis continua sendo o chamador.
- GG11: funções até 50 linhas, complexidade 10, até 4 parâmetros (por isso a entrada é um objeto); lógica nova em arquivo novo; `prettier --write` só em `audience-people.ts`.
- GG13: nenhuma assinatura pública muda; a T8 entra em `team-audience.service.ts` depois (Onda 3, só `scheduledForOf`/`ruleViewOf`).

**Passos:**
1. [ ] RED `audience-people.spec.ts`: `it('classifyPeople dá o mesmo resultado que a prévia para o mesmo escopo')`; `it('shiftNamesOf inclui turno inativo do vínculo')`; `it('filtro de nível e sem nível iguais aos da prévia')`.
2. [ ] GREEN: mover o código; o serviço chama a função.
3. [ ] Validação: o spec novo e cada spec de `team-audience.service*` (um por vez); o e2e com `TESTCONTAINERS_ENABLED=1`; typecheck; eslint dos limites; `--changed`.

**Aceite:** base de 21–39 (mesma classificação na prévia, no envio e no disparo). **Risco: médio** (refatoração sem mudar comportamento; os specs do F são a rede).

## Task 6b — Reconferência no disparo e vencimento (back)

**Arquivos:** modificar `backend/src/modules/team-whatsapp/team-whatsapp-schedule.service.ts` (`fireDue`, `fireOne`, `toScheduledItem` ~L168-184); criar `scheduled-recheck.runner.ts` (`recheckAudience`; `scheduled-recheck.ts` da T4 **não muda** e continua puro, sem importar o repositório); modificar `team-whatsapp-scheduler.processor.spec.ts` (só a asserção `['d1', NOW]`/`['d2', NOW]` de `:60-62`, que passa a `['d1', NOW, expect.any(Function)]`); criar `team-whatsapp-schedule.recheck.spec.ts`, `team-whatsapp.schedule-recheck.integration.spec.ts` e `team-whatsapp.schedule-recheck.test-fixtures.ts`.

**Interfaces:** consome T4 (`planRecheck`), T5 (`claimScheduled(id, now, recheck)`, `expireScheduled`, `ClaimedDispatch`), T6a (`classifyPeople`, `shiftNamesOf`), T8 (envio grava `FROZEN_RECHECK`, `audienceRule.when`, `phoneE164`), `repo.loadDayPeopleMany(sectorIds, date, today)`, `todayIn` (`staff-schedule/civil-date.ts`), `LevelFilter`, `audienceRuleSnapshotSchema`. Produz:

```ts
// scheduled-recheck.runner.ts (novo; importa type ClaimedDispatch/TeamWhatsappRepository do repositório e planRecheck de scheduled-recheck.ts)
export async function recheckAudience(repo: Pick<TeamWhatsappRepository, 'loadDayPeopleMany'>, claimed: ClaimedDispatch,
  now: Date): Promise<RecheckPlan>;   // loadDayPeopleMany(sectorIds, rosterDate, todayIn(now))
// fireOne(id, now): Promise<'fired' | 'expired' | 'skipped'>
// toScheduledItem(row, full): exige scheduledFor e rosterDate; shift = shiftSnapshotOf(row) ?? null (contrato da T2)
```

**Contexto vinculado:**
- DG2 (relógio): a reconferência usa o `now` do tick, nunca o relógio; `recheckAudience` repassa `todayIn(now)` como `today` de `loadDayPeopleMany` (`repository.ts:548-551`), que decide entre o vínculo da data passada (`rosterDate < today`) e o cadastro. Sem o parâmetro, os testes com `fireAt` passariam ou falhariam conforme o dia (memória "relógio falso").
- DG2 (conexão): a leitura das pessoas sai fora da transação do claim, por outra conexão (só leitura); a lista congelada e a regra vêm de `loadClaimed(tx)`; a leitura não escreve e o claim já venceu antes dela; cada disparo segura 2 conexões e o `fireDue` dispara um por vez. Erro ou `timeout` de 20 s → rollback, envio `SCHEDULED`, tenta no tick seguinte.
- DG3: sem ator; regra gravada (setores do envio, `audienceRule.shifts` (`null` = todos) com os nomes gravados, `levels` e `withoutLevel` gravados montando o `LevelFilter` sem consultar níveis, `selectedUserIds`, base, `includeOff`, `rosterDate`); sem portas de alcance, disparo amplo e permissão; sem telefone. `audienceRule` fora do formato, base ou `rosterDate` nulos → lança (fica `SCHEDULED`, tenta de novo e vence no teto).
- DG4 (via `planRecheck`; `selectionWasAll = selectedUserIds === null`): precedência `INACTIVE` → fica se incluído → `VACATION` → `DAY_OFF` → `LEFT_SECTOR`; público recalculado antes do telefone; "entraram depois" só com "todos os aptos".
- GG3: o público congelado é reconferido "com as mesmas regras da prévia, sobre a mesma data de referência, e só pode retirar pessoas, nunca acrescentar"; "Se a reconferência falhar, nada é enviado e o sistema tenta de novo no minuto seguinte"; "Agendados criados antes desta versão disparam pela regra antiga".
- GG4: só quem ganha o claim reconfere; só destinatários `SCHEDULED` mudam; nenhuma linha inserida; dois ticks → um envio; erro na reconferência → nada sai e o envio segue `SCHEDULED`.
- DG5: `fireOne` = `claimScheduled(id, now, (c) => recheckAudience(this.repo, c, now))` (fecha sobre o `now` do tick); `null` → `expireScheduled(id, now)`; `null` de novo → `'skipped'`. Vencido: trilha `team_whatsapp.scheduled_expired` `{ dispatchId, skipped }`. Teto: só pega `scheduledFor <= now AND scheduledFor >= now − 2 h`; vencido = `scheduledFor < now − 2 h`; exatamente 2 h ainda dispara.
- GG13: `team-whatsapp-scheduler.processor.spec.ts` é desta task (a chamada ganha o terceiro argumento). O `it` do vencido há 3 h em `schedule.integration.spec.ts` (virado na T5 sem afirmar estado) continua verde: `fireDue` só conta `'fired'`.
- Trilha `team_whatsapp.scheduled_fire` ganha `policy` (`'frozen_recheck' | null`), `recheckSkipped` e `lateJoined` (contagens). GG8: sem nome, telefone, texto; o log de erro do `fireDue` continua só com `dispatchId` e o erro; erro lançado pela reconferência não leva nome.
- GG3: "Se a reconferência falhar, nada é enviado e o sistema tenta de novo no minuto seguinte" (o tick é a cada minuto, `worker.ts:162`; nada a mudar no worker).
- A classificação é a de `audience-people.ts` (T6a); esta task não mexe em `team-audience.service.ts`.
- Import circular (revisão 2, m3): `repository.ts` importa `SCHEDULE_GRACE_MS` de `scheduled-recheck.ts`; por isso `recheckAudience` mora em `scheduled-recheck.runner.ts` (novo), que importa o repositório só com `import type`, e `scheduled-recheck.ts` continua puro e sem import do repositório.
- Lista de agendados (revisão 2, B): spec G1/G3, "Continua só cancelar e criar de novo". Agendado em "data e hora" com vários ou todos os turnos grava turno nulo (`sector-dispatch.ts:223`, `shiftColumns` só com um turno) e hoje some da lista (`toScheduledItem` descarta a linha sem turno, `schedule.service.ts:170-171`), sem como cancelar. `toScheduledItem` passa a exigir `scheduledFor` e `rosterDate` e devolve `shift: null` quando não há snapshot; o `rosterDate` é sempre gravado no alvo setor, inclusive no `'at'` (`sectorDispatchFields`, `sector-dispatch.ts:225`, `rosterDate: r.date`), então não deixa ninguém de fora. O contrato (`shift` nulo) é da T2; o cancelamento (`cancelScheduled`, com o `timeout` da T5) não muda.

**Passos:**
1. [ ] RED: ajustar a asserção da chamada em `team-whatsapp-scheduler.processor.spec.ts`.
2. [ ] RED `team-whatsapp-schedule.recheck.spec.ts` (fakes): `it('fireOne passa a reconferência ao claim')`; `it('recheckAudience repassa todayIn(now) a loadDayPeopleMany, não o relógio')` (`now` em outro dia que o do sistema); `it('claim null e vencimento — expired e trilha scheduled_expired só com ids e contagens')`; `it('scheduled_fire com policy, recheckSkipped e lateJoined, sem nome nem telefone')`; `it('recheckAudience monta o filtro da regra gravada sem consultar níveis nem alcance')`; `it('audienceRule inválido lança')`.
3. [ ] RED `team-whatsapp.schedule-recheck.integration.spec.ts` (Postgres real; fixtures `scheduleViaService(deps, corpo)` e `fireAt(deps, date)` no arquivo de fixtures novo, que a T10a/T10b reusam): `it('aceite 25: erro na reconferência (loadDayPeopleMany lança) — nada enfileirado, envio SCHEDULED; o tick seguinte dispara uma vez')`; `it('aceite 25: dois fireDue concorrentes — cada mensagem enfileirada uma vez')`; `it('aceite 26: agendado novo vencido há mais de 2 h — EXPIRED, nada enfileirado')`; `it('aceite 36: agendado antigo (política nula) vencido há mais de 2 h — EXPIRED')`; `it('aceite 27: agendado antigo dentro do prazo dispara pela regra antiga, sem recheckedAt')`; `it('agendado em data e hora com todos os turnos aparece na lista e cancela')` (Reunião com todos os turnos criada por `scheduleViaService` com `when: 'at'`; `listScheduled` traz o item com `shift: null`, `scheduledFor` e `rosterDate`, e passa em `teamScheduledListResponseSchema.parse`; o cancelamento pelo serviço deixa o envio `CANCELLED` e os destinatários `CANCELLED`).
4. [ ] GREEN; validação (um spec por vez); typecheck; eslint (`scheduled-recheck.ts` sem import de `team-whatsapp.repository`); `--changed`.

**Aceite:** 25, 26, 27, 35 (data de referência pelo `now`), 36. **Risco: alto** (concorrência do disparo).
**Crítico: concorrência/transação e dado pessoal em trilha — liga a reconferência ao claim, cria o vencimento e duas trilhas sem dado pessoal.**

## Task 7 — Repositório do histórico: filtros, busca e reconferência (back)

**Arquivos:** modificar `backend/src/modules/team-whatsapp/team-whatsapp.repository.ts` (`listDispatches`, `listAllDispatchRecipients` novo, `countRecheckSkips` novo, selects do detalhe e dos destinatários); criar `team-dispatch-history.integration.spec.ts`.

**Interfaces:** consome T1, T5 (arquivo já alterado). Produz CG8. `listDispatches(authorId, page, filter?)` com `filter` opcional (GG13: o serviço de hoje continua chamando sem filtro até a T11).

**Contexto vinculado:**
- GG7: "Quem não é ADMIN continua vendo só os próprios." Hoje `where = authorId === null ? {} : { authorId }` (`:923-937`); o filtro entra **somado** (E) a isso, no `findMany` e no `count` da mesma `$transaction`; ordem `[{ createdAt: 'desc' }, { id: 'desc' }]` e `pageWindow` de hoje.
- DG14 (no repositório já em `Date`): `createdAt >= createdFrom`, `createdAt < createdBefore`, `purpose`, `state`.
- DG13: `listAllDispatchRecipients` sem paginação (o envio tem no máximo `DAY_PEOPLE_LIMIT` = 2000 pessoas), mesma ordem `[userName asc, id asc]`, mesmo select do destinatário + `phoneE164`.
- `countRecheckSkips`: destinatários do envio com `skipReason in (VACATION, DAY_OFF, LEFT_SECTOR, INACTIVE)`.
- Índices da T1 (`state, createdAt`; `purpose, createdAt`) servem a estes filtros.
- GG10: `createdAt` explícito nas fixtures.

**Passos:**
1. [ ] RED: `it('gestor com filtros nunca vê envio de outro autor (findMany e count)')`; `it('filtra por período nas bordas de dia de Manaus')`; `it('filtra por finalidade e por estado, inclusive EXPIRED')`; `it('filtros combinados com paginação: total do count bate')`; `it('listAllDispatchRecipients devolve todos, ordenados, com phoneE164')`; `it('countRecheckSkips conta só os quatro motivos')`; `it('detalhe traz recheckedAt e audienceLateJoined')`.
2. [ ] GREEN; validação; typecheck; `--changed`.

**Aceite:** 31 (repositório). **Risco: crítico (autorização)** — o filtro novo não pode afrouxar "não ADMIN vê só os próprios".
**Crítico: autorização — `where` da lista com filtros sempre somado ao `authorId`.**

## Task 8 — Envio com "data e hora", política e telefone gravados (back)

**Arquivos:** modificar `backend/src/modules/team-whatsapp/team-whatsapp.sector-dispatch.ts` (`sectorScheduledFor` e montagem dos destinatários), `team-whatsapp.service.ts` (só `sectorDraft`, `scheduled`, `dispatchNow` e a montagem do destinatário do alvo pessoa), `team-audience.service.ts` (só `scheduledForOf` e `ruleViewOf`); criar `team-whatsapp.service.schedule-at.spec.ts`. Virar as asserções da regra antiga: `team-whatsapp.service.purpose.spec.ts` ~L292-300 ("início do turno grava schedulePolicy nulo"), `team-audience.e2e.integration.spec.ts` ~L404-444 e `team-audience.service.spec.ts` ~L329 (`schedulePolicy: null` na prévia "agora"); conferir com grep se há outra.

**Interfaces:** consome T2 (DTO), T3 (`scheduledForOf`, `policyOf`, `blocksFor`), T5 (`NewTeamDispatch.schedulePolicy`, `NewTeamRecipient.phoneE164`, `toDbPolicy`), T6a (`team-audience.service.ts` já com `classifyPeople`; aqui só `scheduledForOf`/`ruleViewOf`), `sendPhoneOf` de `recipient-skip.ts`. GG13: gravar `FROZEN_RECHECK` antes da T6b não quebra spec existente (os que disparam semeiam por `seedScheduled`, política nula); se algum quebrar, report. Produz o envio que grava `schedulePolicy`, `audienceRule.when`, `scheduledFor` de `'at'` e `phoneE164` por destinatário; a prévia com `rule.when`, `rule.scheduledFor` e `rule.schedulePolicy` do momento pedido.

**Contexto vinculado:**
- GG2 e DG8 (data e hora em Manaus; 30 dias; Urgência com `'at'` 422; `'at'` só alvo setor).
- DG6: setor "agora" → `IMMEDIATE`; `shift_start`/`at` → `FROZEN_RECHECK`; alvo pessoa → nula.
- DG7: `phoneE164 = sendPhoneOf(member)` em toda linha criada (setor e pessoa; `QUEUED`, `SCHEDULED` e `SKIPPED` de telefone).
- `audienceRule` gravado = `{ ...resolved.ruleSnapshot, when }`.
- Trilha `team_whatsapp.schedule` ganha `when` e `policy`; `team_whatsapp.dispatch` ganha `policy`; GG8.
- GF9 do F (ordem): ator → regra (422) → alcance (403) → turnos/níveis → disparo amplo → público → impressão (409) → seleção (422) → primeira trava (422) → número aberto (409, só "agora") → gravação. Sem `requireOpen` no agendado (como hoje, `service.ts:295`).
- Um `scheduledForOf` só (o de T3) para prévia e envio: `sectorScheduledFor` e o `scheduledForOf` privado de `team-audience.service.ts` passam a usá-lo.

**Passos:**
1. [ ] RED (`team-whatsapp.service.schedule-at.spec.ts`, fakes): `it('aceite 20: data e hora grava scheduledFor em Manaus, SCHEDULED e FROZEN_RECHECK')`; `it('início do turno grava FROZEN_RECHECK')`; `it('agora grava IMMEDIATE')`; `it('aceite 37: 31 dias à frente — 422 schedule_too_far com o texto; urgência com at — 422 when_not_allowed')`; `it('aceite 30: reunião com at depois do início — 422 after_activity_start')`; `it('grava phoneE164 de cada destinatário, inclusive SKIPPED de telefone')`; `it('alvo pessoa grava phoneE164 e política nula')`; `it('audienceRule grava when')`; `it('prévia com at devolve when at, scheduledFor e frozen_recheck')`; `it('trilha schedule com when e policy, sem nome, telefone nem texto')`.
2. [ ] RED: virar as asserções de `schedulePolicy` nulo listadas acima.
3. [ ] GREEN; validação (cada spec tocado; o e2e com `TESTCONTAINERS_ENABLED=1`); typecheck; eslint; `--changed`.

**Aceite:** 20, 30, 37 (servidor); G3 "agora grava a política"; G4 gravação. **Risco: alto**.
**Crítico: contrato público de API — `POST dispatches` passa a agendar em data e hora e a gravar política e telefone por destinatário.**

## Task 9 — Processor com telefone congelado (back)

**Arquivos:** modificar `backend/src/modules/team-whatsapp/team-whatsapp-send.processor.ts` (`recipientSelect`/`LoadedRecipient` ~L36-61 + `phoneE164`, `sendPhoneOf` ~L80, `precheck` ~L272-292, destino do envio) e spec (`describe` novo irmão ou arquivo novo); `recipient-skip.ts` só se o tipo do `sendPhoneOf` precisar abrir para o `LoadedRecipient`; criar `team-whatsapp.phone-frozen.integration.spec.ts`.

**Interfaces:** consome T1 (client com `TeamWhatsappRecipient.phoneE164` e `PHONE_CHANGED`), T5 (`NewTeamRecipient.phoneE164` para semear). Produz `LoadedRecipient` com `phoneE164` (select do processor, `:36-61`) e o `precheck` com `PHONE_CHANGED`.

**Contexto vinculado:**
- GG13: a T8 (mesma onda) é quem grava `phoneE164` pelo serviço; esta task **não depende dela**: a integração semeia envio e destinatários direto no banco (padrão `seedScheduled` de `schedule.integration.spec.ts` ou o repositório com `phoneE164` explícito), com política nula, e dispara pelo `fireOne`/processor. A ponta a ponta pelo serviço é da T12.
- DG7: ordem nova do `precheck`: sem telefone atual → `SKIPPED NO_PHONE`; gravado não nulo e diferente do atual → `SKIPPED PHONE_CHANGED` (sem `Message`, sem chamar o provedor); supressão → `SUPPRESSED`; autorização → `NOT_AUTHORIZED`; canal inativo/provedor desligado → `FAILED` como hoje. Envia para o gravado; gravado nulo → atual. **Um `sendPhoneOf` só, e esta task é quem unifica:** apagar a função local do processor (`team-whatsapp-send.processor.ts:80-82`, `user?.contact?.phoneE164 ?? user?.phoneE164 ?? null`) e importar a de `recipient-skip.ts:12-15` (`m.contact?.phoneE164 ?? m.phoneE164 ?? null`, a mesma que a T8 usa para gravar); as duas expressões já são iguais, então o que pode divergir é só o `contact` carregado (o do `recipientSelect` × o de `TeamMember`): conferir que o select do processor traz o mesmo contato ligado e registrar no report; se o tipo não casar, abrir o parâmetro de `sendPhoneOf` para `{ contact?: { phoneE164: string | null } | null; phoneE164: string | null }` sem mudar a lógica. Telefone apagado depois da criação (gravado não nulo, atual nulo) → `NO_PHONE` "Sem telefone", não `PHONE_CHANGED` (decisão do DG7; mesmo efeito: pulado, sem "Repetir").
- GG6: "Pulado não é falha: o 'Repetir' não o pega". O "Repetir" (`requeueFailed`, `repository.ts:769-792`) só pega `FAILED` com código repetível; uma linha `FAILED` repetida vira `QUEUED` e passa pelo `precheck`, então o telefone trocado também a pula.
- GG5: destinatário sem telefone gravado usa o atual, inclusive no "Repetir".
- GG8: log do processor sem telefone (nem o gravado nem o atual).

**Passos:**
1. [ ] RED unidade: `it('gravado diferente do atual — SKIPPED PHONE_CHANGED, sem Message nem provedor')`; `it('sem telefone atual — NO_PHONE antes de PHONE_CHANGED')`; `it('telefone apagado depois da criação — NO_PHONE, não PHONE_CHANGED')`; `it('LoadedRecipient traz phoneE164')`; `it('gravado igual — envia para o gravado')`; `it('gravado nulo — usa o atual')`; `it('processor usa o sendPhoneOf de recipient-skip: contato ligado vale por cima do usuário')` (gravado = telefone do contato, usuário com outro número: envia, não `PHONE_CHANGED`); `it('nenhum log com telefone')`.
2. [ ] RED integração: `it('aceite 28: agendado, pessoa troca de telefone, disparo — PHONE_CHANGED e os outros recebem')`; `it('aceite 28: Repetir não pega o PHONE_CHANGED; FAILED repetido depois da troca vira PHONE_CHANGED')`; `it('aceite 38: Repetir em envio antigo sem telefone gravado usa o atual')`.
3. [ ] GREEN; validação; typecheck; `--changed`.

**Aceite:** 28, 38. **Risco: alto** (para quem a mensagem sai).
**Crítico: dado pessoal em log — compara telefone gravado e atual; nenhum dos dois pode ir para log ou erro.**

## Task 10a — Cenários T07 da reconferência, base em serviço (back, só teste)

**Arquivos:** criar `backend/src/modules/team-whatsapp/team-whatsapp.recheck-on-duty.integration.spec.ts` (reusa `team-whatsapp.schedule-recheck.test-fixtures.ts` da T6b só importando).

**Interfaces:** consome T6b (`scheduleViaService`, `fireAt`, `recheckAudience(repo, claimed, now)`), T8, serviços reais e Postgres real; fila e porta do número falsas.

**Contexto vinculado:**
- Sentença T, consequência 4: "Cenários T07 (um teste cada): aviso de turno com troca, folga ou férias lançada depois; [...] todos pulados ('ninguém recebeu'); entrou depois (listado, não recebe); turno noturno reconferido na data de referência."
- GG3: o público congelado é reconferido "com as mesmas regras da prévia, sobre a mesma data de referência, e só pode retirar pessoas, nunca acrescentar"; motivos "Férias", "Folga", "Saiu do setor ou turno", "Inativa"; "Se todos forem pulados, o histórico mostra 'ninguém recebeu', nunca sucesso". DG4: precedência `INACTIVE` → fica se incluído → `VACATION` → `DAY_OFF` → `LEFT_SECTOR`; "entraram depois" só com "todos os aptos", sem telefone. GG10: `now` explícito, nada de `vi.setSystemTime` com linha gravada pelo banco; data de referência fixa.
- DG2 (relógio): a reconferência usa `todayIn(now)` do tick para decidir entre o vínculo da data passada e o cadastro; disparo no dia seguinte ao `rosterDate` (turno que começa às 23h, tick às 00:30, dentro do teto) cai no caminho de data passada (vínculo da data de referência).
- Cada teste: criar pela prévia e pelo envio (impressão real), mudar o cadastro ou a escala, disparar com `fireAt(scheduledFor + 1 min)`, conferir situação e `skipReason` de cada destinatário, `recheckedAt`, `audienceLateJoined` e o que foi para a fila.
- Defeito achado volta para a task dona (T4, T5, T6a, T6b ou T8); esta task não muda produção.

**Passos:**
1. [ ] RED/GREEN: `it('aceite 21: aviso de turno, férias lançadas depois — pulada com Férias; os outros enfileirados; recheckedAt gravado')`; `it('aceite 39: folga lançada depois — Folga')`; `it('aceite 32: troca de turno lançada depois — Saiu do setor ou turno')`; `it('aceite 22: todos os aptos, pessoa acrescentada ao setor depois — não recebe e fica em audienceLateJoined')`; `it('aceite 24: todos pulados — nada enfileirado, envio DISPATCHED só com SKIPPED')`; `it('aceite 35: turno noturno — a reconferência usa o rosterDate gravado, não a data do disparo')`; `it('aceite 35: disparo no dia seguinte ao rosterDate (turno das 23h, tick 00:30) — usa o vínculo da data de referência')` (transferir a pessoa no `UserAssignment` com início no dia do disparo: continua recebendo); `it('pessoa desativada depois — Inativa')`.
2. [ ] Validação (`TESTCONTAINERS_ENABLED=1`); eslint (50 linhas por `it`); `--changed`.

**Aceite:** 21, 22, 24, 32, 35, 39. **Risco: alto**.

## Task 10b — Cenários T07 da reconferência, base vinculada (back, só teste)

**Arquivos:** criar `backend/src/modules/team-whatsapp/team-whatsapp.recheck-assigned.integration.spec.ts` (reusa as fixtures da T6b).

**Interfaces:** as da T10a.

**Contexto vinculado:**
- Sentença T, consequência 4: "reunião com férias depois; reunião com folga marcada e folga lançada depois (continua recebendo); hora extra nominal com férias depois; transferência de setor".
- GG3: "Folga só retira quem não estava de folga na criação e a folga não foi incluída; quem entrou por 'Incluir folga' continua." DG4. GG10. Defeito volta para a task dona.

**Passos:**
1. [ ] RED/GREEN: `it('aceite 20: reunião daqui a 3 dias às 9h (atividade às 14h) sai na hora marcada para a lista da criação')`; `it('aceite 33: reunião, férias lançadas depois para um convidado — Férias')`; `it('aceite 33: hora extra nominal, férias lançadas depois — Férias')`; `it('aceite 23: reunião com Incluir folga, folga lançada depois — continua recebendo')`; `it('aceite 34: transferência de setor depois — Saiu do setor ou turno')`; `it('seleção nominal: ninguém em audienceLateJoined')`.
2. [ ] Validação (`TESTCONTAINERS_ENABLED=1`); eslint; `--changed`.

**Aceite:** 20, 23, 33, 34. **Risco: alto**.

## Task 11 — Histórico: filtros, busca por nome e reconferência no detalhe (back)

**Arquivos:** modificar `backend/src/modules/team-whatsapp/team-whatsapp.controller.ts` (`GET dispatches` com `DispatchListQueryDto`; `GET dispatches/:id/recipients` com `q`), `team-whatsapp.service.ts` (só `listDispatches`), `team-whatsapp-results.service.ts` (`detail`, `recipients`, `toRecipientItem`), `dispatch-purpose-view.ts` (`ruleView.when`); criar `team-whatsapp.service.list-filters.spec.ts`, `team-whatsapp-results.service.search.spec.ts` e `describe` novo irmão em `team-whatsapp.controller.spec.ts`.

**Interfaces:** consome T2 (query e contrato), T7 (CG8), `nameView`/`phoneView` (`shared/authz/phone-visibility.ts`), `seesFullPhone`. Produz CG1/CG3 na API.

**Contexto vinculado:**
- GG7 inteiro. DG14: o serviço converte `from` → `zonedStart(from, '00:00')` e `to` → `zonedStart(to + 1 dia, '00:00')` (exclusivo); `purpose` por `toDbPurpose`; passa `actor.role === 'ADMIN' ? null : actor.id` como hoje.
- DG13: com `q`, `listAllDispatchRecipients` → `nameView` do ator → normalizar (NFD sem diacríticos, minúsculas) o nome **exibido** e o `q` → `includes` → paginar em memória (`total` = filtrados); combina com `status`. Sem `q`, caminho de hoje.
- CG3: `recheck = recheckedAt ? { at, skipped: countRecheckSkips, lateJoined (nameView, ordenado pelo nome exibido) } : null`; `phone = phoneView(phoneE164, { full })` (nulo se não gravado). Os dois entraram opcionais no contrato na T2 só para compilar entre tasks; aqui o detalhe e cada destinatário **sempre** os trazem (nulo quando não há), sem mudar o contrato. `rule.when = audienceRule.when ?? (scheduledFor ? 'shift_start' : 'now')`.
- Visibilidade de hoje antes de tudo: remetente (403) → `canViewDispatch` (404) (`results.service.ts:216-227`).
- Lição do Lote E: cada rota com permissão mantém uma negação e uma concessão no spec.

**Passos:**
1. [ ] RED: `it('aceite 31: lista repassa período, finalidade e situação; gestor continua só com os próprios')`; `it('to inclui o dia inteiro em Manaus')`; `it('busca acha sem acento e sem caixa')`; `it('sem telefone.ver_completo a busca não acha pelo número um nome mascarado')`; `it('busca com status e paginação: total dos filtrados')`; `it('detalhe com recheck: hora, pulados e entraram depois mascarados e ordenados')`; `it('detalhe sem reconferência: recheck nulo')`; `it('destinatário com phone por telefone.ver_completo; nulo no antigo')`; `it('detalhe e destinatários sempre trazem recheck e phone, nulos quando não há')`; `it('rule.when at lido do gravado; ausente inferido')`; controller: `it('GET dispatches com query inválida 400')`, `it('GET recipients repassa q')`, `it('VIEWER 403')`.
2. [ ] GREEN; validação; typecheck; eslint; `--changed`.

**Aceite:** 31 (API); G4 número usado; G3 histórico da reconferência. **Risco: crítico (autorização)** — filtros e busca sobre a regra "só os próprios" e a máscara de nome e telefone.
**Crítico: autorização e contrato público — filtros da lista, busca por nome que respeita a máscara, telefone por `telefone.ver_completo`.**

## Task 12 — Ponta a ponta do histórico e da data passada (back, só teste)

**Arquivos:** criar `backend/src/modules/team-whatsapp/team-dispatch-history.e2e.integration.spec.ts`.

**Interfaces:** consome T6b (fixtures `scheduleViaService`, `fireAt` de `team-whatsapp.schedule-recheck.test-fixtures.ts`, só importando), T8, T9, T11 com Postgres real e serviços reais; fila e porta do número falsas; o processor de envio real (`team-whatsapp-send.processor.ts`) chamado sobre o job enfileirado.

**Contexto vinculado:**
- Telefone dos dois lados (revisão 2, C): a T8 grava `phoneE164 = sendPhoneOf(member)` na criação e a T9 compara com `sendPhoneOf` do `LoadedRecipient` no envio; nenhum teste anterior passa pelos dois. Se os dois lados derem números diferentes, toda mensagem vira `PHONE_CHANGED` e ninguém recebe. DG7: um `sendPhoneOf` só (T9 unifica); gravado diferente do atual → `SKIPPED PHONE_CHANGED`, sem `Message`, sem provedor; telefone apagado → `NO_PHONE`. GG6: "se o telefone atual da pessoa não for o gravado, a mensagem não sai e o destinatário fica pulado com 'Telefone mudou depois da criação do envio'".
- Anti-objetivo: "O histórico de um envio antigo mudar porque o cadastro, o vínculo ou a escala mudaram." Herdado 3 (Lote F T11-m2): mudar `UserAssignment` e o nome do turno depois do envio, com data de referência passada, e o detalhe continuar igual.
- GG7, DG13, DG14. GG10 (`createdAt` explícito).
- Defeito volta para a task dona.

**Passos:**
1. [ ] RED/GREEN: `it('aceite 12: envio com data passada; muda o vínculo (UserAssignment) e o nome do turno — detalhe, regra e excluídos iguais')`; `it('aceite 31: filtra por finalidade, período e situação e busca uma pessoa no detalhe')`; `it('gestor filtrando não vê envio de outro autor')`; `it('detalhe de envio reconferido mostra recheck e telefone usado conforme a permissão')`; `it('aceite 28 ponta a ponta: criado pelo serviço, telefone igual — o processor envia para o gravado')` (pessoa com contato ligado e telefone de usuário diferentes; envio "agora" pelo serviço; o processor real envia para o `phoneE164` gravado, situação `SENT`, uma `Message`); `it('aceite 28 ponta a ponta: troca depois da criação — PHONE_CHANGED, sem Message')` (agendado por `scheduleViaService`, troca do telefone do contato ligado, `fireAt(scheduledFor + 1 min)`, processor real: `SKIPPED PHONE_CHANGED`, nenhuma `Message`, porta do número sem chamada; os outros destinatários recebem).
2. [ ] Validação (`TESTCONTAINERS_ENABLED=1`); eslint (50 linhas por `it`); `--changed`.

**Aceite:** 12 (data passada), 28 (ponta a ponta), 31. **Risco: alto**.

## Task 13 — Esquemas, API, matriz e rótulos (front)

**Arquivos:** modificar `frontend/src/features/team-whatsapp/{schemas,api,labels,error-messages,purpose}.ts` e specs; em `components/recent-dispatches.tsx` e `components/dispatch-result.tsx`, só trocar o `STATE_LABEL` local por `DISPATCH_STATE_LABEL` de `labels.ts` (o enum novo quebraria o índice); em `components/scheduled-dispatches.tsx`, só o `whenText` local (`:17-20`), porque o `shift` nulo no esquema quebra `item.shift.startTime` (+ `describe` novo irmão no spec do componente).

**Interfaces:** consome CG1–CG4 e CG9. Produz os esquemas com `EXPIRED`, motivos novos, `when: 'at'`/`at`, `recheck` e `phone` (`.nullish()`: o back os trata como opcionais até a T11), `ScheduledDispatch.shift` `.nullable()`; `DispatchListFilters`; `useTeamDispatches(page, filters?)`, `useDispatchRecipients(id, { status, page, q? })`; `PURPOSE_RULES.when` com `'at'`; `DISPATCH_STATE_LABEL`, `SKIP_REASON_LABEL` novos, `SCHEDULE_GRACE_MS`, `dispatchSituation(item, now)`, `policyLabel`, `whenText` (exportado de `labels.ts`), textos de CG4 em `TEAM_ERROR_MESSAGES`.

**Contexto vinculado:**
- CG9 (textos exatos). DG9: "Ninguém recebeu" = `DISPATCHED` e `queued + scheduled + sent + delivered + read + replied + uncertain = 0`.
- DG16: `dispatchSituation({ state, counts, scheduledFor }, now)` devolve "Não enviado: passou da hora" para `EXPIRED` **e** para `SCHEDULED` com `scheduledFor < now − 2 h` (worker parado); só rótulo, o filtro "Situação" continua pelo estado gravado. `now` vem do chamador (a tela passa `new Date()`; o teste passa fixo).
- GG13: `useTeamDispatches` ganha `filters` **opcional** (hoje `(page)` em `api.ts:116`; `index.tsx` só passa filtros na T16); `q` opcional no objeto de `useDispatchRecipients` (já é objeto, `api.ts:203`; `recipient-table.tsx:84` e o mock de `recipient-table.spec.tsx:15` continuam compilando).
- Herdado 4: `policyLabel` de `frozen_recheck`.
- Lista de agendados (revisão 2, B): o back passa a listar o agendado em "data e hora" sem turno (`shift: null`; spec "Continua só cancelar e criar de novo"). O `whenText` de `scheduled-dispatches.tsx` fica: com turno, `formatDayMonth(rosterDate) + ' ' + shift.startTime` (como hoje, sem conta de fuso); sem turno, dia/mês e `HH:mm` de `scheduledFor` em Manaus (mesmo formatador da T13 para `at`). O teste da lista renderizada é da T16.
- ky 2: corpo de erro só por `readApiErrorBody` (`code` em `HTTPError.data`).
- `useTeamDispatches` mantém o polling (`dispatchPollInterval`) e `PAGE_SIZE` 20; filtros vazios não vão na query.

**Passos:**
1. [ ] RED: `it('lista e detalhe aceitam EXPIRED, recheck e phone; antigo com nulos')`; `it('corpo aceita when at com at')`; `it('useTeamDispatches manda from, to, purpose e state só quando preenchidos')`; `it('useTeamDispatches sem filtros continua igual')`; `it('useDispatchRecipients manda q')`; `it('PURPOSE_RULES: at em todas menos Urgência')`; `it('dispatchSituation: Ninguém recebeu, passou da hora e os de hoje')`; `it('DG16: SCHEDULED vencido há mais de 2 h — passou da hora; há exatamente 2 h — Agendado')`; `it('policyLabel nas três políticas')`; `it('whenText de at em Manaus')`; `it('whenText dos agendados: com turno e sem turno (scheduledFor em Manaus)')`; `it('esquema da lista de agendados aceita shift nulo')`; `it('rótulos dos cinco motivos novos')`.
2. [ ] GREEN; `npx tsc -b`; `--changed`.

**Aceite:** base de 24, 26 (inclusive DG16), 31; herdado 4. **Risco: médio**.

## Task 14 — Momento "Data e hora" e prévia com o momento (front)

**Arquivos:** modificar `frontend/src/features/team-whatsapp/use-send-filters.ts` (estado `moment`), `use-audience-preview.ts` (só se o corpo não passar inteiro), `components/send-whatsapp-dialog.tsx` (controle do momento, `submit`, `notifyDone`), `components/rule-panel.tsx` (usar `whenText` de `labels.ts`), `routes/_authenticated/whatsapp-equipe/index.tsx` (só repassar o momento ao diálogo); criar `components/send-moment.tsx`, `send-moment.spec.tsx`, `send-whatsapp-dialog.schedule.spec.tsx`; `describe` novo em `use-send-filters.spec.ts` e `rule-panel.spec.tsx`; em `components/send-whatsapp-dialog.spec.tsx` **só** o helper de render (props novas do momento, sem mudar asserção). GG13: prop nova do diálogo que não tiver valor neutro entra no helper; se `index.spec.tsx` quebrar pela prop, ajustar só o mock e listar no report.

**Interfaces:** consome T13. Produz `filters.moment: { when: 'now' | 'shift_start' | 'at'; at: { date: string; time: string } | null }`, `setMoment`; `audienceRequest(filters)` com `when` e, se completo, `at`; `SendMoment({ value, onChange, options })`.

**Contexto vinculado:**
- DG11: momento no estado dos filtros; a prévia leva o momento; painel, travas, `audienceKey` e aviso vêm dela; trocar a finalidade volta para "Agora". Herdado 2 (painel "Agora" ao agendar) e herdado 5 (`notifyDone` usava `sector.date` e o início do turno; passa a usar `rule.scheduledFor` da prévia confirmada: "Agendado para {dd/mm/aaaa} às {HH:mm}.").
- GG2: "Data e hora" em todas menos Urgência; "No início do turno" só no Aviso de turno com um turno (regras de hoje de `scheduleOption`, `send-whatsapp-dialog.tsx:288-297`); data entre hoje e hoje + 30 (Manaus) no campo; hora `HH:mm`.
- Rótulos: "Momento do disparo": "Agora", "No início do turno", "Data e hora"; campos "Data do envio" e "Hora do envio". Com "Data e hora" incompleta, a prévia vai sem `when` e o diálogo trava localmente com "Informe a data e a hora do envio.".
- CG4 (travas do servidor por extenso perto do botão: `schedule_in_past`, `schedule_too_far`, `after_activity_start`). O botão continua exigindo `isFresh`, sem travas, com texto e número aberto (só "agora" exige número aberto, como hoje).

**Passos:**
1. [ ] RED: `it('Urgência não oferece Data e hora; Reunião oferece')`; `it('trocar a finalidade volta para Agora')`; `it('prévia leva when at e at quando completos')`; `it('painel mostra a data e hora escolhidas e a política Lista conferida agora…')`; `it('data e hora incompleta trava com Informe a data e a hora do envio.')`; `it('aceite 30: trava after_activity_start do servidor aparece por extenso')`; `it('aceite 37: data além de 30 dias não é oferecida no campo; trava do servidor aparece')`; `it('envio manda when at, at e a audienceKey da prévia atual')`; `it('aviso de agendado com a data e hora da prévia confirmada')`.
2. [ ] GREEN; `npx tsc -b`; `--changed`.

**Aceite:** 20, 30, 37 (tela); herdados 2 e 5. **Risco: alto** (o operador confirma o que vê).

## Task 15 — Texto a partir dos dados da atividade (front)

**Arquivos:** criar `frontend/src/features/team-whatsapp/message-draft.ts` e spec, `components/send-whatsapp-dialog.draft.spec.tsx`; modificar `components/send-whatsapp-dialog.tsx` (texto vem por prop; botão e aviso) e `routes/_authenticated/whatsapp-equipe/index.tsx` (só criar o hook e repassar); em `components/send-whatsapp-dialog.spec.tsx` e `send-whatsapp-dialog.schedule.spec.tsx` (da T14) **só** o helper de render (prop do rascunho, sem mudar asserção). GG13: o texto passa a vir por prop; os specs existentes do diálogo ganham o rascunho no helper; se `index.spec.tsx` quebrar, ajustar só o mock e listar no report.

**Interfaces:** consome T13 (`PURPOSE_LABEL`), T14 (diálogo com momento). Produz:

```ts
export function draftHeader(purpose: Purpose, activity: { date: string; time: string; place: string | null }): string;
export function useMessageDraft(purpose: Purpose, activity: Activity | null): { text: string; setText(t: string): void;
  fill(): void; canFill: boolean; stale: boolean; confirmChecked(): void; reset(): void };
```

**Contexto vinculado:**
- Spec G2: "Botão 'Preencher com os dados da atividade': monta o texto com finalidade, data, hora e local, para o operador completar. Não é template do WhatsApp; é texto livre. Se o operador mudar data, hora ou local depois de preencher, a tela mostra 'Os dados da atividade mudaram depois que o texto foi preenchido. Confira o texto.' e o botão de enviar só libera depois de 'Preencher de novo' ou de marcar 'Conferi o texto'. Nada é guardado como rascunho no servidor."
- DG12: estado na página; fechar o diálogo não perde o texto; sair da página perde; envio aceito chama `reset()`. Cabeçalho `{Finalidade} em {dd/mm/aaaa} às {HH:mm}` + ` — {local}` + `.` + linha em branco; regras de troca do cabeçalho (vazio → cabeçalho; começa pelo último cabeçalho → troca só ele; senão → cabeçalho antes do texto).
- `canFill` só quando a finalidade tem atividade e data e hora estão preenchidas (Reunião, Palestra, Hora extra; Alinhamento com atividade). `stale` compara finalidade, data, hora e local com os do último preenchimento; "Conferi o texto" grava os atuais como conferidos. Trava local com o texto do aviso enquanto `stale`.
- `MAX_TEXT` 2000 continua; o cabeçalho conta.

**Passos:**
1. [ ] RED `message-draft.spec.ts`: `it('cabeçalho com e sem local')`; `it('preencher com texto vazio, com texto que começa pelo cabeçalho e com texto livre')`; `it('stale ao mudar data, hora ou local; não ao mudar o texto')`; `it('Conferi o texto limpa o stale')`.
2. [ ] RED diálogo: `it('aceite 29: preencher, mudar a hora — aviso e botão travado; Preencher de novo libera')`; `it('aceite 29: Conferi o texto libera sem mudar o texto')`; `it('Urgência e Aviso de turno não mostram o botão')`; `it('fechar e abrir o diálogo mantém o texto; envio aceito limpa')`.
3. [ ] GREEN; `npx tsc -b`; `--changed`.

**Aceite:** 29. **Risco: médio**.

## Task 16 — Lista do histórico com filtros (front)

**Arquivos:** modificar `frontend/src/features/team-whatsapp/components/recent-dispatches.tsx`, `components/scheduled-dispatches.tsx` (só o rótulo DG16; o `whenText` sem turno já veio da T13) e `routes/_authenticated/whatsapp-equipe/index.tsx` (só `RecentSection`); criar `components/recent-dispatches.filters.spec.tsx` e `components/scheduled-dispatches.at.spec.tsx` (testes da lista de agendados: DG16 e `shift: null`; o spec existente da lista não cresce, GG11); ajustar o mock de `useTeamDispatches` em `index.spec.tsx` (só a assinatura).

**Interfaces:** consome T13 (`useTeamDispatches(page, filters)`, `DISPATCH_STATE_LABEL`, `dispatchSituation`, `PURPOSE_LABEL`).

**Contexto vinculado:**
- GG7 e DG14. Controles acima da tabela: "De", "Até" (datas), "Finalidade" (Todas + 6), "Situação" (Todas, Agendado, Enviado, Cancelado, Não enviado: passou da hora), "Limpar filtros"; mudar filtro volta à página 1. Paginação de hoje.
- Coluna nova "Data de referência" (`rosterDate`, dd/mm/aaaa; "—" se nulo).
- DG9: situação "Ninguém recebeu" e "Não enviado: passou da hora" via `dispatchSituation(item, new Date())`; nunca o texto de sucesso.
- DG16: agendado `SCHEDULED` com `scheduledFor < agora − 2 h` (worker parado) aparece como "Não enviado: passou da hora" na lista do histórico e na lista de agendados; na lista de agendados o item (`ScheduledDispatch`) não tem `state` nem `counts`: ali a regra usa só `scheduledFor < now − SCHEDULE_GRACE_MS` (revisão 3, m-a), não `dispatchSituation`; só o rótulo (o filtro "Situação" segue o estado gravado; as ações de hoje não mudam).
- Lista de agendados (revisão 2, B): agendado em "data e hora" com vários ou todos os turnos chega com `shift: null` e mostra a data e hora de `scheduledFor` em Manaus (o `whenText` da T13), com o botão "Cancelar" de hoje (spec: "Continua só cancelar e criar de novo"). O teste usa um item com `shift: null` passado pelo esquema (`schemas.ts`), não um mock que já traga turno.

**Passos:**
1. [ ] RED: `it('aceite 31: filtrar por finalidade, período e situação chama o hook com os filtros e volta à página 1')`; `it('Limpar filtros')`; `it('coluna Data de referência')`; `it('aceite 24: envio sem ninguém recebendo mostra Ninguém recebeu')`; `it('aceite 26: vencido mostra Não enviado: passou da hora')`; `it('DG16: agendado vencido há mais de 2 h com o worker parado mostra passou da hora no histórico e nos agendados')`; `it('agendado em data e hora na lista de agendados')` (item com `shift: null`: mostra dd/mm e HH:mm de `scheduledFor` e o botão Cancelar).
2. [ ] GREEN; `npx tsc -b`; `--changed`.

**Aceite:** 24, 26, 31 (lista); G5 `rosterDate`. **Risco: médio**.

## Task 17 — Detalhe: reconferência, entraram depois, busca e telefone (front)

**Arquivos:** modificar `frontend/src/features/team-whatsapp/components/dispatch-result.tsx` e `components/recipient-table.tsx`; criar `components/recheck-summary.tsx`, `name-search.ts` e specs, `components/dispatch-result.recheck.spec.tsx`.

**Interfaces:** consome T13 (esquemas, `useDispatchRecipients(id, { status, page, q })`, rótulos). Produz `normalizeName(s): string` e `matchesName(name, q): boolean` em `name-search.ts`.

**Contexto vinculado:**
- DG10 (herdado 1): "No público (n)" = soma das situações − excluídos de telefone de `audienceExcluded` (regra de hoje, `audienceCount`, `dispatch-result.tsx:91-94`); `PHONE_EXCLUSIONS` não cresce; pulados da reconferência e `PHONE_CHANGED` contam em "No público", aparecem com o motivo na tabela e não entram em "Ficaram de fora".
- `recheck` (CG3): "Reconferido em {dd/mm/aaaa} às {HH:mm}: {n} pulado(s)."; bloco "Entraram depois do agendamento, não receberam ({n})" com nome, setor e turno (só quando há gente).
- DG16: o agendado `SCHEDULED` com `scheduledFor < agora − 2 h` (worker parado) recebe o mesmo rótulo e o mesmo aviso de `EXPIRED` no detalhe, via `dispatchSituation(item, new Date())`; só o rótulo.
- `EXPIRED`: aviso "Não enviado: passou da hora. O sistema não disparou este envio até 2 horas depois da hora marcada. Se a mensagem ainda fizer sentido, crie um envio novo."
- `PHONE_CHANGED` na tabela: motivo "Telefone mudou depois da criação do envio" e a dica "Para avisar essa pessoa, crie um envio novo."; sem botão "Repetir" (pulado não é repetível).
- Coluna "Telefone usado" (`phone`, ou "—").
- DG13: campo "Buscar pessoa pelo nome" (debounce 300 ms) manda `q` aos destinatários e filtra excluídos e "entraram depois" na tela com `matchesName` (sem acento, sem caixa) sobre o nome exibido.
- DG9: "Ninguém recebeu" via `dispatchSituation`.

**Passos:**
1. [ ] RED: `it('DG10: No público conta a foto da criação; pulados da reconferência não entram em Ficaram de fora')`; `it('bloco da reconferência com hora e pulados')`; `it('aceite 22: Entraram depois do agendamento, não receberam')`; `it('aceite 26: vencido mostra o aviso para reenviar')`; `it('DG16: agendado vencido há mais de 2 h com o worker parado mostra o mesmo aviso')`; `it('aceite 28: PHONE_CHANGED com a dica e sem Repetir')`; `it('aceite 31: busca manda q e filtra excluídos e entraram depois')`; `it('Telefone usado ou —')`; `it('matchesName sem acento e sem caixa')`.
2. [ ] GREEN; `npx tsc -b`; `--changed`.

**Aceite:** 22, 24, 26, 28, 31 (detalhe); herdado 1. **Risco: médio**.

## Task 18 — Novidades do Lote G (front)

**Arquivos:** modificar `frontend/src/release-notes.ts` (entrada nova no topo de `RELEASE_NOTES`); `release-notes.spec.ts` continua verde.

**Interfaces:** consome as decisões deste plano (só texto).

**Contexto vinculado:**
- frontend/CLAUDE.md (via plano do F, T16): entrada nova no topo, texto para o operador, `where` só com tela.
- Itens da nota: agendar em data e hora (até 30 dias; não vale para Urgência; mensagem de atividade sai antes do início); botão "Preencher com os dados da atividade" e o aviso quando a atividade muda; o texto não se perde ao fechar a janela de envio (DG12); agendados saem para a lista conferida, e no disparo quem entrou de férias, de folga, saiu do setor ou turno ou foi desativado é pulado, sem acrescentar ninguém; quem entrou depois aparece no histórico; agendado que não saiu até 2 horas depois da hora marcada não sai mais ("Não enviado: passou da hora"); se a pessoa trocou de telefone depois da criação do envio, a mensagem não sai e o "Repetir" não reenvia; histórico com filtros por período, finalidade e situação, busca por nome no detalhe e data de referência na lista.
- GG8: nenhum nome ou telefone de exemplo real.

**Passos:**
1. [ ] Entrada; `timeout 600 gate --test src/release-notes.spec.ts`; `--changed`.

**Aceite:** nota de versão do lote. **Risco: baixo** (`mecanico`).

---

## Fechamento (principal)

1. Conferir o ledger: 20 tasks aceitas; revisões `opus` em T1, T2, T5, T6b, T7, T11; `tsc` do back conferido pela principal depois de cada onda (GG13); os testes do Rastreio presentes e verdes; as asserções de `schedulePolicy` nulo viradas na T8 e o "vencido há 3 h" virado na T5.
2. Gates completos, **um de cada vez**, nada mais rodando (sem stack de QA junto): back e depois front, `--base origin/main`, no estado final; comparar com o fim do Lote F (back 6840/6870, coverage 95,1/86,9; front 2263/2263, coverage 88,3/82,0) pelo script ancorado; bloquear violação nova ou agravada; conferir `max-lines-per-function` 50 dos specs novos.
3. Migração no banco local de QA (stack `orgamind-turnos-qa`, seed fictício): `count(*)` de `TeamWhatsappDispatch` e `TeamWhatsappRecipient` antes e depois; `prisma migrate deploy`; colunas novas nulas nas linhas antigas; índices criados.
4. Boot real da API e do worker; um agendado de aviso de turno criado pela API no banco de QA, com uma pessoa posta de férias depois, dispara com o pulo (o worker local não tem Evolution: conferir só as linhas e a fila).
5. QA visual (agente `qa`, roteiro Node com `@playwright/test`, senha do seed lida no processo, login 5/min): momento "Data e hora" e painel com a hora; travas por extenso; preencher o texto e o aviso; filtros do histórico; detalhe com reconferência, entraram depois, vencido e telefone usado (dados semeados por SQL no banco de QA).
6. Revisão final do conjunto com `opus`.
7. Atualizar "Estado" deste plano; registrar na spec, em "Para a GBR confirmar", as decisões que mudam o que a GBR vê: DG3 (autor desativado não impede o agendado), DG4 (quem trocou de nível depois sai como "Saiu do setor ou turno"), DG7 (telefone apagado depois da criação sai como "Sem telefone", não "Telefone mudou"), DG9 ("ninguém recebeu" não é filtro), DG12 (fechar a janela não perde o texto), DG15 ("Repetir" não reconfere, com a tensão nominal: **"Repetir" dias depois pode chegar a quem entrou de férias depois do disparo**), DG16 (agendado vencido com o worker parado aparece como "passou da hora", mas o filtro "Situação" o mostra em "Agendado" até o worker voltar), os textos de CG4 e CG9.
8. Commits do lote, push e PR **rascunho** sobre `feat/publico-finalidade`, com o aviso: "Vai para produção junto com o Lote F (PR #18)". **Sem merge, sem deploy.** Registrar no PR e na spec, como **requisito de ambiente de produção** (DG2): `connection_limit` do Prisma no worker `≥ 2 do scheduler + concorrência do envio (hoje 2) + demais processors`; o padrão é 2×vCPU+1 (5 no VPS de 2 vCPU). Conferir o valor efetivo (`DATABASE_URL` do worker no Dokploy, sem expor a credencial) antes do deploy, que é decisão do usuário.

## Dúvidas de produto (decididas provisoriamente; para a GBR confirmar)

- **Autor desativado ou sem permissão antes do disparo (DG3):** o agendado sai, como hoje. Recomendação: manter; a alternativa (cancelar os agendados de quem foi desativado) é outra feature.
- **"Repetir" dias depois para quem entrou de férias (DG15):** não reconfere a regra, só o telefone. Tensão com o anti-objetivo "pessoa de férias receber mensagem de qualquer finalidade": **"Repetir" dias depois pode chegar a quem entrou de férias depois do disparo.** Recomendação: manter nesta etapa (a G4 só exige reconferir o telefone e a sentença só pede a reconferência no disparo); levar nominalmente para "Para a GBR confirmar" (Fechamento item 7).
- **"Ninguém recebeu" como filtro (DG9):** não entra; a situação filtra o estado gravado.
- **Troca de nível depois do agendamento (DG4):** sai como "Saiu do setor ou turno"; a spec só tem quatro motivos. Recomendação: manter.
- **Telefone apagado depois da criação (DG7):** "Sem telefone", não "Telefone mudou depois da criação do envio"; mesmo efeito (pulado, sem "Repetir"). Recomendação: manter.
- **Agendado vencido com o worker parado (DG16):** a tela já mostra "Não enviado: passou da hora"; o filtro "Situação" só o põe em "Não enviado" quando o worker volta e grava `EXPIRED`. Recomendação: manter.

## Não verificado (conferir na task dona)

- Versão do Postgres do testcontainers e do `docker-compose` (`ALTER TYPE ... ADD VALUE` dentro de transação) e se o Prisma roda a migração dentro de transação, como o cabeçalho do F supõe (T1).
- Onde o contrato do back enumera os motivos de pulo do destinatário (T2).
- ~~Se os dois `sendPhoneOf` dão o mesmo número~~ **Fechado na revisão 2:** a expressão é a mesma (`recipient-skip.ts:12-15` e `team-whatsapp-send.processor.ts:80-82`, contato ligado por cima do usuário); a T9 apaga a do processor e importa a de `recipient-skip.ts`, com o teste `processor usa o sendPhoneOf de recipient-skip: contato ligado vale por cima do usuário`; a T12 prova os dois lados pelo serviço real (`aceite 28 ponta a ponta: criado pelo serviço…`, com contato ligado e telefone de usuário diferentes). Resta à T9 registrar que o `contact` do `recipientSelect` é o mesmo contato ligado de `TeamMember`.
- ~~Se o `'at'` grava `rosterDate`~~ **Fechado na revisão 2:** `sectorDispatchFields` grava `rosterDate: r.date` sempre (`sector-dispatch.ts:225`); o turno só com um turno (`:223`).
- Forma do `LevelFilter` e se dá para montá-lo dos ids gravados sem consultar níveis (T6a/T6b).
- Se `loadDayPeopleMany` filtra setor desativado (a lista congelada vale com o setor desativado depois; T6b registra).
- Tamanho do pool de conexões do Prisma no worker (`connection_limit` da `DATABASE_URL`; nenhum `connection_limit` no repositório): requisito `connection_limit ≥ 2 do scheduler + concorrência do envio (team-whatsapp-send.processor.ts:126, hoje 2) + demais processors do worker`; padrão do Prisma 2×vCPU+1 = 5 no VPS. A T6b conta os processors do worker e registra o mínimo no report; a principal registra como requisito de ambiente de produção no Fechamento (item 8).
- Se `toRecipientItem`/`isRepeatable` já devolve `repeatable: false` para qualquer `SKIPPED` (T11, T17).
- Formatadores de data em Manaus no front (`formatDayMonth` e vizinhos) e o "hoje" de Manaus para o limite do campo de data (T14).
