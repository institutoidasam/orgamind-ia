# WhatsApp da equipe — ajustes de UX (19/10) Implementation Plan

> **For agentic workers:** executar pela skill `sdd` (TDD, ledger em `.superpowers/sdd/2026-10-19-orgamind-team-whatsapp-ux/progress.md`). Sem commit/push.

**Goal:** três ajustes achados no teste real do GBR (19/10/2026): canais não conectados aparecem desabilitados com a situação no "Enviar WhatsApp"; "Envios recentes" mostra o motivo de falhas e pulados por destinatário; "Copiar senha" temporária tem fallback.

**Architecture:** o back acrescenta dois campos aos contratos `GET /internal/team-whatsapp/targets` e `GET /internal/team-whatsapp/dispatches` (aditivo, mesma autorização). O front espelha os campos em `features/team-whatsapp/schemas.ts`, decide a disponibilidade do canal num helper puro e traduz os códigos em pt-BR. O modal de senha ganha campo somente leitura e cópia em três degraus.

**Tech Stack:** NestJS + Prisma + Zod + Vitest (backend); React + TanStack Query + Radix Select + sonner + Vitest/Testing Library (frontend).

**Spec:** design aprovado pelo usuário em 2026-10-19 (canais inválidos desabilitados com a situação; detalhe com falhas e pulados), registrado no ledger acima; feature de origem `docs/superpowers/specs/2026-10-16-orgamind-user-phone-whatsapp.md`.

## Global Constraints

- Textos de UI em pt-BR. Nenhum telefone de destinatário no contrato novo (o `TeamWhatsappRecipient` não guarda telefone; não fazer join com `User`/`Contact`).
- Estado de conexão ausente (`null`) NUNCA significa "desconectado" (eventos expiram em 7 dias — `whatsapp-providers.repository.ts:40-52`).
- Sem dependência nova. Sem migração. Sem rota nova.
- Fechamento de cada task: `gate --changed --base origin/main` com cwd `frontend/` ou `backend/`.
- Mudança visível ao operador entra em `frontend/src/release-notes.ts` (ver `frontend/CLAUDE.md`).

## Review Focus

1. Canal com `connectionState: null` e telefone conhecido (evento expirado) tem de continuar selecionável — T2 testa.
2. Canal escolhido que fica inutilizável após refetch não pode continuar enviável — T2 testa (`canSend` falso).
3. Estado gravado fora do enum (`'qrcode'`, string qualquer) não pode quebrar o parse do contrato — T1 normaliza para `null` e testa.
4. Código de erro desconhecido ou `null` mostra texto genérico, nunca "undefined" — T3 testa.
5. `navigator.clipboard` ausente (contexto http) cai no fallback sem exceção — T4 testa.

---

### Task 1: back — estado do canal e problemas por envio

**Files:**
- Modify: `backend/src/schemas/contracts/team-whatsapp.schema.ts`
- Modify: `backend/src/modules/team-whatsapp/team-whatsapp.repository.ts` (`listEligibleChannels`, nova `listIssues`)
- Modify: `backend/src/modules/team-whatsapp/team-whatsapp.service.ts` (`targets`, `listDispatches`, `toListItem`)
- Test: `backend/src/modules/team-whatsapp/team-whatsapp.service.list.spec.ts`; `team-whatsapp.repository.integration.spec.ts` só se o projeto já cobre ali `listEligibleChannels`/`countByStatus`

**Interfaces (Produces — contrato que o front espelha):**
- `teamConnectionStateSchema = z.enum(['open', 'connecting', 'close'])`
- cada item de `channels`: `+ connectionState: teamConnectionStateSchema.nullable()`
- cada item de `items` da listagem: `+ issues: { name: string; status: 'FAILED' | 'SKIPPED'; reason: string | null }[]`
  - `reason` = `errorCode` quando FAILED, `skipReason` (`'NO_PHONE' | 'SUPPRESSED'`) quando SKIPPED.
  - ordem: FAILED antes de SKIPPED; dentro do grupo, `name` asc. Envio sem problema → `[]`.
- Repository: `listIssues(dispatchIds: readonly string[]): Promise<TeamIssueRow[]>` com `TeamIssueRow = { dispatchId; userName; status; errorCode; skipReason }`; `[]` sem consulta quando a lista é vazia. `where: { dispatchId: { in }, status: { in: ['FAILED','SKIPPED'] } }`.
- `listEligibleChannels` passa a selecionar `connectionEvents: { orderBy: { occurredAt: 'desc' }, take: 1, select: { state: true } }` (o mesmo de `findChannel`); o service converte para `connectionState` e não devolve `connectionEvents`.

- [ ] **Step 1: testes RED em `team-whatsapp.service.list.spec.ts`**
  - `targets`: canal com último estado `'open'` → `connectionState: 'open'`; sem evento → `null`; estado `'qrcode'` (fora do enum) → `null`; a resposta não contém `connectionEvents`; `teamTargetsResponseSchema.parse` aceita a resposta.
  - `listDispatches`: envio com 1 FAILED (`errorCode 'evolution.session_closed'`, `userName 'Bia'`) e 2 SKIPPED (`'Caio'` NO_PHONE, `'Ana'` SUPPRESSED) → `issues` = `[{name:'Bia',status:'FAILED',reason:'evolution.session_closed'},{name:'Ana',status:'SKIPPED',reason:'SUPPRESSED'},{name:'Caio',status:'SKIPPED',reason:'NO_PHONE'}]`; envio sem problemas → `issues: []`; `listIssues` chamado uma vez com os ids da página; `teamDispatchListResponseSchema.parse` aceita.
- [ ] **Step 2:** `gate --test src/modules/team-whatsapp/team-whatsapp.service.list.spec.ts` → FAIL pelos campos ausentes.
- [ ] **Step 3:** implementar schema, repository e service conforme Interfaces. Escopo de autorização inalterado (`listIssues` só recebe ids já filtrados por `listDispatches`).
- [ ] **Step 4:** mesmo comando → PASS; specs vizinhos do módulo (`team-whatsapp.service.spec.ts`, `controller.spec.ts`) verdes.
- [ ] **Step 5:** `gate --changed --base origin/main` (cwd `backend/`) → PASS.

### Task 2: front — seletor de canal com situação

**Files:**
- Modify: `frontend/src/features/team-whatsapp/schemas.ts` (espelha os DOIS campos da Task 1: `connectionState` e `issues`)
- Create: `frontend/src/features/team-whatsapp/channel-availability.ts` + `channel-availability.spec.ts`
- Modify: `frontend/src/features/team-whatsapp/components/send-whatsapp-dialog.tsx` + `send-whatsapp-dialog.spec.tsx`
- Modify (só fixtures, para o `tsc -b` passar): `frontend/src/routes/_authenticated/whatsapp-equipe/index.spec.tsx`, `frontend/src/features/team-whatsapp/api.spec.ts` se usar os tipos

**Interfaces:**
- Consumes: contrato da Task 1 (pode rodar em paralelo, com mocks).
- Produces: `TeamChannel.connectionState: 'open' | 'connecting' | 'close' | null`; `DispatchList['items'][number].issues` (tipo acima); `channelAvailability(c: Pick<TeamChannel, 'connectionState' | 'phoneE164'>): { usable: true } | { usable: false; label: 'Desconectado' | 'Aguardando conexão' }`.

Regra (`channelAvailability`): `'open'` → usable; `'close'` → Desconectado; `'connecting'` → Aguardando conexão; `null` com `phoneE164` → usable; `null` sem `phoneE164` → Aguardando conexão.

- [ ] **Step 1: testes RED**
  - `channel-availability.spec.ts`: as 5 linhas da regra.
  - `send-whatsapp-dialog.spec.tsx`:
    - inutilizável aparece como opção desabilitada com o texto `ROBO · — · Aguardando conexão` e `Atendimento · (92) … · Desconectado`; utilizáveis vêm antes;
    - com 1 utilizável + 2 inutilizáveis o utilizável já vem escolhido (Enviar habilitado após digitar);
    - com 2 utilizáveis nada vem escolhido;
    - com 0 utilizáveis (e canais existentes) aparece `Nenhum canal conectado — reconecte em Números e canais.` e Enviar fica desabilitado;
    - canal escolhido que vira `'close'` num rerender com dados novos → Enviar desabilitado;
    - lista vazia mantém `Nenhum canal GoZap ou Evolution ativo.`
- [ ] **Step 2:** `gate --test` nos dois specs → FAIL.
- [ ] **Step 3:** implementar. `SelectItem disabled` nos inutilizáveis; `channelId` só resolve para canal utilizável (escolhido e ainda utilizável, ou o único utilizável).
- [ ] **Step 4:** specs → PASS; `index.spec.tsx` e `api.spec.ts` verdes.
- [ ] **Step 5:** `gate --changed --base origin/main` (cwd `frontend/`) → PASS.

### Task 3: front — motivos em "Envios recentes" + Novidades

Depende da Task 2 (tipos de `schemas.ts`).

**Files:**
- Modify: `frontend/src/features/team-whatsapp/error-messages.ts` + `error-messages.spec.ts`
- Modify: `frontend/src/features/team-whatsapp/components/recent-dispatches.tsx`
- Test: `frontend/src/routes/_authenticated/whatsapp-equipe/index.spec.tsx` (describe "envios recentes")
- Modify: `frontend/src/release-notes.ts` (entrada `2026.10.19` no topo, cobrindo os três ajustes; `where: '/whatsapp-equipe'` nos dois primeiros)

**Interfaces:**
- Consumes: `issues` (Task 2), `SKIP_REASON_LABEL` existente.
- Produces: `failureReasonLabel(code: string | null): string`; `issueLabel(issue): string` (SKIPPED → `SKIP_REASON_LABEL[reason]` ou `'pulado'`; FAILED → `failureReasonLabel`).

Textos exatos de `failureReasonLabel`:
| Códigos | Texto |
|---|---|
| `evolution.session_closed`, `evolution.not_connected`, `evolution.session_unstable`, `gozap.not_connected`, `team_whatsapp.channel_disconnected` | `Canal desconectado — reconecte em Números e canais` |
| `team_whatsapp.channel_invalid` | `Canal removido ou inválido — escolha outro canal` |
| `evolution.number_not_on_whatsapp`, `gozap.not_on_whatsapp`, `gozap.invalid_recipient` | `Número sem WhatsApp ou inválido — confira o telefone no cadastro` |
| qualquer código terminado em `.timeout`, `evolution.unknown`, `gozap.unknown`, `gozap.indeterminate`, `team_whatsapp.indeterminate` | `Sem confirmação do WhatsApp — confira no celular antes de reenviar` |
| `evolution.rate_limited`, `gozap.quota_exceeded` | `Limite de envios do canal atingido — tente mais tarde` |
| `evolution.unreachable`, `evolution.unauthorized`, `evolution.provider_unauthorized`, `gozap.unreachable`, `gozap.unauthorized`, `gozap.no_token`, `team_whatsapp.queue_unavailable` | `Serviço de WhatsApp indisponível — avise o administrador` |
| `null` | `Falha no envio` |
| outro | `Falha no envio (código <code>)` |

- [ ] **Step 1: testes RED**
  - `error-messages.spec.ts`: um código de cada linha da tabela, `'gozap.timeout'` pelo sufixo, `null`, e `'x.y'` → `Falha no envio (código x.y)`.
  - `index.spec.tsx`: linha com `issues` mostra `Ver motivos` (elemento `<details>`/`<summary>`); ao abrir lista `Bia — Canal desconectado — reconecte em Números e canais` e `Caio — sem telefone`; linha com `issues: []` não mostra `Ver motivos`; nenhum texto com `+55` na tabela.
- [ ] **Step 2:** `gate --test` nos dois specs → FAIL.
- [ ] **Step 3:** implementar. `<details>` dentro da célula "Situação", abaixo das contagens; itens em `<ul>`.
- [ ] **Step 4:** specs → PASS; `release-notes.spec.ts` verde.
- [ ] **Step 5:** `gate --changed --base origin/main` (cwd `frontend/`) → PASS.

### Task 4: front — fallback de "Copiar senha"

Independente das demais.

**Files:**
- Modify: `frontend/src/features/users/components/temporary-password-modal.tsx` + `temporary-password-modal.spec.tsx`

**Interfaces:**
- Produces: nada consumido por outras tasks. A senha fica num `<input readOnly aria-label="Senha temporária">` dentro do modal, dentro do focus trap do Radix: nada de textarea solta no `body`.

Degraus de `handleCopy`:
1. `navigator.clipboard.writeText` (ausente ou rejeitado → degrau 2);
2. `input.select()` + `document.execCommand('copy')` (retorno `true` → sucesso);
3. deixa o campo focado e selecionado, com `toast.info('Senha selecionada', { description: 'Pressione Ctrl+C para copiar.' })`.

O toast de erro `Não foi possível copiar` só aparece se o degrau 3 lançar. Sucesso nos degraus 1–2 mostra o ícone `Check` como hoje.

- [ ] **Step 1: testes RED**
  - clipboard rejeita e `execCommand` devolve `true` → ícone de sucesso e nenhum `toast.error`;
  - `navigator.clipboard` indefinido e `execCommand` devolve `true` → sucesso;
  - os dois falham → `toast.info` chamado, o input é o `document.activeElement` e `selectionStart`/`selectionEnd` cobrem a senha, nenhum `toast.error`;
  - caminho feliz atual e teste de desmontagem continuam.
  - Ajustar o teste existente "shows a fallback toast when clipboard write fails" ao contrato novo.
- [ ] **Step 2:** `gate --test src/features/users/components/temporary-password-modal.spec.tsx` → FAIL.
- [ ] **Step 3:** implementar. `execCommand` é API deprecada: se o lint/SONAR do gate acusar, usar disable de linha com justificativa curta (fallback intencional para contexto sem permissão de clipboard), sem mexer na configuração do lint.
- [ ] **Step 4:** spec → PASS.
- [ ] **Step 5:** `gate --changed --base origin/main` (cwd `frontend/`) → PASS.

---

## Fechamento (principal)

- `gate` completo em `frontend/` e `backend/` no estado final (dívida legada conhecida: comparar com o baseline do ledger de 2026-10-16).
- QA local pelo `qa`: stack dev, ADMIN logado, canais nos estados `open`/`close`/`null` sem telefone e envio com FAILED/SKIPPED montados por SQL; rotas `/whatsapp-equipe` e `/users`.
