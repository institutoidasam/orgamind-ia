# OrgaMind, Etapa 1 GBR, Lote C: vínculo com vigência (CAD-02, parcial). Implementation Plan

> **Para os agentes:** executar pela skill `sdd` (TDD, ledger em `.superpowers/sdd/2026-11-19-orgamind-gbr-etapa1-lote-c-vinculo/progress.md`). **Sem commit/push**: nenhuma task commita; a principal integra e commita o lote. Branch `feat/vinculo-vigencia`, criado a partir de `feat/permissoes-por-acao` (Lote B). Fechamento de task por `gate --changed --base feat/permissoes-por-acao`. Nos módulos `users/`, `staff-schedule/`, `team-whatsapp/` e `audit-trail/` este plano cita arquivo e símbolo, nunca linha (as linhas dos mapas são do estado do Lote B e podem variar).

**Goal:** cada pessoa passa a ter um histórico de vínculo (setor, turno e nível, com início e fim como datas civis). Trocar o vínculo vale a partir de hoje e não reescreve o passado: o quadro da escala de datas passadas e a lista do dia do envio de datas passadas usam o vínculo vigente na data; hoje e o futuro usam o vínculo aberto, que é o mesmo valor do espelho `User.sectorId/shiftId/levelId`. Toda gravação de vínculo passa por uma única função, na mesma transação da trilha. A ficha ganha a seção "Vínculos".

**Architecture:** tabela nova `UserAssignment` (uma linha aberta por pessoa, garantida por índice único parcial) com backfill na migração. Regras puras de vigência em `backend/src/modules/users/assignment-timeline.ts` (planejar a troca, achar o vínculo na data). Uma única função de escrita, `writeAssignment(tx, …)` em `backend/src/modules/users/assignment-writer.ts`, chamada só por `UsersRepository.createWithAudit` e `UsersRepository.updateWithLastAdminGuard` dentro da transação delas; a trilha continua sendo o evento da pessoa gravado no mesmo `tx`, com o retrato lido depois da função. Leituras com data: o quadro (`staff-schedule`) e a lista do dia (`team-whatsapp`) só consultam o histórico quando a data é anterior a hoje; para hoje e o futuro o caminho fica idêntico ao atual. A ficha lê `GET /audit-trail/people/:userId/assignments` (mesma regra de acesso do Histórico).

**Tech Stack:** NestJS + Prisma 6 + Zod v4 (`createZodDto`, `nestjs-zod`) + Vitest/testcontainers no back; React + TanStack Router/Query + ky 2 + Radix + Vitest/Testing Library no front.

**Spec:** `docs/superpowers/specs/2026-11-19-orgamind-gbr-etapa1-cadastro-permissoes.md` (seção "Lote C — Vínculo com vigência", aceites 17 a 21 e "Geral"). Sentença do conselho: `~/.claude/tribunais/2026-11-19/conselho-R/sentenca-R.md` (R3 e R4). Mapas em `.superpowers/sdd/2026-11-19-orgamind-gbr-etapa1-lote-c-vinculo/` (`mapa-back-escritas.md`, `mapa-back-leituras-por-data.md`, `mapa-front-ficha.md`).

## Preparação (principal, antes da T1)

1. Conferir que o Lote B está commitado em `feat/permissoes-por-acao` (o despacho da revisão 1 confirma que está; reconferir antes de criar o branch). Se não estiver, parar e pedir ao usuário: o `--changed` contra `feat/permissoes-por-acao` mediria o Lote B junto.
2. Criar `feat/vinculo-vigencia` a partir de `feat/permissoes-por-acao`.
3. Copiar `.superpowers/sdd/2026-11-19-orgamind-gbr-etapa1-lote-b-permissoes/implementer-rules.md` e `reviewer-rules.md` para `.superpowers/sdd/2026-11-19-orgamind-gbr-etapa1-lote-c-vinculo/`, adaptando só o cabeçalho "Comuns a este plano": branch `feat/vinculo-vigencia`; base do `--changed` `feat/permissoes-por-acao`; plano e ledger deste lote; "dentro do Lote C as referências `DVn`, `GVn` e `CVn` do brief estão anexadas no fim dele"; o Lote B está commitado em `feat/permissoes-por-acao` e o Lote C fica no working tree sobre ele; manter as "Lições do Lote A" e acrescentar a de typecheck com `--tsBuildInfoFile /tmp/<task>.tsbuildinfo`.

## Ordem e paralelismo

```
Back:  T1 ─┐
       T2 ─┴─┬─> T3 ─> T4a ─> T4b
             ├─> T5
             ├─> T6
             └─> T7
Front: T8 (pode começar junto com a T1; contrato CV6 fixado aqui)
       T9 (por último)
```

- **Paralelos (ownership disjunto):**
  - T1 ∥ T2 ∥ T8. T1: `schema.prisma`, a pasta da migração e o spec de migração. T2: só `users/assignment-timeline.ts` e spec. T8: só `frontend/src/features/audit-trail/`.
  - Depois da T1 e da T2: T3 ∥ T5 ∥ T6 ∥ T7. T3: `users/assignment-writer.ts`, `users.repository.ts` e specs do repositório. T5: `staff-schedule/` (`board.ts`, `staff-schedule.service.ts`, `staff-schedule.repository.ts` e specs). T6: `team-whatsapp/team-whatsapp.repository.ts`, arquivo novo `team-whatsapp/team-member-assignment.ts` e specs, mais um `describe` novo em `team-whatsapp/team-whatsapp.roster.spec.ts`. T7: contrato novo `person-assignments.schema.ts` e `audit-trail/` (controller, service, repository e specs), mais a linha da rota em `NEW_ROUTES` de `permissions/route-parity.spec.ts`.
  - T4b roda em paralelo com o que ainda estiver aberto de T5, T6 e T7 (só cria arquivos novos em `users/`).
- **Em série (mesmo arquivo ou assinatura consumida):**
  - T1 → T3, T5, T6, T7: usam o modelo `UserAssignment` e o client gerado (`npx prisma generate` na T1).
  - T2 → T3, T5, T6: usam os tipos e funções de CV2.
  - T3 → T4a, **imediata**: a T3 põe no repositório a recusa de `sector/sectorId/workShift/shiftId/level/levelId` em `data` (DV15); até a T4a terminar, cadastro e edição pelo serviço lançam esse erro de propósito. Não rodar fumaça nem QA entre as duas.
  - T4a → T4b: a T4b prova os cinco caminhos pelo serviço já ajustado.
  - T8 → T9.
- **Gate conjunto:** com tasks paralelas no mesmo working tree, o `gate --changed` de cada uma mede também o diff das outras. Cada implementador fecha com o seu `--changed`; falha atribuível só a arquivo de outra task em andamento é registrada no report, não corrigida. A principal roda o `--changed` conjunto depois de cada onda (T1+T2+T8; T3+T5+T6+T7; T4a; T4b).
- **Revisão** (SKILL.md do sdd, §Revisão por risco):
  - **Críticas, com revisor `opus`:** T1 (produção), T3 (produção), T4a (produção), T6 (envio em produção e dado pessoal), T7 (autorização).
  - **Alto, revisor `sonnet`:** T2, T4b, T5.
  - **Médio:** T8. **Baixo:** T9 (cabe no `mecanico`).

## Decisões deste plano (registradas para o ledger)

- **DV1. Tabela `UserAssignment`** (convenção do schema: nome do modelo = nome da tabela, sem `@@map`), colunas `id`, `userId`, `sectorId?`, `shiftId?`, `levelId?`, `validFrom DATE?`, `validTo DATE?`, `recordedById?` (sem FK, como `AuditEvent.actorId`; nulo = migração), `recordedAt`. Porquê: a spec pede setor, turno, nível, início e fim como datas civis; quem gravou e quando ficam na própria linha além da trilha. Unidade e equipe ficam fora (R3).
- **DV2. Garantias no banco:** índice único parcial `UserAssignment_userId_open_key` em `("userId") WHERE "validTo" IS NULL` (no máximo uma linha aberta por pessoa; mesmo padrão de `WhatsappInstance_provider_default_key`, migração `20260709120000_multi_provider_channel`) e `CHECK "UserAssignment_period_check"` (`validFrom IS NULL OR validTo IS NULL OR validFrom <= validTo`). **Sem** constraint de exclusão de intervalos: ela exige a extensão `btree_gist`, cujo `CREATE EXTENSION` pode não ser permitido ao usuário do banco de produção; a não sobreposição vem da função única (DV5) dentro da transação serializável (DV7) e é provada por teste. O índice parcial e o `CHECK` não são representáveis no Prisma 6: ficam só no SQL, com comentário no modelo dizendo o nome deles e que um `migrate dev` futuro não pode removê-los (o spec de migração da T1 falha se sumirem). Decisão do plano, a confirmar.
- **DV3. FKs:** `userId` → `User` com `onDelete: Cascade`; `sectorId`, `shiftId` e `levelId` com `onDelete: Restrict`. Porquê: o `SetNull` do `User.sector` apagaria o setor das linhas **fechadas** e perderia o passado; `Restrict` mantém o histórico e não custa nada ao produto, porque nenhum caminho apaga setor, turno ou nível (só inativa; conferido no mapa de escritas). Consequência aceita: apagar um setor direto no banco passa a falhar se houver histórico. Pessoa só é excluída sem histórico (A3); as linhas de vínculo **não** contam como histórico para o `409 user.has_history` (toda pessoa tem uma) e saem junto com ela. Decisão do plano, a confirmar.
- **DV4. Migração `20261119110000_user_assignment_history`:** `CREATE TABLE`, FKs, índices, `CHECK`; depois, entre os comentários `-- backfill:begin` e `-- backfill:end`, um `INSERT … SELECT` de uma linha aberta por pessoa (todas: ativas e inativas, com e sem setor, com e sem acesso), id determinístico `'ua_' || u."id"`, valores iguais aos da ficha, `validFrom` e `validTo` nulos, `recordedById` nulo, `recordedAt` = `now()`, só onde não existe linha aberta (`NOT EXISTS`) e com `ON CONFLICT ("id") DO NOTHING`; em seguida um bloco `DO $$ … $$` que conta pessoas sem linha aberta e linhas abertas com valor diferente da ficha (`IS DISTINCT FROM` nas três colunas) e faz `RAISE EXCEPTION` com as duas contagens se alguma for maior que zero (padrão de `RAISE` de `20260711120000_consent_core`). Porquê: aceite 18, reexecutável sem duplicar, sem perda de dado (só cria tabela e insere).
- **DV5. Função única de escrita = `writeAssignment(tx, input)`** em `backend/src/modules/users/assignment-writer.ts`. É o único código que grava `UserAssignment` e as colunas `User.sectorId/shiftId/levelId`. Na mesma transação: lê o espelho e a linha aberta, decide o passo pelas regras puras (CV2), grava a(s) linha(s) e o espelho. É chamada só por `UsersRepository.createWithAudit` e `UsersRepository.updateWithLastAdminGuard`, dentro do `tx` delas, **antes** da leitura do retrato "depois" que alimenta a trilha. **A trilha não muda de lugar:** continua sendo o evento da pessoa (`PersonCreateTrail`/`PersonUpdateTrail`, `personAuditChanges`, que já registra setor, turno e nível pelo nome com o id), gravado no mesmo `tx` com o retrato lido depois da função. Assim histórico, espelho e trilha ficam numa transação só, uma troca gera um evento só (como hoje) e as categorias atuais (`PERSON`; `ASSIGNMENT` para mover e tirar) não mudam. Leitura do "um caminho só" da spec: decisão do plano, a confirmar.
- **DV6. Criação abre a linha com início = hoje** (não em branco). Início em branco só existe pela migração (e pela materialização de DV8). Porquê: a troca "vale a partir de hoje" (R4) e a ficha mostra a data real de início do vínculo de quem foi cadastrado depois do Lote C.
- **DV7. "Hoje" e concorrência:** `UsersService` calcula `todayIn(new Date())` (fuso America/Manaus, `staff-schedule/civil-date.ts`) uma vez por operação e passa a data explícita ao repositório; `writeAssignment` e as regras puras recebem `today` como dado, nunca leem o relógio. Testes de serviço fixam o relógio com `vi.useFakeTimers({ toFake: ['Date'] })` + `vi.setSystemTime`; testes de integração do escritor passam `today` explícito. A edição já roda em `runSerializable` (repete em `P2034`): duas trocas simultâneas da mesma pessoa serializam e a segunda relê a linha aberta nova. `runSerializable` passa a repetir também `P2002` no índice `UserAssignment_userId_open_key` (inserção concorrente de linha aberta), tratado como conflito de serialização. A criação usa a transação padrão de `createWithAudit`: o id é novo, nenhuma outra transação toca a pessoa antes do commit.
- **DV8. Pessoa sem linha aberta** (fixture de teste criada direto pelo Prisma e pessoa criada pela versão antiga do app durante a janela do deploy; depois da migração e com o app novo, toda pessoa criada pelo serviço tem linha): na escrita, `writeAssignment` com `origin: 'CHANGE'` materializa a linha que a migração teria criado (início em branco, valores do espelho) e a fecha na véspera, só quando o passo não é `NONE`; na leitura, data sem linha que a cubra usa o espelho. Porquê: uma regra só para os dois lados, sem quebrar os specs atuais que criam pessoas com setor direto no banco e consultam datas fixas passadas.
- **DV9. Regra de leitura com data (`assignmentOn`):** data ≥ hoje → espelho (= linha aberta); data < hoje → a linha que cobre a data (início em branco = desde sempre; fim em branco = aberta); nenhuma linha cobre → espelho (DV8). Leituras sem data (permissão do gestor, listagem do setor, token, alvo pessoa do envio, `canEditPerson`, alcance do Histórico) continuam no espelho, sem mudança.
- **DV10. Quadro da escala com período que cruza a troca:** a pessoa entra no quadro do setor S se o vínculo dela (DV9) foi S em **algum** dia do período (`fromOtherSector: false`), ou, se nunca foi, se tem exceção "Outro setor" para S no período (`fromOtherSector: true`, como os visitantes de hoje); senão fica fora. Cada dia é resolvido por `resolveDay` com o setor e o turno do vínculo **daquele dia**, então os dias em que ela estava em outro setor saem como `WORK` com o `sectorId` do outro setor, que o front já mostra como "Em <setor>" (`frontend/src/features/staff-schedule/board-cells.ts`). `canEdit` e o `profileShiftId` da linha seguem o espelho (sem data). Contrato do quadro (`staff-schedule.schema.ts`) e front do quadro **não mudam**. Se `from` ≥ hoje, nenhuma consulta nova roda e o resultado é idêntico ao atual.
- **DV11. Lista do dia do envio (decisão do plano, a confirmar com a GBR; não é texto da spec):** o contrato aceita qualquer data civil (`teamRosterQuerySchema` e o alvo por setor do envio usam `civilDateSchema`, `backend/src/schemas/contracts/team-whatsapp.schema.ts`) e a tela deixa escolher data passada (`frontend/src/features/team-whatsapp/components/sector-shift-picker.tsx:132`, `type="date"` sem `min`). Para data < hoje, as linhas de pessoa ganham setor, turno e nível do vínculo da data antes do agrupamento por setor; a foto do destinatário sai desses valores. Para hoje e o futuro, nenhuma consulta nova e resultado idêntico ao atual (anti-objetivo 1).
  - **Evidência:** a spec (Lote C, "Leituras") põe a "lista do dia do envio" com data passada no vínculo da data, e a sentença R4 cita o roster com data passada; a mesma sentença cita `findMembersForDay` entre as leituras sem data, o que é contraditório, porque é a consulta do roster. A criação do envio revalida a seleção contra a lista refeita (`team-whatsapp.service.ts:527-541`), então roster e criação usam a mesma regra (`loadDayPeopleMany`); com regras diferentes, o envio com data passada recusaria a seleção. "Montagem do envio" da spec = tudo o que não recebe data (alvo pessoa, permissão, canal) e os envios de hoje e futuros.
  - **Consequência aceita:** envio novo com **data passada** para o setor A alcança quem estava em A naquela data, mesmo que hoje esteja em outro setor; o remetente vê essa pessoa na lista, com o telefone conforme `telefone.ver_completo`. Hoje e datas futuras não mudam.
  - A decisão vai para a GBR confirmar (Fechamento, passo 9).
- **DV12. Duas trocas no mesmo dia voltando ao valor original** (A→B→A) não juntam linhas: fica a linha fechada na véspera com A e a aberta de hoje com A, duas entradas na trilha. Porquê: juntar reabriria linha fechada (reescrever o histórico) por ganho só visual.
- **DV13. API "Vínculos":** `GET /audit-trail/people/:userId/assignments`, `@RequirePermission('trilha.consultar')`, mesma regra de acesso do Histórico da pessoa (`canViewPersonHistory(actor, inReach(actor, person.sectorId))`, mesmos 403 `auditTrailForbidden` e 404 `auditTrailPersonNotFound`). Sem paginação (no máximo uma linha nova por dia de troca). Mais recente primeiro: aberta primeiro, depois por fim decrescente. Porquê: vínculo é dado da ficha que o SUPERVISOR já vê pelo Histórico (categoria `ASSIGNMENT`); a regra de alcance fica num lugar só.
- **DV14. Tela:** seção "Vínculos" no topo do diálogo Histórico da pessoa (`PersonHistoryDialog`), que já abre da lista de usuários e da página do setor para quem tem a permissão. Textos: colunas "Setor", "Turno", "Nível", "De", "Até"; início em branco "Anterior ao histórico"; fim em branco "Atual"; vazio "Sem setor", "Sem turno", "Sem nível". Decisão do plano, a confirmar.
- **DV15. Prova do aceite 20 em três camadas:** (a) teste de integração dos cinco caminhos pelo serviço real (T4b); (b) recusa em tempo de execução no repositório: `createWithAudit` e `updateWithLastAdminGuard` lançam `Error('vínculo só por writeAssignment')` se `data` trouxer `sector`, `sectorId`, `workShift`, `shiftId`, `level` ou `levelId` (T3); (c) guarda estática (T4b): spec que varre `backend/src/**/*.ts` e `backend/prisma/*.ts` (fora `*.spec.ts`, `*.test-fixtures.ts` e `assignment-writer.ts`) e falha se achar, dentro do texto de uma chamada `.user.create|createMany|update|updateMany|upsert(` a partir da chave `data`, uma das chaves `sectorId|shiftId|levelId|sector|workShift|level`, ou qualquer escrita em `.userAssignment.` . Limite aceito: `data` montado em variável fora da chamada e passado a `prisma.user.*` direto escapa da guarda estática; a camada (b) cobre o caminho do repositório.
- **DV16. Inativos:** a migração cria linha para todos; as leituras com data mantêm o filtro `isActive: true` que já têm (inativo continua fora do quadro e do envio, como hoje).
- **DV17. Novidades:** entrada nova no topo de `RELEASE_NOTES`, versão `2026.11.19.2` se implementada hoje; em outro dia, `AAAA.MM.DD` do dia (maior que `2026.11.19.1`).

## Global Constraints

- **GV1. Um caminho só:** nenhum código fora de `backend/src/modules/users/assignment-writer.ts` grava `UserAssignment` ou `User.sectorId/shiftId/levelId` (nem por relação `sector`/`workShift`/`level`). `writeAssignment` só é chamada dentro do `tx` de `createWithAudit` e `updateWithLastAdminGuard`.
- **GV2. Trilha na transação (GC1 do Lote A):** histórico, espelho e trilha na mesma transação; se a trilha lançar, nada fica gravado. A trilha da troca é o evento da pessoa com o retrato lido depois de `writeAssignment` (DV5); não criar evento novo nem duplicar o existente.
- **GV3. Vigência (R4):** a troca vale a partir de hoje (`todayIn`, America/Manaus). Nenhum DTO, rota ou tela ganha campo de data de vigência; data futura e retroativa ficam fora. A linha anterior fecha na véspera e a nova abre hoje; duas trocas no mesmo dia atualizam a linha aberta do dia, sem linha de duração zero.
- **GV4. Leituras:** só o quadro da escala e a lista do dia do envio leem por data (DV9 a DV11). Permissão do gestor, listagem do setor, token, alvo pessoa e alcance continuam no espelho. Para hoje e o futuro o resultado e as consultas ficam idênticos aos de hoje.
- **GV5. Histórico de envios e escala não mudam:** nada altera `TeamWhatsappRecipient`, `TeamWhatsappDispatch`, `StaffSchedule` ou exceções; nada apaga nem reescreve evento da trilha nem linha fechada de vínculo.
- **GV6. Escopo por setor e permissões do Lote B não mudam:** `canViewPersonHistory`, `canEditPerson`, `viewableSectorIds`, `@RequirePermission` e as chaves ficam como estão; a rota nova usa `trilha.consultar` (DV13).
- **GV7. Nome exibido:** toda lista nova ou alterada que devolva nome de pessoa usa `nameView(nome, { full: hasPermission(ator, 'telefone.ver_completo') })` (`backend/src/shared/authz/phone-visibility.ts`) e ordena pelo nome exibido com desempate por id. Nome de setor, turno e nível não passa por `nameView`.
- **GV8. Parcial (R3):** não criar coluna, tabela, tela nem tipo para unidade ou equipe/célula.
- **GV9. Migração e dados:** sem perda de dados, reexecutável, backfill em SQL na própria migração; nunca `prisma migrate reset` nem `migrate dev`; banco só o do testcontainer do próprio teste (única exceção: o Postgres descartável de `docker run --rm` que a T1 sobe e remove para gerar o DDL com `prisma migrate diff`); nada de serviço novo no compose.
- **GV10. Testes e tamanho:** TDD (RED antes do GREEN). Funções novas e callbacks de `describe`/`it` de até 50 linhas, complexidade até 10, até 4 parâmetros; `describe` novos irmãos, no topo do arquivo, sem aumentar bloco existente. Conferir com `npx eslint <specs tocados> --rule '{"max-lines-per-function": ["error", 50], "max-params": ["error", 4], "complexity": ["error", 10], "max-depth": ["error", 4]}'`.
- **GV11. Validação:** cwd `backend/` ou `frontend/`, caminhos relativos ao pacote. Loop: `timeout 600 gate --test src/<arquivo>`, um arquivo por chamada; integração com `TESTCONTAINERS_ENABLED=1 timeout 600 gate --test src/<arquivo>.integration.spec.ts`. Typecheck: back `npx tsc --noEmit -p tsconfig.build.json --tsBuildInfoFile /tmp/<task>.tsbuildinfo`; front `npx tsc -b`. Fechamento: `timeout 600 gate --changed --base feat/permissoes-por-acao`. Nunca suíte inteira, gate completo, coverage ou e2e (são da principal). Sem artefato de build no diff.
- **GV12. Arquivos legados:** nunca `prettier --write` em arquivo que já existia (só em arquivo novo); nunca restaurar arquivo do git (`checkout`, `restore`, `stash`, `show >`); se errar, corrigir para a frente. Pastas untracked alheias (`.playwright-mcp/`, `reports/`, `research_notes/`, `tutoriais/`) não se tocam.
- **GV13. Compila entre tasks:** assinatura existente só ganha parâmetro ou campo opcional, salvo onde a task diz o contrário e ajusta todos os chamadores e specs dentro do próprio ownership.
- **GV14. Textos de tela:** pt-BR, no tom das telas atuais, sem jargão técnico; exatamente os de DV14 e da T9.
- **GV15. Sem commit** pelos agentes.

## Contratos compartilhados

**CV1. Prisma (T1), `backend/prisma/schema.prisma`.**
```prisma
model UserAssignment {
  id           String      @id @default(cuid())
  userId       String
  user         User        @relation(fields: [userId], references: [id], onDelete: Cascade)
  sectorId     String?
  sector       Sector?     @relation(fields: [sectorId], references: [id], onDelete: Restrict)
  shiftId      String?
  shift        Shift?      @relation(fields: [shiftId], references: [id], onDelete: Restrict)
  levelId      String?
  level        StaffLevel? @relation(fields: [levelId], references: [id], onDelete: Restrict)
  validFrom    DateTime?   @db.Date   // nulo = anterior ao histórico (só migração/DV8)
  validTo      DateTime?   @db.Date   // nulo = linha aberta
  recordedById String?                // sem FK; nulo = migração
  recordedAt   DateTime    @default(now())
  // Só no SQL: UserAssignment_userId_open_key (único parcial, validTo IS NULL)
  // e CHECK UserAssignment_period_check. Não remover num migrate futuro.
  @@index([userId, validFrom])
  @@index([sectorId, validFrom, validTo])
  @@index([shiftId])
  @@index([levelId])
}
```
Campos de volta: `User.assignments UserAssignment[]`, `Sector.assignmentHistory UserAssignment[]`, `Shift.assignmentHistory UserAssignment[]`, `StaffLevel.assignmentHistory UserAssignment[]`. Migração `backend/prisma/migrations/20261119110000_user_assignment_history/migration.sql` conforme DV2 a DV4.

**CV2. Regras puras (T2), `backend/src/modules/users/assignment-timeline.ts`.**
```ts
import { addDays, type CivilDate } from '../staff-schedule/civil-date';
export type AssignmentValues = { sectorId: string | null; shiftId: string | null; levelId: string | null };
export type AssignmentPatch = Partial<AssignmentValues>;          // ausente = mantém
export type AssignmentLine = AssignmentValues & { from: CivilDate | null; to: CivilDate | null };
export type AssignmentStep =
  | { kind: 'NONE' }
  | { kind: 'OPEN'; values: AssignmentValues; from: CivilDate }
  | { kind: 'UPDATE_OPEN'; values: AssignmentValues }
  | { kind: 'CLOSE_AND_OPEN'; closeTo: CivilDate; values: AssignmentValues; from: CivilDate };
export const NO_ASSIGNMENT: AssignmentValues;                     // três nulos
export function mergeAssignment(current: AssignmentValues, patch: AssignmentPatch): AssignmentValues;
export function sameAssignment(a: AssignmentValues, b: AssignmentValues): boolean;
export function planAssignmentStep(open: AssignmentLine | null, next: AssignmentValues, today: CivilDate): AssignmentStep;
  // open nulo → OPEN{next, from: today} (mesmo com os três nulos: toda pessoa tem linha aberta)
  // igual → NONE; open.from != null && open.from >= today → UPDATE_OPEN
  // senão → CLOSE_AND_OPEN{closeTo: addDays(today, -1), next, from: today}
export function coversDate(line: Pick<AssignmentLine, 'from' | 'to'>, date: CivilDate): boolean;
  // from nulo = desde sempre; to nulo = aberta
export function assignmentOn(input: {
  mirror: AssignmentValues; lines: readonly AssignmentLine[]; date: CivilDate; today: CivilDate;
}): AssignmentValues;                                              // DV9
```

**CV3. Escritor e repositório (T3).**
```ts
// backend/src/modules/users/assignment-writer.ts
export type AssignmentWrite = {
  userId: string; patch: AssignmentPatch; today: CivilDate;
  actorId: string | null; origin: 'CREATE' | 'CHANGE';
};
export function writeAssignment(tx: Prisma.TransactionClient, input: AssignmentWrite): Promise<AssignmentStep>;
// backend/src/modules/users/users.repository.ts
export type AssignmentChange = { patch: AssignmentPatch; today: CivilDate; actorId: string | null };
createWithAudit(data: Prisma.UserCreateInput, audit: PersonCreateTrail, assignment?: AssignmentChange): Promise<UserSummary>;
  // ausente = { patch: {}, today: todayIn(new Date()), actorId: null }; sempre abre a linha (origin CREATE)
updateWithLastAdminGuard(id: string, data: Prisma.UserUpdateInput, audit?: PersonUpdateTrail, assignment?: AssignmentChange):
  Promise<{ updated: PersonAuditRow } | { lastAdmin: true }>;
```
Ordem dentro do `tx`: criação = `tx.user.create(data)` → `writeAssignment(origin 'CREATE')` → retrato `personAuditSelect` → `audit(tx, row, id)` → resumo `USER_SUMMARY_SELECT` relido (depois da função). Edição = `before` → guarda do último ADMIN → `tx.user.update(data)` → `writeAssignment(origin 'CHANGE')` se `assignment` veio → `after` relido com `personAuditSelect` → `audit(tx, before, after)` → `{ updated: after }`. Recusa de DV15(b) antes de abrir o `tx`.

**CV4. Quadro (T5).**
```ts
// staff-schedule.repository.ts (novos)
listAssignedUserIds(sectorId: string, from: CivilDate, to: CivilDate, take: number): Promise<string[]>;
  // ativos com linha no setor que cruza [from, to]
loadAssignmentLines(userIds: readonly string[], from: CivilDate, to: CivilDate): Promise<Map<string, AssignmentLine[]>>;
// board.ts
export type BoardPersonInput = BoardPersonRow & ScheduleData & { assignments: readonly AssignmentLine[] };
export function buildBoardRows(input: { actor: TeamActor; sectorId: string; dates: readonly CivilDate[];
  people: readonly BoardPersonInput[]; today: CivilDate }): BoardRow[];
```
`StaffScheduleService.board` calcula `today = todayIn(new Date())` uma vez e usa no `loadPeople(query, today)`, no `buildBoardRows` e no campo `today` da resposta. Consultas de linha só quando `from < today`, com o fim limitado a `min(to, addDays(today, -1))`.

**CV5. Lista do dia (T6).**
```ts
// team-whatsapp.repository.ts
loadDayPeopleMany(sectorIds: readonly string[], date: CivilDate, today: CivilDate = todayIn(new Date())): Promise<Map<string, TeamMemberWithSchedule[]>>;
// team-whatsapp/team-member-assignment.ts (novo, puro)
export type AssignmentOnRow = {
  sectorId: string | null; sector: { isActive: boolean } | null;
  shiftId: string | null; shift: { name: string } | null;
  levelId: string | null; level: { id: string; name: string } | null;
};
export function withAssignmentOn<T extends TeamMemberRow>(row: T, line: AssignmentOnRow | undefined): T;
  // sem linha = row intacta (espelho); com linha = sectorId, sector, shiftId, workShift, levelId, level da linha
```
Os campos de `TeamMemberRow` estão em `team-whatsapp.repository.ts:41-68` (conferido na revisão; a T6 confirma os nomes exatos); `AssignmentOnRow` acompanha a forma deles. Os specs de integração `staff-schedule.repository.integration.spec.ts` e `team-whatsapp.repository.integration.spec.ts` existem.

**CV6. API "Vínculos" (T7; front espelha na T8).**
```ts
// backend/src/schemas/contracts/person-assignments.schema.ts
export const assignmentRefSchema = z.object({ id: z.string(), name: z.string() });
export const personAssignmentSchema = z.object({
  id: z.string(),
  sector: assignmentRefSchema.nullable(),
  shift: assignmentRefSchema.nullable(),
  level: assignmentRefSchema.nullable(),
  from: civilDateSchema.nullable(),   // nulo = anterior ao histórico
  to: civilDateSchema.nullable(),     // nulo = vínculo atual
});
export const personAssignmentsSchema = z.object({ items: personAssignmentSchema.array() });
export type PersonAssignment = z.infer<typeof personAssignmentSchema>;
export type PersonAssignments = z.infer<typeof personAssignmentsSchema>;
```
`GET /audit-trail/people/:userId/assignments` → `200 PersonAssignments`, itens com a linha aberta primeiro e depois por `to` decrescente; erros iguais aos de `GET /audit-trail/people/:userId` (403 `auditTrailForbidden` para fora do alcance e para inexistente quando o ator não vê qualquer pessoa; 404 `auditTrailPersonNotFound` para quem vê; 403 `auth.permission_denied` sem `trilha.consultar`).

**CV7. Front (T8), `frontend/src/features/audit-trail/`.**
```ts
// schemas.ts: personAssignmentsSchema (espelho de CV6)
// api.ts
export function usePersonAssignments(userId: string): UseQueryResult<PersonAssignments>;
  // key ['audit-trail', 'people', userId, 'assignments']; GET audit-trail/people/:userId/assignments
// components/person-assignments.tsx
export function PersonAssignments(props: { userId: string }): JSX.Element;
```
A chave começa por `['audit-trail','people',userId]`, então toda invalidação do Histórico que já exista cobre os vínculos. A chave do Histórico é `['audit-trail','people',userId,page]` (conferido na revisão), sem colisão com a de vínculos.

## Review Focus

As cinco condições que a spec implica e nenhum teste óbvio cobre, cada uma presa a um teste:

1. **Pessoa sem setor, turno e nível, e pessoa inativa, na migração:** ganham linha aberta com os três nulos / com os valores dela; a contagem do `DO` não as ignora. Teste: T1, `it('cria linha aberta para pessoa sem setor, turno e nível e para pessoa inativa')`.
2. **Troca às 23h59 em Manaus:** em `2026-11-20T03:59:00Z` (19/11 23h59 em Manaus) a linha nova abre em `2026-11-19` e a anterior fecha em `2026-11-18`; em `2026-11-20T04:00:00Z` abre em `2026-11-20`. Nunca a data UTC. Teste: T4a, `it('hoje da troca é a data de Manaus, não a de UTC')`.
3. **Duas trocas no mesmo dia voltando ao valor original (A→B→A):** uma linha fechada na véspera com A, uma aberta hoje com A, espelho A, duas entradas na trilha; a leitura de ontem dá A. Teste: T3, `it('A→B→A no mesmo dia: fecha uma vez, atualiza a aberta, sem linha de duração zero')` e T4b para as duas entradas na trilha.
4. **Período do quadro que cruza a data da troca (e lista do dia de data passada):** pessoa movida hoje de A para B aparece no quadro de A e no de B para `[hoje-3, hoje+3]`, membro nos dois (`fromOtherSector: false`), com os dias anteriores em A e os seguintes em B; o quadro de A só com datas passadas não a perde; a lista do dia de ontem em A a traz e a de hoje não. Testes: T5, `it('período que cruza a troca: dias antes no setor antigo, a partir de hoje no novo')`; T6, `it('lista do dia de ontem usa o vínculo de ontem; a de hoje, o espelho')`.
5. **Pessoa criada hoje e trocada hoje:** uma linha só, início hoje, atualizada no lugar; nenhuma linha fechada; nenhuma linha com fim antes do início. Teste: T3, `it('criada hoje e trocada hoje: uma linha aberta, atualizada no lugar')`.

Também conferir na revisão: `writeAssignment` só aparece nos dois métodos do repositório (GV1); para data ≥ hoje nenhuma consulta nova roda no quadro nem na lista do dia (GV4); a rota nova reaproveita o mesmo teste de alcance do Histórico (DV13).

---

## Task 1 — Modelo e migração do histórico de vínculo (back)

**Arquivos:**
- Modificar: `backend/prisma/schema.prisma` (modelo `UserAssignment` e os quatro campos de volta, CV1).
- Criar: `backend/prisma/migrations/20261119110000_user_assignment_history/migration.sql`; `backend/src/modules/users/user-assignment-migration.integration.spec.ts`.

**Interfaces:**
- Consome: modelos `User`, `Sector`, `Shift`, `StaffLevel` atuais.
- Produz: CV1 e o client gerado (`npx prisma generate`) que T3, T5, T6 e T7 usam.

**Contexto vinculado:**
- Spec Lote C: "cada pessoa tem uma linha aberta com setor, turno e nível atuais, e linhas fechadas para os vínculos anteriores, com início e fim (datas civis)". "Migração: uma linha aberta por pessoa com os valores atuais, início em branco (significa 'anterior ao histórico') e sem fim. A migração confere as contagens: uma linha por pessoa, valores iguais aos da ficha." Parcial: não criar nada de unidade ou equipe.
- DV1: colunas `id`, `userId`, `sectorId?`, `shiftId?`, `levelId?`, `validFrom DATE?`, `validTo DATE?`, `recordedById?` (sem FK; nulo = migração), `recordedAt`.
- DV2: índice único parcial `UserAssignment_userId_open_key` em `("userId") WHERE "validTo" IS NULL`; `CHECK "UserAssignment_period_check"` (`validFrom IS NULL OR validTo IS NULL OR validFrom <= validTo`); sem `btree_gist`; os dois só no SQL, com comentário no modelo.
- DV3: `userId` Cascade; setor, turno e nível Restrict (o `SetNull` apagaria o setor das linhas fechadas); nenhum caminho do produto apaga setor, turno ou nível.
- DV4: backfill entre `-- backfill:begin` e `-- backfill:end`: `INSERT … SELECT` com id `'ua_' || u."id"`, todas as pessoas (ativas e inativas, com e sem setor, com e sem acesso), valores da ficha, início e fim nulos, `recordedById` nulo, `recordedAt now()`, `NOT EXISTS` linha aberta, `ON CONFLICT ("id") DO NOTHING`; depois `DO $$` que conta pessoas sem linha aberta e linhas abertas diferentes da ficha (`IS DISTINCT FROM`) e faz `RAISE EXCEPTION` com as duas contagens se alguma > 0.
- GV9: sem perda de dados, reexecutável, nunca `migrate reset` nem `migrate dev`, banco só do testcontainer.
- GV8: nada de unidade ou equipe.

**Passos:**
1. [ ] RED `user-assignment-migration.integration.spec.ts`, no molde de `backend/src/modules/users/person-record-migration.integration.spec.ts` (linhas 56-68): o banco do testcontainer sobe com `deployMigrations({ databaseUrl, until: '20261119100000_role_permissions' })`, o spec insere **em SQL** as pessoas legadas e só depois roda `deployMigrations({ databaseUrl })` completo, que executa a migração real sobre elas. Só os testes "reexecutar não duplica" e "o `DO` falha" reexecutam o trecho entre `-- backfill:begin` e `-- backfill:end` lido do texto do arquivo:
   - `it('a migração real cria uma linha aberta por pessoa legada, igual à ficha, com início, fim e recordedById em branco')` (aceite 18; pessoas legadas: ativa com setor, turno e nível; inativa; sem setor; sem acesso; depois do deploy completo: uma linha aberta por pessoa, valores iguais aos da ficha, `validFrom` e `validTo` nulos, `recordedById` nulo);
   - `it('cria linha aberta para pessoa sem setor, turno e nível e para pessoa inativa')` (Review Focus 1; no mesmo cenário legado);
   - `it('reexecutar o backfill não duplica nem altera linha existente')` (linha aberta editada à mão continua igual; contagem igual);
   - `it('o DO falha quando uma linha aberta diverge da ficha')` (muda o `sectorId` de uma linha aberta e reexecuta só o `DO`: espera erro com as contagens);
   - `it('o banco recusa segunda linha aberta da mesma pessoa e início depois do fim')` (índice parcial e `CHECK`);
   - `it('apagar a pessoa apaga as linhas; apagar setor com histórico é recusado')`.
2. [ ] GREEN: modelo, campos de volta e SQL. O DDL (`CREATE TABLE`, índices comuns, FKs) **sai do Prisma, não escrito à mão**, para não haver drift com o job `migration-drift` do CI:
   1. Editar `schema.prisma` (CV1) e **ainda sem criar a pasta da migração**.
   2. Subir um Postgres descartável, fora da stack local do projeto, o mesmo que os testes usam (`postgres:16-alpine`, como em `shift-migration.integration.spec.ts`): `docker run --rm -d --name pg-shadow-lote-c -e POSTGRES_PASSWORD=shadow -e POSTGRES_DB=shadow -p 55432:5432 postgres:16-alpine` (porta livre à escolha; esperar `pg_isready`).
   3. No cwd `backend/`: `DATABASE_URL=postgresql://postgres:shadow@localhost:55432/shadow npx prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --shadow-database-url postgresql://postgres:shadow@localhost:55432/shadow --script`. **Nunca** `migrate dev` nem `migrate reset`. (`backend/test/migrations.ts:64-97`, `schemaDrift`, é o mesmo comando; se for mais simples, chamar esse helper num script descartável fora do repo.)
   4. Remover da saída a linha `DROP TABLE "_message_dup_neutralized_20260819";` e qualquer `DROP INDEX` de índice parcial (o Prisma os lista por não os modelar; ver comentário em `schema.prisma` sobre `Message` e `WhatsappInstance_provider_default_key`). Qualquer outra linha da saída que não seja de `UserAssignment` (`CREATE TABLE`, índices, FKs): parar e relatar, sem copiar para a migração. Se o `docker run` for negado pelo ambiente, não insistir: escrever o DDL à mão nos nomes que o Prisma gera (`UserAssignment_pkey`, `UserAssignment_<coluna>_idx`, `UserAssignment_<coluna>_fkey`, `ON UPDATE CASCADE`) e usar o spec de drift do passo de validação como juiz, corrigindo até o drift sair vazio.
   5. Gravar o resultado em `backend/prisma/migrations/20261119110000_user_assignment_history/migration.sql` e **acrescentar à mão só**: `CREATE UNIQUE INDEX "UserAssignment_userId_open_key" ON "UserAssignment"("userId") WHERE "validTo" IS NULL;`, o `ALTER TABLE … ADD CONSTRAINT "UserAssignment_period_check" CHECK (…)` (DV2) e o bloco de backfill (`-- backfill:begin` … `-- backfill:end` e o `DO $$`, DV4).
   6. Parar o container (`docker stop pg-shadow-lote-c`; `--rm` o remove) em qualquer desfecho, inclusive se falhar.
   Depois `npx prisma validate` e `npx prisma generate`.
3. [ ] Rodar também, sem mudar, os specs de integração que já apagam setor ou pessoa: `TESTCONTAINERS_ENABLED=1 timeout 600 gate --test src/modules/sector-people/sector-people.repository.integration.spec.ts` (ele faz `prisma.sector.delete`). Se quebrar **só** porque o novo `Restrict` barra a limpeza, relatar no report com o teste e a linha; não mudar o FK nem o teste (a principal decide). Conferido na revisão: não deve quebrar, porque o `dropOrder` apaga as pessoas antes do setor (`sector-people.repository.integration.spec.ts:142-145`) e pessoas criadas direto pelo Prisma não têm linha; `levels.repository.integration.spec.ts:82-84` continua esperando `P2003`; os `TRUNCATE` existentes usam `CASCADE`.
4. [ ] Validação: `TESTCONTAINERS_ENABLED=1 timeout 600 gate --test src/modules/users/user-assignment-migration.integration.spec.ts`; `TESTCONTAINERS_ENABLED=1 timeout 600 gate --test src/modules/shifts/shift-migration.integration.spec.ts` (roda o `schemaDrift` de `backend/test/migrations.ts:64-97`; **aceite: drift vazio**, isto é, `{ status: 0, script: '' }` ou só o `DROP TABLE` de quarentena já tolerado); typecheck do back; `timeout 600 gate --changed --base feat/permissoes-por-acao`.

**Aceite:** spec aceite 18 (no banco migrado, depois de rodar a migração real sobre pessoas legadas, há exatamente uma linha aberta por pessoa, igual à ficha) e drift do `schema.prisma` contra as migrações vazio.

**Risco: crítico (produção)**
**Crítico:** produção — migração com backfill sobre a tabela `User` real: cria uma linha por pessoa e aborta a migração inteira se a contagem divergir; só cria tabela e insere, sem apagar nem alterar dado existente. O `Restrict` novo muda o efeito de apagar setor direto no banco.

## Task 2 — Regras puras de vigência (back)

**Arquivos:**
- Criar: `backend/src/modules/users/assignment-timeline.ts` e `assignment-timeline.spec.ts`.

**Interfaces:**
- Consome: `addDays`, `CivilDate` (`backend/src/modules/staff-schedule/civil-date.ts`).
- Produz: CV2 inteiro.

**Contexto vinculado:**
- Spec Lote C, Troca: "vale a partir de hoje. Não se aceita data futura nem passada. A linha anterior fecha na véspera e a nova abre hoje. Duas trocas no mesmo dia atualizam a linha aberta do dia, sem vínculo de duração zero."
- Spec Lote C, Leituras: "com data passada usam o vínculo vigente naquela data; hoje e datas futuras usam o vínculo aberto". Migração: "consultas tratam início em branco como 'desde sempre'".
- DV6: criação abre com início = hoje; início em branco só da migração e de DV8.
- DV8: data sem linha que a cubra usa o espelho.
- DV9: data ≥ hoje → espelho; data < hoje → linha que cobre (início nulo = desde sempre; fim nulo = aberta); nenhuma → espelho.
- DV12: A→B→A no mesmo dia não junta linhas.
- CV2: assinaturas e regras de `planAssignmentStep` (open nulo → OPEN mesmo com três nulos; igual → NONE; `open.from` não nulo e ≥ hoje → UPDATE_OPEN; senão CLOSE_AND_OPEN com `closeTo = addDays(today, -1)`).
- GV10: funções até 50 linhas, complexidade até 10.

**Passos:**
1. [ ] RED `assignment-timeline.spec.ts`:
   - `it('planAssignmentStep: sem linha aberta abre hoje, inclusive sem setor, turno e nível')`;
   - `it('planAssignmentStep: igual à aberta não grava')`;
   - `it('planAssignmentStep: aberta desde antes de hoje (ou em branco) fecha em 2026-11-18 e abre 2026-11-19')` (today `2026-11-19`);
   - `it('planAssignmentStep: aberta que começou hoje é atualizada no lugar')`;
   - `it('mergeAssignment: campo ausente mantém, null limpa')` (tirar do setor mantém turno e nível);
   - `it('assignmentOn: hoje e futuro usam o espelho mesmo com linha fechada cobrindo')`;
   - `it('assignmentOn: data passada usa a linha que cobre; início em branco cobre qualquer passado; fim é inclusivo')` (linha `null..2026-11-18` A e `2026-11-19..` B: `2026-11-18` → A, `2000-01-01` → A);
   - `it('assignmentOn: data passada sem linha que cubra usa o espelho')`.
2. [ ] GREEN.
3. [ ] Validação: `timeout 600 gate --test src/modules/users/assignment-timeline.spec.ts`; typecheck do back; `timeout 600 gate --changed --base feat/permissoes-por-acao`.

**Aceite:** base de 17 e 19 (regras de fechar na véspera, abrir hoje e ler pela data).

**Risco: alto** (regra pura de que dependem a escrita e as duas leituras; sem I/O).

## Task 3 — Função única de escrita e repositório de usuários (back)

**Arquivos:**
- Criar: `backend/src/modules/users/assignment-writer.ts` e `assignment-writer.integration.spec.ts`.
- Modificar: `backend/src/modules/users/users.repository.ts` (`createWithAudit`, `updateWithLastAdminGuard`, `runSerializable`/`isSerializationFailure`, tipo `AssignmentChange`, recusa de DV15(b)); `users.repository.spec.ts` e `users.repository.integration.spec.ts` (fixtures que hoje passam `sector`/`workShift`/`level` em `data` passam a usar o parâmetro `assignment`; asserções existentes portadas, nunca afrouxadas).

**Interfaces:**
- Consome: CV1 (client gerado, T1); CV2 (T2); `toDbDate`, `fromDbDate`, `todayIn` (`staff-schedule/civil-date.ts`); `personAuditSelect` (`users/person-audit.ts`); `PersonCreateTrail`, `PersonUpdateTrail`, `USER_SUMMARY_SELECT`.
- Produz: CV3.

**Contexto vinculado:**
- Spec Lote C: "toda gravação de setor, turno ou nível da pessoa (criação, edição, mover, tirar do setor, a partir de contatos) passa por uma única função que, na mesma transação, atualiza o histórico, o espelho em `User.sectorId/shiftId/levelId` e a trilha."
- DV5: `writeAssignment` é o único código que grava `UserAssignment` e o espelho; chamada só por `createWithAudit` e `updateWithLastAdminGuard`, dentro do `tx`, antes da leitura do retrato "depois"; a trilha continua sendo o evento da pessoa nesse `tx` (sem evento novo).
- DV7: `today` chega como dado; `runSerializable` repete `P2034` e também `P2002` no índice `UserAssignment_userId_open_key`; criação em transação padrão.
- DV8: sem linha aberta e `origin: 'CHANGE'` → materializa a linha da migração (início em branco, valores do espelho) e a fecha na véspera, só se o passo não for `NONE`.
- DV12: A→B→A no mesmo dia não junta linhas.
- DV15(b): `createWithAudit` e `updateWithLastAdminGuard` lançam `Error('vínculo só por writeAssignment')` se `data` trouxer `sector`, `sectorId`, `workShift`, `shiftId`, `level` ou `levelId`.
- CV3: ordem dentro do `tx` (criação: create → writer CREATE → retrato → trilha → resumo relido; edição: before → último ADMIN → update → writer CHANGE → after relido → trilha → `{ updated: after }`); `recordedById = actorId`; em `UPDATE_OPEN` atualiza também `recordedById` e `recordedAt`.
- GV2: se a trilha lançar, nem linha nem espelho ficam.
- GV3: fecha na véspera, abre hoje, sem duração zero.

**Passos:**
1. [ ] RED `assignment-writer.integration.spec.ts` (chamando `writeAssignment` dentro de `prisma.$transaction` e pelos dois métodos do repositório, com `today` explícito):
   - `it('criação abre uma linha com início hoje e grava o espelho')`;
   - `it('troca em outro dia fecha a aberta na véspera e abre hoje; espelho igual à aberta')` (linha migrada `null..`; today `2026-11-19` → `null..2026-11-18` e `2026-11-19..`);
   - `it('A→B→A no mesmo dia: fecha uma vez, atualiza a aberta, sem linha de duração zero')` (Review Focus 3);
   - `it('criada hoje e trocada hoje: uma linha aberta, atualizada no lugar')` (Review Focus 5);
   - `it('sem mudança não grava linha nem espelho')`;
   - `it('pessoa sem linha (fixture antiga) materializa a linha migrada antes de fechar')`;
   - `it('se a trilha lançar, linha e espelho não ficam')` (via `updateWithLastAdminGuard` com `audit` que lança);
   - `it('duas trocas simultâneas da mesma pessoa terminam com uma linha aberta igual ao espelho, sem sobreposição')` (`Promise.all` de dois `updateWithLastAdminGuard` com setores diferentes, partindo de pessoa **com** linha aberta: o conflito cai no lock da linha e dá só `P2034`; as duas resolvem, ou a perdedora repete);
   - `it('duas trocas simultâneas só de turno em pessoa sem linha aberta: nenhuma termina com 500 por P2002')` (DV8: pessoa criada direto pelo Prisma, sem linha; `Promise.all` de dois `updateWithLastAdminGuard` com `data` vazio e `assignment.patch` só de `shiftId`; as duas inserções da linha migrada disputam o índice `UserAssignment_userId_open_key` e exercitam o ramo `P2002`; a perdedora repete e termina com uma linha aberta igual ao espelho).
   - Pendência conhecida (registrar no report, **não corrigir** nesta task): quando as tentativas de `P2034` se esgotam, o serviço responde `user.concurrent_admin_change` (`users.service.ts:746-760`), texto de troca de administrador, enganoso para troca de vínculo.
2. [ ] RED `users.repository.spec.ts`: `it('recusa sector/sectorId/workShift/shiftId/level/levelId em data, antes de abrir a transação')`.
3. [ ] GREEN: escritor, novos parâmetros, ordem do `tx`, recusa, repetição em `P2002` do índice. Portar as fixtures dos specs do repositório para o parâmetro `assignment`.
4. [ ] Validação: `TESTCONTAINERS_ENABLED=1 timeout 600 gate --test src/modules/users/assignment-writer.integration.spec.ts`; `TESTCONTAINERS_ENABLED=1 timeout 600 gate --test src/modules/users/users.repository.integration.spec.ts`; `timeout 600 gate --test src/modules/users/users.repository.spec.ts`; typecheck do back; `timeout 600 gate --changed --base feat/permissoes-por-acao`. Os specs de `users.service*` podem falhar até a T4a só se exercitarem o repositório real; relatar quais.
5. [ ] **Quebra esperada até a T4a, não corrigir na T3:** `backend/src/modules/sector-people/sector-people-write.integration.spec.ts` monta `UsersRepository`, `UsersService` e `SectorPeopleWriteService` reais e chama `create`, `move` e `addContact`; com a recusa de DV15(b) no repositório ele falha até a T4a ajustar o serviço. Rodá-lo uma vez, só para registrar no report que quebra por essa razão (e por nenhuma outra); a T4a o devolve ao verde.

**Aceite:** spec aceites 19 (uma linha aberta só depois de duas trocas no dia) e 20 (parte: o repositório recusa gravar o vínculo fora da função).

**Risco: crítico (produção)**
**Crítico:** produção — toda troca de setor, turno ou nível em produção passa a fechar e abrir linhas de histórico numa transação serializável; um defeito fecha ou sobrescreve linha de vínculo, e o passado do quadro e do envio deixa de ser recuperável pela aplicação.

## Task 4a — Serviço de usuários pela função única (back)

**Arquivos:**
- Modificar: `backend/src/modules/users/users.service.ts` (`createInvitation`, `personWithoutAccessData`, `createWithTrail`, `updateUser`, `toUpdateData`; função nova `assignmentPatch(input)`); os specs `users.service*.spec.ts` que conferem `data` com `sector`/`workShift`/`level` passam a conferir o parâmetro `assignment` (asserções portadas, nunca afrouxadas); `users.test-fixtures.ts` se preciso.

**Interfaces:**
- Consome: CV2 (`AssignmentPatch`, `AssignmentValues`), CV3 (`AssignmentChange`, novos parâmetros do repositório), `todayIn`.
- Produz: os cinco caminhos de escrita (criar com e sem acesso, editar, mover, tirar, a partir de contatos) passando o vínculo ao repositório; `sector-people-write.service.ts` não muda (chama `createPersonWithoutAccess` e `updateUser`).

**Contexto vinculado:**
- Spec Lote C: "um caminho só de escrita" (texto em T3). Troca vale a partir de hoje; sem data futura nem passada.
- DV5: o serviço não grava vínculo; passa `assignment` ao repositório; a trilha da pessoa continua a mesma (sem evento novo, mesmas ações e categorias, `move` com `ASSIGNMENT`).
- DV6: criação abre com início = hoje.
- DV7: `today = todayIn(new Date())` calculado uma vez por operação no serviço e passado ao repositório; testes fixam o relógio com `vi.useFakeTimers({ toFake: ['Date'] })` + `vi.setSystemTime`.
- `assignmentPatch(input: UserPatch): AssignmentPatch | undefined`: só as chaves presentes no PATCH (`sectorId`, `shiftId`, `levelId`), string vazia vira `null` (como o `relationPatch` atual), `undefined` se nenhuma veio. `updateUser` só passa `assignment` quando o patch não é `undefined`.
- Mantém: validações atuais (`assertActiveSectorIfGiven`, `assertAssignableLevel`, `assertAssignableShift`, `lacksRequiredSector`), `sessionVersion` incrementado quando `sectorId` vem no PATCH (`changesIdentity`), revogação de sessão.
- Criação: `data` sem `sector`, `workShift` e `level`; `assignment.patch = { sectorId, shiftId, levelId }` com `null` no que não veio. `connectIfGiven` e `relationPatch` saem se ficarem sem uso.
- DV15(b): o repositório recusa os seis campos em `data`.
- GV13: assinaturas públicas do serviço não mudam.

**Passos:**
1. [ ] RED (`describe` novos no topo de `users.service.spec.ts` ou do spec temático correspondente):
   - `it('createUser e createPersonWithoutAccess mandam setor, turno e nível em assignment, nunca em data')`;
   - `it('updateUser manda só as chaves do PATCH em assignment; sem chave de vínculo, sem assignment')`;
   - `it('tirar do setor (sectorId null) mantém turno e nível fora do patch')`;
   - `it('hoje da troca é a data de Manaus, não a de UTC')` (Review Focus 2: `2026-11-20T03:59:00Z` → `today '2026-11-19'`; `2026-11-20T04:00:00Z` → `'2026-11-20'`).
2. [ ] GREEN; portar os specs existentes que conferem `data` com relação de vínculo.
3. [ ] Validação: `timeout 600 gate --test` em cada `src/modules/users/users.service*.spec.ts` tocado e em `src/modules/sector-people/sector-people-write.service.spec.ts` (sem mudar); `TESTCONTAINERS_ENABLED=1 timeout 600 gate --test src/modules/users/users.repository.integration.spec.ts`; `TESTCONTAINERS_ENABLED=1 timeout 600 gate --test src/modules/sector-people/sector-people-write.integration.spec.ts` (quebrado desde a T3; **deve voltar a passar**, sem mudar o spec); typecheck do back; `timeout 600 gate --changed --base feat/permissoes-por-acao`.

**Aceite:** spec aceite 20 (parte: os caminhos do serviço passam pela função única).

**Risco: crítico (produção)**
**Crítico:** produção — muda como todo cadastro e edição de pessoa grava setor, turno e nível; um caminho que esqueça `assignment` deixa a ficha e o histórico divergentes e reescreve o passado lido pelo quadro e pelo envio.

## Task 4b — Prova dos cinco caminhos e guarda estática (back)

**Arquivos:**
- Criar: `backend/src/modules/users/assignment-paths.integration.spec.ts`; `backend/src/modules/users/assignment-write-guard.spec.ts`.

**Interfaces:**
- Consome: `UsersService` (T4a) e `SectorPeopleWriteService` reais, com repositórios e `PrismaService` do testcontainer; molde de montagem: `backend/src/modules/sector-people/sector-people-write.integration.spec.ts` linhas 46-63 (`UsersRepository`, `UsersService`, `UserPhoneService`, `SectorPeopleService` e `SectorPeopleWriteService` reais; contatos e `RefreshService` como stub); `AuditEvent` para a trilha. Esse spec já chama `create`, `move` e `addContact` (linhas 216-231 e 316).
- Produz: prova do aceite 20 e do aceite 19 pela trilha.

**Contexto vinculado:**
- Spec aceite 20: "Nenhum caminho grava setor, turno ou nível da pessoa fora da função única (teste que cobre criação, edição, mover, tirar e a partir de contatos)." Aceite 19: "Duas trocas no mesmo dia deixam uma linha aberta só, e duas entradas na trilha."
- DV5: a trilha da troca é o evento da pessoa no mesmo `tx`; `move` e `remove` gravam `sector_people.person_moved`/`person_removed` com categoria `ASSIGNMENT`; edição e criação com as ações atuais.
- DV15(a) e (c): teste dos cinco caminhos e guarda estática que varre `backend/src/**/*.ts` e `backend/prisma/*.ts` (fora `*.spec.ts`, `*.test-fixtures.ts` e `users/assignment-writer.ts`), falhando se achar, no texto da chamada `.user.create|createMany|update|updateMany|upsert(` a partir da chave `data`, uma das chaves `sectorId|shiftId|levelId|sector|workShift|level`, ou qualquer `.userAssignment.create|createMany|update|updateMany|upsert|delete|deleteMany(`. A extração do texto da chamada é por contagem de parênteses, numa função de até 50 linhas; a mensagem de falha cita arquivo e linha.
- GV1: um caminho só.

**Passos:**
1. [ ] RED `assignment-paths.integration.spec.ts` (para cada caminho: exatamente uma linha aberta, igual ao espelho; linhas fechadas esperadas; um evento da trilha com a mudança de setor, turno ou nível). **Relógio fixo:** `vi.useFakeTimers({ toFake: ['Date'] })` no `beforeEach` (volta com `vi.useRealTimers()` no `afterEach`); a criação roda sob `vi.setSystemTime(new Date('2026-11-18T15:00:00Z'))` e a troca sob `vi.setSystemTime(new Date('2026-11-19T15:00:00Z'))` (ou a pessoa parte de linha com início em branco criada direto pelo Prisma). Sem isso criar e editar no mesmo dia dá `UPDATE_OPEN` (uma linha só), nunca "fecha e abre":
   - `it('convite (createUser) abre a linha com setor, turno e nível')`;
   - `it('pessoa sem acesso (POST /users e pessoa nova no setor) abre a linha')`;
   - `it('a partir de contatos abre uma linha por pessoa criada')`;
   - `it('edição (PATCH /users e PATCH do setor) de turno e nível, em dia depois da criação, fecha e abre')` (linha anterior com `validTo = '2026-11-18'`, nova com `validFrom = '2026-11-19'`);
   - `it('mover, em dia depois da criação, fecha no setor antigo e abre no novo; tirar do setor abre sem setor e mantém turno e nível')` (mesmas datas);
   - `it('criada e trocada no mesmo dia: uma linha só, atualizada')` (criação e troca sob `2026-11-19T15:00:00Z`; nenhuma linha fechada);
   - `it('duas trocas no mesmo dia: uma linha aberta e duas entradas na trilha')` (A→B→A sob `2026-11-19T15:00:00Z`, a pessoa vinda de linha anterior a esse dia).
2. [ ] RED `assignment-write-guard.spec.ts`: `it('nenhum arquivo fora do escritor grava setor, turno ou nível da pessoa nem UserAssignment')`; e um caso com texto de exemplo em memória provando que a varredura acusa `tx.user.update({ where, data: { sectorId } })`.
3. [ ] GREEN (só testes; se um caminho falhar **com o relógio fixado como acima**, é defeito de T3/T4a: relatar com o teste, não corrigir fora do ownership. Falha por criar e editar no mesmo dia sem relógio fixo é defeito do teste, não do serviço).
4. [ ] Validação: `TESTCONTAINERS_ENABLED=1 timeout 600 gate --test src/modules/users/assignment-paths.integration.spec.ts`; `timeout 600 gate --test src/modules/users/assignment-write-guard.spec.ts`; `timeout 600 gate --changed --base feat/permissoes-por-acao`.

**Aceite:** spec aceites 19 e 20.

**Risco: alto** (só testes; é a prova do aceite 20).

## Task 5 — Quadro da escala pela data (back)

**Arquivos:**
- Modificar: `backend/src/modules/staff-schedule/staff-schedule.repository.ts` (`listAssignedUserIds`, `loadAssignmentLines`); `staff-schedule.service.ts` (`board`, `loadPeople`); `board.ts` (`BoardPersonInput`, `buildBoardRows`, `boardDays`); `staff-schedule.service.spec.ts` (`describe` novos no topo e o builder de mocks) e `staff-schedule.repository.integration.spec.ts` (existe; `describe` novo).
- Criar: `backend/src/modules/staff-schedule/board.spec.ts`.

**Interfaces:**
- Consome: CV1 (client), CV2 (`assignmentOn`, `AssignmentLine`), `resolveDay`, `canEditPerson`, `nameView`.
- Produz: CV4. Contrato do quadro e front do quadro sem mudança.

**Contexto vinculado:**
- Spec Lote C, Leituras: "com data passada (quadro da escala e lista do dia do envio) usam o vínculo vigente naquela data; hoje e datas futuras usam o vínculo aberto"; "sem data (permissão do gestor, listagem do setor, token, montagem do envio) usam o espelho, como hoje". Aceite 17: "a escala de datas passadas … continua mostrando o setor antigo".
- DV9: data ≥ hoje → espelho; data < hoje → linha que cobre; nenhuma → espelho.
- DV10: membro do quadro de S = vínculo S em algum dia do período (`fromOtherSector: false`); senão, exceção "Outro setor" para S no período (`fromOtherSector: true`); senão fora. Cada dia por `resolveDay` com setor e turno do vínculo do dia (`WORK` em outro setor vira "Em <setor>" no front, que já existe). `canEdit` e `profileShiftId` da linha pelo espelho. Se `from` ≥ hoje, nenhuma consulta nova e resultado idêntico ao de hoje. Consultas de linha com fim `min(to, addDays(today, -1))`.
- CV4: assinaturas; `today` calculado uma vez em `board` e usado em `loadPeople`, `buildBoardRows` e no campo `today` da resposta. A escala não usa o nível: o espelho do quadro passa `levelId: null` a `assignmentOn`.
- DV16: filtro `isActive: true` mantido.
- Dia com setor nulo (pessoa tirada do setor) aparece como "Em outro setor" no front (`frontend/src/features/staff-schedule/board-cells.ts:18`); conferido na revisão, sem trabalho no quadro.
- GV7: nome por `nameView`, ordem pelo nome exibido com desempate por `userId` (já é assim em `buildBoardRows`; as pessoas novas entram pelo mesmo caminho).
- Limite de pessoas (`BOARD_PEOPLE_LIMIT`, `probe`, `truncated`): a união membros + vinculados no passado + visitantes segue o mesmo corte e a mesma sinalização.

**Passos:**
1. [ ] RED `board.spec.ts` (**não existe spec de `board.ts`: criar**):
   - `it('período que cruza a troca: dias antes no setor antigo, a partir de hoje no novo')` (Review Focus 4: today `2026-11-19`, linhas `null..2026-11-18` A e `2026-11-19..` B, período `2026-11-16..2026-11-22`; no quadro de A a pessoa é membro, `2026-11-18` resolve em A e `2026-11-19` em `WORK` com `sectorId` B; no de B também é membro);
   - `it('quadro só com datas passadas mostra quem estava no setor e esconde quem chegou depois')`;
   - `it('visitante por exceção continua fromOtherSector; quem nunca esteve nem visitou fica fora')`;
   - `it('canEdit e profileShiftId seguem o espelho')`.
2. [ ] RED `staff-schedule.service.spec.ts`: `it('from >= hoje não consulta linhas de vínculo')`; `it('usa o mesmo today no loadPeople e na resposta')`. O builder de mocks do repositório nesse spec (mocks escritos à mão; hoje fixado em 21/10, período 19/10 a 25/10, que cruza hoje) **ganha os dois métodos novos** `listAssignedUserIds` e `loadAssignmentLines` (por padrão `vi.fn` que devolve `[]` e `new Map()`), senão os testes existentes quebram ao chamá-los. Asserções existentes intactas.
3. [ ] RED integração do repositório: `it('listAssignedUserIds acha linha em branco no início, fechada e aberta que cruzam o período; ignora inativos')`; `it('loadAssignmentLines devolve as linhas que cruzam o período por pessoa')`. Linhas inseridas direto pelo Prisma no teste.
4. [ ] GREEN.
5. [ ] Validação: `timeout 600 gate --test` em cada spec tocado; integração com `TESTCONTAINERS_ENABLED=1`; typecheck do back; `timeout 600 gate --changed --base feat/permissoes-por-acao`.

**Aceite:** spec aceite 17 (escala de datas passadas mostra o setor antigo).

**Risco: alto** (muda quem aparece no quadro de datas passadas; para hoje e futuro o caminho é o atual).

## Task 6 — Lista do dia do envio pela data (back)

**Arquivos:**
- Modificar: `backend/src/modules/team-whatsapp/team-whatsapp.repository.ts` (`loadDayPeopleMany`; consultas privadas novas `findAssignedIdsOn(sectorIds, date)` e `findAssignmentsOn(userIds, date)`); `team-whatsapp.repository.integration.spec.ts` (`describe` novo).
- Criar: `backend/src/modules/team-whatsapp/team-member-assignment.ts` e `team-member-assignment.spec.ts`.
- Só teste (`describe` novo, sem mudar o código): o spec existente de `team-whatsapp.roster` (teste de `nameView`/`phoneView`).

**Interfaces:**
- Consome: CV1 (client), CV2 (`coversDate`), `todayIn`, `listVisitorIdsBySector` e `loadScheduleData` (sem mudança).
- Produz: CV5. `team-whatsapp.roster.ts`, o serviço e os contratos do envio não mudam.

**Contexto vinculado:**
- Spec Lote C, Leituras (texto em T5). Aceite 17: "trocar o setor de uma pessoa muda o público de envios novos; … os envios antigos continuam mostrando o setor antigo". "Histórico de envios não muda: já guarda a foto de setor, turno e nível de cada destinatário."
- DV11 (decisão do plano, a confirmar com a GBR): o contrato aceita qualquer data civil e a tela permite data passada; para data < hoje, as linhas de pessoa ganham setor (com `isActive` do setor da linha), turno e nível do vínculo da data **antes** do agrupamento `p.sectorId === sectorId || visitante`; a foto do destinatário sai desses valores; para hoje e o futuro, nenhuma consulta nova e resultado idêntico. Roster e criação usam a mesma regra porque a criação revalida a seleção contra a lista refeita (`team-whatsapp.service.ts:527-541`). Consequência aceita: envio novo com data passada para o setor A alcança quem estava em A naquela data, mesmo que hoje esteja em outro setor; o remetente vê essa pessoa, telefone conforme `telefone.ver_completo`.
- Pessoas da data passada: as do espelho nos setores pedidos (como hoje), mais as que tinham linha nesses setores cobrindo a data (`findAssignedIdsOn`, só ativas), mais os visitantes; os ids extras entram no parâmetro de ids de `findMembersForDay` (assinatura sem mudança).
- DV9 e DV16: sem linha que cubra = espelho; filtro `isActive` mantido.
- GV4 e anti-objetivo 1: no dia da implantação o envio de hoje não muda em nada.
- GV5: nada grava em `TeamWhatsappRecipient`/`TeamWhatsappDispatch` além do que já grava.
- GV7: nome segue o caminho atual (`nameView` no roster, `phoneView` no telefone); nenhuma lista nova.

**Passos:**
1. [ ] RED `team-member-assignment.spec.ts`: `it('sem linha devolve a linha da pessoa intacta')`; `it('com linha troca setor, isActive do setor, turno e nível pelos da data')`.
2. [ ] RED integração: `it('lista do dia de ontem usa o vínculo de ontem; a de hoje, o espelho')` (Review Focus 4: pessoa movida hoje de A para B, `today` explícito; ontem em A traz a pessoa com nível e turno da linha antiga, ontem em B não; hoje em B traz, hoje em A não).
   - Controle negativo (anti-objetivo 1): `it('hoje e data futura: loadDayPeopleMany não consulta UserAssignment e devolve exatamente o que devolvia')` (para `date` = hoje e para uma data futura: zero consultas a `UserAssignment` e resultado igual ao do caminho atual, com a mesma pessoa/ordem/campos do cenário sem linhas de vínculo).
   - Dado pessoal: `it('quem entra pela data passada sai com nome e telefone por nameView e phoneView, como os demais membros')` (pessoa que hoje está em outro setor e ontem estava em A; ator sem `telefone.ver_completo` recebe nome abreviado e telefone mascarado; com a permissão, completos; `nameView`/`phoneView` são aplicados hoje em `team-whatsapp.roster.ts:219-231`, e `loadDayPeopleMany` só devolve as linhas; então o teste passa a linha vinda de `withAssignmentOn` pelo mapeamento do roster, num `describe` novo no spec existente do roster, sem mudar o código dele).
3. [ ] GREEN.
4. [ ] Validação: `timeout 600 gate --test src/modules/team-whatsapp/team-member-assignment.spec.ts`; integração com `TESTCONTAINERS_ENABLED=1`; `timeout 600 gate --test` nos specs de `team-whatsapp.service` e `team-whatsapp.roster` (sem mudar); typecheck do back; `timeout 600 gate --changed --base feat/permissoes-por-acao`.

**Aceite:** spec aceite 17 (público de envio novo pelo vínculo atual; lista de data passada pelo vínculo da data).

**Risco: crítico (produção)**
**Crítico:** envio em produção e dado pessoal — para data passada muda quem entra na lista e no envio da equipe e que nome/telefone o remetente vê; hoje e futuro intocados por construção e por teste (controle negativo acima). Implementador e revisor `opus`.

## Task 7 — API "Vínculos" da pessoa (back)

**Arquivos:**
- Criar: `backend/src/schemas/contracts/person-assignments.schema.ts` e `person-assignments.schema.spec.ts`.
- Modificar: `backend/src/modules/audit-trail/audit-trail.controller.ts` (rota nova); `audit-trail.service.ts` (`personAssignments`; extrair o teste de acesso de `personHistory` num auxiliar privado usado pelos dois, sem mudar o comportamento de `personHistory`); `audit-trail.repository.ts` (`findAssignments(userId)`); `audit-trail.controller.spec.ts`, `audit-trail.service.spec.ts`, `audit-trail.repository.integration.spec.ts` (`describe` novos no topo); `backend/src/modules/permissions/route-parity.spec.ts` (só a linha da rota, abaixo).

**Interfaces:**
- Consome: CV1 (client), `canViewPersonHistory`, `inReach`, `auditTrailForbidden`, `auditTrailPersonNotFound`, `RequirePermission`, `fromDbDate`.
- Produz: CV6.
  ```ts
  // AuditTrailService
  personAssignments(actorId: string, userId: string): Promise<PersonAssignments>;
  // AuditTrailRepository
  findAssignments(userId: string): Promise<Array<{ id: string; validFrom: Date | null; validTo: Date | null;
    sector: { id: string; name: string } | null; shift: { id: string; name: string } | null;
    level: { id: string; name: string } | null }>>;
  ```

**Contexto vinculado:**
- Spec Lote C, Ficha: "seção 'Vínculos' com o histórico (setor, turno, nível, de, até), mais recente primeiro." Aceite 21. Spec A5 (conselho R2): "SUPERVISOR consulta pela ficha das pessoas que alcança (pessoa, vínculo e escala)."
- DV13: `GET /audit-trail/people/:userId/assignments`, `@RequirePermission('trilha.consultar')`, mesma regra de acesso do Histórico (`canViewPersonHistory(actor, inReach(actor, person.sectorId))`, alcance pelo espelho), mesmos 403/404; sem paginação; aberta primeiro, depois `to` decrescente (`orderBy` `validTo desc nulls first`, `validFrom desc nulls last`).
- CV6: forma exata da resposta; datas por `fromDbDate`; `from`/`to` nulos preservados.
- GV6: nenhuma regra de permissão nova; nada de `role ===` no serviço.
- GV7: a resposta não tem nome de pessoa; nomes de setor, turno e nível saem como estão.
- Lote B, regra do implementador: rota nova por permissão mantém no spec do controller uma negação (sem `trilha.consultar` → 403 `auth.permission_denied`) e uma concessão. `backend/src/modules/permissions/route-parity.spec.ts` exige registrar a rota (o teste "toda rota dos sete controllers está na tabela" falha sem ela): acrescentar `'AuditTrailController GET /people/:userId/assignments'` em `NEW_ROUTES` (constante `const NEW_ROUTES: readonly string[] = []`, hoje vazia; entradas no formato `` `${controller.name} ${route}` ``). **Não** acrescentar a rota à tabela `PARITY`: o teste compara `PARITY` com as rotas do controller menos `NEW_ROUTES`, então a rota nas duas listas o faria falhar. A cobertura de permissão da rota é a do spec do controller (acima). Mais nada nesse arquivo.

**Passos:**
1. [ ] RED `person-assignments.schema.spec.ts`: `it('aceita from e to nulos e recusa data fora de AAAA-MM-DD')`.
2. [ ] RED `audit-trail.service.spec.ts`: `it('SUPERVISOR vê os vínculos de quem alcança e recebe 403 fora do alcance')`; `it('pessoa inexistente: 404 para quem vê qualquer pessoa, 403 para os demais')`; `it('personHistory continua com as mesmas respostas')`.
3. [ ] RED `audit-trail.controller.spec.ts`: `it('sem trilha.consultar responde 403 auth.permission_denied; com, 200')`.
4. [ ] RED integração do repositório: `it('devolve aberta primeiro e depois por fim decrescente, com nomes de setor, turno e nível')`; `it('setor inativado depois continua aparecendo pelo nome na linha fechada')`.
5. [ ] GREEN.
6. [ ] Validação: `timeout 600 gate --test` em cada spec tocado; integração com `TESTCONTAINERS_ENABLED=1`; typecheck do back; `timeout 600 gate --changed --base feat/permissoes-por-acao`.

**Aceite:** spec aceite 21 (parte API: o histórico de vínculos com de e até, mais recente primeiro).

**Risco: crítico (autorização)**
**Crítico:** autorização — rota nova que devolve o histórico de vínculo de uma pessoa; o gate é `trilha.consultar` mais o alcance por setor, compartilhado com o Histórico; um erro expõe a ficha de pessoas fora do alcance do SUPERVISOR.

## Task 8 — Seção "Vínculos" no Histórico da pessoa (front)

**Arquivos:**
- Modificar em `frontend/src/features/audit-trail/`: `schemas.ts` (`personAssignmentsSchema`); `api.ts` (`usePersonAssignments`); `components/person-history-dialog.tsx` (monta a seção no topo do corpo); `components/person-history-dialog.spec.tsx` (só o `vi.mock` do módulo novo e um `describe` novo no topo; asserções existentes intactas, passo 2).
- Criar: `components/person-assignments.tsx` e `components/person-assignments.spec.tsx`.

**Interfaces:**
- Consome: CV6 (forma da resposta), `formatDatePtBr` (`frontend/src/lib/format-date-ptbr.ts`), `api` (`@/lib/api-client`), o padrão de `usePersonHistory`.
- Produz: CV7.

**Contexto vinculado:**
- Spec Lote C, Ficha: "seção 'Vínculos' com o histórico (setor, turno, nível, de, até), mais recente primeiro." Aceite 21.
- DV14: seção no topo do `PersonHistoryDialog`, título "Vínculos"; colunas "Setor", "Turno", "Nível", "De", "Até"; datas `DD/MM/AAAA` por `formatDatePtBr`; início em branco "Anterior ao histórico"; fim em branco "Atual"; vazio "Sem setor", "Sem turno", "Sem nível"; carregando "Carregando vínculos…"; erro "Não foi possível carregar os vínculos."; lista vazia "Nenhum vínculo registrado.". A ordem é a da API.
- CV7: chave `['audit-trail', 'people', userId, 'assignments']`, `GET audit-trail/people/:userId/assignments`, parse por `personAssignmentsSchema`.
- Quem vê: quem abre o Histórico (`canViewPersonHistoryUi`); nenhuma regra nova de tela.
- Padrão de teste (mapa): `vi.hoisted` + `vi.mock('@/lib/api-client', () => ({ api: { get } }))`, `QueryClient` com `retry: false`, resposta `mocks.get.mockReturnValue({ json: () => Promise.resolve(body) })`, erro com `HTTPError` (ky 2: o corpo do erro só em `HTTPError.data`, ler por `readApiErrorBody`).
- GV14: textos exatos acima; GV12: sem `prettier --write` nos arquivos existentes.

**Passos:**
1. [ ] RED `person-assignments.spec.tsx`: `it('mostra setor, turno, nível, de e até na ordem da API')`; `it('início em branco mostra "Anterior ao histórico" e fim em branco "Atual"')`; `it('vazio mostra Sem setor, Sem turno e Sem nível')`; `it('erro mostra "Não foi possível carregar os vínculos."')`.
2. [ ] `person-history-dialog.spec.tsx` (existente: seu mock responde a **todo** `GET` com o mesmo corpo, os testes leem `mocks.get.mock.lastCall?.[1].searchParams`, o `mockImplementation` lê `options.searchParams.page` e há `toHaveBeenLastCalledWith`; com a segunda consulta, a de vínculos, no diálogo eles quebrariam):
   - Os testes existentes ficam com as **asserções intactas**. A seção nova é isolada neles com um `vi.mock` do módulo novo, no topo do arquivo: `vi.mock('./person-assignments', () => ({ PersonAssignments: () => <div data-testid="person-assignments" /> }))` (stub sem texto e sem consulta; só um marcador vazio), de modo que só a consulta do Histórico chega a `mocks.get`. Se algum teste existente falhar por causa do marcador, o stub passa a renderizar `null` e o teste de posição abaixo usa `vi.mocked` ou é descartado em favor do spec próprio; nunca se mexe na asserção existente.
   - **Proibido** afrouxar `lastCall`, `toHaveBeenLastCalledWith` ou trocar o mock geral por um que aceite qualquer GET.
   - Os testes da seção ficam no spec próprio `person-assignments.spec.tsx`. Nesse spec do diálogo entra só um `describe` novo, no topo: `it('o Histórico mostra a seção Vínculos acima das alterações')` (confere o marcador `person-assignments` antes da lista de alterações).
3. [ ] GREEN.
4. [ ] Validação: `timeout 600 gate --test` em cada spec tocado; `npx tsc -b`; `timeout 600 gate --changed --base feat/permissoes-por-acao`.

**Aceite:** spec aceite 21 (a ficha mostra o histórico de vínculos com de e até).

**Risco: médio** (tela de leitura; a API decide o acesso).

## Task 9 — Novidades (front)

**Arquivos:**
- Modificar: `frontend/src/release-notes.ts` (entrada nova no topo de `RELEASE_NOTES`).

**Interfaces:**
- Consome: formato atual de `RELEASE_NOTES` (`version` 'AAAA.MM.DD' ou 'AAAA.MM.DD.n', `date`, `title`, `items: [{ text, where? }]`, decrescente; a mais recente é `2026.11.19.1`).
- Produz: nota de versão do Lote C.

**Contexto vinculado:**
- Spec Lote C, Novidades: "nota de versão explicando que trocar o setor de alguém não muda mais o passado."
- DV17: versão `2026.11.19.2` se for hoje; em outro dia, `AAAA.MM.DD` do dia.
- `frontend/CLAUDE.md`: texto pt-BR para o operador; `where` só quando há tela para linkar (o Histórico é diálogo: sem `where`); entrada nova no topo.
- Texto: título "Histórico de vínculos"; item "Trocar o setor, o turno ou o nível de alguém não muda mais o passado: a escala de dias anteriores e os envios antigos continuam mostrando onde a pessoa estava. A troca vale a partir de hoje, e o histórico de cada pessoa aparece em Histórico, na seção Vínculos."

**Passos:**
1. [ ] Adicionar a entrada; `timeout 600 gate --test src/release-notes.spec.ts`; `timeout 600 gate --changed --base feat/permissoes-por-acao`.

**Aceite:** spec Lote C, Novidades.

**Risco: baixo**

## Fechamento (principal)

1. Conferir o ledger: T1 a T9 (com T4a e T4b) aceitas; revisões críticas com `opus` feitas (T1, T3, T4a, T6, T7).
2. Gate completo do back e do front, uma vez cada, no estado final, comparado com a base do Lote B (`.superpowers/sdd/2026-11-19-orgamind-gbr-etapa1-lote-b-permissoes/final-back-gate-full-2.log` e `final-front-gate-full-2.log`; memória: `--base origin/main` para o completo, dívida legada conhecida). Bloquear violação nova ou agravada.
3. Migração numa cópia com dados no banco local de QA (`orgamind-turnos-qa`, seed fictício Marina/Rafael): `prisma migrate deploy`; conferir `count(*)` de linhas abertas = `count(*)` de `User`, zero linhas abertas diferentes da ficha (as duas consultas do `DO`), contagem de pessoas e de eventos da trilha igual à de antes.
4. Boot real da API e do worker na stack local (worker: conferir que sobe; a stack de QA não tem worker nem Evolution, segundo a memória: registrar como lacuna se não der).
5. Fumaça HTTP do aceite 17 (T01): mover uma pessoa de A para B; `GET` do quadro de A com período só de datas passadas mostra a pessoa com os dias em A; o quadro de B para hoje mostra a pessoa; o roster de hoje de B a traz e o de A não; o roster de ontem de A a traz; um envio criado antes da troca continua com o `sectorName` antigo nos destinatários; `GET /audit-trail/people/:id/assignments` mostra duas linhas (aberta hoje e fechada ontem). Mover de volta no mesmo dia: uma linha aberta só e mais uma entrada na trilha (aceite 19).
6. QA visual (agente `qa`, Playwright): seção Vínculos no Histórico (lista de usuários e página do setor), com "Anterior ao histórico" e "Atual"; quadro de um período que cruza a troca mostrando "Em <setor>" nos dias do outro setor; nota em Novidades.
7. Revisão final do conjunto com `opus`.
8. Commit do lote e PR rascunho sobre `feat/permissoes-por-acao`, só com pedido do usuário (memória: merge e deploy exigem pedido explícito).
9. Registrar a decisão DV11 na spec (`docs/superpowers/specs/2026-11-19-orgamind-gbr-etapa1-cadastro-permissoes.md`), na seção "Para a GBR confirmar": a lista do dia de um envio com **data passada** usa o vínculo da data, então alcança quem estava no setor naquela data mesmo que hoje esteja em outro, e o remetente vê essa pessoa (telefone conforme `telefone.ver_completo`); hoje e datas futuras não mudam.

## Não verificado

- Se o Postgres reporta a inserção concorrente de linha aberta como `40001` (`P2034`) ou como `23505` (`P2002`) dentro da transação serializável, e se o `meta.target` do `P2002` traz o nome do índice parcial (que não está no schema Prisma). O teste de concorrência da T3 decide a forma da repetição.
- Se um `prisma migrate dev` futuro tenta remover o índice parcial e o `CHECK` (há precedente de índice parcial em `20260709120000_multi_provider_channel`; não conferi como ficou o schema dele). O spec da T1 falha se sumirem.
- **Limitação aceita, nos dois sentidos, do visitante por exceção "Outro setor" na lista do dia de data passada** (`listVisitorIdsBySector` filtra pelo espelho): (a) pessoa hoje em S que, na data, estava em A com exceção "Outro setor" para S não aparece em S; (b) pessoa hoje em A que, na data, estava em S com exceção "Outro setor" para A também some da lista de A. Casos raros; não tratados neste lote.

**Resolvido lendo o código (revisão 1), registrado onde a task precisa:** Lote B commitado (Preparação, passo 1); `dropOrder` e `Restrict` (T1, passo 3); dia com setor nulo no quadro (T5); tela com data passada (DV11); campos de `TeamMemberRow` e specs de integração existentes (T5 e T6); chave do Histórico no front (T8); spec que monta os serviços reais (T4b).

## Estado (19/11/2026)

Lote implementado e validado no branch `feat/vinculo-vigencia` (sobre `feat/permissoes-por-acao`, PR 14). Sem merge e sem deploy.

**Feito:** T1 a T9 (com T4a e T4b) aceitas, mais três acertos de fechamento. Tabela `UserAssignment` com uma linha aberta por pessoa; escrita só por `writeAssignment`, dentro da transação do repositório de usuários; quadro da escala e lista do dia do envio leem o vínculo da data quando ela já passou; rota `GET /audit-trail/people/:userId/assignments` e seção "Vínculos" no diálogo Histórico; entrada `2026.11.19.2` nas Novidades.

**Decisões além do plano (na spec, "Para a GBR confirmar" → "Decisões minhas no Lote C"):**
- Envio da equipe com data passada usa o vínculo daquela data, na lista e na criação do envio. Vale também na rotina: o atalho "Ver esse turno" do turno da noite em andamento usa a data de ontem.
- Em data passada, quem hoje é do setor mas naquele dia estava em outro e trabalhou ali por "Outro setor" aparece como visitante.
- Vínculo de pessoa nova começa no dia do cadastro; A→B→A no mesmo dia não junta linhas; "Vínculos" usa a permissão e o alcance do Histórico; setor, turno e nível com histórico ficam com `Restrict`; as linhas de vínculo saem junto com a pessoa excluída.

**Validação:**
- Revisão independente por task (opus nas críticas: T1, T3, T4a, T6, T7; sonnet nas demais) e revisão final do conjunto (opus): sem Critical nem Important. Os três Minor da revisão final: desempate diferente entre quadro e lista (backlog), atalho da noite citado na spec (feito), frase nas Novidades sobre a lista de data passada (feito).
- Gate por diff contra `feat/permissoes-por-acao`: PASS (1195/1195 no back com banco real, cobertura 100% das 160 linhas novas, duplicação 0%).
- Gate completo comparado com a base do Lote B: back 6118/6148 (30 ignorados de sempre, 0 falhas), front 2064/2064; lint, sonar e complexidade iguais à base nos dois (0 novos, 0 agravados). `tsc` limpo nos dois. Os specs de integração do lote rodaram com Postgres real (conferido no `vitest.json`).
- Migração `20261119110000_user_assignment_history` aplicada no banco local de QA: 43 pessoas, 43 linhas abertas, 0 diferentes da ficha; pessoas e trilha sem alteração.
- Boot real da API e do worker na stack local, sem erro.
- Fumaça HTTP do aceite 17 na API real: mover de Produção para Manutenção abre a linha de hoje e fecha a antiga ontem; o quadro e a lista do dia de ontem continuam mostrando Produção, os de hoje mostram Manutenção; 22 destinatários antigos da pessoa idênticos antes e depois; segunda troca no mesmo dia mantém uma linha aberta e soma duas entradas na trilha.
- QA visual local (Administrador): seção "Vínculos" com "Anterior ao histórico" e "Atual", controle negativo com uma linha só, quadro com "Em Produção"/"Em Manutenção" nos dias certos, Novidades com os dois itens. 5 de 5.

**Ocorrência:** a máquina reiniciou no meio do fechamento, com o gate completo do back e a stack de QA rodando juntos. A primeira execução do gate teve uma falha em `excel-import` (módulo fora do lote) que não se repetiu com a máquina livre. Nada se perdeu no repositório; gates, boot, fumaça e QA foram refeitos depois, um de cada vez.

**Pendências e limitações (backlog):**
- A corrida na troca de vínculo responde 409 com o código e o texto de "troca de administrador" (`user.concurrent_admin_change`); trocar exige back e front juntos.
- No Histórico, 403/404 mostra dois alertas (o da seção e o do histórico).
- Quadro: o corte de 500 pessoas acontece antes de escolher as linhas da data, então `truncated` pode vir verdadeiro com menos linhas visíveis; falta teste de integração nos limites exatos do intervalo.
- Quadro e lista desempatam de forma diferente se duas linhas cobrirem o mesmo dia (impossível hoje: escritor e índice único).
- A guarda estática não pega `data` montado em variável (a recusa no repositório cobre); o teste de integração da corrida só observou `P2034` (o formato do `P2002` está fixado em teste unitário).
- `P2025`/`P2003` continuam sem tradução (500 se um id some entre a conferência e a gravação, como antes).
- Banco local de QA: a pessoa `qa_u_maria` ficou com duas linhas de vínculo (as duas em Produção) e seis entradas de teste na trilha.
- Minors das revisões por task estão no ledger (`.superpowers/sdd/2026-11-19-orgamind-gbr-etapa1-lote-c-vinculo/progress.md`).

**Antes de qualquer deploy:**
- Publicar código e migração juntos, e back e front juntos (contrato novo). Versão antiga do app gravando depois da migração deixa a ficha diferente do histórico até a próxima gravação, e o valor intermediário se perde.
- Se a conferência da migração ou o limite de 15 s de espera por lock abortar, a migração inteira é desfeita e os deploys seguintes param em `P3009` até rodar `prisma migrate resolve --rolled-back 20261119110000_user_assignment_history`.
- Setor, turno e nível com histórico não podem mais ser apagados direto no banco.

**Próximo:** Etapa 2 (CAD-04 exportação, CAD-03 importação), em branch novo a partir deste.
