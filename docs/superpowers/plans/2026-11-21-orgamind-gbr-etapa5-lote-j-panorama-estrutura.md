# OrgaMind, Etapa 5 GBR, Lote J: panorama da fábrica (PAN-01) e manutenção da estrutura (CAD-06). Implementation Plan

> **Para os agentes:** executar pela skill `sdd` (TDD, ledger em `.superpowers/sdd/2026-11-21-orgamind-gbr-etapa5-lote-j-panorama-estrutura/progress.md`). **Sem commit/push**: nenhuma task commita; a principal integra e commita o lote. Branch `feat/panorama-estrutura`, criado de `feat/alerta-urgente` em `122e821` (Lote I, PR #21). Fechamento de task por `gate --changed --base feat/alerta-urgente`. Regras dos agentes: `.superpowers/sdd/2026-11-21-orgamind-gbr-etapa5-lote-j-panorama-estrutura/{implementer-rules,reviewer-rules}.md` (criadas na Preparação). Linhas citadas são pistas e podem ter mudado.

**Goal:** (1) na "Visão geral", quem envia à equipe vê, para o dia escolhido, um cartão por setor do seu alcance com as contagens por turno, folga, férias, sem escala, sem telefone e sem autorização, abre os nomes sob demanda e pula para a escala ou o envio do setor; (2) setor e nível em uso não são inativados (409 com contagens, conferido na transação da gravação), as dependências aparecem antes, a inativação sem uso pede confirmação; (3) turno e nível gravam antes e depois na trilha; (4) reativar pessoa em setor ou nível inativo é recusado.

**Architecture:** back — rota nova de leitura `GET internal/team-whatsapp/panorama` num controller novo do módulo `team-whatsapp`, com contagem pura sobre o mesmo caminho do roster (`loadDayPeopleMany` + `dayMembers`), em uma rodada e, se passar de 2000 pessoas, setor a setor; contrato em arquivo novo. Estrutura: o `updateWithAudit` do setor ganha uma conferência de uso dentro da transação travada (`sector-usage.ts`); nível ganha contagem de pessoas, conferência e trilha na transação; turno troca `audit.log` por `recordChange` na transação; reativação de pessoa ganha uma checagem em `assertValidAssignment`. Front — feature nova `features/team-panorama/` inserida no topo da Visão geral; `/escala` e `/whatsapp-equipe` passam a aceitar parâmetros de URL (só estado inicial); tela do setor e lista de níveis mostram "Em uso", desligam a inativação e pedem confirmação; mensagens dos 409 novos; Novidades.

**Tech Stack:** NestJS + Prisma 6 + Zod v4 + Vitest/testcontainers no back; React + TanStack Router/Query + Vitest/Testing Library no front. **Sem dependência nova, sem migração.**

**Spec:** `docs/superpowers/specs/2026-11-21-orgamind-gbr-etapa5-panorama-estrutura.md` (APROVADA) — Restrições, Anti-objetivos, C1–C2, P1–P8, E1–E10, A1–A3, aceites 1–19, "Fica com o construtor". Sentença: `~/.claude/tribunais/2026-11-20/conselho-V/sentenca-V.md`. Mapas e revisões: `.superpowers/sdd/2026-11-21-orgamind-gbr-etapa5-governanca/fontes/{mapa-panorama,mapa-estrutura}.md`, `spec-review-1.md`, `spec-review-2.md`.

## Estado (21/11/2026)

- 20/11: revisão 2 do plano (opus) APPROVED; 4 Minor aplicados pela principal (isolamento padrão; pessoa criada por `prisma.user.create`; trava no reordenar do nível; bloco sem título durante o carregamento).
- **21/11: lote implementado e validado.** 14 tasks aceitas (ledger `.superpowers/sdd/2026-11-21-orgamind-gbr-etapa5-lote-j-panorama-estrutura/progress.md`); revisão final do conjunto (opus) APPROVED; gate completo do back sem regressão (testes 7327/7357, 30 ignorados; cx/lint/sonar iguais ao Lote I); QA visual PASS em 3 partes, com um defeito achado e corrigido (data inválida na URL de `/escala` e `/whatsapp-equipe`: o TanStack Router mescla a busca crua com o `validateSearch`, então o validador passou a devolver as chaves com `undefined`). Branch `feat/panorama-estrutura` sobre `feat/alerta-urgente` (Lote I, PR #21); PR em rascunho empilhado.
- A spec da Etapa 5 estava **untracked** (`docs/superpowers/specs/2026-11-21-orgamind-gbr-etapa5-panorama-estrutura.md`) e entra no commit de docs do lote.
- A2 (aceite 19) já foi aplicado em `reports/plano-gbr/dados.py` em 20/11 (ledger da Etapa 5); o lote só confere.
- 20/11: revisão 1 do plano aplicada (plan-review-1.md).
- **Próximo passo:** Preparação; depois Onda 1.

## Preparação (principal, antes da T1)

1. Conferir `git merge-base feat/panorama-estrutura feat/alerta-urgente` = `122e821` (senão o `--changed` mede o Lote I junto). Em worktree: `backend/.env` fictício e `node_modules` por symlink (memória "gate em worktree").
2. Criar `implementer-rules.md` e `reviewer-rules.md` em `.superpowers/sdd/2026-11-21-orgamind-gbr-etapa5-lote-j-panorama-estrutura/`, copiando os do Lote I e adaptando: branch `feat/panorama-estrutura`, base `feat/alerta-urgente`, este plano, a spec da Etapa 5, o ledger novo; referências `DJn`, `GJn` e `CJn` anexadas no fim do brief; "os Lotes A–I estão prontos no branch; não revisar nem mexer fora do ownership"; timeout de shell de no máximo 600 s em subagente (o hook recusa acima). Riscos do lote no `reviewer-rules.md` (copiar o Review Focus abaixo): contagem ou nome de setor fora do alcance; nome ou telefone na resposta do panorama, no `detail` do 409 ou na trilha de estrutura; leitura de pessoas antes do 403; panorama que consulta bloqueio/consentimento; setor ou nível inativado com uso por corrida (conferência fora da transação ou sem trava); reativação que contorna E2/E3; trilha gravada fora da transação ou evento sem mudança; parâmetro de URL que pré-marca setor fora do alcance ou dispara envio sem prévia.
3. Criar o ledger `progress.md` com a referência Git de partida (`122e821`) e os arquivos não commitados de fora do lote (`.playwright-mcp/`, `reports/`, `research_notes/`, `tutoriais/`) e a spec untracked.

## Decisões deste plano (o que a spec deixa com o construtor)

- **DJ1. Rota do panorama num controller novo** `team-panorama.controller.ts` com `@Controller('internal/team-whatsapp')` e `@Get('panorama')` + `@Roles('ADMIN', 'SUPERVISOR', 'OPERATOR')` (VIEWER recebe o 403 do `RolesGuard`, como no roster). `TeamWhatsappController` não muda. Contrato em arquivo novo `backend/src/schemas/contracts/team-panorama.schema.ts` (CJ1). Query: `date` obrigatória, com o mesmo `civilDateSchema` que `teamRosterQuerySchema` usa (`team-whatsapp.schema.ts:271-274`): ausente ou inválida → o mesmo 400 de validação do roster. A leitura não grava trilha.
- **DJ2. Ordem e alcance no serviço** `TeamPanoramaService.panorama(actorId, query, now)`: `repo.findActor` → `!actor || !isTeamSender(actor)` → `teamForbidden()` (403 `team_whatsapp.forbidden`), **antes de qualquer leitura de setor ou pessoa** → setores do alcance = `repo.listSectors(actor.role === 'ADMIN' ? null : actor.managedSectorIds)` (ativos; `team-whatsapp.repository.ts:831-841`, o mesmo de `targets()`, `team-whatsapp.service.ts:400-418`) → turnos ativos `repo.listActiveShifts()` (`sortOrder`, depois nome; `:634-640`) → pessoas do dia → contagem. Setores na resposta ordenados por `new Intl.Collator('pt-BR').compare` do nome. Nenhuma consulta a consentimento ou supressão.
- **DJ3. Pessoas do dia e teto de 2000** (`team-panorama.load.ts`): primeiro uma rodada só, `repo.loadDayPeopleMany(allIds, date, todayIn(now))` (`:677-724`). Se ela lançar `DomainError` com `code === 'team_whatsapp.too_many_people'` (`findMembersForDay`, `:646-664`, teto `DAY_PEOPLE_LIMIT = 2000` por chamada), refaz **setor a setor, em série**, `loadDayPeopleMany([id], date, today)`; o setor cuja chamada sozinha lança o mesmo erro fica `overLimit: true` e `counts: null`. Qualquer outro erro propaga. Cada setor passa por `dayMembers({ sectorId, date, people })` (`team-whatsapp.roster.ts:74-100`): a pessoa emprestada conta só no setor onde trabalha na data, igual ao roster.
- **DJ4. Regra de contagem** (`panoramaCounts`, pura, CJ2), sobre os `DayMember` de um setor:
  - `situation.kind === 'WORK'` com `shiftId` entre os turnos ativos → `byShift` daquele turno; `WORK` com outro `shiftId` → `otherShifts`;
  - `OFF` com `reason: 'DAY_OFF'` → `dayOff`; `OFF` com `reason: 'VACATION'` → `vacation`; `NONE` → `noSchedule`;
  - entre os `WORK` (ativos e outros turnos): `sendPhoneOf(m) === null` (`recipient-skip.ts:12-16`, o mesmo número que dá `hasPhone` no roster) → `noPhone`; senão `m.contactAuthorization !== 'AUTORIZADO'` → `notAuthorized`. As duas contagens são **disjuntas**, na ordem da prévia (`phoneSkipReason`, `recipient-skip.ts:22-30`: sem telefone vem antes de sem autorização; a supressão não é consultada);
  - `byShift` tem um item por turno ativo, na ordem de `shifts`, inclusive com `count: 0`.
- **DJ5. Turno da noite (P7):** a resposta traz `today = todayIn(now)` e `inProgress = query.date === today ? overnightInProgress(shifts, now) : null` (`team-whatsapp.selection.ts:15-25`). O front mostra o atalho só com `inProgress` não nulo e a data escolhida igual a `today`.
- **DJ6. Bloco no front (P1, P8).** `FactoryPanorama` lê o papel de `useAuthStore`; VIEWER ou sem usuário → não renderiza e a query fica `enabled: false`. Query `useTeamPanorama(date, enabled)`, chave `['team-panorama', 'summary', date]`, `retry: false`, `staleTime: 0`, `refetchOnMount: 'always'`, `refetchOnWindowFocus: false`, `refetchOnReconnect: false`, sem `refetchInterval` (recarrega só ao trocar a data ou ao voltar à tela). Erro: `readApiErrorBody` é **assíncrona** (`lib/api-error.ts:44`, devolve Promise), então a decisão não é tomada na renderização. O `queryFn` de `useTeamPanorama` envolve a chamada em `try/catch`: se o erro é `HTTPError` com status 403, lê o corpo com `await readApiErrorBody(error)` e, com `code === 'team_whatsapp.forbidden'`, **devolve `null`** (a query resolve com sucesso); qualquer outro erro é relançado. O bloco não renderiza nada com `data === null` (nem carregando nem erro, portanto sem piscar mensagem: aceite 2); qualquer outro erro → "Não foi possível carregar o panorama" e botão "Tentar de novo" (`refetch`). O tipo de `data` é `TeamPanorama | null`. Carregando → "Carregando panorama…". O bloco entra no `OverviewContent` (`internal-dashboard-page.tsx:36-38`), entre o `Header` e o conteúdo, portanto aparece também no estado vazio (`unconfigured`) e só depois de os indicadores carregarem. Data inicial `todayInManaus()` (`features/people-record/authorization.ts:36`), campo `type="date"` com rótulo "Data". Enquanto a primeira consulta carrega (`data === undefined`), o bloco não mostra título nem subtítulo, só um espaço neutro sem texto, para que quem recebe o 403 não veja "Operação da fábrica" piscar (decisão do plano, revisão 2).
- **DJ7. "Ver pessoas" (P4)** usa uma query própria do panorama, `usePanoramaRoster(sectorId, date, enabled)`, chave `['team-panorama', 'roster', sectorId, date]`, mesma rota `GET internal/team-whatsapp/roster?sectorIds=<id>&date=<data>`, parse por `teamRosterSchema` (`features/team-whatsapp/schemas.ts:65`), `staleTime: Infinity`, `refetchOnWindowFocus: false`, `retry: false`. A lista é montada no primeiro clique e depois só escondida (`hidden`), para fechar e abrir de novo não buscar outra vez. Rótulos: "Ver pessoas" (fechado) e "Fechar" (aberto). Grupos, nesta ordem: um por turno ativo (título "{turno} ({início}–{fim})"), "Outros turnos", "Folga", "Férias", "Sem escala"; cada linha "{nome} · {telefone}" com o telefone por `phoneText` (`features/sector-people/phone-text.ts:8-10`: completo formatado se veio `phoneE164`, senão `phoneMasked`, senão "—"); grupo vazio não aparece. Carregando → "Carregando pessoas…"; erro → "Não foi possível carregar as pessoas" e "Tentar de novo". Cartão `overLimit` não tem "Ver pessoas".
- **DJ8. Parâmetros de URL (P6).** Data válida = texto `AAAA-MM-DD` que é data de calendário real (`parseCivilDateParam`, CJ8). `/escala`: `validateSearch` devolve `{ sectorId?: string; date?: string }`; o setor só vale se está em `options.sectors` (alcance e ativos); a data vira a âncora inicial no modo atual (`'week'`). `/whatsapp-equipe`: `validateSearch` devolve `{ sectorIds?: string; date?: string }` com `sectorIds` separado por vírgula (aceita também lista de textos e junta); os ids que não estão em `targets.sectors` são descartados; lista que fica vazia = nenhum pré-marcado (`sectorIds: null`, o comportamento de hoje); a data vale nas mesmas condições do campo "Data" da tela (o seletor não tem `min`/`max`: qualquer data válida; conferido em `sector-shift-picker.tsx:135`). Nas finalidades com data da atividade, `referenceDate` (`use-send-filters.ts:139-141`) continua mandando. Os parâmetros só entram no estado inicial; nada sincroniza a URL depois. Parâmetro inválido, de setor inativo ou fora do alcance: ignorado, sem erro.
- **DJ9. Setor em uso (E2, E4)** em `internal-sectors/sector-usage.ts` (CJ3), contagens com o `db` recebido (o `tx` na gravação):
  - `people` = `user.count({ where: { sectorId, isActive: true } })`;
  - `exceptions` = `staffScheduleException.count({ where: { sectorId, endDate: { gte: toDbDate(today) }, user: { isActive: true } } })` (`today` = `todayIn(new Date())`, Manaus; `toDbDate` como em `shifts.repository.ts:99`);
  - `scheduled` = `teamWhatsappDispatch.count({ where: { state: 'SCHEDULED', sectors: { some: { sectorId } } } })` (relação `sectors` = `TeamWhatsappDispatchSector`, `schema.prisma:1816,1869-1872`); sem filtro de tipo de alvo: o envio a uma pessoa não grava linha em `TeamWhatsappDispatchSector` (`schema.prisma:1814-1815`, "nenhuma no alvo pessoa"), então "agendado a uma pessoa" já fica de fora;
  - `inactivePeople` = `user.count({ where: { sectorId, isActive: false } })` (só informação).
  Em uso = `people + exceptions + scheduled > 0`. A conferência roda **dentro** de `updateWithAudit`, depois do `SELECT … FOR NO KEY UPDATE` e da leitura do "antes" (`internal-sectors.repository.ts:87-92`), só quando o pedido tem `isActive: false` e o "antes" está ativo; em uso → `sectorInUse(usage)` (409) e nada é gravado (nem trilha). `GET internal/sectors/:id` passa a devolver `usage` (lido fora de transação); o controller devolve o retorno do serviço sem serializador (`internal-sectors.controller.ts:38-43`), então `usage` chega ao front.
- **DJ10. Formato do `detail`:** `usageDetail({ people, exceptions, scheduled })` em `backend/src/shared/errors/usage-detail.ts` (novo): só as chaves com valor > 0, nesta ordem, `chave=valor` separados por `", "` → `"people=3, exceptions=1, scheduled=2"`; no nível, `"people=2"`. Sem id, nome, telefone ou e-mail.
- **DJ11. Nível (E3, E4).** `levelAdminSchema` ganha `activePeople` e `inactivePeople` (`userCount` continua, total). `LevelsRepository.updateWithAudit(id, data, audit, guard?)` abre uma transação interativa, trava `SELECT id FROM "StaffLevel" WHERE id = ${id} FOR NO KEY UPDATE` (nome físico confere: `StaffLevel` não tem `@@map`, `schema.prisma:1664`), lê o "antes" (`levelAuditSelect`), roda o `guard`, grava e chama a trilha. Guard da desativação: com `data.isActive === false`, "antes" ativo e `countActiveLevelPeople(tx, id) > 0` → `levelInUse(n)` (409 `levels.in_use`, `detail` `people=n`). A trava protege a trilha e a conferência contra outra edição do nível; a edição da pessoa não trava o nível (limite conhecido da spec). A transação interativa do nível usa o isolamento padrão, sem `isolationLevel`. O `reorderWithAudit` do nível trava todas as linhas antes de ler a ordem "antes" (`SELECT id FROM "StaffLevel" ORDER BY id FOR NO KEY UPDATE`), como o turno (DJ12).
- **DJ12. Trilha de turno e nível (E8).** As ações continuam com os nomes de hoje (`shift.create`, `shift.update`, `shift.reorder`, `level.create`, `level.update`, `level.reorder`; o front já tem os rótulos, `features/audit-trail/labels.ts:84-89`) e passam a gravar por `audit.recordChange(tx, { action, entity, entityId, category: 'STRUCTURE', changes, actorId })` (`audit.service.ts:114-117`) na mesma transação da gravação, no lugar de `audit.log`. Campos: turno `name`, `startTime`, `endTime`, `isActive`; nível `name`, `isActive`; comparação por `diffFields` (`audit-change.ts:56`), como `sector-audit.ts`. Criação: `before: null` (lista os valores iniciais). Alteração: só os campos que mudaram; nenhum → nenhum evento. Reordenar: `entity` `Shift`/`StaffLevel`, `entityId: null`, um campo `order` com os nomes na ordem antes e depois, unidos por `" > "` (`orderChange`, CJ5); ordem igual → nenhum evento. **Editar turno trava a linha:** `ShiftsRepository.updateWithAudit` roda `SELECT id FROM "Shift" WHERE id = ${id} FOR NO KEY UPDATE` no `tx` **antes** de ler o "antes" da trilha (o mesmo motivo do setor, `internal-sectors.repository.ts:76-81,88`; sem a trava, duas edições simultâneas gravam um "antes" errado). **Reordenar** trava todas as linhas (`SELECT id FROM "Shift" ORDER BY id FOR NO KEY UPDATE`) antes de ler a ordem antiga. Nome físico: `Shift` não tem `@@map` (`schema.prisma:1644`). Entity: `'Shift'` e `'StaffLevel'`. O turno mantém a conferência de uso de hoje (`shifts.service.ts:114-116`), fora da transação (spec: "O turno segue como está").
- **DJ13. Reativação (E10)** em `users/reactivation-guard.ts`, chamada no fim de `assertValidAssignment` (`users.service.ts:689-703`): vale só quando `user.isActive === false` e `input.isActive === true`. Setor efetivo = `input.sectorId !== undefined ? input.sectorId : user.sectorId`; nível efetivo = `input.levelId !== undefined ? input.levelId : user.levelId`. Setor efetivo não nulo e não ativo (`repo.findActiveSector` vazio) → 409 `user.sector_inactive`; nível efetivo não nulo com `isActive: false` (`repo.findLevelForAssignment`) → 409 `user.level_inactive`. Setor primeiro. Um setor **informado** inativo continua dando o `user.sector_invalid` de hoje (`assertActiveSectorIfGiven`, `:706-714`, roda antes). Edição de pessoa já ativa não muda (o nível inativo que já é dela segue aceito, `:720-728`). Fatos conferidos: `UserSummary` traz `isActive`, `sectorId` e `levelId` (`users.repository.ts:20-50`); `findActiveSector` devolve a linha ou `null` (`:396-397`); `findLevelForAssignment` devolve `{ id, isActive }` ou `null` (`:411-416`).
- **DJ14. Textos de estrutura no front (E4–E6):**
  - setor, linhas de uso (só com contagem > 0): "N pessoa(s) ativa(s) neste setor", "N exceção(ões) de escala de hoje em diante", "N envio(s) agendado(s)"; nível: "N pessoa(s) ativa(s) com este nível"; informação: "N pessoa(s) inativa(s) mantêm o vínculo" (só > 0);
  - com uso: título "Em uso: não pode ser inativado" e "Para liberar:" seguido, por tipo com contagem > 0: "Traga as pessoas para outro setor pela tela de pessoas do setor de destino.", "Remova as exceções na Escala.", "Cancele ou aguarde os envios agendados."; no nível: "Troque o nível no cadastro das pessoas.";
  - 409 depois de abrir a tela: "Este setor está em uso e não pode ser inativado." / "Este nível está em uso e não pode ser desativado.", e a tela invalida a query do setor ou da lista de níveis;
  - confirmações: "Inativar {setor}? Ele sai das listas de envio, escala e cadastro. O histórico é mantido." com "Cancelar" e "Inativar setor"; com número da área (`sector.channel` não nulo), parágrafo a mais: "O número da área continua ligado a este setor e nenhum envio sai por ele enquanto o setor estiver inativo. Para usar o número em outra área, desvincule-o antes."; nível: "Desativar o nível {nome}? Ele sai do cadastro novo e do filtro de envio." com "Cancelar" e "Desativar". Diálogos com `@/components/ui/alert-dialog`.
- **DJ15. Mensagens da reativação (E10):** `user.sector_inactive` → "O setor desta pessoa está inativo. Reative o setor ou troque o setor antes de reativar a pessoa."; `user.level_inactive` → "O nível desta pessoa está desativado. Reative o nível ou troque o nível antes de reativar a pessoa." (mesmo texto como `message` do `DomainError` no back e nos mapas do front).
- **DJ16. Novidades e rótulos da trilha.** Entrada `2026.11.21.1` no topo de `RELEASE_NOTES` (CJ10). `FIELD_LABEL` da trilha ganha `startTime: 'Início'`, `endTime: 'Término'`, `order: 'Ordem'` (`name: 'Nome'` já existe, `audit-trail/labels.ts:22`: não mexer).

## Global Constraints

- **GJ1. Escopo.** Back: arquivos novos do panorama em `backend/src/modules/team-whatsapp/` (+ `dto/panorama-query.dto.ts`), `team-whatsapp.module.ts` (só registrar controller e serviço), `backend/src/schemas/contracts/team-panorama.schema.ts` (novo), `sector.schema.ts` e `level.schema.ts` (só os campos novos), `backend/src/modules/permissions/route-parity.spec.ts` (só a linha do panorama), `backend/src/modules/internal-sectors/`, `backend/src/modules/shifts/`, `backend/src/modules/levels/`, `backend/src/modules/users/` (guard, erros, uma chamada), `backend/src/shared/audit/audit-order.ts` e `backend/src/shared/errors/usage-detail.ts` (novos), specs novos de `sector-people` só para a integração da T6. Front: `features/team-panorama/` (nova), `internal-dashboard-page.tsx` (uma inserção), `routes/_authenticated/escala/index.tsx`, `features/staff-schedule/schedule-search.ts`, `lib/civil-date-param.ts`, `routes/_authenticated/whatsapp-equipe/index.tsx`, `features/team-whatsapp/use-send-filters.ts`, `features/team-whatsapp/send-search.ts`, `features/internal-admin/`, `routes/_authenticated/setores/$sectorId.tsx`, `features/levels/`, `features/users/error-messages.ts` (+ `user-status-flow.tsx` só se a mensagem não aparecer), `features/sector-people/error-messages.ts`, `features/audit-trail/labels.ts`, `release-notes.ts` e specs novos. **Não mudam:** agendamento e reconferência (A1: "Não há opção nova na tela, valor novo de política, campo novo, permissão nova nem código de erro novo"), `TeamWhatsappService.roster`, `TeamAudienceService`, `team-whatsapp.controller.ts`, `team-whatsapp.repository.ts`, `features/team-whatsapp/api.ts`, regra de uso do turno, Prisma e migrações, catálogo de permissões.
- **GJ2. Restrições da spec:** "Nenhuma migração: tudo usa as tabelas que já existem." "Nenhuma chave de permissão nova: panorama com a regra de remetente; estrutura com `estrutura.manter`; gestor do setor só pelo ADMIN." "O panorama não consulta bloqueio nem consentimento por pessoa (…). Ele conta pela escala do dia, que é o mesmo caminho do roster: `loadDayPeopleMany` com a situação resolvida." "Testes nunca mandam WhatsApp real."
- **GJ3. Dado pessoal (Anti-objetivos):** "A tela de entrada carregar nome ou telefone de pessoas sem um clique de 'Ver pessoas', ou para quem não é remetente" é falha. "Nome, telefone ou e-mail de pessoas aparecerem no `detail` do 409" é falha. "Telefone ou e-mail de pessoas aparecerem na trilha de estrutura. A trilha do setor continua guardando o gestor como id e nome, como já faz." A resposta do panorama só tem ids e nomes de setor e turno e contagens.
- **GJ4. Alcance (Vocabulário, P1, P2):** "Remetente" = ADMIN, ou SUPERVISOR/OPERATOR que gere ao menos um setor ativo (`isTeamSender`). "Alcance" = todos os ativos para o ADMIN, e os ativos que gere para os demais. Quem não é remetente recebe o mesmo 403 do roster (`team_whatsapp.forbidden`), antes de qualquer leitura de setor ou pessoa; VIEWER recebe o 403 do `RolesGuard`. "Um SUPERVISOR ver contagens de setor fora do alcance dele" é falha.
- **GJ5. Recusas e códigos:** setor 409 `sector.in_use`, nível 409 `levels.in_use`, turno 409 `shifts.in_use` (sem mudança), reativação 409 `user.sector_inactive` / `user.level_inactive`; `detail` no formato DJ10. "Um setor com pessoas ativas, exceções futuras de pessoas ativas ou envio agendado pendente ficar inativo, por qualquer caminho da API" e "Uma pessoa ser reativada num setor ou nível inativo" e "Um nível com pessoas ativas ficar desativado" são falhas.
- **GJ6. Validação:** cwd `backend/` ou `frontend/`. Loop `timeout 600 gate --test src/<arquivo>`; integração `TESTCONTAINERS_ENABLED=1 timeout 600 gate --test src/<arquivo>`. Tipos: back `npx tsc --noEmit -p tsconfig.build.json --tsBuildInfoFile /tmp/<task>.tsbuildinfo`; front `npx tsc -b`. Fechamento: back `cd backend && TESTCONTAINERS_ENABLED=1 timeout 600 gate --changed --base feat/alerta-urgente`; front `cd frontend && timeout 600 gate --changed --base feat/alerta-urgente`. (O despacho pediu 900 s; o hook de subagente recusa acima de 600. Se 600 não bastar, devolver ao controlador.) Nunca suíte inteira, gate completo, coverage ou e2e (são da principal). No máximo dois testcontainers ao mesmo tempo (a principal serializa).
- **GJ7. Compila entre tasks:** assinatura existente só ganha parâmetro ou campo opcional, salvo onde a task diz e ajusta chamadores e specs no próprio ownership. Campos novos de contrato: obrigatórios no back (a task que os cria os preenche), tolerantes no front (`.nullish()`). Sem commit.
- **GJ8. Tempo nos testes:** "hoje" é `todayIn(...)` (`staff-schedule/civil-date.ts`, Manaus), nunca `new Date().toISOString().slice(0,10)`. O serviço do panorama recebe `now` explícito (o controller lê o relógio). Fixtures gravam `createdAt` explícito; nada de `vi.setSystemTime` com linha gravada pelo banco (memória "relógio falso × createdAt"). Datas de exceção nos testes de estrutura são calculadas a partir de `todayIn(new Date())` no próprio teste. Telefones e nomes fictícios (`+5592991110001`, "Pessoa A").
- **GJ9. Tamanho e legado:** funções e callbacks de `describe`/`it` até 50 linhas, complexidade 10, até 4 parâmetros; `describe` novos em arquivo novo (o que existe não cresce); conferir com `npx eslint <arquivos> --rule '{"max-lines-per-function": ["error", 50], "max-params": ["error", 4], "complexity": ["error", 10], "max-depth": ["error", 4]}'`. `prettier --write` só em arquivo novo; nunca em arquivo legado; nunca restaurar arquivo do git. **Legados** (só recebem as trocas que a task diz; lógica nova em arquivo novo): `team-whatsapp.module.ts`, `internal-sectors.service.ts`, `internal-sectors.repository.ts`, `shifts.service.ts`, `shifts.repository.ts`, `levels.service.ts`, `levels.repository.ts`, `users.service.ts`, `sector.schema.ts`, `level.schema.ts`, `route-parity.spec.ts`; front `internal-dashboard-page.tsx`, `escala/index.tsx`, `whatsapp-equipe/index.tsx`, `use-send-filters.ts`, `sector-form.tsx`, `setores/$sectorId.tsx`, `internal-admin/schemas.ts`, `levels-table.tsx`, `levels/schemas.ts`, os `error-messages.ts`, `audit-trail/labels.ts`, `release-notes.ts`.
- **GJ10. Front:** corpo de erro HTTP só por `readApiErrorBody` (`lib/api-error.ts:44`; ky 2 consome o corpo, o `code` está em `HTTPError.data`). Datas dd/MM por `formatDayMonth` (`lib/civil-date.ts:52`). Textos exatamente como DJ6, DJ7, DJ14, DJ15 e P1–P8.
- **GJ11. Concorrência:** teste de corrida por **intercalação determinística** contra o Postgres do testcontainer, nunca com mock do repositório e nunca com `Promise.all` solto (não garante a intercalação nem prova a regra). Dois moldes, ambos com o tipo `FOR NO KEY UPDATE` (a criação de pessoa só pega `FOR KEY SHARE` na linha do setor/nível, que não conflita, então passa durante a trava):
  - **Molde A (conferência de uso, T3 e T5):** (1) uma transação separada (outra conexão, `$transaction` interativa ou `pg` direto) abre e trava a linha com `SELECT id FROM "<Tabela>" WHERE id = ${id} FOR NO KEY UPDATE` e fica aberta; (2) o teste dispara a inativação pelo serviço real, **sem `await`**, e espera ficar bloqueada (poll em `pg_stat_activity` até uma sessão com `wait_event_type = 'Lock'`, com limite de tempo); (3) por outra conexão cria e **commita** uma pessoa ativa do setor/nível com `prisma.user.create` direto (não pelo `UsersService`, que grava trilha de usuário); (4) solta a trava (commit da transação separada); (5) `await` da inativação e espera 409 `sector.in_use` / `levels.in_use`, com o setor/nível ainda ativo e nenhum `AuditEvent` novo de `entity` `Sector`/`StaffLevel`. As transações de gravação usam o isolamento padrão (READ COMMITTED), sem `isolationLevel`: com Serializable/RepeatableRead a contagem depois da trava não veria a pessoa. O teste **tem de falhar** se a conferência rodar fora da transação travada (antes do `SELECT … FOR NO KEY UPDATE`): ela veria zero uso, a gravação passaria e o teste esperaria 409. Dizer isso num comentário do `it`.
  - **Molde B (trilha com "antes" certo, T4 e T5):** (1) transação separada trava a linha do turno/nível; (2) edição 1 (ex.: renomear X→Y) disparada sem `await`, poll até bloqueada; (3) edição 2 (Y→W) disparada sem `await`, poll até haver duas sessões bloqueadas (a fila de travas é FIFO); (4) solta a trava; (5) `await` das duas e confere dois eventos: o "antes" da edição 2 é o "depois" da edição 1 (X→Y e Y→W). Sem a trava antes da leitura do "antes", a edição 2 leria X.

## Contratos compartilhados

**CJ1. Panorama** (T1; `backend/src/schemas/contracts/team-panorama.schema.ts`; o front espelha em `features/team-panorama/schemas.ts` na T7).

```ts
export const teamPanoramaQuerySchema = z.object({ date: civilDateSchema });   // o mesmo civilDateSchema do roster
const countSchema = z.number().int().nonnegative();
export const panoramaCountsSchema = z.object({
  byShift: z.array(z.object({ shiftId: z.string(), count: countSchema })),     // um por turno ativo, na ordem de `shifts`
  otherShifts: countSchema, dayOff: countSchema, vacation: countSchema, noSchedule: countSchema,
  noPhone: countSchema, notAuthorized: countSchema,                            // entre os em serviço; disjuntos (DJ4)
});
export const panoramaSectorSchema = z.object({
  sectorId: z.string(), name: z.string(),
  overLimit: z.boolean(),                       // setor sozinho > 2000 (DJ3)
  counts: panoramaCountsSchema.nullable(),      // null ⇔ overLimit
});
export const teamPanoramaResponseSchema = z.object({
  date: civilDateSchema, today: civilDateSchema,
  shifts: shiftRefSchema.array(),               // ativos, sortOrder e nome
  inProgress: z.object({ date: civilDateSchema, shift: shiftRefSchema }).nullable(), // DJ5
  sectors: panoramaSectorSchema.array(),        // alcance, por nome (pt-BR)
});
export type TeamPanoramaQuery = z.infer<typeof teamPanoramaQuerySchema>;
export type TeamPanoramaResponse = z.infer<typeof teamPanoramaResponseSchema>;
export type PanoramaCounts = z.infer<typeof panoramaCountsSchema>;
```

**CJ2. Back do panorama** (T1 a função pura; T2 o resto).

```ts
// team-panorama.counts.ts (T1)
export function panoramaCounts(members: readonly DayMember[], activeShiftIds: readonly string[]): PanoramaCounts;
// team-panorama.load.ts (T2)
export type PanoramaDays = Map<string, TeamMemberWithSchedule[] | 'over_limit'>;
export async function loadPanoramaDays(repo: Pick<TeamWhatsappRepository, 'loadDayPeopleMany'>,
  sectorIds: readonly string[], date: CivilDate, today: CivilDate): Promise<PanoramaDays>;
// team-panorama.service.ts (T2)
@Injectable() export class TeamPanoramaService {
  constructor(repo: TeamWhatsappRepository);
  panorama(actorId: string, query: TeamPanoramaQuery, now: Date): Promise<TeamPanoramaResponse>;
}
// team-panorama.controller.ts (T2): GET internal/team-whatsapp/panorama, @Roles('ADMIN','SUPERVISOR','OPERATOR'),
//   @Query() query: PanoramaQueryDto (createZodDto(teamPanoramaQuerySchema), padrão de dto/roster-query.dto.ts) → panorama(req.user.sub, query, new Date())
```

**CJ3. Setor em uso** (T3).

```ts
// backend/src/shared/errors/usage-detail.ts
export function usageDetail(counts: Readonly<Record<string, number>>): string;   // DJ10, ordem das chaves do objeto
// internal-sectors/sector-usage.ts
export type SectorUsage = { people: number; exceptions: number; scheduled: number; inactivePeople: number };
export type SectorUsageDb = Pick<Prisma.TransactionClient, 'user' | 'staffScheduleException' | 'teamWhatsappDispatch'>;
export async function sectorUsage(db: SectorUsageDb, sectorId: string, today: CivilDate): Promise<SectorUsage>;
export function isSectorInUse(u: SectorUsage): boolean;                           // people + exceptions + scheduled > 0
export type SectorUpdateGuard = (tx: Prisma.TransactionClient, before: SectorAuditRow) => Promise<void>;
export function inactivationGuard(sectorId: string, today: CivilDate): SectorUpdateGuard; // antes inativo → nada; em uso → sectorInUse
// internal-sectors/sector.errors.ts
export function sectorInUse(u: SectorUsage): DomainError;  // code 'sector.in_use', status 409, message 'Setor em uso não pode ser inativado',
                                                           // detail usageDetail({ people, exceptions, scheduled })
// InternalSectorsRepository
updateWithAudit(id: string, data: Prisma.SectorUpdateInput, audit: SectorUpdateTrail, guard?: SectorUpdateGuard); // guard depois do "antes"
usage(id: string, today: CivilDate): Promise<SectorUsage>;
// GET internal/sectors/:id → { ...summary, members, usage: SectorUsage }
// sector.schema.ts: export const sectorUsageSchema = z.object({ people, exceptions, scheduled, inactivePeople }) (inteiros ≥ 0)
```

**CJ4. Nível** (T5).

```ts
// level.schema.ts: levelAdminSchema + activePeople: z.number().int().nonnegative(), inactivePeople: z.number().int().nonnegative()
// levels.errors.ts
export function levelInUse(activePeople: number): DomainError; // 'levels.in_use', 409, 'Nível em uso não pode ser desativado', detail usageDetail({ people })
// levels/level-usage.ts
export async function countActiveLevelPeople(db: Pick<Prisma.TransactionClient, 'user'>, levelId: string): Promise<number>;
export function deactivationGuard(levelId: string): LevelUpdateGuard;
// levels/level-audit.ts
export const levelAuditSelect = { id: true, name: true, isActive: true } satisfies Prisma.StaffLevelSelect;
export type LevelAuditRow; export function levelAuditChanges(before: LevelAuditRow | null, after: LevelAuditRow): FieldChange[];
// LevelsRepository
export type LevelTrail = (tx: Prisma.TransactionClient, before: LevelAuditRow | null, after: LevelAuditRow) => Promise<void>;
export type LevelUpdateGuard = (tx: Prisma.TransactionClient, before: LevelAuditRow, data: LevelUpdateData) => Promise<void>;
createWithAudit(data: LevelCreateData, audit: LevelTrail): Promise<LevelAdmin>;
updateWithAudit(id: string, data: LevelUpdateData, audit: LevelTrail, guard?: LevelUpdateGuard): Promise<LevelAdmin>;
reorderWithAudit(ids: readonly string[], audit: OrderTrail): Promise<void>;
```

**CJ5. Trilha de turno e ordem** (T4; o nível consome `audit-order.ts` na T5).

```ts
// backend/src/shared/audit/audit-order.ts
export const ORDER_FIELD = 'order';
export function orderChange(before: readonly string[], after: readonly string[]): FieldChange[]; // [] se iguais; senão um item, nomes unidos por ' > '
export type OrderTrail = (tx: Prisma.TransactionClient, before: string[], after: string[]) => Promise<void>;
// ShiftsRepository.updateWithAudit trava a linha (SELECT id FROM "Shift" WHERE id = ${id} FOR NO KEY UPDATE) ANTES de ler o "antes" (DJ12)
// shifts/shift-audit.ts
export const shiftAuditSelect = { id: true, name: true, startTime: true, endTime: true, isActive: true } satisfies Prisma.ShiftSelect;
export type ShiftAuditRow; export function shiftAuditChanges(before: ShiftAuditRow | null, after: ShiftAuditRow): FieldChange[];
// ShiftsRepository
export type ShiftTrail = (tx: Prisma.TransactionClient, before: ShiftAuditRow | null, after: ShiftAuditRow) => Promise<void>;
createWithAudit(data: ShiftCreateData, audit: ShiftTrail): Promise<ShiftRow>;
updateWithAudit(id: string, data: ShiftUpdateData, audit: ShiftTrail): Promise<ShiftRow>;
reorderWithAudit(ids: readonly string[], audit: OrderTrail): Promise<void>;
// trilha: audit.recordChange(tx, { action: 'shift.create' | 'shift.update' | 'shift.reorder', entity: 'Shift', entityId: id | null,
//   category: 'STRUCTURE', changes, actorId }); changes vazio → não chama
```

**CJ6. Reativação** (T6).

```ts
// users/reactivation-guard.ts
export async function assertReactivationAllowed(
  repo: Pick<UsersRepository, 'findActiveSector' | 'findLevelForAssignment'>,
  user: { isActive: boolean; sectorId: string | null; levelId: string | null },
  input: { isActive?: boolean; sectorId?: string | null; levelId?: string | null },
): Promise<void>;                                         // DJ13
// users.errors.ts
export function sectorInactiveOnReactivation(): DomainError; // 'user.sector_inactive', 409, message DJ15
export function levelInactiveOnReactivation(): DomainError;  // 'user.level_inactive', 409, message DJ15
```

**CJ7. Front do panorama** (T7; T8 acrescenta).

```ts
// features/team-panorama/schemas.ts: espelho de CJ1 (campos .nullish() onde a ausência tem leitura óbvia), TeamPanorama, PanoramaSector
// features/team-panorama/api.ts
export const PANORAMA_KEY = ['team-panorama'] as const;
export function useTeamPanorama(date: string, enabled: boolean);                         // DJ6
export function usePanoramaRoster(sectorId: string, date: string, enabled: boolean);     // DJ7 (T8)
// features/team-panorama/labels.ts
export const PANORAMA_TITLE = 'Operação da fábrica';
export function panoramaSubtitle(role: string | undefined): string; // 'Panorama de todos os setores' (ADMIN) | 'Panorama dos seus setores'
export const PANORAMA_NOTICE = 'As contagens vêm da escala do dia, não da hora. Quem recebe uma mensagem só é definido na prévia do envio, que também confere bloqueios.';
export const PANORAMA_LOAD_ERROR = 'Não foi possível carregar o panorama';
export const OVER_LIMIT_TEXT = 'Setor com mais de 2000 pessoas: veja na Escala';
export const EMPTY_SECTOR_TEXT = 'Ninguém na escala deste dia';
export function inServiceTitle(date: string): string;                       // `Em serviço em ${dd/MM}`
export function shiftLine(shift: { name: string; startTime: string; endTime: string }, count: number): string; // `${name} (${start}–${end}): ${n}` (en dash)
export function cardLines(counts: PanoramaCounts, shifts: ShiftRef[]): { shifts: string[]; other: string | null; rest: string[]; gaps: string[]; empty: boolean };
//   other: 'Outros turnos: N' só N > 0; rest: ['Folga: N', 'Férias: N', 'Sem escala: N']; gaps: 'Sem telefone: N', 'Sem autorização de contato: N' só N > 0;
//   empty: soma de tudo = 0 (o cartão mostra só EMPTY_SECTOR_TEXT e as ações)
export function inProgressText(shiftName: string): string;                  // `O turno ${nome} de ontem ainda está em andamento.`; botão `Ver ${dd/MM}`
// components: FactoryPanorama() (bloco), PanoramaCard({ sector, shifts, date }) (T7), PanoramaPeople({ sectorId, date, shifts }) (T8)
// features/team-panorama/links.ts (T8)
export function scheduleSearch(sectorId: string, date: string): { sectorId: string; date: string };
export function sendSearch(sectorId: string | null, date: string): { sectorIds?: string; date: string };
```

**CJ8. Parâmetros de URL** (T9 e T10).

```ts
// frontend/src/lib/civil-date-param.ts (T9)
export function parseCivilDateParam(value: unknown): string | undefined; // 'AAAA-MM-DD' e data real (ida e volta por Date UTC); senão undefined
// features/staff-schedule/schedule-search.ts (T9)
export type ScheduleSearch = { sectorId?: string; date?: string };
export function validateScheduleSearch(search: Record<string, unknown>): ScheduleSearch;
export function initialSchedule(search: ScheduleSearch, options: { today: string; sectors: readonly { id: string }[] }):
  { sectorId: string | null; anchor: string };              // setor fora de options.sectors → null; data inválida → today
// features/team-whatsapp/send-search.ts (T10)
export type SendSearch = { sectorIds?: string; date?: string };
export function validateSendSearch(search: Record<string, unknown>): SendSearch;
export type SendInitial = { sectorIds: string[] | null; date: string | null };
export function initialSendFilters(search: SendSearch, sectors: readonly { id: string }[]): SendInitial; // vazios → null
// use-send-filters.ts: useSendFilters(today: string, sectors: readonly TeamSector[], initial?: SendInitial)
```

**CJ9. Estrutura no front** (T11, T12; textos DJ14).

```ts
// features/internal-admin/schemas.ts: sectorDetailSchema + usage: sectorUsageSchema.nullish()
// features/internal-admin/sector-usage.ts
export function sectorUsageLines(u: SectorUsage): string[]; export function sectorInUse(u: SectorUsage | null | undefined): boolean;
export function sectorHowTo(u: SectorUsage): string[];      export function inactivePeopleLine(n: number): string | null;
export function inactivateSectorText(name: string, hasAreaNumber: boolean): string[];
export const SECTOR_IN_USE_409 = 'Este setor está em uso e não pode ser inativado.';
// features/levels/in-use.ts
export function levelInUse(l: { isActive: boolean; activePeople?: number | null }): boolean;
export function levelUsageLines(l): string[];  export function deactivateLevelText(name: string): string;
export const LEVEL_IN_USE_409 = 'Este nível está em uso e não pode ser desativado.';
```

**CJ10. Novidades** (T14): `{ version: '2026.11.21.1', date: '2026-11-21', title: 'Panorama da fábrica e cuidados ao inativar setor e nível', items: [...] }` no topo, itens com `where` `/dashboard`, `/setores`, `/niveis`, `/trilha`, `/users`; sem nome ou telefone de exemplo.

## Review Focus

1. **Alcance e 403 antes de ler (GJ4):** T2 `SUPERVISOR com dois setores vê só os dois`; `OPERATOR sem setor gerido — 403 team_whatsapp.forbidden sem ler setores nem pessoas`; `setor gerido inativo não aparece`; T7 `VIEWER — nenhuma chamada`; `403 forbidden — bloco some sem erro`.
2. **Só contagens (GJ3):** T1 `o schema descarta chave extra (nome, telefone)`; T2 `a resposta serializada não contém nome nem telefone semeados`; T8 `nenhuma chamada ao roster antes do clique`.
3. **Contagem igual ao roster:** T1 regras; T2 `emprestado conta só no setor da data`; `números batem com o roster na mesma data`.
4. **Teto de 2000:** T2 `alcance com mais de 2000 responde`; `setor sozinho acima de 2000 — overLimit, counts null`.
5. **Setor em uso na transação (E2, aceite 12):** T3 `uso criado depois de a tela abrir — 409 na gravação`; `inativação bloqueada na trava, pessoa ativa criada e commitada por outra conexão, trava solta — 409 sector.in_use (Molde A, GJ11; falha se a conferência rodar fora da transação travada)`; `409 não grava trilha nem muda o setor`; `exceção de pessoa inativa e agendado a uma pessoa não bloqueiam`.
6. **Nível em uso na transação (E3):** T5 `desativar com pessoa ativa — 409 people=N`; `desativação bloqueada na trava, pessoa ativa criada e commitada por outra conexão, trava solta — 409 levels.in_use` (Molde A); `duas edições intercaladas — o antes da segunda é o depois da primeira` (Molde B); T4 o mesmo Molde B para o turno.
7. **Trilha (E8):** T4/T5 `criação grava os valores iniciais`; `alteração sem mudança não grava`; `reordenar grava a ordem antes e depois`; `falha da trilha desfaz a gravação`; `sem telefone nem e-mail`.
8. **Reativação (E10):** T6 `ficha e tela de pessoas do setor — 409`; `trocar e reativar juntos com destino ativo — passa`; `pessoa ativa com nível inativo editada — passa`.
9. **Parâmetros de URL:** T10 `?date= sem sectorIds — nada marcado`; `sectorIds fora do alcance — ignorado`; `nenhum POST no carregamento`.
10. **`detail` sem dado pessoal:** T3/T5 `detail é exatamente people=…, exceptions=…, scheduled=…`.

## Rastreio (aceite → task → teste)

| Aceite / item | Task | Teste |
|---|---|---|
| 1 | T2, T7 | T2 `ADMIN: todos os setores ativos em ordem de nome, com as contagens de hoje`; T7 `aceite 1: título, subtítulo de todos, aviso fixo e um cartão por setor`; `aceite 1: bloco aparece no estado vazio` |
| 2 | T2, T7 | T2 `aceite 2: SUPERVISOR vê só os dois setores que gere`; `aceite 2: OPERATOR sem setor gerido — 403 sem leituras`; T7 `aceite 2: VIEWER — sem bloco e sem chamada`; `aceite 2: 403 team_whatsapp.forbidden — sem bloco e sem erro`; `aceite 2: subtítulo dos seus setores` |
| 3 | T1, T2, T7, T8 | T1 `o schema não aceita nome nem telefone de pessoa`; T2 `aceite 3: VIEWER 403; data ausente e inválida 400 como o roster; sem evento de trilha`; `aceite 3: mais de 2000 no alcance — 200`; `aceite 3: setor sozinho acima de 2000 — overLimit`; T7 `aceite 3: cartão overLimit mostra o texto`; T8 `aceite 3: overLimit sem Ver pessoas` |
| 4 | T1, T2, T7 | T1 casos de `panoramaCounts`; T2 `aceite 4: emprestado conta no setor do empréstimo`; `pessoa inativa não conta`; `números batem com o roster`; T7 `aceite 4: Outros turnos, Sem telefone e Sem autorização só com N > 0; Ninguém na escala deste dia` |
| 5 | T7, T8 | T8 `aceite 5: roster só no clique; fechar e abrir não busca de novo; telefone mascarado`; T7 `aceite 5: trocar a data recarrega; sem recarga por foco ou intervalo` |
| 6 | T8, T9, T10 | T8 `aceite 6: links de Ver escala e Enviar mensagem`; T9 `aceite 6: /escala abre no setor e na data; inválido ignorado`; T10 `aceite 6: /whatsapp-equipe com o setor marcado e a data; fora do alcance ignorado` |
| 7 | T8, T10 | T8 `aceite 7: vários setores só com 2+ setores e equipe.enviar; sem equipe.enviar nenhum botão de envio`; T10 `aceite 7: ?date= sem sectorIds — nenhum setor marcado` |
| 8 | T2, T7 | T2 `aceite 8: inProgress só com a data de hoje`; T7 `aceite 8: atalho troca a data para ontem` |
| 9 | T7 | `aceite 9: falha mostra o erro com Tentar de novo e os indicadores continuam` |
| 10 | T14 | `aceite 10: entrada 2026.11.21.1 no topo` + `release-notes.spec.ts` verde |
| 11 | T3, T11 | T3 `aceite 11: pessoa ativa, exceção futura de pessoa ativa e agendado pendente — 409 sector.in_use com detail`; `exceção de pessoa inativa e agendado a uma pessoa não bloqueiam`; T11 `aceite 11: Inativo desligado com as dependências e o que fazer` |
| 12 | T3 | `aceite 12: dependência criada depois da tela — 409 na gravação`; `aceite 12: inativação bloqueada na trava × pessoa ativa commitada por outra conexão — 409 (Molde A)` |
| 13 | T3, T11 | T3 `aceite 13: sem uso inativa; pessoas inativas mantêm o vínculo; histórico intacto`; T11 `aceite 13: confirmação; aviso do número da área` |
| 14 | T5, T12 | T5 `aceite 14: nível com pessoa ativa — 409 levels.in_use people=1`; `sem uso desativa`; T12 `aceite 14: Desativar desligado; confirmação` |
| 15 | T11, T12 | `aceite 15: 409 depois de abrir — mensagem e recarga das dependências` |
| 16 | T4, T5, T14 | T4/T5 `aceite 16: criação, alteração, reordenar, sem mudança`; `aceite 16: eventos na consulta da trilha, categoria Estrutura`; T14 `rótulos Início, Término, Ordem` |
| 17 | T3 | `aceite 17: renomear, trocar o gestor e reativar com uso — 200 com trilha` |
| 18 | T6, T13 | T6 `aceite 18: ficha e tela de pessoas do setor — 409 user.sector_inactive / user.level_inactive`; `trocar e reativar com destino ativo`; `pessoa ativa com nível desativado editada`; T13 `aceite 18: a tela mostra a mensagem` |
| 19 | Fechamento | `grep -in` de `MSG-01b` em `reports/plano-gbr/dados.py` com o texto exato "Aguarda a GBR (C740)" no `resumo` (o `status` segue "novo": o enum não tem "aguarda"); nenhum arquivo de agendamento no diff do lote |

## Mapa de arquivos

- Criar (back): `backend/src/schemas/contracts/team-panorama.schema.ts`, `backend/src/modules/team-whatsapp/team-panorama.counts.ts` (T1); `team-panorama.load.ts`, `team-panorama.service.ts`, `team-panorama.controller.ts`, `dto/panorama-query.dto.ts` (T2); `backend/src/shared/errors/usage-detail.ts`, `backend/src/modules/internal-sectors/sector-usage.ts`, `sector.errors.ts` (T3); `backend/src/shared/audit/audit-order.ts`, `backend/src/modules/shifts/shift-audit.ts` (T4); `backend/src/modules/levels/level-usage.ts`, `level-audit.ts` (T5); `backend/src/modules/users/reactivation-guard.ts` (T6). Specs novos em cada task.
- Modificar (back): `team-whatsapp.module.ts`, `route-parity.spec.ts` (T2); `internal-sectors.repository.ts`, `internal-sectors.service.ts`, `sector.schema.ts` (T3); `shifts.repository.ts`, `shifts.service.ts` (T4); `levels.repository.ts`, `levels.service.ts`, `levels.errors.ts`, `level.schema.ts` (T5); `users.service.ts`, `users.errors.ts` (T6).
- Criar (front): `features/team-panorama/{schemas,api,labels}.ts`, `components/{factory-panorama,panorama-card}.tsx` (T7); `features/team-panorama/links.ts`, `components/{panorama-people,panorama-actions}.tsx` (T8); `lib/civil-date-param.ts`, `features/staff-schedule/schedule-search.ts` (T9); `features/team-whatsapp/send-search.ts` (T10); `features/internal-admin/sector-usage.ts`, `components/{sector-in-use,sector-inactivate-dialog}.tsx` (T11); `features/levels/in-use.ts`, `components/level-deactivate-dialog.tsx` (T12). Specs novos em cada task.
- Modificar (front): `internal-dashboard-page.tsx` (T7); `features/team-panorama/api.ts`, `components/{factory-panorama,panorama-card}.tsx` (T8, depois da T7); `routes/_authenticated/escala/index.tsx` (T9); `routes/_authenticated/whatsapp-equipe/index.tsx`, `features/team-whatsapp/use-send-filters.ts` (T10); `features/internal-admin/schemas.ts`, `components/sector-form.tsx`, `routes/_authenticated/setores/$sectorId.tsx` (T11); `features/levels/{schemas,error-messages}.ts`, `components/levels-table.tsx` (T12); `features/users/error-messages.ts`, `features/sector-people/error-messages.ts` (+ `features/users/components/user-status-flow.tsx` só se preciso) (T13); `release-notes.ts`, `features/audit-trail/labels.ts` (T14).

## Ordem e paralelismo

```
Onda 1:  T1 (contrato e contagem do panorama)   T3 (setor em uso)   T4 (trilha do turno)   T6 (reativação)   T9 (front: /escala + data da URL)
Onda 2:  T2 (rota do panorama) <- T1   T5 (nível em uso + trilha) <- T3, T4   T7 (front: bloco do panorama)   T10 (front: /whatsapp-equipe) <- T9   T11 (front: setor)   T13 (front: reativação)
Onda 3:  T8 (front: Ver pessoas e ações) <- T7, T9, T10   T12 (front: nível)   T14 (Novidades e rótulos da trilha)
```

- **Ownership disjunto por onda:** Onda 1 — T1: arquivos novos de CJ1/CJ2 (T1); T3: `internal-sectors/`, `sector.schema.ts`, `shared/errors/usage-detail.ts`; T4: `shifts/`, `shared/audit/audit-order.ts`; T6: `users/` (guard, erros, uma linha em `users.service.ts`) e o spec novo de integração; T9: `lib/civil-date-param.ts`, `features/staff-schedule/schedule-search.ts`, `routes/_authenticated/escala/index.tsx`. Onda 2 — T2: arquivos novos do panorama, `team-whatsapp.module.ts`, `route-parity.spec.ts`; T5: `levels/`, `level.schema.ts`; T7: `features/team-panorama/` (cria) e `internal-dashboard-page.tsx`; T10: `send-search.ts`, `use-send-filters.ts`, `whatsapp-equipe/index.tsx`; T11: `features/internal-admin/`, `setores/$sectorId.tsx`; T13: os dois `error-messages.ts` (+ `user-status-flow.tsx`). Onda 3 — T8: `features/team-panorama/` (acrescenta); T12: `features/levels/`; T14: `release-notes.ts`, `features/audit-trail/labels.ts`.
- **Arquivos compartilhados com dono único:** `route-parity.spec.ts` e `team-whatsapp.module.ts` só a T2; `release-notes.ts` só a T14; `usage-detail.ts` criado pela T3 e consumido pela T5; `audit-order.ts` criado pela T4 e consumido pela T5; `civil-date-param.ts` criado pela T9 e consumido pela T10 e pela T8; `features/team-panorama/` criada pela T7 e acrescida pela T8.
- **T8 na Onda 3:** os `<Link to="/escala" search>` e `<Link to="/whatsapp-equipe" search>` só compilam depois que T9 e T10 declaram `validateSearch`.
- **Front sem dependência de código do back:** T7, T11, T12, T13 espelham os contratos com campos tolerantes (GJ7).
- **Testcontainers:** T3, T4 e T6 (Onda 1) e T2 e T5 (Onda 2) têm integração; a principal serializa (no máximo dois ao mesmo tempo).
- **Gate conjunto:** com tasks paralelas, o `--changed` de uma mede o diff das outras; falha só de arquivo alheio vai para o report. A principal roda o `--changed` conjunto (back e front) e o `tsc` do back depois de cada onda.
- **Revisão** (SKILL.md do sdd, §Revisão por risco): `opus` em T2 (`Risco: crítico (autorização)`), T3 e T5 (`Risco: alto` com linha "Crítico: concorrência"), T6 e T8 (linha `fronteira`); `sonnet` em T1, T4, T7, T9–T14. Total **14 tasks** em 3 ondas: 1 `Risco: crítico` (T2), 6 altas (T1, T3, T4, T5, T6, T10), 7 médias ou baixas.

---

## Task 1 — Contrato e contagem do panorama (back, puro)

**Arquivos:** criar `backend/src/schemas/contracts/team-panorama.schema.ts`, `backend/src/schemas/contracts/team-panorama.schema.spec.ts`, `backend/src/modules/team-whatsapp/team-panorama.counts.ts`, `team-panorama.counts.spec.ts`. Nenhum arquivo existente.

**Interfaces:** consome `civilDateSchema` (o mesmo import de `teamRosterQuerySchema`, `team-whatsapp.schema.ts:271-274`), `shiftRefSchema` (`shift.schema.ts:10-15`), `DayMember` (`team-whatsapp.roster.ts:51-54`), `sendPhoneOf` (`recipient-skip.ts:12-16`). Produz CJ1 e `panoramaCounts` (CJ2).

**Contexto vinculado:**
- P2 "Resposta": "só contagens por setor, sem nome nem telefone. Ela traz: os turnos ativos (id, nome, início, fim), por `sortOrder` e depois nome; o turno da noite em andamento (P7); por setor do alcance (id, nome), em ordem de nome: em serviço por turno ativo; em serviço em turno inativo ('Outros turnos'); folga, férias e sem escala; entre os em serviço, sem telefone (`hasPhone` falso) e sem autorização de contato (a mesma regra que faz a prévia agrupar alguém como não autorizado)."
- P2 "Muitas pessoas": "Um setor que sozinho passe de 2000 pessoas mostra, no lugar das contagens, 'Setor com mais de 2000 pessoas: veja na Escala'" → `overLimit: true`, `counts: null`.
- DJ4 inteiro (WORK em turno ativo × outro turno; `DAY_OFF`/`VACATION`/`NONE`; `noPhone` e `notAuthorized` disjuntos, na ordem da prévia; `byShift` com zeros). `DaySituation`: `{ kind: 'WORK', sectorId, shiftId, source }`, `{ kind: 'OFF', reason: 'DAY_OFF' | 'VACATION', source }`, `{ kind: 'NONE' }` (`staff-schedule.schema.ts:6-19`).
- GJ3: a resposta não carrega nome nem telefone de pessoa.

**Passos:**
1. [ ] RED (`team-panorama.counts.spec.ts`): `it('aceite 4: em serviço por turno ativo, com zero nos turnos sem ninguém, na ordem dos turnos')`; `it('aceite 4: WORK em turno inativo conta em otherShifts')`; `it('aceite 4: folga, férias e sem escala')`; `it('aceite 4: sem telefone e sem autorização só entre os em serviço; quem não tem telefone não conta também como sem autorização')`; `it('telefone do contato ligado vale como telefone (sendPhoneOf)')`; `it('CADASTRO_ANTERIOR autorizado não conta como sem autorização')`.
2. [ ] RED (`team-panorama.schema.spec.ts`): `it('aceite 3: resposta com counts e overLimit; chave extra de pessoa (name, phoneE164) é descartada')`; `it('query sem date ou com 2026-02-30 falha')`.
3. [ ] GREEN; eslint (GJ9); typecheck; `--changed`.

**Aceite:** base de 3 e 4. **Risco: alto** (decide os números que a liderança vê). Revisão `sonnet` (funções puras e contrato novo; o alcance é da T2).

## Task 2 — Rota do panorama (back)

**Arquivos:** criar `backend/src/modules/team-whatsapp/team-panorama.load.ts`, `team-panorama.service.ts`, `team-panorama.controller.ts`, `dto/panorama-query.dto.ts`, specs `team-panorama.load.spec.ts`, `team-panorama.service.spec.ts`, `team-panorama.controller.spec.ts`, `team-panorama.integration.spec.ts`; modificar `team-whatsapp.module.ts` (**só** `TeamPanoramaController` em `controllers` e `TeamPanoramaService` em `providers`); `backend/src/modules/permissions/route-parity.spec.ts` (**só** a linha `PARITY` `{ controller: TeamPanoramaController, routes: [['GET /panorama', ASO]] }` e o import, no molde de `TeamAlertController`, ~L27 e ~L103).

**Interfaces:** consome CJ1, `panoramaCounts` (T1), `TeamWhatsappRepository.findActor` (`:605`), `listSectors` (`:831-841`), `listActiveShifts` (`:634-640`), `loadDayPeopleMany` (`:677-724`), `isTeamSender` (`team-whatsapp.policy.ts:47-59`), `teamForbidden` (`team-whatsapp.errors.ts:9-14`), `dayMembers` (`team-whatsapp.roster.ts:74-100`), `overnightInProgress` (`team-whatsapp.selection.ts:15-25`), `todayIn`. Produz CJ2 e a rota.

**Contexto vinculado:**
- P2 "Rota": "rota nova de leitura `GET internal/team-whatsapp/panorama?date=AAAA-MM-DD`, sem lista de setores. O servidor aplica o alcance do ator, e quem não é remetente recebe o mesmo 403 do roster." "Data ausente ou inválida dá 400, com o mesmo erro de data do roster." "A leitura não grava trilha, como o roster."
- P2 "Quem conta": "só pessoas ativas. A pessoa conta no setor em que atua na data, como no roster: quem trabalha emprestado conta no setor do empréstimo, e não também no de origem." "Quem fica de fora: pessoa ativa sem setor no cadastro e sem escala em nenhum setor não aparece em nenhum cartão."
- P2 "Muitas pessoas": "o panorama funciona com mais de 2000 pessoas no alcance, porque a contagem é feita por setor ou em grupos de setores. O teto de 2000 do roster não vale para o alcance inteiro."
- P7: "Quando um turno que atravessa a meia-noite, iniciado ontem, ainda está em andamento (…). A regra é a mesma que a tela de envio já usa, e o servidor a devolve na resposta do panorama. O atalho só aparece quando a data escolhida é hoje."
- Restrições: "O panorama não consulta bloqueio nem consentimento por pessoa". DJ1, DJ2, DJ3, DJ5 inteiros. GJ4 (alcance e ordem do 403). GJ8 (`now` explícito).
- Aceite 4: "Na mesma data, os números batem com o roster." O roster monta os setores pelo mesmo `loadDayPeopleMany` + `dayMembers` (`team-whatsapp.service.ts:426-452,610-622`).
- `route-parity.spec.ts:58-133,259-266`: a lista `PARITY` confere papel por rota; rota com `@Roles` e `@RequirePermission` juntos é recusada (`:270`).

**Passos:**
1. [ ] RED unidade (`team-panorama.load.spec.ts`, repositório falso): `it('uma rodada quando cabe')`; `it('too_many_people na rodada — refaz setor a setor e marca over_limit só o setor que sozinho estoura')`; `it('outro erro propaga')`.
2. [ ] RED unidade (`team-panorama.service.spec.ts`): `it('aceite 2: ator nulo ou não remetente — 403 team_whatsapp.forbidden sem chamar listSectors nem loadDayPeopleMany')`; `it('ADMIN usa listSectors(null); SUPERVISOR usa managedSectorIds')`; `it('aceite 8: inProgress só quando date === today')`; `it('setores ordenados por nome pt-BR')`.
3. [ ] RED controller (`team-panorama.controller.spec.ts`, padrão do spec do controller do roster): `it('aceite 3: VIEWER 403 do RolesGuard')`; `it('aceite 3: sem date e com date inválida — 400 com o mesmo código que o roster devolve para a mesma query')`.
4. [ ] RED integração (`team-panorama.integration.spec.ts`, banco real, fixtures de serviço do roster de hoje, `createdAt` explícito): `it('aceite 1: ADMIN — todos os setores ativos, setor inativo fora')`; `it('aceite 2: SUPERVISOR que gere dois setores vê só esses dois')`; `it('aceite 2: SUPERVISOR cujo setor gerido está inativo não vê esse setor; se não gere outro ativo, 403 team_whatsapp.forbidden')` (`managedSectorIds` só de setores ativos, `team-actor.query.ts:21`; dois casos: gere um ativo e um inativo → vê só o ativo; gere só o inativo → 403); `it('aceite 4: emprestado (OTHER_SECTOR) conta no setor do empréstimo e não no de origem')`; `it('aceite 4: pessoa inativa não conta; pessoa sem setor e sem escala não aparece')`; `it('aceite 4: números batem com o roster na mesma data')` (mesmo setor e data pelo roster real ou por `loadDayPeopleMany` + `dayMembers`; registrar o caminho); `it('aceite 3: a resposta não contém nome nem telefone semeados')`; `it('aceite 3: a leitura não grava AuditEvent')` (contagem antes e depois); `it('aceite 3: alcance com mais de 2000 pessoas responde 200')` (dois setores de 1100 por `createMany`); `it('aceite 3: setor sozinho com 2001 — overLimit e counts null; os outros com contagens')`.
5. [ ] GREEN; módulo; `route-parity.spec.ts`; typecheck; eslint (GJ9); validação (`TESTCONTAINERS_ENABLED=1`); `--changed`.

**Aceite:** 1, 2, 3, 4, 8 (back). **Risco: crítico (autorização).**
**Crítico: autorização — a rota aplica o alcance do ator (ADMIN todos, os demais só os setores que gerem) e recusa o não remetente antes de ler; um portão no lugar errado entrega contagens de setor fora do alcance.**

## Task 3 — Setor em uso não é inativado (back)

**Arquivos:** criar `backend/src/shared/errors/usage-detail.ts` (+ `usage-detail.spec.ts`), `backend/src/modules/internal-sectors/sector-usage.ts`, `sector.errors.ts`, specs `sector-usage.spec.ts`, `internal-sectors.in-use.integration.spec.ts`; modificar `internal-sectors.repository.ts` (`updateWithAudit` ~L82-101: quarto parâmetro opcional `guard`, chamado depois do `findUniqueOrThrow` do "antes"; método novo `usage`), `internal-sectors.service.ts` (`update` ~L100-111: passa `inactivationGuard(id, todayIn(new Date()))` quando `input.isActive === false`; `get` ~L65-72: acrescenta `usage: await this.repo.usage(id, todayIn(new Date()))`), `backend/src/schemas/contracts/sector.schema.ts` (+ `sectorUsageSchema`); as asserções de forma do `get` nos specs existentes que quebrarem (só o campo novo; listar no report).

**Interfaces:** consome `SectorAuditRow` (`sector-audit.ts:12-21`), `toDbDate`/`todayIn` (`staff-schedule/civil-date.ts`), `DomainError` (`shared/errors/domain.error.ts:9-21`). Produz CJ3 (inclusive `usage-detail.ts`, que a T5 consome).

**Contexto vinculado:**
- E2: "Setor em uso não é inativado. Está em uso quando tem: 1. pessoas ativas com ele como setor principal; 2. exceções de escala de hoje em diante (Manaus) que apontam para ele, de pessoas ativas; 3. envios da equipe agendados e ainda pendentes que o incluem: envio em estado agendado com o setor entre os setores do envio. Envio agendado a uma pessoa não conta." "Recusa: a API devolve 409 `sector.in_use`. O `detail` traz só tipo e contagem dos tipos com contagem maior que zero, no formato `people=3, exceptions=1, scheduled=2`, sem dado pessoal." "Concorrência: a conferência e a gravação ocorrem na mesma transação, com a linha do setor travada."
- E2 "Limite conhecido": "criar agendado, exceção ou vínculo não trava o setor; o que for criado no mesmo instante da inativação segue a regra atual".
- E4: "a tela do setor (…) mostra 'Em uso' (…). Os dados vêm junto com o setor". "Informação que não bloqueia: 'N pessoa(s) inativa(s) mantêm o vínculo'." E7: "Edições que continuam livres: renomear, trocar o gestor e reativar, sempre com trilha." E9: "comunicações internas abertas do setor não entram na conta".
- DJ9, DJ10 inteiros. GJ3 (`detail` sem dado pessoal). GJ5. GJ11 (corrida real).
- Estado de hoje: `updateWithAudit` trava a linha com `SELECT id FROM "Sector" WHERE id = ${id} FOR NO KEY UPDATE` e lê o "antes" no mesmo `tx` (`internal-sectors.repository.ts:87-92`); a trilha só grava se algum campo mudou (`internal-sectors.service.ts:176-190`); `write()` só traduz P2002 (`:198-212`).
- GJ9: repositório e serviço são legados — um parâmetro, um método e duas chamadas; a regra mora em `sector-usage.ts`.

**Passos:**
1. [ ] RED unidade (`usage-detail.spec.ts`): `it('só chaves com valor > 0, na ordem, separadas por vírgula e espaço')`; `it('people=2 sozinho')`. (`sector-usage.spec.ts`): `it('inactivationGuard: antes inativo — não consulta')`; `it('em uso — sector.in_use 409 com detail people=3, exceptions=1, scheduled=2')`; `it('só inactivePeople — não bloqueia')`.
2. [ ] RED integração (`internal-sectors.in-use.integration.spec.ts`, banco real, serviço real com `AuditService` real): `it('aceite 11: pessoa ativa — 409 sector.in_use people=1; setor continua ativo; nenhum AuditEvent novo')`; `it('aceite 11: exceção OTHER_SECTOR de hoje em diante de pessoa ativa — 409 exceptions=1')`; `it('aceite 11: exceção de pessoa inativa e exceção que terminou ontem — não bloqueiam')`; `it('aceite 11: agendado pendente com o setor — 409 scheduled=1; cancelado, já disparado e agendado a uma pessoa não bloqueiam')`; `it('aceite 11: detail sem nome, e-mail ou telefone')`; `it('aceite 12: uso criado depois do GET (tela aberta sem uso) — a gravação recusa com 409')`; `it('aceite 12: inativação bloqueada na trava do setor, pessoa ativa do setor criada e commitada por outra conexão, trava solta — 409 sector.in_use, setor continua ativo, nenhum AuditEvent novo')` (**Molde A do GJ11**, `SELECT id FROM "Sector" WHERE id = ${id} FOR NO KEY UPDATE` na transação separada; este teste **falha se a conferência rodar fora da transação travada**, ou seja, antes do `FOR NO KEY UPDATE` de `internal-sectors.repository.ts:88`; escrever isso num comentário do `it`). O caso "uso criado depois do GET" acima é sequencial e **não** prova a corrida: o teste de intercalação é o que prova; `it('aceite 13: sem uso — inativa; pessoas inativas continuam com sectorId; UserAssignment e exceções antigas intactos')`; `it('aceite 17: setor em uso — renomear e trocar o gestor 200 com AuditEvent sector.updated')`; `it('aceite 17: setor inativo com dependência legada — reativar 200 com trilha')`; `it('GET :id devolve usage com inactivePeople')`.
3. [ ] GREEN; ajustar specs de forma do `get`; typecheck; eslint (GJ9); validação (`TESTCONTAINERS_ENABLED=1`); `--changed`.

**Aceite:** 11, 12, 13, 17 (back). **Risco: alto** (concorrência; pela SKILL.md, concorrência não é categoria de `Risco: crítico`, mas o delta decide a gravação sob trava, daí a linha abaixo e a revisão `opus`).
**Crítico: concorrência — a conferência de uso entra na transação que trava a linha do setor e decide se a inativação grava; conferência fora dela deixaria setor inativo com pessoas ativas e agendado que dispara.**

## Task 4 — Trilha do turno com antes e depois (back)

**Arquivos:** criar `backend/src/shared/audit/audit-order.ts` (+ `audit-order.spec.ts`), `backend/src/modules/shifts/shift-audit.ts` (+ `shift-audit.spec.ts`), `shifts.trail.integration.spec.ts`; modificar `shifts.repository.ts` (métodos novos `createWithAudit`, `updateWithAudit` (com `SELECT id FROM "Shift" WHERE id = ${id} FOR NO KEY UPDATE` antes de ler o "antes", DJ12), `reorderWithAudit`; `create`/`update`/`setOrder` ficam se ainda tiverem chamador), `shifts.service.ts` (`create` ~L86-103, `update` ~L105-120, `reorder` ~L122-134: troca de `repo.create`/`update`/`setOrder` + `audit.log` pelas versões `WithAudit` com a trilha de CJ5; a conferência de uso de `update` fica onde está); nos specs existentes de `shifts.service`, **só** as asserções de `audit.log('shift.*')` que passam a `recordChange` (listar no report).

**Interfaces:** consome `AuditService.recordChange` (`audit.service.ts:114-117`), `diffFields`/`FieldChange` (`audit-change.ts:6-10,56`), `ShiftCreateData`/`ShiftUpdateData`/`ShiftRow` (`shifts.repository.ts:16-23`). Produz CJ5 (inclusive `audit-order.ts`, que a T5 consome).

**Contexto vinculado:**
- E8: "Turno e nível: passam a gravar, na mesma transação e na categoria Estrutura, quem, quando e os valores de nome, horário (turno) e ativo. Na criação grava os valores iniciais, como o setor faz; na alteração, o antes e o depois." "Reordenar: grava a ordem antes e depois." "Sem mudança: alteração que não muda nada não grava evento." "Dado pessoal: a trilha de estrutura não leva telefone nem e-mail."
- E3: "O turno segue como está (409 `shifts.in_use`)" — a conferência de uso do turno não muda (`shifts.service.ts:114-116`).
- DJ12 inteiro (nomes das ações mantidos; `entity: 'Shift'`; campo `order` com nomes unidos por `" > "`; `recordChange` propaga erro e desfaz a gravação). **Trava:** `updateWithAudit` roda `SELECT id FROM "Shift" WHERE id = ${id} FOR NO KEY UPDATE` antes de ler o "antes" (duas edições simultâneas gravariam um "antes" errado); o reordenar trava todas as linhas (`SELECT id FROM "Shift" ORDER BY id FOR NO KEY UPDATE`) antes de ler a ordem antiga. A conferência de uso do turno continua como está, fora da transação. Padrão a seguir: `sector-audit.ts` + `internal-sectors.service.ts:176-190`.
- GJ9: `shifts.service.ts` e `shifts.repository.ts` são legados — troca de chamadas e métodos novos; a comparação mora em `shift-audit.ts`.

**Passos:**
1. [ ] RED unidade (`audit-order.spec.ts`): `it('ordem igual — nenhum campo')`; `it('ordem diferente — campo order com nomes unidos por >')`. (`shift-audit.spec.ts`): `it('criação lista nome, início, fim e ativo')`; `it('alteração só dos campos que mudaram')`; `it('nada mudou — vazio')`.
2. [ ] RED integração (`shifts.trail.integration.spec.ts`, banco real, `AuditService` real): `it('aceite 16: criar turno grava shift.create com os valores iniciais, categoria STRUCTURE e actorId')`; `it('aceite 16: renomear e trocar horário grava antes e depois só desses campos')`; `it('aceite 16: desativar turno sem uso grava isActive true → false')`; `it('aceite 16: PATCH sem mudança — nenhum evento')`; `it('aceite 16: reordenar grava order antes e depois; mesma ordem — nenhum evento')`; `it('falha na trilha desfaz a gravação do turno')` (espiar `recordChange` para lançar); `it('aceite 16: eventos aparecem na consulta da trilha com categoria Estrutura')` (por `AuditTrailService.list`, `audit-trail.service.ts:49`; o filtro de categoria fica em `:53,76`); `it('duas edições do mesmo turno intercaladas — o antes da segunda é o depois da primeira')` (**Molde B do GJ11**, `FOR NO KEY UPDATE` em `"Shift"`; falha se `updateWithAudit` ler o "antes" sem a trava); `it('turno em uso continua 409 shifts.in_use, sem evento')`.
3. [ ] GREEN; ajustar specs de `audit.log`; typecheck; eslint (GJ9); validação (`TESTCONTAINERS_ENABLED=1`); `--changed`.

**Aceite:** 16 (turno). **Risco: alto** (trilha DAT-02 passa a ser gravada na transação; falha dela desfaz a edição). Revisão `sonnet`.

## Task 5 — Nível em uso e trilha do nível (back)

**Arquivos:** criar `backend/src/modules/levels/level-usage.ts`, `level-audit.ts`, specs `level-usage.spec.ts`, `level-audit.spec.ts`, `levels.in-use.integration.spec.ts`; modificar `levels.repository.ts` (`levelSelect`/`toAdmin` ~L9-23 com `activePeople` e `inactivePeople`; métodos `createWithAudit`, `updateWithAudit`, `reorderWithAudit`), `levels.service.ts` (`create` ~L65-75, `update` ~L77-91, `reorder` ~L93-104: troca pelas versões `WithAudit`, com `deactivationGuard(id)` no `update` quando `data.isActive === false`; o comentário da classe, L50-53, passa a dizer que desativar com pessoa ativa é bloqueado), `levels.errors.ts` (+ `levelInUse`), `backend/src/schemas/contracts/level.schema.ts` (`levelAdminSchema` ~L10-15 + dois campos; comentário de `userCount`); nos specs existentes de `levels`, **só** asserções de forma e de `audit.log('level.*')` que quebrarem (listar no report).

**Interfaces:** consome `usageDetail` (T3), `orderChange`/`OrderTrail` (T4), `recordChange`, `diffFields`. Produz CJ4.

**Contexto vinculado:**
- E3: "Nível com pessoas ativas não é desativado: 409 `levels.in_use`, com `detail` no mesmo formato (`people=N`), conferido na mesma transação da gravação." E2 "Limite conhecido": "no nível vale o mesmo: a edição da pessoa não trava o nível".
- E4: "a lista de níveis mostra 'Em uso' (…). Os dados vêm (…) com a lista de níveis, que a API passa a devolver". "Texto do nível: 'N pessoa(s) ativa(s) com este nível'." "Informação que não bloqueia: 'N pessoa(s) inativa(s) mantêm o vínculo'."
- E8 (texto na T4): criação com valores iniciais, alteração com antes e depois, reordenar com a ordem, sem mudança sem evento, sem telefone nem e-mail.
- DJ10, DJ11, DJ12 inteiros (trava `FOR NO KEY UPDATE` na linha do nível; guard só com "antes" ativo; `entity: 'StaffLevel'`; ações `level.create`/`level.update`/`level.reorder`). GJ5, GJ11.
- Estado de hoje: `update` só confere existência e nome e grava `audit.log('level.update', …)` sem antes e depois (`levels.service.ts:77-91`); `userCount` vem de `_count.users` (todas, ativas ou não).
- GJ9: serviço, repositório e schema são legados; regra em `level-usage.ts`/`level-audit.ts`.

**Passos:**
1. [ ] RED unidade (`level-usage.spec.ts`): `it('deactivationGuard: antes inativo ou pedido sem isActive false — não consulta')`; `it('aceite 14: com pessoa ativa — levels.in_use 409, detail people=2')`. (`level-audit.spec.ts`): criação, alteração e sem mudança.
2. [ ] RED integração (`levels.in-use.integration.spec.ts`, banco real): `it('aceite 14: nível com pessoa ativa — 409 levels.in_use people=1; nível continua ativo; nenhum evento')`; `it('aceite 14: só pessoa inativa — desativa; a pessoa mantém levelId')`; `it('lista traz activePeople e inactivePeople')`; `it('aceite 16: criar, renomear, desativar e reativar gravam level.* com antes e depois, categoria STRUCTURE')`; `it('aceite 16: sem mudança — nenhum evento')`; `it('aceite 16: reordenar grava order; mesma ordem — nada')`; `it('aceite 16: eventos level.* aparecem na consulta da trilha com categoria Estrutura')` (por `AuditTrailService.list`, `audit-trail.service.ts:49`; filtro de categoria em `:53,76`, como na T4); `it('aceite 14: desativação bloqueada na trava do nível, pessoa ativa com o nível criada e commitada por outra conexão, trava solta — 409 levels.in_use people=1; nível continua ativo')` (**Molde A do GJ11**, `FOR NO KEY UPDATE` em `"StaffLevel"`; falha se a conferência rodar fora da transação travada); `it('duas edições do mesmo nível intercaladas — o antes da segunda é o depois da primeira')` (**Molde B do GJ11**); `it('desativar e reativar não exigem nada além de estrutura.manter (permissão de hoje)')`.
3. [ ] GREEN; ajustar specs; typecheck; eslint (GJ9); validação (`TESTCONTAINERS_ENABLED=1`); `--changed`.

**Aceite:** 14, 16 (nível). **Risco: alto** (concorrência; linha abaixo e revisão `opus`, como na T3).
**Crítico: concorrência — a contagem de pessoas ativas entra na transação que trava a linha do nível e decide se a desativação grava; a trilha do nível passa a ler o "antes" na mesma transação.**

## Task 6 — Reativação de pessoa em setor ou nível inativo (back)

**Arquivos:** criar `backend/src/modules/users/reactivation-guard.ts`, `reactivation-guard.spec.ts`, `users.reactivation.integration.spec.ts`; modificar `users.errors.ts` (+ CJ6), `users.service.ts` (**só** uma linha no fim de `assertValidAssignment`, ~L702: `await assertReactivationAllowed(this.repo, user, input);` e o import).

**Interfaces:** consome `UsersRepository.findActiveSector` e `findLevelForAssignment` (usados em `users.service.ts:709,725`), `UserSummary` (`isActive`, `sectorId`, `levelId`), `UserPatch`. Produz CJ6.

**Contexto vinculado:**
- E10: "reativar uma pessoa cujo setor principal está inativo devolve 409 `user.sector_inactive`, com a mensagem 'O setor desta pessoa está inativo. Reative o setor ou troque o setor antes de reativar a pessoa.' Com o nível inativo, 409 `user.level_inactive`, com a mensagem 'O nível desta pessoa está desativado. Reative o nível ou troque o nível antes de reativar a pessoa.'" "Quando vale: só quando a pessoa passa de inativa para ativa. Editar uma pessoa que já está ativa não muda: o nível desativado que já é dela continua aceito, como hoje." "Onde vale: na ficha da pessoa e na tela de pessoas do setor. A importação não reativa ninguém." "Trocar e reativar juntos: é aceito quando o setor ou o nível novo está ativo."
- E2 "Limite conhecido": "a reativação de uma pessoa (E10) e a inativação do setor ou do nível ao mesmo tempo seguem o mesmo limite" (sem trava nova).
- DJ13, DJ15 inteiros. Fatos: há uma única gravação de `isActive`, `updateUser` → `updateWithLastAdminGuard` (`users.repository.ts:330-360`, Serializable); a tela de pessoas do setor reativa pelo mesmo `updateUser` (`sector-people-write.service.ts:293-298`) e `translateStatusGuard` deixa passar código desconhecido (`sector-people.errors.ts:63-67`); `assertValidAssignment` roda em `updateUser` (`users.service.ts:598`).
- GJ9: `users.service.ts` é legado — uma linha.

**Passos:**
1. [ ] RED unidade (`reactivation-guard.spec.ts`, repositório falso): `it('aceite 18: inativa → ativa com setor inativo mantido — user.sector_inactive')`; `it('aceite 18: com nível desativado mantido (ou reenviado igual) — user.level_inactive')`; `it('setor antes do nível')`; `it('aceite 18: trocar para setor e nível ativos e reativar — passa')`; `it('aceite 18: pessoa já ativa com nível desativado, editada — passa sem consultar')`; `it('sem setor e sem nível — passa')`.
2. [ ] RED integração (`users.reactivation.integration.spec.ts`, banco real): `it('aceite 18: ficha (UsersService.updateUser) — 409 user.sector_inactive; pessoa continua inativa; nenhum evento')`; `it('aceite 18: tela de pessoas do setor (setStatus) — 409 user.sector_inactive com a mesma mensagem')` (**ator ADMIN**: `canManageSector` recusa quem não é ADMIN em setor inativo, `sector-people.policy.ts:63-65`, então um gestor receberia 403 antes da regra nova); `it('aceite 18: nível desativado — 409 user.level_inactive nas duas telas')`; `it('aceite 18: trocar setor e reativar na mesma gravação — 200 com trilha user.reactivated')`; `it('setor informado inativo continua user.sector_invalid')`.
3. [ ] GREEN; typecheck; eslint (GJ9); validação (`TESTCONTAINERS_ENABLED=1`); `--changed`.

**Aceite:** 18 (back). **Risco: alto.**
**fronteira: validação de estado — decide se a reativação passa; sem a regra, a reativação contorna E2/E3 e põe gente ativa em setor ou nível inativo. Revisão `opus`.**

## Task 7 — Front: bloco "Operação da fábrica" na Visão geral

**Arquivos:** criar `frontend/src/features/team-panorama/schemas.ts`, `api.ts` (`useTeamPanorama`), `labels.ts`, `components/factory-panorama.tsx`, `components/panorama-card.tsx`, specs `labels.spec.ts`, `components/factory-panorama.spec.tsx`, `components/panorama-card.spec.tsx`, `frontend/src/features/internal-communications/components/internal-dashboard-page.panorama.spec.tsx`; modificar `internal-dashboard-page.tsx` (**só** o import e `<FactoryPanorama />` entre o `Header` e o conteúdo em `OverviewContent`, ~L38, à mão).

**Interfaces:** consome CJ1 (espelho tolerante), `useAuthStore`, `readApiErrorBody`, `todayInManaus` (`features/people-record/authorization.ts:36`), `formatDayMonth`, componentes de UI existentes (cartão e botão do padrão da Visão geral/escala). Produz CJ7 (menos `usePanoramaRoster`, links e ações, que são da T8).

**Contexto vinculado:**
- P1 "Lugar": "um bloco no topo da 'Visão geral' (`/dashboard`), acima dos indicadores de comunicações e independente deles. Aparece mesmo quando o resto da tela está no estado vazio, carrega depois dos indicadores e, se falhar, mostra 'Não foi possível carregar o panorama' com 'Tentar de novo', sem derrubar a tela." "Quem vê: só remetentes. VIEWER e quem não gere setor não veem o bloco." "Consulta: a tela do VIEWER não faz a consulta. (…) O SUPERVISOR ou OPERATOR que não gere setor recebe o 403 de remetente (`team_whatsapp.forbidden`), e o bloco simplesmente não aparece, sem mensagem de erro. Qualquer outro erro mostra a falha de P1." "Textos: título 'Operação da fábrica'; subtítulo 'Panorama de todos os setores' para ADMIN e 'Panorama dos seus setores' para os demais."
- P3: "'Em serviço em {data}', com uma linha por turno ativo: '{turno} ({início}–{fim}): N'." "Se houver alguém em serviço em turno inativo, aparece 'Outros turnos: N' logo depois das linhas de turno." "Abaixo: 'Folga: N', 'Férias: N', 'Sem escala: N'." "Entre os em serviço, só quando N > 0: 'Sem telefone: N' e 'Sem autorização de contato: N'." "Setor sem ninguém em nenhuma situação mostra 'Ninguém na escala deste dia'." "A data aparece no formato dd/MM."
- P2: setor acima de 2000 → "Setor com mais de 2000 pessoas: veja na Escala". P7: "o bloco mostra o atalho 'O turno {nome} de ontem ainda está em andamento. Ver {dd/MM}', que troca a data para ontem." "O atalho só aparece quando a data escolhida é hoje." P8: "A data padrão é hoje (Manaus), com seletor." Aviso fixo: "As contagens vêm da escala do dia, não da hora. Quem recebe uma mensagem só é definido na prévia do envio, que também confere bloqueios." "O bloco não atualiza sozinho: recarrega ao trocar a data ou ao voltar à tela."
- DJ6: `readApiErrorBody` é `async` (`lib/api-error.ts:44`). O `queryFn` de `useTeamPanorama` captura o `HTTPError` 403, lê o corpo com `await readApiErrorBody(error)` e, com `code === 'team_whatsapp.forbidden'`, devolve `null`; o bloco não renderiza com `data === null`; outro erro é relançado e mostra "Não foi possível carregar o panorama" com "Tentar de novo".
- DJ5, DJ6 inteiros. GJ3 (o bloco nunca chama o roster: isso é da T8, no clique). GJ10.
- GJ9: `internal-dashboard-page.tsx` é legado (linha longa, sem prettier): só a inserção.

**Passos:**
1. [ ] RED puro (`labels.spec.ts`): `it('panoramaSubtitle: ADMIN todos; demais seus')`; `it('shiftLine: Manhã (06:00–14:00): 3 com travessão')`; `it('cardLines: Outros turnos e lacunas só com N > 0; empty quando tudo é zero')`; `it('inServiceTitle usa dd/MM')`.
2. [ ] RED tela (`factory-panorama.spec.tsx`, `panorama-card.spec.tsx`, `internal-dashboard-page.panorama.spec.tsx`, fetch falso): `it('aceite 1: ADMIN vê Operação da fábrica, Panorama de todos os setores, o aviso fixo e um cartão por setor na ordem da resposta')`; `it('aceite 1: bloco aparece acima do estado vazio do usuário sem setor')`; `it('aceite 2: VIEWER — sem bloco e nenhuma chamada a internal/team-whatsapp/panorama')`; `it('aceite 2: SUPERVISOR — Panorama dos seus setores')`; `it('aceite 2: 403 team_whatsapp.forbidden — o queryFn devolve null: nenhum bloco, nenhum texto de erro (nem por um instante) e sem botão Tentar de novo')`; `it('403 com outro code, ou 500 — Não foi possível carregar o panorama e Tentar de novo')`; `it('aceite 9: 500 — Não foi possível carregar o panorama e Tentar de novo refaz a chamada; indicadores continuam')`; `it('aceite 4: cartão com linhas de turno, Outros turnos, Folga, Férias, Sem escala, Sem telefone e Sem autorização de contato')`; `it('aceite 4: setor zerado — Ninguém na escala deste dia')`; `it('aceite 3: overLimit — Setor com mais de 2000 pessoas: veja na Escala')`; `it('aceite 5: trocar a data faz nova chamada com a data; foco da janela não faz')`; `it('aceite 8: com inProgress e a data de hoje, atalho Ver dd/MM troca a data para a de ontem; com outra data, sem atalho')`.
3. [ ] GREEN; `npx tsc -b`; eslint (GJ9); validação; `--changed`.

**Aceite:** 1, 2, 3 (texto), 4 (tela), 5 (data), 8 (tela), 9. **Risco: médio.** Revisão `sonnet` (a recusa e o alcance são do servidor, T2; o bloco não carrega dado pessoal).

## Task 8 — Front: "Ver pessoas" e ações do cartão

**Arquivos:** criar `frontend/src/features/team-panorama/links.ts`, `components/panorama-people.tsx`, `components/panorama-actions.tsx`, specs `links.spec.ts`, `components/panorama-people.spec.tsx`, `components/panorama-actions.spec.tsx`; modificar `api.ts` (+ `usePanoramaRoster`), `components/panorama-card.tsx` (botão "Ver pessoas"/"Fechar", `PanoramaPeople` montado no primeiro clique e depois só escondido, `PanoramaActions`), `components/factory-panorama.tsx` (botão "Mensagem para vários setores").

**Interfaces:** consome CJ7 (T7), `teamRosterSchema` (`features/team-whatsapp/schemas.ts:65`), `phoneText` (`features/sector-people/phone-text.ts:8-10`), `usePermission('equipe.enviar')` (`features/permissions/use-permission.ts`), `Link` do TanStack Router com os `validateSearch` de T9 e T10 (CJ8). Produz o restante de CJ7.

**Contexto vinculado:**
- P4: "'Ver pessoas' expande o cartão e só então busca o roster daquele setor e daquela data (rota existente). Mostra os nomes por turno e situação, com o telefone como a tela de envio já mostra: completo com `telefone.ver_completo`, mascarado sem ela. Fechar o cartão não refaz a busca."
- P5: "'Ver escala' abre `/escala?sectorId=…&date=…`." "'Enviar mensagem' abre `/whatsapp-equipe?sectorIds=…&date=…` com aquele setor marcado." "O botão 'Mensagem para vários setores' aparece só quando o alcance tem dois ou mais setores. Ele abre `/whatsapp-equipe?date=…` com a lista de setores visível e nenhum pré-marcado. Prévia, disparo amplo e confirmação não mudam." "Os botões de envio só aparecem para quem tem `equipe.enviar`."
- Anti-objetivos: "A tela de entrada carregar nome ou telefone de pessoas sem um clique de 'Ver pessoas'" e "O panorama marcar setores no envio por conta própria: o botão 'vários setores' não pré-marca nada, e o envio nunca pula a prévia" são falhas.
- P2: setor acima de 2000 → "sem 'Ver pessoas'". DJ7, DJ8 inteiros (formato `sectorIds` por vírgula; "Ver escala" aparece para todo remetente).
- GJ3, GJ10.

**Passos:**
1. [ ] RED puro (`links.spec.ts`): `it('aceite 6: scheduleSearch e sendSearch com o setor e a data; vários setores sem sectorIds')`.
2. [ ] RED tela: `it('aceite 5: nenhuma chamada ao roster antes do clique; Ver pessoas busca roster?sectorIds=<id>&date=<data>')`; `it('aceite 5: Fechar e Ver pessoas de novo — uma chamada só')`; `it('aceite 5: nomes por turno, Outros turnos, Folga, Férias e Sem escala; telefone mascarado quando a resposta só traz phoneMasked')`; `it('aceite 3: cartão overLimit sem Ver pessoas')`; `it('aceite 6: Ver escala e Enviar mensagem apontam para /escala e /whatsapp-equipe com setor e data')`; `it('aceite 7: Mensagem para vários setores só com 2 ou mais setores e equipe.enviar; aponta para /whatsapp-equipe só com a data')`; `it('aceite 7: sem equipe.enviar — nem Enviar mensagem nem vários setores; Ver escala continua')`; `it('erro do roster — Não foi possível carregar as pessoas e Tentar de novo')`.
3. [ ] GREEN; `npx tsc -b`; eslint (GJ9); validação; `--changed`.

**Aceite:** 3 (sem Ver pessoas), 5, 6 (links), 7. **Risco: médio.**
**fronteira: dado pessoal — decide quando a tela de entrada carrega nomes e telefones (só no clique) e o que vai pré-marcado no envio; a máscara do telefone e o alcance são do servidor. Revisão `opus`.**

## Task 9 — Front: `/escala` aceita setor e data na URL

**Arquivos:** criar `frontend/src/lib/civil-date-param.ts`, `civil-date-param.spec.ts`, `frontend/src/features/staff-schedule/schedule-search.ts`, `schedule-search.spec.ts`, `frontend/src/routes/_authenticated/escala/index.search.spec.tsx`; modificar `routes/_authenticated/escala/index.tsx` (**só** `validateSearch: validateScheduleSearch` na rota ~L21 e o estado inicial de `pickedSectorId` e `anchor` em `ScheduleContent` ~L63-65 a partir de `initialSchedule(search, options)`).

**Interfaces:** consome `useScheduleOptions` (`features/staff-schedule/api.ts:15-21`: `today`, `sectors`), padrão de `validateSearch` de `routes/_authenticated/importar-pessoas/index.tsx:8-9` e do spec dela (`index.spec.tsx:42,81-84`). Produz CJ8 (`parseCivilDateParam`, `validateScheduleSearch`, `initialSchedule`).

**Contexto vinculado:**
- P6: "`/escala` passa a aceitar `sectorId` e `date`. A data vira a âncora do período no modo atual da tela." "Parâmetro inválido, de setor inativo ou fora do alcance é ignorado, sem erro: a tela abre como abriria sem ele." "Os parâmetros só preenchem o estado inicial; depois disso a tela funciona como hoje."
- DJ8 (data válida = `AAAA-MM-DD` e data real; setor só se está em `options.sectors`, que já é o alcance com setores ativos). Estado de hoje: `useState` para setor, modo (`'week'`) e âncora (`options.today`) em `ScheduleContent` (`escala/index.tsx:62-70`).
- GJ9: a rota é legada — só as duas trocas.

**Passos:**
1. [ ] RED puro: `it('parseCivilDateParam: 2026-11-21 sim; 2026-02-30, 21/11/2026, número e vazio não')`; `it('validateScheduleSearch descarta o que não é texto')`; `it('initialSchedule: setor fora das opções → null; data inválida → today')`.
2. [ ] RED tela (`index.search.spec.tsx`): `it('aceite 6: /escala?sectorId=<do alcance>&date=2026-11-18 abre no setor com a semana da data')`; `it('aceite 6: setor fora do alcance ou inativo e data inválida — tela como sem parâmetro, sem erro')`; `it('trocar setor depois não mexe na URL nem volta ao parâmetro')`.
3. [ ] GREEN; `npx tsc -b`; eslint (GJ9); validação; `--changed`.

**Aceite:** 6 (escala). **Risco: baixo.** Revisão `sonnet`.

## Task 10 — Front: `/whatsapp-equipe` aceita setores e data na URL

**Arquivos:** criar `frontend/src/features/team-whatsapp/send-search.ts`, `send-search.spec.ts`, `use-send-filters.initial.spec.ts`, `frontend/src/routes/_authenticated/whatsapp-equipe/index.search.spec.tsx`; modificar `use-send-filters.ts` (**só** o terceiro parâmetro opcional `initial?: SendInitial`, usado no inicializador do `useState`, ~L72-77: `sectorIds: initial?.sectorIds ?? null`, `date: initial?.date ?? today`), `routes/_authenticated/whatsapp-equipe/index.tsx` (**só** `validateSearch: validateSendSearch` ~L29 e, em `SendSection` ~L82, `useSendFilters(targets.today, targets.sectors, initialSendFilters(search, targets.sectors))`).

**Interfaces:** consome `parseCivilDateParam` (T9), `useTeamTargets` (`today`, `sectors` do alcance), `referenceDate`/`showsScreenDate` (`use-send-filters.ts:126-141`). Produz `validateSendSearch`, `initialSendFilters`, `SendInitial` (CJ8).

**Contexto vinculado:**
- P6: "`/whatsapp-equipe` passa a aceitar `sectorIds` (lista) e `date`. A data da URL vira a data da tela, aceita nas mesmas condições do seletor de data da própria tela. Nas finalidades em que a data de referência é a da atividade (Reunião, Palestra, Hora extra e o Alinhamento com data), ela continua sendo a da atividade, como hoje." "Parâmetro inválido, de setor inativo ou fora do alcance é ignorado, sem erro". "Os parâmetros só preenchem o estado inicial".
- P5: "Mensagem para vários setores" abre "com a lista de setores visível e nenhum pré-marcado. Prévia, disparo amplo e confirmação não mudam." Anti-objetivo: "o envio nunca pula a prévia".
- DJ8 inteiro. Estado de hoje: `sectorIds: null` vira `[sectors[0].id]` só com um setor no alcance, senão `[]` (`use-send-filters.ts:86`).
- GJ9: `use-send-filters.ts` e a rota são legados — só as trocas descritas.

**Passos:**
1. [ ] RED puro (`send-search.spec.ts`): `it('validateSendSearch: texto com vírgulas e lista de textos; descarta o resto')`; `it('initialSendFilters: ids fora do alcance saem; lista vazia → null; data inválida → null')`.
2. [ ] RED hook (`use-send-filters.initial.spec.ts`): `it('aceite 6: initial com um setor e uma data — sectorIds e date iniciais')`; `it('sem initial — igual a hoje')`; `it('Reunião com initial.date — referenceDate continua a da atividade')`.
3. [ ] RED tela (`index.search.spec.tsx`): `it('aceite 6: ?sectorIds=<id>&date=2026-11-18 — setor marcado e data na tela')`; `it('aceite 7: ?date= sem sectorIds com 3 setores no alcance — nenhum marcado, lista visível')`; `it('aceite 6: setor fora do alcance e data inválida — ignorados, sem erro')`; `it('nenhuma prévia nem envio sai no carregamento (nenhum POST)')`.
4. [ ] GREEN; `npx tsc -b`; eslint (GJ9); validação; `--changed`.

**Aceite:** 6 (envio), 7 (nenhum pré-marcado). **Risco: alto** (estado inicial da tela de envio). Revisão `sonnet` (só pré-preenche; prévia, alcance e disparo amplo continuam decididos pelo servidor).

## Task 11 — Front: setor em uso, confirmação e 409

**Arquivos:** criar `frontend/src/features/internal-admin/sector-usage.ts`, `components/sector-in-use.tsx`, `components/sector-inactivate-dialog.tsx`, specs `sector-usage.spec.ts`, `components/sector-in-use.spec.tsx`, `components/sector-inactivate-dialog.spec.tsx`, `frontend/src/routes/_authenticated/setores/$sectorId.in-use.spec.tsx`; modificar `features/internal-admin/schemas.ts` (`sectorDetailSchema` ~L34 + `usage: sectorUsageSchema.nullish()`), `components/sector-form.tsx` (prop opcional `usage?: SectorUsage | null`; item "Inativo" do select ~L133-145 desligado quando o setor está ativo e em uso, com "Em uso: não pode ser inativado"; `<SectorInUse usage={usage} />` abaixo do select), `routes/_authenticated/setores/$sectorId.tsx` (passa `usage` ao form; no `onSubmit` ~L209-215: se o setor estava ativo e `input.isActive === false`, abre `SectorInactivateDialog` e só grava ao confirmar; erro com `(await readApiErrorBody(error))?.code === 'sector.in_use'` (`readApiErrorBody` é `async`, `lib/api-error.ts:44`; o tratamento do erro é um `async` e espera o corpo) → mostra `SECTOR_IN_USE_409` e invalida a query do detalhe do setor; demais erros como hoje).

**Interfaces:** consome CJ3 (espelho tolerante), `sector.channel` (número da área, `internal-admin/schemas.ts:29`), `@/components/ui/alert-dialog`, `readApiErrorBody`. Produz CJ9 (parte do setor).

**Contexto vinculado:**
- E4: "a tela do setor (…) mostra 'Em uso', no molde do turno." "Textos do setor: 'N pessoa(s) ativa(s) neste setor', 'N exceção(ões) de escala de hoje em diante', 'N envio(s) agendado(s)'." "Com qualquer dependência: a opção 'Inativo' do setor (…) fica desligada, com 'Em uso: não pode ser inativado'; o que fazer no setor: trazer as pessoas para outro setor pela tela de pessoas do setor de destino, remover as exceções na Escala, cancelar ou aguardar os envios agendados." "Informação que não bloqueia: 'N pessoa(s) inativa(s) mantêm o vínculo'."
- E5: "Se a API devolver o 409 porque o uso surgiu depois de abrir a tela, aparece 'Este setor está em uso e não pode ser inativado.' (…), e as dependências são recarregadas."
- E6: "Setor sem uso: inativar pede confirmação: 'Inativar {setor}? Ele sai das listas de envio, escala e cadastro. O histórico é mantido.', com 'Cancelar' e 'Inativar setor'." "Número da área: não bloqueia. Se o setor tem número próprio da área, a confirmação acrescenta: 'O número da área continua ligado a este setor e nenhum envio sai por ele enquanto o setor estiver inativo. Para usar o número em outra área, desvincule-o antes.'" E7: renomear, trocar o gestor e reativar seguem livres.
- DJ14 inteiro (textos "Para liberar:"). GJ10. Molde visual: `features/shifts/in-use.ts` e `turnos/index.tsx:121,155-167`.
- GJ9: form, rota e schema são legados — só as trocas descritas; textos e diálogo em arquivo novo.

**Passos:**
1. [ ] RED puro (`sector-usage.spec.ts`): `it('linhas só com contagem > 0, nos textos da spec')`; `it('Para liberar: um passo por tipo com uso')`; `it('inactivePeopleLine só com N > 0')`; `it('inactivateSectorText com e sem número da área')`.
2. [ ] RED tela: `it('aceite 11: setor ativo em uso — Inativo desligado, Em uso: não pode ser inativado, contagens e o que fazer')`; `it('aceite 13: sem uso — Inativo, Salvar abre a confirmação com o nome; Cancelar não grava; Inativar setor grava')`; `it('aceite 13: com número da área — confirmação traz o aviso do número')`; `it('aceite 15: 409 sector.in_use — mensagem e nova chamada ao detalhe do setor')`; `it('aceite 17: renomear setor em uso — sem confirmação, grava')`; `it('setor inativo — reativar sem confirmação')`; `it('esquema aceita detalhe sem usage')`.
3. [ ] GREEN; `npx tsc -b`; eslint (GJ9); validação; `--changed`.

**Aceite:** 11, 13, 15 (tela do setor), 17 (tela). **Risco: médio.** Revisão `sonnet` (a recusa é do servidor, T3).

## Task 12 — Front: nível em uso, confirmação e 409

**Arquivos:** criar `frontend/src/features/levels/in-use.ts`, `components/level-deactivate-dialog.tsx`, specs `in-use.spec.ts`, `components/level-deactivate-dialog.spec.tsx`, `components/levels-table.in-use.spec.tsx`; modificar `features/levels/schemas.ts` (+ `activePeople`, `inactivePeople` `.nullish()`), `error-messages.ts` (~L7-12 + `'levels.in_use': LEVEL_IN_USE_409`), `components/levels-table.tsx` (linhas de uso na célula ~L45-47; em `rowActions` ~L100-106, "Desativar" com `disabled: busy || levelInUse(level)`; o `toggle` de desativar abre `LevelDeactivateDialog`; em `useLevelActions` ~L73-86, com `code === 'levels.in_use'` invalida a lista de níveis além do toast).

**Interfaces:** consome CJ4 (espelho tolerante), `describeLevelError` (`error-messages.ts:19`), `@/components/ui/alert-dialog`. Produz CJ9 (parte do nível).

**Contexto vinculado:**
- E4: "a lista de níveis mostra 'Em uso', no molde do turno." "Texto do nível: 'N pessoa(s) ativa(s) com este nível'." "Com qualquer dependência: (…) o botão 'Desativar' do nível fica desligado, com 'Em uso: não pode ser inativado'"; "o que fazer no nível: trocar o nível no cadastro das pessoas." "Informação que não bloqueia: 'N pessoa(s) inativa(s) mantêm o vínculo'."
- E5: "'Este nível está em uso e não pode ser desativado.', e as dependências são recarregadas." E6: "Nível sem uso: 'Desativar o nível {nome}? Ele sai do cadastro novo e do filtro de envio.', com 'Cancelar' e 'Desativar'."
- DJ14. GJ10. Estado de hoje: "Desativar"/"Reativar" sempre ativo (`levels-table.tsx:105`).
- GJ9: tabela, schema e mapa de erros são legados — só as trocas descritas.

**Passos:**
1. [ ] RED puro (`in-use.spec.ts`): `it('levelInUse com activePeople > 0; ausente não bloqueia')`; `it('linhas e o que fazer')`.
2. [ ] RED tela: `it('aceite 14: nível com pessoa ativa — Desativar desligado com Em uso e as linhas')`; `it('aceite 14: sem uso — Desativar abre a confirmação; Cancelar não grava; Desativar grava')`; `it('aceite 15: 409 levels.in_use — mensagem e nova chamada à lista')`; `it('Reativar sem confirmação')`; `it('mostra N pessoa(s) inativa(s) mantêm o vínculo')`.
3. [ ] GREEN; `npx tsc -b`; eslint (GJ9); validação; `--changed`.

**Aceite:** 14, 15 (tela do nível). **Risco: médio.** Revisão `sonnet`.

## Task 13 — Front: mensagens da reativação recusada

**Arquivos:** modificar `frontend/src/features/users/error-messages.ts` (~L3-17 + os dois códigos), `frontend/src/features/sector-people/error-messages.ts` (~L8-24 + os dois códigos); `features/users/components/user-status-flow.tsx` **só se** o erro da reativação não chegar à tela pelo caminho de hoje (registrar no report); criar `features/users/error-messages.reactivation.spec.ts`, `features/sector-people/error-messages.reactivation.spec.ts`, `features/users/components/user-status-flow.reactivation.spec.tsx`.

**Interfaces:** consome `describeUserError` (`users/error-messages.ts:19-21`), `describeSectorPeopleError`/`toastSectorPeopleError` (`sector-people/error-messages.ts:36-49`), `useSetUserStatus` (`user-status-flow.tsx:8,48`).

**Contexto vinculado:**
- E10 (mensagens exatas): "'O setor desta pessoa está inativo. Reative o setor ou troque o setor antes de reativar a pessoa.'" e "'O nível desta pessoa está desativado. Reative o nível ou troque o nível antes de reativar a pessoa.'" "Onde vale: na ficha da pessoa e na tela de pessoas do setor."
- Aceite 18: "Isso vale na ficha e na tela de pessoas do setor, e a tela mostra a mensagem." DJ15. GJ10 (`readApiErrorBody`).

**Passos:**
1. [ ] RED: `it('aceite 18: user.sector_inactive e user.level_inactive com os textos da spec (ficha)')`; `it('aceite 18: mesmos textos na tela de pessoas do setor')`; `it('aceite 18: reativar na ficha com 409 user.sector_inactive mostra a mensagem e não mostra o sucesso')`.
2. [ ] GREEN; `npx tsc -b`; eslint (GJ9); validação; `--changed`.

**Aceite:** 18 (tela). **Risco: baixo.** Revisão `sonnet`.

## Task 14 — Front: Novidades e rótulos da trilha

**Arquivos:** modificar `frontend/src/release-notes.ts` (entrada nova no topo de `RELEASE_NOTES`, ~L32-34), `frontend/src/features/audit-trail/labels.ts` (`FIELD_LABEL` ~L21-59 + `startTime: 'Início'`, `endTime: 'Término'`, `order: 'Ordem'`; `name: 'Nome'` já existe em `:22`); criar `frontend/src/release-notes.panorama.spec.ts`, `features/audit-trail/labels.structure.spec.ts`.

**Interfaces:** consome `ReleaseNote`/`ReleaseNoteItem` (`release-notes.ts:16-30`), `fieldLabel` (`labels.ts:151-153`). Produz CJ10.

**Contexto vinculado:**
- C2: "Uma entrada nova descreve o panorama, o bloqueio de setor e nível em uso, a confirmação ao inativar e a trilha de turno e nível." Despacho: também "a recusa de reativar pessoa em setor/nível inativo"; versão `2026.11.21.1`.
- frontend/CLAUDE.md: entrada nova sempre no TOPO, ordem decrescente por `version` (o topo hoje é `2026.11.20.3`); texto em PT-BR para o operador; sem nome ou telefone de exemplo.
- Itens (texto final do implementador, curto, no tom das entradas vizinhas): `/dashboard` — bloco "Operação da fábrica" com as contagens do dia por setor e turno, "Ver pessoas", "Ver escala" e "Enviar mensagem"; `/setores` — setor com pessoas ativas, exceções de hoje em diante ou envios agendados não é inativado, a tela mostra o que prende e o que fazer, e sem uso pede confirmação; `/niveis` — nível com pessoas ativas não é desativado, sem uso pede confirmação; `/trilha` — antes e depois das alterações de turno e nível, inclusive a ordem; `/users` — reativar pessoa com setor ou nível inativo é recusado até reativar ou trocar.
- E8: a trilha de turno e nível passa a ter os campos `name`, `startTime`, `endTime`, `isActive` e `order` (DJ12, DJ16).

**Passos:**
1. [ ] RED (`release-notes.panorama.spec.ts`): `it('aceite 10: entrada 2026.11.21.1 no topo, com itens em /dashboard, /setores, /niveis, /trilha e /users e as palavras Operação da fábrica, confirmação e reativar')`; `timeout 600 gate --test src/release-notes.spec.ts` verde.
2. [ ] RED (`labels.structure.spec.ts`): `it('aceite 16: fieldLabel de startTime, endTime e order')`.
3. [ ] GREEN; `npx tsc -b`; validação; `--changed`.

**Aceite:** 10, 16 (rótulos). **Risco: baixo.** Revisão `sonnet`.

---

## Fechamento (principal)

1. Conferir o ledger: 14 tasks aceitas; revisões conforme cada task; `tsc` do back conferido depois de cada onda (GJ7); os testes do Rastreio presentes e verdes.
2. Aceite 19: `grep -in "MSG-01b" reports/plano-gbr/dados.py` mostra, no campo `resumo` (~L311), o texto exato "Aguarda a GBR (C740)" (com maiúscula; o `status` continua `"novo"`, porque o enum não tem "aguarda", ~L48) e o texto "Recalcular o público na hora do envio: só se a GBR escolher; até lá vale o congelado com reconferência"; `git diff --stat feat/alerta-urgente` sem arquivo de agendamento (`team-whatsapp-schedule*`, reconferência).
3. Revisão final do conjunto com `opus` (diff inteiro do lote contra `feat/alerta-urgente`).
4. Gates completos, **um de cada vez**, nada mais rodando (sem stack de QA junto; memória "gate completo sozinho"): back com `NODE_OPTIONS=--max-old-space-size=6144`, depois front, `--base origin/main`, no estado final; comparar com a base do Lote I (`.superpowers/sdd/2026-11-20-orgamind-gbr-etapa4-lote-i-alerta/final-back-gate-full-r2-detail.log` e `final-front-gate-full-detail.log`) pelo script ancorado; bloquear violação nova ou agravada (lint, sonar, complexidade, duplicação); conferir `max-lines-per-function` 50 dos specs novos.
5. QA visual (agente `qa`, roteiro Node com `@playwright/test` do frontend, senha do seed lida no processo e nunca impressa, login 5/min) na stack `orgamind-turnos-qa` (web 5174, api 3002; sem worker nem Evolution), com dados fictícios semeados por SQL com prefixo `qa_j_` e a reversão anotada em `qa/qa-data.md`: três setores `qa_j_` (um com pessoa emprestada, um com turno inativo em uso, um vazio), exceção futura, um envio agendado pendente (sem disparo; o QA não tem provedor), um nível com pessoa ativa e outro só com inativa, uma pessoa inativa em setor inativo. Roteiro: ADMIN na Visão geral (título, subtítulo, aviso, cartões, "Outros turnos", "Ninguém na escala deste dia", trocar data, atalho da noite se o relógio permitir — senão anotar), "Ver pessoas" (rede: uma chamada ao roster; fechar e abrir sem nova), "Ver escala" e "Enviar mensagem" (setor e data na tela), "Mensagem para vários setores" (nenhum marcado; nenhuma prévia disparada sozinha); SUPERVISOR Rafael (só os setores dele; subtítulo dos seus); VIEWER (sem bloco; rede sem chamada ao panorama); setor em uso (Inativo desligado, contagens, o que fazer), setor sem uso com número (confirmação com o aviso), nível em uso e sem uso; reativar a pessoa no setor inativo (mensagem) pela ficha e pela tela de pessoas do setor; trilha com eventos de turno e nível (Início, Término, Ordem). Evidência visual por cenário.
6. Atualizar "Estado" deste plano; registrar na spec, em "Para a GBR confirmar" (linha do Lote J), as decisões que mudam o que a GBR vê (as de "Dúvidas de produto", abaixo).
7. Commits do lote (docs: spec + plano; back; front), push e PR **rascunho** sobre `feat/alerta-urgente` (C1: PR empilhado sobre o #21), com os avisos: "Vai para produção junto com os Lotes F–I (PRs #18–#21)"; "sem migração"; "o panorama mostra contagens do dia, não de agora"; "inativar setor ou nível em uso passa a ser recusado". **Sem merge, sem deploy.**

## Dúvidas de produto (decididas provisoriamente; para a GBR confirmar)

- **Sem telefone × sem autorização (DJ4):** quem está em serviço sem telefone conta só em "Sem telefone", não também em "Sem autorização de contato" (mesma ordem da prévia). Recomendação: manter.
- **Cartão vazio (DJ7/CJ7):** setor sem ninguém mostra só "Ninguém na escala deste dia" e as ações, sem as linhas zeradas. Recomendação: manter.
- **Cartão de setor acima de 2000 (DJ3):** mantém "Ver escala" e "Enviar mensagem"; só "Ver pessoas" some. Recomendação: manter.
- **"Ver escala" sem `equipe.enviar`:** aparece para todo remetente (só os botões de envio dependem da chave). Recomendação: manter.
- **Passos "Para liberar" (DJ14):** um por tipo de dependência, nos textos do plano. Recomendação: manter.
- **Ordem na trilha (DJ12):** a ordem antes e depois aparece como os nomes unidos por " > ". Recomendação: manter.
- **Turno (DJ12):** a conferência de uso do turno continua fora da transação, como hoje (spec: "O turno segue como está"); só a trilha entra na transação. Recomendação: manter.
- **Reativação com setor informado inativo (DJ13):** continua o erro de hoje ("O setor da pessoa está inativo. Escolha outro em Editar."), não o código novo; o novo vale para o setor ou o nível que a pessoa já tem. Recomendação: manter.
- **Desempenho do panorama acima de 2000 pessoas (DJ3):** a contagem passa a ser setor a setor, em série; com muitos setores o bloco demora mais. Recomendação: medir no QA e, se preciso, agrupar setores num lote seguinte.

## Não verificado (conferir na task dona)

(Conferidos na revisão 1 e movidos para a DJ dona: envio a pessoa sem linha de setor e `GET :id` sem serializador, DJ9; tabelas `Shift` e `StaffLevel` sem `@@map`, DJ11 e DJ12; `UserSummary`, `findActiveSector` e `findLevelForAssignment`, DJ13; "Data" do envio sem `min`/`max`, DJ8; `FIELD_LABEL` já com `name`, DJ16; filtro de categoria da trilha, T4 e T5.)

- Quais specs fixam a forma exata do `get` do setor (T3).
- Se algum spec ou consumidor lê o `metadata` antigo de `shift.*`/`level.*` (`{ actorId, shiftId }`) (T4, T5).
- Se `levelSelect` pode trazer as duas contagens filtradas por `_count` ou se precisa de `groupBy` (T5).
- Se o 409 da reativação chega à tela pela `PersonStatusDialog` com `describeUserError`, e por qual caminho a tela de pessoas do setor mostra o erro do `setStatus` (T13).
- Hook e chave da query do detalhe do setor e da lista de níveis no front, para a invalidação depois do 409 (T11, T12).
- Comportamento do `parseSearch` padrão do TanStack Router com id só de dígitos (viraria número; o `validateSearch` descarta) (T9, T10).
- Se o `QueryClient` global define `refetchOnWindowFocus`/`staleTime` que contrariem DJ6/DJ7 (as queries novas declaram as opções explicitamente) (T7, T8).
- Tempo de resposta do panorama com o alcance acima de 2000 e muitos setores (QA, Fechamento).
