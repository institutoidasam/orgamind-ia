# OrgaMind, Etapa 2 GBR, Lote D: exportar pessoas e escala (CAD-04). Implementation Plan

> **Para os agentes:** executar pela skill `sdd` (TDD, ledger em `.superpowers/sdd/2026-11-19-orgamind-gbr-etapa2-planilhas/progress-lote-d.md`). **Sem commit/push**: nenhuma task commita; a principal integra e commita o lote. Branch `feat/planilhas-pessoas`, criado a partir de `feat/vinculo-vigencia` (Lote C, commitado). Fechamento de task por `gate --changed --base feat/vinculo-vigencia`. Regras dos agentes: `.superpowers/sdd/2026-11-19-orgamind-gbr-etapa2-planilhas/implementer-rules.md` e `reviewer-rules.md` (copiadas na Preparação). Este plano cita arquivo e símbolo; as linhas dos mapas são pistas e podem ter mudado.

**Goal:** quem tem `pessoas.exportar` baixa a lista de pessoas (filtro por setor, turno, situação e data de referência) e a escala de um setor num período, em CSV ou XLSX, com telefone e nome mascarados conforme a regra do Lote B e cada exportação registrada na Trilha, na categoria nova Planilhas. O escritor de CSV, as regras de célula, os cabeçalhos das colunas de pessoas e a categoria Planilhas nascem prontos para o Lote E (importar).

**Architecture:** pasta nova `backend/src/shared/spreadsheet/` com o que é comum aos dois lotes (regras de célula, escritor de CSV em streaming, escritor de XLSX em streaming sobre `exceljs`, cabeçalhos de download, nome de arquivo, colunas de pessoas). Módulo novo `backend/src/modules/people-export/` com um controller (`GET /internal/people-export/people` e `/schedule`, chave `pessoas.exportar` na classe), um serviço de pessoas (índice leve ordenado em memória, limitado a 50.000 entradas, e leitura dos dados em blocos de 500) e um serviço de escala que reaproveita `StaffScheduleService.board`. A trilha é gravada por `AuditService.recordChange` dentro de `prisma.$transaction`, antes do primeiro header de download. Front: feature nova `frontend/src/features/people-export/` (diálogo e menu de exportação, download por blob), montada em Usuários, na página do setor e na Escala.

**Tech Stack:** NestJS + Prisma 6 + Zod v4 (`createZodDto`, `nestjs-zod`) + `exceljs` + `libphonenumber-js` + Vitest/testcontainers no back; React + TanStack Router/Query + ky 2 + Radix + Vitest/Testing Library no front. Sem dependência nova.

**Spec:** `docs/superpowers/specs/2026-11-19-orgamind-gbr-etapa2-planilhas.md` — seções "Comum aos dois lotes", "Lote D" (D1, D2, D3), Restrições, Anti-objetivos, aceites 1 a 10 e a parte de exportação do 22. O Lote E fica fora. Mapas em `.superpowers/sdd/2026-11-19-orgamind-gbr-etapa2-planilhas/fontes/`; pareceres `spec-review-1.md` e `spec-review-2.md` na mesma pasta.

## Estado (19/11/2026)

- **Concluído.** As 14 tasks (T1–T7, T8a, T8b, T9–T13) foram implementadas, revisadas e aceitas, e a varredura final de Minors também (limite de 20 exportações por minuto, DX21; trilha com data passada; filtros da aba Instruções; comentário de `CandidateFilter`). Revisão final do conjunto (opus): APPROVED, 0 Critical, 0 Important, 3 Minor (data vazia no diálogo vira hoje → backlog; ordem numa corrida rara entre as passadas → sem ação; aba antiga do front → nota de deploy).
- **Gates completos** (cada um sozinho na máquina) comparados com o fim do Lote C: backend LINT 7517/733, SONAR 92, COMPLEXIDADE 723, sem nada novo ou agravado (por arquivo e ancorado); TESTES 6305/6335 | 30 ignorados, 0 falhas; COVERAGE 94.4/85.8. Frontend LINT 105/4, SONAR 18, COMPLEXIDADE 228, sem nada novo; TESTES 2097/2097; COVERAGE 87.4/81.3.
- **QA local:** as duas migrações foram aplicadas (RolePermission 16 → 18, as duas negadas; enum com SPREADSHEET). Fumaça HTTP: 8/8 sem a chave e 44/44 com a chave concedida ao Supervisor (aceites 1–9 e casos M8). LibreOffice reabriu os XLSX. QA visual 5/5. Os dados de QA foram restaurados.
- **Pendências:** o aceite 10 (reimportar uma exportação sem alteração) fecha no Lote E. Ficam em backlog T1-m4, T2-m2/m3, T3 (comentários "16 células"), T4-m1/m2, T5-m2, T10-m1/m2, T12-m3/m4 e a revisão final M1/M2. Não foram medidos o tempo e a memória com 50.000 pessoas nem o 429 com Redis real.
- **Ledger:** `.superpowers/sdd/2026-11-19-orgamind-gbr-etapa2-lote-d-exportar/progress.md`. Próximo passo: commits, PR rascunho sobre `feat/vinculo-vigencia` e depois o plano do Lote E.

## Preparação (principal, antes da T1)

1. Conferir que o Lote C está commitado em `feat/vinculo-vigencia` e que `feat/planilhas-pessoas` parte dele (o `--changed` contra `feat/vinculo-vigencia` mediria o Lote C junto se não estiver).
2. Copiar `.superpowers/sdd/2026-11-19-orgamind-gbr-etapa1-lote-c-vinculo/implementer-rules.md` e `reviewer-rules.md` para `.superpowers/sdd/2026-11-19-orgamind-gbr-etapa2-planilhas/`, adaptando só o cabeçalho "Comuns a este plano": branch `feat/planilhas-pessoas`; base do `--changed` `feat/vinculo-vigencia`; plano e ledger deste lote; "as referências `DXn`, `GXn` e `CXn` do brief estão anexadas no fim dele"; manter as lições dos lotes anteriores (typecheck com `--tsBuildInfoFile /tmp/<task>.tsbuildinfo`; `prettier --write` só em arquivo novo).
3. Criar o ledger `progress-lote-d.md`.

## Ordem e paralelismo

```
Onda 1:  T1 (células e CSV)   T3 (chave back)   T4 (categoria)   T11 (catálogo front)
Onda 2:  T2 (XLSX e download) <- T1     T5 (contrato, erros, trilha) <- T4
         T6 (linhas e Instruções) <- T1  T12 (diálogo e menu, front) <- T11
Onda 3:  T7 (repositório) <- T6    T9 (escala) <- T2, T5    T13 (telas e Novidades) <- T12
Onda 4:  T8a (viewer, seleção, índice e limite) <- T5, T6, T7
Onda 5:  T8b (segunda passada, escrita, trilha, streaming) <- T2, T5, T6, T8a
Onda 6:  T10 (controller, módulo, rotas) <- T3, T8b (que já inclui a T8a), T9
```

- **T8a e T8b tocam o mesmo arquivo de serviço** (`people-export.service.ts`) e a mesma pasta de apoio de teste: por isso a T8b roda depois da T8a, em onda própria, nunca junto.

- **Ownership disjunto dentro de cada onda:**
  - T1: `shared/spreadsheet/{cell-rules,csv-writer,people-columns,file-name}.ts` e specs. T3: `shared/authz/permissions.ts`, a pasta da migração `20261119120000_people_export_permission`, specs de permissão do back, inclusive `sector-people/sector-people.repository.integration.spec.ts` (8 → 9 chaves do ADMIN). T4: `prisma/schema.prisma`, a pasta da migração `20261119120100_audit_category_spreadsheet`, `schemas/contracts/audit-trail.schema.ts` e specs. T11: `frontend/src/features/permissions/` e `frontend/src/features/audit-trail/{schemas,labels}.ts` e specs.
  - T2: `shared/spreadsheet/{xlsx-writer,spreadsheet-writer,download}.ts` e specs. T5: `schemas/contracts/people-export.schema.ts`, `people-export/{people-export.errors,export-trail}.ts` e specs. T6: `people-export/{people-rows,people-instructions}.ts` e specs. T12: `frontend/src/features/people-export/` (pasta nova).
  - T7: `people-export/people-export.repository.ts` e spec. T9: `people-export/{schedule-cells,schedule-export.service,sector-name.query}.ts`, specs e `staff-schedule/staff-schedule.module.ts` (só `exports`). T13: as três rotas do front, os três specs existentes delas (`users/index.spec.tsx`, `setores/$sectorId.spec.tsx`, `escala/index.spec.tsx`) e `release-notes.ts`.
  - T8a (onda 4): `people-export/people-export.service.ts` (cria), `people-export.service.spec.ts` (cria) e `people-export.service.fixtures.ts` (cria; repositório falso em memória e fábricas de ator e candidato). T8b (onda 5, depois da T8a): os mesmos três arquivos (modifica), mais `people-export.service.write.spec.ts` (cria). T10: `people-export/{people-export.controller,people-export.module}.ts`, `people-export/dto/`, `app.module.ts`, um `describe` novo em `permissions/route-parity.spec.ts`.
- **Gate conjunto:** com tasks paralelas no mesmo working tree, o `gate --changed` de cada uma mede também o diff das outras. Cada implementador fecha com o seu `--changed`; falha que vem só de arquivo de outra task em andamento vai para o report, sem correção. A principal roda o `--changed` conjunto (back e front) depois de cada onda.
- **Revisão** (SKILL.md do sdd, §Revisão por risco):
  - **Críticas, revisor `opus`:** T3 (autorização), T6 (autorização: decide telefone e nome por linha), T7 (autorização: filtra por alcance), T8a (autorização: alcance, viewer e regra de telefone e nome por linha), T8b (autorização e dado pessoal: trilha antes do envio e telefone na escrita), T9 (autorização: alcance e máscara pelo quadro), T10 (autorização: gate da rota e entrada de rota).
  - **Alto, revisor `sonnet`:** T1, T2, T4, T5.
  - **Médio:** T11, T12. **Baixo:** T13.

## Decisões deste plano (registradas para o ledger)

- **DX1. Onde fica o que o Lote E reaproveita:** `backend/src/shared/spreadsheet/` — `cell-rules.ts` (apóstrofo, telefone nacional, data), `csv-writer.ts`, `xlsx-writer.ts`, `spreadsheet-writer.ts` (escolhe o formato), `download.ts` (headers e erro de streaming), `file-name.ts` (redução do nome), `people-columns.ts` (cabeçalhos e rótulos das células de pessoas). A pasta não importa nada de `src/modules/` (só `node:stream`, `exceljs`, `libphonenumber-js`, `@nestjs/common` para `Logger`). O leitor de CSV/XLSX é do Lote E e entra nessa mesma pasta; `unguardFormula` (a volta do apóstrofo) nasce agora, junto com a regra, para a ida e a volta ficarem num arquivo só.
- **DX2. Colunas de pessoas numa constante só:** `PEOPLE_TEMPLATE_COLUMNS` (as 11 do modelo de importação) e `PEOPLE_EXPORT_COLUMNS` (as 11 + `situacao`, `tem_acesso`). O Lote E importa `PEOPLE_TEMPLATE_COLUMNS` e os rótulos `AUTHORIZATION_SOURCE_CELL` e `YES_NO_CELL` para ler de volta o que a exportação escreve.
- **DX3. Chave na classe, sem `@Roles`:** `PeopleExportController` leva só `@RequirePermission('pessoas.exportar')` na classe. Porquê: com a chave na classe e o handler sem `@Roles`, o `RolesGuard` não confere papel (`deferredToPermission`, `backend/src/modules/auth/roles.guard.ts`) e um `@Roles` na classe seria letra morta; o Lote B proíbe misturar os dois (`mixedRoutes`, `route-parity.spec.ts`). Os papéis saem da matriz: ADMIN sempre tem a chave, VIEWER nunca (`resolvePermissions` → `[]`), SUPERVISOR e OPERATOR conforme a tela de Permissões. O teste da T10 prova isso rota por rota. É o que a spec diz (item "Rotas" de "Comum aos dois lotes").
- **DX4. Consulta de pessoas em duas passadas:** (1) **índice** — lê candidatos em páginas de 1.000 por cursor de `id` (`id`, `name`, `hasAccess`, espelho do vínculo), resolve o vínculo da data, aplica filtro e alcance em memória e guarda uma entrada leve por pessoa (`PeopleIndexEntry`); para de ler e responde 422 assim que passar de 50.000 entradas; (2) **dados** — ordena o índice e lê os campos das células em blocos de 500 ids, escrevendo cada bloco no arquivo. Porquê: a ordem é pelo nome **como sai no arquivo** (máscara por linha), que o SQL não sabe calcular; carregar só o índice limita a memória a 50.000 entradas pequenas, e as linhas completas nunca ficam todas em memória (o VPS tem 8 GB sem swap). A contagem do limite é o tamanho do índice. A passada (1) é da T8a (`planPeopleExport`); a (2) é da T8b (`exportPeople`). **Corrida entre as duas passadas (regra):** na segunda passada os detalhes de cada bloco são mapeados por id (`detailsByIds` volta em ordem livre); id do índice que não voltou (pessoa apagada) é omitido, sem erro, e o arquivo segue íntegro (o `rowCount` da trilha é o do índice, registrado antes). Célula `nome` = `entry.displayName` quando o telefone sai completo; quando a segunda passada rebaixa o telefone (`entry.phoneFull` verdadeiro, mas ator não ADMIN e `detail.hasAccess`), `nome` = `nameView(entry.displayName, { full: false })`; a posição da linha continua a do índice (assim o nome que é o próprio telefone não sai completo quando o telefone foi rebaixado). Telefone completo só se `entry.phoneFull` **e** (`viewer.isAdmin` ou `!detail.hasAccess`): pessoa que ganhou login entre as passadas sai mascarada para o gestor.
- **DX5. Filtro no SQL e de novo em memória:** com data ≥ hoje o SQL já filtra setor, turno e alcance pelo espelho; com data passada o SQL filtra só situação e cadastro (`createdAt` antes do fim do dia da data, em Manaus) e o vínculo é resolvido por `assignmentOn` (`backend/src/modules/users/assignment-timeline.ts`) com as linhas que cobrem a data. Em qualquer caso a função pura da T6 confere de novo setor, turno e alcance da linha; o SQL é só redução. Linhas de vínculo só são consultadas quando a data é anterior a hoje.
- **DX6. Regra de telefone e nome por linha** (mesma da lista do setor, `shownPersonName` e `phoneHidden` em `sector-people.repository.ts`, mais a de data passada): `phoneFull = viewer.fullPhone && (viewer.isAdmin || (!row.hasAccess && viewer.reach.includes(row.sectorId do espelho)))`. Telefone: sem telefone → vazio; `phoneFull` → `formatPhoneCell`; senão `phoneView(e164, { full: false }).phoneMasked`. Nome: `nameView(name ?? '', { full: phoneFull })`; nome nulo sai vazio e o e-mail da pessoa nunca sai no arquivo (o quadro usa `name ?? email`, `board.ts`; a exportação não). O alcance usa o espelho (setor de **hoje**), então quem saiu do setor depois da data sai mascarado.
- **DX7. Ordem das linhas:** nome do setor do vínculo da data (`Intl.Collator('pt-BR')`), pessoas sem setor por último; depois o nome exibido (mesmo collator); depois `id` (comparação de string). Escala: a ordem do quadro.
- **DX8. Sem resultado:** arquivo com só o cabeçalho (e a aba Instruções no XLSX); a trilha registra `rowCount: 0`.
- **DX9. Erros e ordem da operação:** permissão (guard) → ator e alcance (403/404) → índice e limite (422) → trilha (`recordChange` em `prisma.$transaction`; erro propaga, 500) → `setDownloadHeaders` → bytes. Nada de header de download nem byte antes da trilha. Erro depois dos headers: `failDownload` (DX10).
- **DX10. Streaming e falha no meio:** mesmo idioma do export de contatos (`contacts-export.service.ts`, que **não muda**): headers já enviados → log com mensagem fixa (sem query nem telefone) e `sink.destroy()`; ainda não enviados → `removeHeader('Content-Disposition')` e relança. O CSV respeita backpressure (espera `drain`).
- **DX11. Nome do arquivo e CORS:** `pessoas-AAAA-MM-DD.<fmt>` com `todayIn(new Date())` (não a data UTC, diferente do export de contatos); `escala-<slug>-<from>-a-<to>.<fmt>`. Em produção a API é da mesma origem (`VITE_API_URL=/api`, `frontend/Dockerfile`, `docker-compose.prod.yml`) e o header já é legível; só no desenvolvimento a API é de outra origem, e lá o navegador só deixa o front ler `Content-Disposition` se a resposta trouxer `Access-Control-Expose-Headers: Content-Disposition` (o `enableCors` de `main.ts` não declara `exposedHeaders` e não sobrescreve o header gravado no handler). Por isso `setDownloadHeaders` grava o header, mantido por ser inofensivo em produção. O front lê o nome do `Content-Disposition`, com `pessoas.<fmt>` / `escala.<fmt>` como reserva montada no front se o header não vier.
- **DX12. Setor e turno do filtro:** setor pedido fora do alcance (inclusive inexistente) por quem não é ADMIN → 403 `export.out_of_reach`; ADMIN com setor inexistente → 404 `export.sector_not_found`; turno inexistente → 404 `export.shift_not_found` (turnos não têm alcance). Setor e turno inativos são aceitos (exportação de data passada). Gestor sem setor → 403 `export.out_of_reach`.
- **DX13. Trilha:** `entity: 'Spreadsheet'`; `entityId` nulo (pessoas) ou o id do setor (escala); `subjectUserId` nulo (não aparece no Histórico de nenhuma pessoa); `reason` nulo; `metadata` ausente; `changes` com `before: null` e os campos de CX3. Valores guardados como dado (datas `AAAA-MM-DD`, códigos `active|inactive|all`, `full|masked|partial`); o front traduz (T11). "Todos" vai como texto (`'Todos os setores'`, `'Todos os turnos'`), setor e turno escolhidos como `{ id, name }`.
- **DX14. Escala:** reaproveita `StaffScheduleService.board(actorId, { sectorId, from, to })` (permissão de ver o quadro, alcance, período de até 42 dias, máscara do nome, `truncated`); `StaffScheduleModule` passa a exportar `StaffScheduleService`. `truncated` → 422. Textos das células por `scheduleCellLabel` no back, cópia fiel de `cellLabel` (`frontend/src/features/staff-schedule/board-cells.ts`), com os mesmos casos de teste. O nome do setor para o arquivo e a trilha vem de `findSectorName(prisma, id)` (o `sectors` do quadro só traz os setores citados nas linhas).
- **DX15. XLSX sem fórmula e sem apóstrofo:** toda célula é escrita como string (`exceljs` grava string como texto, nunca como fórmula); o apóstrofo é só do CSV (aceite 9: "apóstrofo no CSV e como texto no XLSX").
- **DX16. Formato padrão do diálogo:** XLSX (abre direto no Excel e traz a aba Instruções); situação padrão Ativas; data padrão `today` do `GET internal/staff-schedule/options`.
- **DX17. Aceite 10 em duas partes:** este lote garante a ida (colunas e cabeçalhos do modelo, regras de célula reversíveis por `unguardFormula`, telefone nacional, aviso na aba Instruções); a volta ("Sem alteração" em todas as linhas) só se prova no Lote E, que deve ter um teste com um arquivo gerado pela T8b.
- **DX18. Novidades:** entrada nova no topo de `RELEASE_NOTES`, versão `2026.11.19.3` se implementada hoje (a mais recente é `2026.11.19.2`); em outro dia, `AAAA.MM.DD` do dia.
- **DX19. Apóstrofo nos dois sentidos com `/^'*[=+\-@\t\r]/`:** amplia a letra da spec para texto que já começa por apóstrofo(s) seguido(s) de gatilho, para a volta ser exata (`unguardFormula(guardFormula(s)) === s`). `unguardFormula` só se aplica a célula de **CSV**; célula de XLSX é lida crua, porque a exportação não protege célula no XLSX (DX15). A spec foi ajustada no mesmo sentido.
- **DX20. Nome que é e-mail sai vazio na escala (decisão da coordenação durante a T9):** o quadro mostra o e-mail quando a pessoa não tem nome; `scheduleFixedCells` grava `''` na coluna nome quando `row.name` contém `@`, para o arquivo não levar e-mail. Registrado na spec em "Para a GBR confirmar".
- **DX21. Limite próprio de 20 exportações por minuto por usuário (decisão da coordenação após a revisão da T10):** `@Throttle({ default: { ttl: 60_000, limit: 20 } })` na classe `PeopleExportController` (vale para cada uma das duas rotas, com contador próprio por rota e por usuário), no lugar do global de 100/min. Porquê: até 50.000 linhas por exportação num servidor de 2 vCPU/8 GB sem swap. Aplicado na varredura final de Minors; registrado na spec.

## Global Constraints

- **GX1. Sem dependência nova:** XLSX com `exceljs`, telefone com `libphonenumber-js`, CSV por código próprio. Nenhum `package.json` muda.
- **GX2. Contatos intocados:** `contacts-export.service.ts`, `contacts.controller.ts`, `/imports` e o front de contatos não mudam (spec, Não objetivos).
- **GX3. Ordem da operação (spec D1):** conferir permissão e alcance → contar → conferir o limite → registrar na trilha → enviar o arquivo. Se o registro falhar, a rota responde erro e não há arquivo; exportação recusada não baixa nada (nenhum `Content-Disposition`, nenhum byte).
- **GX4. Telefone e nome (conselho R2, Lote B):** telefone completo quando o ator tem `telefone.ver_completo` **e** (é ADMIN ou a pessoa não tem login); senão mascarado (`•••• 2008`); sem telefone, vazio. Para quem não é ADMIN, pessoa que hoje está fora do alcance sai mascarada mesmo com a chave. O nome que é o próprio telefone sai mascarado para quem não vê aquele telefone completo (DX6).
- **GX5. Alcance (conselho R2):** ADMIN exporta todas as pessoas, inclusive sem setor. Quem não é ADMIN exporta só pessoas cujo setor, na data de referência, está no seu alcance (`managedSectorIds`, só setores ativos); setor fora do alcance → 403; quem não gerencia setor → 403. Pessoa cadastrada depois da data de referência não entra.
- **GX6. Hoje:** sempre `todayIn` (America/Manaus, `backend/src/modules/staff-schedule/civil-date.ts`), calculado uma vez por exportação; testes fixam o relógio com `vi.useFakeTimers({ toFake: ['Date'] })` + `vi.setSystemTime`.
- **GX7. Formato do CSV (spec, Comum):** UTF-8 com BOM, separador `;`, fim de linha CRLF; campo entre aspas quando contém `;`, aspas, `\r` ou `\n`, com aspas dobradas; texto que começa por `=`, `+`, `-`, `@`, tabulação ou retorno de carro ganha apóstrofo na frente, e o que já começa por apóstrofo(s) seguido(s) de um desses gatilhos (`'=x`) também (para a volta devolver o texto original); telefone nacional `(92) 99111-2008`, estrangeiro internacional `+1 415 555 2671` (ganha o apóstrofo no CSV); data `DD/MM/AAAA`. XLSX: toda célula como texto, sem fórmula (DX15).
- **GX8. Trilha (spec, Comum):** categoria `SPREADSHEET` passada explicitamente; gravada por `recordChange` dentro de transação, com `actorId` explícito (quem exportou); o que a tela mostra vai em `changes` com "antes" vazio, porque a Trilha não mostra `metadata`; nenhum dado pessoal no registro (nem nome, nem telefone, nem id de pessoa).
- **GX9. Só leitura:** a exportação não grava pessoa nem vínculo (nenhum `prisma.user.*` de escrita, nenhuma escrita em `userAssignment`); a única escrita é o evento da trilha.
- **GX10. Migrações:** só aditivas, SQL escrito à mão no padrão de `backend/prisma/migrations/20261119100000_role_permissions/` e `20261119110000_user_assignment_history/`; nunca `prisma migrate dev` nem `reset`; banco só o do testcontainer do próprio teste.
- **GX11. Testes e tamanho:** TDD (RED antes do GREEN). Funções novas e callbacks de `describe`/`it` de até 50 linhas, complexidade ciclomática até 10, cognitiva até 15, profundidade até 4, até 4 parâmetros (use objeto de entrada); `describe` novos irmãos, sem aumentar bloco existente. Conferir com `npx eslint <arquivos tocados> --rule '{"max-lines-per-function": ["error", 50], "max-params": ["error", 4], "complexity": ["error", 10], "max-depth": ["error", 4]}'`.
- **GX12. Validação:** cwd `backend/` ou `frontend/`, caminhos relativos ao pacote. Loop: `timeout 600 gate --test src/<arquivo>`, um arquivo por chamada; integração `TESTCONTAINERS_ENABLED=1 timeout 600 gate --test src/<arquivo>`. Tipos: back `npx tsc --noEmit -p tsconfig.build.json --tsBuildInfoFile /tmp/<task>.tsbuildinfo`; front `npx tsc -b`. Fechamento: back `TESTCONTAINERS_ENABLED=1 timeout 600 gate --changed --base feat/vinculo-vigencia`; front `timeout 600 gate --changed --base feat/vinculo-vigencia`. Nunca suíte inteira, gate completo, coverage ou e2e (são da principal).
- **GX13. Arquivos legados:** nunca `prettier --write` em arquivo que já existia (só em arquivo novo); nunca restaurar arquivo do git (`checkout`, `restore`, `stash`, `show >`); errou, corrige para a frente. Pastas untracked alheias (`.playwright-mcp/`, `reports/`, `research_notes/`, `tutoriais/`) não se tocam.
- **GX14. Compila entre tasks:** assinatura existente só ganha campo opcional, salvo onde a task diz o contrário e ajusta chamadores e specs no próprio ownership.
- **GX15. Textos:** pt-BR, para quem opera, exatamente os deste plano e da spec D3.
- **GX16. Sem commit** pelos agentes.
- **GX17. Reuso pelo Lote E:** nada em `shared/spreadsheet/` conhece pessoas além de `people-columns.ts`; nada ali importa de `src/modules/`.

## Contratos compartilhados

**CX1. Rotas (T10; serviços T8a/T8b e T9; front T12).**

```ts
// backend/src/schemas/contracts/people-export.schema.ts (T5)
export const spreadsheetFormatSchema = z.enum(['csv', 'xlsx']);
const optionalId = z.string().trim().optional().transform((v) => (v ? v : undefined)); // `sectorId=` vale "todos"
export const peopleExportQuerySchema = z.object({
  format: spreadsheetFormatSchema,
  sectorId: optionalId,
  shiftId: optionalId,
  status: z.enum(['active', 'inactive', 'all']).default('active'),
  date: civilDateSchema.optional(),            // ausente = todayIn
});
export const scheduleExportQuerySchema = z.object({
  format: spreadsheetFormatSchema,
  sectorId: z.string().min(1),
  from: civilDateSchema,
  to: civilDateSchema,
});
export type SpreadsheetFormatParam = z.infer<typeof spreadsheetFormatSchema>;
export type PeopleExportQuery = z.infer<typeof peopleExportQuerySchema>;
export type ScheduleExportQuery = z.infer<typeof scheduleExportQuerySchema>;
export const PEOPLE_EXPORT_ROW_CAP = 50_000;
```

| Rota | Sucesso | Erros |
|---|---|---|
| `GET /internal/people-export/people` | 200, corpo = arquivo | 400 (query, pipe Zod global); 403 `auth.permission_denied` ("Você não tem permissão para exportar pessoas e escala."); 403 `export.out_of_reach`; 404 `export.sector_not_found` / `export.shift_not_found`; 422 `export.too_large` ("Há pessoas demais para um arquivo só. Filtre por setor ou turno.") |
| `GET /internal/people-export/schedule` | 200, corpo = arquivo | 400; 403 `auth.permission_denied`; 403 do quadro (o mesmo `scheduleForbidden` de `StaffScheduleService`); 422 `staff_schedule.invalid_period`; 422 `export.too_large` ("Há pessoas demais neste setor para um arquivo só.") |

Headers do 200 (`setDownloadHeaders`, T2): `Content-Type` `text/csv; charset=utf-8` ou `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`; `Content-Disposition: attachment; filename="<nome>"`; `X-Content-Type-Options: nosniff`; `Cache-Control: no-store`; `Access-Control-Expose-Headers: Content-Disposition`.

**CX2. Erros (T5), `backend/src/modules/people-export/people-export.errors.ts`.** Todos `new DomainError({ code, status, message, detail })` (mesmo molde de `permissionDenied`, `backend/src/shared/authz/permissions.ts`; o texto para a tela vai em `detail`):

| Função | code / status | message | detail |
|---|---|---|---|
| `peopleTooLarge()` | `export.too_large` / 422 | `Exportação grande demais` | `Há pessoas demais para um arquivo só. Filtre por setor ou turno.` |
| `scheduleTooLarge()` | `export.too_large` / 422 | `Exportação grande demais` | `Há pessoas demais neste setor para um arquivo só.` |
| `sectorOutOfReach()` | `export.out_of_reach` / 403 | `Ação não permitida` | `Você só pode exportar pessoas dos setores que gerencia.` |
| `noManagedSector()` | `export.out_of_reach` / 403 | `Ação não permitida` | `Você não gerencia nenhum setor.` |
| `exportSectorNotFound()` | `export.sector_not_found` / 404 | `Setor não encontrado` | `Setor não encontrado.` |
| `exportShiftNotFound()` | `export.shift_not_found` / 404 | `Turno não encontrado` | `Turno não encontrado.` |

**CX3. Registro na trilha (T5), `backend/src/modules/people-export/export-trail.ts`.**

```ts
import type { AuditChange, AuditRef } from '../../shared/audit/audit-change';
export type PhoneVisibility = 'full' | 'masked' | 'partial';
export function peopleExportChange(input: {
  actorId: string; format: 'csv' | 'xlsx'; sector: AuditRef | null; shift: AuditRef | null;
  status: 'active' | 'inactive' | 'all'; date: CivilDate; rowCount: number; phoneVisibility: PhoneVisibility;
}): AuditChange;
  // action 'people.export', entity 'Spreadsheet', entityId null, category 'SPREADSHEET', subjectUserId null, reason null
  // changes (before null), nesta ordem: format 'CSV'|'XLSX'; sector AuditRef | 'Todos os setores';
  // shift AuditRef | 'Todos os turnos'; statusFilter 'active'|'inactive'|'all'; referenceDate 'AAAA-MM-DD';
  // rowCount número; phoneVisibility 'full'|'masked'|'partial'
export function scheduleExportChange(input: {
  actorId: string; format: 'csv' | 'xlsx'; sector: AuditRef; from: CivilDate; to: CivilDate; rowCount: number;
}): AuditChange;
  // action 'schedule.export', entity 'Spreadsheet', entityId sector.id, category 'SPREADSHEET'
  // changes (before null): format; sector AuditRef; periodFrom; periodTo; rowCount
export function phoneVisibilityOf(viewer: { isAdmin: boolean; fullPhone: boolean }): PhoneVisibility;
  // !fullPhone → 'masked'; isAdmin → 'full'; senão 'partial'
```

**CX4. Planilha comum (T1, T2), `backend/src/shared/spreadsheet/`.**

```ts
// cell-rules.ts (T1)
export const FORMULA_TRIGGERS: readonly string[];          // ['=', '+', '-', '@', '\t', '\r']
export function guardFormula(text: string): string;         // apóstrofo na frente se casa /^'*[=+\-@\t\r]/ (gatilho, ou apóstrofo(s) + gatilho)
export function unguardFormula(text: string): string;       // tira UM apóstrofo da frente só quando o resto casa /^'*[=+\-@\t\r]/; unguardFormula(guardFormula(s)) === s para todo s
export function formatPhoneCell(phoneE164: string): string; // BR → formatNational(); outro país → formatInternational(); inválido → o próprio texto
export function formatDateCell(civilDate: string): string;  // 'AAAA-MM-DD' → 'DD/MM/AAAA'
export const YES_NO_CELL: { readonly yes: 'Sim'; readonly no: 'Não' };
export function yesNo(value: boolean): 'Sim' | 'Não';
// csv-writer.ts (T1)
export const CSV_BOM = '﻿'; export const CSV_SEPARATOR = ';'; export const CSV_EOL = '\r\n';
export function csvField(value: string): string;           // guardFormula e depois aspas (GX7)
export function csvRow(cells: readonly string[]): string;  // campos por csvField, unidos por ';', + CRLF
export class CsvStreamWriter {
  constructor(sink: Writable);
  writeRow(cells: readonly string[]): Promise<void>;       // BOM antes da primeira linha; espera 'drain'
  close(): Promise<void>;                                  // BOM se nada foi escrito; sink.end()
}
// people-columns.ts (T1)
export const PEOPLE_TEMPLATE_COLUMNS: readonly ['matricula','nome','telefone','funcao','setor','turno','nivel',
  'autorizacao_contato','origem_autorizacao','detalhe_origem','data_autorizacao'];
export const PEOPLE_EXPORT_COLUMNS: readonly [...PEOPLE_TEMPLATE_COLUMNS, 'situacao', 'tem_acesso'];
export type PeopleColumn = (typeof PEOPLE_EXPORT_COLUMNS)[number];
export const PEOPLE_COLUMN_MEANING: Readonly<Record<PeopleColumn, string>>;    // textos de T6/CX6
export type AuthorizationSourceCode = 'TERMO_ASSINADO' | 'FICHA_ADMISSAO' | 'ACEITE_WHATSAPP' | 'OUTRO' | 'CADASTRO_ANTERIOR';
export const AUTHORIZATION_SOURCE_CELL: Readonly<Record<AuthorizationSourceCode, string>>;
  // 'Termo assinado', 'Ficha de admissão', 'Aceite por WhatsApp', 'Outro', 'Cadastro anterior'
export const PERSON_STATUS_CELL: { readonly active: 'Ativa'; readonly inactive: 'Inativa' };
// file-name.ts (T1)
export function fileSlug(text: string): string;  // NFD sem diacríticos, minúsculas, tudo fora de [a-z0-9] vira '-', sem '-' repetido nem nas pontas; vazio → 'setor'
// xlsx-writer.ts (T2)
export class XlsxStreamWriter {
  constructor(sink: Writable);                      // WorkbookWriter { stream: sink, useStyles: false, useSharedStrings: false }
  startSheet(name: string): void;                   // fecha (commit) a aba anterior, se houver
  writeRow(cells: readonly string[]): Promise<void>;// addRow(strings).commit()
  close(): Promise<void>;                           // commit da aba e do workbook
}
// spreadsheet-writer.ts (T2)
export type SpreadsheetFormat = 'csv' | 'xlsx';
export interface SpreadsheetWriter {
  writeRow(cells: readonly string[]): Promise<void>;
  startSheet(name: string): void;                   // CSV: lança Error('CSV tem uma aba só')
  close(): Promise<void>;
}
export function openSpreadsheet(input: { sink: Writable; format: SpreadsheetFormat; firstSheet: string }): SpreadsheetWriter;
// download.ts (T2)
export type DownloadSink = Writable & { setHeader(name: string, value: string): void; removeHeader(name: string): void; headersSent: boolean };
export const SPREADSHEET_CONTENT_TYPE: Readonly<Record<SpreadsheetFormat, string>>;
export function setDownloadHeaders(sink: DownloadSink, input: { format: SpreadsheetFormat; fileName: string }): void;
export function failDownload(input: { sink: DownloadSink; error: unknown; logger: Logger; route: string }): void;
  // headersSent → logger.error(`stream de exportação abortado após headers (rota ${route})`, stack) e sink.destroy(); senão removeHeader('Content-Disposition') e relança error
```

**CX5. Linhas de pessoas (T6, consumidas por T7, T8a e T8b), `backend/src/modules/people-export/people-rows.ts`.**

```ts
import type { AssignmentLine, AssignmentValues } from '../users/assignment-timeline';
export type PeopleCandidateRow = { id: string; name: string | null; hasAccess: boolean } & AssignmentValues; // vínculo = espelho
export type PeopleDetailRow = {
  id: string; registration: string | null; name: string | null; phoneE164: string | null; jobTitle: string | null;
  contactAuthorization: 'AUTORIZADO' | 'NAO_AUTORIZADO'; authorizationSource: AuthorizationSourceCode | null;
  authorizationNote: string | null; authorizationDate: CivilDate | null; isActive: boolean; hasAccess: boolean;
};
export type ExportNameMaps = { sectors: ReadonlyMap<string, string>; shifts: ReadonlyMap<string, string>; levels: ReadonlyMap<string, string> };
export type ExportViewer = { isAdmin: boolean; fullPhone: boolean; reach: readonly string[] | null }; // reach null = ADMIN
export type PeopleSelection = { sectorIds: readonly string[] | null; shiftId: string | null; date: CivilDate; today: CivilDate };
export type PeopleIndexEntry = { id: string; sectorName: string | null; displayName: string; phoneFull: boolean; assignment: AssignmentValues };
export function selectIndexEntry(input: {
  row: PeopleCandidateRow; lines: readonly AssignmentLine[]; selection: PeopleSelection; viewer: ExportViewer; names: ExportNameMaps;
}): PeopleIndexEntry | null;  // null = fora do filtro ou do alcance; vínculo por assignmentOn; DX6
export function comparePeopleEntries(a: PeopleIndexEntry, b: PeopleIndexEntry): number; // DX7
export function peopleCells(input: { detail: PeopleDetailRow; entry: PeopleIndexEntry; names: ExportNameMaps; viewer: ExportViewer }): string[];
  // 13 textos crus (sem apóstrofo) na ordem de PEOPLE_EXPORT_COLUMNS.
  // Regra da segunda passada (DX4): célula `nome` = entry.displayName quando o telefone sai completo; se a segunda passada rebaixa o telefone, nome = nameView(entry.displayName, { full: false }); telefone completo só se entry.phoneFull
  // e (viewer.isAdmin ou !detail.hasAccess), senão mascarado; sem telefone, vazio. `detail` nunca é indefinido
  // (quem chama omite o id que sumiu).
```

**CX6. Instruções (T6), `backend/src/modules/people-export/people-instructions.ts`.**

```ts
export function peopleInstructionRows(input: {
  exportedAt: Date; sectorLabel: string; shiftLabel: string; status: 'active' | 'inactive' | 'all';
  date: CivilDate; phoneVisibility: PhoneVisibility;
}): string[][];
```
Linhas, nesta ordem (coluna A, coluna B): `Exportado em` / `DD/MM/AAAA HH:MM` (America/Manaus); `Setor` / nome ou `Todos os setores`; `Turno` / nome ou `Todos os turnos`; `Situação` / `Ativas` | `Inativas` | `Todas`; `Data de referência` / `DD/MM/AAAA`; `Telefone` / `Completo` | `Mascarado (só os 4 últimos dígitos)` | `Completo só de pessoas sem acesso ao sistema que estão hoje nos setores que você gerencia; mascarado nas demais`; `Atenção` / `Setor, turno e nível são os que valiam na data de referência. Telefone, função, autorização de contato, situação e acesso são sempre os de hoje.`; `Atenção` / `Para atualizar pessoas pela importação, use uma exportação com data de referência de hoje. Não envie de volta um arquivo exportado com data passada: setor, turno e nível voltariam aos daquele dia.`; linha vazia; `Coluna` / `Significado`; uma linha por coluna de `PEOPLE_EXPORT_COLUMNS` com `PEOPLE_COLUMN_MEANING`:

| Coluna | Significado |
|---|---|
| `matricula` | Matrícula da pessoa na empresa. |
| `nome` | Nome da pessoa. Quando o nome é o próprio telefone e o telefone está mascarado, o nome também sai mascarado. |
| `telefone` | Telefone no formato (92) 99111-2008; número de fora do Brasil sai no formato internacional. Mascarado (•••• 2008) para quem não pode vê-lo completo. |
| `funcao` | Função da pessoa. |
| `setor` | Setor na data de referência. |
| `turno` | Turno habitual na data de referência. |
| `nivel` | Nível na data de referência. |
| `autorizacao_contato` | Sim quando a pessoa autorizou receber mensagens; Não quando não. |
| `origem_autorizacao` | De onde veio a autorização: Termo assinado, Ficha de admissão, Aceite por WhatsApp, Outro ou Cadastro anterior. |
| `detalhe_origem` | Detalhe da origem, quando ela é Outro. |
| `data_autorizacao` | Data da autorização (DD/MM/AAAA). |
| `situacao` | Ativa ou Inativa. |
| `tem_acesso` | Sim quando a pessoa entra no sistema com login. |

**CX7. Front (T12), `frontend/src/features/people-export/`.**

```ts
// api.ts
export type ExportFormat = 'csv' | 'xlsx';
export type PeopleExportParams = { format: ExportFormat; sectorId?: string; shiftId?: string; status: 'active' | 'inactive' | 'all'; date: string };
export type ScheduleExportParams = { format: ExportFormat; sectorId: string; from: string; to: string };
export function useExportPeople(): UseMutationResult<void, unknown, PeopleExportParams>;     // GET internal/people-export/people, timeout 120_000, blob → saveBlob
export function useExportSchedule(): UseMutationResult<void, unknown, ScheduleExportParams>; // GET internal/people-export/schedule
// download.ts
export function filenameFromDisposition(header: string | null, fallback: string): string;
export function saveBlob(blob: Blob, filename: string): void;  // createObjectURL → <a download> → click → revoke (padrão de contacts.tsx onExport)
// components/export-people-button.tsx
export function ExportPeopleButton(props: { defaultSectorId?: string }): JSX.Element | null; // null sem pessoas.exportar
// components/export-people-dialog.tsx
export function ExportPeopleDialog(props: { open: boolean; onOpenChange(open: boolean): void; defaultSectorId?: string }): JSX.Element;
// components/export-schedule-menu.tsx
export function ExportScheduleMenu(props: { sectorId: string; from: string; to: string }): JSX.Element | null; // null sem a chave
```
Parâmetros indefinidos não vão na query string.

## Review Focus

As cinco entradas que a spec implica e nenhum teste de task cobriria por acaso, cada uma presa a um teste:

1. **Fórmula e caracteres especiais na mesma célula:** nome `=HYPERLINK("http://x";"y")` e função `Aux; "chefe"\nnoite` saem no CSV como `"'=HYPERLINK(""http://x"";""y"")"` e `"Aux; ""chefe""` + LF + `noite"`, sem quebrar a linha CRLF; no XLSX as duas células são do tipo string, sem fórmula; telefone estrangeiro `+1 415 555 2671` sai `'+1 415 555 2671` no CSV e `+1 415 555 2671` no XLSX. Testes: T1, `it('csvField: gatilho de fórmula ganha apóstrofo antes das aspas; ; aspas e quebras vão entre aspas')`; T8b, `it('nome com fórmula e função com ; aspas e quebra de linha: CSV com apóstrofo e aspas, XLSX como texto')`.
2. **Data de referência no passado:** (a) pessoa movida de A para B depois da data sai em A; (b) pessoa criada depois da data não entra; (c) data anterior ao início do histórico usa a linha migrada (início em branco); (d) gestor de A com `telefone.ver_completo`, pessoa sem login que estava em A e hoje está em C: entra no arquivo de A com telefone e nome mascarados. Testes: T6, `it('data passada: vínculo da linha que cobre a data; quem hoje está fora do alcance sai mascarado')`; T7, `it('linesOn devolve a linha de início em branco para data anterior ao histórico e respeita os limites inclusivos')` e `it('pageCandidates exclui quem foi cadastrado depois do fim do dia da data em Manaus')`; T8a, `it('aceite 6: data passada mostra o setor daquele dia')`.
3. **Gestor com a chave pedindo setor alheio:** setor de outro gestor, setor inexistente e gestor sem setor → 403 `export.out_of_reach` com o mesmo corpo para inexistente e alheio; ADMIN com setor inexistente → 404; nenhum evento na trilha e nenhum header de download. Escala: gestor pedindo o quadro de setor alheio → 403 do quadro, sem trilha. Testes: T8a, `it('gestor: setor alheio e setor inexistente dão o mesmo 403, lança antes de ler detailsByIds')` (a T8a prova que o plano lança antes de qualquer escrita; a T8b prova, no `exportPeople`, que o erro sobe sem trilha nem header); T9, `it('quadro recusado não grava trilha nem header')`.
4. **Falha ao registrar na trilha e limite:** `recordChange` que lança → o serviço rejeita, sem `Content-Disposition`, sem byte no sink; 50.001 pessoas → 422 sem trilha, e a leitura de candidatos para na página que passa do limite; quadro com `truncated` → 422 sem trilha. Testes: T8b, `it('trilha que falha: erro sobe, nenhum header de download nem byte')`; T8a, `it('acima de 50.000 responde 422, lança antes de ler detailsByIds e para de ler')`; T9, `it('quadro cortado responde 422 sem trilha')`.
5. **Nome de setor com acento, barra e símbolos no nome do arquivo:** `Manutenção / Elétrica (2º)` → `escala-manutencao-eletrica-2o-2026-11-01-a-2026-11-30.csv`; nome só de símbolos → `escala-setor-…`; `Content-Disposition` só com ASCII. Testes: T1, `it('fileSlug: tira acento, barra e símbolos; vazio vira setor')`; T9, `it('nome do arquivo usa o setor reduzido e o período')`.

Também conferir na revisão: pessoa sem telefone e sem setor no arquivo do ADMIN (telefone vazio, setor vazio, por último — T6); a exportação não escreve nada além do evento da trilha (GX9); `shared/spreadsheet/` não importa de `src/modules/` (GX17).

## Mapa de arquivos

- Criar (back): `backend/src/shared/spreadsheet/{cell-rules,csv-writer,people-columns,file-name,xlsx-writer,spreadsheet-writer,download}.ts` e specs; `backend/src/schemas/contracts/people-export.schema.ts` e spec; `backend/src/modules/people-export/{people-export.errors,export-trail,people-rows,people-instructions,people-export.repository,people-export.service,schedule-cells,schedule-export.service,sector-name.query,people-export.controller,people-export.module}.ts`, `people-export.service.fixtures.ts` (apoio dos specs do serviço de pessoas), `dto/{people-export-query,schedule-export-query}.dto.ts` e specs (o serviço de pessoas tem dois: `people-export.service.spec.ts`, da T8a, e `people-export.service.write.spec.ts`, da T8b); migrações `backend/prisma/migrations/20261119120000_people_export_permission/migration.sql` e `20261119120100_audit_category_spreadsheet/migration.sql`; specs de migração.
- Modificar (back): `backend/src/shared/authz/permissions.ts`; `backend/prisma/schema.prisma` (enum); `backend/src/schemas/contracts/audit-trail.schema.ts`; `backend/src/modules/staff-schedule/staff-schedule.module.ts` (exports); `backend/src/app.module.ts`; specs de permissão (inclui `sector-people/sector-people.repository.integration.spec.ts`, T3) e `permissions/route-parity.spec.ts` (um `describe` novo).
- Criar (front): `frontend/src/features/people-export/` (`api.ts`, `download.ts`, `components/export-people-button.tsx`, `components/export-people-dialog.tsx`, `components/export-schedule-menu.tsx` e specs).
- Modificar (front): `features/permissions/keys.ts` e specs; `features/audit-trail/{schemas,labels}.ts` e `labels.spec.ts`; `routes/_authenticated/users/index.tsx`, `routes/_authenticated/setores/$sectorId.tsx`, `routes/_authenticated/escala/index.tsx` e os specs existentes das três rotas (`users/index.spec.tsx`, `setores/$sectorId.spec.tsx`, `escala/index.spec.tsx`); `release-notes.ts`.

---

## Task 1 — Regras de célula, escritor de CSV, colunas de pessoas e nome de arquivo (back)

**Arquivos:**
- Criar: `backend/src/shared/spreadsheet/cell-rules.ts`, `csv-writer.ts`, `people-columns.ts`, `file-name.ts` e os specs `cell-rules.spec.ts`, `csv-writer.spec.ts`, `people-columns.spec.ts`, `file-name.spec.ts`.

**Interfaces:**
- Consome: `libphonenumber-js` (já usado em `backend/src/modules/contacts/phone.util.ts`; aqui importado direto, sem passar pelo módulo de contatos); `node:stream` (`Writable`, `PassThrough` nos testes).
- Produz: CX4 (parte T1: `cell-rules.ts`, `csv-writer.ts`, `people-columns.ts`, `file-name.ts`).

**Contexto vinculado:**
- Spec, Formato do CSV: "UTF-8 com BOM, separador `;`, fim de linha CRLF. Campo entre aspas quando contém `;`, aspas ou quebra de linha; aspas dobradas dentro do campo. Texto que começa por `=`, `+`, `-`, `@`, tabulação ou retorno de carro ganha um apóstrofo na frente. Na leitura, o apóstrofo inicial é tirado quando vem antes de um desses caracteres."
- Regra deste plano (achado M4 da revisão): a volta tem de devolver o texto original, então a ida também protege o texto que já começa por apóstrofo(s) seguido(s) de gatilho (`'=x` → `''=x`); sem isso `'=x` voltaria como `=x`. Regex dos dois lados: `/^'*[=+\-@\t\r]/`; `unguardFormula` tira um apóstrofo só quando o resto casa essa regex. Propriedade testada: `unguardFormula(guardFormula(s)) === s` para todo gatilho, para `'` + gatilho e para `''` + gatilho; `'abc` e `''abc` ficam iguais nos dois sentidos. Telefone `(92) 99111-2008`; estrangeiro `+1 415 555 2671` ganha o apóstrofo; data `DD/MM/AAAA`.
- Spec D1, Colunas: `matricula`, `nome`, `telefone`, `funcao`, `setor`, `turno`, `nivel`, `autorizacao_contato` (Sim/Não), `origem_autorizacao` (Termo assinado, Ficha de admissão, Aceite por WhatsApp, Outro, Cadastro anterior), `detalhe_origem`, `data_autorizacao`, `situacao` (Ativa/Inativa), `tem_acesso` (Sim/Não); "os cabeçalhos são os mesmos do modelo de importação".
- Spec D2, nome do arquivo: "nome do setor reduzido a letras minúsculas sem acento, números e hífen".
- DX1/GX17: a pasta não importa de `src/modules/`; `unguardFormula` nasce aqui para o Lote E.
- DX2: `PEOPLE_TEMPLATE_COLUMNS` (11) e `PEOPLE_EXPORT_COLUMNS` (13); textos de `PEOPLE_COLUMN_MEANING` na tabela de CX6.
- DX10: `CsvStreamWriter` espera `drain` quando `write` devolve `false`.
- GX11 e GX13.

**Passos:**
1. [ ] RED `cell-rules.spec.ts`: `it('guardFormula: cada gatilho (= + - @ tab CR) ganha apóstrofo; texto que já começa por apóstrofo e gatilho também; texto comum e vazio ficam iguais')` (`=x` → `'=x`; `'=x` → `''=x`; `'abc` fica `'abc`); `it('unguardFormula desfaz guardFormula e não mexe em apóstrofo antes de outro caractere')` (propriedade `unguardFormula(guardFormula(s)) === s` para cada gatilho, para `'` + gatilho e para `''` + gatilho; `'abc` continua `'abc`); `it('formatPhoneCell: celular e fixo do Brasil no formato nacional; estrangeiro no internacional')` (`+5592991112008` → `(92) 99111-2008`; `+14155552671` → `+1 415 555 2671`); `it('formatDateCell: AAAA-MM-DD vira DD/MM/AAAA')`; `it('yesNo: Sim e Não')`.
2. [ ] RED `csv-writer.spec.ts`: `it('csvField: gatilho de fórmula ganha apóstrofo antes das aspas; ; aspas e quebras vão entre aspas')` (Review Focus 1); `it('csvRow: separador ; e fim CRLF')`; `it('CsvStreamWriter: BOM só no começo, linhas na ordem, end no close')` (coleta os bytes de um `PassThrough`: começa por `EF BB BF`); `it('CsvStreamWriter: close sem linhas ainda grava o BOM')`; `it('CsvStreamWriter espera drain quando o destino está cheio')` (Writable com `highWaterMark` 1 e `write` que devolve `false`).
3. [ ] RED `people-columns.spec.ts`: `it('PEOPLE_EXPORT_COLUMNS são as 11 do modelo mais situacao e tem_acesso, nesta ordem')`; `it('toda coluna tem significado e toda origem tem rótulo')`. RED `file-name.spec.ts`: `it('fileSlug: tira acento, barra e símbolos; vazio vira setor')` (Review Focus 5: `Manutenção / Elétrica (2º)` → `manutencao-eletrica-2o`; `***` → `setor`).
4. [ ] GREEN. `prettier --write` só nestes arquivos novos.
5. [ ] Validação: `timeout 600 gate --test src/shared/spreadsheet/cell-rules.spec.ts`; idem para `csv-writer.spec.ts`, `people-columns.spec.ts`, `file-name.spec.ts`; typecheck do back; `TESTCONTAINERS_ENABLED=1 timeout 600 gate --changed --base feat/vinculo-vigencia`.

**Aceite:** base dos aceites 1, 9 e 10 (formato do CSV, apóstrofo, colunas do modelo).

**Risco: alto** (a neutralização de fórmula é anti-objetivo da spec; código puro, sem I/O de banco).

## Task 2 — Escritor de XLSX, escritor por formato e cabeçalhos de download (back)

**Arquivos:**
- Criar: `backend/src/shared/spreadsheet/xlsx-writer.ts`, `spreadsheet-writer.ts`, `download.ts` e specs `xlsx-writer.spec.ts`, `spreadsheet-writer.spec.ts`, `download.spec.ts`.

**Interfaces:**
- Consome: CX4 parte T1 (`CsvStreamWriter`); `exceljs` (`ExcelJS.stream.xlsx.WorkbookWriter`; nos testes, `new ExcelJS.Workbook().xlsx.load(buffer)` para ler de volta); `Logger` de `@nestjs/common`.
- Produz: CX4 parte T2.

**Contexto vinculado:**
- Padrão do export de contatos (`backend/src/modules/contacts/contacts-export.service.ts`, que não muda — GX2): `WorkbookWriter({ stream: sink, useStyles: false, useSharedStrings: false })`; headers `Content-Type`, `Content-Disposition: attachment; filename="…"`, `X-Content-Type-Options: nosniff`, `Cache-Control: no-store`; erro com headers enviados → log com mensagem fixa e `sink.destroy()`; senão `removeHeader('Content-Disposition')` e relança.
- DX10: mensagem fixa `stream de exportação abortado após headers (rota <rota>)`, nunca query nem telefone.
- DX11: `setDownloadHeaders` grava também `Access-Control-Expose-Headers: Content-Disposition`.
- DX15: no XLSX toda célula é string, sem fórmula e sem apóstrofo.
- CX1: `Content-Type` `text/csv; charset=utf-8` (CSV) e `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` (XLSX).
- GX17: nada de `src/modules/`.

**Passos:**
1. [ ] RED `xlsx-writer.spec.ts`: `it('grava duas abas na ordem, com as linhas como texto')` (abas `Pessoas` e `Instruções`; lido de volta, `cell.type === ExcelJS.ValueType.String`); `it('texto que começa por = fica string, sem fórmula e sem apóstrofo')` (`cell.formula` indefinido; valor igual ao escrito).
2. [ ] RED `spreadsheet-writer.spec.ts`: `it('csv: escreve pelo CsvStreamWriter e startSheet lança')`; `it('xlsx: startSheet abre uma aba nova')`.
3. [ ] RED `download.spec.ts`: `it('setDownloadHeaders grava os cinco headers por formato')`; `it('failDownload antes dos headers saírem: tira Content-Disposition e relança')`; `it('failDownload depois dos headers: registra mensagem fixa e destrói o destino, sem relançar')` (o log não contém o texto do erro original além da `stack`).
4. [ ] GREEN.
5. [ ] Validação: `timeout 600 gate --test src/shared/spreadsheet/xlsx-writer.spec.ts`; idem `spreadsheet-writer.spec.ts`, `download.spec.ts`; typecheck do back; `TESTCONTAINERS_ENABLED=1 timeout 600 gate --changed --base feat/vinculo-vigencia`.

**Aceite:** base dos aceites 2 e 9 (XLSX com abas, célula como texto) e do anti-objetivo "exportação recusada baixar arquivo vazio".

**Risco: alto** (streaming e headers de download; sem regra de acesso).

## Task 3 — Chave `pessoas.exportar` no back e semente da matriz (back)

**Arquivos:**
- Modificar: `backend/src/shared/authz/permissions.ts` (`PERMISSION_KEYS`, `DEFAULT_MATRIX`, `PERMISSION_DENIED_TEXT`); `backend/src/shared/authz/permissions.spec.ts`; `backend/src/schemas/contracts/permissions.schema.spec.ts` (se conferir a lista ou a contagem de chaves); `backend/src/modules/permissions/role-permissions-migration.integration.spec.ts` (contagem 16 → 18); `backend/src/modules/sector-people/sector-people.repository.integration.spec.ts` (o ADMIN passa a ter 9 chaves: 8 → 9 no título e na asserção `toHaveLength`, linha ~411).
- Criar: `backend/prisma/migrations/20261119120000_people_export_permission/migration.sql`; `backend/src/modules/permissions/people-export-permission-migration.integration.spec.ts`.

**Interfaces:**
- Consome: tabela `RolePermission(role, key, granted, updatedAt, updatedById)` e o `CHECK` de papel editável (migração `20261119100000_role_permissions`); `deployMigrations({ databaseUrl, until? })` de `backend/test/migrations.ts`.
- Produz: `PermissionKey` com `'pessoas.exportar'` (T10 usa no decorator; o front espelha na T11).

**Contexto vinculado:**
- Decisão 1 da coordenação: o Lote D acrescenta só `pessoas.exportar`; `pessoas.importar` entra no Lote E, junto com a função (conselho R2: "semeadas pela migração da etapa que criar a função"). A troca de `DEFAULT_MATRIX.SUPERVISOR` para lista explícita é feita agora.
- Spec, Permissões: `pessoas.exportar`, "Exportar pessoas e escala": ADMIN sim; SUPERVISOR, OPERATOR, VIEWER não. Recusa: "Você não tem permissão para exportar pessoas e escala." "Hoje a matriz padrão do Supervisor é 'todas menos estrutura'. Ela passa a ser uma lista explícita, sem as chaves novas; a migração semeia Supervisor e Operador com as chaves negadas."
- Comentário do arquivo: "Uma chave só entra aqui na etapa em que a função existe."
- Aceite 22 (parte exportação): com a matriz padrão, Supervisor e Operador não têm `pessoas.exportar`.
- Posição da chave: **última** de `PERMISSION_KEYS` (não muda a ordem das 8 existentes, que testes e a tela usam).
- `DEFAULT_MATRIX.SUPERVISOR` = `['pessoas.editar', 'pessoas.inativar', 'escala.alterar', 'telefone.ver_completo', 'equipe.enviar', 'equipe.disparo_amplo', 'trilha.consultar']`; OPERATOR igual ao atual.
- Migração: `INSERT INTO "RolePermission" ("role","key","granted") VALUES ('SUPERVISOR','pessoas.exportar',false), ('OPERATOR','pessoas.exportar',false) ON CONFLICT DO NOTHING;` com comentário de cabeçalho no estilo da `20261119100000_role_permissions` (só insere; reaplicar não desfaz linha editada).
- GX10, GX11, GX13; asserções existentes portadas, nunca afrouxadas.

**Passos:**
1. [ ] RED `permissions.spec.ts`: `it('SUPERVISOR e OPERATOR não têm pessoas.exportar por padrão; ADMIN tem')`; `it('DEFAULT_MATRIX.SUPERVISOR é a lista explícita das sete chaves')`; ajustar o título e a contagem do teste "texto para cada uma das 8 chaves" para 9. Ajustes em `permissions.spec.ts` que a chave nova força: (a) no fixture da linha ~35, que usa `'pessoas.exportar'` como "chave desconhecida ignorada" (passa a existir e o teste ficaria verde por coincidência), trocar a chave por `'chave.inexistente'`, para continuar provando o descarte; (b) a expectativa das linhas ~17-19 ("SUPERVISOR = tudo menos `estrutura.manter`") quebra: trocá-la pela lista explícita das sete chaves (a mesma de `DEFAULT_MATRIX.SUPERVISOR`).
   - Em `sector-people.repository.integration.spec.ts` (linhas ~401-411): título e asserção do ADMIN de 8 para 9 chaves (`toHaveLength(9)`), sem afrouxar nada.
2. [ ] RED `people-export-permission-migration.integration.spec.ts` (sobe o banco com `deployMigrations({ databaseUrl, until: '20261119110000_user_assignment_history' })`, edita uma linha à mão antes de aplicar o resto, quando o teste pedir): `it('a migração semeia pessoas.exportar negada para SUPERVISOR e OPERATOR, sem autor')`; `it('não sobrescreve linha de pessoas.exportar já gravada pela tela')` (linha `SUPERVISOR/pessoas.exportar/true` inserida antes do deploy completo continua `true`); `it('reaplicar o INSERT não duplica')`.
3. [ ] Ajustar `role-permissions-migration.integration.spec.ts`: com o deploy completo o banco passa a ter 18 linhas iguais a `DEFAULT_MATRIX`; trocar 16 por 18 nos títulos e asserções, mantendo a comparação linha a linha com a matriz.
4. [ ] GREEN (código e migração). Rodar `npx tsc` para achar todo `Record<PermissionKey, …>` exaustivo no back e completar (o compilador força).
5. [ ] Validação: `timeout 600 gate --test src/shared/authz/permissions.spec.ts`; `timeout 600 gate --test src/schemas/contracts/permissions.schema.spec.ts`; `TESTCONTAINERS_ENABLED=1 timeout 600 gate --test src/modules/permissions/people-export-permission-migration.integration.spec.ts`; `TESTCONTAINERS_ENABLED=1 timeout 600 gate --test src/modules/permissions/role-permissions-migration.integration.spec.ts`; `TESTCONTAINERS_ENABLED=1 timeout 600 gate --test src/modules/sector-people/sector-people.repository.integration.spec.ts`; `TESTCONTAINERS_ENABLED=1 timeout 600 gate --test src/modules/permissions/route-parity.spec.ts` (a paridade das rotas antigas não pode mudar); typecheck do back; `TESTCONTAINERS_ENABLED=1 timeout 600 gate --changed --base feat/vinculo-vigencia`.

**Aceite:** spec aceite 22 (parte exportação: matriz padrão sem a chave para Supervisor e Operador) e base do aceite 5.

**Risco: crítico (autorização)**
**Crítico:** autorização — acrescenta uma chave ao catálogo, troca a regra que dava ao SUPERVISOR toda chave nova por uma lista fixa e semeia as linhas negadas em produção por migração; um erro aqui libera a exportação de telefones e dados de pessoas ao Supervisor por padrão.

## Task 4 — Categoria de trilha Planilhas (back)

**Arquivos:**
- Modificar: `backend/prisma/schema.prisma` (enum `AuditCategory` ganha `SPREADSHEET`, por último); `backend/src/schemas/contracts/audit-trail.schema.ts` (`auditCategorySchema`); o spec que conferir a lista de categorias, se houver (procurar por `auditCategorySchema` nos `*.spec.ts`).
- Criar: `backend/prisma/migrations/20261119120100_audit_category_spreadsheet/migration.sql`; `backend/src/shared/audit/audit-category-migration.integration.spec.ts`.

**Interfaces:**
- Consome: enum `AuditCategory` atual (PERSON, ASSIGNMENT, SCHEDULE, STRUCTURE, PERMISSIONS).
- Produz: `AuditCategory.SPREADSHEET` no client gerado (`npx prisma generate`) e no contrato da Trilha (T5 usa; o front espelha na T11).

**Contexto vinculado:**
- Decisão 2 da coordenação: a categoria `SPREADSHEET` entra agora, em migração própria que não usa o valor.
- Spec, Trilha: "Nova categoria de trilha Planilhas (`AuditCategory.SPREADSHEET`) … só para o ADMIN (regra do Lote A para a consulta geral). O valor novo do enum entra numa migração que não o usa."
- Migração: só `ALTER TYPE "AuditCategory" ADD VALUE IF NOT EXISTS 'SPREADSHEET';`, com comentário de cabeçalho (aditiva; o valor não é usado na mesma migração porque o Postgres não deixa usar valor de enum na transação que o criou). Precedente: `20260711081500_campaign_optin_gate`.
- GX10: nunca `migrate dev`/`reset`; o drift do schema contra as migrações tem de sair vazio.

**Passos:**
1. [ ] RED `audit-category-migration.integration.spec.ts`: `it('depois do deploy o enum AuditCategory aceita SPREADSHEET')` (insere um `AuditEvent` com a categoria em SQL); `it('reaplicar a migração não falha')`.
2. [ ] RED no spec do contrato (se existir; senão no mesmo spec novo): `it('auditCategorySchema aceita SPREADSHEET')`.
3. [ ] GREEN: enum, migração, contrato; `npx prisma validate` e `npx prisma generate`.
4. [ ] Validação: `TESTCONTAINERS_ENABLED=1 timeout 600 gate --test src/shared/audit/audit-category-migration.integration.spec.ts`; `TESTCONTAINERS_ENABLED=1 timeout 600 gate --test src/modules/shifts/shift-migration.integration.spec.ts` (roda o `schemaDrift` de `backend/test/migrations.ts`; aceite: drift vazio, ou só o `DROP TABLE` de quarentena já tolerado); `TESTCONTAINERS_ENABLED=1 timeout 600 gate --test src/modules/audit-trail/audit-trail.repository.integration.spec.ts`; typecheck do back; `TESTCONTAINERS_ENABLED=1 timeout 600 gate --changed --base feat/vinculo-vigencia`.

**Aceite:** base do aceite 8 (tipo Planilhas existe no banco e no contrato).

**Risco: alto** (migração aditiva de enum em produção; não altera dado).

## Task 5 — Contrato das rotas, erros e registro na trilha (back)

**Arquivos:**
- Criar: `backend/src/schemas/contracts/people-export.schema.ts` e `people-export.schema.spec.ts`; `backend/src/modules/people-export/people-export.errors.ts`; `backend/src/modules/people-export/export-trail.ts` e `export-trail.spec.ts`.

**Interfaces:**
- Consome: `civilDateSchema` (`backend/src/schemas/contracts/civil-date.schema.ts`); `DomainError` (`backend/src/shared/errors/domain.error.ts`); `AuditChange`, `AuditRef` (`backend/src/shared/audit/audit-change.ts`); `AuditCategory.SPREADSHEET` (T4).
- Produz: CX1 (schemas e tipos), CX2, CX3.

**Contexto vinculado:**
- Spec D1, rota: `GET /internal/people-export/people?format=csv|xlsx&sectorId=&shiftId=&status=active|inactive|all&date=AAAA-MM-DD`; situação padrão `active`; data padrão hoje. D2: `GET /internal/people-export/schedule?format=csv|xlsx&sectorId=&from=&to=`.
- Spec D1, limite: "50.000 linhas; acima disso, 422 `export.too_large` com 'Há pessoas demais para um arquivo só. Filtre por setor ou turno.'" D2: "422 `export.too_large` com 'Há pessoas demais neste setor para um arquivo só.'"
- Spec, Trilha: ação `people.export` "com formato, filtros, data de referência, quantidade de linhas e se o telefone saiu completo ou mascarado. Nenhum dado pessoal"; `schedule.export` "com formato, setor, período e quantidade de linhas"; dados em `changes` com "antes" vazio; categoria explícita.
- DX12 (403/404 do filtro), DX13 (forma do evento), CX1 a CX3 (assinaturas e textos exatos).
- `recordChange` mascara campos de telefone e e-mail pelo nome do campo: nenhum campo deste evento usa os nomes `phone` ou `email` (por isso `phoneVisibility`).

**Passos:**
1. [ ] RED `people-export.schema.spec.ts`: `it('people: format obrigatório; status padrão active; sectorId e shiftId vazios valem ausentes; date opcional e só AAAA-MM-DD')`; `it('schedule: format, sectorId, from e to obrigatórios')`; `it('formato fora de csv e xlsx é recusado')`. Já conferido pelo revisor: `transform` em DTO de query funciona (precedente `backend/src/schemas/contracts/sector-people.schema.ts:63-68`; `ZodValidationPipe` global em `app.module.ts:188`); manter `optionalId` como está.
2. [ ] RED `export-trail.spec.ts`: `it('peopleExportChange: ação, categoria SPREADSHEET, autor e os sete campos com antes vazio')`; `it('peopleExportChange: Todos os setores e Todos os turnos quando não há filtro; setor e turno escolhidos como id e nome')`; `it('scheduleExportChange: setor como entityId e período em periodFrom e periodTo')`; `it('phoneVisibilityOf: masked sem a chave; full para ADMIN; partial para gestor com a chave')`; `it('nenhum campo se chama phone ou email e nenhum valor traz dado de pessoa')`.
3. [ ] GREEN.
4. [ ] Validação: `timeout 600 gate --test src/schemas/contracts/people-export.schema.spec.ts`; `timeout 600 gate --test src/modules/people-export/export-trail.spec.ts`; typecheck do back; `TESTCONTAINERS_ENABLED=1 timeout 600 gate --changed --base feat/vinculo-vigencia`.

**Aceite:** base dos aceites 8 (o que vai na trilha) e 4 (códigos de recusa).

**Risco: alto** (contrato público consumido pelo front e forma do evento da trilha; sem acesso a banco).

## Task 6 — Linhas de pessoas e aba Instruções, puras (back)

**Arquivos:**
- Criar: `backend/src/modules/people-export/people-rows.ts` e `people-rows.spec.ts`; `backend/src/modules/people-export/people-instructions.ts` e `people-instructions.spec.ts`.

**Interfaces:**
- Consome: `assignmentOn`, `AssignmentLine`, `AssignmentValues` (`backend/src/modules/users/assignment-timeline.ts`); `phoneView`, `nameView` (`backend/src/shared/authz/phone-visibility.ts`); CX4 parte T1 (`formatPhoneCell`, `formatDateCell`, `yesNo`, `AUTHORIZATION_SOURCE_CELL`, `PERSON_STATUS_CELL`, `PEOPLE_EXPORT_COLUMNS`, `PEOPLE_COLUMN_MEANING`); `PhoneVisibility` (T5; se a T5 ainda não tiver terminado, declarar o tipo localmente igual a CX3 e trocar pelo import no fim).
- Produz: CX5 e CX6.

**Contexto vinculado:**
- Spec D1, Telefone (conselho R2): "completo quando o ator tem `telefone.ver_completo` **e** (é ADMIN ou a pessoa não tem login); senão mascarado (`•••• 2008`); sem telefone, vazio. É a mesma regra da lista do setor." Nome: "o nome que é o próprio telefone sai mascarado para quem não vê o telefone completo."
- Spec D1, Data passada não amplia: "para quem não é ADMIN, pessoa que **hoje** está fora do alcance (saiu do setor depois da data) sai com o telefone mascarado, mesmo que o ator tenha `telefone.ver_completo`."
- Spec D1, Data de referência: "Hoje ou futuro: o vínculo da ficha. Data passada: o vínculo que valia naquele dia (histórico do Lote C); sem linha que cubra o dia, o da ficha. Situação, telefone, função e autorização são sempre os atuais."
- Spec D1, Ordem: "setor, depois o nome **como sai no arquivo** (o mascarado, quando for o caso), depois id."
- DX4, regra da segunda passada: "célula `nome` = `entry.displayName` quando o telefone sai completo; quando a segunda passada rebaixa o telefone (`entry.phoneFull` verdadeiro, mas ator não ADMIN e `detail.hasAccess`), `nome` = `nameView(entry.displayName, { full: false })`; a posição da linha continua a do índice. Telefone completo só se `entry.phoneFull` e (`viewer.isAdmin` ou `!detail.hasAccess`)" (pessoa que ganhou login entre as passadas sai mascarada para o gestor).
- DX6, nome e e-mail: "nome nulo sai vazio; e-mail nunca sai no arquivo".
- DX5 (filtro conferido de novo em memória), DX6 (fórmula de `phoneFull` e do nome), DX7 (collator `pt-BR`, sem setor por último), CX5, CX6 (todas as linhas e textos da aba).
- GX4, GX5; `peopleCells` devolve texto cru: o apóstrofo é do escritor de CSV (GX7, DX15).

**Passos:**
1. [ ] RED `people-rows.spec.ts` (fábrica de linhas no próprio spec; `today` `2026-11-19`):
   - `it('ADMIN com a chave: telefone completo no formato nacional, inclusive de pessoa com login')`;
   - `it('gestor com a chave: completo só de pessoa sem login; com login sai mascarado, e o nome-telefone também')`;
   - `it('sem a chave: telefone e nome-telefone mascarados para todos')`;
   - `it('data passada: vínculo da linha que cobre a data; quem hoje está fora do alcance sai mascarado')` (Review Focus 2a, 2c, 2d);
   - `it('gestor: pessoa cujo setor na data não é do alcance fica fora; filtro de turno pelo vínculo da data')`;
   - `it('pessoa sem telefone e sem setor no arquivo do ADMIN: telefone vazio, setor vazio, por último')`;
   - `it('ordena por setor, nome exibido e id; o nome mascarado decide a posição')`;
   - `it('peopleCells: 13 colunas na ordem, Sim/Não, origens, data DD/MM/AAAA, Ativa/Inativa e nomes de setor, turno e nível inativos')`;
   - `it('peopleCells: nome é o displayName do índice; telefone completo só com entry.phoneFull e (ADMIN ou sem login agora), senão mascarado')` (I3: `entry.phoneFull` verdadeiro com `detail.hasAccess` verdadeiro e gestor → mascarado; ADMIN → completo; sem telefone → vazio; inclui pessoa cujo nome é o próprio telefone e que ganhou login entre as passadas: telefone e nome mascarados);
   - `it('nome nulo sai vazio e o e-mail nunca entra nas linhas')` (M5: `PeopleCandidateRow` e `PeopleDetailRow` não têm e-mail; nome nulo → `displayName` e célula `nome` vazios).
   - Contrato mudado por este ajuste: `peopleCells` ganha `viewer: ExportViewer` no objeto de entrada (CX5); a T8b é a única chamadora.
2. [ ] RED `people-instructions.spec.ts`: `it('linhas de filtro, data e hora em Manaus e os dois avisos')` (relógio fixo em `2026-11-19T18:30:00Z` → `19/11/2026 14:30`); `it('uma linha por coluna exportada, com o significado')`; `it('texto do telefone para full, masked e partial')`.
3. [ ] GREEN.
4. [ ] Validação: `timeout 600 gate --test src/modules/people-export/people-rows.spec.ts`; `timeout 600 gate --test src/modules/people-export/people-instructions.spec.ts`; typecheck do back; `TESTCONTAINERS_ENABLED=1 timeout 600 gate --changed --base feat/vinculo-vigencia`.

**Aceite:** spec aceites 3 e 6 (regra por linha) e a aba "Instruções" do aceite 2 e do 10.

**Risco: crítico (autorização)**
**Crítico:** autorização — decide, linha a linha, se o telefone e o nome de cada pessoa saem completos ou mascarados no arquivo e se a pessoa entra no recorte do gestor; um erro entrega telefone completo de pessoa com login ou fora do alcance.

## Task 7 — Repositório da exportação de pessoas (back)

**Arquivos:**
- Criar: `backend/src/modules/people-export/people-export.repository.ts` e `people-export.repository.integration.spec.ts`.

**Interfaces:**
- Consome: `PrismaService`; modelos `User`, `UserAssignment`, `Sector`, `Shift`, `StaffLevel`; `toDbDate`, `fromDbDate`, `zonedStart`, `addDays` (`civil-date.ts`); tipos de CX5 (T6).
- Produz:
```ts
export type CandidateFilter = {
  status: 'active' | 'inactive' | 'all';
  createdBefore: Date;                                          // zonedStart(addDays(date, 1), '00:00') — fim do dia da data em Manaus
  mirror: { sectorIds: readonly string[] | null; shiftId: string | null } | null; // null = sem filtro de vínculo no SQL (data passada)
};
@Injectable() export class PeopleExportRepository {
  pageCandidates(filter: CandidateFilter, take: number, afterId?: string): Promise<PeopleCandidateRow[]>; // ordem id asc
  linesOn(userIds: readonly string[], date: CivilDate): Promise<Map<string, AssignmentLine[]>>;          // linhas que cobrem a data
  detailsByIds(ids: readonly string[]): Promise<PeopleDetailRow[]>;                                      // ordem livre
  nameMaps(): Promise<ExportNameMaps>;                                                                     // inclui inativos
}
```

**Contexto vinculado:**
- DX4: índice em páginas de 1.000 por cursor de `id`; dados em blocos de 500.
- DX5: data ≥ hoje → `mirror` com setor (`sectorIds` nulo = todos, inclusive sem setor), turno e alcance no SQL; data passada → `mirror: null`, só situação e `createdAt < createdBefore`. Linha cobre a data quando `validFrom` é nulo ou ≤ data **e** `validTo` é nulo ou ≥ data (fim inclusivo, Lote C DV9).
- Spec D1: "Pessoa cadastrada depois da data de referência não entra no arquivo."
- `authorizationDate` (`@db.Date`) volta como `CivilDate` por `fromDbDate`; `contactAuthorization` e `authorizationSource` são os enums do Prisma (valores de CX4).
- GX9: só leitura; nenhuma escrita em `user` ou `userAssignment` (os fixtures do spec podem inserir direto pelo Prisma).

**Passos:**
1. [ ] RED `people-export.repository.integration.spec.ts` (testcontainer; pessoas e linhas de vínculo inseridas direto):
   - `it('pageCandidates: filtra situação, setor, turno e alcance pelo espelho e pagina por id')`;
   - `it('pageCandidates com sectorIds nulo traz também quem não tem setor')`;
   - `it('pageCandidates exclui quem foi cadastrado depois do fim do dia da data em Manaus')` (Review Focus 2b: `createdAt` `2026-11-19T03:59:00Z` entra em `2026-11-18`; `04:00:00Z` não);
   - `it('linesOn devolve a linha de início em branco para data anterior ao histórico e respeita os limites inclusivos')` (Review Focus 2c);
   - `it('detailsByIds traz os campos das células com a data da autorização como data civil')`;
   - `it('nameMaps inclui setor, turno e nível inativos')`.
2. [ ] GREEN.
3. [ ] Validação: `TESTCONTAINERS_ENABLED=1 timeout 600 gate --test src/modules/people-export/people-export.repository.integration.spec.ts`; typecheck do back; `TESTCONTAINERS_ENABLED=1 timeout 600 gate --changed --base feat/vinculo-vigencia`.

**Aceite:** base dos aceites 1, 4 e 6 (recorte certo no banco).

**Risco: crítico (autorização)**
**Crítico:** autorização — a consulta aplica no SQL o recorte de setor e de alcance do gestor e o corte por data de cadastro; um `where` errado põe no arquivo pessoas de setores que o gestor não alcança.

## Task 8a — Serviço de pessoas, parte 1: viewer, seleção, índice e limite (back)

**Arquivos:**
- Criar: `backend/src/modules/people-export/people-export.service.ts` (classe, constantes e `planPeopleExport`; **sem** `exportPeople`), `people-export.service.spec.ts` e `people-export.service.fixtures.ts` (repositório falso em memória com `pageCandidates`, `linesOn`, `detailsByIds` e `nameMaps` contáveis por `vi.fn`; fábricas de ator, candidato e mapas de nomes). Esses três arquivos passam a ser da T8b na onda seguinte; a T8a não toca nenhum outro.

**Interfaces:**
- Consome: `findTeamActor(prisma, id)` (`backend/src/modules/team-whatsapp/team-actor.query.ts`; `TeamActor` com `role`, `isActive`, `hasAccess`, `managedSectorIds`, `permissions`; devolve o ator mesmo inativo, com `isActive: false`); `hasPermission`; `todayIn`, `zonedStart`, `addDays`; T7 (`PeopleExportRepository`, `CandidateFilter`); T6 (`selectIndexEntry`, `comparePeopleEntries` e os tipos de CX5); T5 (CX1 `PeopleExportQuery` e `PEOPLE_EXPORT_ROW_CAP`, CX2); `AuditRef` (`backend/src/shared/audit/audit-change.ts`); `PrismaService` (só para `findTeamActor`).
- Produz (a T8b consome exatamente isto; é a interface entre as duas):
```ts
export const PEOPLE_INDEX_PAGE = 1_000;
export type PeopleExportPlan = {
  viewer: ExportViewer;                 // { isAdmin, fullPhone, reach }
  today: CivilDate;                     // todayIn(new Date()), uma vez
  date: CivilDate;                      // query.date ?? today
  sector: AuditRef | null;              // { id, name } do setor escolhido; null = todos
  shift: AuditRef | null;               // idem para o turno
  names: ExportNameMaps;                // de repo.nameMaps(), inclui inativos
  entries: PeopleIndexEntry[];          // índice já ordenado por comparePeopleEntries; no máximo 50.000
};
@Injectable() export class PeopleExportService {
  constructor(prisma: PrismaService, repo: PeopleExportRepository);   // a T8b acrescenta o 3º parâmetro `audit: AuditService`
  planPeopleExport(actorId: string, query: PeopleExportQuery): Promise<PeopleExportPlan>;
}
```
  `planPeopleExport` só lê (repositório) e lança `DomainError` de CX2 (403, 404, 422); não grava trilha, não toca em `sink`, não escreve byte nem header. A T8b chama `planPeopleExport` como primeiro passo de `exportPeople` e o `PeopleExportPlan` é tudo que ela precisa do que a T8a decidiu.

**Contexto vinculado:**
- Spec D1, ordem: a T8a cobre só "conferir permissão e alcance → contar → conferir o limite" (`planPeopleExport` só lê e lança 403/404/422); registrar na trilha, headers e arquivo são da T8b.
- Spec D1, Alcance: ADMIN exporta todas, inclusive sem setor; quem não é ADMIN só pessoas cujo setor, na data de referência, está no alcance; setor fora do alcance → 403; quem não gerencia setor → 403.
- Sem resultado: o plano volta com `entries` vazio, sem erro (o arquivo só com cabeçalho é da T8b).
- DX4 (duas passadas, para ao passar de 50.000), DX5, DX9 (só a parte de ator, alcance, índice e limite, com os códigos) e DX12.
- Viewer: `isAdmin = role === 'ADMIN'`; `fullPhone = hasPermission(actor, 'telefone.ver_completo')`; `reach = isAdmin ? null : managedSectorIds`. Seleção: `sectorIds = sectorId ? [sectorId] : reach`. Regra do ator (`findTeamActor` devolve ator com `isActive: false`, não nulo): `!actor || !actor.isActive || !actor.hasAccess` → 403 `sectorOutOfReach()`; gestor com `managedSectorIds` vazio → 403 `noManagedSector()`.
- Ordem dentro do plano (DX9): ator → setor (não ADMIN fora do alcance, inclusive inexistente, → `sectorOutOfReach()`; ADMIN com setor fora de `names.sectors` → `exportSectorNotFound()`) → turno (fora de `names.shifts` → `exportShiftNotFound()`, para qualquer papel) → índice. Existência pelo `repo.nameMaps()` (inclui inativos, DX12).
- Índice (DX4/DX5): `today = todayIn(new Date())`; `date = query.date ?? today`; `CandidateFilter { status, createdBefore: zonedStart(addDays(date, 1), '00:00'), mirror }` com `mirror = date >= today ? { sectorIds: selection.sectorIds, shiftId } : null`; lê `pageCandidates(filter, PEOPLE_INDEX_PAGE, afterId)` até vir página menor que `PEOPLE_INDEX_PAGE`; `linesOn(ids, date)` só quando `date < today`; cada candidato por `selectIndexEntry`; ao passar de `PEOPLE_EXPORT_ROW_CAP` entradas lança `peopleTooLarge()` na hora, sem ler a página seguinte; no fim ordena por `comparePeopleEntries`.
- Regra de telefone e nome por linha (DX6, GX4): `entry.phoneFull` e `entry.displayName` vêm de `selectIndexEntry` (T6); a T8a só prova que o serviço os aplica com o viewer certo.
- GX3, GX4, GX5, GX6, GX9.

**Passos:**
1. [ ] RED `people-export.service.spec.ts` (fixtures de `people-export.service.fixtures.ts`; relógio `vi.useFakeTimers({ toFake: ['Date'] })`). Cada `describe` com até 50 linhas; dividir em `describe` irmãos:
   - `it('plano: filtro por setor e turno devolve só as pessoas do filtro, ordenadas')` (base do aceite 1);
   - `it('aceite 3: sem telefone.ver_completo, telefone e nome-telefone mascarados; gestor com a chave: pessoa com login mascarada, sem login completa')` (I2; confere `entry.phoneFull` e `entry.displayName` de cada pessoa do plano);
   - `it('aceite 4: gestor sem setor escolhido exporta só os setores que gerencia; pessoa sem setor e de setor alheio ficam fora')` (I2);
   - `it('aceite 6: data passada mostra o setor daquele dia')` (`entry.sectorName` do vínculo da data, não do espelho);
   - `it('gestor: setor alheio e setor inexistente dão o mesmo 403, lança antes de ler detailsByIds')` (Review Focus 3; e gestor sem setor → `Você não gerencia nenhum setor.`; o plano lança antes de qualquer `recordChange`);
   - `it('ator inexistente, inativo ou sem acesso: 403 sectorOutOfReach')` (M3);
   - `it('ADMIN com setor inexistente → 404; turno inexistente → 404')`;
   - `it('acima de 50.000 responde 422, lança antes de ler detailsByIds e para de ler')` (Review Focus 4; repositório falso com 50.001 candidatos em páginas de 1.000: no máximo 51 chamadas a `pageCandidates`, nenhuma a `detailsByIds`);
   - `it('linhas de vínculo só são consultadas para data passada')`.
2. [ ] GREEN, em funções pequenas (resolver o viewer; resolver setor e turno; montar o índice), cada uma dentro de GX11.
3. [ ] Validação: `timeout 600 gate --test src/modules/people-export/people-export.service.spec.ts`; typecheck do back; `TESTCONTAINERS_ENABLED=1 timeout 600 gate --changed --base feat/vinculo-vigencia`.

**Aceite:** spec aceites 1, 3, 4 e 6 no plano (recorte e regra por pessoa); anti-objetivos "telefone completo para quem não pode" e "pessoa fora do alcance".

**Risco: crítico (autorização)**
**Crítico:** autorização — decide o alcance do gestor (403), o ator válido e o recorte de pessoas, nome e telefone por linha que a T8b escreve; um erro vaza pessoas de outros setores ou telefones completos.

## Task 8b — Serviço de pessoas, parte 2: segunda passada, escrita, trilha e streaming (back)

**Ordem:** roda depois da T8a (mesmo arquivo de serviço; nunca na mesma onda).

**Arquivos:**
- Modificar (criados pela T8a): `backend/src/modules/people-export/people-export.service.ts` (acrescenta `PEOPLE_DETAIL_PAGE`, o 3º parâmetro `audit` do construtor e `exportPeople`; `planPeopleExport` e `PEOPLE_INDEX_PAGE` não mudam), `people-export.service.spec.ts` (só a fábrica do serviço, que ganha o `audit` falso; nenhuma asserção da T8a muda) e `people-export.service.fixtures.ts` (acrescenta destino `PassThrough` com `setHeader`/`removeHeader`/`headersSent`, `recordChange` espionado e `prisma.$transaction` falso que chama o callback).
- Criar: `backend/src/modules/people-export/people-export.service.write.spec.ts`.

**Interfaces:**
- Consome: `PeopleExportService.planPeopleExport` e `PeopleExportPlan` (T8a, interface acima); T7 (`detailsByIds`); T6 (`peopleCells` com `viewer`, `peopleInstructionRows`; CX5, CX6); T5 (CX1 tipos, CX3 `peopleExportChange`, `phoneVisibilityOf`); T2 (`openSpreadsheet`, `setDownloadHeaders`, `failDownload`, `DownloadSink`); T1 (`PEOPLE_EXPORT_COLUMNS`); `AuditService.recordChange(tx, change)`; `PrismaService.$transaction`.
- Produz:
```ts
export const PEOPLE_DETAIL_PAGE = 500;
@Injectable() export class PeopleExportService {
  constructor(prisma: PrismaService, repo: PeopleExportRepository, audit: AuditService);
  planPeopleExport(actorId: string, query: PeopleExportQuery): Promise<PeopleExportPlan>;   // da T8a, inalterado
  exportPeople(actorId: string, query: PeopleExportQuery, sink: DownloadSink): Promise<number>; // devolve as linhas escritas (pode ser menor que o rowCount da trilha, ver DX4)
}
```

**Contexto vinculado:**
- Spec D1, ordem: "conferir permissão e alcance → contar → conferir o limite → **registrar na trilha** → enviar o arquivo. Se o registro falhar, a rota responde erro e não há arquivo."
- Spec D1, nome do arquivo `pessoas-AAAA-MM-DD.csv|xlsx` (dia da exportação); XLSX com aba "Pessoas" e aba "Instruções"; CSV só os dados; sem resultado, só o cabeçalho.
- DX4, segunda passada: "mapear os detalhes por id; id ausente é omitido, sem erro (o `rowCount` da trilha é o do índice, registrado antes). Célula `nome` = `entry.displayName` quando o telefone sai completo; quando a segunda passada rebaixa o telefone (`entry.phoneFull` verdadeiro, mas ator não ADMIN e `detail.hasAccess`), `nome` = `nameView(entry.displayName, { full: false })`; a posição da linha continua a do índice. Telefone completo só se `entry.phoneFull` e (`viewer.isAdmin` ou `!detail.hasAccess`)." (a regra vive em `peopleCells`, T6; a T8b só passa `viewer`, `entry`, `detail` e `names`).
- DX8 (sem resultado), DX9 (ordem e códigos: plano → trilha em `prisma.$transaction` → `setDownloadHeaders` → bytes), DX10 (`failDownload` com rota `/internal/people-export/people`), DX11 (nome do arquivo com `plan.today`; não chamar `todayIn` de novo, GX6), DX13 (forma da trilha: `peopleExportChange`, `rowCount = plan.entries.length`, `phoneVisibility = phoneVisibilityOf(plan.viewer)`, setor e turno de `plan.sector` e `plan.shift`), DX15 (XLSX só string).
- Fluxo de `exportPeople`: `plan = await planPeopleExport(...)` (erro sobe sem trilha, sem header) → trilha → nome e headers → `openSpreadsheet({ sink, format, firstSheet: 'Pessoas' })` → linha de cabeçalho `PEOPLE_EXPORT_COLUMNS` → para cada bloco de `PEOPLE_DETAIL_PAGE` entradas: `detailsByIds(ids)`, mapa por id, escreve na ordem do índice, omitindo id ausente → XLSX: `startSheet('Instruções')` + `peopleInstructionRows` → `close()`. Qualquer erro depois da trilha vai a `failDownload`.
- GX3, GX4, GX6, GX8, GX9.

**Passos:**
1. [ ] RED `people-export.service.write.spec.ts` (CSV lido pelos bytes; XLSX por `ExcelJS.Workbook().xlsx.load`). Cada `describe` com até 50 linhas; vários `describe` irmãos:
   - `it('aceite 1: CSV filtrado por setor e turno, com BOM, ; e CRLF, só as pessoas do filtro')`;
   - `it('aceite 2: XLSX com as abas Pessoas e Instruções')`;
   - `it('recusa do plano (403, 404, 422) sobe sem trilha, sem header e sem byte')` (Review Focus 3 e 4 no `exportPeople`);
   - `it('trilha que falha: erro sobe, nenhum header de download nem byte')` (Review Focus 4);
   - `it('sem resultado: só o cabeçalho e trilha com rowCount 0')`;
   - `it('trilha registrada antes do primeiro header, com filtros, data, quantidade e phoneVisibility')`;
   - `it('nome com fórmula e função com ; aspas e quebra de linha: CSV com apóstrofo e aspas, XLSX como texto')` (Review Focus 1);
   - `it('pessoa apagada ou que ganhou login entre as passadas: linha omitida ou mascarada, arquivo íntegro')` (I3: `detailsByIds` sem um dos ids, em ordem embaralhada, e outro com `hasAccess: true` para gestor, cujo nome é o próprio telefone: telefone e nome saem mascarados; o arquivo sai completo e bem formado, a trilha leva o `rowCount` do índice e o retorno é o número de linhas escritas);
   - `it('erro no meio do streaming depois dos headers derruba a conexão sem relançar')`;
   - `it('nome do arquivo usa o dia de Manaus')` (relógio em `2026-11-20T03:30:00Z` → `pessoas-2026-11-19.csv`).
2. [ ] GREEN, em funções pequenas (montar a trilha; escrever o bloco; escrever as Instruções), cada uma dentro de GX11.
3. [ ] Validação: `timeout 600 gate --test src/modules/people-export/people-export.service.write.spec.ts`; `timeout 600 gate --test src/modules/people-export/people-export.service.spec.ts` (a fábrica mudou); typecheck do back; `TESTCONTAINERS_ENABLED=1 timeout 600 gate --changed --base feat/vinculo-vigencia`.

**Aceite:** spec aceites 1, 2, 8 e 9 no serviço; anti-objetivos "fórmula" e "recusada baixar arquivo vazio, ou feita ficar sem registro".

**Risco: crítico (autorização)**
**Crítico:** autorização e dado pessoal — grava a trilha antes do envio e escreve o arquivo com telefone e nome por linha; um erro deixa exportação sem registro, baixa arquivo de exportação recusada ou entrega telefone completo de pessoa que ganhou login.

## Task 9 — Serviço de exportação da escala (back)

**Arquivos:**
- Criar: `backend/src/modules/people-export/schedule-cells.ts` e `schedule-cells.spec.ts`; `schedule-export.service.ts` e `schedule-export.service.spec.ts`; `sector-name.query.ts`.
- Modificar: `backend/src/modules/staff-schedule/staff-schedule.module.ts` (só `exports: [StaffScheduleRepository, StaffScheduleService]`).

**Interfaces:**
- Consome: `StaffScheduleService.board(actorId: string, query: BoardQuery): Promise<StaffScheduleBoard>` (`rows[]` com `name`, `jobTitle`, `fromOtherSector`, `days[]` de `{ date, situation }`; `sectors`, `shifts`, `truncated`; `backend/src/schemas/contracts/staff-schedule.schema.ts`); `addDays`, `diffDays`; T5 (CX1 `ScheduleExportQuery`, CX2 `scheduleTooLarge`, CX3 `scheduleExportChange`); T2; T1 (`formatDateCell`, `yesNo`, `fileSlug`); `AuditService.recordChange`; `PrismaService`.
- Produz:
```ts
// schedule-cells.ts
export type ScheduleCellInput = { situation: DaySituationContract; sectorId: string;
  shiftNames: ReadonlyMap<string, string>; sectorNames: ReadonlyMap<string, string> };
export function scheduleCellLabel(input: ScheduleCellInput): string; // cópia fiel de cellLabel do front
export const SCHEDULE_FIXED_COLUMNS: readonly ['nome', 'funcao', 'visitante'];
// sector-name.query.ts
export function findSectorName(prisma: PrismaService, sectorId: string): Promise<string | null>;
// schedule-export.service.ts
@Injectable() export class ScheduleExportService {
  constructor(prisma: PrismaService, schedule: StaffScheduleService, audit: AuditService);
  exportSchedule(actorId: string, query: ScheduleExportQuery, sink: DownloadSink): Promise<number>;
}
```

**Contexto vinculado:**
- Spec D2: "Exige `pessoas.exportar` **e** poder ver o quadro daquele setor (as mesmas regras do quadro da Escala: alcance e período de até 42 dias)." Conteúdo: "uma linha por pessoa; colunas `nome`, `funcao`, `visitante` (Sim quando a pessoa é de outro setor) e uma coluna por dia do período, com cabeçalho `DD/MM/AAAA`." Célula: "nome do turno; `Folga`; `Férias`; `Em <setor>` quando trabalha em outro setor naquele dia; vazio quando não há escala. Os mesmos textos da tela." "Nome mascarado como no quadro. Sem coluna de telefone." Limite: quadro cortado (mais de 500) → 422. Arquivo `escala-<setor>-AAAA-MM-DD-a-AAAA-MM-DD.csv|xlsx`. Trilha `schedule.export`.
- Texto da célula no front (`frontend/src/features/staff-schedule/board-cells.ts`): `NONE` → vazio; `OFF` → `Férias` se `VACATION`, senão `Folga`; `WORK` no setor do quadro → nome do turno (vazio se desconhecido); `WORK` em outro setor → `Em <nome>`, ou `Em outro setor` quando o setor é nulo ou desconhecido.
- DX9 (ordem: quadro → `truncated` → trilha → headers → bytes), DX10 (rota `/internal/people-export/schedule`), DX11, DX14 (aba única `Escala`; ordem das linhas = a do quadro; célula pelo `date` do dia, não pela posição).
- GX3, GX8.

**Passos:**
1. [ ] RED `schedule-cells.spec.ts`: os mesmos casos do spec do front (`frontend/src/features/staff-schedule/board-cells.spec.ts`, se existir; senão um por ramo): `it('turno no setor do quadro; Folga; Férias; Em <setor>; Em outro setor; vazio sem escala')`.
2. [ ] RED `schedule-export.service.spec.ts` (`StaffScheduleService` falso):
   - `it('aceite 7: cabeçalho nome, funcao, visitante e um dia por coluna; células com os textos do quadro')`;
   - `it('visitante Sim para quem é de outro setor; nome como veio do quadro')`;
   - `it('quadro cortado responde 422 sem trilha')` (Review Focus 4);
   - `it('quadro recusado não grava trilha nem header')` (Review Focus 3; o falso lança o 403 do quadro);
   - `it('nome do arquivo usa o setor reduzido e o período')` (Review Focus 5);
   - `it('trilha com formato, setor, período e quantidade, antes do primeiro header')`;
   - `it('XLSX com a aba Escala e células como texto')`.
3. [ ] GREEN; exportar `StaffScheduleService` no módulo da escala.
4. [ ] Validação: `timeout 600 gate --test src/modules/people-export/schedule-cells.spec.ts`; `timeout 600 gate --test src/modules/people-export/schedule-export.service.spec.ts`; `timeout 600 gate --test src/modules/staff-schedule/staff-schedule.service.spec.ts` (o módulo mudou; o serviço não); typecheck do back; `TESTCONTAINERS_ENABLED=1 timeout 600 gate --changed --base feat/vinculo-vigencia`.

**Aceite:** spec aceites 7 e 8 (escala) e o limite de D2.

**Risco: crítico (autorização)**
**Crítico:** autorização — a exportação da escala depende da conferência de alcance e de período do quadro e grava a trilha antes do envio; chamar o quadro errado, ou escrever antes de conferir, entrega a escala de setor alheio.

## Task 10 — Controller, módulo e prova de que toda rota exige a chave (back)

**Arquivos:**
- Criar: `backend/src/modules/people-export/people-export.controller.ts`, `people-export.module.ts`, `dto/people-export-query.dto.ts`, `dto/schedule-export-query.dto.ts`, `people-export.controller.spec.ts`.
- Modificar: `backend/src/app.module.ts` (importa `PeopleExportModule`); `backend/src/modules/permissions/route-parity.spec.ts` (só um `describe` novo, irmão, no fim do arquivo, e a importação do controller; nada do que existe muda).

**Interfaces:**
- Consome: T8b (`PeopleExportService.exportPeople`; a T8b já traz a T8a, `planPeopleExport`), T9 (`ScheduleExportService`), T7 (`PeopleExportRepository`), T5 (schemas de CX1), T3 (`'pessoas.exportar'`); `RequirePermission` (`backend/src/modules/auth/decorators/require-permission.decorator.ts`); `createZodDto`; `Response` do Express com `@Res()` sem `passthrough` (padrão de `contacts.controller.ts`, rota `export.xlsx`); `req.user.sub` (padrão `AuthRequest` de `staff-schedule.controller.ts`); `StaffScheduleModule` (que passa a exportar o serviço, T9).
- Produz: as duas rotas de CX1.
```ts
@ApiTags('people-export')
@RequirePermission('pessoas.exportar')
@Controller('internal/people-export')
export class PeopleExportController {
  @Get('people') people(@Query() q: PeopleExportQueryDto, @Req() req: AuthRequest, @Res() res: Response): Promise<void>;
  @Get('schedule') schedule(@Query() q: ScheduleExportQueryDto, @Req() req: AuthRequest, @Res() res: Response): Promise<void>;
}
```

**Contexto vinculado:**
- Spec, Rotas (texto atual): "os dois controllers novos levam a chave na classe (`pessoas.exportar` ou `pessoas.importar`), como manda o Lote B: com a chave na classe, o papel deixa de ser conferido à parte e quem decide é a matriz (ADMIN sempre passa, VIEWER nunca). Vale para todas as rotas, inclusive a do modelo. Um teste prova que nenhuma rota deles fica sem a chave (rota sem chave e sem papel declarado cairia na regra antiga, que libera ADMIN e OPERATOR)." Aceite 5: sem `pessoas.exportar`, a rota responde 403. Aceite 22 (parte exportação): nenhuma rota do controller novo fica sem a chave.
- DX3: só `@RequirePermission` na classe; nenhum `@Roles` na classe nem nos handlers; ADMIN sempre passa, VIEWER nunca, SUPERVISOR e OPERATOR conforme a matriz. Mistura de `@Roles` e `@RequirePermission` é proibida (Lote B).
- Guardas em ordem JWT → `RolesGuard` → `PermissionsGuard` (`permissions.guard.ts` lê a chave por `getAllAndOverride(PERMISSION_KEY, [handler, class])`).
- `route-parity.spec.ts` já tem `handlersOf`, `routeContext`, `isAllowed`, `mixedRoutes`, `rolesGuard` e `permissionsGuard` (matriz padrão): o `describe` novo os reaproveita, sem copiar.
- GX13 (arquivo legado: nada de `prettier --write` em `route-parity.spec.ts` nem em `app.module.ts`).

**Passos:**
1. [ ] RED `route-parity.spec.ts`, `describe('controllers com a chave na classe (Etapa 2)')` com a lista `CLASS_KEY_CONTROLLERS = [{ controller: PeopleExportController, key: 'pessoas.exportar' }]` (o Lote E acrescenta o dele):
   - `it('toda rota exige a chave e nenhuma declara @Roles')` (para cada handler de `handlersOf`: a chave resolvida no handler ou na classe é a esperada; `ROLES_KEY` ausente na classe e no handler; `mixedRoutes` vazio);
   - `it('com a matriz padrão só o ADMIN passa')` (ADMIN permitido; SUPERVISOR, OPERATOR e VIEWER recusados com 403);
   - `it('com a chave liberada SUPERVISOR e OPERATOR passam; VIEWER continua recusado')` (um `PermissionsGuard` local cujo `effectiveFor` devolve o padrão do papel mais a chave, menos para VIEWER, que é sempre vazio).
2. [ ] RED `people-export.controller.spec.ts`: `it('people repassa o id do usuário, a query e a resposta ao serviço')`; `it('schedule repassa o id do usuário, a query e a resposta ao serviço')`; `it('erro do serviço antes do envio sobe para o filtro global')`.
3. [ ] GREEN: controller, DTOs, módulo (`imports` no molde de `staff-schedule.module.ts`, mais `StaffScheduleModule`; `providers` dos dois serviços e do repositório; `AuditModule` e `PrismaModule` são `@Global`, não precisam entrar em `imports`), registro no `app.module.ts`.
4. [ ] Boot de fumaça sem banco não é exigido aqui (a principal faz o boot real). Conferir que o Nest resolve o módulo: `timeout 600 gate --test src/app.module.spec.ts` se existir spec do módulo raiz; senão registrar no report.
5. [ ] Validação: `TESTCONTAINERS_ENABLED=1 timeout 600 gate --test src/modules/permissions/route-parity.spec.ts`; `timeout 600 gate --test src/modules/people-export/people-export.controller.spec.ts`; typecheck do back; `TESTCONTAINERS_ENABLED=1 timeout 600 gate --changed --base feat/vinculo-vigencia`.

**Aceite:** spec aceites 5 e 22 (parte exportação) e a ligação das rotas dos aceites 1 a 9.

**Risco: crítico (autorização)**
**Crítico:** autorização e entrada de rota — o controller novo decide, só pela chave na classe, quem chega aos dois downloads e valida a query por Zod; um handler sem a chave ou com `@Roles` volta à regra antiga e libera ADMIN e OPERATOR sem permissão.

## Task 11 — Catálogo no front: chave e rótulos da Trilha (front)

**Arquivos:**
- Modificar: `frontend/src/features/permissions/keys.ts` (`PERMISSION_KEYS`, `DEFAULT_MATRIX`, `PERMISSION_LABELS`); specs em `frontend/src/features/permissions/` (`access.spec.ts`, `use-permission.spec.ts`, `matrix-diff.spec.ts`, `components/permissions-matrix.spec.tsx`) só onde contam ou listam as chaves; `frontend/src/features/audit-trail/schemas.ts` (`AUDIT_CATEGORIES`); `frontend/src/features/audit-trail/labels.ts` (`CATEGORY_LABEL`, `ACTION_LABEL`, `FIELD_LABEL`, formatadores de valor); `frontend/src/features/audit-trail/labels.spec.ts`.

**Interfaces:**
- Consome: a chave de T3 e a categoria de T4 (contrato; o front precisa conhecê-las antes de o back enviá-las, porque o parse falha com valor desconhecido).
- Produz: `PermissionKey` do front com `'pessoas.exportar'` (T12 usa em `usePermission`); rótulos da Trilha.

**Contexto vinculado:**
- Espelho de T3: chave por último; `DEFAULT_MATRIX.SUPERVISOR` lista explícita das sete chaves (`pessoas.editar`, `pessoas.inativar`, `escala.alterar`, `telefone.ver_completo`, `equipe.enviar`, `equipe.disparo_amplo`, `trilha.consultar`); OPERATOR igual.
- `PERMISSION_LABELS['pessoas.exportar']` = `{ name: 'Exportar pessoas e escala', description: 'Baixar a lista de pessoas e a escala em CSV ou XLSX. Quem não é administrador exporta só os setores que gerencia.' }`.
- Spec D3, Trilha: "o filtro de tipo ganha 'Planilhas'; as ações novas têm rótulo em português ('Exportou pessoas', 'Exportou escala')."
- DX13 e CX3: `CATEGORY_LABEL.SPREADSHEET = 'Planilhas'`; `ACTION_LABEL['people.export'] = 'Exportou pessoas'`, `['schedule.export'] = 'Exportou escala'`; `FIELD_LABEL`: `format` 'Formato', `statusFilter` 'Situação', `referenceDate` 'Data de referência', `rowCount` 'Linhas', `phoneVisibility` 'Telefone', `periodFrom` 'De', `periodTo` 'Até' (`sector` e `shift` já existem). Formatadores: `statusFilter` active/inactive/all → 'Ativas'/'Inativas'/'Todas'; `phoneVisibility` full/masked/partial → 'Completo'/'Mascarado'/'Completo em parte'; `referenceDate`, `periodFrom`, `periodTo` com `formatDatePtBr` quando o valor é data civil (mesmo molde de `authorizationDate`).
- Regra da tela: "valor de enum nunca aparece cru" (cabeçalho de `labels.ts`).
- GX13 (sem `prettier --write`), GX15.

**Passos:**
1. [ ] RED `labels.spec.ts`: `it('categoria Planilhas e ações Exportou pessoas e Exportou escala')`; `it('campos da exportação com rótulo e valores traduzidos')` (`statusFilter` 'all' → 'Todas'; `phoneVisibility` 'partial' → 'Completo em parte'; `referenceDate` '2026-11-19' → '19/11/2026').
2. [ ] RED nos specs de permissões: `it('SUPERVISOR e OPERATOR não têm pessoas.exportar por padrão')` (em `access.spec.ts` ou onde a matriz padrão é testada); a matriz mostra a linha "Exportar pessoas e escala" (`permissions-matrix.spec.tsx`); ajustar contagens de 8 para 9 onde houver, sem afrouxar (já sabido: `access.spec.ts:14`, que usa `length - 1`, quebra com a chave nova).
3. [ ] GREEN.
4. [ ] Validação: `timeout 600 gate --test src/features/audit-trail/labels.spec.ts`; `timeout 600 gate --test` em cada spec de permissões tocado; `npx tsc -b`; `timeout 600 gate --changed --base feat/vinculo-vigencia`.

**Aceite:** spec D3 (Permissões e Trilha) e base dos aceites 5 e 8 na tela.

**Risco: médio** (catálogo de exibição; quem decide o acesso é a API).

**QA visual (no Fechamento):** (1) Permissões mostra a linha "Exportar pessoas e escala" com a descrição, desmarcada para Supervisor e Operador; (2) Trilha: filtro de tipo com "Planilhas"; (3) evento "Exportou pessoas" com Formato, Setor, Turno, Situação, Data de referência, Linhas e Telefone legíveis, sem código cru.

## Task 12 — Diálogo "Exportar pessoas" e menu de exportação da escala (front)

**Arquivos:**
- Criar em `frontend/src/features/people-export/`: `api.ts`, `download.ts`, `components/export-people-button.tsx`, `components/export-people-dialog.tsx`, `components/export-schedule-menu.tsx` e os specs `download.spec.ts`, `api.spec.ts`, `components/export-people-dialog.spec.tsx`, `components/export-people-button.spec.tsx`, `components/export-schedule-menu.spec.tsx`.

**Interfaces:**
- Consome: `api` (`@/lib/api-client`, ky; timeout padrão 15 s, aqui 120 s por chamada); `readApiErrorBody`/`extractApiError` (`@/lib/api-error`; ky 2: o corpo do erro fica em `HTTPError.data`); `usePermission` (`@/features/permissions/use-permission`); `useScheduleOptions` (`frontend/src/features/staff-schedule/api.ts`: `GET internal/staff-schedule/options` → `{ today, sectors, shifts }`, setores do alcance e turnos ativos); componentes de `components/ui` (`dialog`, `select`, `input`, `label`, `button`, `alert`, `dropdown-menu`, `sonner`).
- Produz: CX7.

**Contexto vinculado:**
- Spec D3, diálogo "Exportar pessoas": Formato (CSV ou XLSX), Setor ("Todos os setores" ou um da lista do alcance), Turno ("Todos" ou um), Situação (Ativas, Inativas, Todas), Data de referência (padrão hoje, com a frase "Em data passada, setor, turno e nível são os que valiam naquele dia. Telefone, função e situação são sempre os atuais."). Botão "Exportar". Para quem não vê telefone completo: "O telefone sairá mascarado."
- Spec D3, Escala: botão "Exportar" na linha de controles, com escolha de CSV ou XLSX; usa o setor e o período da tela. Só para quem tem `pessoas.exportar`.
- Spec D3: "Erro da API aparece como aviso na tela (o texto da API); 403 usa o tratamento de permissão negada que já existe."
- **Erro da exportação (M2):** por `toast.error` (sonner), com o texto da API (`extractApiError`/`readApiErrorBody`; sem texto, "Não foi possível exportar. Tente de novo."). Motivo: no 403 o tratamento global (`api-client.ts:54-66`, `use-session-sync.ts:35`) só relê a sessão; depois disso `ExportPeopleButton` e `ExportScheduleMenu` viram `null` e um aviso dentro do diálogo ou do menu sumiria junto. O toast sobrevive. No diálogo, o erro não fecha o diálogo; no sucesso fecha.
- **Falha ao carregar as opções do diálogo (M9):** `useScheduleOptions` com erro (por exemplo 403 de OPERATOR com a chave e sem setor gerenciado) mostra, dentro do diálogo, um `Alert` de erro com o texto da API (sem texto: "Não foi possível carregar as opções. Tente de novo.") e o botão "Exportar" fica desabilitado; o diálogo não fica mudo e sem opções.
- **Como ler o header (M1):** `const res = await api.get(path, { searchParams, timeout: 120_000 })` (sem `.blob()` encadeado: o `.blob()` direto do padrão de contatos, `features/contacts/api.ts:240-245`, perde os headers); `const name = filenameFromDisposition(res.headers.get('content-disposition'), fallback)`; `const blob = await res.blob()`; `saveBlob(blob, name)`. Nome de arquivo de reserva montado no front se o header não vier: `pessoas.<fmt>` / `escala.<fmt>`. Conferido pelo revisor: o ky 2 deixa o corpo do erro em `error.data` antes de `.blob()`, o filtro grava `application/problem+json` e `extractApiError` lê o `detail`.
- DX11 (nome do arquivo do header `Content-Disposition`, reserva `pessoas.<fmt>` / `escala.<fmt>`; em produção a API é de mesma origem, no desenvolvimento o `Access-Control-Expose-Headers` do back deixa o front ler o header), DX16 (padrões: XLSX, Ativas, `today` das opções).
- Textos fixos deste plano: título do diálogo "Exportar pessoas"; rótulos "Formato", "Setor", "Turno", "Situação", "Data de referência"; botões "Exportar" e "Cancelar"; enquanto baixa, "Exportando…"; erro sem texto da API: "Não foi possível exportar. Tente de novo."; menu da escala: itens "CSV" e "XLSX".
- O diálogo só busca as opções quando aberto (`useScheduleOptions` montado no conteúdo do diálogo), para as telas que o recebem não fazerem consulta nova nos specs existentes. O 403 de permissão segue o tratamento global do `api-client` (só relê a sessão); o aviso do erro é o `toast.error` acima, que não depende do componente continuar montado.
- Padrão de teste: `vi.hoisted` + `vi.mock('@/lib/api-client', () => ({ api: { get } }))` (o `get` devolve `{ headers: new Headers({...}), blob: () => Promise.resolve(blob) }`), `vi.mock('sonner', …)` para espiar `toast.error`, `QueryClient` com `retry: false`; `URL.createObjectURL`/`revokeObjectURL` espionados; erro com `HTTPError`.
- GX15.

**Passos:**
1. [ ] RED `download.spec.ts`: `it('filenameFromDisposition lê filename entre aspas e cai na reserva sem header')`; `it('saveBlob cria o link com o nome, clica e revoga a URL')`.
2. [ ] RED `api.spec.ts`: `it('useExportPeople chama internal/people-export/people com timeout de 120 s e sem parâmetros vazios')`; `it('useExportPeople salva o blob com o nome do Content-Disposition e usa a reserva sem o header')` (M1); `it('useExportSchedule chama internal/people-export/schedule com setor e período')`.
3. [ ] RED `export-people-dialog.spec.tsx`: `it('campos, opções e frase da data de referência com os textos da spec')`; `it('padrões: XLSX, Todos os setores, Todos, Ativas e a data de hoje das opções')`; `it('defaultSectorId já vem escolhido')`; `it('mostra "O telefone sairá mascarado." só sem telefone.ver_completo')`; `it('Exportar envia os filtros e fecha; erro chama toast.error com o texto da API e não fecha')`; `it('falha ao carregar as opções mostra erro com o texto da API e desabilita Exportar')` (M9).
4. [ ] RED `export-people-button.spec.tsx`: `it('não aparece sem pessoas.exportar')`; `it('abre o diálogo')`. RED `export-schedule-menu.spec.tsx`: `it('não aparece sem pessoas.exportar')`; `it('CSV e XLSX exportam o setor e o período recebidos')`; `it('erro chama toast.error com o texto da API')`.
5. [ ] GREEN. `prettier --write` só nos arquivos novos.
6. [ ] Validação: `timeout 600 gate --test` em cada spec criado; `npx tsc -b`; `timeout 600 gate --changed --base feat/vinculo-vigencia`.

**Aceite:** spec D3 (diálogo e menu) e base dos aceites 1, 2, 5 e 7 na tela.

**Risco: médio** (tela; a API decide acesso e máscara).

**QA visual (no Fechamento):** (1) diálogo com os cinco campos, opções e a frase da data de referência literais; (2) aviso "O telefone sairá mascarado." para um usuário sem a chave de telefone; (3) erro 422 aparece como aviso com o texto da API, sem baixar arquivo; (4) menu da Escala com CSV e XLSX; (5) arquivo baixado com o nome do servidor (`pessoas-AAAA-MM-DD.xlsx`, `escala-<setor>-…`).

## Task 13 — Botões nas telas e Novidades (front)

**Arquivos:**
- Modificar: `frontend/src/routes/_authenticated/users/index.tsx` (`UsersHeader`: `<ExportPeopleButton />` ao lado de "Cadastrar usuário"); `frontend/src/routes/_authenticated/setores/$sectorId.tsx` (`SectorHeader`: `<ExportPeopleButton defaultSectorId={sectorId} />`); `frontend/src/routes/_authenticated/escala/index.tsx` (linha de controles de `ScheduleContent`: `<ExportScheduleMenu sectorId from to />` quando há setor escolhido); `frontend/src/release-notes.ts` (entrada no topo). Specs das três rotas, que existem (conferido): `frontend/src/routes/_authenticated/users/index.spec.tsx`, `frontend/src/routes/_authenticated/setores/$sectorId.spec.tsx`, `frontend/src/routes/_authenticated/escala/index.spec.tsx` (entram no ownership; precisam do `vi.mock` do módulo novo se quebrarem, e ganham um `describe` novo cada).

**Interfaces:**
- Consome: CX7 (`ExportPeopleButton`, `ExportScheduleMenu`); o setor e o período já calculados na tela da Escala (`features/staff-schedule/period.ts`).
- Produz: os pontos de entrada da spec D3 e a nota de versão.

**Contexto vinculado:**
- Spec D3: botão "Exportar" no cabeçalho de **Usuários** e no cabeçalho da **página do setor** (já com o setor escolhido); na **Escala**, botão "Exportar" na linha de controles. Só aparecem para quem tem `pessoas.exportar`.
- A tela de Usuários é só do ADMIN (`beforeLoad`); a página do setor e a Escala atendem os demais papéis.
- Specs existentes das três rotas (`users/index.spec.tsx`, `setores/$sectorId.spec.tsx`, `escala/index.spec.tsx`): se um spec quebrar pelo componente novo, isolar com `vi.mock('@/features/people-export/components/…', () => ({ … : () => null }))` no topo; nunca mexer em asserção existente.
- `frontend/CLAUDE.md`: entrada nova no topo de `RELEASE_NOTES`, pt-BR para o operador, `where` só quando há tela para linkar. DX18: versão `2026.11.19.3` se hoje; senão `AAAA.MM.DD` do dia.
- Texto: título "Exportar pessoas e escala"; itens: (1) "Em Usuários e na página de cada setor, o botão Exportar baixa a lista de pessoas em CSV ou XLSX, filtrada por setor, turno, situação e data de referência." (`where: '/users'`, se for o caminho da rota; conferir); (2) "Na Escala, o botão Exportar baixa o quadro do setor e do período na tela." (`where: '/escala'`, conferir); (3) "Quem não pode ver o telefone completo recebe o telefone mascarado, e toda exportação fica registrada na Trilha de alterações, no tipo Planilhas. O administrador libera a exportação para Supervisor e Operador em Permissões." (sem `where`).
- GX13: sem `prettier --write` nesses arquivos existentes.

**Passos:**
1. [ ] Montar os três botões e a nota. Em cada um dos três specs existentes, `describe` novo: `it('Exportar aparece no cabeçalho para quem tem pessoas.exportar')`. Conferir o `where` das Novidades (`/users`, `/escala`) contra os caminhos reais das rotas e, ao escolher o item da nota, o `where` já usado em outras entradas de `RELEASE_NOTES`.
2. [ ] Validação: `timeout 600 gate --test src/release-notes.spec.ts`; `timeout 600 gate --test` em cada um dos três specs das rotas (um por chamada); `npx tsc -b`; `timeout 600 gate --changed --base feat/vinculo-vigencia`.

**Aceite:** spec D3 (onde abre; Novidades) e a parte de tela do aceite 5.

**Risco: baixo** (composição de componentes já testados e nota de versão).

**QA visual (no Fechamento):** (1) "Exportar" no cabeçalho de Usuários, ao lado de "Cadastrar usuário"; (2) "Exportar" no cabeçalho da página do setor, abrindo com o setor escolhido; (3) "Exportar" na linha de controles da Escala; (4) Supervisor sem a chave não vê nenhum dos três; com a chave liberada, vê os da página do setor e da Escala; (5) nota em Novidades com os três itens.

## Fechamento (principal)

1. Conferir o ledger: T1 a T7, T8a, T8b e T9 a T13 aceitas; revisões críticas com `opus` feitas (T3, T6, T7, T8a, T8b, T9, T10).
2. Gate completo do back e do front, uma vez cada, no estado final, comparado com a base do Lote C (`.superpowers/sdd/2026-11-19-orgamind-gbr-etapa1-lote-c-vinculo/final-back-gate-full.log` e `final-front-gate-full.log`; memória: o completo usa `--base origin/main`, com dívida legada conhecida). Bloquear violação nova ou agravada; conferir a cobertura das linhas novas.
3. Migrações no banco local de QA (stack `orgamind-turnos-qa`, seed fictício Marina/Rafael): antes, `count(*)` de `RolePermission` e de `AuditEvent`; `prisma migrate deploy`; depois, `RolePermission` com +2 linhas (`pessoas.exportar`, `granted=false`, SUPERVISOR e OPERATOR), nenhuma linha antiga alterada; `SELECT unnest(enum_range(NULL::"AuditCategory"))` inclui `SPREADSHEET`; `AuditEvent` inalterado.
4. Boot real da API e do worker na stack local (o worker não carrega o módulo novo; só confirmar que sobe).
5. Fumaça HTTP (aceites 1 a 10), arquivos guardados numa pasta de evidências do lote:
   - ADMIN: CSV filtrado por setor e turno; conferir byte a byte (`od -c | head`): começa por `EF BB BF`, separador `;`, linhas terminadas em `\r\n`, cabeçalho igual a `PEOPLE_EXPORT_COLUMNS`; só as pessoas do filtro (aceite 1). XLSX: `unzip -l` com duas abas e `unzip -p … xl/workbook.xml` com "Pessoas" e "Instruções" (aceite 2).
   - Pessoa sem acesso criada com nome `=SOMA(1;2)`: no CSV `"'=SOMA(1;2)"`, no XLSX texto (aceite 9).
   - Supervisor com `pessoas.exportar` liberado pela tela de Permissões: setor que gerencia → 200; setor alheio → 403; sem a chave → 403 com o texto da spec (aceites 4 e 5). Sem `telefone.ver_completo` → telefones mascarados; com a chave, pessoa com login mascarada (aceite 3).
   - Pessoa movida hoje de A para B: data de ontem traz a pessoa em A (aceite 6).
   - Gestor de A com `telefone.ver_completo` e data passada: pessoa sem login que estava em A e hoje está fora do alcance dele sai com telefone e nome mascarados (M8a; Review Focus 2d).
   - Escala de setor alheio: gestor pede `/schedule` de um setor que não gerencia → 403 sem `Content-Disposition` e sem evento na Trilha (M8b).
   - Escala de um setor numa semana: textos de turno, `Folga`, `Férias`, `Em <setor>` iguais aos do quadro na tela (aceite 7).
   - `GET /audit-trail?category=SPREADSHEET` (ou o filtro equivalente) mostra cada exportação com autor, data, filtros e quantidade (aceite 8).
   - Headers de cada 200 (`curl -D -`): os cinco de CX1; um 422 e um 403 sem `Content-Disposition`.
   - Reabrir os arquivos numa planilha: se a máquina tiver LibreOffice, `soffice --headless --convert-to csv` do XLSX e abrir o CSV conferindo acentos e colunas; se não tiver, registrar como não verificado. Aceite 10: só a parte da aba Instruções (DX17); o resto fica para o Lote E.
6. QA visual (agente `qa`, Playwright): os critérios listados em T11, T12 e T13.
7. Revisão final do conjunto com `opus`.
8. Atualizar este plano com a seção "Estado" (feito, validação, pendências, próximo).
9. Commit do lote e PR rascunho sobre `feat/vinculo-vigencia`, conforme a autorização vigente do plano GBR (memória: commit e PR rascunho liberados; merge e deploy só com pedido explícito).
10. Registrar na spec, em "Para a GBR confirmar" → decisões do Lote D: DX3 (chave na classe sem `@Roles`; papéis pela matriz), DX12 (403 igual para setor alheio e inexistente; 404 para ADMIN), DX16 (XLSX como formato padrão), DX19 (apóstrofo: regra ampliada e só no CSV) e o texto "Completo em parte" da Trilha.

## Não verificado

- Os caminhos exatos das rotas para o `where` das Novidades (`/users`, `/escala`); a T13 confere.
- Tempo e memória de uma exportação de 50.000 pessoas no VPS (não há base desse tamanho; a GBR tem centenas).

## Já verificado (revisão 1 do plano; não repetir)

- `transform` em DTO de query funciona com o `ZodValidationPipe` global (T5). `findTeamActor` devolve ator com `isActive: false`, não nulo (T8a, regra `!actor || !actor.isActive || !actor.hasAccess`).
- ky 2 lê o corpo do erro em `error.data` antes de `.blob()`; o filtro grava `application/problem+json`; `extractApiError` lê o `detail`; o 403 `auth.permission_denied` só dispara a releitura da sessão (T12).
- A Trilha geral mostra evento com `subjectUserId` nulo (`category: query.category ?? { not: null }`, `audit-trail.service.ts:52-58`).
- `Content-Disposition` entre origens: o `cors` sem `exposedHeaders` não sobrescreve header gravado no handler; em produção a API é de mesma origem (DX11).
- Enums `ContactAuthorizationSource` e `ContactAuthorizationStatus` (`schema.prisma:47-58`) para a T7. `board-cells.spec.ts` existe e `cellLabel` bate com a T9.
- Postgres 16 em produção, dev e testcontainer: `ALTER TYPE ... ADD VALUE` roda na transação (T4); INSERT da T3 compatível (`updatedAt` tem DEFAULT).
- `StaffScheduleModule` exporta só o repositório (T9 acrescenta o serviço); `AuditModule` e `PrismaModule` são `@Global`.
- LibreOffice na máquina: não é pré-requisito; o passo 5 do Fechamento registra "não verificado" se faltar.
