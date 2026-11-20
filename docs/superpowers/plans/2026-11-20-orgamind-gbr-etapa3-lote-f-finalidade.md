# OrgaMind, Etapa 3 GBR, Lote F: finalidade e público do envio (PUB-02, PUB-04, MSG-01 parte). Implementation Plan

> **Para os agentes:** executar pela skill `sdd` (TDD, ledger em `.superpowers/sdd/2026-11-20-orgamind-gbr-etapa3-lote-f-finalidade/progress.md`). **Sem commit/push**: nenhuma task commita; a principal integra e commita o lote. Branch `feat/publico-finalidade`, criado de `9c52cc6` (topo de `feat/importar-pessoas`, Lote E). Fechamento de task por `gate --changed --base feat/importar-pessoas`. Regras dos agentes: `.superpowers/sdd/2026-11-20-orgamind-gbr-etapa3-lote-f-finalidade/{implementer-rules,reviewer-rules}.md` (criadas na Preparação). Linhas citadas são pistas e podem ter mudado.

**Goal:** quem envia para a equipe escolhe a finalidade (Aviso de turno, Reunião, Alinhamento, Palestra, Hora extra, Urgência); o servidor monta o público pela base da finalidade (equipe em serviço ou equipe vinculada), separa Férias de Folga, devolve uma prévia nominal com motivos, travas e uma impressão do público; o envio só sai se a impressão bater (senão 409 `audience_changed`) e grava finalidade, base, atividade, regra e excluídos; o histórico mostra isso lido do que foi gravado.

**Architecture:** no back, módulo `backend/src/modules/team-whatsapp/` ganha funções puras (`team-whatsapp.purpose.ts`, `audience-classify.ts`, `team-whatsapp.audience.ts`, `audience-key.ts`), um serviço novo `TeamAudienceService` (prévia e resolução do público, usado também pelo envio) e a rota `POST /internal/team-whatsapp/dispatches/preview`. Uma migração aditiva no `TeamWhatsappDispatch` (colunas nulas + enums). No front, `frontend/src/features/team-whatsapp/` troca a prévia calculada na tela pela do servidor, ganha os campos da finalidade, o painel da regra e o tratamento do 409.

**Tech Stack:** NestJS + Prisma 6 + Zod v4 (`createZodDto`) + `node:crypto` (HMAC) + Vitest/testcontainers no back; React + TanStack Router/Query + ky 2 + Radix (`components/ui`) + Vitest/Testing Library no front. **Sem dependência nova.**

**Spec:** `docs/superpowers/specs/2026-11-20-orgamind-gbr-etapa3-publico.md` — Restrições, Anti-objetivos, "Comum aos dois lotes" (C1–C5), "Lote F" (F1–F3), aceites 1–19. O Lote G (G1–G5, aceites 20–39) **não entra**; o desenho deixa o G encaixar (DF1, DF9). Sentença: `~/.claude/tribunais/2026-11-20/conselho-T/sentenca-T.md` ("Consequências", itens 1, 2 parcial, 6 e 7). Mapas: `.superpowers/sdd/2026-11-20-orgamind-gbr-etapa3-publico/fontes/`.

## Estado (20/11/2026)

- Plano escrito; nenhuma task iniciada. Branch `feat/publico-finalidade` sobre `9c52cc6`, working tree só com as pastas untracked alheias e a spec.
- Revisão 1 (opus) aplicada: I1–I3, M4–M8 (`.superpowers/sdd/2026-11-20-orgamind-gbr-etapa3-lote-f-finalidade/plan-review-1.md`). A T8 virou T8a1 e T8a2 (specs existentes no corpo novo) e T8b (envio); `RulePanel` nasce na T16; `requireShifts`/`requireLevels` em `audience-scope.ts` (T7); DF13 novo. **19 tasks em 7 ondas.**
- Re-revisão 2 (opus) aplicada pela principal: N1 (T2 põe `purpose` e chave provisória nas chamadas de `parse` dos specs de serviço), N2/N3 (`withAudienceKey` só substitui a chave e relança sem `expectError`), N4 (não remover `passesLevel`/`pickLevels`/`LevelFilter`/`parseRosterSnapshot`), N5 (saída T8c para o código morto) (`plan-review-2.md`).
- **Executado em 20/11/2026 (Lote F fechado).** As 19 tasks foram aceitas, cada uma com revisão independente (opus nas críticas e de fronteira: T1, T2, T5, T7, T8b, T9, T10). A T8c não foi necessária. Também entraram:
  - as varreduras de minors do back e do front;
  - o fechamento: a revisão final (opus) apontou I1 (envio a uma pessoa aparecia como "regra anterior") e três minors, todos corrigidos e re-revisados; o QA achou o botão "No início do turno" ausente quando a consulta do número chega depois de abrir a confirmação, também corrigido.
- **Gates completos no estado final,** comparados com o Lote E pelo script ancorado, sem nada novo nem agravado:
  - back: 6840/6870 testes (30 ignorados, 0 falhas), coverage 95,1/86,9;
  - front: 2263/2263, coverage 88,3/82,0.
- **QA visual** C1–C5 PASS num clone do banco de QA, já apagado.
- **Ledger, pareceres e logs** em `.superpowers/sdd/2026-11-20-orgamind-gbr-etapa3-lote-f-finalidade/`.
- **Pendências no backlog:** os minors listados no `carry-forward.md`. Para o G: o painel mostra "Agora" ao agendar, e `PHONE_EXCLUSIONS` precisa crescer junto com os novos pulos da reconferência.
- **Próximo passo:** plano do Lote G.

## Preparação (principal, antes da T1)

1. Conferir que `feat/importar-pessoas` aponta para `9c52cc6` e que `feat/publico-finalidade` parte dele (senão o `--changed` mede o Lote E junto).
2. Criar `.superpowers/sdd/2026-11-20-orgamind-gbr-etapa3-lote-f-finalidade/implementer-rules.md` e `reviewer-rules.md` copiando os do Lote E (`.superpowers/sdd/2026-11-19-orgamind-gbr-etapa2-lote-e-importar/`), adaptando: branch `feat/publico-finalidade`, base `feat/importar-pessoas`, este plano, esta spec, o ledger novo; referências `GFn`, `DFn` e `CFn` anexadas no fim do brief; trocar a lição do Lote E sobre `SPREADSHEET`/planilhas por "o Lote E (importar) está pronto no branch; não revisar nem mexer". Riscos do lote no `reviewer-rules.md`: pessoa de férias recebendo; envio para lista diferente da prévia; impressão que vaza telefone; prévia fora do alcance ou sem `disparo_amplo`; histórico recalculado em vez de lido; nome ou telefone em trilha/log.
3. Criar o ledger `progress.md` com a referência Git de partida.

## Decisões deste plano (o que a spec deixa com o construtor)

- **DF1. Uma migração no F, aditiva, com o que o F grava e a coluna de política.** `TeamWhatsappDispatch` ganha, todas nulas: `purpose`, `audienceBase`, `activityDate`, `activityTime`, `activityPlace`, `urgencyReason`, `audienceRule` (Json), `audienceExcluded` (Json) e `schedulePolicy` (enum `IMMEDIATE | FROZEN_RECHECK`). O F nunca escreve `schedulePolicy` (fica nulo: "agendado sem política = regra antiga", Restrições), mas a coluna existir já no F deixa o G só passar a escrever. **Fica para a migração do G** (aditiva, posterior, sem conflito): valores novos de `TeamWhatsappSkipReason` e de `TeamWhatsappDispatchState`, telefone gravado no destinatário, hora da reconferência e o registro "entraram depois". Motivo: valores de enum novos exigem rótulo e tratamento exaustivo no back e no front, que são do G; colocá-los no F deixaria valores mortos.
- **DF2. Regra e excluídos em JSON validado por Zod**, como a foto `roster` de hoje (`parseRosterSnapshot`): `audienceRule` = `{ shifts, levels, withoutLevel, selectedUserIds }`; `audienceExcluded` = lista de pessoas com motivo, **sem telefone**. Finalidade, base, folga (`includeOff`, que passa a significar só folga), data de referência (`rosterDate`) e setores (`TeamWhatsappDispatchSector`) já têm coluna. O histórico lê o JSON; nunca recalcula.
- **DF3. Todos os excluídos da prévia vão para `audienceExcluded`**, inclusive "Sem telefone", "Contato não autorizado" e "Número bloqueado"; esses três continuam também gravados como destinatário `SKIPPED` (contagens e "Repetir" como hoje).
- **DF4. Envio novo grava `roster: null`.** O detalhe de envio com finalidade lê `audienceExcluded`; `leftOut` (foto antiga) fica só para envio sem finalidade. *(Conferido na revisão 1: o único leitor da coluna é `leftOut` no detalhe, `team-whatsapp-results.service.ts:172,226-245`.)*
- **DF5. Impressão do público = HMAC-SHA256 em hex** sobre um JSON canônico (CF7), com chave derivada do `JWT_SECRET` (`backend/src/shared/config/env.schema.ts:191`). Hash simples não serve: com uma pessoa só, quem vê `•••• NNNN` acharia o número completo testando 10^7 hipóteses. O telefone entra só para quem vai receber (CF7).
- **DF6. "Relação com o setor" (C3, linha 105 e 109 da spec):** com turnos escolhidos, na base em serviço só aparece quem tem um dos turnos no vínculo da data ou é escalado num deles; quem é do setor com vínculo noutro turno e trabalha nesse outro turno **não aparece** (não é "Fora do turno"). "Fora do turno nesta data" = vínculo no setor e num turno escolhido (ou "todos"), mas a escala o põe em outro turno ou em nenhum.
- **DF7. Travas como lista, em ordem fixa (CF4);** o envio responde 422 com a primeira. Texto vazio passa a ser trava 422 `team_whatsapp.empty_text` no alvo setor (hoje 400 do DTO); no alvo pessoa continua 400.
- **DF8. Erros de regra (não são travas) respondem 422 na prévia e no envio:** base diferente da fixada, folga na base em serviço, momento não permitido, data de referência diferente da data da atividade (CF4).
- **DF9. Tipos e matriz pensados para o G:** `when` aceita hoje `now | shift_start`; `PURPOSE_RULES.when` é lista, e o G acrescenta `'at'`. `schedulePolicy` vem no painel (`null` no F).
- **DF10. `includeOff` ausente na API = `false`.** O padrão "marcada em Reunião e Palestra" é da tela.
- **DF11. A prévia não recebe o texto da tela a cada tecla:** o front manda `text: ''` na prévia e descarta a trava `team_whatsapp.empty_text` da lista do servidor, conferindo o texto localmente com o mesmo texto da trava. O envio confere de novo (422). A impressão não depende de texto, momento nem atividade.
- **DF12. Aviso de turno mantém "Todos os turnos"** como escolha válida (hoje é); "data e turno obrigatórios" (C1) = data sempre e um item da lista de turnos escolhido (um, vários ou "Todos").
- **DF13. Aba antiga recebe 400 ao enviar (mudança aceita pela principal, sem compatibilidade).** Hoje o DTO aceita o envio sem os campos novos (`create-team-dispatch.dto.ts:34-37,64`); com CF2, envio para setor sem `purpose` ou sem `audienceKey` responde 400. Uma aba aberta antes do deploy recebe 400 ao enviar até ser recarregada. Não se cria caminho de compatibilidade (nem no DTO, nem no serviço). A entrada de `release-notes.ts` (T16) e as notas do PR (Fechamento) dizem: "Se a tela de WhatsApp da equipe já estava aberta antes da atualização, recarregue a página antes de enviar."

## Global Constraints

- **GF1. Escopo:** só `backend/src/modules/team-whatsapp/`, `backend/src/schemas/contracts/team-whatsapp.schema.ts`, `backend/prisma/` e `frontend/src/features/team-whatsapp/`, as rotas `whatsapp-equipe` e `release-notes.ts`. Sem chave de permissão nova: `equipe.enviar`, `equipe.disparo_amplo`, `telefone.ver_completo` (Restrições). Envio direto a uma pessoa (alvo `user`) **não muda** e não aceita finalidade.
- **GF2. Finalidades (C1):** Aviso de turno → base em serviço, sem opção de folga, momentos agora e início do turno. Reunião e Palestra → base vinculada, opção de folga marcada na tela, data, hora e local obrigatórios, só agora (no F). Alinhamento → base vinculada (padrão) ou em serviço; opção de folga só na vinculada, desmarcada; atividade opcional, mas se informada data e hora obrigatórias e local opcional; só agora. Hora extra → base vinculada, folga desmarcada, atividade obrigatória, pelo menos uma pessoa marcada, só agora. Urgência → base em serviço, sem folga, "Motivo da urgência" obrigatório, só agora. "Fora do Alinhamento o operador não troca a base"; base diferente → 422.
- **GF3. Férias (conselho T):** "Quem está de férias na data de referência fica fora do público em todas as finalidades, inclusive por seleção nominal. A pessoa aparece na prévia e no histórico entre os excluídos, com o motivo 'Férias', separado de 'Folga'. A opção 'Incluir folga' passa a incluir só quem está de folga." Sem opção nem configuração para incluir férias.
- **GF4. Data de referência (C2):** sempre explícita no pedido (`target.date`); o servidor nunca a deduz do relógio. Reunião, Palestra e Hora extra: a data da atividade; Alinhamento: a da atividade se informada, senão a da tela; Aviso de turno e Urgência: a da tela (o atalho do turno noturno em andamento sugere a véspera, só na tela). Vínculo da data = histórico de vínculo para data passada, cadastro para hoje e futuro (já é o que `loadDayPeopleMany` entrega via `withAssignmentOn`).
- **GF5. Quem entra (C3):** em serviço = escala da data num setor e turno escolhido; remanejado para o setor entra; quem foi para outro setor sai com "Em outro setor nesta data". Vinculada = setor e turno do vínculo da data, trabalhe ou não; remanejado entra pelo setor do vínculo; troca de turno não muda o turno; "todos os turnos" inclui quem tem o setor sem turno e com turno inativo no vínculo; "Incluir folga" vale com qualquer seleção de turnos; nível = nível do vínculo da data. Cada pessoa uma vez. Pessoa inativa não aparece. Quem não tem relação com os setores e turnos não aparece (DF6).
- **GF6. Motivos exatos:** "Não selecionado", "Folga", "Férias", "Em outro setor nesta data" (só em serviço), "Fora do turno nesta data" (só em serviço), "Sem telefone", "Contato não autorizado", "Número bloqueado". Marcado e excluído mantém o motivo próprio, nunca "Não selecionado".
- **GF7. Seleção nominal:** só restringe. Id válido = está entre os incluídos ou os excluídos da base; fora disso 422 `team_whatsapp.invalid_selection` (prévia e envio). Na tela só se marca quem está em "Vão receber".
- **GF8. Prévia (C4):** mesma função do envio; aceita texto vazio e seleção vazia; devolve travas como lista. Mesmas travas de acesso do envio: `equipe.enviar`, alcance em todos os setores pedidos (403 `team_whatsapp.forbidden`, sem dizer quais setores existem) e `equipe.disparo_amplo` quando amplo (403 `team_whatsapp.broad_send_denied`). Telefone por `phoneView`, nome por `nameView` (`backend/src/shared/authz/phone-visibility.ts`), `full` = `telefone.ver_completo`.
- **GF9. Ordem no envio (alvo setor), a mesma do `resolve` da T7:** ator (403) → erros de regra (422, DF8) → alcance (403, setor por setor, na ordem pedida) → turnos/níveis (422) → disparo amplo (403, antes de ler pessoas: só depende dos setores pedidos) → leitura das pessoas e público → **impressão (409 `team_whatsapp.audience_changed`, "O público mudou depois da prévia. Confira de novo antes de enviar.")** → seleção (422 `invalid_selection`) → primeira trava (422) → número aberto (409 de hoje) → gravação. Nada é criado antes do fim. **Mudança intencional:** hoje o 422 `invalid_selection` sai antes do 403 de disparo amplo (`team-whatsapp.service.ts:228-229` chama `resolveSector`, que faz `selectMembers` em `541-542`); passa a sair depois dos 403 e do 409, porque a seleção é conferida contra o público, que só é lido depois das travas de acesso.
- **GF10. Trava "antes do início da atividade"** vale no "agora" e no "início do turno": "A mensagem precisa sair antes do início da atividade."
- **GF11. Limites:** local da atividade até 120 caracteres; motivo da urgência até 200 (aparados; DTO 400 acima). Hora `HH:mm`. Fuso America/Manaus (`zonedStart`, `todayIn` de `backend/src/modules/staff-schedule/civil-date.ts`).
- **GF12. Trilha (F2):** `team_whatsapp.dispatch` e `team_whatsapp.schedule` ganham `purpose` e `base` (valores da API); sem nome, telefone, texto, local nem motivo da urgência.
- **GF13. Envio antigo (C5):** sem finalidade gravada → finalidade "—", base "equipe em serviço (regra anterior)", sem atividade; resto como hoje. Agendado do F grava `schedulePolicy` nulo e dispara pelo worker de hoje, sem mudança.
- **GF14. Validação:** cwd `backend/` ou `frontend/`. Loop `timeout 600 gate --test src/<arquivo>`; integração `TESTCONTAINERS_ENABLED=1 timeout 600 gate --test src/<arquivo>`. Tipos: back `npx tsc --noEmit -p tsconfig.build.json --tsBuildInfoFile /tmp/<task>.tsbuildinfo`; front `npx tsc -b`. Fechamento: back `TESTCONTAINERS_ENABLED=1 timeout 600 gate --changed --base feat/importar-pessoas`; front `timeout 600 gate --changed --base feat/importar-pessoas`. Nunca suíte inteira, gate completo, coverage ou e2e (da principal).
- **GF15. Tamanho e legado:** funções e callbacks de `describe`/`it` até 50 linhas, complexidade 10, até 4 parâmetros; `describe` novos irmãos (o que existe não cresce); conferir com `npx eslint <arquivos> --rule '{"max-lines-per-function": ["error", 50], "max-params": ["error", 4], "complexity": ["error", 10], "max-depth": ["error", 4]}'`. `prettier --write` só em arquivo novo; nunca restaurar do git. `team-whatsapp.service.ts` (937 linhas) não recebe lógica nova além do que a task diz: código novo em arquivo novo.
- **GF16. Migração:** só aditiva, SQL à mão no padrão de `backend/prisma/migrations/20261119130100_people_import_tables/`; nome posterior a `20261119130100`; nunca `migrate dev`/`reset`; banco só o do testcontainer.
- **GF17. Compila entre tasks:** assinatura existente só ganha campo opcional, salvo onde a task diz e ajusta chamadores e specs no próprio ownership. Sem commit.

## Contratos compartilhados

**CF1. Rotas** (controller `team-whatsapp.controller.ts`).

| Rota | Sucesso | Erros |
|---|---|---|
| `POST /internal/team-whatsapp/dispatches/preview` body `TeamAudienceRequest` (CF2), mesmos `@Roles`/`@RequirePermission('equipe.enviar')` do `POST dispatches` | 200 `TeamAudiencePreview` (CF3) | 400; 403 `auth.permission_denied`, `team_whatsapp.forbidden`, `team_whatsapp.broad_send_denied`; 422 `invalid_shift`, `invalid_level`, `invalid_selection`, `too_many_people`, erros de regra (CF4) |
| `POST /internal/team-whatsapp/dispatches` body `CreateTeamDispatchInput` (CF2) | 202 como hoje | os de hoje + 409 `team_whatsapp.audience_changed`; 422 erros de regra e travas (CF4) |
| `GET dispatches`, `GET dispatches/:id` | campos novos (CF3) | como hoje |

**CF2. Corpo** (`backend/src/modules/team-whatsapp/dto/create-team-dispatch.dto.ts`; front espelha em `schemas.ts`).

```ts
type Purpose = 'shift_notice' | 'meeting' | 'alignment' | 'lecture' | 'overtime' | 'urgency';
type AudienceBase = 'on_duty' | 'assigned';
// teamAudienceRequestSchema (prévia):
{ text: string /* 0..2000 */, when?: 'now' | 'shift_start',
  purpose?: Purpose,            // obrigatório com target.type 'sector'; proibido com 'user' (400)
  base?: AudienceBase,          // ausente = a fixa/padrão da finalidade
  activity?: { date?: CivilDate; time?: string /* HH:mm */; place?: string /* trim, ≤120 */ },
  urgencyReason?: string,       // trim, ≤200
  audienceKey?: string,         // ignorado na prévia
  target: { type: 'user', userId } | { type: 'sector', sectorIds, shiftIds?, userIds? /* 0..500 */, date, includeOff?, levelIds?, withoutLevel? } }
// A prévia só aceita target.type 'sector' (alvo pessoa → 400).
// createTeamDispatchSchema (envio) = o mesmo + target setor exige audienceKey (/^[0-9a-f]{64}$/) e userIds 1..500 quando presente;
// alvo user exige texto não vazio (400, como hoje). Sai o refine "includeOff só sem shiftIds". Aliases sectorId/shiftId ficam.
```

**CF3. Respostas** (`backend/src/schemas/contracts/team-whatsapp.schema.ts`).

```ts
teamPurposeSchema = z.enum([...Purpose]); teamAudienceBaseSchema = z.enum(['on_duty','assigned']);
teamExclusionReasonSchema = z.enum(['not_selected','day_off','vacation','other_sector','other_shift','no_phone','not_authorized','suppressed']);
teamSchedulePolicySchema = z.enum(['immediate','frozen_recheck']);
teamActivitySchema = z.object({ date: civilDate.nullable(), time: z.string().nullable(), place: z.string().nullable() });
teamAudienceRuleViewSchema = z.object({ purpose, base, includeOff: z.boolean(), rosterDate: civilDate,
  sectors: {id,name}[], shifts: {id,name}[].nullable() /* null = todos */, levels: {id,name}[], withoutLevel: z.boolean(),
  selectedCount: int.nullable(), activity: teamActivitySchema.nullable(), urgencyReason: z.string().nullable(),
  when: z.enum(['now','shift_start']), scheduledFor: z.string().nullable(), schedulePolicy: teamSchedulePolicySchema.nullable() });
teamAudiencePersonSchema = z.object({ userId, name, sectorId: z.string(), sectorName: z.string(), shiftName: nullable, levelName: nullable });
// sectorId = área por onde o servidor manda: a do AudienceEntry que buildAudience escolheu (remanejado A→B: B na base em serviço,
// A na vinculada). O front conta e agrupa por área com ele (T14, T15); o GET roster fica só para número da área, estado do número e shiftStarts.
teamAudiencePreviewSchema = z.object({ audienceKey: z.string(), rule: teamAudienceRuleViewSchema,
  included: teamAudiencePersonSchema.extend({ phone: z.string().nullable() }).array(),
  excluded: teamAudiencePersonSchema.extend({ reason: teamExclusionReasonSchema }).array(),
  blocks: z.object({ code: z.string(), message: z.string() }).array() });
// Gravados (Json, sem telefone): audienceRuleSnapshotSchema = { shifts: {id,name}[] | null, levels: {id,name}[], withoutLevel, selectedUserIds: string[] | null };
// audienceExcludedSnapshotSchema = teamAudiencePersonSchema.extend({ reason }).array()  (parse descarta chaves fora do contrato).
// Lista (items): + purpose: nullable, base: nullable, activity: teamActivitySchema.nullable(), urgencyReason: nullable.
// Detalhe: + purpose, base (nullable), rule: teamAudienceRuleViewSchema.nullable() (null = envio antigo), excluded: (person + reason)[] ([] no antigo); leftOut fica.
```

**CF4. Erros de regra e travas** (`team-whatsapp.errors.ts`; códigos com prefixo `team_whatsapp.`).
- 409 `audience_changed`: "O público mudou depois da prévia. Confira de novo antes de enviar."
- Erros de regra (422, prévia e envio): `invalid_base` "A base do público desta finalidade é fixa."; `invalid_off_option` "A equipe em serviço não tem a opção de incluir quem está de folga."; `when_not_allowed` "Esta finalidade não pode ser enviada nesse momento."; `invalid_reference_date` "A data de referência precisa ser a data da atividade."
- Travas, nesta ordem (prévia: lista; envio: 422 com a primeira): `empty_text` "Escreva a mensagem."; `missing_activity` "Informe a data, a hora e o local da atividade." (Reunião, Palestra, Hora extra) ou "Informe a data e a hora da atividade." (Alinhamento com atividade incompleta); `missing_urgency_reason` "Informe o motivo da urgência."; `overtime_without_selection` "Marque pelo menos uma pessoa para a hora extra."; `schedule_in_past` "O início deste turno já passou" (já existe); `after_activity_start` "A mensagem precisa sair antes do início da atividade."; `no_recipients` "Nenhum destinatário válido" (já existe; = público vazio); `sector_without_number` "Há área sem número neste envio" (já existe). Número desconectado continua 409 só no envio e na tela pelo estado do número (como hoje).

**CF5. Matriz** (`team-whatsapp.purpose.ts`, T3; o front copia em `purpose.ts`, T12).

```ts
type PurposeRule = { bases: readonly AudienceBase[] /* [0] = padrão */; offOption: 'none' | 'checked' | 'unchecked';
  activity: 'none' | 'required' | 'optional'; urgencyReason: boolean; selectionRequired: boolean; when: readonly ('now' | 'shift_start')[] };
export const PURPOSE_RULES: Record<Purpose, PurposeRule>;
export function resolveBase(purpose: Purpose, base: AudienceBase | undefined): AudienceBase;          // 422 invalid_base
export function assertPurposeRules(input: AudienceRuleInput): void;                                    // 422 de regra (CF4)
export function activityStart(activity: CompleteActivity): Date;                                       // zonedStart(date, time)
export function blocksFor(input: BlocksInput): AudienceBlock[];  // ordem do CF4
type BlocksInput = { request: TeamAudienceRequest; receivingCount: number; selectedCount: number | null;
  scheduledFor: Date | null; numbersMissing: boolean; now: Date };
type AudienceBlock = { code: string; message: string };
```

**CF6. Público** (T4a, T4b).

```ts
// audience-classify.ts
export type AudienceRuleReason = 'not_selected' | 'day_off' | 'vacation' | 'other_sector' | 'other_shift';
export type AudienceEntry = { member: TeamMemberRow; sectorId: string; sectorName: string;
  shiftId: string | null; shiftName: string | null; levelName: string | null; reason: AudienceRuleReason | null };
export function classifySector(input: { base: AudienceBase; sector: { id: string; name: string }; date: CivilDate;
  people: readonly TeamMemberWithSchedule[]; filter: AudienceFilter }): AudienceEntry[];
export type AudienceFilter = { shiftIds: ReadonlySet<string> | null; includeOff: boolean; level: LevelFilter | null;
  shiftNames: ReadonlyMap<string, string> };
// team-whatsapp.audience.ts
export type Audience = { included: AudienceEntry[]; excluded: AudienceEntry[]; unknownSelected: string[] };
export function buildAudience(input: { sectors: readonly AudienceEntry[][]; userIds: readonly string[] | undefined }): Audience;
```

**CF7. Impressão** (`audience-key.ts`, T5).

```ts
export type AudienceKeyInput = { rule: { purpose; base; includeOff; date; sectorIds: string[]; shiftIds: string[] | null;
  levelIds: string[]; withoutLevel: boolean; userIds: string[] | null };
  receiving: { userId: string; sectorId: string; shiftId: string | null; phone: string }[];
  excluded: { userId: string; sectorId: string; reason: TeamExclusionReason }[] };
export function deriveAudienceSecret(jwtSecret: string): Buffer;      // HMAC-SHA256(jwtSecret, 'team-audience-key:v1')
export function audienceKey(input: AudienceKeyInput, secret: Buffer): string;  // HMAC-SHA256 hex do JSON canônico (listas ordenadas por userId; ids da regra ordenados e sem repetição)
```

**CF8. Prisma** (T1). Enums `TeamDispatchPurpose { SHIFT_NOTICE MEETING ALIGNMENT LECTURE OVERTIME URGENCY }`, `TeamAudienceBase { ON_DUTY ASSIGNED }`, `TeamSchedulePolicy { IMMEDIATE FROZEN_RECHECK }`. `TeamWhatsappDispatch` + `purpose TeamDispatchPurpose?`, `audienceBase TeamAudienceBase?`, `activityDate DateTime? @db.Date`, `activityTime String?`, `activityPlace String?`, `urgencyReason String?`, `audienceRule Json?`, `audienceExcluded Json?`, `schedulePolicy TeamSchedulePolicy?`. Conversão API ↔ banco em `team-whatsapp.purpose-codes.ts` (T6): `toDbPurpose`/`fromDbPurpose`, `toDbBase`/`fromDbBase`, `fromDbPolicy`.

**CF9. Serviço do público** (T7). `TeamAudienceService` (`team-audience.service.ts`, `@Injectable`, deps: `TeamWhatsappRepository`, `ConsentService`, `LevelsRepository`, `ConfigService`):

```ts
resolve(actor: TeamActor, input: TeamAudienceRequest & { target: SectorTargetInput }): Promise<ResolvedAudience>;
preview(actorId: string, input: TeamAudienceRequest): Promise<TeamAudiencePreview>;
type ResolvedAudience = { purpose: Purpose; base: AudienceBase; includeOff: boolean; date: CivilDate;
  sectors: TeamSector[]; shifts: ShiftRef[]; levels: { id: string; name: string }[];
  receiving: AudienceEntry[];                                  // reason null e sem pulo de telefone
  excluded: (AudienceEntry & { reason: TeamExclusionReason })[];
  unknownSelected: string[]; audienceKey: string; ruleSnapshot: AudienceRuleSnapshot };
// recipient-skip.ts: export async function phoneSkipReason(m: TeamMember, consent: ConsentService): Promise<'NO_PHONE' | 'SUPPRESSED' | 'NOT_AUTHORIZED' | null>
```

**CF10. Front** (T12). `purpose.ts` (CF5 copiado), `labels`: `PURPOSE_LABEL` = Aviso de turno, Reunião, Alinhamento, Palestra, Hora extra, Urgência; `BASE_LABEL` = Equipe em serviço, Equipe vinculada; `LEGACY_BASE_LABEL` = "equipe em serviço (regra anterior)"; `EXCLUSION_LABEL` = GF6; `INCLUDE_OFF_LABEL` = "Incluir quem está de folga"; `basePhrase(base, includeOff, date)`: em serviço "Equipe em serviço: quem a escala de {dd/mm} põe para trabalhar nos setores e turnos escolhidos. Quem está de folga ou de férias fica de fora."; vinculada com folga "Equipe vinculada: quem tem os setores e turnos escolhidos no cadastro em {dd/mm}. Quem está de folga entra porque a opção foi marcada; quem está de férias fica de fora."; sem folga "… Quem está de folga fica de fora porque a opção não foi marcada; quem está de férias também."; `policyLabel(when, policy)`: agora → "Envio imediato"; início do turno com política nula → "No início do turno, para a lista conferida agora". `api.ts`: `useAudiencePreview(body: TeamAudienceRequest | null)` (POST, `queryKey ['team-whatsapp','preview', body]`, `placeholderData: keepPreviousData`, corpo com debounce de 300 ms no chamador).

## Review Focus

1. **Férias recebendo:** férias fora nas duas bases, com "Incluir folga" e com seleção nominal. Testes: T4a `vacation sai nas duas bases mesmo com includeOff`; T4b `aceite 7: marcado de férias fica Férias`; T7 `aceite 14: em cada finalidade Férias e Folga separados`.
2. **Lista diferente da conferida:** impressão comparada antes da seleção, cobre pessoa, motivo e telefone. Testes: T5 `muda com telefone, motivo ou pessoa`; T8b `aceite 11`, `aceite 16`, `409 antes do 422: marcado que perdeu a relação dá 409`; T11 ponta a ponta. Specs antigos do envio continuam afirmando as negações (T8a1, T8a2).
3. **Prévia como porta lateral:** alcance, `disparo_amplo` e máscara iguais ao envio. Testes: T7 `aceite 17: setor fora do alcance 403`, `amplo sem disparo_amplo 403`, `sem telefone.ver_completo mascara`; T10 `sem equipe.enviar 403`.
4. **Impressão que vaza telefone:** HMAC com chave do servidor; nenhum telefone no JSON gravado. Testes: T5 `a impressão não é reproduzível sem a chave`; T6 `audienceExcluded descarta telefone`.
5. **Histórico recalculado:** detalhe lê o JSON; envio antigo aparece como regra anterior. Testes: T11 `aceite 12: editar pessoa e escala depois não muda o histórico`; T9 `aceite 13`.

## Rastreio (aceite → task → teste)

| Aceite / item | Task | Teste |
|---|---|---|
| 1 | T4a, T7 | `aceite 1: em serviço — escalados e remanejados entram; Folga, Férias e Em outro setor nesta data` |
| 2 | T4b, T7 | `aceite 2: reunião em dois setores e dois turnos com folga; férias fora; uma vez por pessoa` |
| 3 | T4a | `aceite 3: vinculada sem includeOff — folga sai com Folga` |
| 4 | T3, T8b, T15 | T3 `aceite 4: palestra sem hora ou sem local trava missing_activity`; T8b `aceite 4: 422 com o texto`; T15 `botão travado com o texto` |
| 5 | T4b | `aceite 5: seleção de duas; as outras Não selecionado` |
| 6 | T3, T4b, T7, T15 | T3 `overtime_without_selection`; T7 `aceite 6: marcada de férias fica fora e público vazio dá no_recipients` |
| 7 | T4b | `aceite 7: marcada de férias numa reunião fica Férias` |
| 8 | T3, T15 | T3 `aceite 8: urgência exige motivo, só agora, base em serviço`; T15 `revisão mostra os nomes` |
| 9 | T4a, T14, T15 | T4a `aceite 9: remanejado A→B entra em B (serviço) e em A (vinculada)`; T14 `agrupa por área pelo sectorId da prévia`; T15 `aceite 9: remanejado conta uma vez, na área que o servidor manda` |
| 10 | T3, T7 | T3 `aceite 10: base diferente da fixada 422 exceto Alinhamento`; T7 `aceite 10: Alinhamento nas duas bases dá públicos diferentes` |
| 11 | T8b, T11 | `aceite 11: escala alterada entre prévia e envio dá 409 e nada é criado` |
| 12 | T9, T11, T16 | T11 `aceite 12: histórico lê o gravado`; T16 `detalhe mostra painel e excluídos por motivo` |
| 13 | T9, T16 | `aceite 13: envio antigo — finalidade — e base equipe em serviço (regra anterior)` |
| 14 | T7, T13 | T7 `aceite 14` (test.each das 6 finalidades); T13 `rótulo Incluir quem está de folga, marcado em Reunião e Palestra` |
| 15 | T4a | `aceite 15: escala põe em outro turno → Fora do turno nesta data` |
| 16 | T5, T8b, T11 | `aceite 16: telefone de incluído trocado dá 409` |
| 17 | T7, T10 | `aceite 17: prévia de setor fora do alcance 403; sem telefone.ver_completo mascara` |
| 18 | T7, T13 | T7 `aceite 18: urgência com a véspera pega o turno noturno de ontem`; T13 `atalho do turno noturno põe a véspera na urgência` |
| 19 | T8b | `aceite 19: trilha com purpose e base, sem nome, telefone nem texto` |
| Sentença 1 (notas de versão, rótulo) | T13, T16 | rótulo; entrada em `release-notes.ts` |
| Sentença 2 parcial (base, finalidade, excluídos no schema) | T1, T6 | migração; `grava e lê finalidade, base, regra e excluídos` |
| Sentença 6 (Férias × Folga; nominal de férias) | T4a, T4b, T7 | itens 1 do Review Focus |
| Sentença 7 (base fixa; Alinhamento; cenário 7) | T3, T7, T4a | aceites 9 e 10 |
| GF10 (antes da atividade também no agora) | T3 | `after_activity_start no agora e no início do turno` |
| GF13 (agendado do F com política nula) | T8b | `início do turno grava schedulePolicy nulo` |
| GF9 (403 antes do 422 `invalid_selection`; 409 antes do 422) | T8b | `ordem nova: 403 de disparo amplo antes de 422 invalid_selection`; `409 antes do 422: marcado que perdeu a relação dá 409` |
| GF5/C3 (pessoa inativa não aparece) | T7 | `C3: pessoa inativa não aparece nem em Vão receber nem em Ficam de fora` |
| DF6 (sem relação com o turno escolhido não aparece) | T4a | `turnos escolhidos: folga ou férias com vínculo em turno não escolhido não aparece em serviço` |
| CF3 `sectorId` (contagem e grupos por área) | T2, T14, T15 | T2 `prévia valida included com phone e sectorId`; T14 `agrupa por área pelo sectorId da prévia`; T15 `grupos por número contam pelo sectorId da prévia` |
| Specs existentes do envio no corpo novo | T8a1, T8a2, T8b | nove specs verdes com `purpose`/`audienceKey`; asserções da regra antiga viradas na T8b |
| DF13 (aba antiga recebe 400) | T16, Fechamento | entrada de `release-notes.ts` e notas do PR pedem recarregar a página |

## Mapa de arquivos

- Criar (back, em `backend/src/modules/team-whatsapp/`): `team-whatsapp.purpose.ts`, `audience-classify.ts`, `team-whatsapp.audience.ts`, `audience-key.ts`, `team-whatsapp.purpose-codes.ts`, `recipient-skip.ts`, `audience-scope.ts`, `team-audience.service.ts`, `dispatch-purpose-view.ts` e specs; `team-whatsapp.sector-send.test-fixtures.ts` (helper de teste, T8a1); `team-whatsapp.service.purpose.spec.ts`; `team-audience.e2e.integration.spec.ts`; `team-dispatch-purpose.migration.integration.spec.ts`; migração `backend/prisma/migrations/20261120120000_team_dispatch_purpose/migration.sql`.
- Modificar (back): `backend/prisma/schema.prisma`; `schemas/contracts/team-whatsapp.schema.ts`; `dto/create-team-dispatch.dto.ts` e spec; `team-whatsapp.errors.ts`; `team-whatsapp.repository.ts`; `team-whatsapp.service.ts`; `team-whatsapp-results.service.ts`; `team-whatsapp.controller.ts`; `team-whatsapp.module.ts`; `team-whatsapp.test-fixtures.ts` (harness, T8a1; linha da injeção, T8b); os nove specs do envio para setor (T8a1, T8a2, T8b): `team-whatsapp.service.spec.ts`, `.service.sectors.spec.ts`, `.service.channels.spec.ts`, `.name-view.spec.ts`, `.service.single-sector.spec.ts`, `.service.broad.spec.ts`, `.service.list.spec.ts`, `.service.roster.spec.ts`, `.service.schedule.spec.ts`; `team-whatsapp.selection.ts`, `team-whatsapp.roster.ts` e specs (só remoção do que ficar sem chamador, T8b); specs vizinhos citados nas tasks.
- Criar (front, em `frontend/src/features/team-whatsapp/`): `purpose.ts`, `labels.ts`, `use-audience-preview.ts`, `components/purpose-fields.tsx`, `components/rule-panel.tsx`, `components/excluded-groups.tsx` e specs.
- Modificar (front): `schemas.ts`, `api.ts`, `error-messages.ts`, `use-send-filters.ts`, `member-filter.ts`, `components/{member-selection,send-whatsapp-dialog,recent-dispatches,dispatch-result}.tsx` e specs; `routes/_authenticated/whatsapp-equipe/index.tsx`; `release-notes.ts`.

## Ordem e paralelismo

```
Onda 1:  T1 (migração)   T2 (contrato, DTO, erros)   T4a (classificação por setor)   T12 (front: esquemas, api, rótulos)
Onda 2:  T3 (regras) <- T2    T4b (vários setores e seleção) <- T4a    T5 (impressão) <- T2    T6 (repositório) <- T1, T2
         T13 (front: campos da finalidade) <- T12    T16 (front: histórico, RulePanel e Novidades) <- T12
Onda 3:  T7 (serviço do público, prévia, audience-scope.ts) <- T2, T3, T4b, T5    T9 (histórico back) <- T2, T6
         T14 (front: público pela prévia) <- T12, T13
Onda 4:  T8a1 (helper, harness e 4 specs do envio) <- T2, T7    T10 (rota da prévia) <- T2, T7
         T15 (front: travas, confirmação, 409) <- T12, T13, T14, T16
Onda 5:  T8a2 (5 specs do envio) <- T8a1
Onda 6:  T8b (envio com finalidade) <- T3, T6, T7, T8a1, T8a2, T9
Onda 7:  T11 (ponta a ponta) <- T8b, T9, T10
```

- **Specs de serviço entre a T2 e a T8a (re-revisão 2, N1):** a T2 já põe `purpose` e a chave provisória de zeros nas chamadas de `parse` com alvo setor, para os specs de serviço continuarem verdes nas Ondas 1–3 (o serviço de hoje ignora os campos).
- **Por que T8a1 → T8a2 → T8b em série:** a T8a1 cria o helper que a T8a2 usa; a T8b muda o serviço e quebraria os nove specs se eles ainda não mandassem `purpose`/`audienceKey`. As T8a mantêm os specs verdes contra o serviço de hoje (o serviço ignora os campos novos); as asserções da regra antiga, que só podem virar quando o serviço muda, a T8a1/T8a2 listam no report e a T8b vira no seu RED.

- O front anda em paralelo ao back: o contrato da API está fixado em CF1–CF4 e o front testa com respostas falsas.
- **Ownership disjunto por onda:** Onda 1 — T1: `prisma/schema.prisma`, pasta da migração, `team-dispatch-purpose.migration.integration.spec.ts`; T2: `schemas/contracts/team-whatsapp.schema.ts` (+ spec se existir), `dto/create-team-dispatch.dto.ts` e spec, `team-whatsapp.errors.ts` (+ spec), e só as quatro linhas de `parse` de N1 em `service.channels.spec.ts`, `service.sectors.spec.ts` e `service.single-sector.spec.ts`; T4a: `audience-classify.ts` e spec; T12: `schemas.ts`, `api.ts`, `purpose.ts`, `labels.ts`, `error-messages.ts` e specs. Onda 2 — T3: `team-whatsapp.purpose.ts` e spec; T4b: `team-whatsapp.audience.ts` e spec; T5: `audience-key.ts` e spec; T6: `team-whatsapp.repository.ts`, `team-whatsapp.purpose-codes.ts`, `team-whatsapp.repository.integration.spec.ts` (só `describe` novo irmão) ou `team-dispatch-purpose.repository.integration.spec.ts` novo; T13: `use-send-filters.ts`, `components/purpose-fields.tsx`, `routes/_authenticated/whatsapp-equipe/index.tsx` e specs; T16: `components/{recent-dispatches,dispatch-result,excluded-groups,rule-panel}.tsx`, `release-notes.ts` e specs. Onda 3 — T7: `team-audience.service.ts`, `recipient-skip.ts`, `audience-scope.ts`, `team-whatsapp.module.ts`, `team-whatsapp.module.di.spec.ts` e specs novos (**não toca** `team-whatsapp.service.ts`); T9: `team-whatsapp-results.service.ts`, `dispatch-purpose-view.ts`, `team-whatsapp.service.ts` **só** `toListItem`/`listDispatches`, e specs; T14: `use-audience-preview.ts`, `member-filter.ts`, `components/member-selection.tsx`, `index.tsx` da rota e specs. Onda 4 — T8a1: `team-whatsapp.sector-send.test-fixtures.ts` (novo), `team-whatsapp.test-fixtures.ts` (harness), `team-whatsapp.service.spec.ts`, `team-whatsapp.service.sectors.spec.ts`, `team-whatsapp.service.channels.spec.ts`, `team-whatsapp.name-view.spec.ts`; T10: `team-whatsapp.controller.ts`, `team-whatsapp.controller.spec.ts`, `route-parity.spec.ts` (só a linha da rota, se exigir); T15: `components/send-whatsapp-dialog.tsx` e spec. Onda 5 — T8a2: `team-whatsapp.service.single-sector.spec.ts`, `team-whatsapp.service.broad.spec.ts`, `team-whatsapp.service.list.spec.ts`, `team-whatsapp.service.roster.spec.ts`, `team-whatsapp.service.schedule.spec.ts`. Onda 6 — T8b: `team-whatsapp.service.ts` (`dispatch`, `scheduled`, `dispatchNow`, `resolveSector`, `skipReasonOf`, cópias privadas de `requireShifts`/`requireLevels`), `team-whatsapp.service.purpose.spec.ts` (novo), `team-whatsapp.test-fixtures.ts` (só a injeção do `audience` no serviço), nos nove specs só as asserções listadas pela T8a1/T8a2, `team-whatsapp.selection.ts`, `team-whatsapp.roster.ts` e specs (só remoção). Onda 7 — T11: `team-audience.e2e.integration.spec.ts`.
- **Carga:** no máximo duas tasks com testcontainers ao mesmo tempo (T1, T6, T11 e as que rodam specs de integração existentes). Gate completo e stack de QA nunca junto de outra coisa.
- **Gate conjunto:** com tasks paralelas, o `--changed` de uma mede o diff das outras; falha só de arquivo alheio vai para o report. A principal roda o `--changed` conjunto (back e front) depois de cada onda.
- **Revisão** (SKILL.md do sdd, §Revisão por risco): críticas com revisor `opus` — T5, T7, T8b, T10. Altas com `opus` (decisão da coordenação: migração e contrato público) — T1, T2. Altas com `sonnet` — T3, T4a, T4b, T6, T8a1, T8a2, T9, T11, T14, T15. Médias — T12, T13, T16. Total **19 tasks** (4 críticas, 12 altas, 3 médias) em 7 ondas. A linha "Crítico:" pedida pelo despacho marca, para o revisor, o ponto sensível do delta (contrato, autorização, migração).

---

## Task 1 — Colunas e enums da finalidade (back)

**Arquivos:** modificar `backend/prisma/schema.prisma`; criar `backend/prisma/migrations/20261120120000_team_dispatch_purpose/migration.sql` e `backend/src/modules/team-whatsapp/team-dispatch-purpose.migration.integration.spec.ts`.

**Interfaces:** consome o modelo `TeamWhatsappDispatch` (schema ~L1743). Produz CF8 e o client gerado (`npx prisma generate`).

**Contexto vinculado:** DF1 (o F grava finalidade, base, atividade, motivo, regra e excluídos; `schedulePolicy` existe e fica nula; enums de pulo/estado e telefone do destinatário são da migração do G). GF16 (só aditiva, SQL à mão, nunca `migrate dev`). Restrições da spec: "Envios e agendados criados antes desta versão continuam válidos"; "para disparar pela regra antiga, é o agendado sem política gravada (campo nulo)".

**Passos:**
1. [ ] RED `team-dispatch-purpose.migration.integration.spec.ts` (padrão de `team-number-by-area.migration.integration.spec.ts`): `it('envio criado antes da migração fica com purpose, audienceBase, schedulePolicy e o resto nulos')`; `it('aceita as seis finalidades, as duas bases e as duas políticas')`; `it('nenhuma coluna nova é obrigatória')`.
2. [ ] GREEN: enums e colunas de CF8 no schema (comentário curto em cada coluna: o que é, `null` = envio antigo); SQL com `CREATE TYPE` e `ALTER TABLE ... ADD COLUMN` nulos, cabeçalho comentado.
3. [ ] `npx prisma generate`; `npx prisma validate`; teste de integração; typecheck; `--changed`.

**Aceite:** sentença item 2 parcial; base para aceites 12, 13. **Risco: alto** (migração não destrutiva).
**Crítico: migração — cria 3 enums e 9 colunas nulas no `TeamWhatsappDispatch`, sem tocar linha existente.**

## Task 2 — Contrato, corpo da prévia e do envio, erros (back)

**Arquivos:** modificar `backend/src/schemas/contracts/team-whatsapp.schema.ts`, `backend/src/modules/team-whatsapp/dto/create-team-dispatch.dto.ts` (+ `create-team-dispatch.dto.spec.ts`, `describe` novo irmão), `team-whatsapp.errors.ts` (+ spec se existir; senão criar `team-whatsapp.errors.spec.ts`). **Também (re-revisão 2, N1):** nas quatro chamadas de `createTeamDispatchSchema.parse` com alvo setor que existem hoje — `team-whatsapp.service.channels.spec.ts:71` e `:82`, `team-whatsapp.service.sectors.spec.ts:188`, `team-whatsapp.service.single-sector.spec.ts:182` —, só acrescentar `purpose: 'shift_notice'` e `audienceKey: '0'.repeat(64)` (o serviço de hoje ignora os dois), para esses specs não ficarem vermelhos entre a T2 e a T8a1/T8a2; conferir com grep se há outra chamada e incluí-la do mesmo jeito.

**Interfaces:** consome `civilDateSchema`. Produz CF2, CF3, CF4 (fábricas: `audienceChanged()`, `invalidBase()`, `invalidOffOption()`, `whenNotAllowed()`, `invalidReferenceDate()`, `blocked(block: AudienceBlock)` → `DomainError` 422 com `code` e `message` do bloco; constantes `BLOCK_TEXT` com os textos de CF4) e `TeamAudienceRequest`/`TeamAudiencePreview` exportados; `PreviewTeamDispatchDto`.

**Contexto vinculado:** CF2–CF4 inteiros. GF11 (local ≤120, motivo ≤200, `HH:mm`). DF7 (texto vazio vira trava 422 no alvo setor; alvo pessoa continua 400). DF10 (`includeOff` ausente = false). GF1 (alvo pessoa não aceita finalidade). Spec C3/C4: prévia "aceita texto vazio e seleção vazia".

**Passos:**
1. [ ] RED DTO: `it('prévia aceita texto vazio, userIds vazio e atividade incompleta')`; `it('envio para setor exige purpose e audienceKey hex de 64')`; `it('alvo pessoa com purpose é recusado; sem purpose passa como hoje')`; `it('includeOff com shiftIds agora passa')`; `it('local com 121 e motivo com 201 caracteres são recusados; aparados antes de medir')`; `it('hora fora de HH:mm é recusada')`; `it('aliases sectorId e shiftId continuam')`.
2. [ ] RED erros: `it('audience_changed é 409 com o texto da spec')`; `it('blocked devolve 422 com o código e o texto do bloco')`; tabela dos textos de CF4.
3. [ ] RED contrato: `it('audienceExcludedSnapshotSchema descarta telefone')`; `it('prévia valida included com phone e sectorId, excluded com reason e sectorId')`.
4. [ ] GREEN; ajustar specs existentes que esperavam o refine `includeOff só sem shiftIds` (no ownership) e as quatro chamadas de `parse` de N1 (chave provisória de zeros). Validação: os três specs de serviço tocados verdes com `gate --test`; `--changed`.

**Aceite:** contratos de todos os aceites; 4 e 11 (códigos). **Risco: alto** (contrato público).
**Crítico: contrato público de API — corpo novo do `POST dispatches`, rota de prévia e códigos 409/422 novos.**

## Task 3 — Regras da finalidade e travas (back, puro)

**Arquivos:** criar `backend/src/modules/team-whatsapp/team-whatsapp.purpose.ts` e `team-whatsapp.purpose.spec.ts`.

**Interfaces:** consome T2 (tipos, `BLOCK_TEXT`, fábricas de erro), `zonedStart` de `civil-date.ts`. Produz CF5.

**Contexto vinculado:** GF2 (matriz inteira), GF4 (data de referência = data da atividade em Reunião, Palestra, Hora extra e Alinhamento com atividade), GF10, DF7, DF8, DF12, CF4 (ordem e textos das travas). Spec C4: "disparo no passado; disparo (agora ou agendado) depois do início da atividade".

**Passos:**
1. [ ] RED: `it('PURPOSE_RULES segue a matriz do C1')` (tabela das 6); `it('aceite 10: base diferente da fixada 422 invalid_base; Alinhamento aceita as duas; ausente = padrão')`; `it('includeOff na base em serviço 422 invalid_off_option')`; `it('aceite 8: urgência exige motivo, só agora, base em serviço')`; `it('shift_start fora do Aviso de turno 422 when_not_allowed')`; `it('data de referência diferente da data da atividade 422; sem data da atividade não confere')`; `it('aceite 4: palestra sem hora ou sem local trava missing_activity com o texto')`; `it('Alinhamento: sem atividade não trava; com data sem hora trava com Informe a data e a hora da atividade.')`; `it('overtime_without_selection com seleção vazia ou ausente')`; `it('after_activity_start no agora e no início do turno; igual ao início também trava')`; `it('schedule_in_past quando o início do turno já passou')`; `it('blocos saem na ordem do CF4; empty_text com texto só de espaços')`.
2. [ ] GREEN com as assinaturas de CF5 (`blocksFor` sem acessar banco).
3. [ ] Validação; `--changed`.

**Aceite:** 4, 6 (trava), 8, 10 (servidor), GF10. **Risco: alto** (decide o que trava o envio).

## Task 4a — Classificação por setor nas duas bases (back, puro)

**Arquivos:** criar `backend/src/modules/team-whatsapp/audience-classify.ts` e `audience-classify.spec.ts` (dois ou três `describe` irmãos: em serviço, vinculada, nível).

**Interfaces:** consome `resolveDay` (`staff-schedule/schedule-resolver.ts`), `TeamMemberWithSchedule`/`TeamMemberRow` (`team-whatsapp.repository.ts` L75-82), `LevelFilter` e `passesLevel` (já exportados de `team-whatsapp.roster.ts`, L265-292; conferido na revisão 1), fixtures de `team-whatsapp.test-fixtures.ts`. Produz `classifySector`, `AudienceEntry`, `AudienceRuleReason`, `AudienceFilter` (CF6).

**Contexto vinculado:** GF3, GF5, GF6, DF6. Escala: `resolveDay` dá WORK{sectorId, shiftId}, OFF{reason DAY_OFF|VACATION}, NONE; OTHER_SECTOR vira WORK no setor da exceção. `people` de um setor (de `loadDayPeopleMany`) traz os vinculados ao setor na data (vínculo já aplicado por `withAssignmentOn`) e os de fora com exceção para o setor (`person.sectorId !== sector.id`). Turno noturno pertence à data em que começa.
- Em serviço, pessoa do setor: WORK aqui num turno escolhido (ou todos) → entra; WORK aqui noutro turno, ou NONE, com vínculo num turno escolhido (ou todos) → `other_shift`; WORK noutro setor → `other_sector`; OFF → `day_off`/`vacation`; com turnos escolhidos e vínculo fora deles, só aparece se a escala a põe num deles (DF6). De fora: WORK aqui num turno escolhido → entra; senão não aparece.
- Vinculada, só pessoa do setor: turno do vínculo num dos escolhidos (ou "todos": inclui sem turno e turno inativo); VACATION → `vacation`; DAY_OFF → entra com `includeOff`, senão `day_off`; WORK em qualquer lugar ou NONE → entra. De fora não aparece. Turno mostrado = do vínculo (`workShift.name`); em serviço = o da escala (`shiftNames`), ou o do vínculo quando fora de WORK.
- Nível (as duas bases): `passesLevel` sobre o nível do vínculo; quem não passa não aparece.

**Passos:**
1. [ ] RED: `it('aceite 1: em serviço — escalados e remanejados para o setor entram; Folga, Férias e Em outro setor nesta data')`; `it('aceite 15: escala põe em outro turno ou em nenhum → Fora do turno nesta data')`; `it('turnos escolhidos: do setor com vínculo e escala noutro turno não aparece')`; `it('turnos escolhidos: folga ou férias com vínculo em turno não escolhido não aparece em serviço')` (DF6: sem relação com o turno escolhido não vira Folga nem Férias); `it('aceite 9: remanejado A→B entra em B em serviço e em A na vinculada')`; `it('aceite 3: vinculada sem includeOff — folga sai com Folga; com includeOff entra')`; `it('vacation sai nas duas bases mesmo com includeOff')`; `it('vinculada com todos os turnos inclui sem turno e turno inativo; com turnos escolhidos só eles')`; `it('troca de turno não muda o turno na vinculada')`; `it('includeOff na vinculada vale com turno escolhido')`; `it('nível do vínculo da data filtra nas duas bases')`; `it('aceite 18 (parte pura): data da véspera põe na lista quem tem o turno noturno que começou nela')`.
2. [ ] GREEN (funções pequenas por base; `classifySector` só despacha).
3. [ ] Validação; eslint dos limites; `--changed`.

**Aceite:** 1, 3, 9, 15; sentença 6 e 7 (cenário 7). **Risco: alto** (anti-objetivo "pessoa de férias recebe").

## Task 4b — Público de vários setores e seleção nominal (back, puro)

**Arquivos:** criar `backend/src/modules/team-whatsapp/team-whatsapp.audience.ts` e `team-whatsapp.audience.spec.ts`.

**Interfaces:** consome T4a. Produz `buildAudience`, `Audience` (CF6).

**Contexto vinculado:** GF5 ("cada pessoa uma vez"), GF6 ("marcado e excluído mantém o motivo próprio, nunca Não selecionado"), GF7. Regra de unicidade deste plano: entrou em algum setor → conta como incluída no primeiro setor (ordem recebida) em que entrou; senão, excluída com o motivo do primeiro setor em que aparece. Seleção (`userIds` presente e não vazio): incluído não marcado → `not_selected`; marcado excluído → motivo próprio; id que não aparece em nenhum setor → `unknownSelected` (o chamador decide 409/422, GF9). `userIds` vazio = sem seleção.

**Passos:**
1. [ ] RED: `it('aceite 2: dois setores e dois turnos com folga — férias fora, cada pessoa uma vez')`; `it('incluída num setor e excluída noutro conta como incluída')`; `it('aceite 5: seleção de duas; as outras Não selecionado')`; `it('aceite 7: marcada de férias numa reunião fica Férias, não Não selecionado')`; `it('id sem relação vai para unknownSelected e não aparece nas listas')`; `it('userIds vazio é igual a sem seleção')`.
2. [ ] GREEN; validação; `--changed`.

**Aceite:** 2, 5, 7; parte de 6. **Risco: alto**.

## Task 5 — Impressão do público (back, puro)

**Arquivos:** criar `backend/src/modules/team-whatsapp/audience-key.ts` e `audience-key.spec.ts`.

**Interfaces:** consome tipos de T2 e `node:crypto` (`createHmac`). Produz CF7.

**Contexto vinculado:** spec C4: "a prévia devolve uma impressão do público que cobre a regra, os incluídos, os excluídos com o motivo e o telefone de cada um (resumo, sem expor o número)". DF5 (HMAC com chave derivada do `JWT_SECRET`; hash simples deixaria achar o número a partir de `•••• NNNN`; telefone só de quem recebe). Canonização: chaves em ordem fixa, listas ordenadas por `userId`, ids da regra ordenados e sem repetição, `null` explícito.

**Passos:**
1. [ ] RED: `it('mesma entrada em outra ordem dá a mesma impressão')`; `it('muda com pessoa a mais, motivo diferente, setor diferente ou telefone diferente de quem recebe')`; `it('aceite 16 (parte pura): telefone trocado muda a impressão')`; `it('telefone de excluído não entra')`; `it('muda com a regra: finalidade, base, folga, data, turnos, níveis, seleção')`; `it('a impressão não é reproduzível sem a chave: SHA-256 puro do mesmo JSON dá outro valor; o texto não contém o telefone')`; `it('deriveAudienceSecret depende do segredo')`.
2. [ ] GREEN; validação; `--changed`.

**Aceite:** 11, 16 (base). **Risco: crítico (segredo/credencial)** — deriva chave do `JWT_SECRET` e protege telefone de quem não tem `telefone.ver_completo`.
**Crítico: autorização — a impressão não pode revelar o telefone completo a quem só vê o mascarado.**

## Task 6 — Gravar e ler a finalidade no repositório (back)

**Arquivos:** modificar `backend/src/modules/team-whatsapp/team-whatsapp.repository.ts`; criar `team-whatsapp.purpose-codes.ts` (+ spec) e `team-dispatch-purpose.repository.integration.spec.ts`.

**Interfaces:** consome T1 (client), T2 (`audienceRuleSnapshotSchema`, `audienceExcludedSnapshotSchema`). Produz `NewTeamDispatch` com campos opcionais `purpose`, `audienceBase`, `activity` (`{ date: CivilDate | null; time; place }`), `urgencyReason`, `audienceRule`, `audienceExcluded`; selects da lista e do detalhe com as colunas novas; CF8 (conversões).

**Contexto vinculado:** DF2, DF4 (envio novo pode passar `roster: null`), GF13 (`schedulePolicy` nunca escrito no F). Padrão de hoje: `createDispatch` faz `rosterSnapshotSchema.parse(roster)` antes de gravar para descartar chaves fora do contrato (GC10) — o mesmo vale para `audienceRule` e `audienceExcluded`.

**Passos:**
1. [ ] RED `purpose-codes.spec.ts`: ida e volta das 6 finalidades, 2 bases e 2 políticas.
2. [ ] RED integração: `it('grava e lê finalidade, base, atividade, motivo, regra e excluídos')`; `it('audienceExcluded descarta telefone e chaves fora do contrato')`; `it('agendado grava schedulePolicy nulo')`; `it('envio sem os campos novos fica com tudo nulo, como antes')`; `it('lista e detalhe devolvem as colunas novas')`.
3. [ ] GREEN; testes de integração existentes do repositório que tocam `createDispatch` (rodar um por vez); validação; `--changed`.

**Aceite:** sentença 2 parcial; 12, 13 (base). **Risco: alto** (persistência da fotografia).

## Task 7 — Serviço do público e prévia (back)

**Arquivos:** criar `backend/src/modules/team-whatsapp/team-audience.service.ts`, `recipient-skip.ts`, `audience-scope.ts`, `team-audience.service.spec.ts`, `team-audience.service.reach.spec.ts`, `recipient-skip.spec.ts`, `audience-scope.spec.ts`; modificar `team-whatsapp.module.ts` e `team-whatsapp.module.di.spec.ts`. **Não toca `team-whatsapp.service.ts`** (é da T9 nesta onda; a T8b troca as cópias privadas).

**Interfaces:** consome T2, T3, T4a, T4b, T5; repo: ator por `findActor(actorId)` + `isTeamSender` → `teamForbidden()` (o que `requireSender` faz, `team-whatsapp.service.ts:435-438`), `findSector`, `listActiveShifts`, `listActiveSectorIds`, `loadDayPeopleMany`, `findSectorChannels`; `canSendToSector`, `isBroadSend`, `canBroadSend` (`team-whatsapp.policy.ts`); `pickLevels`/`LevelFilter` (já exportados de `team-whatsapp.roster.ts`); `nameView`/`phoneView`, `sortByViewedName`, `ConfigService.get('JWT_SECRET')`. Produz CF9 e `audience-scope.ts`:

```ts
// cópia exata de team-whatsapp.service.ts:806-819 (função privada de hoje): sem shiftIds = [] (todos);
// id fora dos ativos → 422 invalid_shift; devolve na ordem de listActiveShifts (D9).
export function requireShifts(active: readonly ShiftRef[], shiftIds: readonly string[] | undefined): TeamShiftSnapshot[];
// cópia de team-whatsapp.service.ts:570-580 (método privado de hoje): só lê os níveis com levelIds; inexistente ou inativo → 422 invalid_level.
export async function requireLevels(levels: Pick<LevelsRepository, 'listActive'>, target: SectorTargetInput): Promise<{ filter: LevelFilter; names: string[] }>;
```

**Contexto vinculado:** GF8 (prévia com as mesmas travas de acesso do envio; 403 sem dizer quais setores existem; telefone e nome mascarados conforme `telefone.ver_completo`; lista mascarada ordenada pelo nome exibido com desempate por id). GF9 até "seleção": ator (403) → erros de regra (422) → alcance (403, setor por setor) → turnos/níveis (422) → disparo amplo (403, antes de ler pessoas) → leitura das pessoas e público → (no envio, T8b: impressão 409) → seleção (422 `invalid_selection`). CF3: cada pessoa da prévia leva `sectorId` = `AudienceEntry.sectorId` da entrada que `buildAudience` escolheu (área por onde o servidor manda; remanejado A→B: B em serviço, A na vinculada). GF5: "Pessoa inativa não aparece." CF4 (erros de regra antes do alcance; travas como lista). DF3 (pulo de telefone vira excluído `no_phone`/`suppressed`/`not_authorized`; ordem: sem telefone → supressão → sem autorização, como `skipReasonOf`). DF11. Spec C4: "Id marcado sem relação com os setores e turnos escolhidos: a prévia responde 422 invalid_selection". `too_many_people` acima de `DAY_PEOPLE_LIMIT` como hoje. Teto de construtor: 4 dependências (GC2 do serviço) — usar exatamente as de CF9.
- Ordem do `resolve`: `assertPurposeRules` → `resolveBase` → setores (403, um por vez na ordem pedida) → turnos (422) → níveis (422) → disparo amplo (403) → `loadDayPeopleMany` → `classifySector` por setor (setores por nome) → `buildAudience` → `phoneSkipReason` só nos incluídos → `audienceKey`. `preview`: ator (`equipe.enviar` já no guard; `isTeamSender`, 403 como `requireSender`) → `resolve` → `unknownSelected` 422 → `blocksFor` (com `numbersMissing` pelo `findSectorChannels`) → visão. Alvo pessoa não chega aqui: o DTO da prévia o recusa com 400 (CF2).

**Passos:**
1. [ ] RED `recipient-skip.spec.ts`: ordem sem telefone → bloqueado → sem autorização; `CADASTRO_ANTERIOR` autorizado passa. RED `audience-scope.spec.ts`: `it('requireShifts: sem shiftIds devolve []; id inativo 422 invalid_shift; ordem dos ativos')`; `it('requireLevels: sem levelIds não lê o repositório; inexistente ou inativo 422 invalid_level')`.
2. [ ] RED `team-audience.service.reach.spec.ts` (fakes): `it('aceite 17: setor fora do alcance 403 forbidden, sem ler pessoas')`; `it('amplo sem equipe.disparo_amplo 403 broad_send_denied; com a chave passa')`; `it('aceite 17: sem telefone.ver_completo telefones mascarados e lista pelo nome exibido')`; `it('id sem relação 422 invalid_selection')`; `it('erro de regra vem antes do alcance')`.
3. [ ] RED `team-audience.service.spec.ts` (`describe` irmãos de até 50 linhas): `it('aceite 1: em serviço — escalados e remanejados entram; Folga, Férias e Em outro setor nesta data')`; `it('aceite 2: reunião em dois setores e dois turnos com folga; férias fora; uma vez por pessoa, com o sectorId da área que manda')`; `it('C3: pessoa inativa não aparece nem em Vão receber nem em Ficam de fora')` (se o filtro de ativo está em `loadDayPeopleMany`, o fake reproduz o filtro e o report cita a linha do repositório; se não está, o filtro entra no `resolve`); `it('aceite 14: em cada finalidade Férias e Folga separados')` (`test.each` das 6, com a base de cada uma; folga incluída onde marcada); `it('aceite 10: Alinhamento nas duas bases dá públicos diferentes com folga e remanejado')`; `it('aceite 6: hora extra com a marcada de férias — Férias e trava no_recipients')`; `it('aceite 18: urgência com a véspera pega o turno noturno de ontem')`; `it('sem telefone vira excluído Sem telefone e sai de quem recebe')`; `it('prévia com texto vazio devolve empty_text na lista, sem 422')`; `it('área sem número vira trava sector_without_number')`; `it('mesma entrada dá a mesma audienceKey; painel com finalidade, base, folga, data, atividade, momento e política nula')`.
4. [ ] GREEN; registrar o serviço no módulo e no spec de DI; validação; `--changed`.

**Aceite:** 1, 2, 6, 10, 14, 17, 18; C3 (inativa); sentença 6 e 7. **Risco: crítico (autorização)** — rota nova que expõe nomes e telefones da equipe; alcance, disparo amplo e máscara.
**Crítico: autorização/alcance da rota de prévia — mesma porta do envio, sem revelar setor fora do alcance nem telefone completo.**

## Task 8a1 — Specs do envio no corpo novo, parte 1: helper, harness e 4 specs (back, só teste)

**Arquivos:** criar `backend/src/modules/team-whatsapp/team-whatsapp.sector-send.test-fixtures.ts` (mesmo padrão de nome de `team-whatsapp.test-fixtures.ts`; conferir que coverage e Sonar o tratam como arquivo de teste e registrar no report); modificar `team-whatsapp.test-fixtures.ts` (harness) e os specs `team-whatsapp.service.spec.ts`, `team-whatsapp.service.sectors.spec.ts`, `team-whatsapp.service.channels.spec.ts`, `team-whatsapp.name-view.spec.ts`. **Nenhum arquivo de produção.**

**Interfaces:** consome T2 (`CreateTeamDispatchInput` com `purpose`, `base`, `audienceKey`), T7 (`TeamAudienceService` com construtor `TeamWhatsappRepository`, `ConsentService`, `LevelsRepository`, `ConfigService`; `resolve(actor, input)` devolve `audienceKey`). Produz:

```ts
// team-whatsapp.test-fixtures.ts: o harness passa a expor `audience`, um TeamAudienceService real montado sobre os
// mesmos fakes do harness (repo, consent, levels) e um ConfigService falso com JWT_SECRET de teste (≥ 32 caracteres).
// O serviço de envio ainda NÃO recebe esse `audience` (a T8b faz a injeção).
// team-whatsapp.sector-send.test-fixtures.ts:
export async function withAudienceKey(
  h: Harness, actorId: string, input: CreateTeamDispatchInput, opts?: { expectError?: boolean },
): Promise<CreateTeamDispatchInput>;
// `input` com ou sem a chave provisória '0'.repeat(64) (validado ou montado direto pelo spec) (os specs validam antes para aplicar os apelidos
// sectorId/shiftId; a T2 deixou a chave de zeros nas chamadas de parse) — o helper só SUBSTITUI a chave (re-revisão 2, N2).
// alvo 'user': devolve o corpo igual. Alvo 'sector': purpose 'shift_notice' se ausente; audienceKey = (await h.audience.resolve(ator do fake, corpo)).audienceKey.
// Se o resolve lança: com `expectError: true` (cenário de 403/422 que o teste espera) devolve o corpo com a chave de zeros —
// pela GF9 o envio lança o mesmo erro antes de comparar a impressão; sem `expectError`, RELANÇA, para um teste de sucesso
// que caia numa regra nova falhar alto em vez de ficar verde até a T8b (re-revisão 2, N3). O report da T8a lista esses casos.
```

**Contexto vinculado:**
- CF2: envio para setor exige `purpose` e `audienceKey` (`/^[0-9a-f]{64}$/`); alvo pessoa não aceita finalidade (400).
- GF9: ator (403) → erros de regra (422) → alcance (403) → turnos/níveis (422) → disparo amplo (403, antes de ler pessoas) → público → impressão (409 `audience_changed`) → seleção (422 `invalid_selection`) → primeira trava (422) → número aberto (409) → gravação.
- GF2: Aviso de turno = base em serviço, sem opção de folga; Alinhamento = vinculada (padrão) ou em serviço, folga só na vinculada, atividade opcional, só "agora". Escolha nos specs: `shift_notice` por padrão; caso com `includeOff` usa `purpose: 'alignment'` e `base: 'assigned'`; `when: 'shift_start'` só com `shift_notice`.
- A impressão é calculada no momento do envio do teste, depois de montar os fakes do cenário; em teste que muda fakes "entre prévia e envio", calcular antes da mudança.
- Esta task **não muda o serviço**: os specs ficam verdes contra o serviço de hoje (ele ignora `purpose`/`audienceKey`). Asserção que depende da regra antiga não muda aqui (ficaria vermelha até a T8b): listar no report, por `arquivo:linha`, cada uma — `roster`/`leftOut` gravado em envio novo; `includeOff` incluindo quem está de férias; `invalid_selection` antes do 403 de disparo amplo; `includeOff` com `shiftIds` recusado; pessoa sem relação com o turno escolhido recebendo (DF6); qualquer outra achada.
- Nenhuma asserção de negação (403, 422, 409) pode sumir nem afrouxar. GF15: `describe` existente não cresce (helper reduz linhas); `prettier --write` só no arquivo novo.

**Passos:**
1. [ ] Harness e helper; `describe` novo irmão em `team-whatsapp.service.sectors.spec.ts` com `it('withAudienceKey dá a mesma impressão da prévia para o mesmo corpo')` (compara com `h.audience.preview`).
2. [ ] Em cada um dos 4 specs: todo envio para setor passa por `withAudienceKey`; builders locais ganham `purpose`. `timeout 600 gate --test src/modules/team-whatsapp/<spec>` por arquivo.
3. [ ] `npx tsc --noEmit -p tsconfig.build.json --tsBuildInfoFile /tmp/t8a1.tsbuildinfo`; eslint dos limites (GF15); `--changed`. Report com a lista de asserções da regra antiga.

**Aceite:** os 4 specs verdes com corpo no contrato novo e as mesmas negações; lista de asserções antigas no report. **Risco: alto** (specs de autorização do envio: nenhuma negação pode sumir).

## Task 8a2 — Specs do envio no corpo novo, parte 2: 5 specs (back, só teste)

**Arquivos:** modificar `backend/src/modules/team-whatsapp/team-whatsapp.service.single-sector.spec.ts`, `team-whatsapp.service.broad.spec.ts`, `team-whatsapp.service.list.spec.ts`, `team-whatsapp.service.roster.spec.ts`, `team-whatsapp.service.schedule.spec.ts`. **Nenhum arquivo de produção**, nem os fixtures (são da T8a1).

**Interfaces:** consome T8a1 (`withAudienceKey(h, actorId, input)` em `team-whatsapp.sector-send.test-fixtures.ts`; `h.audience` no harness) e T2 (`CreateTeamDispatchInput`).

**Contexto vinculado:**
- CF2: envio para setor exige `purpose` e `audienceKey` (`/^[0-9a-f]{64}$/`); alvo pessoa não aceita finalidade (400).
- GF9: ator (403) → erros de regra (422) → alcance (403) → turnos/níveis (422) → disparo amplo (403, antes de ler pessoas) → público → impressão (409) → seleção (422 `invalid_selection`) → primeira trava (422) → número aberto (409) → gravação.
- GF2 e escolha nos specs: `shift_notice` por padrão; caso com `includeOff` usa `purpose: 'alignment'` e `base: 'assigned'`; `when: 'shift_start'` só com `shift_notice`.
- Impressão calculada depois de montar os fakes do cenário; em teste que muda fakes "entre prévia e envio", calcular antes da mudança. Se o `resolve` lança, o helper usa `'0'.repeat(64)`.
- Serviço não muda: specs verdes contra o serviço de hoje. Asserção da regra antiga (`roster`/`leftOut` gravado em envio novo; `includeOff` com férias; `invalid_selection` antes do 403 de disparo amplo; `includeOff` com `shiftIds` recusado; DF6) não muda aqui: vai para o report por `arquivo:linha`.
- Nenhuma negação some nem afrouxa. `describe` existente não cresce.

**Passos:**
1. [ ] Em cada um dos 5 specs: todo envio para setor passa por `withAudienceKey`; builders locais ganham `purpose`. `timeout 600 gate --test src/modules/team-whatsapp/<spec>` por arquivo.
2. [ ] Typecheck (`/tmp/t8a2.tsbuildinfo`); eslint dos limites; `--changed`. Report com a lista de asserções antigas.

**Aceite:** os 5 specs verdes com corpo no contrato novo e as mesmas negações; lista no report. **Risco: alto** (inclui `broad.spec.ts`, negação de disparo amplo).

## Task 8b — Envio com finalidade: ordem 403 → 409 → 422, gravação e trilha (back)

**Arquivos:** modificar `backend/src/modules/team-whatsapp/team-whatsapp.service.ts` (`dispatch`, `scheduled`, `dispatchNow`, `resolveSector`, `skipReasonOf`; apagar as cópias privadas `requireShifts`, L810, e `requireLevels`, L571, e importar as de `audience-scope.ts`), `team-whatsapp.test-fixtures.ts` (só a injeção de `h.audience` no serviço); criar `team-whatsapp.service.purpose.spec.ts`; nos nove specs da T8a1/T8a2, **só** as asserções que os reports listaram; em `team-whatsapp.selection.ts`, `team-whatsapp.roster.ts` e specs, só remover o que ficar sem chamador.

**Interfaces:** consome T3 (`blocksFor`, `PURPOSE_RULES`), T6 (`NewTeamDispatch` novo, `toDb*`), T7 (`TeamAudienceService.resolve`, `phoneSkipReason`, `requireShifts`/`requireLevels` de `audience-scope.ts`; injetar o serviço por propriedade, como `levels` e `live`), T8a1/T8a2 (specs com `purpose`/`audienceKey` e a lista de asserções antigas). Produz `dispatch` com a ordem de GF9.

**Contexto vinculado:**
- GF9: ator (403) → erros de regra (422, DF8) → alcance (403, setor por setor) → turnos/níveis (422) → disparo amplo (403, antes de ler pessoas) → leitura das pessoas e público → impressão (409 `audience_changed`, "O público mudou depois da prévia. Confira de novo antes de enviar.") → seleção (422 `invalid_selection`) → primeira trava (422) → número aberto (409 de hoje) → gravação. Nada é criado antes do fim. "Marcado que perdeu a relação com o setor entre a prévia e a confirmação dá 409, não 422."
- Mudança intencional (M4): hoje o 422 `invalid_selection` sai antes do 403 de disparo amplo (`service.ts:228-229` → `resolveSector` → `selectMembers`, `541-542`); passa a sair depois dos 403 e do 409.
- GF12: trilha `team_whatsapp.dispatch` e `team_whatsapp.schedule` com `purpose` e `base` (valores da API); sem nome, telefone, texto, local nem motivo da urgência.
- GF13: agendado do F grava `schedulePolicy` nulo; o worker não muda.
- DF3: destinatários = quem recebe `QUEUED`/`SCHEDULED`; pulados de telefone `SKIPPED` com `skipReason`; `audienceExcluded` com todos os excluídos (inclusive os três de telefone). DF4: envio novo grava `roster: null`.
- Turno e área do destinatário: os do `AudienceEntry` (`sectorId` = área por onde o servidor manda, CF3; turno da escala em serviço, do vínculo na vinculada). `targetLabel` e `sectors` como hoje.
- Sem código morto (M7): o envio deixa de chamar `eligibleAcross`, `selectMembers` e `rosterSnapshot`. Fica só o que o GET roster usa; função sem chamador de produção sai com seu teste. **Não remover** `passesLevel`, `pickLevels` e `LevelFilter` (`roster.ts`), nem `parseRosterSnapshot` (`roster.ts:32`, lido pelo detalhe): a T4a, a T7 e o histórico os usam (re-revisão 2, N4).
- **Saída de tamanho (re-revisão 2, N5):** se a T8b passar de ~60 chamadas antes do passo 3, ela fecha com o serviço novo e os specs verdes e devolve a remoção do código morto como **T8c** (mesma onda, depois dela; ownership: `team-whatsapp.selection.ts`, `team-whatsapp.roster.ts` e specs, só remoção; revisor `sonnet`). Grep de 20/11: `rosterSnapshot` só em `service.ts:565`; `eligibleAcross` em `service.ts:541` e `roster.ts:192` (dentro de `rosterSnapshot`); `selectMembers` só em `service.ts:541`.
- DF13: envio para setor sem `purpose`/`audienceKey` é 400 no DTO (T2); o serviço não cria caminho de compatibilidade.
- Alvo pessoa: caminho de hoje; `skipReasonOf` passa a chamar `phoneSkipReason`.

**Passos:**
1. [ ] RED `team-whatsapp.service.purpose.spec.ts` (fakes; `describe` irmãos de até 50 linhas): `it('aceite 11: escala alterada entre prévia e envio — 409 audience_changed e nada é criado')`; `it('aceite 16: telefone de incluído trocado — 409')`; `it('409 antes do 422: marcado que perdeu a relação dá 409')`; `it('ordem nova: 403 de disparo amplo antes de 422 invalid_selection')`; `it('mesma impressão e id sem relação dá 422 invalid_selection')`; `it('aceite 4: palestra sem local — 422 missing_activity com o texto, nada criado')`; `it('texto só com espaços no alvo setor — 422 empty_text')`; `it('grava finalidade, base, atividade, motivo, regra e excluídos; roster nulo')`; `it('destinatário sai pela área do sectorId da entrada; remanejado na vinculada pela área do vínculo')`; `it('início do turno grava schedulePolicy nulo e destinatários SCHEDULED')`; `it('aceite 19: trilha dispatch e schedule com purpose e base, sem nome, telefone, texto, local nem motivo')`; `it('alvo pessoa continua como hoje')`.
2. [ ] RED: virar para a regra nova as asserções listadas pela T8a1/T8a2 (roster nulo e `audienceExcluded`; férias fora com `includeOff`; 403 antes de `invalid_selection`; `includeOff` com `shiftIds` aceito na vinculada; DF6), sem afrouxar negação.
3. [ ] GREEN; harness injeta `h.audience` no serviço; troca das cópias privadas; `grep -rn "eligibleAcross\|selectMembers\|rosterSnapshot" backend/src` antes e depois, no report, e remoção do que ficar sem chamador.
4. [ ] Validação (cada spec tocado com `gate --test`, um por vez); typecheck; eslint dos limites; `--changed`.

**Aceite:** 4, 11, 16, 19; GF9, GF13. **Risco: crítico (autorização)** — reescreve a ordem das travas de acesso do `POST dispatches` (alcance, disparo amplo) junto com a impressão.
**Crítico: contrato público de API e autorização — novo 409 e 422 no `POST dispatches`, ordem 403 → 409 → 422.**

## Task 9 — Histórico com finalidade (back)

**Arquivos:** criar `backend/src/modules/team-whatsapp/dispatch-purpose-view.ts` e spec; modificar `team-whatsapp-results.service.ts` (`detail`) e `team-whatsapp.service.ts` **só** em `toListItem`/`listDispatches`; specs `team-whatsapp-results.service.purpose.spec.ts` e `team-whatsapp.service.list-purpose.spec.ts` (novos).

**Interfaces:** consome T2 (CF3), T6 (colunas lidas, `fromDb*`), `parse` dos snapshots, `nameView`, `sortByViewedName`. Produz `purposeView(row): { purpose; base; activity; urgencyReason }` e `ruleView(row, sectors): TeamAudienceRuleView | null`, usados por lista e detalhe.

**Contexto vinculado:** F3: "A lista e o detalhe mostram finalidade, base e dados da atividade; o detalhe mostra o painel da regra e os excluídos por motivo, lidos do que foi gravado." GF13 (envio sem finalidade: `purpose`, `base`, `rule`, `activity` nulos, `excluded` []; `leftOut` como hoje). GF8 (nome por `nameView`; lista mascarada ordenada pelo nome exibido). `when` do painel = `shift_start` se `scheduledFor` não é nulo, senão `now`.

**Passos:**
1. [ ] RED: `it('aceite 13: envio sem finalidade devolve purpose, base e rule nulos e excluded vazio')`; `it('detalhe devolve painel e excluídos lidos do JSON, sem recalcular')` (spy: nenhuma leitura de escala); `it('sem telefone.ver_completo nomes dos excluídos mascarados e ordenados pelo nome exibido')`; `it('lista traz finalidade, base e atividade')`; `it('JSON fora do formato vira excluded vazio, sem 500')`.
2. [ ] GREEN; validação; `--changed`.

**Aceite:** 12, 13. **Risco: alto** (máscara de nome no histórico).
**Crítico: contrato público de API — campos novos na lista e no detalhe dos envios.**

## Task 10 — Rota da prévia (back)

**Arquivos:** modificar `backend/src/modules/team-whatsapp/team-whatsapp.controller.ts` e `team-whatsapp.controller.spec.ts` (`describe` novo irmão); `permissions/route-parity.spec.ts` só se exigir a linha da rota.

**Interfaces:** consome T2 (`PreviewTeamDispatchDto`), T7 (`TeamAudienceService.preview`). Produz CF1 (rota de prévia).

**Contexto vinculado:** CF1 (mesmos `@Roles` e `@RequirePermission('equipe.enviar')` do `POST dispatches`; 200, não 202). GF8. Lição do Lote E: cada rota com permissão mantém pelo menos uma negação e uma concessão no spec.

**Passos:**
1. [ ] RED: `it('POST dispatches/preview sem equipe.enviar 403 auth.permission_denied')`; `it('VIEWER 403')`; `it('com a chave chama preview com o ator e o corpo e responde 200')`; `it('corpo inválido 400')`.
2. [ ] GREEN; validação; `--changed`.

**Aceite:** 17 (parte da rota). **Risco: crítico (autorização)** — rota pública nova.
**Crítico: autorização da rota de prévia — guarda `equipe.enviar` e papéis iguais ao envio.**

## Task 11 — Ponta a ponta da finalidade (back)

**Arquivos:** criar `backend/src/modules/team-whatsapp/team-audience.e2e.integration.spec.ts` (fábricas no próprio arquivo ou em `team-whatsapp.test-fixtures.ts` só acrescentando).

**Interfaces:** consome T8b, T9, T10 com banco real (testcontainers), serviços reais e fila/porta do número falsas, como os integration specs vizinhos (`team-whatsapp.schedule.integration.spec.ts`).

**Contexto vinculado:** aceites 11, 12, 16 e GF9. "O histórico de um envio antigo mudar porque o cadastro, o vínculo ou a escala mudaram" é anti-objetivo. Telefones e nomes fictícios (`+5592991110001`).

**Passos:**
1. [ ] RED: `it('aceite 11: prévia, exceção de folga lançada, envio com a impressão antiga — 409 e nenhuma linha criada')`; `it('aceite 16: telefone do incluído trocado — 409')`; `it('aceite 12: envia, depois muda nome, setor e escala da pessoa — detalhe igual ao da criação')`; `it('reunião por vínculo grava finalidade, base, regra e excluídos; agendado de aviso de turno com schedulePolicy nulo')`.
2. [ ] GREEN (só teste; defeito achado volta para a task dona); `TESTCONTAINERS_ENABLED=1 timeout 600 gate --test`; `--changed`.

**Aceite:** 11, 12, 16. **Risco: alto**.

## Task 12 — Esquemas, API, matriz e rótulos (front)

**Arquivos:** modificar `frontend/src/features/team-whatsapp/{schemas,api,error-messages}.ts` e specs; criar `purpose.ts`, `labels.ts` e specs.

**Interfaces:** consome CF1–CF5 e CF10 (contrato fixado no plano). Produz `teamAudiencePreviewSchema`, `TeamAudienceRequest`, `CreateDispatchInput` com os campos de CF2, campos novos de `dispatchListSchema`/`dispatchDetailSchema`, `useAudiencePreview`, `PURPOSE_RULES` (cópia de CF5), rótulos de CF10 e `TEAM_ERROR_MESSAGES` para os códigos de CF4.

**Contexto vinculado:** CF10 (textos exatos), GF6, CF4 (textos), ky 2: corpo de erro só por `readApiErrorBody` (`code` em `HTTPError.data`). Envio antigo: `purpose`, `base`, `rule` nulos.

**Passos:**
1. [ ] RED: `it('prévia valida a resposta do servidor')`; `it('lista e detalhe aceitam envio antigo com campos nulos')`; `it('useAudiencePreview faz POST em dispatches/preview e não chama com corpo nulo')`; `it('PURPOSE_RULES igual ao CF5')`; `it('basePhrase nas três combinações')`; `it('rótulos dos oito motivos')`; `it('audience_changed e as travas têm texto')`.
2. [ ] GREEN; `npx tsc -b`; `--changed`.

**Aceite:** base de 12–14 e da tela. **Risco: médio**.

## Task 13 — Campos da finalidade e da atividade (front)

**Arquivos:** modificar `frontend/src/features/team-whatsapp/use-send-filters.ts` e `routes/_authenticated/whatsapp-equipe/index.tsx` (+ specs); criar `components/purpose-fields.tsx` e spec.

**Interfaces:** consome T12. Produz no estado dos filtros: `purpose` (padrão `shift_notice`), `base`, `includeOff`, `activity`, `urgencyReason`, e `audienceRequest(filters): TeamAudienceRequest | null` (sem texto, `when` à parte) com `referenceDate(filters)` (GF4).

**Contexto vinculado:** F1: "Primeiro campo: finalidade. Trocar a finalidade ajusta base, opção de folga, campos obrigatórios e momentos de disparo permitidos; a seleção de pessoas é refeita." "Campos da atividade (Reunião, Palestra, Hora extra; opcionais no Alinhamento): data, hora de início e local (até 120 caracteres). Urgência: campo 'Motivo da urgência' (até 200 caracteres)." "No Alinhamento, um controle 'Base do público': 'Equipe vinculada' (padrão) ou 'Equipe em serviço'. Nas outras finalidades a base aparece como texto." "'Incluir folga' aparece só na base vinculada." CF10 (`INCLUDE_OFF_LABEL` "Incluir quem está de folga", marcado por padrão em Reunião e Palestra). GF4 (data). O atalho do turno noturno em andamento continua sugerindo a véspera (Aviso de turno e Urgência).

**Passos:**
1. [ ] RED: `it('finalidade é o primeiro campo e começa em Aviso de turno')`; `it('aceite 14: Incluir quem está de folga marcado em Reunião e Palestra, desmarcado em Hora extra e Alinhamento, ausente em Aviso de turno e Urgência')`; `it('Alinhamento mostra Base do público; trocar para Equipe em serviço esconde a folga')`; `it('trocar a finalidade limpa a seleção e ajusta a folga')`; `it('local até 120 e motivo até 200 caracteres')`; `it('Reunião usa a data da atividade como data de referência; Alinhamento sem atividade usa a da tela')`; `it('aceite 18: atalho do turno noturno põe a véspera na Urgência')`; `it('turno escolhido não zera mais a folga na base vinculada')`.
2. [ ] GREEN; `npx tsc -b`; `--changed`.

**Aceite:** 14 (tela), 18 (tela); F1. **Risco: médio**.

## Task 14 — Público pela prévia do servidor (front)

**Arquivos:** criar `frontend/src/features/team-whatsapp/use-audience-preview.ts` e spec; modificar `components/member-selection.tsx`, `member-filter.ts`, a rota `whatsapp-equipe/index.tsx` e specs.

**Interfaces:** consome T12 (`useAudiencePreview`), T13 (`audienceRequest`). Produz `useDebouncedAudience(filters)` → `{ preview, isFresh, error }` (`isFresh` = resposta do corpo atual, sem `placeholderData` nem busca em andamento) e a lista "Vão receber (n)" / "Ficam de fora (n)" por motivo.

**Contexto vinculado:** F1: "A prévia vem do servidor e se atualiza quando os filtros mudam." C3: "Na tela, só dá para marcar quem está em 'Vão receber'." C4: "Mostra: 'Vão receber (n)' com nome, setor, turno e nível; 'Ficam de fora (n)' agrupados por motivo." GF6 (rótulos). Prévia 422 `invalid_selection` (marcado que perdeu a relação): a tela limpa a seleção, avisa "A lista mudou. Marque as pessoas de novo." e pede a prévia de novo. 403: mensagem de hoje. Funções de `member-filter.ts` que deixarem de ser usadas saem (sem código morto).
- CF3: cada pessoa da prévia traz `sectorId` = área por onde o servidor manda (remanejado A→B: B na base em serviço, A na vinculada). Contagem e grupos por área saem de `preview.included[].sectorId`. O GET roster continua só para o número da área, o estado do número e `shiftStarts` (`routes/_authenticated/whatsapp-equipe/index.tsx:153-156`); a lista de pessoas não vem mais dele (hoje o remanejado aparece nas duas áreas, `team-whatsapp.repository.ts:503-508`).

**Passos:**
1. [ ] RED: `it('mostra Vão receber e Ficam de fora vindos do servidor, agrupados por motivo')`; `it('só quem está em Vão receber tem caixa de marcar')`; `it('Férias e Folga em grupos separados')`; `it('agrupa por área pelo sectorId da prévia; remanejado aparece uma vez')`; `it('GET roster só alimenta número da área, estado do número e shiftStarts')`; `it('mudar um filtro pede nova prévia depois de 300 ms')`; `it('422 invalid_selection limpa a seleção e avisa')`; `it('telefone como veio do servidor (mascarado ou não)')`.
2. [ ] GREEN; `npx tsc -b`; `--changed`.

**Aceite:** 5, 7 (tela), 9 (tela), 14; F1. **Risco: alto** (o operador confirma o que vê).

## Task 15 — Travas, confirmação e 409 no diálogo (front)

**Arquivos:** modificar `frontend/src/features/team-whatsapp/components/send-whatsapp-dialog.tsx` e spec. (O `RulePanel` é da T16; aqui só se usa.)

**Interfaces:** consome T12, T13, T14 (`preview`, `isFresh`), T16 (`RulePanel({ rule, includedCount, excludedCount })` de `components/rule-panel.tsx`). Produz o diálogo que envia `CreateDispatchInput` com `audienceKey` da prévia atual e mostra o `RulePanel` da prévia antes de confirmar.

**Contexto vinculado:** C4: o painel ("finalidade, base (com a frase da folga), setores, turnos, níveis, folga incluída ou não, data de referência, dados da atividade, momento do disparo e política do agendamento") aparece antes de confirmar. "Cada trava aparece por extenso perto do botão." CF3: `receivingBySector`/`buildChannelGroups` (`send-whatsapp-dialog.tsx:107-111,129-135`) passam a contar e agrupar por área com `preview.included[].sectorId`; o GET roster entra só com o número da área e o estado do número (remanejado A→B conta uma vez, pela área que o servidor manda). 409: "A tela fecha a confirmação e relê a prévia", com o texto "O público mudou depois da prévia. Confira de novo antes de enviar.". Momentos: "No início do turno" só no Aviso de turno com um turno; Urgência só "Enviar agora". DF11 (trava de texto local, descartando `team_whatsapp.empty_text` da lista do servidor). O botão só libera com `isFresh`, sem travas, com texto e número aberto (regras de hoje do número).

**Passos:**
1. [ ] RED: `it('diálogo mostra o RulePanel com a regra da prévia antes de confirmar')`; `it('grupos por número contam pelo sectorId da prévia')`; `it('aceite 9: remanejado conta uma vez, na área que o servidor manda')`; `it('aceite 4: palestra sem hora — botão travado com o texto da trava')`; `it('aceite 8: urgência só Enviar agora e a revisão lista os nomes')`; `it('hora extra sem pessoa marcada fica travada com o texto')`; `it('envio leva a audienceKey da prévia atual; prévia desatualizada trava o botão')`; `it('409 audience_changed fecha a confirmação, mostra o texto e relê a prévia')`; `it('No início do turno só aparece no Aviso de turno com um turno')`.
2. [ ] GREEN; `npx tsc -b`; `--changed`.

**Aceite:** 4, 6, 8, 9 (tela), 11 (tela). **Risco: alto**.

## Task 16 — Histórico com finalidade, painel da regra e Novidades (front)

**Arquivos:** modificar `frontend/src/features/team-whatsapp/components/{recent-dispatches,dispatch-result}.tsx` e specs, `frontend/src/release-notes.ts`; criar `components/rule-panel.tsx`, `components/excluded-groups.tsx` e specs.

**Interfaces:** consome T12 (schemas, rótulos, `basePhrase`, `policyLabel`). Produz `RulePanel({ rule, includedCount, excludedCount }: { rule: TeamAudienceRuleView; includedCount: number; excludedCount: number })` em `components/rule-panel.tsx`, usado no detalhe (aqui) e no diálogo de envio (T15), e `ExcludedGroups`.

**Contexto vinculado:** F3; GF13 (antigo: finalidade "—", base "equipe em serviço (regra anterior)"; "Ficaram de fora" de hoje continua para o antigo). C4: o painel mostra "finalidade, base (com a frase da folga), setores, turnos, níveis, folga incluída ou não, data de referência, dados da atividade, momento do disparo e política do agendamento"; textos de CF10 (`basePhrase`, `policyLabel`; `shifts: null` = todos os turnos). frontend/CLAUDE.md: entrada nova no topo de `RELEASE_NOTES`, texto para o operador, `where` só com tela. Sentença item 1: a nota diz que "Incluir quem está de folga" não inclui mais quem está de férias e que férias nunca recebem. DF13: a mesma entrada diz "Se a tela de WhatsApp da equipe já estava aberta antes da atualização, recarregue a página antes de enviar."

**Passos:**
1. [ ] RED `rule-panel.spec.tsx`: `it('painel mostra finalidade, base com a frase, setores, turnos, níveis, folga, data, atividade, momento e política')`; `it('turnos nulos aparecem como todos os turnos; política nula no início do turno mostra a lista conferida agora')`.
2. [ ] RED: `it('lista mostra Finalidade e a atividade; envio antigo mostra —')`; `it('aceite 13: detalhe antigo mostra base equipe em serviço (regra anterior)')`; `it('aceite 12: detalhe mostra o painel e os excluídos agrupados por motivo')`; `it('Férias e Folga separados no detalhe')`; `release-notes.spec.ts` continua verde com a entrada nova (com o aviso de recarregar, DF13).
3. [ ] GREEN; `npx tsc -b`; `--changed`.

**Aceite:** 12, 13 (tela); painel da regra (C4); sentença 1; DF13. **Risco: médio**.

---

## Fechamento (principal)

1. Conferir o ledger: 19 tasks aceitas; revisões `opus` feitas em T1, T2, T5, T7, T8b, T10; os testes do Rastreio presentes e verdes; as listas de asserções antigas da T8a1/T8a2 todas viradas na T8b.
2. Gates completos, **um de cada vez**, nada mais rodando: back e depois front, `--base origin/main`, no estado final; comparar com o fim do Lote E (back LINT 7517/733, SONAR 92, COMPLEXIDADE 723, COVERAGE 95.0/86.7; front LINT 105/4, SONAR 18, COMPLEXIDADE 228, COVERAGE 88.1/81.7). Bloquear violação nova ou agravada (por arquivo e ancorado); conferir `max-lines-per-function` 50 dos specs novos.
3. Migração no banco local de QA (stack `orgamind-turnos-qa`, seed fictício): `count(*)` de `TeamWhatsappDispatch` antes e depois; `prisma migrate deploy`; colunas novas nulas em todas as linhas antigas.
4. Boot real da API e do worker; um agendado antigo pendente no banco de QA dispara pela regra de hoje (GF13).
5. Fumaça HTTP (telefones e nomes fictícios): prévia de setor fora do alcance 403 (aceite 17); prévia de Reunião com folga e férias (aceite 2, 14); base trocada em Reunião 422 (aceite 10); envio com impressão velha depois de lançar folga 409 e nada criado (aceite 11); `GET audit-trail`/`AuditEvent` do envio com `purpose` e `base`, sem nome, telefone nem texto (aceite 19); detalhe de envio antigo com nulos (aceite 13).
6. QA visual (agente `qa`, roteiro Node com `@playwright/test`, senha do seed lida no processo, login 5/min): critérios de T13, T14, T15 e T16 — finalidade primeiro, folga só na vinculada, travas por extenso, painel antes de confirmar, 409 relendo a prévia, histórico com finalidade e envio antigo como regra anterior.
7. Revisão final do conjunto com `opus`.
8. Atualizar "Estado" deste plano; registrar na spec, em "Para a GBR confirmar", as decisões que mudam o que a GBR vê: DF6 (quem aparece como "Fora do turno nesta data"), DF7 (texto vazio 422), DF12, textos de CF4 e das frases da base (CF10).
9. Commits do lote, push e PR **rascunho** sobre `feat/importar-pessoas`, com o aviso no corpo: "Não publicar sem o Lote G (vão juntos para produção)". Notas de versão no corpo do PR (DF13, mudança aceita, sem compatibilidade): "Aba da tela de WhatsApp da equipe aberta antes do deploy recebe 400 ao enviar; recarregue a página." **Sem merge, sem deploy.**

## Não verificado (conferir na task dona)

- Se `route-parity.spec.ts` exige registrar rota com `@RequirePermission` (T10).
- Onde está o filtro de pessoa inativa: em `loadDayPeopleMany` ou a cargo da classificação (T7).
- Se coverage e Sonar tratam `*.test-fixtures.ts` como arquivo de teste (T8a1).
- Contagem real de envios para setor nos nove specs: a revisão estimou ~55; se a T8a1 passar de ~60 chamadas, a principal move um spec dela para a T8a2.
- Custo da prévia com muitas pessoas: `consent.isSuppressed` é chamado por pessoa (como no envio de hoje); se a T7 medir mais de 2 s com 500 pessoas no teste, registrar no report.
