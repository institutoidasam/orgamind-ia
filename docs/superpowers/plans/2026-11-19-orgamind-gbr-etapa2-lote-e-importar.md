# OrgaMind, Etapa 2 GBR, Lote E: importar pessoas (CAD-03). Implementation Plan

> **Para os agentes:** executar pela skill `sdd` (TDD, ledger em `.superpowers/sdd/2026-11-19-orgamind-gbr-etapa2-lote-e-importar/progress.md`). **Sem commit/push**: nenhuma task commita; a principal integra e commita o lote. Branch `feat/importar-pessoas`, criado sobre `feat/planilhas-pessoas` (Lote D, commitado, PR 16). Fechamento de task por `gate --changed --base feat/planilhas-pessoas`. Regras dos agentes: `.superpowers/sdd/2026-11-19-orgamind-gbr-etapa2-lote-e-importar/implementer-rules.md` (e `reviewer-rules.md` na mesma pasta, Preparação). Este plano cita arquivo e símbolo; linhas citadas são pistas e podem ter mudado.

**Goal:** quem tem `pessoas.importar` baixa o modelo, envia uma planilha CSV ou XLSX de pessoas, confere o mapeamento das colunas, vê na prévia o que cada linha vai fazer (Criar, Atualizar, Sem alteração, Inválida, Duplicada, Conflito, Ignorada), escolhe o conjunto e confirma; a API grava linha a linha pelo mesmo caminho do cadastro manual (`UsersService`), em blocos pedidos pela tela, sem gravar duas vezes; as linhas que não entraram saem num relatório CSV; cada lote fica registrado e aparece na Trilha, tipo Planilhas.

**Architecture:** leitores novos em `backend/src/shared/spreadsheet/` (`sheet-data.ts`, `csv-reader.ts`, `xlsx-reader.ts`), ao lado dos escritores do Lote D. Módulo novo `backend/src/modules/people-import/`: funções puras de leitura das células, mapeamento, estrutura, autorização, diff e classificação; dois repositórios (leitura/prévia e gravação/reserva); serviços de prévia, consulta, arquivos (modelo e relatório), confirmação e gravação em blocos; um controller com `@RequirePermission('pessoas.importar')` na classe. Duas tabelas novas (`PeopleImportBatch`, `PeopleImportRow`), em migração própria, e a chave nova em outra. Front: feature nova `frontend/src/features/people-import/` e rota `/importar-pessoas` em quatro passos, com a lista dos lotes.

**Tech Stack:** NestJS + Prisma 6 + Zod v4 (`createZodDto`) + `exceljs` + `libphonenumber-js` + multer (já usado) + Vitest/testcontainers no back; React + TanStack Router/Query + ky 2 + Radix (`components/ui`) + Vitest/Testing Library no front. **Sem dependência nova** (spec, Restrições).

**Spec:** `docs/superpowers/specs/2026-11-19-orgamind-gbr-etapa2-planilhas.md` — "Comum aos dois lotes", "Lote E" (E1–E8), Restrições, Anti-objetivos, "Para a GBR confirmar", aceites 10 e 11–28. Mapas em `.superpowers/sdd/2026-11-19-orgamind-gbr-etapa2-planilhas/fontes/`. Plano-modelo e contratos prontos: `docs/superpowers/plans/2026-11-19-orgamind-gbr-etapa2-lote-d-exportar.md`.

## Estado (20/11/2026)

- **Lote E implementado e validado; Fechamento passos 1–9 feitos** (ledger `.superpowers/sdd/2026-11-19-orgamind-gbr-etapa2-lote-e-importar/progress.md`). As 32 tasks aceitas com revisão por risco; varreduras de minors do back (A e B) e do front feitas.
- Gates completos (estado final, um de cada vez, `--base origin/main`): back TESTES 6683/6713 (30 ignorados, 0 falhas), COVERAGE 95.0/86.7; front TESTES 2200/2200, COVERAGE 88.1/81.7; LINT/SONAR/COMPLEXIDADE iguais à base do Lote D (back 7517/733, 92, 723; front 105/4, 18, 228) — por arquivo 0 pares acima, ancorado 0 novos e 0 agravados.
- Migrações aplicadas no banco local de QA (`picoa_dev`): +2 linhas de permissão negadas, tabelas novas vazias, pessoas e trilha inalteradas. Fumaça HTTP num clone descartável (`picoa_smoke`, apagado no fim): antes 13/13, ADMIN 17/17, gestor (aceites 24/27) e carga (blocos de 50 em 1,7–2,0 s; CSV de 5.000 em 1,0 s; XLSX de 3,6 MB em 1,3 s; API até 1,2 GiB em modo dev).
- QA visual: 5/5 critérios (o "FAIL" do negativo de Setor era critério errado: Setor só é obrigatório para quem não é ADMIN). Revisão final do conjunto (`opus`): NEEDS_FIXES com I1 (confirmar numa aba depois de remapear em outra) → corrigido (a confirmação leva o mapeamento que a tela mostrou; 409 `preview_changed`, diálogo fecha e seleção zera) junto com m1 (`\p{Cf}` no nome do arquivo) e o GET de linhas refeito depois de confirmar; re-review `opus` APPROVED; fumaça 7/7 e QA de duas abas PASS. Teste do roundtrip que dependia da data real corrigido na fixture.
- Backlog (Minor): m2 `canRemap` (ADMIN vê colunas editáveis na prévia de lote alheio; remapear dá 403); m3 texto do `preview_changed` duplicado no front; 422 `mapping_incomplete` em vez de 409 quando a outra aba grava mapeamento incompleto; XLSX de carga medido com 3,6 MB, não 5 MB.
- Próximo passo: passo 10 (commits, push e PR rascunho sobre `feat/planilhas-pessoas`); depois Etapa 3 do plano GBR. Deploy não faz parte.

## Estado anterior (19/11/2026)

- **Plano aprovado na re-revisão 2 (revisor `opus`, 19/11, APPROVED); minors m1–m8 aplicados** (`.superpowers/sdd/2026-11-19-orgamind-gbr-etapa2-lote-e-importar/plan-review-2.md`: m1 e m2 em EX17.4 e T20a; m3 no Fechamento; m4 e m8 em T13b/EX13/CX11; m5 no Review Focus; m6 em CX12; m7 em T22a). Implementação em andamento: T1, T2, T3, T11a, T14, T23 e T24 não foram tocadas por esses ajustes.
- Histórico: plano escrito e ajustado pela revisão 1 (revisor `opus`: I1, I2, I3, I5, M1–M12, riscos por task, lacunas de cobertura). Os pontos 1–5 e 7–10 da coordenação estão confirmados e foram para "Decisões deste plano"; o ponto 6 foi revogado pelo Conselho S.
- **Conselho S aplicado (19/11):** sentença em `~/.claude/tribunais/2026-11-19/conselho-S/sentenca-S.md` (S1 = S1-b ajustada; S2 = S2-a com I1), mais o ruling da coordenação sobre a linha de criação achada de novo na gravação (EX17.4). Texto em EX9, EX15, EX17, EX19–EX22; testes na tabela "Testes do Conselho S e da retomada" (depois de EX17), copiados nos passos RED das tasks donas.
- Próximo passo: seguir a Ordem a partir da Onda 1 (em andamento); T13b, T20a e T22a levam os ajustes dos minors no brief.

## Preparação (principal, antes da T1)

1. Conferir que `feat/planilhas-pessoas` (Lote D) está commitado e que `feat/importar-pessoas` parte dele (o `--changed` mediria o Lote D junto se não estiver).
2. Conferir `.superpowers/sdd/2026-11-19-orgamind-gbr-etapa2-lote-e-importar/implementer-rules.md` (já existe) e criar `reviewer-rules.md` na mesma pasta, copiado do Lote D com o cabeçalho "Comuns a este plano" adaptado (branch, base `feat/planilhas-pessoas`, plano e ledger deste lote; referências `EXn`, `GXn` e `CXn` anexadas no fim do brief).
3. Criar o ledger `progress.md` com a referência Git de partida.
4. **Sentença do Conselho S:** feita (19/11): sentença em `~/.claude/tribunais/2026-11-19/conselho-S/sentenca-S.md`; spec atualizada (E4, E6, E7 e "Para a GBR confirmar", marcas "(conselho S)").

## Ordem e paralelismo

```
Onda 1:  T1 (chave back)  T2 (tabelas)  T3 (leitor CSV)  T11a (contrato, erros, textos, tipos das linhas)
         T14 (motivo na criação)  T23 (catálogo front)  T24 (api front)
Onda 1b: T7 (estrutura) <- T11a      T11b (trilha e ator) <- T1, T11a
Onda 2:  T4 (leitor XLSX) <- T3      T5 (mapeamento) <- T11a      T6 (células) <- T11a, T14
         T8 (autorização) <- T11a    T12 (repo leitura) <- T2, T7, T11a
         T13a (repo confirmação e reserva) <- T2, T11a    T13b (repo conclusão e encerramento) <- T2, T11a
         T25 (passos Arquivo e Colunas) <- T24   T26 (passo Prévia) <- T24
Onda 3:  T9 (diff e versão) <- T6, T7, T8, T11a, T14
         T17 (consulta) <- T5, T6, T11a, T11b, T12, T13b    T27 (gravação na tela) <- T24
Onda 4:  T10 (classificação) <- T6, T7, T8, T9, T11a, T11b
         T18 (modelo e relatório) <- T5, T11b, T12, T13b, T17
         T19 (confirmar, encerrar, concluir) <- T5, T11a, T11b, T13a, T13b, T17
Onda 5:  T15 (classificador do lote) <- T5, T6, T8, T10, T11a, T11b, T12
         T20a (gravação da linha) <- T7, T9, T11a, T11b, T12, T14
Onda 6:  T16 (envio, remapear, descartar) <- T3, T4, T5, T6, T11a, T11b, T12, T15, T17, T19
         T20b (bloco) <- T11a, T11b, T12, T13a, T17, T19, T20a
Onda 7:  T21 (controller e rotas) <- T1, T11a, T16, T17, T18, T19, T20b    T22a (ponta a ponta 1) <- T16, T17, T18, T19, T20b
         T28 (página, lista, menu, Novidades) <- T23, T24, T25, T26, T27
Onda 8:  T22b (ponta a ponta 2: aceites 10, 28, 21, 25) <- T22a
```

- **Conferido na revisão 1 (I3):** nenhuma task consome algo de task da mesma onda ou de onda posterior; o "Consome" de cada task lista tudo o que ela usa; os tipos das linhas que várias ondas usam ficam em `import-person.ts` (T11a, CX14), e `fromSheetReadError`, que precisa do `SheetReadError` da T3, fica na T16.
- **Carga da máquina:** a onda diz dependência, não obrigação de rodar tudo junto. No máximo **duas** tasks com teste de integração (testcontainers) ao mesmo tempo (Onda 2 tem três: T12, T13a, T13b); o gate completo e a stack de QA nunca junto de outra coisa (memória: falha espúria e reinício em 19/11).
- **Ownership disjunto dentro de cada onda:**
  - Onda 1. T1: `shared/authz/permissions.ts`, `shared/authz/permissions.spec.ts`, `schemas/contracts/permissions.schema.spec.ts`, `permissions/role-permissions-migration.integration.spec.ts`, `sector-people/sector-people.repository.integration.spec.ts`, pasta `prisma/migrations/20261119130000_people_import_permission/`, `permissions/people-import-permission-migration.integration.spec.ts`. T2: `prisma/schema.prisma`, pasta `prisma/migrations/20261119130100_people_import_tables/`, `people-import/people-import-tables-migration.integration.spec.ts`. T3: `shared/spreadsheet/{sheet-data,csv-reader}.ts` e specs. T11a: `schemas/contracts/people-import.schema.ts` e spec, `people-import/{people-import.errors,row-texts,import-person}.ts`, `people-import.errors.spec.ts` (`import-person.ts` só tipos, sem spec). T14: `users/users.service.ts`, `users/users.service.reason.spec.ts` (novo). T23: `frontend/src/features/permissions/` (só keys e specs) e `frontend/src/features/audit-trail/{schemas,labels}.ts` e `labels.spec.ts`. T24: `frontend/src/features/people-import/{schemas,api,labels}.ts` e specs.
  - Onda 1b. T7: `people-import/structure-match.ts` e spec. T11b: `people-import/{import-trail,import-actor}.ts` e specs.
  - Onda 2. T4: `shared/spreadsheet/{xlsx-reader,zip-size}.ts` e specs. T5: `people-import/mapping.ts` e spec. T6: `people-import/cell-values.ts` e spec. T8: `people-import/authorization-plan.ts` e spec. T12: `people-import/people-import.repository.ts` e `people-import.repository.integration.spec.ts`. T13a: `people-import/people-import-write.repository.ts`, `people-import-write.repository.integration.spec.ts`, `people-import-reserve.integration.spec.ts`. T13b: `people-import/people-import-close.repository.ts`, `people-import-close.repository.integration.spec.ts`. T25: `features/people-import/components/{file-step,mapping-step}.tsx` e specs. T26: `features/people-import/components/{preview-step,preview-table,confirm-dialog}.tsx` e specs.
  - Onda 3. T9: `people-import/person-diff.ts` e spec. T17: `people-import/{people-import-query.service,row-view}.ts` e specs. T27: `features/people-import/use-write-loop.ts`, `components/{writing-step,result-step}.tsx` e specs.
  - Onda 4. T10: `people-import/{classify-row,duplicates,classify-row.fixtures}.ts` e specs (`classify-row.spec.ts`, `classify-row.reach.spec.ts`, `duplicates.spec.ts`). T18: `people-import/{people-import-files.service,import-template}.ts` e specs. T19: `people-import/people-import-confirm.service.ts` e spec.
  - Onda 5. T15: `people-import/batch-classifier.ts` e spec. T20a: `people-import/row-writer.ts`, `row-writer.spec.ts`, `row-writer.integration.spec.ts`.
  - Onda 6. T16: `people-import/people-import-preview.service.ts`, `upload-format.ts` e specs. T20b: `people-import/people-import-writer.service.ts` e spec.
  - Onda 7. T21: `people-import/{people-import.controller,people-import.module,spreadsheet-upload.interceptor}.ts`, `people-import/dto/`, `people-import.controller.spec.ts`, `app.module.ts`, um item na lista `CLASS_KEY_CONTROLLERS` de `permissions/route-parity.spec.ts`. T22a: `people-import/people-import.e2e.fixtures.ts`, `people-import.e2e.integration.spec.ts`. T28: `routes/_authenticated/importar-pessoas/` (rota e spec), `features/people-import/components/{import-page,steps-header,batch-list}.tsx` e specs, `lib/nav.ts` e o spec dele, `routes/_authenticated/users/index.tsx` e `users/index.spec.tsx`, `release-notes.ts`, `routeTree.gen.ts` (gerado).
  - Onda 8. T22b: `people-import/people-import.e2e-roundtrip.integration.spec.ts` (usa as fixtures da T22a sem mudá-las; se precisar de uma fábrica nova, cria no próprio spec).
- **Gate conjunto:** com tasks paralelas no mesmo working tree, o `--changed` de cada uma mede o diff das outras. Falha que vem só de arquivo de outra task em andamento vai para o report, sem correção. A principal roda o `--changed` conjunto (back e front) depois de cada onda (1, 1b, 2…).
- **Revisão** (SKILL.md do sdd, §Revisão por risco; riscos ajustados pela revisão 1):
  - **Críticas, revisor `opus`:** T1, T7, T8, T10, T11b, T13a, T13b, T15, T16, T17, T18, T19, T20a, T20b, T21 (autorização: chave, alcance, travas de quem não é ADMIN, autorização de contato, visibilidade do lote, máscara de nome e telefone, telefone já cadastrado sem a chave — Conselho S, quem confirma/continua/encerra; produção: gravar uma vez só e apagar o que o arquivo trouxe). T15 subiu a crítica com o Conselho S: é ela que garante que a consulta do lote não recebe telefone de quem não tem a chave.
  - **Alto, revisor `opus`** (decisão da coordenação): T2 (migração aditiva com dado pessoal do arquivo), T11a (contrato público e tipos que todas as ondas usam).
  - **Alto, revisor `sonnet`:** T3, T4 (entrada não confiável), T6, T9, T12, T14 (caminho único de gravação; id da pessoa dado pela importação, EX17.4), T22a, T22b, T27 (concorrência no cliente).
  - **Médio:** T5, T23, T24, T25, T26, T28.
  - Total: **32 tasks** (15 críticas, 11 altas, 6 médias), em 9 ondas (1, 1b, 2–8).

## Decisões deste plano (registradas para o ledger)

**Confirmadas pela coordenação (revisão 1).** Os pontos 1–5 e 7–10 que estavam em "Para a coordenação decidir" ficam como recomendei, todos *(decisão minha, confirmada pela coordenação)*; o texto completo de cada um está na EX citada:
- Ponto 1 → EX12: a versão da pessoa é o SHA-256 dos campos que a importação lê e grava, não `User.updatedAt` (que muda a cada login: `lastLoginAt`, `sessionVersion`, e faria a linha de pessoa com login falhar à toa).
- Ponto 2 → EX12: a janela de milissegundos entre a conferência da versão e a transação do `updateUser` é aceita (fechá-la exigiria mudar `UsersRepository.updateWithLastAdminGuard`).
- Ponto 3 → EX13: autor do encerramento automático = quem confirmou o lote, com o motivo "Encerrada automaticamente: gravação interrompida há mais de 7 dias." (não quem enviou o arquivo que disparou a limpeza).
- Ponto 4 → EX25: só quem enviou remapeia e confirma, inclusive contra o ADMIN (a prévia foi calculada com as permissões de quem enviou); o ADMIN vê, descarta e encerra lote alheio.
- Ponto 5 → EX14: descartar apaga lote e linhas. **A GBR confirma** (vai para "Para a GBR confirmar" no Fechamento).
- Ponto 6 → **revogado pelo Conselho S** (S2-a com I1): telefone vazio de pessoa achada pela matrícula é preenchido pela planilha, sem conferir se está livre na prévia (EX17.2). A recomendação original (nunca preencher) caiu.
- Ponto 7 → EX19: trava que mudou entre a prévia e a gravação faz a linha falhar com o texto da trava (não grava a linha sem o campo, em silêncio).
- Ponto 8 → EX18: "Sim" + "Outro" sem detalhe = autorização ignorada com o aviso `authorizationWithoutNote`; a linha segue válida.
- Ponto 9 → EX4: 422 `people_import.file_too_large`, "O arquivo passa de 5 MB. Divida a planilha e envie em partes."
- Ponto 10 → EX3: `workbook.xlsx.load(buffer)` com o teto de 5 MB, mais o acréscimo do revisor: teto do tamanho descompactado lido do diretório central do zip antes de abrir, e leitura só das linhas com valor.

**Conselho S e coordenação (19/11).** Sentença em `~/.claude/tribunais/2026-11-19/conselho-S/sentenca-S.md`:
- S1 → EX17.3 (S1-b ajustada): sem a chave, a prévia não compara telefone com o cadastro (aviso fixo no topo, `phoneCheckDeferred`); a gravação falha `phoneTaken`; contador `phoneTaken` no lote e na trilha.
- S2 → EX17.2 (S2-a com I1): preenche telefone vazio; telefone gravado nunca comparado; trava antes de "Sem alteração" também na gravação.
- Ruling da coordenação → EX17.4: linha de criação só vira "Sem alteração" quando a pessoa foi criada pela própria linha (id guardado na reserva); sem a chave, nunca por coincidência. *Mecanismo e contador pelas linhas: decisão minha, sobre o ruling.*

- **EX1. Onde fica cada coisa.** Leitores em `backend/src/shared/spreadsheet/` (`sheet-data.ts`: tipos, limites e `SheetReadError`; `csv-reader.ts`; `xlsx-reader.ts`), sem importar nada de `src/modules/` (regra GX17 do Lote D). O conserto de XLSX dos contatos (`normalizeXlsxForExceljs`, `backend/src/modules/excel-import/xlsx-normalizer.ts`) entra por parâmetro (`repair`), passado pelo módulo de importação. Tudo o que conhece pessoas fica em `backend/src/modules/people-import/`. Escrita de CSV/XLSX, cabeçalhos de download, `PEOPLE_TEMPLATE_COLUMNS`, `AUTHORIZATION_SOURCE_CELL`, `YES_NO_CELL` e `unguardFormula` são os do Lote D, sem reimplementar.
- **EX2. Leitor de CSV próprio** *(decisão minha; a spec proíbe dependência nova)*: (1) tira o BOM UTF-8; (2) decodifica UTF-8 estrito (`new TextDecoder('utf-8', { fatal: true })`); se falhar, Windows-1252 por tabela própria: `buffer.toString('latin1')` e troca dos 27 caracteres de 0x80–0x9F pelos do Windows-1252 (€, ‚, ƒ, „, …, †, ‡, ˆ, ‰, Š, ‹, Œ, Ž, ‘, ’, “, ”, •, –, —, ˜, ™, š, ›, œ, ž, Ÿ), sem depender do ICU do Node; (3) separador pela linha de cabeçalho: conta `;` e `,` fora de aspas; mais `,` que `;` → `,`; senão `;`; (4) registros pelo padrão de aspas (campo entre aspas pode ter separador, aspas dobradas e quebra de linha; fim de linha CRLF, LF ou CR); aspas sem fechamento → erro com a linha; só a aspa no **início** do campo abre campo entre aspas: aspa no meio de campo sem aspas é texto (`ab"c` → `ab"c`; revisão 1, M5); (5) `unguardFormula` em cada célula de dado (só no CSV, DX19 do Lote D); (6) cada registro vai para o `SheetCollector` (CX6): registro todo vazio depois do cabeçalho não é guardado, e o registro com valor de número 5.001 para a leitura com `too_many_rows` (nada de acumular o arquivo inteiro nem linhas em branco; revisão 1, M5). Número da linha = número do registro (cabeçalho = 1), que é o que o Excel mostra; linha em branco descartada deixa um buraco na numeração, não muda a das outras.
- **EX3. Leitor de XLSX** *(decisão minha, confirmada pela coordenação — ponto 10, com o acréscimo do revisor)*: (1) antes de abrir, `zipUncompressedTotal(buffer)` (`shared/spreadsheet/zip-size.ts`, T4) acha o registro de fim do diretório central (assinatura `0x06054b50`, procurada de trás para a frente nos últimos 65.557 bytes), percorre as entradas do diretório central (assinatura `0x02014b50`; tamanho descompactado = inteiro de 4 bytes little-endian no deslocamento 24 da entrada; a entrada seguinte começa em 46 + os tamanhos de nome, extra e comentário, lidos nos deslocamentos 28, 30 e 32) e soma, sem descompactar nada; soma acima de `XLSX_MAX_UNCOMPRESSED` (60 MB) → `expands_too_much`; diretório ilegível ou ZIP64 (`0xFFFFFFFF`) → `unreadable`. (O `jszip`, já dependência direta, também lê só o diretório, mas guarda o tamanho num campo interno sem tipo, `_data.uncompressedSize`; a leitura direta é função pura, tipada e testável com o zip que o próprio `exceljs` escreve.) (2) `new ExcelJS.Workbook().xlsx.load(buffer)`; se lançar, `repair(buffer)`, confere (1) de novo no reparado e tenta de novo; ainda falhando → `unreadable`. (3) Primeira aba; cabeçalho na linha 1; só as linhas com valor (`worksheet.eachRow({ includeEmpty: false }, …)`), cada uma passada ao `SheetCollector`, que descarta a toda vazia e para no limite. Célula: fórmula → `result`; data → `AAAA-MM-DD` pelos campos UTC da `Date` (o `exceljs` devolve a data civil à meia-noite UTC); número → `String(n)`; booleano → `Sim`/`Não`; rich text → textos concatenados; hyperlink → `text`; erro e vazio → `''`. Lida crua (sem `unguardFormula`).
- **EX4. Limites e tipo do arquivo** *(decisão minha, confirmada pela coordenação — ponto 9)*: `IMPORT_MAX_BYTES = 5 * 1024 * 1024`, `IMPORT_MAX_ROWS = 5_000` (linhas de dados com valor; linha toda vazia não conta, em qualquer lugar do arquivo), `XLSX_MAX_UNCOMPRESSED = 60 * 1024 * 1024` (EX3). **Nome do arquivo** (revisão 1, M6): o multer (busboy) entrega `originalname` em latin1; `uploadedFileName(originalname)` (`upload-format.ts`, T16) converte para UTF-8 (`Buffer.from(nome, 'latin1').toString('utf8')`; se o resultado tiver `�`, fica o original), tira o caminho (último trecho depois de `/` ou `\`) e corta em 255 caracteres (o `VarChar(255)` de `PeopleImportBatch.fileName`). O multer recebe `limits: { fileSize: IMPORT_MAX_BYTES, files: 1 }`; o `SpreadsheetUploadInterceptor` estende `FileInterceptor('file', …)` e troca o `PayloadTooLargeException` do multer por `importFileTooLarge()` (422). Tipo pela extensão (`.csv`/`.xlsx`, sem diferenciar maiúsculas) **e** pelo conteúdo: `.xlsx` precisa começar por `PK\x03\x04`; `.csv` não pode. Outro caso → 422 `people_import.invalid_file`. O MIME do navegador não é usado (varia para CSV).
- **EX5. Tabelas** (CX5): `PeopleImportBatch` e `PeopleImportRow`, com enums próprios; ids de pessoa sem FK (como `UserAssignment.recordedById`), para apagar pessoa nunca travar nem apagar o registro do lote. `cells` é um objeto `{ "<índice da coluna>": "texto" }` em `jsonb`, para limpar colunas com `cells - ARRAY[...]::text[]` num `UPDATE` só.
- **EX6. Prévia guardada e paginada:** cada linha guarda `classification`, `reasons`, `warnings`, `preview` (`{ personName, diff }`) e `plan` (o que gravar) no envio. Página de 50, ordem do número da linha, filtro opcional por classificação. Remapear = ler as `cells`, reclassificar tudo e trocar as linhas (`deleteMany` + `createMany` em blocos de 1.000) numa transação, só com o lote em prévia; o remapear relê o ator (`loadImportActor`) e roda `assertCanWrite` de novo com as permissões de agora, e a nova classificação usa o alcance e as chaves de agora (revisão 1). Com o mapeamento incompleto no envio, as linhas ficam com `classification` nula e o lote traz `mappingProblem` (EX30).
- **EX7. Seleção na confirmação:** corpo `{ createNew: boolean, updateExisting: boolean, excludedRows: number[], mapping: ColumnMapping }` (números de linha tirados à mão; até 5.000; `mapping` = o da prévia que a tela mostrou — revisão final, I1). O servidor marca `writeState = 'PENDING'` nas linhas `CREATE` (se `createNew`) e `UPDATE` (se `updateExisting`) cujo número não está em `excludedRows`. Nenhuma linha escolhida → 422.
- **EX8. Confirmar uma vez só:** numa transação: `updateMany({ where: { id, status: 'PREVIEW', createdById: actorId }, data: { status: 'WRITING', confirmedById, confirmedAt, lastBlockAt } })`; contagem 0 → 409 `people_import.already_confirmed` (`alreadyConfirmed()`, "Esta importação já foi confirmada."). O serviço (T19) confere antes, nesta ordem, 404/403 (EX25) e o `status`: lote fora de `PREVIEW` → o **mesmo** 409 `already_confirmed`, sem chamar o repositório (revisão 1, M2; `not_preview` nunca sai da confirmação); depois a seleção (EX7), a limpeza (EX14) e `people_import.confirmed` (`recordChange`). Dois cliques ou duas abas: a segunda transação não acha o lote em `PREVIEW` e não muda nada. Remapear × confirmar (revisão T19, Important 1): o serviço passa o mapeamento que validou; dentro da transação, depois do flip, o repositório relê `mapping`/`headers` e, se divergirem, desfaz e devolve `preview_changed` (409); as colunas não mapeadas são calculadas ali. Remapear numa aba e confirmar depois em outra (revisão final, I1): o corpo traz o `mapping` que a tela mostrou; diferente do gravado → o mesmo 409 `preview_changed`, antes de qualquer escrita; a tela fecha o diálogo, relê a prévia e zera a seleção.
- **EX9. Reserva da linha (E6) e o que o servidor garante sozinho.** Reserva atômica, uma linha por vez, por SQL (`$queryRaw`):
  ```sql
  UPDATE "PeopleImportRow" r
     SET "writeState" = 'RESERVED', "reservedUntil" = $until, "reservationToken" = $token,
         "personId" = CASE WHEN r."plan"->>'kind' = 'create' THEN COALESCE(r."personId", $personId) ELSE r."personId" END
   WHERE r."id" = (
           SELECT "id" FROM "PeopleImportRow"
            WHERE "batchId" = $batchId
              AND ("writeState" = 'PENDING' OR ("writeState" = 'RESERVED' AND "reservedUntil" < $now))
            ORDER BY "rowNumber" LIMIT 1
            FOR UPDATE SKIP LOCKED)
     AND EXISTS (SELECT 1 FROM "PeopleImportBatch" b WHERE b."id" = $batchId AND b."status" = 'WRITING')
  RETURNING r."id", r."rowNumber", r."plan", r."personId";
  ```
  `$now` e `$until = $now + 5 min` vêm do relógio da API (testes controlam o tempo); `$token` é um `randomUUID()` por pedido de bloco. `$personId` = `newPersonId()` (T13a: `'c' + randomUUID()` sem hífens, 33 caracteres, gerado a cada chamada): a linha de **criação** recebe na primeira reserva o id que a pessoa vai ter e o mantém nas reservas seguintes (`COALESCE`); a de atualização fica com o `personId` da prévia. É por esse id que a gravação reconhece a pessoa criada pela própria linha (EX17.4 a). Formato: começa por `c` e não tem hífen, então passa no `z.string().cuid()` que já valida id de usuário (`whatsapp-instances/dto/create-instance.dto.ts:7`). O resultado só é gravado por quem tem a reserva: `updateMany({ where: { id, reservationToken: token, writeState: 'RESERVED' } })`; contagem 0 = a reserva venceu e outro pedido pegou a linha → o resultado é descartado sem erro. **Garantias do servidor, sem depender da tela:** (a) dois pedidos nunca reservam a mesma linha (`FOR UPDATE SKIP LOCKED` + condição); (b) a mesma pessoa nunca é criada em dobro (único de `phoneE164` e de `registrationKey` no banco; a criação usa o id guardado na linha, e a gravação procura esse id antes de criar: repetir uma linha que já criou a pessoa dá "Sem alteração", E6 e EX17.4); (c) o lote é concluído e registrado na Trilha uma vez (EX13); (d) só quem confirmou grava (EX10). O que fica com a tela: pedir o próximo bloco, esperar, repetir após erro de rede (EX34).
- **EX10. Bloco** *(spec E6)*: `writeBlock` confere, nesta ordem: lote visível (404) → `confirmedById === ator` (403 `not_confirmer`, inclusive ADMIN) → `status === 'WRITING'` (409 `not_writing`) → permissões **relidas** do confirmador (`loadImportActor`; `assertCanWrite`: sem `pessoas.editar` → 403 `auth.permission_denied` com o texto da chave; sem setor → 403). Depois grava `lastBlockAt` e reserva/grava linha a linha enquanto `gravadas < 50` **e** `Date.now() - início < 10_000` (conferido antes de cada reserva). No fim, `completeIfDone` e devolve o resumo. `pessoas.importar` perdida é recusada antes pelo guard (403). **Ajustes da implementação (revisões T20b e T27):** lote ainda sem confirmação (`confirmedById` nulo, em PREVIEW) responde 409 `not_writing` logo depois do 404, antes do `not_confirmer` (não abre acesso: só quem vê o lote chega aí); o limite de 10 s só barra a partir da segunda reserva, para todo bloco com linha livre avançar ao menos uma.
- **EX11. "Gravação interrompida" é derivada** *(decisão minha)*: `situation = 'INTERRUPTED'` quando `status === 'WRITING'` e `(lastBlockAt ?? confirmedAt) < agora − 3 min` (mais que os 120 s que a tela espera por bloco). "Continuar gravação" é só voltar a pedir blocos; não há estado a desfazer.
- **EX12. Versão da pessoa** *(decisão minha, confirmada pela coordenação — pontos 1 e 2)*: `personFingerprint(person)` = SHA-256 hex do JSON canônico de `ImportPerson` sem o `id` (nome, telefone, matrícula, função, setor, turno, nível, autorização com origem, detalhe e data, situação, acesso). A prévia guarda o resumo no `plan`; a gravação compara. Diferente → falha "A pessoa foi alterada depois da prévia". A conferência roda logo antes do `updateUser`; a janela até a transação dele é aceita.
- **EX13. Concluir e encerrar.** `completeIfDone`: numa transação, se não há linha `PENDING` nem `RESERVED`, `updateMany({ where: { id, status: 'WRITING' } , data: { status: 'COMPLETED', finishedAt, result } })`; contagem 1 → `people_import.completed` (autor = quem confirmou, `ending: 'COMPLETED'`). Dois blocos terminando juntos: só um passa no `updateMany`. **Encerrar** (só ADMIN, qualquer lote em `WRITING`): numa transação, `WRITING → CLOSED` condicional, `closedById`, linhas `PENDING` e `RESERVED` vencidas → `DONE` com `outcome = 'NOT_WRITTEN'` e "Não gravada: gravação encerrada"; `people_import.completed` com `ending: 'CLOSED'`, autor = quem encerrou. Reserva **viva** no encerramento termina com o dono (a pessoa já pode ter sido gravada); a trilha leva `writing: n` quando n > 0; ao ler um lote `CLOSED` (resumo, relatório), reservas vencidas viram `NOT_WRITTEN` (`settleExpired`). **Exceção (re-revisão 2, m8):** linha de **criação** (`classification = 'CREATE'`) com `personId` cuja pessoa já existe (`User.id = personId`: criada pela própria linha, EX17.4 a) não vira `NOT_WRITTEN`: `close` e `settleExpired` a marcam `DONE` com `outcome = 'CREATED'` (o mesmo que a gravação normal usa), `personId` mantido, `cells` e `plan` nulos, sem `outcomeReason`. Só linha de criação; na atualização `personId` é a pessoa existente da prévia e não prova gravação. **Automático** *(decisão minha, confirmada pela coordenação — ponto 3)*: no envio de um arquivo novo, lote `WRITING` com `(lastBlockAt ?? confirmedAt)` anterior a agora − 7 dias é encerrado do mesmo jeito, autor = quem confirmou, `ending: 'AUTO_CLOSED'`, motivo "Encerrada automaticamente: gravação interrompida há mais de 7 dias."
- **EX14. Limpeza do que fica guardado (E2, aceite 26), momento exato:**
  - **Ao confirmar** (mesma transação da EX8): `UPDATE "PeopleImportRow" SET "cells" = "cells" - $unmapped::text[] WHERE "batchId" = $id AND "cells" IS NOT NULL` (colunas não mapeadas de todas as linhas); `preview` nulo em **todas** as linhas (depois de confirmar, a prévia não é mais lida, EX26; revisão 1, M11); linhas sem `writeState` e com classificação fora de `INVALID`/`DUPLICATE`/`CONFLICT` (desmarcadas, Sem alteração, Ignoradas) → também `cells` e `plan` nulos; linhas de erro → `plan` nulo (ficam as colunas mapeadas e os motivos); linhas `PENDING` guardam as colunas mapeadas e o `plan` até serem gravadas.
  - **Ao gravar cada linha:** `CREATED`/`UPDATED`/`UNCHANGED` → `cells` e `plan` nulos (fica número, resultado e pessoa); `FAILED` → `plan` nulo (ficam as colunas mapeadas e o motivo).
  - **Ao encerrar:** `NOT_WRITTEN` → `plan` nulo (ficam as colunas mapeadas, como as de erro).
  - **Ao descartar** *(decisão minha, confirmada pela coordenação — ponto 5; a GBR confirma)*: o lote e as linhas são apagados (`DELETE` do lote, linhas em cascata); não fica registro do descarte nem dado do arquivo. A frase da spec E2 "ao confirmar ou descartar o lote, apagam-se as colunas não mapeadas…" pressupunha o lote guardado; aqui ela vale só para a confirmação, e o descarte apaga tudo. Depois do descarte o lote não existe: a lista não o mostra; `GET batches/:id` responde 404 `batch_not_found` (inclusive na outra aba aberta no mesmo lote); a tela que abre `?lote=<id>` de lote apagado volta ao passo Arquivo (T28). **No envio de arquivo novo:** lotes em prévia criados há mais de 7 dias são apagados com as linhas (mesma consequência).
- **EX15. Ordem da classificação de uma linha** (E4; `classifyRow`, T10; telefone pela decisão do Conselho S, EX17). (1) linha em branco ou de exemplo → Ignorada; (2) duplicada (decidida antes, para o lote inteiro, EX31) → Duplicada; (3) sem matrícula e sem telefone válido → Inválida "Sem matrícula nem telefone para identificar"; (4) erros das próprias células (tamanho, telefone inválido, Sim/Não, data) → Inválida com todos os motivos; (5) identificar: por matrícula (chave em minúsculas); se não achou, pelo telefone (todas as grafias), só para o ADMIN e quem tem `telefone.ver_completo`; quem não tem a chave → sem consulta ao telefone (`lookup.byPhone` nunca é lido, e a consulta do lote nem recebe telefone, EX17.3); (6) pessoa achada e ator não ADMIN: fora do alcance hoje ou com login → Inválida "Você não pode alterar esta pessoa." e para (EX16); (7) conflito — **o conflito por telefone só é avaliado para ADMIN ou quem tem a chave**: matrícula achou A e telefone achou B ≠ A → "O telefone já pertence a outra pessoa cadastrada"; achada só pelo telefone com outra matrícula gravada e a linha traz matrícula → o mesmo texto; achada só pelo telefone **sem** matrícula gravada e a linha traz matrícula → não é conflito: a matrícula da planilha entra no patch. Sem a chave, nunca há Conflito por telefone (nem no caso do aceite 17); (8) pessoa existente: estrutura (CX8; erro → Inválida), setor obrigatório para quem não é ADMIN, telefone de quem não tem a chave por EX17.1 (pessoa com telefone gravado) e EX17.2 (pessoa sem telefone gravado), autorização (CX7), diff (CX9); sem diferença → Sem alteração; com diferença e pessoa inativa → Inválida "Pessoa inativa; reative na ficha"; senão Atualizar; (9) pessoa nova: nome mascarado → "Nome inválido"; sem nome → "Pessoa nova precisa de nome"; sem telefone (vazio ou mascarado) → "Pessoa nova precisa de telefone"; setor obrigatório para quem não é ADMIN; estrutura; ADMIN ou quem tem `telefone.ver_completo` e o telefone já é de alguém → Conflito (na prática já resolvido nos passos 5 e 7); quem não tem a chave → sem consulta, Criar.
- **EX16. Mesma resposta fora do alcance (aceite 27):** para quem não é ADMIN, linha **cujas células não têm erro próprio** (passa pelos passos 1–4 de EX15) e cuja pessoa achada está fora do alcance ou tem login dá sempre `{ classification: 'INVALID', reasons: ['Você não pode alterar esta pessoa.'], warnings: [], preview: null, plan: null, personId: null }`, venham as demais células iguais às da pessoa ou diferentes. Linha com erro próprio para no passo 4, antes de identificar, e responde só pelos seus erros, que dependem só da própria célula (revisão 1, M1). A estrutura de quem não é ADMIN só procura setor entre os do alcance: setor de outro gestor e setor inexistente dão o mesmo "Setor 'X' não encontrado entre os setores que você gerencia".
- **EX17. Telefone de quem não vê telefone completo** (spec E4, aceite 24; mesma regra da tela do setor, `sector-people-write.service.ts:222-229`, DB8: "sem a chave, trocar o telefone gravado seria também ler/confirmar o número; vale até para o mesmo valor"). EX17.2 e EX17.3 são a decisão do Conselho S, **provisória até a GBR confirmar** (`~/.claude/tribunais/2026-11-19/conselho-S/sentenca-S.md`); EX17.4 é o ruling da coordenação de 19/11.
  - **EX17.1 (fixo; revisão 1, I1).** Quem não tem `telefone.ver_completo` não identifica pessoa pelo telefone (EX15 passo 5). Pessoa achada pela matrícula **com telefone gravado** (`phoneE164` não nulo): célula de telefone não vazia e não mascarada sai do patch **e** da comparação de "Sem alteração" (o `diffPerson` recebe `phoneE164: null`), sempre com o aviso "Você não pode alterar o telefone desta pessoa." (`cannotEditPhone`), seja igual à gravada, diferente ou de outra pessoa; o passo 7 não procura o dono do telefone. Célula mascarada conta como vazia (sem aviso). Na gravação (T20a, EX19 c): patch com telefone, ator sem a chave e pessoa que **hoje** tem telefone → FAILED `cannotEditPhone`, antes de `patchSatisfied` (senão "Sem alteração" contra "falha" confirmaria o número).
  - **EX17.2 (Conselho S: S2-a com I1).** Quem não vê telefone completo: não identifica pelo telefone. Pessoa existente **com** telefone: a célula sai do patch com o aviso, sem comparar (EX17.1). Pessoa existente **sem** telefone: o telefone entra no patch, sem conferir se está livre; a prévia mostra "Atualizar" com o número do arquivo, como na tela do setor (que só barra quem já tem telefone). Pessoa nova: aceito, sem conferir. A unicidade é só a do `updateUser`/`createPersonWithoutAccess` na gravação (EX20): número que já é de outra pessoa faz a linha inteira falhar com "O telefone já pertence a outra pessoa cadastrada", sem aplicar nenhum campo. Telefone já gravado nunca é comparado. Na gravação, a trava de telefone é conferida antes de "Sem alteração" (EX19 c): pessoa que ganhou telefone depois da prévia → FAILED `cannotEditPhone`, sem comparar números.
  - **EX17.3 (Conselho S: S1-b ajustada).** Sem `telefone.ver_completo`, a pessoa só é identificada pela **matrícula**. Na prévia, nenhum telefone do arquivo é comparado com o cadastro: a prévia não diz se um número já existe, a linha sai como Criar ou Atualizar, e o topo mostra o aviso fixo "A conferência de telefones já cadastrados é feita ao gravar." Na gravação, número que já é de outra pessoa faz a linha falhar com "O telefone já pertence a outra pessoa cadastrada" (`phoneTaken`), seja de quem for (sem login no alcance, com login, fora do alcance, na outra grafia do 9º dígito); as outras linhas seguem. Com a chave, e para o ADMIN, a prévia continua mostrando o Conflito (EX15 passos 5 e 7), sem dizer de quem. Peças:
    - **Consulta do lote** (T15, `BatchClassifier.classify`): para quem não tem a chave (`!phoneFullFor(actor)`), `findPeopleByKeys` recebe `phones: []` — nenhum telefone, só as matrículas; o `buildLookup` fica com `byPhone` vazio. ADMIN e quem tem a chave: todas as grafias, como antes.
    - **Indicador** `BatchSummary.phoneCheckDeferred` (T17, `summaryFor`): `!phoneFullFor(actor)`, com o ator relido naquele pedido (`loadImportActor`); a tela da prévia (T26) mostra o aviso fixo quando é `true`. O texto do aviso é da tela, não entra em `ROW_TEXT`.
    - **Contador** `phoneTaken` (EX20, EX22): falhas por telefone já cadastrado, só o número, contadas pelas linhas `FAILED` com `outcomeReason = ROW_TEXT.phoneTaken` (T13b `resultCounts`; sem coluna nova, porque `result` do lote, `close` e o resumo já saem de `resultCounts`); vai em `ImportResultCounts`, no `result` do lote, no `progress` do resumo e em `people_import.completed`.
  - **EX17.4 Linha de criação achada de novo na gravação** (ruling da coordenação, 19/11; substitui o antigo parágrafo "Gravação, em qualquer desfecho"). Para quem não tem a chave, "Sem alteração" por coincidência de telefone confirmaria nome e setor do dono — o oráculo que a sentença fecha. Regra (T20a):
    - (a) **Pessoa criada pela própria linha.** Na primeira reserva, a linha de criação recebe em `personId` o id que a pessoa vai ter (EX9, `newPersonId()`), mantido nas reservas seguintes; a criação passa esse id a `createPersonWithoutAccess(actorId, input, { reason, personId })` (T14). Na gravação, **antes de qualquer trava**, pessoa com esse id já existe → UNCHANGED com esse `personId` (retomada do aceite 25: reserva vencida depois de criar e antes de registrar), para qualquer ator, com ou sem matrícula. **Qualquer erro do cadastro na criação** (`user.phone_taken`, `user.registration_taken`, o P2002 com alvo `id` que a corrida gera e qualquer outro) → relê a pessoa pelo `personId` da linha antes de traduzir pela EX20: existe → UNCHANGED (um pedido antigo criou no meio: a reserva venceu com ele ainda dentro de `createWithAudit`, o novo insere com o mesmo id e a PK barra); senão segue (b)/(c) ou o motivo da EX20 *(re-revisão 2, m1)*.
    - (b) **Sem a chave:** a gravação não consulta telefone. Matrícula da linha já é de outra pessoa → FAILED `registrationTaken`, sem comparar valores; `createPersonWithoutAccess` devolve `user.phone_taken` → FAILED `phoneTaken`, sempre, sem comparar valores. Fora de (a), nunca "Sem alteração".
    - (c) **ADMIN e quem tem a chave:** reidentifica por matrícula e telefone. **ADMIN:** achada de novo com os valores da linha (`patchSatisfied`) → UNCHANGED (spec E6). **Quem não é ADMIN** *(re-revisão 2, m2; spec E4/E6 e aceite 27: as travas vêm antes de "Sem alteração")*: pessoa achada de novo (não pelo id da própria linha) **fora do alcance ou com login** → FAILED `phoneTaken` (achada pelo telefone, ou matrícula e telefone em pessoas diferentes) ou `registrationTaken` (achada só pela matrícula), sem comparar valores; no alcance e sem login → `patchSatisfied` → UNCHANGED. Em todos os casos, o que não é UNCHANGED → FAILED `phoneTaken` ou `registrationTaken`, conforme o que a achou. O texto nunca é `cannotEditPerson` (diria de quem é o número). Só a linha de **atualização** passa pelas travas da pessoa com o texto delas (EX19 b).
    - **Por que o id na linha** *(decisão minha, conferida no código)*: `User.id` é `String @id @default(cuid())` (`backend/prisma/schema.prisma:72`), então `Prisma.UserCreateInput` aceita `id` opcional; `personWithoutAccessData` (`users.service.ts:200-218`) monta esse `data`, e `createWithAudit` (`users.repository.ts:199-224`) o passa a `tx.user.create` sem filtrar (`refuseAssignmentInData`, L112-117, só recusa chaves de vínculo); `PeopleImportRow.personId` já existe (CX5). A procura pelo id vem antes de `createPersonWithoutAccess` porque ele confere o telefone (`phones.assertAvailable`, `users.service.ts:467`) antes de criar: sem isso a retomada daria `phone_taken`. Custo: campo opcional no `meta` (T14), um `CASE` no SQL da reserva (T13a), `ids` em `findPeopleByKeys` (T12); sem migração.
- **Testes do Conselho S e da retomada** (sentença: S1 1–7 e S2 1–6; EX17.4: R1–R4). Cada um está copiado no passo RED da task dona; os demais testes das tasks não mudam.

  | ID | Task, spec | `it(...)` | Assertivas |
  |---|---|---|---|
  | S1-1 | T10 `classify-row.reach.spec.ts` | `it.each([...])('S1-1: sem telefone.ver_completo, pessoa nova com número já cadastrado (%s) dá o mesmo resultado que com número livre')` — dono sem login no alcance, com login, fora do alcance, outra grafia do 9º dígito | lookup com o dono em `byPhone` × lookup sem ele → `toStrictEqual`; `classification` `CREATE`; nenhum `phoneTaken` nem `cannotEditPerson` |
  | S1-2 | T15 `batch-classifier.spec.ts` | `it('S1-2: sem telefone.ver_completo, a consulta de pessoas do lote não recebe nenhum telefone')` | spy em `findPeopleByKeys`: uma chamada, `phones` `[]`, `registrationKeys` com as matrículas; com a chave (e ADMIN): todas as grafias |
  | S1-3 | T10 `classify-row.spec.ts` (ADMIN) e `classify-row.reach.spec.ts` (gestor com a chave) | `it('S1-3: com telefone.ver_completo e para o ADMIN, Conflito de telefone traz só o texto fixo')` | `reasons` `[phoneTaken]`; `preview`, `plan`, `personId` nulos; `JSON.stringify(verdict)` sem nome, setor nem matrícula do dono |
  | S1-4 | T10 `classify-row.reach.spec.ts` | `it('S1-4: aceite 17 sem telefone.ver_completo (matrícula de A, telefone de B) nunca dá Conflito')` | A sem telefone → `UPDATE` com `phone` no patch; A com telefone → aviso `cannotEditPhone`; nunca `CONFLICT` |
  | S1-5 | T20a `row-writer.integration.spec.ts`; T22a `people-import.e2e.integration.spec.ts` | T20a `it.each([...])('S1-5: sem telefone.ver_completo, número já cadastrado (%s) falha com phoneTaken')` (os quatro donos de S1-1); T22a `it('S1-5: sem a chave, número ocupado falha; as outras linhas entram; relatório, phoneTaken e trilha só com números')` | T20a: `{ outcome: 'FAILED', reason: phoneTaken, personId: null }` igual nos quatro; T22a: as outras linhas `CREATED`; a linha no `errors.csv` com o motivo; `progress.phoneTaken` 1; `people_import.completed` com `phoneTaken` 1 e nenhum nome ou telefone em `changes` |
  | S1-6 | T17 `people-import-query.service.spec.ts`; T26 `preview-step.spec.tsx` | T17 `it('S1-6: phoneCheckDeferred só para quem não tem telefone.ver_completo')`; T26 `it('S1-6: aviso fixo da conferência de telefones só com phoneCheckDeferred')` | T17: gestor sem a chave `true`; gestor com a chave e ADMIN `false`; T26: "A conferência de telefones já cadastrados é feita ao gravar." presente com `true`, ausente com `false` |
  | S1-7 | T22b `people-import.e2e-roundtrip.integration.spec.ts` | `it('S1-7 (aceite 24): sem a chave, dois envios que diferem só por o número existir dão prévias iguais')` | resumo (`counts`, `phoneCheckDeferred`) e página 1 de `rows` iguais (`toStrictEqual`, sem `id`/datas do lote) |
  | S2-1 | T10 `classify-row.reach.spec.ts` | `it('S2-1: sem telefone.ver_completo, pessoa achada pela matrícula e sem telefone: Atualizar com o telefone no plano e na prévia')` | `UPDATE`; `plan.patch.phone` = E.164 da célula; `preview.diff` com `phone` (antes nulo) |
  | S2-2 | T10 `classify-row.reach.spec.ts` | `it('S2-2: pessoa com telefone: célula igual e célula diferente dão o mesmo resultado')` | `toStrictEqual`; `warnings` com `cannotEditPhone`; sem `phone` no patch nem no diff |
  | S2-3 | T20a `row-writer.integration.spec.ts` | `it('S2-3: sem a chave, número livre preenche o telefone vazio, liga o Contato e grava o motivo na trilha da pessoa')` | `UPDATED`; `User.phoneE164` e `contactId` preenchidos; evento da pessoa com `reason` = `importReason(fileName)` |
  | S2-4 | T20a `row-writer.integration.spec.ts` | `it('S2-4: sem a chave, número ocupado: FAILED phoneTaken e nenhum campo da linha aplicado')` | linha com nome novo + telefone ocupado → `FAILED` `phoneTaken`; pessoa igual à de antes (nome, telefone, vínculo); nenhum evento novo da pessoa |
  | S2-5 | T20a `row-writer.spec.ts` | `it('S2-5: pessoa que ganhou telefone entre a prévia e a gravação falha com cannotEditPhone, nunca Sem alteração')` | telefone de hoje igual ao do patch e diferente → os dois `FAILED` `cannotEditPhone`; `updateUser` não chamado |
  | S2-6 | T10 `classify-row.reach.spec.ts` | `it('S2-6: pessoa com login ou fora do alcance: resposta da EX16 com qualquer telefone')` | célula vazia, igual, diferente e de outra pessoa → o objeto exato da EX16 nos quatro (aceite 27 intacto) |
  | R1 | T13a `people-import-reserve.integration.spec.ts` | `it('reserveNextRow dá personId à linha de criação e mantém o mesmo depois que a reserva vence')` | criação: `personId` não nulo, `/^c[0-9a-f]{32}$/`; segunda reserva da mesma linha → mesmo `personId`; atualização devolve o `personId` da prévia |
  | R2 | T14 `users.service.reason.spec.ts` | `it('createPersonWithoutAccess cria com o id dado em meta.personId')` | `createWithAudit` recebe `data.id` = o id dado; sem `personId`, `data` sem a chave `id` |
  | R3 | T20a `row-writer.spec.ts` | `it('criação: pessoa com o id da linha já existe dá Sem alteração antes das travas, inclusive sem a chave e sem matrícula')`; `it('sem a chave, criação: matrícula de outra pessoa ou phone_taken falham sem comparar valores')`; `it('com a chave, criação achada de novo: ADMIN com os valores da linha dá Sem alteração; gestor com pessoa fora do alcance ou com login falha com phoneTaken ou registrationTaken; nunca cannotEditPerson')`; `it('phone_taken na criação relê pelo id: pessoa da própria linha dá Sem alteração')`; `it('erro desconhecido na criação e pessoa da linha existente → UNCHANGED')` | 1º: `UNCHANGED` com o `personId` dado, `findPeopleByKeys` sem telefone, `createPersonWithoutAccess` não chamado, mesmo com setor fora do alcance de agora; 2º: `FAILED` com o texto mesmo quando os valores batem com os da pessoa; 3º: ADMIN → `UNCHANGED` se os valores batem, `phoneTaken`/`registrationTaken` se não; gestor com a chave e pessoa achada de novo fora do alcance ou com login → `phoneTaken` (achada pelo telefone) ou `registrationTaken` (só pela matrícula) **mesmo com os valores iguais**; gestor com a chave, no alcance e sem login → `UNCHANGED` se iguais; 4º: `UNCHANGED`; 5º: `createPersonWithoutAccess` lança erro qualquer (inclusive P2002 alvo `id`) e a pessoa com o `personId` existe → `UNCHANGED`, sem `logger.error`; se não existe, segue a EX20 |
  | R4 | T20a `row-writer.integration.spec.ts`; T22b | T20a `it('retomada: pessoa criada pela linha e reserva vencida antes de registrar dá Sem alteração, sem a chave e sem matrícula')` e `it('dois write concorrentes com a mesma personId (Promise.all): uma pessoa só, nenhuma linha FAILED')` (re-revisão 2, m1); T22b `it('aceite 25 sem telefone.ver_completo e sem matrícula: retomada depois de criar dá Sem alteração')` | uma pessoa só no banco com aquele telefone; `outcome` `UNCHANGED` com o `personId` da reserva; nenhum `FAILED`; no `Promise.all`, um `CREATED` e um `UNCHANGED` (ou os dois `UNCHANGED`/`CREATED` em qualquer ordem), nunca `FAILED` |
- **EX18. Autorização** (CX7) *(decisão minha, confirmada pela coordenação — ponto 8)*: regras da spec E4 mais "Outro sem detalhe" = autorização ignorada com aviso.
- **EX19. Trava que mudou na gravação** *(decisão minha, confirmada pela coordenação — ponto 7)*: na gravação, as travas de quem não é ADMIN são conferidas de novo com as permissões do bloco (`loadImportActor`), nesta ordem, **antes** de "Sem alteração" (mesma ordem da prévia, spec E4), depois só da procura da pessoa criada pela própria linha (EX17.4 a, que vem antes de tudo e não é palpite): (a) setor de destino (`plan.input.sectorId` na criação, `plan.patch.sectorId` na atualização) fora do `actor.reach` de agora → FAILED "Setor '<nome>' não encontrado entre os setores que você gerencia" (`notInReach`, com o nome do catálogo; revisão 1, I2); (b) só na atualização: pessoa fora do alcance hoje ou com login → `cannotEditPerson`; (c) telefone (EX17.1 e EX17.2, Conselho S): patch com telefone, ator sem `telefone.ver_completo` e pessoa que **hoje** tem telefone → `cannotEditPhone`, sem comparar números (pessoa que ganhou telefone depois da prévia cai aqui, nunca em "Sem alteração"); (d) só na atualização: patch com `contactAuthorization` e `canEditContactAuthorization(actor.policy, pessoa)` falso → `cannotEditAuthorization`. Trava que agora barra → a linha falha com o texto da trava (não grava a linha sem o campo, em silêncio). A gravação nunca aplica campo que o `plan` não tem (E6).
- **EX20. Erros do cadastro viram motivo da linha** (T20a): `user.phone_taken` → "O telefone já pertence a outra pessoa cadastrada" (na criação, depois de reler pelo id da linha, EX17.4 a; conta no contador `phoneTaken`, EX17.3); `user.registration_taken` → "A matrícula já pertence a outra pessoa cadastrada"; `user.sector_invalid`, `users.invalid_shift`, `users.invalid_level` → "Setor, turno ou nível não está mais ativo"; `user.invalid_phone` → "Telefone inválido"; `user.authorization_future_date` → "Data da autorização no futuro"; `NotFoundError` **e** `Error('USER_NOT_FOUND')` (lançado por `UsersRepository` quando a pessoa some dentro da transação, `users.repository.ts:303` e `:343`) → "A pessoa foi removida depois da prévia"; qualquer outro, inclusive `user.concurrent_admin_change` (`users.service.ts` ~L779: outro ADMIN mudou a pessoa com login ao mesmo tempo) → "Não foi possível gravar esta linha.", outcome FAILED, e `logger.error('falha ao gravar linha da importação (código <code ou nome do erro>)')`, sem nome, telefone, célula ou id de pessoa *(decisão minha; revisão 1, M4: a linha não é repetida sozinha; quem importa vê no relatório e reimporta a linha)*.
- **EX21. Motivo na pessoa:** `importReason(fileName)` = `` `Importação de planilha: ${fileName}` `` cortado em 200. `createPersonWithoutAccess(actorId, input, meta?: PersonCreateMeta)` ganha o terceiro parâmetro opcional, com `export type PersonCreateMeta = PersonChangeMeta & { personId?: string }`: `personId`, quando vem, é o `id` da pessoa criada (`data.id`, EX17.4 a); sem ele, o `id` continua do `@default(cuid())`; `createWithTrail` passa a receber um objeto `{ data, action, actorId, values, reason }`, e o convite passa `reason: null` (padrão das outras portas não muda). Atualização: `updateUser(id, patch, actorId, { reason })`. A linha de vínculo (`UserAssignment`) não tem campo de motivo: o motivo fica no evento da pessoa gravado na mesma transação da linha de vínculo (aceite 14: "a trilha da pessoa e o histórico de vínculo refletem a mudança, com o motivo").
- **EX22. Trilha do lote:** `entity: 'Spreadsheet'`, `entityId` = id do lote, `category: 'SPREADSHEET'`, `subjectUserId` nulo, `metadata` ausente, `changes` com `before: null` (CX3). Nenhum nome, telefone ou id de pessoa. `people_import.completed` traz `phoneTaken` (falhas por telefone já cadastrado, só o número; Conselho S, EX17.3).
- **EX23. Relatório de erros:** linhas com classificação `INVALID`, `DUPLICATE` ou `CONFLICT`, mais as com `outcome` `FAILED` ou `NOT_WRITTEN`, em ordem de linha, lidas em páginas de 500; colunas `linha`, os cabeçalhos **originais** das colunas mapeadas (ordem do arquivo) e `motivo` (`reasons` unidos por `; `, ou `outcomeReason`). CSV do Lote D (`CsvStreamWriter`, apóstrofo de fórmula). Nome `erros-importacao-AAAA-MM-DD.csv` (`todayIn`). Disponível em qualquer situação do lote.
- **EX24. Modelo:** `modelo-importacao-pessoas.csv|xlsx`; cabeçalho `PEOPLE_TEMPLATE_COLUMNS`; linha de exemplo `EXEMPLO;Maria Exemplo;(92) 99111-0000;Auxiliar;Nome do setor;Nome do turno;Nome do nível;Sim;Termo assinado;;<hoje DD/MM/AAAA>`; XLSX com abas "Pessoas" e "Instruções" (texto em CX12).
- **EX25. Quem faz o quê com um lote:** ver: ADMIN todos, demais só os seus; lote inexistente ou alheio → mesmo 404 `batch_not_found`. Remapear e confirmar: só quem enviou (403 `not_uploader`, inclusive ADMIN; *decisão minha, confirmada pela coordenação — ponto 4*), e com `assertCanWrite` das permissões de agora nos dois. Pedir bloco: só quem confirmou (403 `not_confirmer`). Encerrar: só ADMIN (403 `close_admin_only`). Descartar: quem vê, só em prévia (409 `not_preview`). Relatório: quem vê.
- **EX26. Prévia só em prévia:** `GET rows`, nesta ordem: lote invisível → 404; fora de `PREVIEW` → 409 `not_preview` (o conteúdo já foi limpo); em prévia com `mappingProblem` (linhas sem classificação, EX30) → 422 `people_import.mapping_incomplete` com o texto do `mappingProblem` (`mappingIncomplete(detail)`; revisão 1, M8).
- **EX27. Tela:** rota `/importar-pessoas` (`routes/_authenticated/importar-pessoas/index.tsx`), `beforeLoad` igual ao de `/turnos` com `pessoas.importar`; o lote aberto fica na URL (`?lote=<id>`), para recarregar a página voltar ao passo certo.
- **EX28. Limite de envio:** `@Throttle({ default: { ttl: 60_000, limit: 10 } })` em `POST batches` e `PUT batches/:id/mapping` (leitura e classificação de até 5.000 linhas num servidor de 2 vCPU).
- **EX29. Novidades:** versão `2026.11.19.4` se implementada hoje (a mais recente é `2026.11.19.3`); em outro dia, `AAAA.MM.DD` do dia.
- **EX30. Envio com mapeamento incompleto:** o lote é guardado com as `cells` e `classification` nula; o resumo traz `mappingProblem` e `counts: null`; a tela abre no passo Colunas com o aviso.
- **EX31. Duplicadas:** chaves = matrícula (minúsculas) e telefone canônico (`canonicalBrPhoneForm`); telefone mascarado ou inválido não conta; linhas Ignoradas não entram. A primeira ocorrência segue a classificação que tiver; as seguintes ficam "Linha repetida: a mesma matrícula ou o mesmo telefone já aparece na linha N".
- **EX32. Quem não é ADMIN e não gerencia setor:** 403 `no_managed_sector` ("Você não gerencia nenhum setor.") no envio, na confirmação e no bloco. Quem não é ADMIN precisa ter a coluna Setor mapeada (`mappingProblem`).
- **EX33. Comparações:** matrícula pela chave (sem diferenciar maiúsculas); telefone pelas duas grafias do nono dígito; nome e função depois do `trim` (função pelo `normalizeJobTitle` de `users.service.ts`, exportado na T14); setor, turno e nível pelo id resolvido.
- **EX34. Gravação na tela** (T27): espera até 120 s por bloco; tempo esgotado ou erro de rede → consulta o resumo e pede de novo depois de 5 s; resposta com `pending === 0` e `writing > 0` (linhas reservadas por outro pedido) → espera 5 s e pede de novo; 429 (limite de pedidos do throttler global) → espera o `Retry-After` em segundos (ausente ou ilegível: 10 s) e pede de novo, sem mostrar erro (revisão 1, M7); 403 → para e mostra "Gravação interrompida" com o texto da API; 409 `not_writing` → recarrega o resumo; para quando a situação deixa de ser `WRITING`/`INTERRUPTED`.

## Global Constraints

- **GX1. Sem dependência nova:** nenhum `package.json` muda. XLSX com `exceljs`, telefone com `libphonenumber-js` (via `backend/src/modules/contacts/phone.util.ts`), CSV por código próprio (EX2).
- **GX2. Contatos intocados:** `backend/src/modules/excel-import/`, `ImportBatch`/`ImportItem`, `/imports` e o front de contatos não mudam; só se importa a função `normalizeXlsxForExceljs` (EX1).
- **GX3. Caminho único de gravação (spec, Restrições; anti-objetivo):** toda gravação de pessoa passa por `UsersService.createPersonWithoutAccess` e `UsersService.updateUser`; nenhum `prisma.user.create/update` novo; setor, turno e nível só pelo `assignment` do `updateUser`/criação (que chama `writeAssignment`, vínculo com início hoje). A importação só escreve nas tabelas dela e na Trilha.
- **GX4. Hoje:** sempre `todayIn(new Date())` (`backend/src/modules/staff-schedule/civil-date.ts`, America/Manaus): data da autorização vazia = dia da **gravação**; data futura comparada com o hoje do momento. Testes fixam o relógio com `vi.useFakeTimers({ toFake: ['Date'] })` + `vi.setSystemTime`.
- **GX5. Trilha do lote (spec, Comum):** `people_import.confirmed` e `people_import.completed`, categoria `SPREADSHEET` passada explicitamente, gravadas por `AuditService.recordChange` dentro da transação, com `actorId` explícito (quem confirmou; quem encerrou); o que a tela mostra vai em `changes` com "antes" vazio; nenhum dado pessoal.
- **GX6. Quem não é ADMIN (spec E4):** "precisa também de `pessoas.editar`; sem ela, as rotas de envio e de confirmação respondem 403; o setor é obrigatório e precisa estar no alcance; pessoa existente precisa estar hoje num setor do alcance e não ter login; senão, 'Você não pode alterar esta pessoa.'; sem `telefone.ver_completo` (conselho S, provisório até a GBR confirmar): a pessoa só é identificada pela matrícula; na prévia, nenhum telefone do arquivo é comparado com o cadastro (aviso fixo 'A conferência de telefones já cadastrados é feita ao gravar.'); na gravação, número que já é de outra pessoa faz a linha falhar com 'O telefone já pertence a outra pessoa cadastrada', seja de quem for; telefone já gravado não é alterado nem comparado ('Você não pode alterar o telefone desta pessoa.'); telefone vazio de pessoa achada pela matrícula pode ser preenchido; telefone de pessoa nova é aceito; com a chave, e para o ADMIN, a prévia mostra o Conflito de telefone, sem dizer de quem; as travas são conferidas na prévia e de novo na gravação, com as permissões daquele momento." Alcance = `managedSectorIds` de `findTeamActor` (só setores ativos); ADMIN alcança tudo.
- **GX7. O motivo nunca revela outra pessoa (spec E4, I7):** em Conflito, Inválida e Duplicada, prévia e relatório mostram só o que veio na linha; textos "O telefone já pertence a outra pessoa cadastrada" e "A matrícula já pertence a outra pessoa cadastrada", sem nome, setor ou matrícula de quem é. Para quem não é ADMIN, a mesma resposta fora do alcance (EX16).
- **GX8. Máscara na leitura, nunca na gravação:** toda resposta com nome de pessoa do banco aplica `nameView`, e com telefone do banco aplica `phoneView` (`backend/src/shared/authz/phone-visibility.ts`), `full` = `telefone.ver_completo` do ator. O que veio do arquivo do próprio ator volta como veio.
- **GX9. Lote visível (spec E7):** ADMIN vê todos; os demais só os seus; prévia, andamento, relatório e descarte seguem a mesma regra; lote de outra pessoa → 404 igual ao inexistente.
- **GX10. Leitura das células:** CSV com `unguardFormula` (Lote D, DX19); XLSX cru. Escrita (modelo, relatório): escritores do Lote D (`CsvStreamWriter`, `openSpreadsheet`, `setDownloadHeaders`, `failDownload`), formato da spec Comum (UTF-8 com BOM, `;`, CRLF, aspas, apóstrofo de fórmula).
- **GX11. Migrações:** só aditivas, SQL escrito à mão no padrão de `backend/prisma/migrations/20261119120000_people_export_permission/` (cabeçalho comentado, `ON CONFLICT DO NOTHING`) e `20261119110000_user_assignment_history/`; nomes posteriores a `20261119120100`; nunca `prisma migrate dev` nem `reset`; banco só o do testcontainer do próprio teste.
- **GX12. Testes e tamanho:** TDD (RED antes do GREEN). Funções e callbacks de `describe`/`it` de até 50 linhas, complexidade até 10, cognitiva até 15, profundidade até 4, até 4 parâmetros (objeto de entrada); `describe` novos irmãos. Conferir com `npx eslint <arquivos tocados> --rule '{"max-lines-per-function": ["error", 50], "max-params": ["error", 4], "complexity": ["error", 10], "max-depth": ["error", 4]}'`.
- **GX13. Validação:** cwd `backend/` ou `frontend/`. Loop: `timeout 600 gate --test src/<arquivo>`, um arquivo por chamada; integração `TESTCONTAINERS_ENABLED=1 timeout 600 gate --test src/<arquivo>`. Tipos: back `npx tsc --noEmit -p tsconfig.build.json --tsBuildInfoFile /tmp/<task>.tsbuildinfo`; front `npx tsc -b`. Fechamento: back `TESTCONTAINERS_ENABLED=1 timeout 600 gate --changed --base feat/planilhas-pessoas`; front `timeout 600 gate --changed --base feat/planilhas-pessoas`. Nunca suíte inteira, gate completo, coverage ou e2e (são da principal).
- **GX14. Arquivos legados:** `prettier --write` só em arquivo novo; nunca restaurar arquivo do git; erro se corrige para a frente. Pastas untracked alheias não se tocam.
- **GX15. Compila entre tasks:** assinatura existente só ganha parâmetro ou campo opcional, salvo onde a task diz o contrário e ajusta chamadores e specs no próprio ownership.
- **GX16. Textos:** pt-BR, para quem opera, exatamente os deste plano e da spec (E1–E8).
- **GX17. Nada de dado pessoal em log:** mensagens de log fixas, com código de erro no máximo; nunca célula, nome, telefone, matrícula ou id de pessoa.
- **GX18. Sem commit** pelos agentes.

## Contratos compartilhados

**CX1. Rotas (T21; serviços T16–T20b; front T24).** Controller `PeopleImportController`, `@RequirePermission('pessoas.importar')` na classe, nenhum `@Roles`.

| Rota | Sucesso | Erros |
|---|---|---|
| `GET /internal/people-import/template?format=csv\|xlsx` | 200, arquivo | 400; 403 `auth.permission_denied` ("Você não tem permissão para importar planilhas de pessoas.") |
| `GET /internal/people-import/batches?page=` | 200 `BatchList` | 400; 403 |
| `POST /internal/people-import/batches` (multipart, campo `file`) | 201 `BatchSummary` | 403 (chave; `pessoas.editar`; `no_managed_sector`); 422 `file_too_large`, `invalid_file`, `unreadable`, `empty`, `no_data`, `duplicate_header`, `too_many_rows`; 429 |
| `GET /internal/people-import/batches/:id` | 200 `BatchSummary` | 403; 404 `batch_not_found` |
| `PUT /internal/people-import/batches/:id/mapping` body `{ mapping }` | 200 `BatchSummary` | 400; 403 `not_uploader`; 404; 409 `not_preview`; 422 `mapping_incomplete`; 429 |
| `GET /internal/people-import/batches/:id/rows?page=&classification=` | 200 `RowsPage` | 400; 403; 404; 409 `not_preview`; 422 `mapping_incomplete` (EX26) |
| `POST /internal/people-import/batches/:id/confirm` body `ConfirmBody` | 200 `BatchSummary` | 400; 403 (`not_uploader`, `pessoas.editar`, `no_managed_sector`); 404; 409 `already_confirmed`, `preview_changed`; 422 `mapping_incomplete`, `nothing_selected` |
| `POST /internal/people-import/batches/:id/write` | 200 `BatchSummary` | 403 (`not_confirmer`, `pessoas.editar`, `no_managed_sector`); 404; 409 `not_writing` |
| `POST /internal/people-import/batches/:id/close` | 200 `BatchSummary` | 403 `close_admin_only`; 404; 409 `not_writing` |
| `DELETE /internal/people-import/batches/:id` | 204 | 403; 404; 409 `not_preview` |
| `GET /internal/people-import/batches/:id/errors.csv` | 200, arquivo | 403; 404 |

**CX2. Contrato (T11a), `backend/src/schemas/contracts/people-import.schema.ts`.**

```ts
import { spreadsheetFormatSchema } from './people-export.schema';
export const IMPORT_FIELDS = ['registration', 'name', 'phone', 'jobTitle', 'sector', 'shift', 'level',
  'authorization', 'authorizationSource', 'authorizationNote', 'authorizationDate'] as const;
export type ImportField = (typeof IMPORT_FIELDS)[number];
export const IMPORT_FIELD_LABEL: Readonly<Record<ImportField, string>>;
  // Matrícula, Nome, Telefone, Função, Setor, Turno, Nível, Autorização de contato,
  // Origem da autorização, Detalhe da origem, Data da autorização
export type ColumnMapping = Record<ImportField, number | null>;      // índice da coluna (0 = primeira) ou null = Não usar
export const columnMappingSchema;   // z.object com as 11 chaves obrigatórias, cada uma z.number().int().min(0).nullable(); strict
export const mappingBodySchema;     // z.object({ mapping: columnMappingSchema }).refine(nenhum índice repetido, 'Cada coluna serve a um campo só.')
export const ROW_CLASSES = ['CREATE', 'UPDATE', 'UNCHANGED', 'INVALID', 'DUPLICATE', 'CONFLICT', 'IGNORED'] as const;
export type RowClass = (typeof ROW_CLASSES)[number];
export const IMPORT_ROWS_PAGE_SIZE = 50; export const IMPORT_BATCHES_PAGE_SIZE = 20;
export const rowsQuerySchema;       // { page: z.coerce.number().int().min(1).default(1), classification: z.enum(ROW_CLASSES).optional() }
export const batchListQuerySchema;  // { page: z.coerce.number().int().min(1).default(1) }
export const confirmBodySchema;     // { createNew: z.boolean(), updateExisting: z.boolean(), excludedRows: z.array(z.number().int().min(2)).max(5000).default([]) }
export const templateQuerySchema;   // { format: spreadsheetFormatSchema }
export type ConfirmBody = z.infer<typeof confirmBodySchema>;
export type BatchSituation = 'PREVIEW' | 'WRITING' | 'INTERRUPTED' | 'COMPLETED' | 'CLOSED';
export type ImportProgress = { toWrite: number; pending: number; writing: number; created: number; updated: number;
  unchanged: number; failed: number; phoneTaken: number; notWritten: number };   // phoneTaken: das falhas, as por telefone já cadastrado (Conselho S)
export type PersonRef = { id: string; name: string | null };       // name já com nameView
export type BatchSummary = {
  id: string; fileName: string; fileSize: number; format: 'csv' | 'xlsx'; situation: BatchSituation;
  createdAt: string; createdBy: PersonRef; confirmedAt: string | null; confirmedBy: PersonRef | null; finishedAt: string | null;
  headers: string[]; mapping: ColumnMapping; mappingProblem: string | null;
  counts: Record<RowClass, number> | null; progress: ImportProgress | null;   // progress nulo em prévia
  canConfirm: boolean; canContinue: boolean; canClose: boolean; canDiscard: boolean; hasErrorReport: boolean;
  phoneCheckDeferred: boolean;   // = !phoneFullFor(ator do pedido); a prévia mostra o aviso fixo (EX17.3)
};
export type BatchListItem = Omit<BatchSummary, 'headers' | 'mapping' | 'mappingProblem' | 'phoneCheckDeferred'>;
export type BatchList = { items: BatchListItem[]; total: number; page: number; pageSize: number };
export type RowDiffView = { field: string; label: string; before: string | null; after: string | null };
export type RowView = { rowNumber: number; classification: RowClass; name: string | null; registration: string | null;
  sector: string | null; reasons: string[]; warnings: string[]; diff: RowDiffView[]; selectable: boolean };
export type RowsPage = { items: RowView[]; total: number; page: number; pageSize: number };
```

**CX3. Erros, textos das linhas e trilha (T11a, T11b).**

`backend/src/modules/people-import/people-import.errors.ts` (T11a), todos `new DomainError({ code, status, message, detail })`, código com prefixo `people_import.`:

| Função | code / status | detail (texto da tela) |
|---|---|---|
| `importFileTooLarge()` | `file_too_large` / 422 | O arquivo passa de 5 MB. Divida a planilha e envie em partes. |
| `importTooManyRows()` | `too_many_rows` / 422 | A planilha tem linhas demais. Envie até 5.000 por vez. |
| `importInvalidFile()` | `invalid_file` / 422 | Envie um arquivo .csv ou .xlsx. |
| `importUnreadable(detail?)` | `unreadable` / 422 | Não foi possível ler a planilha. Confira se o arquivo abre no Excel e envie de novo. (com aspas sem fechamento: "O CSV tem aspas sem fechamento a partir da linha N.") |
| `importEmpty()` | `empty` / 422 | A planilha está vazia. |
| `importNoData()` | `no_data` / 422 | A planilha não tem linhas de dados abaixo do cabeçalho. |
| `importDuplicateHeader(name)` | `duplicate_header` / 422 | A coluna 'NOME' aparece mais de uma vez no cabeçalho. |
| `mappingIncomplete(detail)` | `mapping_incomplete` / 422 | o texto de `mappingProblem` (CX6) |
| `batchNotFound()` | `batch_not_found` / 404 | Lote não encontrado. |
| `notUploader()` | `not_uploader` / 403 | Só quem enviou a planilha pode mudar as colunas ou confirmar a importação. |
| `notConfirmer()` | `not_confirmer` / 403 | Só quem confirmou a importação pode continuar a gravação. |
| `closeAdminOnly()` | `close_admin_only` / 403 | Só o administrador pode encerrar a gravação. |
| `importNoManagedSector()` | `no_managed_sector` / 403 | Você não gerencia nenhum setor. |
| `alreadyConfirmed()` | `already_confirmed` / 409 | Esta importação já foi confirmada. |
| `previewChanged()` | `preview_changed` / 409 | A prévia mudou depois que você a abriu. Confira de novo antes de confirmar. (revisão T19, Important 1) |
| `notInPreview()` | `not_preview` / 409 | A prévia deste lote não está mais disponível. |
| `notWriting()` | `not_writing` / 409 | A gravação deste lote já terminou ou foi encerrada. |
| `nothingSelected()` | `nothing_selected` / 422 | Escolha pelo menos uma linha para gravar. |

`fromSheetReadError(error: SheetReadError): DomainError` fica em `upload-format.ts` (**T16**, que já consome o `SheetReadError` da T3; revisão 1, I3): `empty` → `importEmpty()`; `no_data` → `importNoData()`; `too_many_rows` → `importTooManyRows()`; `duplicate_header` → `importDuplicateHeader(detail)`; `unreadable` → `importUnreadable()`; `unclosed_quote` → `importUnreadable('O CSV tem aspas sem fechamento a partir da linha N.')`; `expands_too_much` → `importUnreadable('A planilha fica grande demais ao abrir. Divida a planilha e envie em partes.')`.

`backend/src/modules/people-import/row-texts.ts` (T11a), `export const ROW_TEXT` — os únicos textos de motivo e aviso de linha:

```ts
noKey: 'Sem matrícula nem telefone para identificar',
phoneTaken: 'O telefone já pertence a outra pessoa cadastrada',
registrationTaken: 'A matrícula já pertence a outra pessoa cadastrada',
duplicateOf: (first: number) => `Linha repetida: a mesma matrícula ou o mesmo telefone já aparece na linha ${first}`,
invalidName: 'Nome inválido', newNeedsName: 'Pessoa nova precisa de nome', newNeedsPhone: 'Pessoa nova precisa de telefone',
invalidPhone: 'Telefone inválido',
tooLong: (label: string, max: number) => `${label} com mais de ${max} caracteres`,   // Nome 120, Função 80, Matrícula 30, Detalhe da origem 120
inactivePerson: 'Pessoa inativa; reative na ficha',
notFound: (kind: 'Setor' | 'Turno' | 'Nível', text: string) => `${kind} '${text}' não encontrado`,
ambiguous: (kind: 'Setor' | 'Turno' | 'Nível', text: string) => `${kind} '${text}' corresponde a mais de um`,
notInReach: (text: string) => `Setor '${text}' não encontrado entre os setores que você gerencia`,
sectorRequired: 'Informe o setor',
cannotEditPerson: 'Você não pode alterar esta pessoa.',
cannotEditPhone: 'Você não pode alterar o telefone desta pessoa.',
cannotEditAuthorization: 'Você não pode alterar a autorização desta pessoa.',
authorizationWithoutSource: 'Autorização ignorada: falta a origem.',
authorizationWithoutNote: 'Autorização ignorada: falta o detalhe da origem.',
noRevoke: 'A planilha não retira autorização; faça na ficha da pessoa.',
invalidYesNo: 'Autorização de contato inválida: use Sim ou Não',
invalidDate: 'Data da autorização inválida: use DD/MM/AAAA',
futureDate: 'Data da autorização no futuro',
newWithoutAuthorization: 'Esta pessoa não receberá mensagens até ter a autorização registrada.',
mustLoginAgain: 'Esta pessoa terá de entrar de novo no sistema.',
example: 'Linha de exemplo', blank: 'Linha em branco',
changedAfterPreview: 'A pessoa foi alterada depois da prévia',
removedAfterPreview: 'A pessoa foi removida depois da prévia',
structureInactive: 'Setor, turno ou nível não está mais ativo',
notWrittenClosed: 'Não gravada: gravação encerrada',
writeFailed: 'Não foi possível gravar esta linha.',
```

`backend/src/modules/people-import/import-trail.ts` (T11b), no molde de `people-export/export-trail.ts`:

```ts
export function importReason(fileName: string): string;   // `Importação de planilha: ${fileName}`, cortado em 200
// ImportEnding e ImportResultCounts vêm de import-person.ts (T11a, CX14)
export function importConfirmedChange(input: { actorId: string; batchId: string; fileName: string; rowCount: number;
  toCreate: number; toUpdate: number }): AuditChange;
  // action 'people_import.confirmed', entity 'Spreadsheet', entityId batchId, category 'SPREADSHEET', subjectUserId null, reason null
  // changes (before null), nesta ordem: fileName, rowCount, toCreate, toUpdate
export function importCompletedChange(input: { actorId: string; batchId: string; fileName: string; ending: ImportEnding;
  counts: ImportResultCounts }): AuditChange;
  // action 'people_import.completed'; reason = 'Encerrada automaticamente: gravação interrompida há mais de 7 dias.' só em AUTO_CLOSED
  // changes: fileName, ending, rowCount (= counts.rows), created, updated, unchanged, invalid, duplicate, conflict, failed,
  // phoneTaken (sempre, só o número; Conselho S), notWritten e, só quando > 0, writing
```

**CX4. Ator (T11b), `backend/src/modules/people-import/import-actor.ts`.**

```ts
import type { PermissionActor } from '../../shared/authz/person-actions.policy';
export type ImportActor = { id: string; isAdmin: boolean; fullPhone: boolean; canEditPeople: boolean;
  reach: readonly string[] | null; policy: PermissionActor };          // reach null = ADMIN
export function toImportActor(actor: TeamActor): ImportActor;          // fullPhone = hasPermission(actor, 'telefone.ver_completo'); canEditPeople = 'pessoas.editar'
export function loadImportActor(prisma: PrismaService, id: string): Promise<ImportActor>;
  // findTeamActor (team-whatsapp/team-actor.query.ts); ausente, inativo ou sem acesso → permissionDenied('pessoas.importar')
export function assertCanWrite(actor: ImportActor): void;
  // !isAdmin && !canEditPeople → permissionDenied('pessoas.editar'); !isAdmin && reach vazio → importNoManagedSector()
export function canSeeBatch(actor: ImportActor, batch: { createdById: string }): boolean;  // isAdmin || createdById === id
export function phoneFullFor(actor: ImportActor): boolean;  // = actor.fullPhone (ADMIN tem todas as chaves; quem não é ADMIN só toca pessoa sem login)
```

**CX5. Tabelas (T2), `backend/prisma/schema.prisma`, migração `20261119130100_people_import_tables`.**

```prisma
enum PeopleImportStatus { PREVIEW WRITING COMPLETED CLOSED }
enum PeopleImportRowClass { CREATE UPDATE UNCHANGED INVALID DUPLICATE CONFLICT IGNORED }
enum PeopleImportWriteState { PENDING RESERVED DONE }
enum PeopleImportOutcome { CREATED UPDATED UNCHANGED FAILED NOT_WRITTEN }

/// Lote de importação de pessoas (Lote E). Não é o ImportBatch dos contatos.
model PeopleImportBatch {
  id            String             @id @default(cuid())
  fileName      String             @db.VarChar(255)
  fileSize      Int
  fileSha256    String             @db.Char(64)
  format        String             @db.VarChar(4)   // 'csv' | 'xlsx'
  headers       Json                                // string[] na ordem do arquivo
  mapping       Json                                // ColumnMapping
  previewCounts Json?                               // Record<RowClass, number>; nulo com mapeamento incompleto
  status        PeopleImportStatus @default(PREVIEW)
  createdById   String                              // sem FK (como UserAssignment.recordedById)
  createdAt     DateTime           @default(now())
  confirmedById String?
  confirmedAt   DateTime?
  lastBlockAt   DateTime?
  finishedAt    DateTime?
  closedById    String?
  result        Json?                               // ImportResultCounts final
  updatedAt     DateTime           @updatedAt
  rows          PeopleImportRow[]

  @@index([createdById, createdAt])
  @@index([status, createdAt])
}

model PeopleImportRow {
  id               String                  @id @default(cuid())
  batchId          String
  batch            PeopleImportBatch       @relation(fields: [batchId], references: [id], onDelete: Cascade)
  rowNumber        Int                                     // linha no arquivo (cabeçalho = 1)
  cells            Json?                                   // { "<índice>": "texto" }; nulo depois de limpo (EX14)
  classification   PeopleImportRowClass?                   // nulo com mapeamento incompleto
  reasons          Json                    @default("[]")  // string[]
  warnings         Json                    @default("[]")  // string[]
  preview          Json?                                   // { personName: string | null, diff: FieldDiff[] }
  plan             Json?                                   // RowPlan (CX10)
  personId         String?                                 // sem FK
  writeState       PeopleImportWriteState?                 // nulo = não vai ser gravada
  reservedUntil    DateTime?
  reservationToken String?                 @db.VarChar(36)
  outcome          PeopleImportOutcome?
  outcomeReason    String?                 @db.VarChar(200)
  writtenAt        DateTime?

  @@unique([batchId, rowNumber])
  @@index([batchId, classification, rowNumber])
  @@index([batchId, writeState, rowNumber])
}
```

**CX6. Leitura e mapeamento (T3, T4, T5).**

```ts
// backend/src/shared/spreadsheet/sheet-data.ts (T3)
export const IMPORT_MAX_BYTES = 5 * 1024 * 1024;
export const IMPORT_MAX_ROWS = 5_000;
export const XLSX_MAX_UNCOMPRESSED = 60 * 1024 * 1024;            // EX3
export type SheetRow = { rowNumber: number; cells: string[] };    // cabeçalho = linha 1; só linhas com valor
export type SheetData = { headers: string[]; rows: SheetRow[] };
export type SheetReadProblem = 'empty' | 'no_data' | 'too_many_rows' | 'duplicate_header' | 'unreadable' | 'unclosed_quote'
  | 'expands_too_much';
export class SheetReadError extends Error { constructor(readonly problem: SheetReadProblem, readonly detail: string | null = null) }
export class SheetCollector {
  add(rowNumber: number, cells: readonly string[]): void;
    // o primeiro add é o cabeçalho. Depois dele, registro com todas as células vazias depois do trim é descartado (não é guardado
    // nem contado). O registro com valor de número IMPORT_MAX_ROWS + 1 lança 'too_many_rows' na hora: a leitura para ali (M5).
  finish(): SheetData;
    // nenhum add ou cabeçalho todo vazio → 'empty'. Largura = maior registro guardado; cabeçalho vazio → `Coluna N` (N a partir
    // de 1). Cabeçalho repetido (trim, sem diferenciar maiúsculas) → 'duplicate_header' com o texto. Nenhuma linha → 'no_data'.
    // Células completadas com '' até a largura.
}
// backend/src/shared/spreadsheet/csv-reader.ts (T3)
export function decodeCsv(buffer: Buffer): string;                 // EX2 (1)(2)
export function detectSeparator(text: string): ';' | ',';         // EX2 (3)
export function parseCsvRecords(text: string, separator: ';' | ',',
  onRecord: (rowNumber: number, cells: string[]) => void): void;  // EX2 (4); 'unclosed_quote' com detail `linha N`; erro de onRecord para a leitura
export function readCsvSheet(buffer: Buffer): SheetData;           // decode → separador → registros → unguardFormula nas células de dado → SheetCollector
// backend/src/shared/spreadsheet/zip-size.ts (T4)
export function zipUncompressedTotal(buffer: Buffer): number | null;   // EX3 (1); null = diretório central ilegível ou ZIP64
// backend/src/shared/spreadsheet/xlsx-reader.ts (T4)
export function xlsxCellText(value: ExcelJS.CellValue): string;   // EX3
export function readXlsxSheet(buffer: Buffer, opts?: { repair?: (buffer: Buffer) => Promise<Buffer> }): Promise<SheetData>;
// backend/src/modules/people-import/mapping.ts (T5)
export function normalizeHeader(text: string): string;            // NFD sem diacríticos, minúsculas, sem espaço, '_' nem '-'
export const FIELD_SYNONYMS: Readonly<Record<ImportField, readonly string[]>>;  // já normalizados:
  // registration: matricula, registro, id, cracha | name: nome, colaborador, funcionario | phone: telefone, celular, whatsapp, fone
  // jobTitle: funcao, cargo | sector: setor, area, departamento | shift: turno | level: nivel
  // authorization: autorizacaocontato, autorizacao | authorizationSource: origemautorizacao, origem
  // authorizationNote: detalheorigem, detalhe | authorizationDate: dataautorizacao
export function suggestMapping(headers: readonly string[]): ColumnMapping;  // por campo, a primeira coluna que casa; coluna usada não serve a outro campo
export function mappingProblem(mapping: ColumnMapping, input: { headerCount: number; isAdmin: boolean }): string | null;
  // índice ≥ headerCount → 'Coluna inexistente no arquivo.'; índice repetido → 'Cada coluna serve a um campo só.';
  // sem name, ou sem phone e sem registration → 'Escolha a coluna de Nome e pelo menos uma entre Telefone e Matrícula.';
  // !isAdmin e sem sector → 'Escolha a coluna de Setor: quem não é administrador informa o setor em todas as linhas.'
export function mappedColumns(mapping: ColumnMapping): number[];                     // crescente
export function unmappedColumns(mapping: ColumnMapping, headerCount: number): number[];
```

**CX7. Células e autorização (T6, T8).**

```ts
// backend/src/modules/people-import/cell-values.ts (T6)
// RowCells (= Readonly<Record<string, string>>, como gravado em PeopleImportRow.cells) vem de import-person.ts (T11a, CX14)
export type RawFields = Record<ImportField, string>;               // aparado; '' = vazio
export function rowCellsOf(cells: readonly string[]): RowCells;    // ['a','b'] → { '0': 'a', '1': 'b' }
export function fieldsOf(cells: RowCells, mapping: ColumnMapping): RawFields;
export function isMaskedPhoneText(text: string): boolean;
  // exatamente as duas formas da máscara: '•••• NNNN' (quatro '•', espaço, os 4 últimos dígitos) e '••••' sozinho
  // (conferido pelo revisor em shared/audit/audit-change.ts:76-80 e shared/authz/phone-visibility.ts)
export type ParsedFields = {
  isBlank: boolean; isExample: boolean;                             // todos os campos mapeados vazios; matrícula 'exemplo' sem caixa
  registration: { value: string; key: string } | null;              // normalizeRegistration (users/person-record.ts)
  name: string | null; nameMasked: boolean;                         // mascarado → name null e nameMasked
  phoneE164: string | null; phoneMasked: boolean;                   // normalizeToE164(raw, 'BR'); mascarado → null
  jobTitle: string | null;                                          // normalizeJobTitle (exportado na T14)
  sector: string | null; shift: string | null; level: string | null;   // texto da célula
  errors: string[];                                                 // tooLong, invalidPhone
};
export function parseFields(raw: RawFields): ParsedFields;
// backend/src/modules/people-import/authorization-plan.ts (T8)
export type AuthorizationCells = { answer: 'yes' | 'no' | null; source: AuthorizationSourceCode | null; sourceGiven: boolean;
  note: string | null; date: CivilDate | null; errors: string[] };
export function parseAuthorizationCells(raw: RawFields, today: CivilDate): AuthorizationCells;
  // answer: sim/s/x/1 → yes; não/nao/n/0 → no (sem caixa e acento); vazio → null; outro → errors [invalidYesNo]
  // source pelo rótulo de AUTHORIZATION_SOURCE_CELL normalizado (inclui CADASTRO_ANTERIOR); texto sem par → source null, sourceGiven true
  // note > 120 → tooLong('Detalhe da origem', 120); date DD/MM/AAAA ou AAAA-MM-DD (data civil válida) → AAAA-MM-DD;
  // inválida → invalidDate; > today → futureDate
// AuthorizationNow vem de import-person.ts (T11a):
// { status: 'AUTORIZADO' | 'NAO_AUTORIZADO'; source: AuthorizationSourceCode | null; note: string | null; date: CivilDate | null }
export type AuthorizationPlan = { input: ContactAuthorizationInput | null; warnings: string[]; errors: string[] };   // input null = não mexe; errors = o que invalida a linha (vazio com canEdit falso; ruling T8 R1)
export function planAuthorization(input: { cells: AuthorizationCells; current: AuthorizationNow | null; canEdit: boolean }): AuthorizationPlan;
export function authorizationSatisfied(current: AuthorizationNow, input: ContactAuthorizationInput): boolean;
  // AUTORIZADO: mesmo status, origem e detalhe, e (input.date ausente ou igual); NAO_AUTORIZADO: status igual
```

Regras de `planAuthorization` (spec E4, conselho R1; `current` nulo = pessoa nova):

| Células | Resultado |
|---|---|
| `answer` nulo | `input` nulo; pessoa nova → aviso `newWithoutAuthorization` |
| Não, pessoa nova ou não autorizada | `input` nulo (pessoa nova: aviso `newWithoutAuthorization`) |
| Não, pessoa autorizada | `input` nulo, aviso `noRevoke` |
| Sim + origem TERMO_ASSINADO/FICHA_ADMISSAO/ACEITE_WHATSAPP, ou OUTRO com detalhe | `{ status: 'AUTORIZADO', source, note?, date? }`; data vazia: ausente (hoje na gravação), salvo pessoa já autorizada com a mesma origem (spec E4; detalhe igual ou não) → `date` = data atual da pessoa (revisão T8, Important 1); se já igual ao atual → `input` nulo |
| Sim + OUTRO sem detalhe | `input` nulo, aviso `authorizationWithoutNote`; pessoa nova: + `newWithoutAuthorization` |
| Sim sem origem ou com origem desconhecida | `input` nulo, aviso `authorizationWithoutSource`; pessoa nova: + `newWithoutAuthorization` |
| Sim + CADASTRO_ANTERIOR, pessoa já AUTORIZADO com CADASTRO_ANTERIOR | `input` nulo, **sem aviso** (aceite 10) |
| Sim + CADASTRO_ANTERIOR, outro caso | `input` nulo, aviso `authorizationWithoutSource` |
| `canEdit` falso e o resultado acima mudaria algo | `input` nulo, aviso só `cannotEditAuthorization` |
| Célula com erro (`cells.errors`), `canEdit` verdadeiro | `input` nulo, `errors` = `cells.errors` (a linha fica inválida) |
| Célula com erro, `canEdit` falso | `input` nulo, `errors` vazio, aviso só `cannotEditAuthorization` (colunas ignoradas, spec E4) |

**CX8. Estrutura (T7), `backend/src/modules/people-import/structure-match.ts`.**

```ts
export type StructureKind = 'sector' | 'shift' | 'level';
export type StructureOption = { id: string; name: string; code: string | null; isActive: boolean };  // code só em setor
export type StructureCatalog = Readonly<Record<StructureKind, readonly StructureOption[]>>;        // todos, ativos e inativos
export type StructureMatch = { ok: true; id: string } | { ok: false; reason: string };
export function normalizeStructureName(text: string): string;   // NFD sem acento, minúsculas, espaços colapsados, trim
export function matchStructure(input: { kind: StructureKind; text: string; catalog: StructureCatalog;
  currentId: string | null; reach: readonly string[] | null }): StructureMatch;
  // (1) a opção currentId casa pelo nome (setor: ou código) → { ok, id: currentId }, mesmo inativa;
  // (2) entre as ATIVAS (setor com reach ≠ null: só as do alcance) que casam pelo nome (setor: ou código): 1 → ok;
  //     >1 → ambiguous(rótulo, text); 0 → setor com reach ≠ null ? notInReach(text) : notFound(rótulo, text)
export function structureName(catalog: StructureCatalog, kind: StructureKind, id: string | null): string | null;
```

**CX9. Pessoa, diff e versão (T9), `backend/src/modules/people-import/person-diff.ts`.**

```ts
// ImportPerson, AuthorizationNow, ImportPatch, DiffField e FieldDiff vêm de import-person.ts (T11a, CX14)
export type ResolvedRow = { name: string | null; phoneE164: string | null; jobTitle: string | null;
  registration: string | null; sectorId: string | null; shiftId: string | null; levelId: string | null;
  authorization: ContactAuthorizationInput | null };                   // null = célula vazia (ou fora por EX17): não altera
export function diffPerson(input: { person: ImportPerson; row: ResolvedRow; catalog: StructureCatalog }): { patch: ImportPatch; diff: FieldDiff[] };
  // campo entra no patch só se a linha traz valor e ele difere do atual (EX33)
export function patchSatisfied(person: ImportPerson, patch: ImportPatch): boolean;   // cada campo do patch já é o atual
export function personFingerprint(person: ImportPerson): string;                      // EX12
export function authorizationLabel(value: AuthorizationNow | ContactAuthorizationInput): string;
  // 'Não' | 'Sim — <rótulo da origem>[ — <detalhe>] — DD/MM/AAAA' (data ausente na entrada: 'data da gravação'; `AuthorizationNow` com `date` nulo, ex.: backfill de Cadastro anterior: 'sem data registrada' — revisão T9, Important 1)
export function samePhone(a: string | null, b: string | null): boolean;              // brazilianPhoneVariants
```

**CX10. Classificação (T10), `backend/src/modules/people-import/{classify-row,duplicates}.ts`.**

```ts
export type PeopleLookup = { byRegistrationKey: ReadonlyMap<string, ImportPerson>; byPhone: ReadonlyMap<string, ImportPerson> };
  // byPhone chaveado por cada grafia de brazilianPhoneVariants
// RowKeys, CreatePlan, RowPlan, RowPreview e RowVerdict vêm de import-person.ts (T11a, CX14)
export function duplicateOf(rows: readonly { rowNumber: number; fields: ParsedFields }[]): ReadonlyMap<number, number>;  // EX31
export function identify(input: { fields: ParsedFields; lookup: PeopleLookup; actor: ImportActor }):
  { person: ImportPerson | null; conflict: boolean };
export function classifyRow(input: { fields: ParsedFields; authorization: AuthorizationCells; lookup: PeopleLookup;
  catalog: StructureCatalog; actor: ImportActor; today: CivilDate }): RowVerdict;   // EX15–EX17
```
`personId` só em Atualizar e Sem alteração; `preview.personName` = nome atual cru, só em Atualizar e Sem alteração.

**CX11. Repositórios (T12, T13a, T13b).** `RowCells`, `RowVerdict`, `RowPreview`, `RowPlan`, `RowOutcome`, `ImportResultCounts`, `TrailWriter` vêm de `import-person.ts` (T11a, CX14).

```ts
// backend/src/modules/people-import/people-import.repository.ts (T12)
export type RowRecord = { rowNumber: number; cells: RowCells; verdict: RowVerdict | null };
export type NewBatch = { fileName: string; fileSize: number; fileSha256: string; format: 'csv' | 'xlsx'; headers: string[];
  mapping: ColumnMapping; previewCounts: Record<RowClass, number> | null; createdById: string };
export type BatchRecord = NewBatch & { id: string; status: PeopleImportStatus; createdAt: Date; confirmedById: string | null;
  confirmedAt: Date | null; lastBlockAt: Date | null; finishedAt: Date | null; closedById: string | null;
  result: ImportResultCounts | null };
export type StoredRow = { rowNumber: number; cells: RowCells | null; classification: RowClass | null; reasons: string[];
  warnings: string[]; preview: RowPreview | null };
export type ReportRow = { rowNumber: number; cells: RowCells | null; reasons: string[]; outcomeReason: string | null };
@Injectable() export class PeopleImportRepository {
  createBatch(batch: NewBatch, rows: readonly RowRecord[]): Promise<string>;     // transação; createMany em blocos de 1.000
  replaceRows(batchId: string, input: { mapping: ColumnMapping; previewCounts: Record<RowClass, number> | null;
    rows: readonly RowRecord[] }): Promise<boolean>;                              // false = lote não está em PREVIEW
  findBatch(id: string): Promise<BatchRecord | null>;
  readRowCells(batchId: string): Promise<{ rowNumber: number; cells: RowCells }[]>;
  pageRows(batchId: string, query: { page: number; classification?: RowClass }): Promise<{ total: number; items: StoredRow[] }>;
  listBatches(query: { createdById: string | null; page: number }): Promise<{ total: number; items: BatchRecord[] }>;  // createdAt desc
  deletePreview(id: string): Promise<boolean>;                                    // só PREVIEW; linhas em cascata
  deleteStalePreviews(cutoff: Date): Promise<number>;
  findPeopleByKeys(input: { registrationKeys: readonly string[]; phones: readonly string[]; ids?: readonly string[] }): Promise<ImportPerson[]>;
    // blocos de 1.000; OR de registrationKey in, phoneE164 in e id in; lista vazia não consulta aquela chave.
    // phones [] para quem não tem telefone.ver_completo (T15, EX17.3); ids = o personId da linha de criação (T20a, EX17.4 a)
  loadCatalog(): Promise<StructureCatalog>;
  userNames(ids: readonly string[]): Promise<Map<string, string | null>>;
  reportRows(batchId: string, after: number, take: number): Promise<ReportRow[]>;  // EX23, rowNumber > after
}
// backend/src/modules/people-import/people-import-write.repository.ts (T13a)
export type ReservedRow = { id: string; rowNumber: number; plan: RowPlan; personId: string | null };
  // personId: na criação, o id que a pessoa vai ter (nunca nulo depois da reserva; EX9, EX17.4 a); na atualização, o da prévia
export function newPersonId(): string;   // 'c' + randomUUID() sem hífens (33 caracteres)
@Injectable() export class PeopleImportWriteRepository {
  confirm(input: { batchId: string; actorId: string; now: Date; createNew: boolean; updateExisting: boolean;
    excludedRows: readonly number[]; unmappedColumns: readonly number[];
    trail: TrailWriter<{ toCreate: number; toUpdate: number }> }): Promise<{ toCreate: number; toUpdate: number } | 'not_preview' | 'nothing_selected'>;
    // EX7, EX8, EX14 (ao confirmar); 'not_preview' = o updateMany condicional não achou o lote em PREVIEW do ator (o serviço responde already_confirmed)
  touchBlock(batchId: string, now: Date): Promise<void>;
  reserveNextRow(input: { batchId: string; now: Date; token: string }): Promise<ReservedRow | null>;   // EX9; $personId = newPersonId() a cada chamada
  finalizeRow(input: { rowId: string; token: string; now: Date; result: RowOutcome }): Promise<boolean>;  // EX9, EX14 (ao gravar)
}
// backend/src/modules/people-import/people-import-close.repository.ts (T13b)
@Injectable() export class PeopleImportCloseRepository {
  completeIfDone(input: { batchId: string; now: Date; trail: TrailWriter<ImportResultCounts> }): Promise<boolean>;  // EX13
  close(input: { batchId: string; closedById: string; now: Date; trail: TrailWriter<ImportResultCounts> }): Promise<ImportResultCounts | null>;
    // EX13, EX14 (ao encerrar); null = lote não estava em WRITING; criação com personId de pessoa existente → CREATED, não NOT_WRITTEN (m8)
  settleExpired(batchId: string, now: Date): Promise<number>;                       // lote CLOSED: reservas vencidas → NOT_WRITTEN (criação com pessoa já criada → CREATED, m8)
  staleWriting(cutoff: Date): Promise<{ id: string; confirmedById: string; fileName: string }[]>;
  resultCounts(batchId: string): Promise<ImportResultCounts>;                       // groupBy de classificação, writeState e outcome;
    // phoneTaken = count de outcome FAILED com outcomeReason = ROW_TEXT.phoneTaken (pelas linhas, sem coluna nova; EX17.3)
}
```

**CX12. Serviços (T15–T20b).**

```ts
// batch-classifier.ts (T15)
export function buildLookup(people: readonly ImportPerson[]): PeopleLookup;
export function countByClass(rows: readonly RowRecord[]): Record<RowClass, number>;   // todas as classes, inclusive 0
@Injectable() export class BatchClassifier {
  classify(input: { rows: readonly { rowNumber: number; cells: RowCells }[]; mapping: ColumnMapping; actor: ImportActor;
    today: CivilDate }): Promise<{ rows: RowRecord[]; counts: Record<RowClass, number> }>;
}
// people-import-query.service.ts (T17)
export function batchSituation(batch: BatchRecord, now: Date): BatchSituation;   // EX11
@Injectable() export class PeopleImportQueryService {
  visibleBatch(actor: ImportActor, batchId: string): Promise<BatchRecord>;        // 404 batchNotFound (GX9)
  summary(actorId: string, batchId: string): Promise<BatchSummary>;
  summaryFor(actor: ImportActor, batch: BatchRecord): Promise<BatchSummary>;      // CLOSED → settleExpired antes
  rows(actorId: string, batchId: string, query: { page: number; classification?: RowClass }): Promise<RowsPage>;  // EX26
  list(actorId: string, query: { page: number }): Promise<BatchList>;
}
// row-view.ts (T17)
export function toRowView(input: { row: StoredRow; mapping: ColumnMapping; actor: ImportActor }): RowView;
// people-import-files.service.ts (T18)
@Injectable() export class PeopleImportFilesService {
  template(format: SpreadsheetFormat, sink: DownloadSink): Promise<void>;
  errorReport(actorId: string, batchId: string, sink: DownloadSink): Promise<void>;
}
// people-import-confirm.service.ts (T19)
@Injectable() export class PeopleImportConfirmService {
  confirm(actorId: string, batchId: string, body: ConfirmBody): Promise<BatchSummary>;
  close(actorId: string, batchId: string): Promise<BatchSummary>;
  completeIfDone(batch: BatchRecord): Promise<void>;
  closeStale(now: Date): Promise<number>;                                          // EX13 automático
}
// row-writer.ts (T20a)
@Injectable() export class RowWriter {
  write(input: { plan: RowPlan; personId: string | null; actor: ImportActor; reason: string; catalog: StructureCatalog }): Promise<RowOutcome>;
    // catalog carregado uma vez por bloco pela T20b (loadCatalog, T12): dá o nome do setor de notInReach (EX19 a)
    // personId = ReservedRow.personId (T13a): na criação, o id da pessoa a criar e a procurar antes (EX17.4 a)
}
// people-import-writer.service.ts (T20b)
@Injectable() export class PeopleImportWriterService { writeBlock(actorId: string, batchId: string): Promise<BatchSummary> }
export const BLOCK_MAX_ROWS = 50; export const BLOCK_MAX_MS = 10_000; export const RESERVATION_MS = 5 * 60_000;
// upload-format.ts (T16)
export function formatOf(name: string, buffer: Buffer): 'csv' | 'xlsx' | null;   // EX4
export function uploadedFileName(originalName: string): string;                 // EX4 (M6): latin1 → UTF-8, sem caminho, até 255
export function fromSheetReadError(error: SheetReadError): DomainError;         // CX3
// people-import-preview.service.ts (T16)
export type UploadedSheet = { originalName: string; size: number; buffer: Buffer };   // originalName cru do multer
@Injectable() export class PeopleImportPreviewService {
  upload(actorId: string, file: UploadedSheet): Promise<BatchSummary>;
  remap(actorId: string, batchId: string, mapping: ColumnMapping): Promise<BatchSummary>;
  discard(actorId: string, batchId: string): Promise<void>;
}
```

Aba "Instruções" do modelo (T18, EX24), linhas na coluna A, nesta ordem: "Preencha uma pessoa por linha, a partir da linha 2. A linha com matrícula EXEMPLO é ignorada."; "Aceita arquivos .csv e .xlsx de até 5 MB e 5.000 linhas."; "A pessoa é encontrada pela matrícula; sem matrícula, pelo telefone (quem não vê telefone completo: só pela matrícula)."; "Pessoa nova precisa de nome e telefone. Setor, turno, nível, função e matrícula são opcionais. Quem não é administrador informa o setor em todas as linhas."; "Célula vazia não altera o que já está cadastrado. A planilha não apaga valores, não inativa nem reativa pessoas e não cria acesso ao sistema."; "Setor, turno e nível pelo nome (setor também pelo código), como estão cadastrados e ativos."; "autorizacao_contato: Sim ou Não. Sim só vale com origem_autorizacao (Termo assinado, Ficha de admissão, Aceite por WhatsApp ou Outro; Outro exige detalhe_origem). data_autorizacao em DD/MM/AAAA; vazia = dia da gravação. A planilha não retira autorização."; linha vazia; `Coluna` / `Significado` e uma linha por coluna de `PEOPLE_TEMPLATE_COLUMNS` com `PEOPLE_COLUMN_MEANING`.

**CX13. Front (T24), `frontend/src/features/people-import/`.**

```ts
// schemas.ts — espelho de CX2 em zod (parse das respostas): ROW_CLASSES, IMPORT_FIELDS, batchSummarySchema, batchListSchema,
// rowsPageSchema; tipos BatchSummary, BatchListItem, RowView, RowsPage, ColumnMapping, ImportField, RowClass, BatchSituation
// labels.ts
export const ROW_CLASS_LABEL: Record<RowClass, string>;   // Criar, Atualizar, Sem alteração, Inválida, Duplicada, Conflito, Ignorada
export const SITUATION_LABEL: Record<BatchSituation, string>;  // Em prévia, Gravando, Gravação interrompida, Concluída, Encerrada
export const FIELD_LABEL: Record<ImportField, string>;    // os rótulos de IMPORT_FIELD_LABEL
export function confirmText(toCreate: number, toUpdate: number): string;
  // 'Criar 12 e atualizar 30 pessoas'; só um lado: 'Criar 12 pessoas' / 'Atualizar 30 pessoas'; 1 → 'pessoa'
// api.ts (prefixo internal/people-import; timeout 120_000 no envio, no remapear, na confirmação e no bloco)
export function useImportBatches(page: number): UseQueryResult<BatchList>;
export function useImportBatch(id: string | undefined): UseQueryResult<BatchSummary>;
export function useImportRows(id: string, page: number, classification?: RowClass): UseQueryResult<RowsPage>;
export function useUploadImport(): UseMutationResult<BatchSummary, unknown, File>;      // FormData 'file', sem Content-Type
export function useRemapImport(id: string): UseMutationResult<BatchSummary, unknown, ColumnMapping>;
export function useConfirmImport(id: string): UseMutationResult<BatchSummary, unknown, { createNew: boolean; updateExisting: boolean; excludedRows: number[] }>;
export function writeBlock(id: string): Promise<BatchSummary>;                            // usado pelo laço da T27
export function useCloseImport(id: string): UseMutationResult<BatchSummary, unknown, void>;
export function useDiscardImport(id: string): UseMutationResult<void, unknown, void>;
export function downloadTemplate(format: 'csv' | 'xlsx'): Promise<void>;               // saveBlob + filenameFromDisposition do people-export
export function downloadErrors(id: string): Promise<void>;
export const IMPORT_MAX_BYTES = 5 * 1024 * 1024;
```

**CX14. Tipos das linhas (T11a), `backend/src/modules/people-import/import-person.ts`** (só tipos; revisão 1, I3: tudo o que mais de uma onda usa nasce na Onda 1).

```ts
import type { Prisma } from '@prisma/client';
import type { ContactAuthorizationInput } from '../../schemas/contracts/contact-authorization.schema';
import type { AuthorizationSourceCode } from '../../shared/spreadsheet/people-columns';
import type { CivilDate } from '../staff-schedule/civil-date';
import type { RowClass } from '../../schemas/contracts/people-import.schema';
export type RowCells = Readonly<Record<string, string>>;           // como gravado em PeopleImportRow.cells
export type AuthorizationNow = { status: 'AUTORIZADO' | 'NAO_AUTORIZADO'; source: AuthorizationSourceCode | null;
  note: string | null; date: CivilDate | null };
export type ImportPerson = { id: string; name: string | null; phoneE164: string | null; registration: string | null;
  registrationKey: string | null; jobTitle: string | null; sectorId: string | null; shiftId: string | null; levelId: string | null;
  authorization: AuthorizationNow; isActive: boolean; hasAccess: boolean };
export type ImportPatch = { name?: string; phone?: string; jobTitle?: string; registration?: string; sectorId?: string;
  shiftId?: string; levelId?: string; contactAuthorization?: ContactAuthorizationInput };   // subconjunto de UserPatch (T14)
export type DiffField = 'name' | 'phone' | 'registration' | 'jobTitle' | 'sector' | 'shift' | 'level' | 'authorization';
export type FieldDiff = { field: DiffField; before: string | null; after: string | null };
  // texto de exibição: setor/turno/nível pelo nome; autorização por authorizationLabel; telefone em E.164 e nome cru
  // (mascarados na leitura, T17)
export type RowKeys = { registrationKey: string | null; phoneE164: string | null };
export type CreatePlan = { name: string; phone: string; sectorId?: string; shiftId?: string; levelId?: string;
  jobTitle?: string; registration?: string; contactAuthorization?: ContactAuthorizationInput };
  // a T20a converte para PersonWithoutAccessInput (T14) com `sectorId: input.sectorId ?? null` (lá o campo é obrigatório e anulável)
export type RowPlan =
  | { kind: 'create'; keys: RowKeys; input: CreatePlan }
  | { kind: 'update'; keys: RowKeys; personId: string; fingerprint: string; patch: ImportPatch };
export type RowPreview = { personName: string | null; diff: FieldDiff[] };
export type RowVerdict = { classification: RowClass; reasons: string[]; warnings: string[];
  preview: RowPreview | null; plan: RowPlan | null; personId: string | null };
export type RowOutcome = { outcome: 'CREATED' | 'UPDATED' | 'UNCHANGED' | 'FAILED'; reason: string | null; personId: string | null };
export type ImportEnding = 'COMPLETED' | 'CLOSED' | 'AUTO_CLOSED';
export type ImportResultCounts = { rows: number; created: number; updated: number; unchanged: number; invalid: number;
  duplicate: number; conflict: number; ignored: number; failed: number; phoneTaken: number; notWritten: number; writing: number };
  // phoneTaken ⊂ failed: falhas por telefone já cadastrado (Conselho S, EX17.3)
export type TrailWriter<T> = (tx: Prisma.TransactionClient, data: T) => Promise<void>;
```

Quem usa: T6 (`RowCells`), T8 (`AuthorizationNow`), T9 (`ImportPerson`, `ImportPatch`, `DiffField`, `FieldDiff`), T10 (linhas), T11b (`ImportEnding`, `ImportResultCounts`), T12 (`RowCells`, `RowVerdict`, `RowPreview`, `ImportPerson`, `ImportResultCounts`), T13a (`RowPlan`, `RowOutcome`, `TrailWriter`), T13b (`ImportResultCounts`, `TrailWriter`), T15, T17 (`RowPreview`, `FieldDiff`, `DiffField`), T19, T20a (`RowPlan`, `CreatePlan`, `ImportPatch`, `RowOutcome`), T20b.

## Review Focus

Os seis casos mais prováveis de morder um usuário, cada um preso a um teste na task dona:

1. **Reimportar uma exportação apaga ou suja dados:** arquivo do ADMIN com pessoa inativa, setor inativo, nome `=SOMA(1;2)`, autorização "Cadastro anterior" e telefone estrangeiro → tudo "Sem alteração"; arquivo de quem não vê telefone completo → nome e telefone mascarados não gravam nada. Testes: T22b `it('aceite 10: exportação do ADMIN reimportada dá Sem alteração em todas as linhas')` e `it('aceite 28: exportação mascarada reimportada não grava nome nem telefone mascarado')`; T6 `it('telefone e nome no padrão mascarado contam como vazio')`; T8 `it('Cadastro anterior não autoriza; igual ao atual não muda nada nem avisa')`.
2. **Gestor descobre ou altera quem não alcança:** pessoa de outro setor, pessoa com login, palpite certo ou errado, telefone de outra pessoa, setor alheio → mesma resposta, sem nome nem diff. Testes: T10 `it('aceite 27: quem não é ADMIN recebe a mesma resposta para pessoa fora do alcance, com palpite certo ou errado')` e `it('aceite 24: sem telefone.ver_completo, célula de telefone igual, diferente e de outra pessoa dão a mesma classificação e o mesmo aviso')`; T7 `it('quem não é ADMIN: setor fora do alcance e inexistente dão o mesmo texto')`; T20a `it('trava de quem não é ADMIN conferida de novo na gravação')`, `it('setor de destino fora do alcance de agora: a linha falha com notInReach')` e `it('sem telefone.ver_completo na gravação: telefone fica fora da comparação e a linha falha com cannotEditPhone')`; T17 `it('lote de outra pessoa responde 404 para quem não é ADMIN; ADMIN vê')`. Telefone já cadastrado: item 6.
3. **Gravação em dobro:** dois cliques em Confirmar, duas abas pedindo bloco, aba fechada no meio e retomada depois de a reserva vencer (inclusive depois de criar a pessoa e antes de registrar). Testes: T13a `it('reserveNextRow: dois pedidos simultâneos nunca pegam a mesma linha')`, `it('confirm: duas confirmações simultâneas, só uma muda o lote e grava a trilha')`, R1 `it('reserveNextRow dá personId à linha de criação e mantém o mesmo depois que a reserva vence')`; T13b `it('completeIfDone grava a trilha uma vez mesmo com dois blocos terminando juntos')`; T20a R4 `it('retomada: pessoa criada pela linha e reserva vencida antes de registrar dá Sem alteração, sem a chave e sem matrícula')`; T22b `it('aceite 21: duas confirmações simultâneas gravam uma vez')`, `it('aceite 25: gravação interrompida e continuada não grava duas vezes')` e R4 `it('aceite 25 sem telefone.ver_completo e sem matrícula: retomada depois de criar dá Sem alteração')`.
4. **Planilha do Excel lida errado:** CSV "separado por vírgulas" em Windows-1252 com `“aspas”` e acentos, BOM, `,` no lugar de `;`, quebra de linha dentro de aspas, telefone e data digitados como número/data no XLSX. Testes: T3 `it('aceite 19: CSV em Windows-1252 é lido com acentos e aspas tipográficas')`, `it('aspas: campo com separador, aspas dobradas e quebra de linha dentro de aspas')`; T4 `it('fórmula vale pelo resultado; data vira AAAA-MM-DD sem fuso; número vira texto')`.
5. **Colunas que não interessam (CPF, endereço) ficam no banco:** depois de confirmar, nenhuma coluna não mapeada em nenhuma linha; depois de gravar, a linha só tem número, resultado e pessoa. Testes: T13a `it('aceite 26: confirmar apaga as colunas não mapeadas e o conteúdo das linhas fora da gravação')`, `it('finalizeRow: linha gravada perde cells e plan; falha guarda as colunas mapeadas')` (o `preview` já sai na confirmação, EX14); T22a `it('aceite 26: depois de gravar, o conteúdo da linha sai do banco')`.
6. **Telefone já cadastrado, para quem não tem `telefone.ver_completo` (Conselho S, EX17.2–EX17.4):** a prévia não pode responder diferente porque um número existe (nem pela consulta do lote, nem pela classificação, nem pelo resumo), e a gravação não pode dizer "Sem alteração" por coincidência de telefone; o erro é o mesmo para qualquer dono. Testes: T10 S1-1, S1-4, S2-2, S2-6; T15 S1-2 (spy: consulta sem telefone); T17/T26 S1-6 (aviso); T22b S1-7 (aceite 24, dois envios iguais); T20a S1-5, S2-4, S2-5 e R3 (`it('sem a chave, criação: matrícula de outra pessoa ou phone_taken falham sem comparar valores')`); com a chave e ADMIN, S1-3 (Conflito só com o texto fixo).

Também conferir na revisão: "Sim" sem origem nunca autoriza (T8, anti-objetivo); nenhum `prisma.user.create/update` no módulo novo (GX3); nenhum log com célula ou telefone (GX17); `shared/spreadsheet/` sem import de `src/modules/` (EX1).

## Rastreio (spec → task → teste)

| Aceite | Task | Teste que prova |
|---|---|---|
| 10 | T22b (+ T6, T8, T7) | `aceite 10: exportação do ADMIN reimportada dá Sem alteração em todas as linhas` (escritor real do Lote D) |
| 11 (T02) | T22a, T18 | `aceite 11 (T02): válida, duplicada e inválida; só a confirmada entra; o relatório traz as outras duas`; T18 `aceite 11: relatório traz linha, colunas mapeadas com o cabeçalho original e motivo` |
| 12 | T18, T10 | `aceite 12: modelo CSV com BOM, ;, cabeçalhos do modelo e linha EXEMPLO`; `modelo XLSX com abas Pessoas e Instruções`; T10 `linha de exemplo e linha em branco ficam Ignoradas` |
| 13 | T5, T16, T25 | `aceite 13: celular e cargo são reconhecidos, sem diferenciar acento, caixa, espaço e sublinhado`; T16 `aceite 13: remapear refaz a prévia; só quem enviou; só em prévia`; T25 `Ver prévia envia o mapeamento quando mudou` |
| 14 | T22a, T9, T17 | `aceite 14: atualizar por matrícula mostra antes e depois e grava ficha, trilha e vínculo com o motivo` |
| 15 | T8, T20a | `aceite 15: Sim sem origem não autoriza e avisa; Sim com origem autoriza com origem e data` |
| 16 | T22a | `aceite 16: reimportar a mesma planilha não cria ninguém` |
| 17 | T10 | `aceite 17: matrícula de uma pessoa e telefone de outra dá Conflito sem revelar quem` |
| 18 | T7, T10 | `aceite 18: setor, turno e nível inexistentes ou inativos invalidam com o nome no motivo`; T10 `aceite 18: setor inexistente deixa a linha Inválida com o nome` |
| 19 | T3 | `aceite 19: CSV em Windows-1252 é lido com acentos e aspas tipográficas` |
| 20 | T20a | `aceite 20: pessoa alterada depois da prévia falha; as outras linhas entram` (integração) |
| 21 | T13a, T13b, T19, T22b | T13a `confirm: duas confirmações simultâneas…`; T13b `completeIfDone grava a trilha uma vez…`; T19 `aceite 21: segunda confirmação responde 409 already_confirmed e não grava trilha`; T22b `aceite 21: duas confirmações simultâneas gravam uma vez` |
| 22 | T1, T21, T23, T28 | T1 `SUPERVISOR e OPERATOR não têm pessoas.importar por padrão; ADMIN tem`; T21 `toda rota exige a chave e nenhuma declara @Roles` (lista `CLASS_KEY_CONTROLLERS`); T28 `rota só para quem tem pessoas.importar` e `Importar planilha aparece para quem tem pessoas.importar` |
| 23 | T19, T17, T23 | T19 `confirma: marca a seleção, limpa e grava people_import.confirmed`, `completeIfDone grava people_import.completed com o confirmador como autor`; T17 `aceite 23: resumo traz arquivo, autor, envio, confirmação, fim e contagens` (com `phoneTaken`); T13b `resultCounts conta phoneTaken…`; T11b `importCompletedChange…` (com `phoneTaken`); T23 `ações e campos da importação traduzidos` |
| 24 | T10, T15, T16, T17, T20a, T22a, T22b, T26 | T10 `aceite 24: sem telefone.ver_completo, célula de telefone igual, diferente e de outra pessoa…`, S1-1, S1-3, S1-4, S2-1, S2-2, S2-6; T15 S1-2; T16 `remapear relê o ator: sem pessoas.editar agora, 403`; T17 `lote de outra pessoa responde 404…`, S1-6; T20a `trava de quem não é ADMIN…`, `setor de destino fora do alcance de agora…`, `sem telefone.ver_completo na gravação…`, S1-5, S2-3, S2-4, S2-5, R3; T22a S1-5; T22b S1-7 (`dois envios que diferem só por o número existir dão prévias iguais`); T26 S1-6 |
| 25 | T13a, T20a, T22b | T13a `reserva vencida volta a ser reservável; finalizeRow com token antigo não grava`, R1; T20a R4; T22b `aceite 25: …` e R4 (sem a chave e sem matrícula) |
| 26 | T13a, T13b, T22a | T13a `aceite 26: confirmar apaga…`; T13b `close: pendentes e reservas vencidas viram Não gravada…` (só colunas mapeadas); T22a `aceite 26: depois de gravar, o conteúdo da linha sai do banco` |
| 27 | T10, T7 | `aceite 27: …` |
| 28 | T22b, T6 | `aceite 28: …` |

| Item da spec | Task |
|---|---|
| Comum: permissões, matriz explícita, chave na classe, texto da recusa | T1, T21, T23 |
| Comum: formato do CSV (modelo e relatório) e leitura do apóstrofo | T3 (leitura), T18 (escrita pelo Lote D) |
| Comum: trilha Planilhas por `recordChange`, autor explícito, `changes` | T11b, T19, T23 |
| E1 fluxo em quatro passos e lista de lotes | T25, T26, T27, T28 |
| E2 tipos, limites, CSV, XLSX, cabeçalho, modelo, o que fica guardado e o prazo | T3, T4, T16, T18, T13a e T13b (EX14) |
| E3 mapeamento | T5, T16, T25 |
| E4 leitura da linha, identificação, conflito, duplicada, travas, autorização | T6, T7, T8, T9, T10 |
| E5 prévia, avisos, seleção, confirmação, descarte, 7 dias | T17, T26, T19, T16 |
| E6 gravação em blocos, ordem de conferência, reserva, encerrar, uma vez | T13a, T13b, T19, T20a, T20b, T27, T14 |
| E7 relatório, registro, trilha, quem vê | T18, T17, T19 |
| E8 menu, botão em Usuários, Novidades | T28, T23 |

## Mapa de arquivos

- Criar (back): `backend/src/shared/spreadsheet/{sheet-data,csv-reader,xlsx-reader,zip-size}.ts` e specs; `backend/src/modules/people-import/people-import-close.repository.ts` e `people-import-reserve.integration.spec.ts` (além da lista abaixo); `backend/src/schemas/contracts/people-import.schema.ts` e spec; `backend/src/modules/people-import/` — `people-import.errors.ts`, `row-texts.ts`, `import-trail.ts`, `import-actor.ts`, `mapping.ts`, `cell-values.ts`, `structure-match.ts`, `authorization-plan.ts`, `person-diff.ts`, `classify-row.ts`, `duplicates.ts`, `batch-classifier.ts`, `people-import.repository.ts`, `people-import-write.repository.ts`, `people-import-query.service.ts`, `row-view.ts`, `people-import-files.service.ts`, `import-template.ts`, `people-import-confirm.service.ts`, `row-writer.ts`, `people-import-writer.service.ts`, `people-import-preview.service.ts`, `upload-format.ts`, `spreadsheet-upload.interceptor.ts`, `people-import.controller.ts`, `people-import.module.ts`, `dto/*.dto.ts`, `people-import.e2e.fixtures.ts` e specs; migrações `backend/prisma/migrations/20261119130000_people_import_permission/migration.sql` e `20261119130100_people_import_tables/migration.sql`; `backend/src/modules/users/users.service.reason.spec.ts`.
- Modificar (back): `backend/src/shared/authz/permissions.ts`; `backend/prisma/schema.prisma`; `backend/src/modules/users/users.service.ts`; `backend/src/app.module.ts`; specs de permissão (`permissions.spec.ts`, `permissions.schema.spec.ts`, `role-permissions-migration.integration.spec.ts`, `sector-people.repository.integration.spec.ts`) e `route-parity.spec.ts` (uma linha na lista).
- Criar (front): `frontend/src/features/people-import/` (`schemas.ts`, `labels.ts`, `api.ts`, `use-write-loop.ts`, `components/{file-step,mapping-step,preview-step,preview-table,confirm-dialog,writing-step,result-step,import-page,steps-header,batch-list}.tsx` e specs); `frontend/src/routes/_authenticated/importar-pessoas/index.tsx` e spec.
- Modificar (front): `features/permissions/keys.ts` e specs; `features/audit-trail/{schemas,labels}.ts` e `labels.spec.ts`; `lib/nav.ts` e spec; `routes/_authenticated/users/index.tsx` e `users/index.spec.tsx`; `release-notes.ts`; `routeTree.gen.ts` (gerado).

---

## Task 1 — Chave `pessoas.importar` no back e semente da matriz (back)

**Arquivos:**
- Modificar: `backend/src/shared/authz/permissions.ts` (`PERMISSION_KEYS`, `PERMISSION_DENIED_TEXT`); `backend/src/shared/authz/permissions.spec.ts`; `backend/src/schemas/contracts/permissions.schema.spec.ts` (se conferir lista ou contagem); `backend/src/modules/permissions/role-permissions-migration.integration.spec.ts` (18 → 20 linhas); `backend/src/modules/sector-people/sector-people.repository.integration.spec.ts` (ADMIN com 10 chaves).
- Criar: `backend/prisma/migrations/20261119130000_people_import_permission/migration.sql`; `backend/src/modules/permissions/people-import-permission-migration.integration.spec.ts`.

**Interfaces:**
- Consome: tabela `RolePermission(role, key, granted, updatedAt, updatedById)`; `deployMigrations({ databaseUrl, until? })` de `backend/test/migrations.ts`; a migração do Lote D como molde.
- Produz: `PermissionKey` com `'pessoas.importar'` (T11b usa em `permissionDenied`; T21 no decorator; o front espelha na T23).

**Contexto vinculado:**
- Spec, Comum, Permissões (conselho R2): `pessoas.importar`, "Importar planilha de pessoas": ADMIN sim; SUPERVISOR, OPERATOR, VIEWER não. "O ADMIN pode liberar para Supervisor e Operador na tela de Permissões." Recusa: "Você não tem permissão para importar planilhas de pessoas." "A migração semeia Supervisor e Operador com as duas negadas."
- `DEFAULT_MATRIX` já é lista explícita desde o Lote D: **não muda** (a chave nova fica fora das listas de SUPERVISOR e OPERATOR). Chave entra **por último** em `PERMISSION_KEYS` (depois de `pessoas.exportar`).
- Migração, cópia do molde `20261119120000_people_export_permission/migration.sql` com a chave trocada: `INSERT INTO "RolePermission" ("role","key","granted") VALUES ('SUPERVISOR','pessoas.importar',false), ('OPERATOR','pessoas.importar',false) ON CONFLICT DO NOTHING;`, com o cabeçalho comentado (só insere; `updatedById` nulo; reaplicar não desfaz linha editada pela tela).
- Aceite 22: "Com a matriz padrão, Supervisor e Operador não têm nenhuma das duas chaves."
- GX11, GX12, GX14; asserções existentes portadas, nunca afrouxadas.

**Passos:**
1. [ ] RED `permissions.spec.ts` (describe irmão novo): `it('SUPERVISOR e OPERATOR não têm pessoas.importar por padrão; ADMIN tem')`; ajustar o teste do texto por chave de 9 para 10 ("texto para cada uma das 10 chaves"). Se algum fixture usar `'pessoas.importar'` como "chave desconhecida", trocar por `'chave.inexistente'`.
2. [ ] RED `people-import-permission-migration.integration.spec.ts` (deploy até `20261119120100_audit_category_spreadsheet`, depois o resto): `it('semeia pessoas.importar negada para SUPERVISOR e OPERATOR, sem autor')`; `it('não sobrescreve linha de pessoas.importar já gravada pela tela')`.
3. [ ] Ajustar `role-permissions-migration.integration.spec.ts` (18 → 20, comparação linha a linha com a matriz mantida) e `sector-people.repository.integration.spec.ts` (`toHaveLength(10)` no ADMIN e o título).
4. [ ] GREEN. `npx tsc` acha os `Record<PermissionKey, …>` exaustivos do back.
5. [ ] Validação: `timeout 600 gate --test src/shared/authz/permissions.spec.ts`; `timeout 600 gate --test src/schemas/contracts/permissions.schema.spec.ts`; `TESTCONTAINERS_ENABLED=1 timeout 600 gate --test` em `src/modules/permissions/people-import-permission-migration.integration.spec.ts`, `src/modules/permissions/role-permissions-migration.integration.spec.ts`, `src/modules/permissions/people-export-permission-migration.integration.spec.ts` (não pode quebrar), `src/modules/sector-people/sector-people.repository.integration.spec.ts`, `src/modules/permissions/route-parity.spec.ts`; typecheck; `TESTCONTAINERS_ENABLED=1 timeout 600 gate --changed --base feat/planilhas-pessoas`.

**Aceite:** spec aceite 22 (matriz padrão) e base do 22 nas rotas.

**Risco: crítico (autorização)** — acrescenta a chave que libera a importação; erro aqui dá a Supervisor ou Operador o poder de criar e alterar pessoas em lote.

## Task 2 — Tabelas do lote e das linhas (back)

**Arquivos:**
- Modificar: `backend/prisma/schema.prisma` (quatro enums e dois models de CX5, no fim do arquivo).
- Criar: `backend/prisma/migrations/20261119130100_people_import_tables/migration.sql`; `backend/src/modules/people-import/people-import-tables-migration.integration.spec.ts`.

**Interfaces:**
- Consome: padrão de SQL à mão de `20261119110000_user_assignment_history/migration.sql`; `deployMigrations`, `schemaDrift` (`backend/test/migrations.ts`).
- Produz: CX5 no client gerado (`npx prisma generate`): `PeopleImportBatch`, `PeopleImportRow`, enums `PeopleImportStatus`, `PeopleImportRowClass`, `PeopleImportWriteState`, `PeopleImportOutcome`.

**Contexto vinculado:**
- Spec, Fica com o construtor: "Nome e desenho das tabelas do lote de importação e das linhas (não reaproveitar `ImportBatch`/`ImportItem`, que são de contatos)." Restrições: "Migração só aditiva; nada destrutivo."
- EX5: ids de pessoa sem FK; `cells` em `jsonb` como objeto índice → texto. `Json` do Prisma é `jsonb` no Postgres: conferir no SQL gerado.
- E2: "O arquivo em si não é guardado. Ficam o nome, o tamanho, o resumo SHA-256 e as linhas lidas."
- GX11: SQL à mão, nunca `migrate dev`; o drift do schema contra as migrações tem de sair vazio (ou só o `DROP TABLE` de quarentena já tolerado).

**Passos:**
1. [ ] RED `people-import-tables-migration.integration.spec.ts`: `it('cria lote e linhas; apagar o lote apaga as linhas')`; `it('número da linha é único por lote')`; `it('cells é jsonb: o operador - tira as chaves pedidas')` (`UPDATE … SET "cells" = "cells" - ARRAY['1']::text[]`).
2. [ ] GREEN: schema, migração (`CREATE TYPE` dos quatro enums, `CREATE TABLE`, `@@unique`, índices, FK com `ON DELETE CASCADE`), `npx prisma validate`, `npx prisma generate`.
3. [ ] Validação: `TESTCONTAINERS_ENABLED=1 timeout 600 gate --test src/modules/people-import/people-import-tables-migration.integration.spec.ts`; `TESTCONTAINERS_ENABLED=1 timeout 600 gate --test src/modules/shifts/shift-migration.integration.spec.ts` (drift); typecheck; `--changed`.

**Aceite:** base dos aceites 23 e 26 (registro e limpeza dependem das colunas).

**Risco: alto** (migração aditiva em produção; tabelas novas, nenhum dado existente muda). **Revisor `opus`** (decisão da coordenação, revisão 1): as tabelas guardam dado pessoal do arquivo e sustentam a reserva e a limpeza (EX9, EX14).

## Task 3 — Leitor de CSV e dados da planilha (back)

**Arquivos:**
- Criar: `backend/src/shared/spreadsheet/sheet-data.ts`, `csv-reader.ts`, `sheet-data.spec.ts`, `csv-reader.spec.ts`.

**Interfaces:**
- Consome: `unguardFormula` (`shared/spreadsheet/cell-rules.ts`, Lote D).
- Produz: CX6 (parte T3).

**Contexto vinculado:**
- Spec E2: "CSV: separador `;` ou `,` detectado pela linha de cabeçalho; aspas no padrão; UTF-8 com ou sem BOM. Arquivo que não é UTF-8 válido é lido como Windows-1252, que é como o Excel em português salva 'CSV (separado por vírgulas)'." "Cabeçalho repetido, arquivo vazio ou sem linha de dados: 422 com texto próprio." Limite 5.000 linhas de dados.
- Spec, Comum, Formato do CSV: "Na leitura (importação) de CSV, um apóstrofo inicial é tirado quando o que vem depois são esses caracteres (`=`, `+`, `-`, `@`, tabulação, retorno de carro), com ou sem outros apóstrofos antes; assim o que foi exportado volta igual."
- EX2 (passos do leitor, tabela própria de Windows-1252 para 0x80–0x9F; aspa no meio de campo sem aspas é texto; registro todo vazio não é guardado; a leitura para no registro com valor de número 5.001) e EX4 (`IMPORT_MAX_ROWS`; linha toda vazia não conta em lugar nenhum). `SheetCollector` e `SheetReadProblem` de CX6, inclusive `expands_too_much` (usado pela T4). EX1: a pasta não importa de `src/modules/`.
- Restrição: sem dependência nova (GX1).

**Passos:**
1. [ ] RED `sheet-data.spec.ts`: `it('arquivo vazio → empty; só cabeçalho → no_data; cabeçalho repetido → duplicate_header com o nome')`; `it('5.001 linhas de dados → too_many_rows; linhas em branco em qualquer lugar não contam')`; `it('o registro com valor de número 5.001 lança na hora: nada depois dele é lido')` (espião no `add` do coletor ou contagem de chamadas do `onRecord`); `it('linha em branco no meio não é guardada e não muda a numeração das outras')`; `it('cabeçalho vazio vira Coluna N e células completam a largura')`.
2. [ ] RED `csv-reader.spec.ts`: `it('aceite 19: CSV em Windows-1252 é lido com acentos e aspas tipográficas')` (bytes `Jo\xe3o;Fun\xe7\xe3o` e `\x93x\x94` → `João`, `Função`, `“x”`); `it('UTF-8 com BOM e sem BOM dão o mesmo resultado')`; `it('separador detectado pela linha de cabeçalho: ; ou ,')` (vírgula dentro de aspas não conta); `it('aspas: campo com separador, aspas dobradas e quebra de linha dentro de aspas')` (Review Focus 4); `it('aspa no meio de campo sem aspas é texto')` (`ab"c;d` → `['ab"c', 'd']`; `5" tela` fica igual); `it('aspas sem fechamento: unclosed_quote com a linha')`; `it('apóstrofo de proteção sai na leitura do CSV; texto comum fica igual')` (`'=SOMA(1;2)` → `=SOMA(1;2)`; `''=x` → `'=x`; `'abc` fica); `it('número da linha: cabeçalho é 1; registro com quebra dentro de aspas conta como uma linha')`.
3. [ ] GREEN. `prettier --write` só nos arquivos novos.
4. [ ] Validação: `timeout 600 gate --test src/shared/spreadsheet/sheet-data.spec.ts`; idem `csv-reader.spec.ts`; typecheck; `--changed`.

**Aceite:** spec aceite 19 e a parte de CSV de E2 e do aceite 10 (volta do apóstrofo).

**Risco: alto** (lê arquivo enviado pelo usuário; erro aqui corrompe acentos ou junta colunas).

## Task 4 — Leitor de XLSX (back)

**Arquivos:**
- Criar: `backend/src/shared/spreadsheet/xlsx-reader.ts`, `xlsx-reader.spec.ts`, `zip-size.ts`, `zip-size.spec.ts`.

**Interfaces:**
- Consome: CX6 parte T3 (`SheetCollector`, `SheetReadError`, `XLSX_MAX_UNCOMPRESSED`, problema `expands_too_much`); `exceljs` (`Workbook().xlsx.load`, `worksheet.eachRow({ includeEmpty: false }, …)`; nos testes `Workbook` + `writeBuffer` para montar o arquivo).
- Produz: `readXlsxSheet`, `xlsxCellText`, `zipUncompressedTotal` (CX6).

**Contexto vinculado:**
- Spec E2: "XLSX: primeira aba; cabeçalho na linha 1. Célula com fórmula vale pelo valor calculado; data do Excel vira data civil, sem fuso; número vira texto (telefone e matrícula digitados como número)."
- Lote D, DX19 e spec Comum: "Célula de XLSX é lida como está" (nada de `unguardFormula`).
- EX3 (decisão confirmada pela coordenação, ponto 10, com o acréscimo do revisor): (1) antes de abrir, soma dos tamanhos descompactados lida do diretório central do zip (registro de fim `0x06054b50` nos últimos 65.557 bytes; entradas `0x02014b50`; tamanho descompactado = uint32 LE no deslocamento 24; próxima entrada em 46 + nome (uint16 em 28) + extra (30) + comentário (32)); acima de 60 MB → `expands_too_much`; ilegível ou ZIP64 (`0xFFFFFFFF`) → `unreadable`; (2) `xlsx.load`; se lançar, `repair` injetado, (1) de novo no reparado, nova tentativa; ainda falhando → `unreadable`; (3) primeira aba, só as linhas com valor, cada uma no `SheetCollector` (descarta a toda vazia, para no limite). Regras por tipo de célula em EX3. EX1 (`shared` não importa o normalizer dos contatos: ele chega por parâmetro).

**Passos:**
1. [ ] RED `zip-size.spec.ts`: `it('soma o tamanho descompactado das entradas do diretório central de um xlsx do exceljs')` (confere contra a soma dos tamanhos dos arquivos do zip); `it('buffer que não é zip, cortado ou com ZIP64 → null')`.
2. [ ] RED `xlsx-reader.spec.ts`: `it('lê a primeira aba com o cabeçalho na linha 1')` (segunda aba ignorada); `it('fórmula vale pelo resultado; data vira AAAA-MM-DD sem fuso; número vira texto')` (telefone `92991110001` numérico → `'92991110001'`; data 2026-11-01 → `'2026-11-01'`; `=1+1` com resultado 2 → `'2'`; rich text concatenado); `it('célula de XLSX é lida crua: apóstrofo não sai')`; `it('arquivo ilegível tenta repair e, se ainda falhar, unreadable')`; `it('mais de 5.000 linhas → too_many_rows')`; `it('linhas sem valor no meio e no fim não são lidas nem contadas')`; `it('descompactado acima do teto → expands_too_much sem chamar xlsx.load')` (teto injetado pequeno no teste, ou `XLSX_MAX_UNCOMPRESSED` contra um arquivo com uma célula longa repetida; espião em `xlsx.load`).
3. [ ] GREEN. `prettier --write` só nos arquivos novos.
4. [ ] Validação: `timeout 600 gate --test src/shared/spreadsheet/xlsx-reader.spec.ts`; `timeout 600 gate --test src/shared/spreadsheet/zip-size.spec.ts`; typecheck; `--changed`.

**Aceite:** parte XLSX de E2 e do aceite 10 (reimportar o XLSX exportado).

**Risco: alto** (entrada não confiável; datas e números mal lidos viram dado errado gravado).

## Task 5 — Mapeamento de colunas (back)

**Arquivos:**
- Criar: `backend/src/modules/people-import/mapping.ts`, `mapping.spec.ts`.

**Interfaces:**
- Consome: CX2 (`IMPORT_FIELDS`, `ImportField`, `ColumnMapping`); `PEOPLE_TEMPLATE_COLUMNS`, `PEOPLE_EXPORT_COLUMNS` (Lote D) nos testes.
- Produz: CX6 parte T5.

**Contexto vinculado:**
- Spec E3: "Sugestão automática pelo cabeçalho, sem diferenciar maiúsculas, acentos, espaços e sublinhado, com sinônimos comuns (`celular`, `whatsapp`, `fone` → Telefone; `cargo` → Função; `area`, `departamento` → Setor; `registro`, `id`, `cracha` → Matrícula; `colaborador`, `funcionario` → Nome). Cada campo recebe no máximo uma coluna; coluna sem campo fica como 'Não usar'. Para seguir, precisam estar mapeados Nome e pelo menos um entre Telefone e Matrícula. As colunas `situacao` e `tem_acesso` de um arquivo exportado ficam como 'Não usar'."
- EX32: quem não é ADMIN precisa da coluna Setor. Textos de `mappingProblem` em CX6.

**Passos:**
1. [ ] RED: `it('aceite 13: celular e cargo são reconhecidos, sem diferenciar acento, caixa, espaço e sublinhado')` (`Celular`, ` CARGO `, `Área`, `Crachá`, `Funcionário`); `it('cabeçalhos do modelo mapeiam os onze campos; situacao e tem_acesso ficam Não usar')`; `it('campo recebe só a primeira coluna que casa')`; `it('mappingProblem: Nome e Telefone ou Matrícula; Setor para quem não é ADMIN; coluna fora do arquivo; coluna repetida')`; `it('mappedColumns e unmappedColumns em ordem crescente')`.
2. [ ] GREEN.
3. [ ] Validação: `timeout 600 gate --test src/modules/people-import/mapping.spec.ts`; typecheck; `--changed`.

**Aceite:** spec aceite 13 (parte do back) e E3.

**Risco: médio** (função pura; o mapeamento é conferido pela pessoa na tela).

## Task 6 — Leitura das células da linha (back)

**Arquivos:**
- Criar: `backend/src/modules/people-import/cell-values.ts`, `cell-values.spec.ts`.

**Interfaces:**
- Consome: CX2; `RowCells` (`import-person.ts`, T11a, CX14); `normalizeToE164` (`modules/contacts/phone.util.ts`); `normalizeRegistration` (`modules/users/person-record.ts`); `normalizeJobTitle` (exportado de `users.service.ts` na T14); `phoneView`/`nameView` nos testes para montar o texto mascarado.
- Produz: CX7 parte T6 (`RawFields`, `rowCellsOf`, `fieldsOf`, `isMaskedPhoneText`, `ParsedFields`, `parseFields`).

**Contexto vinculado:**
- Spec E4: "Pessoa existente: célula vazia não altera o campo. Telefone mascarado (`•••• 2008`) conta como vazio. Nome no padrão de telefone mascarado (`•••• 2008`) também conta como vazio. Em pessoa nova, nome no padrão de telefone mascarado deixa a linha Inválida, 'Nome inválido'." "Telefone: mesma validação do cadastro. Inválido: 'Telefone inválido'." "Tamanhos: nome até 120, função até 80, matrícula até 30, detalhe da origem até 120." "Linha com matrícula `EXEMPLO` é sempre ignorada."
- `isMaskedPhoneText` casa exatamente as duas formas da máscara, conferidas pelo revisor (`shared/audit/audit-change.ts:76-80`, `shared/authz/phone-visibility.ts`): `•••• NNNN` (quatro `•`, espaço, os 4 últimos dígitos) e `••••` sozinho. Teste com o texto que `phoneView(…, { full: false })` e `nameView` produzem de verdade, não com literal copiado.
- EX31 (linha em branco = todos os campos mapeados vazios); textos de `ROW_TEXT` (CX3).

**Passos:**
1. [ ] RED: `it('fieldsOf lê só as colunas mapeadas e apara')`; `it('telefone e nome no padrão mascarado contam como vazio')` (Review Focus 1); `it('telefone inválido e tamanhos acima do limite viram motivos')` (Nome 121, Função 81, Matrícula 31); `it('matrícula EXEMPLO marca a linha de exemplo; tudo vazio marca linha em branco')`; `it('matrícula gera a chave em minúsculas')`.
2. [ ] GREEN.
3. [ ] Validação: `timeout 600 gate --test src/modules/people-import/cell-values.spec.ts`; typecheck; `--changed`.

**Aceite:** base dos aceites 10, 12 e 28 (máscara e exemplo).

**Risco: alto** (decide o que conta como vazio; erro aqui grava máscara por cima de nome ou telefone).

## Task 7 — Setor, turno e nível pelo nome (back)

**Arquivos:**
- Criar: `backend/src/modules/people-import/structure-match.ts`, `structure-match.spec.ts`.

**Interfaces:**
- Consome: `ROW_TEXT` (CX3, `row-texts.ts`, T11a, Onda 1; a T7 é da Onda 1b).
- Produz: CX8.

**Contexto vinculado:**
- Spec E4: "Setor, turno e nível: pelo nome (setor também pelo código), sem diferenciar maiúsculas e acentos, só entre os ativos. Não achou: linha inválida, 'Setor 'X' não encontrado' (idem turno e nível). Achou mais de um: inválida, 'Setor 'X' corresponde a mais de um'." "Para o ADMIN, … valor igual ao atual vale mesmo que o setor, turno ou nível esteja inativo. Para quem não é ADMIN … só a regra do setor, turno ou nível inativo igual ao atual continua valendo."
- GX6: "o setor é obrigatório e precisa estar no alcance". EX16: setor fora do alcance e inexistente dão o mesmo texto (`notInReach`).
- Aceite 18: "Setor, turno ou nível que não existe, ou inativo, invalida a linha com o nome no motivo."

**Passos:**
1. [ ] RED: `it('aceite 18: setor, turno e nível inexistentes ou inativos invalidam com o nome no motivo')`; `it('sem diferenciar maiúsculas e acentos; setor também pelo código')`; `it('nome que casa com mais de um ativo dá corresponde a mais de um')`; `it('valor igual ao atual vale mesmo inativo')`; `it('quem não é ADMIN: setor fora do alcance e inexistente dão o mesmo texto')`.
2. [ ] GREEN.
3. [ ] Validação: `timeout 600 gate --test src/modules/people-import/structure-match.spec.ts`; typecheck; `--changed`.

**Aceite:** spec aceite 18 e parte do 27 (setor alheio).

**Risco: crítico (autorização)** — para quem não é ADMIN, decide se um setor fora do alcance pode ser escolhido; erro aqui deixa o gestor mover pessoa para setor de outro.

## Task 8 — Autorização de contato pela planilha (back)

**Arquivos:**
- Criar: `backend/src/modules/people-import/authorization-plan.ts`, `authorization-plan.spec.ts`.

**Interfaces:**
- Consome: CX2; `AuthorizationNow` (`people-import/import-person.ts`, T11a); `AUTHORIZATION_SOURCE_CELL`, `AuthorizationSourceCode` (`shared/spreadsheet/people-columns.ts`); `ContactAuthorizationInput` (`schemas/contracts/contact-authorization.schema.ts`: `{ status: 'NAO_AUTORIZADO' } | { status: 'AUTORIZADO', source, note?, date? }`); `ROW_TEXT`; `CivilDate`.
- Produz: CX7 parte T8.

**Contexto vinculado:**
- Spec E4 (regra do caderno, conselho R1): "`autorizacao_contato` aceita Sim/Não (e `s`, `n`, `x`, `1`, `0`). Sim com origem válida (Termo assinado, Ficha de admissão, Aceite por WhatsApp, Outro) autoriza. 'Outro' exige o detalhe. A data não pode ser futura e aceita `DD/MM/AAAA` e `AAAA-MM-DD`. Data vazia: hoje, quando a autorização é nova ou a origem muda; em pessoa já autorizada com a mesma origem, a data vazia mantém a que está. Sim sem origem válida: a linha continua válida, mas a autorização não é aplicada, com o aviso 'Autorização ignorada: falta a origem.' Pessoa nova fica 'Não autorizado'. 'Cadastro anterior' não é origem aceita para autorizar. Linha com Sim e 'Cadastro anterior' igual ao que a pessoa já tem não muda nada e não mostra aviso. 'Hoje', para a data de autorização vazia, é o dia da gravação. Não em pessoa já autorizada: ignorado, com o aviso 'A planilha não retira autorização; faça na ficha da pessoa.' Quando o ator não pode alterá-la, as colunas de autorização daquela linha são ignoradas com o aviso 'Você não pode alterar a autorização desta pessoa.'"
- Anti-objetivo: "Uma célula 'sim' na coluna de autorização virar autorização sem origem informada."
- Tabela de regras de CX7; EX18 (Outro sem detalhe → aviso). GX4 (hoje).

**Passos:**
1. [ ] RED: `it('aceite 15: Sim sem origem não autoriza e avisa; Sim com origem autoriza com origem e data')`; `it('Sim aceita s, x e 1; Não aceita n e 0; outro valor invalida')`; `it('data vazia: ausente quando nova ou muda a origem; mantém a atual com a mesma origem')`; `it('data futura e formato inválido invalidam; DD/MM/AAAA e AAAA-MM-DD valem')`; `it('Cadastro anterior não autoriza; igual ao atual não muda nada nem avisa')`; `it('Não em pessoa autorizada é ignorado com aviso')`; `it('Outro sem detalhe é ignorado com aviso')`; `it('ator que não pode alterar a autorização: colunas ignoradas com aviso')`; `it('pessoa nova sem autorização ganha o aviso de mensagens')`; `it('authorizationSatisfied: mesma origem e detalhe com data ausente é satisfeita')`.
   Se o `describe` passar de 50 linhas, dividir em dois `describe` irmãos (leitura das células; plano).
2. [ ] GREEN.
3. [ ] Validação: `timeout 600 gate --test src/modules/people-import/authorization-plan.spec.ts`; typecheck; `--changed`.

**Aceite:** spec aceite 15 e a parte de autorização dos aceites 10 e 28.

**Risco: crítico (autorização)** (revisão 1) — decide se uma célula da planilha vira autorização de contato registrada (consentimento; anti-objetivo da spec: "sim" sem origem) e respeita quem pode alterá-la (`canEdit`, aviso `cannotEditAuthorization`); erro aqui autoriza mensagem sem origem ou deixa quem não pode mexer na autorização de outra pessoa. Revisor `opus`.

## Task 9 — Diff, patch e versão da pessoa (back)

**Arquivos:**
- Criar: `backend/src/modules/people-import/person-diff.ts`, `person-diff.spec.ts`.

**Interfaces:**
- Consome: T11a (`ImportPerson`, `AuthorizationNow`, `ImportPatch`, `DiffField`, `FieldDiff`, de `import-person.ts`, CX14), T6 (`ParsedFields` só nos testes), T7 (`StructureCatalog`, `structureName`), T8 (`authorizationSatisfied`); `brazilianPhoneVariants` (`contacts/phone.util.ts`); `normalizeJobTitle` (T14); `AUTHORIZATION_SOURCE_CELL`, `formatDateCell` (Lote D); `node:crypto` (`createHash`).
- Produz: CX9 (`ResolvedRow`, `diffPerson`, `patchSatisfied`, `personFingerprint`, `authorizationLabel`, `samePhone`).

**Contexto vinculado:**
- Spec E4: "Pessoa existente: célula vazia não altera o campo. A planilha não apaga valores. Linha em que nada muda fica como 'Sem alteração'." "compara-se cada célula, depois da mesma normalização do cadastro, com o valor atual".
- Spec E5: "em 'Atualizar' — o que muda, campo a campo (antes → depois)".
- Spec E6: "se os valores atuais já são os da linha, registrar como 'Sem alteração'" → `patchSatisfied`. EX12 (`personFingerprint`), EX33 (comparações).
- GX8: o diff guarda nome e telefone crus; quem mascara é a leitura (T17).

**Passos:**
1. [ ] RED: `it('célula vazia não altera; nome e telefone nulos não entram no patch')`; `it('diff mostra antes e depois por campo, com nomes de setor, turno e nível e a autorização por extenso')`; `it('telefone na outra grafia do nono dígito não é mudança')`; `it('matrícula com outra caixa não é mudança')`; `it('patchSatisfied é verdadeiro depois de aplicar o patch e falso antes')`; `it('personFingerprint muda quando um campo importado muda e não depende do id')`.
2. [ ] GREEN.
3. [ ] Validação: `timeout 600 gate --test src/modules/people-import/person-diff.spec.ts`; typecheck; `--changed`.

**Aceite:** base dos aceites 10, 14, 16 e 20.

**Risco: alto** (decide o que é gravado e o que é "Sem alteração").

## Task 10 — Classificação da linha e duplicadas (back)

**Arquivos:**
- Criar: `backend/src/modules/people-import/classify-row.ts`, `duplicates.ts`, `classify-row.spec.ts`, `classify-row.reach.spec.ts`, `duplicates.spec.ts`, `classify-row.fixtures.ts` (fábricas de pessoa, catálogo e lookup, só para os specs deste módulo; **ator nenhum**: o ator dos testes é `toImportActor(actorWith(...))`, com `actorWith`/`permissionsWith` de `shared/authz/actor.test-fixtures.ts` e `toImportActor` da T11b — revisão 1, M9).

**Interfaces:**
- Consome: T11a (`RowKeys`, `CreatePlan`, `RowPlan`, `RowPreview`, `RowVerdict`, `ImportPerson`, `ImportPatch`, `FieldDiff`, de `import-person.ts`, CX14; `ROW_TEXT`; `RowClass`), T6 (`ParsedFields`), T7 (`matchStructure`, `StructureCatalog`), T8 (`planAuthorization`, `AuthorizationCells`; a linha fica inválida pelos `errors` do plano, nunca por `cells.errors` direto — ruling T8 R1), T9 (`diffPerson`, `personFingerprint`, `samePhone`, `ResolvedRow`), T11b (`ImportActor`, `toImportActor`), `actorWith`/`permissionsWith` (`shared/authz/actor.test-fixtures.ts`, só testes), `canEditContactAuthorization` (`shared/authz/person-actions.policy.ts`, com `actor.policy`), `canonicalBrPhoneForm`, `brazilianPhoneVariants`, `CivilDate`.
- Produz: CX10 (`PeopleLookup`, `duplicateOf`, `identify`, `classifyRow`).

**Contexto vinculado:**
- Spec E4, Identificação: "1. Com matrícula: procura a pessoa por matrícula (sem diferenciar maiúsculas). 2. Se não achou por matrícula, ou a linha não tem matrícula: procura pelo telefone (as duas grafias do nono dígito). 3. Não achou: pessoa nova. 4. Linha sem matrícula e sem telefone válido: Inválida." "Conflito: a matrícula é de uma pessoa e o telefone é de outra; ou a pessoa achada pelo telefone já tem outra matrícula. A linha não entra." "Duplicada: a mesma matrícula (sem diferenciar maiúsculas), ou o mesmo telefone (pelas duas grafias do nono dígito; telefone mascarado não conta), aparece em mais de uma linha. A primeira ocorrência segue com a classificação que tiver, mesmo inválida; as seguintes ficam como duplicadas." "Pessoa inativa: a planilha não a altera. A linha fica 'Sem alteração' ou Inválida, 'Pessoa inativa; reative na ficha'." "Ordem das checagens: para o ADMIN, 'Sem alteração' é decidido primeiro …; para quem não é ADMIN, as travas de alcance, de login e de telefone vêm antes de 'Sem alteração' (senão a resposta diria se um palpite sobre pessoa fora do alcance está certo)."
- Spec E5, avisos: "pessoa nova sem autorização mostra 'Esta pessoa não receberá mensagens até ter a autorização registrada.'; troca de setor de pessoa com login mostra 'Esta pessoa terá de entrar de novo no sistema.'"
- GX6 (travas de quem não é ADMIN, texto completo), GX7 (motivo nunca revela outra pessoa), EX31 (duplicadas). Spec E4: "ADMIN pode atualizar pessoa com login (nome, telefone, função, vínculo), como na tela de Usuários. Perfil e acesso nunca mudam pela planilha."
- EX15 (ordem): (1) branco/exemplo → Ignorada; (2) Duplicada; (3) sem matrícula nem telefone válido → `noKey`; (4) erros próprios das células → Inválida com todos; (5) identificar por matrícula; se não achou, pelo telefone só para o ADMIN e quem tem `telefone.ver_completo`; quem não tem a chave → sem consulta (`lookup.byPhone` nunca lido); (6) não ADMIN e pessoa fora do alcance ou com login → `cannotEditPerson` e para; (7) o conflito por telefone só é avaliado para ADMIN ou quem tem a chave: matrícula acha A e telefone acha B ≠ A → `phoneTaken`; achada só pelo telefone com outra matrícula gravada e linha com matrícula → `phoneTaken`; achada só pelo telefone **sem** matrícula gravada e linha com matrícula → a matrícula entra no patch; sem a chave, nunca Conflito por telefone; (8) existente: estrutura, setor obrigatório (não ADMIN), telefone por EX17.1/EX17.2, autorização, diff; sem diferença → Sem alteração; inativa com diferença → `inactivePerson`; senão Atualizar; (9) nova: `invalidName` / `newNeedsName` / `newNeedsPhone`; setor obrigatório; estrutura; ADMIN ou quem tem `telefone.ver_completo` e o telefone já é de alguém → Conflito; quem não tem a chave → sem consulta, Criar.
- EX16 (revisão 1, M1): para quem não é ADMIN, linha **sem erro próprio nas células** cuja pessoa achada está fora do alcance ou tem login → sempre `{ classification: 'INVALID', reasons: ['Você não pode alterar esta pessoa.'], warnings: [], preview: null, plan: null, personId: null }`, com as demais células iguais às da pessoa ou diferentes. Linha com erro próprio responde no passo 4, antes de identificar.
- EX17.1 (revisão 1, I1; mesma regra da tela do setor, `sector-people-write.service.ts:222-229`): sem `telefone.ver_completo`, não identifica pelo telefone; pessoa achada pela matrícula **com telefone gravado**: célula de telefone não vazia e não mascarada sai do patch e da comparação de "Sem alteração" (`diffPerson` com `phoneE164: null`), sempre com o aviso "Você não pode alterar o telefone desta pessoa.", seja igual à gravada, diferente ou de outra pessoa; o passo 7 não procura o dono do telefone. Célula mascarada = vazia, sem aviso.
- EX17.2 (Conselho S, S2-a com I1): sem a chave, pessoa achada pela matrícula **sem** telefone gravado: a célula de telefone válida e não mascarada entra no patch, sem conferir se está livre; a prévia mostra "Atualizar" com o número do arquivo. Pessoa nova: telefone aceito, sem conferir. Telefone já gravado nunca é comparado (EX17.1).
- EX17.3 (Conselho S, S1-b ajustada): sem a chave, "na prévia, nenhum telefone do arquivo é comparado com o cadastro: a prévia não diz se um número já existe, a linha sai como Criar ou Atualizar" (o aviso do topo é da T17/T26); "com a chave, e para o ADMIN, a prévia continua mostrando o Conflito, sem dizer de quem".
- Textos (CX3): `noKey` 'Sem matrícula nem telefone para identificar'; `phoneTaken` 'O telefone já pertence a outra pessoa cadastrada'; `cannotEditPerson` 'Você não pode alterar esta pessoa.'; `cannotEditPhone` 'Você não pode alterar o telefone desta pessoa.'; `notFound('Setor', x)` "Setor 'x' não encontrado"; `notInReach(x)` "Setor 'x' não encontrado entre os setores que você gerencia"; `sectorRequired` 'Informe o setor'; `inactivePerson` 'Pessoa inativa; reative na ficha'; `mustLoginAgain` 'Esta pessoa terá de entrar de novo no sistema.'; `newWithoutAuthorization` 'Esta pessoa não receberá mensagens até ter a autorização registrada.'.

**Passos:**
1. [ ] RED `duplicates.spec.ts`: `it('mesma matrícula sem caixa ou mesmo telefone nas duas grafias; mascarado não conta; a primeira segue')`; `it('linhas Ignoradas não entram nas duplicadas')`.
2. [ ] RED `classify-row.spec.ts` (ADMIN, `toImportActor(actorWith({ role: 'ADMIN' }))` ou a forma que `actorWith` aceitar): `it('aceite 17: matrícula de uma pessoa e telefone de outra dá Conflito sem revelar quem')` (`reasons` exatamente `[phoneTaken]`, `preview` nulo, `personId` nulo); `it('telefone de pessoa com outra matrícula dá Conflito')`; `it('pessoa achada pelo telefone e sem matrícula recebe a da planilha')` (patch com `registration`, Atualizar, sem Conflito); `it('aceite 18: setor inexistente deixa a linha Inválida com o nome')` (`reasons` com "Setor 'Galpão 9' não encontrado"); `it('sem matrícula nem telefone válido: Inválida')`; `it('pessoa nova exige nome e telefone; nome mascarado é Nome inválido')`; `it('ADMIN: Sem alteração vale para pessoa inativa e setor inativo iguais aos atuais')`; `it('pessoa inativa com mudança: Inválida, reative na ficha')`; `it('troca de setor de pessoa com login avisa que terá de entrar de novo')`; `it('linha de exemplo e linha em branco ficam Ignoradas')`; `it('Atualizar traz plan com personId, fingerprint e patch, e preview com o diff')`.
3. [ ] RED `classify-row.reach.spec.ts` (quem não é ADMIN, `toImportActor(actorWith(...))` com `managedSectorIds` e as chaves do caso): `it('aceite 27: quem não é ADMIN recebe a mesma resposta para pessoa fora do alcance, com palpite certo ou errado')` (só células **sem erro próprio**: pessoa de outro setor com as células iguais às dela; com células diferentes e válidas; pessoa com login no alcance → três `RowVerdict` iguais, `toStrictEqual`); `it('linha com erro próprio responde pelo erro, antes da trava de alcance')`; `it('aceite 24: sem telefone.ver_completo, célula de telefone igual, diferente e de outra pessoa dão a mesma classificação e o mesmo aviso')` (pessoa achada pela matrícula, com telefone gravado; três linhas iguais salvo o telefone — igual ao gravado, número livre, número de outra pessoa do lookup → mesma `classification`, `warnings` `[cannotEditPhone]`, nenhum `phone` no patch nem no diff; o lookup falso registra que o telefone não foi consultado); `it('sem telefone.ver_completo: telefone mascarado conta como vazio, sem aviso')`; `it('quem não é ADMIN: setor obrigatório e no alcance')`; `it('travas vêm antes de Sem alteração')`.
4. [ ] RED **Conselho S** (tabela "Testes do Conselho S e da retomada", assertivas lá), em `describe` irmãos de `classify-row.reach.spec.ts` (`describe('Conselho S: telefone sem a chave')`), salvo S1-3 do ADMIN, que vai em `classify-row.spec.ts`: S1-1 `it.each([...])('S1-1: sem telefone.ver_completo, pessoa nova com número já cadastrado (%s) dá o mesmo resultado que com número livre')` (dono sem login no alcance, com login, fora do alcance, outra grafia do 9º dígito; `toStrictEqual` com o lookup sem o dono); S1-3 `it('S1-3: com telefone.ver_completo e para o ADMIN, Conflito de telefone traz só o texto fixo')` (ADMIN e gestor com a chave; `reasons` `[phoneTaken]`, `JSON.stringify` sem nome, setor nem matrícula do dono); S1-4 `it('S1-4: aceite 17 sem telefone.ver_completo (matrícula de A, telefone de B) nunca dá Conflito')`; S2-1 `it('S2-1: sem telefone.ver_completo, pessoa achada pela matrícula e sem telefone: Atualizar com o telefone no plano e na prévia')`; S2-2 `it('S2-2: pessoa com telefone: célula igual e célula diferente dão o mesmo resultado')`; S2-6 `it('S2-6: pessoa com login ou fora do alcance: resposta da EX16 com qualquer telefone')`.
5. [ ] GREEN. Funções pequenas (identificar, travas, telefone, existente, nova) para ficar em complexidade ≤ 10.
6. [ ] Validação: `timeout 600 gate --test` em cada um dos três specs; typecheck; `--changed`.

**Aceite:** spec aceites 17, 18 (na linha), 24 (prévia), 27 e a parte de classificação de 11, 12, 16.

**Risco: crítico (autorização)** — decide, para quem não é ADMIN, o que é alterável e o que a prévia revela de pessoas fora do alcance e de telefones já cadastrados (Conselho S).

## Task 11a — Contrato, erros e textos das linhas (back)

**Arquivos:**
- Criar: `backend/src/schemas/contracts/people-import.schema.ts`, `people-import.schema.spec.ts`; `backend/src/modules/people-import/people-import.errors.ts`, `people-import.errors.spec.ts`, `row-texts.ts`, `import-person.ts` (só tipos, CX14: todos os tipos de linha que mais de uma onda usa).

**Interfaces:**
- Consome: `spreadsheetFormatSchema` (`schemas/contracts/people-export.schema.ts`); `DomainError` (molde de `people-export/people-export.errors.ts`); `ContactAuthorizationInput` (`schemas/contracts/contact-authorization.schema.ts`); `AuthorizationSourceCode` (`shared/spreadsheet/people-columns.ts`, Lote D); `CivilDate` (`staff-schedule/civil-date.ts`); `Prisma.TransactionClient` (`@prisma/client`). Nada de task deste lote.
- Produz: CX2, a tabela de erros e `ROW_TEXT` de CX3 (sem `fromSheetReadError`, que é da T16), e CX14 (`import-person.ts`: `RowCells`, `AuthorizationNow`, `ImportPerson`, `ImportPatch`, `DiffField`, `FieldDiff`, `RowKeys`, `CreatePlan`, `RowPlan`, `RowPreview`, `RowVerdict`, `RowOutcome`, `ImportEnding`, `ImportResultCounts`, `TrailWriter`), copiado de CX14 sem mudar nome nem forma (revisão 1, I3).

**Contexto vinculado:**
- Spec E2: "Acima disso, 422 com 'A planilha tem linhas demais. Envie até 5.000 por vez.'" "Cabeçalho repetido, arquivo vazio ou sem linha de dados: 422 com texto próprio."
- Spec E4: textos de conflito, travas e autorização (copiados em `ROW_TEXT`, CX3). EX4 (5 MB), EX7 (corpo da confirmação), EX25 (403/404/409), EX26.
- Conselho S (EX17.3): `ImportProgress.phoneTaken`, `BatchSummary.phoneCheckDeferred` (fora de `BatchListItem`) e `ImportResultCounts.phoneTaken` (subconjunto de `failed`) já estão em CX2 e CX14; nenhum texto novo em `ROW_TEXT` (`phoneTaken` já existe; o aviso da prévia é texto da tela).
- GX16: textos exatamente os de CX3.

**Passos:**
1. [ ] RED `people-import.schema.spec.ts`: `it('mappingBodySchema exige as onze chaves e recusa a mesma coluna em dois campos e índice negativo')`; `it('confirmBodySchema exige os dois marcadores e limita excludedRows a 5.000')`; `it('rowsQuerySchema aceita página e classificação; página padrão 1')`.
2. [ ] RED `people-import.errors.spec.ts`: `it('cada erro tem code, status e o texto da tabela')` (uma tabela de casos; `alreadyConfirmed()` = `people_import.already_confirmed` / 409); `it('ROW_TEXT: textos exatamente os de CX3')` (tabela de casos com as funções `duplicateOf`, `tooLong`, `notFound`, `ambiguous`, `notInReach`).
3. [ ] GREEN (`import-person.ts` só com `export type`; o typecheck é o teste dele).
4. [ ] Validação: `timeout 600 gate --test` nos dois specs; typecheck; `--changed`.

**Aceite:** base de E2, E3 e E7 (contrato e textos de erro) e os tipos que as ondas seguintes consomem.

**Risco: alto** (contrato público das rotas, validação dos corpos e tipos que todas as ondas usam). **Revisor `opus`** (decisão da coordenação, revisão 1).

## Task 11b — Trilha do lote e ator da importação (back)

**Arquivos:**
- Criar: `backend/src/modules/people-import/import-trail.ts`, `import-trail.spec.ts`, `import-actor.ts`, `import-actor.spec.ts`.

**Interfaces:**
- Consome: `AuditChange`, `FieldChange` (`shared/audit/audit-change.ts`; molde `people-export/export-trail.ts`); `findTeamActor` (`team-whatsapp/team-actor.query.ts`), `TeamActor`; `hasPermission`, `permissionDenied` (`shared/authz/permissions.ts`, com `'pessoas.importar'` da T1, Onda 1); `PermissionActor` (`shared/authz/person-actions.policy.ts`); `importNoManagedSector` (T11a, Onda 1); `ImportEnding`, `ImportResultCounts` (`import-person.ts`, T11a, CX14); `actorWith`/`permissionsWith` (`shared/authz/actor.test-fixtures.ts`). A T11b é da Onda 1b: tudo isso já está no working tree.
- Produz: `import-trail.ts` de CX3 e CX4.

**Contexto vinculado:**
- Spec, Comum, Trilha: "Os registros de Planilhas são gravados pelo caminho que propaga erro e recebe o autor explícito (`recordChange`, dentro de transação). O que precisa aparecer na tela vai nos campos de antes/depois (`changes`, com 'antes' vazio), porque a tela da Trilha não mostra `metadata`. A categoria é passada explicitamente em cada registro."
- Spec E7: "Trilha: `people_import.confirmed` e `people_import.completed`, categoria Planilhas, com o arquivo e as contagens." Spec E6: "O encerramento grava `people_import.completed` com as contagens, e o autor do registro é quem encerrou." Spec E6: "Motivo gravado em cada criação e alteração: 'Importação de planilha: <arquivo>', cortado em 200 caracteres."
- GX6 (travas: `pessoas.editar`, alcance), GX9 (visibilidade), EX13 (motivo do automático), EX22, EX32.

**Passos:**
1. [ ] RED `import-trail.spec.ts`: `it('importConfirmedChange: Planilhas, entidade Spreadsheet, id do lote, sem dado pessoal')`; `it('importCompletedChange: contagens na ordem, com phoneTaken depois de failed; writing só quando > 0; motivo só no automático')`; `it('importReason corta em 200 caracteres')`.
2. [ ] RED `import-actor.spec.ts`: `it('toImportActor: ADMIN sem alcance e com todas as chaves; gestor com setores e chaves')`; `it('assertCanWrite: sem pessoas.editar 403 com o texto da chave; sem setor 403')`; `it('canSeeBatch: ADMIN vê todos; os demais só os seus')`; `it('loadImportActor recusa ator ausente, inativo ou sem acesso')`.
3. [ ] GREEN.
4. [ ] Validação: `timeout 600 gate --test` nos dois specs; typecheck; `--changed`.

**Aceite:** base dos aceites 23 e 24 (registro; quem vê e quem grava).

**Risco: crítico (autorização)** — `assertCanWrite` e `canSeeBatch` decidem quem grava pessoas e quem vê o lote alheio.

## Task 12 — Repositório de leitura e da prévia (back)

**Arquivos:**
- Criar: `backend/src/modules/people-import/people-import.repository.ts`, `people-import.repository.integration.spec.ts`.

**Interfaces:**
- Consome: T2 (models); CX2; `ImportPerson`, `AuthorizationNow`, `RowCells`, `RowVerdict`, `RowPreview`, `ImportResultCounts` (`people-import/import-person.ts`, T11a, CX14); `StructureCatalog`, `StructureOption` (T7, Onda 1b). `RowRecord.verdict` (`RowVerdict | null`) é gravado como JSON nas colunas `classification`, `reasons`, `warnings`, `preview`, `plan`, `personId`, sem interpretar `plan` nem `preview`.
- Produz: `PeopleImportRepository` de CX11 (lado de leitura e prévia).

**Contexto vinculado:**
- EX6 (prévia guardada e paginada, 50 por página, remapear só em PREVIEW, `deleteMany` + `createMany` em blocos de 1.000 numa transação); EX14 (prévias com mais de 7 dias apagadas); EX23 (linhas do relatório); GX9 (lista: ADMIN todos; demais os seus).
- `findPeopleByKeys`: `user.findMany` por `registrationKey in`, por `phoneE164 in` (todas as grafias) e, quando vier, por `id in` (`ids`: o `personId` da linha de criação, EX17.4 a), em blocos de 1.000; lista vazia não entra no `OR` (sem a chave, `phones` vem `[]`, EX17.3); campos de `ImportPerson` (`contactAuthorization`, `authorizationSource`, `authorizationNote`, `authorizationDate` → `authorization`, com `fromDbDate` na data).
- `loadCatalog`: `sector` (`id`, `name`, `code`, `isActive`), `shift` e `staffLevel` (`id`, `name`, `isActive`; `code` nulo). Conferido pelo revisor: `Shift.name` e `StaffLevel.name` são `@unique` e têm `isActive`; `Sector.name` e `Sector.code` são únicos e não nulos.
- GX12, GX13.

**Passos:**
1. [ ] RED `people-import.repository.integration.spec.ts` (dois `describe` irmãos: lote e linhas; pessoas e catálogo): `it('createBatch grava lote e linhas; pageRows pagina 50 por vez em ordem de linha e filtra por classificação')`; `it('replaceRows só em prévia; troca classificação e contagens')`; `it('findPeopleByKeys acha por matrícula e por qualquer grafia do telefone')`; `it('findPeopleByKeys acha pelo id; phones vazio não consulta telefone')`; `it('loadCatalog traz setores, turnos e níveis, ativos e inativos, com o código do setor')`; `it('listBatches: ADMIN todos, demais os seus, mais recentes primeiro')`; `it('deleteStalePreviews apaga só prévias com mais de 7 dias, com as linhas')`; `it('reportRows traz inválidas, duplicadas, conflitos, falhas e não gravadas em ordem de linha')`.
2. [ ] GREEN.
3. [ ] Validação: `TESTCONTAINERS_ENABLED=1 timeout 600 gate --test src/modules/people-import/people-import.repository.integration.spec.ts`; typecheck; `--changed`.

**Aceite:** base dos aceites 11, 13, 23 e 24 (dados do lote, lista por dono).

**Risco: alto** (consultas do lote e de pessoas; a visibilidade é decidida no serviço).

## Task 13a — Repositório da gravação: confirmação e reserva (back)

**Arquivos:**
- Criar: `backend/src/modules/people-import/people-import-write.repository.ts`, `people-import-write.repository.integration.spec.ts` (confirmação), `people-import-reserve.integration.spec.ts` (reserva e `finalizeRow`).

**Interfaces:**
- Consome: T2 (models); `RowPlan`, `RowOutcome`, `TrailWriter` (`import-person.ts`, T11a, CX14); `Prisma.TransactionClient`; `PrismaService`.
- Produz: `PeopleImportWriteRepository`, `ReservedRow` (com `personId`) e `newPersonId` de CX11 (T13a): `confirm`, `touchBlock`, `reserveNextRow`, `finalizeRow`. Contrato novo com T20a/T20b e o módulo de usuários (EX17.4 a): o `personId` da linha de criação é o `id` com que a T20a cria a pessoa (`createPersonWithoutAccess(..., { reason, personId })`, T14) e o que ela procura antes de criar.

**Contexto vinculado:**
- Spec E6: "Reserva da linha: só um pedido passa a linha de pendente para reservada (operação atômica), e cada pedido reserva uma linha por vez. O resultado só é gravado por quem detém a reserva. A reserva vence em 5 minutos; linha com reserva vencida volta a ficar pendente." "Um lote só pode ser confirmado uma vez. Dois cliques, ou duas abas, não gravam duas vezes."
- Spec E2, prazo: "O conteúdo de cada linha confirmada é apagado quando ela é gravada (fica só o número da linha, o resultado e a pessoa). Das linhas que não entraram por erro ficam as colunas mapeadas e o motivo."
- EX7 (seleção: `PENDING` nas linhas `CREATE` se `createNew` e `UPDATE` se `updateExisting`, fora de `excludedRows`; nenhuma → `nothing_selected`); EX8 (numa transação, `updateMany({ where: { id, status: 'PREVIEW', createdById: actorId }, data: { status: 'WRITING', confirmedById, confirmedAt, lastBlockAt } })`; contagem 0 → `'not_preview'`; depois seleção, limpeza e `trail`); EX9 (SQL da reserva, verbatim, com o `CASE` de `"personId"`: linha de criação recebe `COALESCE("personId", $personId)`, `$personId = newPersonId()` = `'c' + randomUUID()` sem hífens, e o mantém nas reservas seguintes; atualização fica com o da prévia; `RETURNING` inclui `personId`; `$now`/`$until` do relógio da API; resultado só com `updateMany({ where: { id, reservationToken: token, writeState: 'RESERVED' } })`, contagem 0 → `false`, sem erro).
- EX14, momentos desta task: **ao confirmar** — `cells - $unmapped::text[]` em todas as linhas; `preview` nulo em **todas** (revisão 1, M11); desmarcadas, Sem alteração e Ignoradas → também `cells` e `plan` nulos; linhas de erro → `plan` nulo; `PENDING` guardam colunas mapeadas e `plan`. **Ao gravar** (`finalizeRow`) — `CREATED`/`UPDATED`/`UNCHANGED` → `cells` e `plan` nulos, `outcome`, `personId`, `writtenAt`, `writeState = 'DONE'`; `FAILED` → `plan` nulo, `outcomeReason` (até 200).
- A trilha entra por `TrailWriter` (callback na mesma transação, padrão de `UsersRepository.createWithAudit`).

**Passos:**
1. [ ] RED `people-import-write.repository.integration.spec.ts` (Postgres real; lote e linhas semeados pelo `prisma` do container): `it('confirm: marca PENDING só nas linhas escolhidas e devolve as contagens')`; `it('confirm: duas confirmações simultâneas, só uma muda o lote e grava a trilha')` (`Promise.all`; um resultado e um `'not_preview'`; trilha chamada uma vez); `it('confirm de quem não enviou ou de lote fora de PREVIEW devolve not_preview e não muda nada')`; `it('confirm sem nada escolhido devolve nothing_selected e não muda o lote')` (a transação desfaz o `WRITING`); `it('aceite 26: confirmar apaga as colunas não mapeadas e o conteúdo das linhas fora da gravação')`; `it('confirmar anula o preview de todas as linhas, inclusive as que vão ser gravadas')`.
2. [ ] RED `people-import-reserve.integration.spec.ts`: `it('reserveNextRow: dois pedidos simultâneos nunca pegam a mesma linha')` (10 linhas pendentes, dois laços em `Promise.all` até `null`; união = 10 ids distintos); `it('reserva vencida volta a ser reservável; finalizeRow com token antigo não grava')`; R1 `it('reserveNextRow dá personId à linha de criação e mantém o mesmo depois que a reserva vence')` (criação: `personId` casa `/^c[0-9a-f]{32}$/`; segunda reserva da mesma linha, relógio + 5 min + 1 s → mesmo `personId`; atualização devolve o `personId` da prévia); `it('finalizeRow: linha gravada perde cells e plan; falha guarda as colunas mapeadas')`; `it('reserveNextRow não reserva em lote fora de WRITING')`; `it('touchBlock grava lastBlockAt')`.
3. [ ] GREEN (`$queryRaw` só na reserva e na limpeza `cells - $unmapped::text[]`; o resto por `updateMany`).
4. [ ] Validação: `TESTCONTAINERS_ENABLED=1 timeout 600 gate --test` em cada um dos dois specs; typecheck; `--changed`.

**Aceite:** spec aceites 21 (repositório), 25 (reserva) e 26 (limpeza na confirmação e na gravação).

**Risco: crítico (produção)** (revisão 1) — decide se uma linha de pessoa é gravada uma vez só em produção (confirmação única, reserva atômica, resultado só do dono da reserva) e o que do arquivo enviado (dado pessoal de colunas não mapeadas) fica no banco. Revisor `opus`.

## Task 13b — Repositório da gravação: conclusão, encerramento e contagens (back)

**Arquivos:**
- Criar: `backend/src/modules/people-import/people-import-close.repository.ts`, `people-import-close.repository.integration.spec.ts`.

**Interfaces:**
- Consome: T2 (models, inclusive `User` para conferir `personId`); `ImportResultCounts`, `TrailWriter` (`import-person.ts`, T11a, CX14); `ROW_TEXT.notWrittenClosed` e `ROW_TEXT.phoneTaken` (T11a; o segundo em `resultCounts`); `Prisma.TransactionClient`; `PrismaService`. Nada da T13a (mesma onda): os testes semeiam lotes `WRITING` e linhas `PENDING`/`RESERVED`/`DONE` direto pelo `prisma` do container.
- Produz: `PeopleImportCloseRepository` de CX11 (T13b): `completeIfDone`, `close`, `settleExpired`, `staleWriting`, `resultCounts`.

**Contexto vinculado:**
- Spec E6: "O ADMIN pode 'Encerrar gravação' de qualquer lote: as linhas pendentes viram 'Não gravada: gravação encerrada'. Em lote encerrado, linha com reserva vencida também vira 'Não gravada: gravação encerrada'." "O encerramento grava `people_import.completed` com as contagens, e o autor do registro é quem encerrou."
- Spec E2: "Linhas não gravadas por encerramento guardam as colunas mapeadas."
- m8 (re-revisão 2; EX13, exceção): em `close` e `settleExpired`, linha de **criação** (`classification = 'CREATE'`) pendente ou com reserva vencida, com `personId` não nulo cuja pessoa já existe (`User.id = personId`; a pessoa foi criada pela própria linha, EX17.4 a, e a reserva venceu antes de `finalizeRow`) → `DONE`, `outcome = 'CREATED'` (o mesmo da gravação normal), `personId` mantido, `cells` e `plan` nulos, sem `outcomeReason`; não conta como `NOT_WRITTEN`. Linha de criação sem `personId` (nunca reservada) ou cuja pessoa não existe → `NOT_WRITTEN` como antes. Linha de atualização: `personId` é a pessoa existente da prévia, nunca prova de gravação → sempre `NOT_WRITTEN`. Implementação sem `$queryRaw`: ler os `personId` das candidatas (criação, `personId` não nulo), `user.findMany({ where: { id: { in } }, select: { id } })` e dois `updateMany` (os com pessoa → `CREATED`; o resto → `NOT_WRITTEN`), na mesma transação. O retorno de `close`/`settleExpired` e as contagens refletem a divisão.
- EX13: `completeIfDone` numa transação: sem linha `PENDING` nem `RESERVED` → `updateMany({ where: { id, status: 'WRITING' }, data: { status: 'COMPLETED', finishedAt, result } })`; contagem 1 → `trail` e `true`. `close` numa transação: `WRITING → CLOSED` condicional com `closedById` e `finishedAt`; linhas `PENDING` e `RESERVED` vencidas → `DONE`, `outcome = 'NOT_WRITTEN'`, `outcomeReason` "Não gravada: gravação encerrada", `plan` nulo (EX14: ficam as colunas mapeadas); reserva **viva** fica com o dono; `result` com `writing` = reservas vivas; `trail`; devolve as contagens (ou `null` se o lote não estava em `WRITING`). `settleExpired`: lote `CLOSED`, reservas vencidas → `NOT_WRITTEN` do mesmo jeito. `staleWriting(cutoff)`: lotes `WRITING` com `(lastBlockAt ?? confirmedAt) < cutoff`. `resultCounts`: `groupBy` de classificação, `writeState` e `outcome` → `ImportResultCounts`; `phoneTaken` = `count` de `outcome = 'FAILED'` com `outcomeReason = ROW_TEXT.phoneTaken` ("O telefone já pertence a outra pessoa cadastrada"), contado pelas linhas, sem coluna nova (Conselho S: "contagem de falhas por telefone já cadastrado, só o número, no registro do lote e em `people_import.completed`"; `close` e `completeIfDone` já gravam o `result` a partir daqui).

**Passos:**
1. [ ] RED `people-import-close.repository.integration.spec.ts` (dois `describe` irmãos: fim do lote; contagens): `it('completeIfDone grava a trilha uma vez mesmo com dois blocos terminando juntos')` (`Promise.all`); `it('completeIfDone não conclui com linha pendente ou reservada')`; `it('close: pendentes e reservas vencidas viram Não gravada só com as colunas mapeadas; reserva viva fica')`; `it('close e completeIfDone ao mesmo tempo: só um encerra o lote e só uma trilha')`; `it('close de lote fora de WRITING devolve null')`; `it('settleExpired converte a reserva vencida de lote encerrado')`; `it('close e settleExpired: linha de criação com personId de pessoa já existente vira CREATED, não NOT_WRITTEN')` (m8; semear `User` com o `id` do `personId`; dois casos de criação — `PENDING`/reserva vencida — com pessoa e um sem pessoa → `NOT_WRITTEN`; uma linha de **atualização** com `personId` de pessoa existente continua `NOT_WRITTEN`; a pessoa-linha sai com `cells` e `plan` nulos e sem `outcomeReason`; `resultCounts` e o `result` do lote refletem `created` e `notWritten`); `it('staleWriting acha lotes parados há mais de 7 dias')`; `it('resultCounts conta classificações e resultados, writing só com reserva viva')`; `it('resultCounts conta phoneTaken pelas falhas com o texto de telefone já cadastrado')` (duas falhas `phoneTaken` e uma `changedAfterPreview` → `failed` 3, `phoneTaken` 2; o `result` de `completeIfDone` e de `close` traz o mesmo).
2. [ ] GREEN (`updateMany`/`groupBy`; nada de `$queryRaw`).
3. [ ] Validação: `TESTCONTAINERS_ENABLED=1 timeout 600 gate --test src/modules/people-import/people-import-close.repository.integration.spec.ts`; typecheck; `--changed`.

**Aceite:** spec aceites 21 (lote concluído e registrado uma vez), 25 (reserva vencida em lote encerrado) e 26 (o que fica das não gravadas).

**Risco: crítico (produção)** (revisão 1) — fecha o lote e grava a Trilha uma vez só, decide quais linhas de pessoa ficam "Não gravada" e o que delas fica no banco. Revisor `opus`.

## Task 14 — Motivo na criação de pessoa sem acesso (back)

**Arquivos:**
- Modificar: `backend/src/modules/users/users.service.ts` (`createPersonWithoutAccess`, `createWithTrail`, `createInvitation`; `export` em `normalizeJobTitle`).
- Criar: `backend/src/modules/users/users.service.reason.spec.ts`.

**Interfaces:**
- Consome: `PersonChangeMeta` (`users.service.ts`: `{ reason: string | null; action?: string; category?: AuditCategory }`); `UsersRepository.createWithAudit` (inalterado).
- Produz: `createPersonWithoutAccess(actorId: string, input: PersonWithoutAccessInput, meta?: PersonCreateMeta): Promise<UserView>`, com `export type PersonCreateMeta = PersonChangeMeta & { personId?: string }` (contrato novo com T20a, EX17.4 a: `personId` vira o `id` da pessoa criada; `personWithoutAccessData` ganha o id e o põe em `data.id` só quando vem); `normalizeJobTitle` exportada (T6 e T9 usam); `export` nos tipos `PersonWithoutAccessInput` (`users.service.ts` ~L93: `name: string; phone: string; sectorId: string | null` obrigatório; `levelId?`, `jobTitle?`, `shiftId?` anuláveis; mais `PersonRecordInput`) e `UserPatch` (~L60), sem mudar a forma (T20a usa; revisão 1, M3).

**Contexto vinculado:**
- Spec E6: "A criação de pessoa sem acesso passa a aceitar o motivo (hoje grava vazio); o padrão das outras portas não muda."
- Restrição: "Toda gravação de pessoa passa por `UsersService` (`createPersonWithoutAccess` e `updateUser`), o caminho único do Lote C."
- EX21: `createWithTrail` passa a receber um objeto `{ data, action, actorId, values, reason }` (sai de 4 para 1 parâmetro, GX12); o convite passa `reason: null`; a trilha `user.person_created` grava `reason: meta?.reason ?? null`.
- EX17.4 a (ruling da coordenação, Conselho S): a importação cria a pessoa com o id que guardou na linha antes de criar, para reconhecer na retomada a pessoa criada pela própria linha. Conferido: `User.id` é `@id @default(cuid())` (`schema.prisma:72`), logo `Prisma.UserCreateInput` aceita `id`; `createWithAudit` não filtra `id` (`refuseAssignmentInData` só recusa chaves de vínculo). Nenhum outro chamador passa `personId`; `users.controller.ts:58` continua com dois argumentos.
- GX14 (arquivo legado: sem `prettier --write`), GX15 (parâmetro novo opcional; chamadores existentes intocados).

**Passos:**
1. [ ] RED `users.service.reason.spec.ts` (montagem do serviço com dependências falsas no molde de `users.service.spec.ts`, que existe, como os outros `users.service.*.spec.ts` — conferido pelo revisor): `it('createPersonWithoutAccess grava o motivo na trilha da criação')`; `it('sem motivo continua gravando motivo nulo')`; `it('convite continua sem motivo')`; R2 `it('createPersonWithoutAccess cria com o id dado em meta.personId')` (`createWithAudit` recebe `data.id` = o id dado; sem `personId`, `data` sem a chave `id`).
2. [ ] GREEN.
3. [ ] Validação: `timeout 600 gate --test src/modules/users/users.service.reason.spec.ts`; `timeout 600 gate --test` em `src/modules/users/users.service.spec.ts` e em cada `src/modules/users/users.service.*.spec.ts` existente que chame `createPersonWithoutAccess` ou `createInvitation` (não podem quebrar); `TESTCONTAINERS_ENABLED=1 timeout 600 gate --test src/modules/users/assignment-paths.integration.spec.ts`; typecheck; `--changed`.

**Aceite:** base do aceite 14 (motivo da importação na trilha da pessoa criada).

**Risco: alto** (caminho único de gravação de pessoa; mudança de assinatura privada; id dado por quem chama, só pela importação).

## Task 15 — Classificador do lote (back)

**Arquivos:**
- Criar: `backend/src/modules/people-import/batch-classifier.ts`, `batch-classifier.spec.ts`.

**Interfaces:**
- Consome: T11a (`ColumnMapping`, `RowClass`, `ROW_CLASSES` de CX2; `RowCells`, `RowVerdict`, `ImportPerson` de CX14), T5 (`mappedColumns`), T6 (`fieldsOf`, `parseFields`), T8 (`parseAuthorizationCells`), T10 (`classifyRow`, `duplicateOf`, `PeopleLookup`), T12 (`findPeopleByKeys`, `loadCatalog`, `RowRecord`), T11b (`ImportActor`, `phoneFullFor`); `brazilianPhoneVariants`; `CivilDate`.
- Produz: `BatchClassifier`, `buildLookup`, `countByClass` (CX12).

**Contexto vinculado:**
- Spec E4, Duplicada: "A primeira ocorrência segue com a classificação que tiver, mesmo inválida; as seguintes ficam como duplicadas e não entram." EX31.
- Spec E5: "Contadores por classificação no topo" → `countByClass` com todas as classes.
- EX15 (ordem); a consulta de pessoas é feita uma vez por lote (todas as chaves e grafias), nunca por linha (5.000 linhas).
- EX17.3, consulta do lote (Conselho S): "para quem não tem a chave, não recebe nenhum telefone". `classify` chama `findPeopleByKeys({ registrationKeys, phones: phoneFullFor(actor) ? <todas as grafias> : [] })`; sem a chave, `buildLookup` recebe só pessoas achadas pela matrícula e `byPhone` não tem dono de número do arquivo. É a defesa em profundidade da regra "a prévia não diz se um número já existe" (o `classifyRow`, T10, também não lê `byPhone` sem a chave).

**Passos:**
1. [ ] RED (repositório falso): `it('classifica o lote: duplicadas depois da primeira, as demais por classifyRow')`; `it('consulta pessoas uma vez com todas as matrículas e grafias de telefone')` (ator com a chave e ADMIN); S1-2 `it('S1-2: sem telefone.ver_completo, a consulta de pessoas do lote não recebe nenhum telefone')` (spy em `findPeopleByKeys`: uma chamada, `phones` `[]`, `registrationKeys` com as matrículas do arquivo); `it('countByClass conta todas as classes, inclusive zero')`; `it('buildLookup indexa cada grafia do telefone e a chave da matrícula')`.
2. [ ] GREEN.
3. [ ] Validação: `timeout 600 gate --test src/modules/people-import/batch-classifier.spec.ts`; typecheck; `--changed`.

**Aceite:** base dos aceites 11 e 16 (classificação do lote inteiro).

**Risco: crítico (autorização)** (Conselho S) — decide se a consulta do lote leva os telefones do arquivo ao cadastro para quem não tem `telefone.ver_completo` (oráculo de número fechado pela sentença); além disso liga as regras puras ao lote. Revisor `opus`.

## Task 16 — Envio, remapeamento e descarte (back)

**Arquivos:**
- Criar: `backend/src/modules/people-import/people-import-preview.service.ts`, `upload-format.ts`, `people-import-preview.service.spec.ts`, `upload-format.spec.ts`.

**Interfaces:**
- Consome: T3 (`readCsvSheet`, `SheetReadError`, `IMPORT_MAX_BYTES`), T4 (`readXlsxSheet` com `repair: normalizeXlsxForExceljs` de `excel-import/xlsx-normalizer.ts`), T5 (`suggestMapping`, `mappingProblem`), T6 (`rowCellsOf`), T11a (erros de CX3, `ColumnMapping`), T11b (`loadImportActor`, `assertCanWrite`, `canSeeBatch`), T12 (`createBatch`, `replaceRows`, `findBatch`, `readRowCells`, `deletePreview`, `deleteStalePreviews`), T15 (`BatchClassifier`), T17 (`summaryFor`, `visibleBatch`), T19 (`closeStale`); `DomainError`; `node:crypto` (SHA-256); `todayIn`.
- Produz: `PeopleImportPreviewService` e `UploadedSheet` (CX12); em `upload-format.ts`: `formatOf`, `uploadedFileName` e `fromSheetReadError` (CX12; o mapa de `fromSheetReadError` está em CX3, logo depois da tabela de erros — revisão 1, I3).

**Contexto vinculado:**
- Spec E2: "Aceita: `.csv` e `.xlsx`, até 5 MB e 5.000 linhas de dados. O arquivo em si não é guardado. Ficam o nome, o tamanho, o resumo SHA-256 e as linhas lidas." Spec E5: "O lote em prévia pode ser descartado. Lotes em prévia com mais de 7 dias são apagados quando alguém envia um arquivo novo." Spec E6: "Lote interrompido há mais de 7 dias é encerrado do mesmo jeito quando alguém envia um arquivo novo." Spec E3: "Mudar o mapeamento refaz a prévia."
- GX6: "sem `pessoas.editar`, as rotas de envio e de confirmação respondem 403"; "as travas são conferidas na prévia e de novo na gravação, com as permissões daquele momento". EX4 (tipo por extensão e assinatura; nome do arquivo: latin1 do multer → UTF-8, sem caminho, até 255), EX6 (remapear relê o ator e roda `assertCanWrite` com as permissões de agora; reclassifica com o alcance de agora), EX25 (remapear só quem enviou, 403 `not_uploader` inclusive ADMIN; descartar quem vê, só em prévia, 409 `not_preview`), EX30, EX32.
- EX14, descarte *(confirmado pela coordenação, ponto 5; a GBR confirma)*: descartar apaga o lote e as linhas (`deletePreview`); não fica registro; depois disso o lote responde 404.
- Ordem do `upload`: ator (`loadImportActor` + `assertCanWrite`) → `formatOf` (422) → tamanho (422) → leitura (`fromSheetReadError`) → limpeza (`deleteStalePreviews(agora − 7 d)` e `closeStale(agora)`) → sugestão → classificação (se `mappingProblem` nulo) → `createBatch` (com `fileName = uploadedFileName(originalName)`) → `summaryFor`. Nada é gravado antes da leitura terminar bem.
- Ordem do `remap`: ator (`loadImportActor`) → `visibleBatch` (404) → quem enviou (403 `not_uploader`) → `assertCanWrite` (403, permissões de agora) → `status` (409 `not_preview`) → `mappingProblem` do novo mapeamento (422 `mapping_incomplete`) → `readRowCells` → classificação com o ator de agora → `replaceRows` (`false` → 409) → `summaryFor`.
- GX17: nenhum log com célula ou nome de arquivo do usuário além do `fileName` no lote.

**Passos:**
1. [ ] RED `upload-format.spec.ts`: `it('xlsx pela extensão e pela assinatura PK; csv sem a assinatura; outro caso nulo')`; `it('nome do arquivo: latin1 do multer vira UTF-8, sem caminho, cortado em 255')` (`Buffer.from('Relatório São João.csv', 'utf8').toString('latin1')` → `'Relatório São João.csv'`; `'C:\\pasta\\a.csv'` → `'a.csv'`; 300 caracteres → 255; texto que não é UTF-8 em latin1 fica como veio); `it('fromSheetReadError traduz cada problema da leitura')` (tabela com os sete problemas de CX6 e os textos de CX3).
2. [ ] RED `people-import-preview.service.spec.ts` (fakes; dois ou três `describe` irmãos): `it('envio: lê, sugere colunas, classifica e guarda com o SHA-256; devolve o resumo')`; `it('envio guarda o nome do arquivo acentuado em UTF-8')`; `it('arquivo que não é csv nem xlsx: 422 invalid_file')`; `it('acima de 5 MB: 422 file_too_large')`; `it('acima de 5.000 linhas: 422 com o texto da spec')`; `it('quem não é ADMIN sem pessoas.editar: 403 no envio, sem ler o arquivo')`; `it('mapeamento incompleto: lote guardado sem classificação e com o aviso')`; `it('envio apaga prévias com mais de 7 dias e encerra gravações paradas há mais de 7 dias')`; `it('aceite 13: remapear refaz a prévia; só quem enviou; só em prévia')`; `it('remapear relê o ator: sem pessoas.editar agora, 403; sem setor agora, 403 no_managed_sector; nada muda')`; `it('remapear reclassifica com o alcance de agora')`; `it('remapear incompleto: 422 e nada muda')`; `it('descartar: lote alheio 404 para quem não é ADMIN; fora da prévia 409; apaga o lote e ele passa a responder 404')`.
3. [ ] GREEN.
4. [ ] Validação: `timeout 600 gate --test` nos dois specs; typecheck; `--changed`.

**Aceite:** spec aceites 13 (remapear) e 22/24 (recusas do envio); E2 e o prazo de 7 dias de E5/E6.

**Risco: crítico (autorização)** — porta de entrada do arquivo e das travas de quem não é ADMIN (`pessoas.editar`, setor), e decide quem remapeia e descarta lote alheio.

## Task 17 — Consulta: resumo, linhas da prévia e lista (back)

**Arquivos:**
- Criar: `backend/src/modules/people-import/people-import-query.service.ts`, `row-view.ts`, `people-import-query.service.spec.ts`, `row-view.spec.ts`.

**Interfaces:**
- Consome: T11a (contrato CX2, erros CX3 inclusive `mappingIncomplete` e `notInPreview`; `RowPreview`, `FieldDiff`, `DiffField`, `ImportResultCounts` de CX14), T11b (`loadImportActor`, `canSeeBatch`, `phoneFullFor`, `ImportActor`), T12 (`findBatch`, `pageRows`, `listBatches`, `userNames`, `BatchRecord`, `StoredRow`), T13b (`resultCounts`, `settleExpired`), T5 (`mappingProblem`, `mappedColumns`), T6 (`fieldsOf`, `isMaskedPhoneText`, para o nome e a matrícula da linha); `nameView`, `phoneView`; `formatPhoneCell` (Lote D).
- Produz: `PeopleImportQueryService`, `batchSituation` e `toRowView` (CX12).

**Contexto vinculado:**
- Spec E5: "A prévia mostra: número da linha no arquivo, classificação, nome, matrícula, setor, e — em 'Atualizar' — o que muda, campo a campo (antes → depois; telefone conforme a permissão de ver telefone). Motivos e avisos por extenso. Contadores por classificação no topo; filtro por classificação; paginada (50 por página)." "Linhas inválidas, duplicadas, em conflito, sem alteração e ignoradas não têm caixa."
- Spec E7: "Registro do lote: arquivo, tamanho, SHA-256, autor e hora do envio, quem confirmou e quando, hora do fim, contagens." "Quem vê os lotes: o ADMIN vê todos; os demais veem só os seus (prévia, andamento, relatório e descarte seguem a mesma regra; lote de outra pessoa responde 404)."
- GX8 (máscara na leitura): `diff.before` de nome e telefone e `preview.personName` passam por `nameView`/`phoneView` com `full = phoneFullFor(actor)`; telefone mostrado com `formatPhoneCell` quando completo. Coluna "nome" da linha = célula do arquivo; vazia (ou mascarada) em Atualizar/Sem alteração = `preview.personName` mascarado. Nomes dos autores (`createdBy`, `confirmedBy`) com `nameView`.
- EX11 (situação derivada, 3 minutos), EX13 (lote CLOSED: `settleExpired` antes de contar), EX25 (`canConfirm` = em prévia, sem `mappingProblem` e ator é quem enviou; `canContinue` = WRITING e ator é quem confirmou; `canClose` = WRITING e ADMIN; `canDiscard` = PREVIEW; `hasErrorReport` = inválidas + duplicadas + conflitos + falhas + não gravadas > 0; `phoneCheckDeferred` = `!phoneFullFor(actor)` com o ator relido no pedido — Conselho S: "o resumo do lote ganha um indicador que a tela usa para mostrar o aviso" "A conferência de telefones já cadastrados é feita ao gravar."; `progress.phoneTaken` e `counts`/`result` vêm de `resultCounts`, T13b), EX26 (`rows`: 404 → 409 `not_preview` fora de prévia → 422 `mapping_incomplete` com o texto do `mappingProblem` quando o lote em prévia tem mapeamento incompleto; revisão 1, M8). `RowDiffView.label` pelo `DiffField` (Nome, Telefone, Matrícula, Função, Setor, Turno, Nível, Autorização de contato).

**Passos:**
1. [ ] RED `row-view.spec.ts`: `it('diff mascara nome e telefone de antes sem telefone.ver_completo')`; `it('nome da linha: célula do arquivo; vazia em Atualizar usa o nome atual com nameView')`; `it('selectable só em Criar e Atualizar')`.
2. [ ] RED `people-import-query.service.spec.ts`: `it('lote de outra pessoa responde 404 para quem não é ADMIN; ADMIN vê')`; `it('aceite 23: resumo traz arquivo, autor, envio, confirmação, fim e contagens')` (inclui `progress.phoneTaken`); S1-6 `it('S1-6: phoneCheckDeferred só para quem não tem telefone.ver_completo')` (gestor sem a chave `true`; gestor com a chave e ADMIN `false`; a lista não traz o campo); `it('situação: Gravação interrompida depois de 3 minutos sem bloco')`; `it('linhas: 50 por página, filtro por classificação, só em prévia')`; `it('linhas de lote em prévia com mapeamento incompleto: 422 mapping_incomplete com o texto')`; `it('lista: ADMIN todos; demais os seus')`; `it('lote encerrado acerta reservas vencidas antes de contar')`.
3. [ ] GREEN.
4. [ ] Validação: `timeout 600 gate --test` nos dois specs; typecheck; `--changed`.

**Aceite:** spec aceites 23 (registro na tela), 24 (lote alheio) e E5 (prévia paginada).

**Risco: crítico (autorização)** — decide quem vê cada lote e mascara nome e telefone de pessoas na prévia.

## Task 18 — Modelo e relatório de erros (back)

**Arquivos:**
- Criar: `backend/src/modules/people-import/people-import-files.service.ts`, `import-template.ts`, `people-import-files.service.spec.ts`, `import-template.spec.ts`.

**Interfaces:**
- Consome: Lote D (`openSpreadsheet`, `CsvStreamWriter`, `setDownloadHeaders`, `failDownload`, `PEOPLE_TEMPLATE_COLUMNS`, `PEOPLE_COLUMN_MEANING`, `formatDateCell`); T5 (`mappedColumns`); T12 (`reportRows`, `BatchRecord`); T17 (`visibleBatch`); T11b (`loadImportActor`); T13b (`settleExpired`); `todayIn`.
- Produz: `PeopleImportFilesService` (CX12); `templateRows(today: CivilDate): string[][]` e `templateInstructionRows(): string[][]` em `import-template.ts`.

**Contexto vinculado:**
- Spec E2, Modelo: "`GET /internal/people-import/template?format=csv|xlsx`: cabeçalhos `matricula`, `nome`, `telefone`, `funcao`, `setor`, `turno`, `nivel`, `autorizacao_contato`, `origem_autorizacao`, `detalhe_origem`, `data_autorizacao`, e uma linha de exemplo com matrícula `EXEMPLO`. No XLSX, uma aba 'Instruções' com as regras desta seção."
- Spec E7, Relatório: "`GET /internal/people-import/batches/:id/errors.csv`: uma linha por linha do arquivo que não entrou (inválida, duplicada, conflito, falha na gravação, não gravada por encerramento), com `linha`, as colunas mapeadas (com o cabeçalho original do arquivo) e `motivo`. Mesmo formato de CSV. O telefone sai como veio no arquivo. Baixar exige `pessoas.importar` e ser quem enviou o lote ou ADMIN."
- EX23, EX24, texto da aba Instruções em CX12; GX10 (escritores do Lote D; ordem: conferir permissão e lote → headers → bytes; erro depois dos headers → `failDownload`).

**Passos:**
1. [ ] RED `import-template.spec.ts`: `it('linha de exemplo com EXEMPLO e a data de hoje')`; `it('instruções com as regras e o significado das onze colunas')`.
2. [ ] RED `people-import-files.service.spec.ts`: `it('aceite 12: modelo CSV com BOM, ;, cabeçalhos do modelo e linha EXEMPLO')`; `it('modelo XLSX com abas Pessoas e Instruções')`; `it('aceite 11: relatório traz linha, colunas mapeadas com o cabeçalho original e motivo')`; `it('relatório: telefone como veio e fórmula protegida')`; `it('relatório inclui falhas e não gravadas')`; `it('relatório de lote alheio: 404 sem header de download')`.
3. [ ] GREEN.
4. [ ] Validação: `timeout 600 gate --test` nos dois specs; typecheck; `--changed`.

**Aceite:** spec aceites 11 (relatório) e 12 (modelo).

**Risco: crítico (autorização)** — o relatório traz telefones e dados do arquivo; só quem enviou e o ADMIN podem baixar.

## Task 19 — Confirmar, encerrar e concluir (back)

**Arquivos:**
- Criar: `backend/src/modules/people-import/people-import-confirm.service.ts`, `people-import-confirm.service.spec.ts`.

**Interfaces:**
- Consome: T11a (erros, inclusive `alreadyConfirmed`, `nothingSelected`, `mappingIncomplete`, `notUploader`, `closeAdminOnly`, `notWriting`; `ConfirmBody`; `ImportResultCounts`), T11b (`loadImportActor`, `assertCanWrite`, `importConfirmedChange`, `importCompletedChange`), T5 (`unmappedColumns`, `mappingProblem`), T13a (`confirm`), T13b (`close`, `completeIfDone`, `staleWriting`), T17 (`visibleBatch`, `summaryFor`), T12 (`BatchRecord`); `AuditService.recordChange`.
- Produz: `PeopleImportConfirmService` (CX12).

**Contexto vinculado:**
- Spec E5: "Escolha do conjunto: 'Criar pessoas novas (n)' e 'Atualizar pessoas existentes (n)', os dois marcados por padrão; e uma caixa por linha para tirar linhas individuais." Spec E6: "Um lote só pode ser confirmado uma vez. Dois cliques, ou duas abas, não gravam duas vezes." "O ADMIN pode 'Encerrar gravação' de qualquer lote … O encerramento grava `people_import.completed` com as contagens, e o autor do registro é quem encerrou."
- GX5 (trilha), GX6 (`pessoas.editar` na confirmação), EX7, EX8, EX13 (encerramento e automático, autor do automático = quem confirmou), EX25 (só quem enviou confirma; só ADMIN encerra).
- Ordem do `confirm`: ator → `visibleBatch` (404) → quem enviou (403 `not_uploader`) → `assertCanWrite` (403) → `status` fora de `PREVIEW` → 409 `people_import.already_confirmed` ("Esta importação já foi confirmada."), sem chamar o repositório → `mappingProblem` (422) → `repo.confirm` (`not_preview` → o mesmo 409 `already_confirmed`; `nothing_selected` → 422) → `summaryFor`. A confirmação nunca responde `not_preview` (revisão 1, M2).

**Passos:**
1. [ ] RED (fakes): `it('confirma: marca a seleção, limpa e grava people_import.confirmed')`; `it('aceite 21: segunda confirmação responde 409 already_confirmed e não grava trilha')` (o repositório devolve `not_preview`); `it('lote já em gravação ou concluído: 409 already_confirmed sem chamar o repositório')`; `it('só quem enviou confirma; ADMIN em lote alheio recebe 403')`; `it('nada escolhido: 422')`; `it('quem não é ADMIN sem pessoas.editar: 403')`; `it('encerrar: só ADMIN; pendentes viram Não gravada; trilha com quem encerrou')`; `it('completeIfDone grava people_import.completed com o confirmador como autor')`; `it('closeStale encerra gravações paradas há mais de 7 dias com o motivo automático')`.
2. [ ] GREEN.
3. [ ] Validação: `timeout 600 gate --test src/modules/people-import/people-import-confirm.service.spec.ts`; typecheck; `--changed`.

**Aceite:** spec aceites 21 e 23 (trilha); E5 (seleção) e E6 (encerrar).

**Risco: crítico (autorização)** — decide quem confirma uma gravação em lote e quem encerra, e grava a Trilha.

## Task 20a — Gravação de uma linha (back)

**Arquivos:**
- Criar: `backend/src/modules/people-import/row-writer.ts`, `row-writer.spec.ts`, `row-writer.integration.spec.ts`.

**Interfaces:**
- Consome: T11a (`RowPlan`, `CreatePlan`, `ImportPatch`, `RowOutcome`, `ImportPerson` de CX14; `ROW_TEXT`), T7 (`StructureCatalog`, `structureName`), T9 (`patchSatisfied`, `personFingerprint`, `samePhone`), T11b (`ImportActor`, `phoneFullFor`), T12 (`findPeopleByKeys`, com `ids`), T14 (`createPersonWithoutAccess` com `meta: PersonCreateMeta` = `{ reason, personId }`; tipos exportados `PersonWithoutAccessInput` e `UserPatch`), `UsersService.updateUser(id, patch, actorId, { reason })`; `canEditContactAuthorization`; `DomainError`, `NotFoundError`; `Logger`. Nada da T10 (o `RowPlan` vem da T11a). O `personId` da entrada vem de `ReservedRow.personId` (T13a), passado pela T20b; os testes o dão direto.
- Produz: `RowWriter.write({ plan, personId, actor, reason, catalog })` (CX12). Contrato novo com T13a/T20b e T14 (EX17.4 a): na criação, `personId` é o id com que a pessoa é criada e o que se procura antes de criar.

**Contexto vinculado:**
- Spec E6: "Só as linhas confirmadas são gravadas, uma a uma, pelo mesmo caminho do cadastro manual: criar pessoa sem acesso, ou atualizar a pessoa. Cada uma gera a entrada normal na trilha da pessoa e, se mudou setor, turno ou nível, a linha de vínculo com início hoje." "Cada linha é conferida de novo na hora de gravar, nesta ordem: identificar a pessoa de novo → se os valores atuais já são os da linha, registrar como 'Sem alteração', sem falha (vale para linha de criação cuja pessoa já existe com os valores da linha) → só então conferir a data da última alteração e os conflitos. … se for outra na gravação, a linha falha com 'A pessoa foi alterada depois da prévia'. Matrícula ou telefone que passou a ser de outra pessoa falha com o motivo do conflito. Linha que falha não impede as outras." "A gravação nunca aplica mais do que a prévia mostrou."
- GX3 (caminho único: só `createPersonWithoutAccess` e `updateUser`), GX6 (travas na gravação, "com as permissões daquele momento"), EX12 (versão: `personFingerprint` diferente → "A pessoa foi alterada depois da prévia"), EX21 (motivo `importReason(fileName)` no `meta`).
- EX19 (ponto 7 confirmado; revisão 1, I2), para quem não é ADMIN, **antes** de "Sem alteração": (a) setor de destino (`plan.input.sectorId` / `plan.patch.sectorId`) fora do `actor.reach` de agora → FAILED "Setor '<nome>' não encontrado entre os setores que você gerencia" (`notInReach(structureName(catalog, 'sector', id))`); (b) só atualização: pessoa fora do alcance hoje ou com login → "Você não pode alterar esta pessoa."; (c) EX17.1: patch com telefone, ator sem `telefone.ver_completo` e pessoa que hoje tem telefone → "Você não pode alterar o telefone desta pessoa." (o telefone sai da comparação: nada de "Sem alteração" porque o número é igual); (d) só atualização: patch com autorização e `canEditContactAuthorization(actor.policy, pessoa)` falso → "Você não pode alterar a autorização desta pessoa.". Trava que barra → FAILED com o texto; nunca grava a linha sem o campo.
- EX17.2 (Conselho S, S2-a com I1): sem a chave, telefone vazio de pessoa achada pela matrícula vai no patch sem conferir se está livre; "a unicidade é só a do `updateUser`/`createPersonWithoutAccess` na gravação"; número já de outra pessoa → a linha inteira falha com `phoneTaken`, nenhum campo aplicado; "na gravação, a trava de telefone é conferida antes de 'Sem alteração'" (EX19 c).
- EX17.3 (Conselho S, S1-b ajustada): "na gravação, número que já é de outra pessoa faz a linha falhar com 'O telefone já pertence a outra pessoa cadastrada', seja de quem for; as outras linhas seguem" — mesmo `RowOutcome` para dono sem login no alcance, com login, fora do alcance e na outra grafia.
- EX17.4 (ruling da coordenação): (a) linha de criação só vira "Sem alteração" quando a pessoa foi criada **por essa mesma linha** (pessoa com `id = personId` existe → UNCHANGED, antes de qualquer trava, para qualquer ator, com ou sem matrícula); qualquer erro do cadastro na criação (inclusive P2002 com alvo `id`, da corrida entre dois pedidos da mesma linha) → relê pelo id da linha antes de traduzir pela EX20 (m1); (b) sem a chave: não consulta telefone; matrícula de outra pessoa → `registrationTaken`; `phone_taken` → `phoneTaken`; sempre sem comparar valores; (c) ADMIN: achada de novo com os valores da linha → UNCHANGED; quem tem a chave e não é ADMIN: pessoa achada de novo fora do alcance ou com login → `phoneTaken`/`registrationTaken` sem comparar valores (spec E4/E6, aceite 27; m2), senão UNCHANGED se os valores batem; o que sobra → `phoneTaken`/`registrationTaken`; nunca `cannotEditPerson` na criação.
- EX20 (revisão 1, M4): `user.phone_taken` → `phoneTaken`; `user.registration_taken` → `registrationTaken`; `user.sector_invalid`, `users.invalid_shift`, `users.invalid_level` → `structureInactive`; `user.invalid_phone` → `invalidPhone`; `user.authorization_future_date` → `futureDate`; `NotFoundError` e `Error('USER_NOT_FOUND')` (`users.repository.ts:303` e `:343`) → `removedAfterPreview`; `user.concurrent_admin_change` e qualquer outro → `writeFailed` ("Não foi possível gravar esta linha."), FAILED, `logger.error('falha ao gravar linha da importação (código <code ou nome do erro>)')`, sem nome, telefone, célula ou id de pessoa.
- Conversão para o `UsersService` (revisão 1, M3): criação → `PersonWithoutAccessInput` = `{ ...plan.input, sectorId: plan.input.sectorId ?? null }` (lá `sectorId` é obrigatório e anulável); atualização → o `ImportPatch` vai como `UserPatch` (subconjunto, mesmos tipos).
- Ordem do `write` (uma função curta por passo): (0) **criação**: `findPeopleByKeys({ ids: [personId], registrationKeys: [], phones: [] })` acha → UNCHANGED com esse `personId` (EX17.4 a); `personId` nulo numa criação → FAILED `writeFailed` com `logger.error` sem dado pessoal (não acontece depois da reserva); (1) trava (a) do setor de destino; (2) reidentificar: matrícula sempre; telefone só se `phoneFullFor(actor)` (criação e atualização); (3) **criação**: sem a chave → achada pela matrícula → FAILED `registrationTaken` sem comparar (EX17.4 b); ADMIN → achada → `patchSatisfied` → UNCHANGED, senão FAILED `phoneTaken` (achada pelo telefone, ou chaves em pessoas diferentes) ou `registrationTaken`; com a chave e não ADMIN → achada fora do alcance ou com login → FAILED `phoneTaken`/`registrationTaken` direto, sem comparar valores; no alcance e sem login → `patchSatisfied` → UNCHANGED, senão o mesmo FAILED (EX17.4 c, m2); não achada → `createPersonWithoutAccess(actor.id, input, { reason, personId })` → CREATED com `personId`; **qualquer erro** do cadastro na criação (inclusive P2002 alvo `id`) → relê pelo id: existe → UNCHANGED; senão o motivo de EX20 (m1); (4) **atualização**: não achada → `removedAfterPreview`; outra pessoa pelas chaves → motivo do conflito; travas (b), (c), (d); `patchSatisfied` → UNCHANGED; `personFingerprint` diferente → `changedAfterPreview`; pessoa inativa → `inactivePerson`; senão `updateUser` → UPDATED. Erro do `UsersService` → tabela EX20.

**Passos:**
1. [ ] RED `row-writer.spec.ts` (fakes; dois `describe` irmãos se passar de 50 linhas): `it('ordem E6: reidentifica, Sem alteração antes da versão, depois versão e conflitos')`; `it('trava de quem não é ADMIN conferida de novo na gravação')` (pessoa saiu do alcance; ganhou login; ator perdeu a permissão de autorização); `it('setor de destino fora do alcance de agora: a linha falha com notInReach')` (criação e atualização; o nome vem do catálogo; ADMIN não passa por essa trava); `it('sem telefone.ver_completo na gravação: telefone fica fora da comparação e a linha falha com cannotEditPhone')` (patch com telefone igual ao gravado e com telefone diferente → o mesmo FAILED, nenhum UNCHANGED); S2-5 `it('S2-5: pessoa que ganhou telefone entre a prévia e a gravação falha com cannotEditPhone, nunca Sem alteração')` (pessoa sem telefone na prévia; hoje com o número do patch e com outro → os dois `FAILED` `cannotEditPhone`; `updateUser` não chamado); R3, num `describe('criação achada de novo (EX17.4)')` irmão: `it('criação: pessoa com o id da linha já existe dá Sem alteração antes das travas, inclusive sem a chave e sem matrícula')` (`UNCHANGED` com o `personId` dado, mesmo com setor fora do alcance de agora; `createPersonWithoutAccess` não chamado; `findPeopleByKeys` sem telefone), `it('sem a chave, criação: matrícula de outra pessoa ou phone_taken falham sem comparar valores')` (`registrationTaken` e `phoneTaken` mesmo com os valores da linha iguais aos da pessoa; `findPeopleByKeys` sempre com `phones` `[]`), `it('com a chave, criação achada de novo: ADMIN com os valores da linha dá Sem alteração; gestor com pessoa fora do alcance ou com login falha com phoneTaken ou registrationTaken; nunca cannotEditPerson')` (gestor com a chave e pessoa fora do alcance ou com login → FAILED mesmo com os valores iguais; ADMIN → UNCHANGED se iguais), `it('phone_taken na criação relê pelo id: pessoa da própria linha dá Sem alteração')`, `it('erro desconhecido na criação e pessoa da linha existente → UNCHANGED')` (`createPersonWithoutAccess` lança erro qualquer, inclusive P2002 alvo `id`; pessoa com o `personId` existe → `UNCHANGED`, sem `logger.error`); `it('erros do cadastro viram motivos da linha; erro desconhecido loga sem dado pessoal')` (espiona o `Logger`: mensagem sem nome, telefone nem id); `it('Error USER_NOT_FOUND vira removedAfterPreview; user.concurrent_admin_change vira o texto genérico e FAILED')`; `it('criação passa sectorId nulo quando o plano não tem setor')`; `it('criação passa o personId da linha como meta.personId')`.
2. [ ] RED `row-writer.integration.spec.ts` (Postgres real, `UsersService` montado como em `assignment-paths.integration.spec.ts`, relógio fixo; `describe` irmãos por assunto): `it('cria pessoa sem acesso com o motivo, o vínculo com início hoje e o id da linha')` (`User.id` = `personId`); `it('atualiza pela matrícula com o motivo na trilha e linha de vínculo nova')`; `it('aceite 20: pessoa alterada depois da prévia falha; as outras linhas entram')`; `it('com a chave: criação de pessoa que já existe com os valores da linha dá Sem alteração, sem pessoa em dobro')`; `it('aceite 15: Sim com origem grava a autorização com a origem e a data de hoje')`; S1-5 `it.each([...])('S1-5: sem telefone.ver_completo, número já cadastrado (%s) falha com phoneTaken')` (dono sem login no alcance, com login, fora do alcance, outra grafia do 9º dígito → `{ outcome: 'FAILED', reason: phoneTaken, personId: null }` igual nos quatro; nenhuma pessoa nova); S2-3 `it('S2-3: sem a chave, número livre preenche o telefone vazio, liga o Contato e grava o motivo na trilha da pessoa')`; S2-4 `it('S2-4: sem a chave, número ocupado: FAILED phoneTaken e nenhum campo da linha aplicado')` (nome, telefone e vínculo iguais aos de antes; nenhum evento novo da pessoa); R4 `it('retomada: pessoa criada pela linha e reserva vencida antes de registrar dá Sem alteração, sem a chave e sem matrícula')` (primeiro `write` cria; segundo `write` com o mesmo `plan` e `personId` → `UNCHANGED`, uma pessoa só com aquele telefone); `it('dois write concorrentes com a mesma personId (Promise.all): uma pessoa só, nenhuma linha FAILED')` (re-revisão 2, m1: o P2002 de alvo `id` da corrida é relido pelo id e vira `UNCHANGED`; uma `User` com aquele `personId`, nenhum `FAILED`).
3. [ ] GREEN.
4. [ ] Validação: `timeout 600 gate --test src/modules/people-import/row-writer.spec.ts`; `TESTCONTAINERS_ENABLED=1 timeout 600 gate --test src/modules/people-import/row-writer.integration.spec.ts`; typecheck; `--changed`.

**Aceite:** spec aceites 14 (gravação), 15 (gravação), 20 e 24 (gravação).

**Risco: crítico (autorização)** — grava pessoas em produção conferindo de novo alcance, login e permissões de telefone e autorização, e decide se "Sem alteração" confirma o dono de um telefone para quem não tem a chave (EX17.4).

## Task 20b — Gravação em blocos (back)

**Arquivos:**
- Criar: `backend/src/modules/people-import/people-import-writer.service.ts`, `people-import-writer.service.spec.ts`.

**Interfaces:**
- Consome: T11a (erros `notConfirmer`, `notWriting`; `RowOutcome`), T11b (`loadImportActor`, `assertCanWrite`, `importReason`), T12 (`loadCatalog`, uma vez por bloco, passado ao `RowWriter`), T13a (`touchBlock`, `reserveNextRow`, `finalizeRow`, `ReservedRow.personId`), T17 (`visibleBatch`, `summaryFor`), T19 (`completeIfDone`), T20a (`RowWriter`, que recebe `personId`); `randomUUID`.
- Produz: `PeopleImportWriterService.writeBlock`, `BLOCK_MAX_ROWS`, `BLOCK_MAX_MS`, `RESERVATION_MS` (CX12).

**Contexto vinculado:**
- Spec E6: "A gravação acontece na API, em blocos pedidos pela tela: a tela pede um bloco, a API grava linhas por até 10 segundos (no máximo 50) e devolve o andamento ('Gravando 120 de 300'); a tela pede o próximo até acabar. Não usa a fila do worker. Cada gravação roda com o usuário e as permissões de quem confirmou, conferidas a cada bloco." "Só quem confirmou continua a gravação. … Pedido de bloco de quem não confirmou o lote responde 403, inclusive para o ADMIN, que só pode encerrar." "Se o ator perdeu `pessoas.importar` ou `pessoas.editar`, o bloco responde 403 e o lote fica 'Gravação interrompida'."
- EX9 (token por pedido; reserva perdida descarta o resultado), EX10 (ordem das conferências e laço), EX11.

**Passos:**
1. [ ] RED (fakes, relógio falso): `it('bloco grava até 50 linhas')`; `it('bloco para em 10 segundos')`; `it('só quem confirmou: 403 inclusive para o ADMIN; lote alheio 404 para gestor')`; `it('ator sem pessoas.editar: 403 e nenhuma reserva')`; `it('lote fora de gravação: 409')`; `it('reserva perdida: resultado descartado sem erro')`; `it('atualiza lastBlockAt e chama completeIfDone no fim do bloco')`; `it('carrega o catálogo uma vez por bloco e o passa a cada linha, com o personId da reserva')` (`write` recebe `personId` = `ReservedRow.personId`; EX17.4 a).
2. [ ] GREEN.
3. [ ] Validação: `timeout 600 gate --test src/modules/people-import/people-import-writer.service.spec.ts`; typecheck; `--changed`.

**Aceite:** spec E6 (blocos, só quem confirmou, permissões por bloco) e base dos aceites 21 e 25.

**Risco: crítico (autorização)** — só o confirmador grava e as permissões são relidas a cada bloco; erro aqui deixa outro usuário, ou um ator sem a permissão, gravar pessoas.

## Task 21 — Controller, módulo e prova de que toda rota exige a chave (back)

**Arquivos:**
- Criar: `backend/src/modules/people-import/people-import.controller.ts`, `people-import.module.ts`, `spreadsheet-upload.interceptor.ts`, `dto/{mapping-body,confirm-body,rows-query,batch-list-query,template-query}.dto.ts`, `people-import.controller.spec.ts`.
- Modificar: `backend/src/app.module.ts` (importa `PeopleImportModule`); `backend/src/modules/permissions/route-parity.spec.ts` (só o item `{ controller: PeopleImportController, key: 'pessoas.importar' }` na lista `CLASS_KEY_CONTROLLERS`, ~L278, e o import).

**Interfaces:**
- Consome: T16–T20b; T11a (schemas); T1 (`'pessoas.importar'`); `RequirePermission`; `FileInterceptor` (`@nestjs/platform-express`); `Throttle`; `createZodDto`; `UsersModule` (exporta `UsersService` e `UsersRepository`); `@Res()` sem `passthrough` nas duas rotas de arquivo (molde `people-export.controller.ts`); `req.user.sub`.
- Produz: as rotas de CX1.
```ts
@ApiTags('people-import')
@RequirePermission('pessoas.importar')
@Controller('internal/people-import')
export class PeopleImportController {
  @Get('template') template(@Query() q: TemplateQueryDto, @Res() res: Response): Promise<void>;
  @Get('batches') list(@Query() q: BatchListQueryDto, @Req() req: AuthRequest): Promise<BatchList>;
  @Post('batches') @Throttle(…10/min) @UseInterceptors(SpreadsheetUploadInterceptor)
  upload(@UploadedFile() file: Express.Multer.File, @Req() req: AuthRequest): Promise<BatchSummary>;
  @Get('batches/:id') summary(…): Promise<BatchSummary>;
  @Put('batches/:id/mapping') @Throttle(…10/min) remap(@Param('id') id, @Body() body: MappingBodyDto, …): Promise<BatchSummary>;
  @Get('batches/:id/rows') rows(…): Promise<RowsPage>;
  @Post('batches/:id/confirm') @HttpCode(200) confirm(…): Promise<BatchSummary>;
  @Post('batches/:id/write') @HttpCode(200) write(…): Promise<BatchSummary>;
  @Post('batches/:id/close') @HttpCode(200) close(…): Promise<BatchSummary>;
  @Delete('batches/:id') @HttpCode(204) discard(…): Promise<void>;
  @Get('batches/:id/errors.csv') errors(@Param('id') id, @Req() req, @Res() res: Response): Promise<void>;
}
```

**Contexto vinculado:**
- Spec, Comum, Rotas: "os dois controllers novos levam a chave na classe (`pessoas.exportar` ou `pessoas.importar`): com a chave na classe, o papel deixa de ser conferido à parte e quem decide é a matriz (ADMIN sempre passa, VIEWER nunca). Vale para todas as rotas, inclusive a do modelo. Um teste prova que nenhuma rota deles fica sem a chave (rota sem chave e sem papel declarado cairia na regra antiga, que libera ADMIN e OPERATOR)." Aceite 22.
- DX3 do Lote D: só `@RequirePermission` na classe; nenhum `@Roles`; mistura proibida (`mixedRoutes`).
- EX4: `SpreadsheetUploadInterceptor` estende `FileInterceptor('file', { limits: { fileSize: IMPORT_MAX_BYTES, files: 1 } })`, sobrescreve `intercept` e troca `PayloadTooLargeException` por `importFileTooLarge()`; sem arquivo → `importInvalidFile()`. EX28 (throttle).
- Módulo: `imports: [UsersModule]` (`AuditModule` e `PrismaModule` são `@Global`); `providers`: os três repositórios (`PeopleImportRepository`, `PeopleImportWriteRepository`, `PeopleImportCloseRepository`), `BatchClassifier`, os cinco serviços, `RowWriter`.
- Envio: o controller monta `UploadedSheet` com `originalName: file.originalname` **cru** (latin1 do multer); quem converte para UTF-8 e corta em 255 é a T16 (`uploadedFileName`, EX4).
- GX14: `route-parity.spec.ts` e `app.module.ts` são legados (sem `prettier --write`).

**Passos:**
1. [ ] RED `route-parity.spec.ts`: acrescentar o item à lista; os três `it` existentes do `describe('controllers com a chave na classe (Etapa 2)')` passam a cobrir o controller novo (toda rota com a chave, nenhuma com `@Roles`; matriz padrão só ADMIN; chave liberada SUPERVISOR e OPERATOR passam, VIEWER não).
2. [ ] RED `people-import.controller.spec.ts`: `it('envio repassa o arquivo e o id do usuário ao serviço')`; `it('modelo e relatório escrevem na resposta')`; `it('interceptor troca o 413 do multer por 422 com o texto da spec')`; `it('rotas de ação repassam id do lote e corpo validado')`.
3. [ ] GREEN: controller, DTOs (`createZodDto` dos schemas de CX2), interceptor, módulo, `app.module.ts`.
4. [ ] Não existe `app.module.spec.ts` (conferido pelo revisor): o grafo do Nest é provado pelo boot real da API, feito pela principal no Fechamento; no report, listar os providers e exports usados.
5. [ ] Validação: `TESTCONTAINERS_ENABLED=1 timeout 600 gate --test src/modules/permissions/route-parity.spec.ts`; `timeout 600 gate --test src/modules/people-import/people-import.controller.spec.ts`; typecheck; `--changed`.

**Aceite:** spec aceite 22 (rotas) e a ligação das rotas de todos os aceites 11–28.

**Risco: crítico (autorização)** — gate das onze rotas pela chave da classe e validação do corpo e do arquivo enviados.

## Task 22a — Ponta a ponta 1: T02, atualizar, reimportar e limpeza (back)

**Arquivos:**
- Criar: `backend/src/modules/people-import/people-import.e2e.fixtures.ts` (sobe Postgres, aplica as migrações, monta os serviços reais do módulo e o `UsersService`, semeia setores, turnos, níveis, ADMIN e dois gestores com `pessoas.importar` e `pessoas.editar` — um com e um sem `telefone.ver_completo` (Conselho S; a T22b usa os dois); fábrica de CSV/XLSX em memória), `people-import.e2e.integration.spec.ts`.

**Interfaces:**
- Consome: T16, T17, T18, T19, T20b (serviços reais), `UsersService` (molde de montagem de `assignment-paths.integration.spec.ts`; ou `Test.createTestingModule` com os providers do módulo e `PrismaService` trocado pelo cliente do container); `CsvStreamWriter` para montar o CSV de entrada.
- Produz: fixtures reutilizadas pela T22b (`setupImportE2E()`, `uploadCsv(actor, rows)`, `confirmAll(actor, batchId)`, `writeAll(actor, batchId)`).

**Contexto vinculado:**
- Aceite 11 (T02): "Planilha com uma linha válida, uma duplicada e uma inválida: a prévia mostra os três resultados com o motivo; só a confirmada entra; o relatório de erros traz as outras duas."
- Aceite 14: "Atualizar por matrícula mostra antes e depois; depois de confirmar, a ficha, a trilha da pessoa e o histórico de vínculo refletem a mudança, com o motivo da importação."
- Aceite 16: "Reimportar a mesma planilha não cria ninguém: as linhas que entraram ficam 'Sem alteração' e as que não entraram repetem a classificação."
- Aceite 26: "depois de gravada, o conteúdo da linha também não [está no banco]."
- EX21 (motivo no evento da pessoa; a linha de vínculo não tem motivo), GX4 (relógio fixo).

**Passos:**
1. [ ] RED: `it('aceite 11 (T02): válida, duplicada e inválida; só a confirmada entra; o relatório traz as outras duas')`; `it('aceite 14: atualizar por matrícula mostra antes e depois e grava ficha, trilha e vínculo com o motivo')`; `it('aceite 16: reimportar a mesma planilha não cria ninguém')` (ator fixo: **ADMIN**, que identifica também pelo telefone, então as linhas sem matrícula voltam como "Sem alteração"; com gestor sem `telefone.ver_completo` e linhas sem matrícula o resultado seria `phoneTaken`, não vale para este teste — m7); `it('aceite 26: depois de gravar, o conteúdo da linha sai do banco')`; S1-5 `it('S1-5: sem a chave, número ocupado falha; as outras linhas entram; relatório, phoneTaken e trilha só com números')` (gestor sem a chave; três pessoas novas, uma com telefone de pessoa já cadastrada → as outras duas `CREATED`; a linha no `errors.csv` com "O telefone já pertence a outra pessoa cadastrada"; `progress.phoneTaken` 1; `people_import.completed` com `phoneTaken` 1 e nenhum nome ou telefone em `changes`).
2. [ ] GREEN (só fixtures e testes; defeito achado em código de outra task vai para o report com o teste vermelho, sem correção fora do ownership).
3. [ ] Validação: `TESTCONTAINERS_ENABLED=1 timeout 600 gate --test src/modules/people-import/people-import.e2e.integration.spec.ts`; typecheck; `--changed`.

**Aceite:** spec aceites 11, 14, 16 e 26 de ponta a ponta.

**Risco: alto** (só testes; prova o caminho real com banco).

## Task 22b — Ponta a ponta 2: reimportar exportação e concorrência (back)

**Arquivos:**
- Criar: `backend/src/modules/people-import/people-import.e2e-roundtrip.integration.spec.ts`.

**Interfaces:**
- Consome: fixtures da T22a (sem mudá-las); `PeopleExportService.exportPeople` e `PeopleExportRepository` reais do Lote D (escreve num `PassThrough` com `setHeader`/`removeHeader`/`headersSent` falsos, como em `people-export.service.write.spec.ts`), em CSV e em XLSX.
- Produz: os testes dos aceites 10, 21, 25 e 28, e S1-7 (aceite 24) e R4 do Conselho S.

**Contexto vinculado:**
- Aceite 10: "O arquivo de pessoas exportado pelo ADMIN, com data de referência hoje, enviado de volta na importação, dá 'Sem alteração' em todas as linhas com matrícula ou telefone (inclusive pessoa inativa, pessoa com setor inativo e nome que começa por `=`)." DX17 do Lote D: "a volta só se prova no Lote E, que deve ter um teste com um arquivo gerado pela T8b."
- Aceite 28: "Arquivo exportado por quem não vê telefone completo, reimportado, não grava nome nem telefone mascarado." (Exportação por gestor sem `telefone.ver_completo`; importação pelo ADMIN do mesmo arquivo.)
- Aceite 21: "Confirmar duas vezes o mesmo lote não grava duas vezes." Aceite 25: "Gravação interrompida no meio é continuada sem gravar duas vezes a mesma linha."
- EX9 (reserva vencida: avançar o relógio 5 min + 1 s), EX13.

**Passos:**
1. [ ] RED: `it('aceite 10: exportação do ADMIN reimportada dá Sem alteração em todas as linhas')` (CSV e XLSX; base com pessoa inativa, setor inativo, nome `=SOMA(1;2)`, autorização "Cadastro anterior", pessoa com login; `counts.UNCHANGED` = linhas com matrícula ou telefone; nenhuma Inválida); `it('aceite 28: exportação mascarada reimportada não grava nome nem telefone mascarado')` (confirma e grava; banco igual ao de antes; nenhuma trilha de pessoa nova); `it('aceite 21: duas confirmações simultâneas gravam uma vez')` (`Promise.all` de duas confirmações e de dois laços de bloco; cada pessoa criada uma vez; uma trilha `confirmed` e uma `completed`); `it('aceite 25: gravação interrompida e continuada não grava duas vezes')` (reserva uma linha e "morre"; relógio + 5 min; novo bloco termina; pessoas sem duplicata; a linha repetida dá Sem alteração); R4 `it('aceite 25 sem telefone.ver_completo e sem matrícula: retomada depois de criar dá Sem alteração')` (gestor sem a chave, linhas sem matrícula; reserva uma linha e chama o `RowWriter` real, que cria a pessoa, sem `finalizeRow`; relógio + 5 min + 1 s; novo bloco → a linha `UNCHANGED` com o `personId` da reserva, uma pessoa só, nenhum `FAILED`); S1-7 `it('S1-7 (aceite 24): sem a chave, dois envios que diferem só por o número existir dão prévias iguais')` (gestor sem a chave envia o mesmo CSV antes e depois de o ADMIN cadastrar uma pessoa com um dos números → `counts`, `phoneCheckDeferred` e a página 1 de `rows` iguais, `toStrictEqual`, sem `id`/datas do lote).
2. [ ] GREEN (só testes).
3. [ ] Validação: `TESTCONTAINERS_ENABLED=1 timeout 600 gate --test src/modules/people-import/people-import.e2e-roundtrip.integration.spec.ts`; typecheck; `--changed`.

**Aceite:** spec aceites 10, 21, 25 e 28 de ponta a ponta, com o escritor real do Lote D.

**Risco: alto** (só testes; cobre os casos que mordem o usuário, Review Focus 1 e 3).

## Task 23 — Catálogo no front: chave e rótulos da Trilha (front)

**Arquivos:**
- Modificar: `frontend/src/features/permissions/keys.ts` (`PERMISSION_KEYS`, `PERMISSION_LABELS`; `DEFAULT_MATRIX` não muda); specs em `features/permissions/` só onde contam ou listam chaves (`access.spec.ts`, `use-permission.spec.ts`, `matrix-diff.spec.ts`, `components/permissions-matrix.spec.tsx`); `frontend/src/features/audit-trail/{schemas,labels}.ts` e `labels.spec.ts`.

**Interfaces:**
- Consome: a chave da T1 e as ações/campos de CX3 (o front precisa conhecê-los antes de o back enviá-los).
- Produz: `PermissionKey` do front com `'pessoas.importar'` (T25–T28 usam); rótulos da Trilha.

**Contexto vinculado:**
- Espelho da T1: chave por último; `DEFAULT_MATRIX` igual (SUPERVISOR e OPERATOR sem a chave).
- `PERMISSION_LABELS['pessoas.importar']` = `{ name: 'Importar planilha de pessoas', description: 'Enviar planilhas CSV ou XLSX para criar e atualizar pessoas, com prévia antes de gravar. Quem não é administrador precisa também da permissão de editar pessoas e só altera pessoas sem acesso dos setores que gerencia.' }`.
- `ACTION_LABEL['people_import.confirmed'] = 'Confirmou importação de pessoas'`, `['people_import.completed'] = 'Terminou importação de pessoas'`. `FIELD_LABEL`: `fileName` 'Arquivo', `toCreate` 'A criar', `toUpdate` 'A atualizar', `created` 'Criadas', `updated` 'Atualizadas', `unchanged` 'Sem alteração', `invalid` 'Inválidas', `duplicate` 'Duplicadas', `conflict` 'Conflitos', `failed` 'Falhas', `phoneTaken` 'Falhas por telefone já cadastrado' (Conselho S), `notWritten` 'Não gravadas', `writing` 'Em gravação no encerramento', `ending` 'Fim' (`rowCount` já existe). Formatador de `ending`: COMPLETED 'Concluída', CLOSED 'Encerrada pelo administrador', AUTO_CLOSED 'Encerrada automaticamente'. Regra da tela: "valor de enum nunca aparece cru" (cabeçalho de `labels.ts`).
- GX14, GX16.

**Passos:**
1. [ ] RED `labels.spec.ts`: `it('ações e campos da importação traduzidos')` (`ending` 'AUTO_CLOSED' → 'Encerrada automaticamente').
2. [ ] RED nos specs de permissões: `it('SUPERVISOR e OPERATOR não têm pessoas.importar por padrão')`; a matriz mostra a linha "Importar planilha de pessoas" (`permissions-matrix.spec.tsx`); contagens de 9 para 10 onde houver, sem afrouxar.
3. [ ] GREEN.
4. [ ] Validação: `timeout 600 gate --test src/features/audit-trail/labels.spec.ts`; `timeout 600 gate --test` em cada spec de permissões tocado; `npx tsc -b`; `timeout 600 gate --changed --base feat/planilhas-pessoas`.

**Aceite:** spec aceites 22 (tela de Permissões) e 23 (Trilha legível).

**Risco: médio** (catálogo de exibição; quem decide o acesso é a API).

**QA visual (no Fechamento):** Permissões com "Importar planilha de pessoas" desmarcada para Supervisor e Operador; evento "Confirmou importação de pessoas" e "Terminou importação de pessoas" com os campos legíveis.

## Task 24 — API, esquemas e rótulos da importação (front)

**Arquivos:**
- Criar: `frontend/src/features/people-import/schemas.ts`, `labels.ts`, `api.ts`, `schemas.spec.ts`, `labels.spec.ts`, `api.spec.ts`.

**Interfaces:**
- Consome: `api` (`@/lib/api-client`, ky; timeout padrão 15 s); `readApiErrorBody`/`extractApiError` (`@/lib/api-error`); `saveBlob`, `filenameFromDisposition` (`@/features/people-export/download`); padrão de multipart de `features/imports/api.ts` (FormData sem `Content-Type`).
- Produz: CX13.

**Contexto vinculado:**
- CX1 e CX2 (formas das respostas e erros), inclusive os campos do Conselho S: `BatchSummary.phoneCheckDeferred: boolean` (fora do item da lista) e `ImportProgress.phoneTaken: number`. Memória do projeto: no ky 2 o corpo do erro fica em `HTTPError.data`; ler com `readApiErrorBody`.
- `confirmText`: "Botão 'Confirmar importação' mostra a contagem final ('Criar 12 e atualizar 30 pessoas')" (spec E5).
- Timeout de 120 s no envio, remapeamento, confirmação e bloco (EX34).

**Passos:**
1. [ ] RED `schemas.spec.ts`: `it('aceita o resumo, a lista e a página de linhas da API')` (resumo com `phoneCheckDeferred` e `progress.phoneTaken`); `it('recusa classificação desconhecida')`.
2. [ ] RED `labels.spec.ts`: `it('confirmText: os dois lados, um lado só e singular')`; `it('rótulos de classificação e situação')`.
3. [ ] RED `api.spec.ts`: `it('useUploadImport envia FormData sem Content-Type e timeout de 120 s')`; `it('writeBlock usa timeout de 120 s e devolve o resumo')`; `it('downloadTemplate e downloadErrors salvam com o nome do Content-Disposition')`; `it('useConfirmImport envia createNew, updateExisting e excludedRows')`.
4. [ ] GREEN. `prettier --write` só nos arquivos novos.
5. [ ] Validação: `timeout 600 gate --test` em cada spec; `npx tsc -b`; `--changed`.

**Aceite:** base das telas (E1, E5, E7).

**Risco: médio** (cliente HTTP; a API decide tudo).

## Task 25 — Passos "Arquivo" e "Colunas" (front)

**Arquivos:**
- Criar: `frontend/src/features/people-import/components/file-step.tsx`, `mapping-step.tsx`, `file-step.spec.tsx`, `mapping-step.spec.tsx`.

**Interfaces:**
- Consome: T24 (`useUploadImport`, `useRemapImport`, `useDiscardImport`, `downloadTemplate`, `FIELD_LABEL`, `IMPORT_MAX_BYTES`); `components/ui` (`button`, `input`, `select`, `table`, `alert`, `alert-dialog`, `label`); `sonner`.
- Produz: `FileStep(props: { onUploaded(summary: BatchSummary): void })`; `MappingStep(props: { batch: BatchSummary; onReady(summary: BatchSummary): void; onDiscarded(): void })`.

**Contexto vinculado:**
- Spec E1: "1. Arquivo. Baixar o modelo (CSV ou XLSX) e enviar a planilha preenchida. 2. Colunas. O sistema mostra as colunas do arquivo e sugere a qual campo cada uma corresponde; a pessoa confere e ajusta." Spec E3: "Cada campo recebe no máximo uma coluna; coluna sem campo fica como 'Não usar'. Para seguir, precisam estar mapeados Nome e pelo menos um entre Telefone e Matrícula." "Mudar o mapeamento refaz a prévia."
- Textos fixos: botões "Baixar modelo CSV", "Baixar modelo XLSX", "Enviar planilha", "Ver prévia", "Descartar lote"; rótulo "Planilha (.csv ou .xlsx, até 5 MB)"; opção "Não usar"; colunas da tabela "Coluna do arquivo" e "Campo"; arquivo grande no navegador: "O arquivo passa de 5 MB. Divida a planilha e envie em partes."; erro sem texto da API: "Não foi possível enviar a planilha. Tente de novo."
- Erro da API por `toast.error` com o texto da API (padrão do Lote D, M2). `mappingProblem` do resumo aparece num `Alert` e desabilita "Ver prévia"; a tela confere localmente as mesmas regras de `mappingProblem` (CX6) para desabilitar antes de enviar. "Ver prévia" chama `useRemapImport` só se o mapeamento mudou; senão segue. "Descartar lote" pede confirmação (`alert-dialog`).

**Passos:**
1. [ ] RED `file-step.spec.tsx`: `it('baixar modelo CSV e XLSX')`; `it('arquivo acima de 5 MB avisa sem enviar')`; `it('envio com erro mostra o texto da API')`; `it('envio com sucesso chama onUploaded')`.
2. [ ] RED `mapping-step.spec.tsx`: `it('mostra as colunas com o campo sugerido e Não usar')`; `it('campo já usado fica indisponível nas outras colunas')`; `it('aceite 13: Ver prévia envia o mapeamento quando mudou')`; `it('mapeamento incompleto mostra o aviso e desabilita Ver prévia')`; `it('Descartar lote pede confirmação')`.
3. [ ] GREEN. `prettier --write` só nos arquivos novos.
4. [ ] Validação: `timeout 600 gate --test` em cada spec; `npx tsc -b`; `--changed`.

**Aceite:** spec aceites 12 e 13 na tela; E1 passos 1 e 2.

**Risco: médio** (tela; a API valida tudo de novo).

**QA visual (no Fechamento):** passo 1 com os dois botões de modelo e o envio; passo 2 com `celular` sugerido como Telefone e `cargo` como Função; aviso de mapeamento incompleto.

## Task 26 — Passo "Prévia" com seleção e confirmação (front)

**Arquivos:**
- Criar: `frontend/src/features/people-import/components/preview-step.tsx`, `preview-table.tsx`, `confirm-dialog.tsx`, `preview-step.spec.tsx`, `preview-table.spec.tsx`, `confirm-dialog.spec.tsx`.

**Interfaces:**
- Consome: T24 (`useImportRows`, `useConfirmImport`, `ROW_CLASS_LABEL`, `confirmText`); `components/ui` (`badge`, `table`, `checkbox`, `button`, `alert-dialog`, `alert`).
- Produz: `PreviewStep(props: { batch: BatchSummary; onConfirmed(summary: BatchSummary): void; onBack(): void })`.

**Contexto vinculado:**
- Spec E5: "Cada linha recebe uma classificação: Criar, Atualizar, Sem alteração, Inválida, Duplicada, Conflito, Ignorada. A prévia mostra: número da linha no arquivo, classificação, nome, matrícula, setor, e — em 'Atualizar' — o que muda, campo a campo (antes → depois). Motivos e avisos por extenso. Contadores por classificação no topo; filtro por classificação; paginada (50 por página)." "Escolha do conjunto: 'Criar pessoas novas (n)' e 'Atualizar pessoas existentes (n)', os dois marcados por padrão; e uma caixa por linha para tirar linhas individuais. Linhas inválidas, duplicadas, em conflito, sem alteração e ignoradas não têm caixa." "Botão 'Confirmar importação' mostra a contagem final ('Criar 12 e atualizar 30 pessoas') e pede confirmação."
- A seleção vive no cliente: conjunto de linhas tiradas (número e classe), para contar `n` e enviar `excludedRows` (EX7). Desmarcar "Criar pessoas novas" desabilita as caixas das linhas Criar. Contagens finais = `counts.CREATE` − tiradas Criar (se marcado) e idem Atualizar.
- 409 `already_confirmed` na confirmação → `onConfirmed` com o resumo relido (duas abas: a segunda vai para o andamento).
- Conselho S (EX17.3): com `batch.phoneCheckDeferred === true`, o topo da prévia mostra um `Alert` com o texto fixo "A conferência de telefones já cadastrados é feita ao gravar."; com `false`, nada. O texto é só da tela (não vem da API).
- Textos fixos: "Todas" (filtro), "Linha", "Classificação", "Nome", "Matrícula", "Setor", "O que acontece", "Anterior", "Próxima", "Página X de Y", "Voltar às colunas", "Confirmar importação"; diálogo: título "Confirmar importação", corpo `confirmText(...)` + "Depois de confirmar, a gravação começa e não dá para desfazer pela planilha.", botões "Confirmar" e "Cancelar".

**Passos:**
1. [ ] RED `preview-table.spec.tsx`: `it('Atualizar mostra antes → depois; motivos e avisos por extenso')`; `it('caixas só em Criar e Atualizar')`.
2. [ ] RED `preview-step.spec.tsx`: `it('contadores e filtro por classificação')`; `it('paginação de 50')`; `it('marcadores gerais e caixas por linha mudam as contagens')`; `it('409 já confirmado leva ao andamento')`; S1-6 `it('S1-6: aviso fixo da conferência de telefones só com phoneCheckDeferred')` (texto exato presente com `true`, ausente com `false`).
3. [ ] RED `confirm-dialog.spec.tsx`: `it('mostra Criar 12 e atualizar 30 pessoas e envia a seleção')`.
4. [ ] GREEN. `prettier --write` só nos arquivos novos.
5. [ ] Validação: `timeout 600 gate --test` em cada spec; `npx tsc -b`; `--changed`.

**Aceite:** spec aceites 11, 14 e 15 na tela (prévia com motivo, antes e depois, aviso); E5.

**Risco: médio** (tela; o servidor confirma uma vez e decide o que entra).

**QA visual (no Fechamento):** contadores e filtro; linha Atualizar com antes → depois; linha Inválida com motivo; aviso de autorização ignorada; diálogo com "Criar n e atualizar m pessoas".

## Task 27 — Gravação na tela e resultado (front)

**Arquivos:**
- Criar: `frontend/src/features/people-import/use-write-loop.ts`, `components/writing-step.tsx`, `components/result-step.tsx` e specs (`use-write-loop.spec.ts`, `writing-step.spec.tsx`, `result-step.spec.tsx`).

**Interfaces:**
- Consome: T24 (`writeBlock`, `useImportBatch`, `useCloseImport`, `downloadErrors`, `SITUATION_LABEL`); `readApiErrorBody`; `HTTPError`/`TimeoutError` do ky; `components/ui` (`alert`, `button`, `alert-dialog`, `card`).
- Produz: `useWriteLoop(batch: BatchSummary): { running: boolean; summary: BatchSummary; error: string | null; start(): void }`; `WritingStep(props: { batch: BatchSummary; isAdmin: boolean })`; `ResultStep(props: { batch: BatchSummary })`.

**Contexto vinculado:**
- Spec E6: "a tela pede um bloco, a API … devolve o andamento ('Gravando 120 de 300'); a tela pede o próximo até acabar." "Se a página for fechada no meio, o lote fica 'Gravação interrompida' e quem confirmou continua pelo botão 'Continuar gravação'. O ADMIN pode 'Encerrar gravação' de qualquer lote." "A tela espera até 120 segundos por bloco. Tempo esgotado ou erro de rede não marca falha: a tela consulta o andamento e pede de novo; linha reservada aparece como 'Gravando'. Se o ator perdeu `pessoas.importar` ou `pessoas.editar`, o bloco responde 403 e o lote fica 'Gravação interrompida', com o aviso de permissão."
- Spec E1, passo 4: "Quantas foram criadas, atualizadas e quantas falharam; botão para baixar o relatório de erros."
- EX34 (laço: até 120 s por bloco; tempo esgotado ou rede → consulta o resumo e pede de novo depois de 5 s; só reservadas por outro pedido → 5 s; **429 → espera o `Retry-After` em segundos, ou 10 s se ausente ou ilegível, e pede de novo, sem mostrar erro** (revisão 1, M7); 403 para com o texto da API; 409 `not_writing` recarrega). O laço começa sozinho depois da confirmação; ao abrir um lote `INTERRUPTED`/`WRITING` de quem confirmou, mostra "Continuar gravação" (não começa sozinho, para duas abas não disputarem sem querer).
- Textos fixos: "Gravando X de Y" (X = criadas + atualizadas + sem alteração + falhas + não gravadas; Y = `toWrite`), "Gravação interrompida", "Continuar gravação", "Encerrar gravação" (diálogo: "As linhas que ainda não foram gravadas ficarão como 'Não gravada: gravação encerrada'."), "Criadas", "Atualizadas", "Sem alteração", "Não entraram", "Baixar relatório de erros"; com `progress.phoneTaken > 0`, "Falhas por telefone já cadastrado: n" (Conselho S: só o número).

**Passos:**
1. [ ] RED `use-write-loop.spec.ts` (timers falsos): `it('pede blocos até acabar')`; `it('tempo esgotado ou rede: consulta o andamento e pede de novo')`; `it('só reservadas por outro pedido: espera 5 s')`; `it('429: espera o Retry-After (ou 10 s) e pede de novo, sem erro na tela')`; `it('403: para com Gravação interrompida e o texto da API')`; `it('409 not_writing: recarrega o resumo e para')`.
2. [ ] RED `writing-step.spec.tsx`: `it('mostra Gravando X de Y')`; `it('Continuar gravação só para quem confirmou; Encerrar gravação só para ADMIN, com confirmação')`. RED `result-step.spec.tsx`: `it('contagens e Baixar relatório de erros quando há erros')`; `it('falhas por telefone já cadastrado só quando phoneTaken > 0')`.
3. [ ] GREEN. `prettier --write` só nos arquivos novos.
4. [ ] Validação: `timeout 600 gate --test` em cada spec; `npx tsc -b`; `--changed`.

**Aceite:** spec aceites 20, 21 e 25 na tela; E1 passo 4; E6 (tela).

**Risco: alto** (laço de repetição com erros de rede; repetir errado sobrecarrega o servidor ou mostra estado falso).

**QA visual (no Fechamento):** "Gravando X de Y" avançando; fechar a aba no meio e reabrir: "Gravação interrompida" com "Continuar gravação"; ADMIN vê "Encerrar gravação"; resultado com o botão do relatório.

## Task 28 — Página, lista de lotes, menu, botão em Usuários e Novidades (front)

**Arquivos:**
- Criar: `frontend/src/routes/_authenticated/importar-pessoas/index.tsx` e `index.spec.tsx`; `frontend/src/features/people-import/components/import-page.tsx`, `steps-header.tsx`, `batch-list.tsx` e specs.
- Modificar: `frontend/src/lib/nav.ts` (item no `NAV`, seção `admin`) e o spec de nav existente (`describe` novo); `frontend/src/routes/_authenticated/users/index.tsx` (`UsersHeader`: link "Importar planilha") e `users/index.spec.tsx` (`describe` novo); `frontend/src/release-notes.ts` (entrada no topo); `frontend/src/routeTree.gen.ts` (gerado pelo plugin do TanStack Router no Vite, conferido pelo revisor: sai ao rodar o dev server ou o build/teste que carrega o plugin; **não usar `npx tsr generate`**; nunca editar à mão).

**Interfaces:**
- Consome: T23 (`'pessoas.importar'`), T24, T25, T26, T27; `hasPermission` + `useAuthStore` (molde de `routes/_authenticated/turnos/index.tsx`, `beforeLoad` com `redirect({ to: '/dashboard' })`); `usePermission`; `NavItem` (`lib/nav.ts`: `{ to, label, icon, section, roles, permission? }`).
- Produz: a rota `/importar-pessoas` e os pontos de entrada da spec E8.

**Contexto vinculado:**
- Spec E8: "Rota 'Importar pessoas' no menu Administração, para quem tem `pessoas.importar`; botão 'Importar planilha' no cabeçalho de Usuários. Os quatro passos de E1. Novidades: uma entrada explicando a importação."
- Spec E1: "Quatro passos, numa página só ('Importar pessoas') … Abaixo dos passos, a lista dos lotes já enviados (arquivo, autor, data, situação, contagens, relatório)."
- Aceite 22: "Sem `pessoas.importar`, … a tela não aparece."
- EX27 (rota, `?lote=<id>`); passo mostrado pela situação do lote: sem lote → Arquivo; `PREVIEW` com `mappingProblem` ou recém-enviado → Colunas; `PREVIEW` pronto → Prévia; `WRITING`/`INTERRUPTED` → Gravação; `COMPLETED`/`CLOSED` → Resultado. `StepsHeader`: "1. Arquivo", "2. Colunas", "3. Prévia", "4. Resultado", passo atual em destaque (`badge`), sem componente de passos novo (spec: usar `components/ui`).
- Lista (`BatchList`): colunas "Arquivo", "Enviado por", "Data", "Situação", "Criadas", "Atualizadas", "Não entraram", ações "Abrir", "Relatório", "Continuar" (`canContinue`), "Encerrar" (`canClose`), "Descartar" (`canDiscard`); paginada (20).
- Item do menu: `{ to: '/importar-pessoas', label: 'Importar pessoas', icon: Upload (lucide), section: 'admin', roles: WRITE_INTERNAL_ROLES, permission: 'pessoas.importar' }` (`WRITE_INTERNAL_ROLES` em `frontend/src/lib/nav.ts:39`, conferido pelo revisor: os papéis que podem receber a chave).
- Lote apagado (EX14: descarte, ou prévia com mais de 7 dias): `?lote=<id>` que responde 404 → tira o `lote` da URL e mostra o passo Arquivo, com o texto da API ("Lote não encontrado.") num `toast`; depois de "Descartar lote", a página volta ao passo Arquivo sem `?lote`. A tela de Usuários é só do ADMIN; o botão aparece com `usePermission('pessoas.importar')`.
- Novidades (`frontend/CLAUDE.md`; EX29, versão `2026.11.19.4` se hoje): título "Importar pessoas por planilha"; itens: (1) "Em Administração > Importar pessoas, baixe o modelo, envie a planilha (CSV ou XLSX, até 5.000 linhas) e confira as colunas." (`where: '/importar-pessoas'`); (2) "A prévia mostra o que cada linha vai fazer (criar, atualizar, sem alteração ou por que não entra) e você escolhe o que gravar. Nada é gravado antes de confirmar."; (3) "As linhas que não entraram saem num relatório para baixar. Cada importação fica registrada na Trilha de alterações, no tipo Planilhas; o administrador libera a importação para Supervisor e Operador em Permissões."
- GX14: arquivos existentes sem `prettier --write`; specs existentes isolam o componente novo com `vi.mock` se quebrarem, sem mexer em asserção existente.

**Passos:**
1. [ ] RED `importar-pessoas/index.spec.tsx`: `it('rota só para quem tem pessoas.importar')` (OPERATOR com a chave entra; SUPERVISOR sem a chave → `redirect`).
2. [ ] RED `import-page.spec.tsx`: `it('passos conforme a situação do lote da URL')`; `it('lote da URL descartado ou apagado: volta ao passo Arquivo sem o lote na URL')`; RED `batch-list.spec.tsx`: `it('lista dos lotes com arquivo, autor, data, situação e contagens')`; `it('ações conforme canContinue, canClose e canDiscard')`; RED `steps-header.spec.tsx`: `it('destaca o passo atual')`.
3. [ ] RED nav: `it('menu Administração mostra Importar pessoas só com a chave')`; RED `users/index.spec.tsx`: `it('Importar planilha aparece para quem tem pessoas.importar')`.
4. [ ] GREEN; `routeTree.gen.ts` regenerado pelo plugin do Vite (nada de `npx tsr generate`; conferir no diff só a rota nova); nota de versão.
5. [ ] Validação: `timeout 600 gate --test` em cada spec tocado (um por chamada) e `src/release-notes.spec.ts`; `npx tsc -b`; `--changed`.

**Aceite:** spec aceite 22 (tela), E1 (página e lista), E8.

**Risco: médio** (rota com `beforeLoad`; a API recusa sem a chave de qualquer forma).

**QA visual (no Fechamento):** menu Administração com "Importar pessoas" para o ADMIN e ausente para Supervisor sem a chave; botão "Importar planilha" em Usuários; os quatro passos com o atual destacado; lista de lotes; Novidades.

## Fechamento (principal)

1. Conferir o ledger: as 32 tasks aceitas; revisões com `opus` feitas: as 15 críticas T1, T7, T8, T10, T11b, T13a, T13b, T15, T16, T17, T18, T19, T20a, T20b, T21, e as altas T2 e T11a (decisão da coordenação), igual à seção Ordem; os testes do Conselho S e da retomada (tabela depois de EX17: S1-1…S1-7, S2-1…S2-6, R1–R4) presentes e verdes nas tasks donas.
2. Gates completos, **um de cada vez**, nada mais rodando na máquina (memória: gate completo e stack juntos derrubaram a máquina): back e depois front, no estado final, comparados com os do fim do Lote D (Estado do plano do Lote D: back LINT 7517/733, SONAR 92, COMPLEXIDADE 723, TESTES sem falha, COVERAGE 94.4/85.8; front LINT 105/4, SONAR 18, COMPLEXIDADE 228, COVERAGE 87.4/81.3; memória: completo com `--base origin/main` e dívida legada conhecida). Bloquear violação nova ou agravada (por arquivo e ancorado); conferir a cobertura das linhas novas e o `max-lines-per-function` 50 dos specs novos.
3. Migrações no banco local de QA (stack `orgamind-turnos-qa`, seed fictício): antes, `count(*)` de `RolePermission` e de `AuditEvent`; `prisma migrate deploy`; depois, `RolePermission` +2 linhas (`pessoas.importar`, `granted=false`, SUPERVISOR e OPERATOR), nenhuma antiga alterada; tabelas `PeopleImportBatch` e `PeopleImportRow` vazias; `AuditEvent` inalterado.
4. Boot real da API e do worker (o worker não carrega o módulo; só confirmar que sobe).
5. Fumaça HTTP (pasta de evidências do lote; telefones e nomes fictícios):
   - Sem a chave: as onze rotas → 403 com "Você não tem permissão para importar planilhas de pessoas." (aceite 22).
   - ADMIN: modelo CSV (`od -c | head`: `EF BB BF`, `;`, `\r\n`, cabeçalhos do modelo, linha `EXEMPLO`) e XLSX (`unzip -p … xl/workbook.xml` com "Pessoas" e "Instruções") (aceite 12).
   - T02 (aceite 11): CSV com uma válida, uma duplicada e uma inválida → prévia com os três motivos; confirmar só a válida; relatório com as outras duas.
   - CSV salvo em Windows-1252 com acentos e `,` (gerar com `iconv -t WINDOWS-1252`) → nomes certos na prévia (aceite 19). Cabeçalhos `celular` e `cargo` reconhecidos; remapear refaz a prévia (aceite 13).
   - Atualizar por matrícula: antes → depois na prévia; depois, ficha, Histórico da pessoa e histórico de vínculo com "Importação de planilha: <arquivo>" (aceite 14). "Sim" sem origem → aviso, sem autorização; "Sim" com origem → autorizado (aceite 15). Setor inexistente e inativo → motivo com o nome (aceite 18). Matrícula de um e telefone de outro → Conflito (aceite 17).
   - Reimportar a mesma planilha → Sem alteração, ninguém criado (aceite 16). Exportar (Lote D) pessoas como ADMIN com data de hoje e reimportar → Sem alteração em tudo (aceite 10); exportar como gestor sem `telefone.ver_completo` e reimportar como ADMIN → nada gravado (aceite 28).
   - Mudar uma pessoa pela ficha entre a prévia e a confirmação → a linha falha e as outras entram (aceite 20). Confirmar duas vezes (dois `curl` simultâneos) → um 200 e um 409 (aceite 21). Pedir um bloco, matar o `curl` no meio, esperar 5 min e pedir de novo → sem duplicata (aceite 25).
   - `GET /audit-trail` filtrado em Planilhas: `people_import.confirmed` e `people_import.completed` com arquivo e contagens (aceite 23). Supervisor com as duas chaves liberadas: pessoa com login e de setor alheio → "Você não pode alterar esta pessoa." igual com palpite certo e errado; lote do ADMIN → 404 (aceites 24 e 27). Supervisor sem `telefone.ver_completo` (Conselho S): o mesmo CSV enviado antes e depois de cadastrar uma pessoa com um dos números → prévias iguais e o aviso "A conferência de telefones já cadastrados é feita ao gravar."; gravar → a linha falha com "O telefone já pertence a outra pessoa cadastrada", sai no relatório, e `people_import.completed` traz `phoneTaken` 1 (aceite 24).
   - SQL depois de confirmar e gravar: nenhuma linha com coluna não mapeada; linhas gravadas com `cells IS NULL` (aceite 26).
   - **Tempo de um bloco:** planilha de 300 pessoas novas; medir com `curl -w '%{time_total}'` três blocos seguidos (50 linhas cada) e registrar a média e o pico de memória do container da API (`docker stats --no-stream`). Se um bloco de 50 passar de 10 s, o bloco corta antes (EX10) — registrar quantas linhas couberam.
   - **Tempo e memória do envio** (revisão 1, M12): com `docker stats` do container da API rodando em paralelo (amostra por segundo, gravada em arquivo), enviar (a) um CSV de 5.000 linhas válidas e (b) um XLSX de ~5 MB; registrar o `time_total` de cada `curl` e o pico de memória da API em cada um. Pico perto do limite do container, ou envio acima de 60 s, vai para as pendências com o número medido (o servidor tem 8 GB sem swap e build exige ≥ 2,5 GB livres).
   - Nome de arquivo acentuado (EX4, M6): enviar `Relatório São João.csv` → `fileName` igual no resumo e na lista.
   - Descarte (EX14): descartar um lote em prévia → `GET batches/:id` 404 e a tela volta ao passo Arquivo.
6. QA visual (agente `qa`, Playwright): os critérios de T23, T25, T26, T27 e T28.
7. Revisão final do conjunto com `opus`.
8. Atualizar a seção "Estado" deste plano (feito, validação, pendências, próximo).
9. Registrar na spec, em "Para a GBR confirmar" → "Decisões tomadas na implementação do Lote E", as decisões novas que mudam o que a GBR vê: EX4 (texto do 5 MB), EX11 (interrompida depois de 3 min sem bloco), EX12 (alteração da pessoa medida pelos campos importados), EX13 (autor do encerramento automático), EX14 (descartar apaga o lote e não deixa registro — **a GBR confirma**: a spec E2 falava em limpar as colunas ao descartar, pressupondo o lote guardado), EX16 (setor alheio e inexistente com o mesmo texto), EX17 (telefone de quem não vê completo: EX17.1; EX17.2 e EX17.3 já estão na spec como "conselho S, provisório até a GBR confirmar"; registrar EX17.4 — reimportar sem matrícula e sem a chave falha `phoneTaken` em vez de "Sem alteração", já na spec E6), EX18 (Outro sem detalhe), EX19 (trava que mudou faz a linha falhar, inclusive setor de destino fora do alcance de agora), EX20 (alteração simultânea por outro ADMIN vira "Não foi possível gravar esta linha."), EX25 (só quem enviou confirma), EX28 (10 envios por minuto), EX32 (coluna Setor obrigatória para quem não é ADMIN), EX3 (XLSX que fica acima de 60 MB ao abrir é recusado).
10. Commits do lote, push e PR rascunho sobre `feat/planilhas-pessoas` (PR 16), conforme a autorização vigente do plano GBR (memória: commit e PR rascunho liberados; merge e deploy só com pedido explícito). **Deploy não faz parte.**

## Não verificado (conferir na task dona)

- Comportamento do `exceljs` com rich text e hyperlink na leitura (T4 testa os casos de EX3).

## Já verificado (na escrita do plano e na revisão 1; não repetir)

- Máscara: `•••• NNNN` (4 últimos dígitos) e `••••` sozinho (`shared/audit/audit-change.ts:76-80`; revisor). `users.service.spec.ts` e outros `users.service.*.spec.ts` existem (revisor). `Shift` e `StaffLevel` têm `name @unique` e `isActive`; `Sector.name` e `Sector.code` são únicos e não nulos (revisor). Menu: `WRITE_INTERNAL_ROLES` em `frontend/src/lib/nav.ts:39` (revisor). `routeTree.gen.ts` é gerado pelo plugin do Vite; não usar `npx tsr generate` (revisor). Não existe `app.module.spec.ts` (revisor).
- Tela do setor: `sector-people-write.service.ts:222-229` recusa `permissionDenied('telefone.ver_completo')` quando o patch traz telefone, a pessoa já tem telefone e o ator não vê completo — "vale até para o mesmo valor" (DB8); pessoa sem telefone pode receber um (base de EX17.1 e da opção S2-a).
- `UsersRepository` lança `new Error('USER_NOT_FOUND')` quando a pessoa some dentro da transação (`users.repository.ts:303` e `:343`); `user.concurrent_admin_change` sai de `users.service.ts` ~L779 (EX20).
- `UserPatch` (`users.service.ts` L60) e `PersonWithoutAccessInput` (L93: `sectorId: string | null` obrigatório; `levelId`, `jobTitle`, `shiftId` opcionais e anuláveis) são tipos privados do arquivo (T14 exporta).

- `createPersonWithoutAccess(actorId, input)` grava `reason: null` em `createWithTrail` (4 parâmetros: `data`, `action`, `actorId`, `values`); `updateUser(id, input, actorId, meta = { reason: null })` grava `meta.reason` na trilha e passa setor, turno e nível só por `assignment` (`writeAssignment`, origem CHANGE), dentro de `runSerializable` (`users.service.ts` ~L384-636; `users.repository.ts` ~L330-360).
- EX17.4 (na aplicação do Conselho S): `User.id` é `String @id @default(cuid())` (`schema.prisma:72`); `personWithoutAccessData` monta `Prisma.UserCreateInput` (`users.service.ts:200-218`); `createWithAudit` passa `data` a `tx.user.create` (`users.repository.ts:199-224`) e `refuseAssignmentInData` (L112-117) só recusa chaves de vínculo; `createPersonWithoutAccess` chama `phones.assertAvailable` (L467) antes de criar; `z.string().cuid()` valida id de usuário em `whatsapp-instances/dto/create-instance.dto.ts:7` e `update-instance.dto.ts:6`.
- `UserAssignment` não tem campo de motivo (`schema.prisma` ~L1680); `User` tem `lastLoginAt` e `sessionVersion` (por isso EX12).
- `PERMISSION_KEYS` termina em `pessoas.exportar`; `DEFAULT_MATRIX` já é lista explícita; migração do Lote D em `20261119120000_people_export_permission` (só `INSERT … ON CONFLICT DO NOTHING`).
- `route-parity.spec.ts` já tem `CLASS_KEY_CONTROLLERS` com o controller de exportação e o `describe('controllers com a chave na classe (Etapa 2)')` com os três testes (L278-385).
- `canEditContactAuthorization(actor, person)`: pessoa com login só ADMIN; sem login, `pessoas.editar`. `TeamActor` traz `managedSectorIds` e `permissions`. `normalizeRegistration` exportado em `users/person-record.ts`; `normalizeJobTitle` privado em `users.service.ts` (T14 exporta). `UsersModule` exporta `UsersService` e `UsersRepository`.
- `contactAuthorizationInputSchema`: `{ status: 'NAO_AUTORIZADO' } | { status: 'AUTORIZADO', source (sem CADASTRO_ANTERIOR), note?, date? }`.
- A importação de contatos usa `FileInterceptor` com `limits.fileSize` 10 MB e confere de novo no controller; não há leitor de CSV no backend.
- Novidades: a mais recente é `2026.11.19.3`. A rota `/turnos` é o molde de `beforeLoad` por chave.
