# Correções pós-plano GBR

> Implementar com a skill `sdd`. Cada task termina com `gate --changed` sobre a base `main`.

**Goal:** fechar os achados menores dos Lotes C e K que ainda têm efeito para quem usa o sistema.

**Architecture:** correções pontuais, sem migração, sem rota nova e sem mudar contrato de API.

**Tech Stack:** NestJS, BullMQ e Vitest no `backend/`; React, TanStack Query, ky 2 e Vitest no `frontend/`.

**Origem:** triagem dos ledgers em `.superpowers/sdd/2026-11-*/progress.md`, conferida no código em `84ca962`.

## Global Constraints

- Nenhuma mensagem real sai pelo WhatsApp em teste ou QA.
- Sem migração, sem dependência nova, sem alterar `*.bak`.
- `prettier --write` só em arquivo novo. Em arquivo existente, ajustar à mão as linhas tocadas.
- Spec com `describe` de no máximo 50 linhas.
- Texto de interface em português, escrito para o operador.
- Erro do ky 2 é lido com `readApiErrorBody`.

## Review Focus

- Falha de mídia antes do Dify não pode gerar resposta duplicada nem deixar a conversa sem pausa.
- Falha ao enviar a mensagem de contingência não pode impedir a pausa do robô.
- Erro de autorização não pode sugerir "tente de novo".
- O aviso de lista incompleta só aparece quando a API devolve `truncated: true`.
- O 409 de vínculo mostra texto em português sem perder o tratamento dos demais erros.

## Fora deste plano

Ficam no backlog, com motivo:

- Falha do banco entre gravar a `Message` e reabrir a conversa (K1:52,57). É anterior ao K1, exige falha no meio do fluxo e pede redesenho da ingestão.
- Erro de banco no meio de uma passagem de turno (K3:45). Repetir é seguro: o que já passou volta como `already_with_target`.

---

### Task E1: build do backend volta a gerar `dist/main.js` (PR #26)

**Files:**
- Modify: `backend/tsconfig.build.json`

Fixtures de teste em `src/` (`*.test-fixtures.ts`, `*.fixtures.ts`) importam `test/migrations.ts`. Como esse arquivo fica fora de `src/`, o TypeScript sobe a raiz e a saída vai para `dist/src/`. O `CMD` da imagem (`node dist/main.js`), o worker (`dist/worker.js`) e a checagem `dist/shared/config/validate-consent-salt.js` deixam de existir.

- [ ] Excluir as fixtures do build, depois de confirmar que nenhum código de produção as importa.
- [ ] Fixar `"rootDir": "./src"` no `tsconfig.build.json`, para que um import de fora de `src/` quebre o build.
- [ ] `nest build` gera `dist/main.js`, `dist/worker.js` e `dist/shared/config/validate-consent-salt.js`, sem nenhum `*fixtures*` em `dist/`.
- [ ] `gate --changed --base main` no `backend/`.

### Task E2: formulário de cadastro de usuário alcançável em tela baixa (PR #26)

**Files:**
- Modify: `frontend/src/features/users/components/invite-user-dialog.tsx`
- Test: spec existente do diálogo, se cobrir a classe; a prova principal é o e2e `users-phone.spec.ts`

O diálogo não tem altura máxima. A 1280x720, o botão "Cadastrar" fica fora da tela e não é alcançável. O padrão do projeto é `max-h-[90vh] overflow-y-auto` no `DialogContent`.

- [ ] Aplicar o padrão ao diálogo.
- [ ] Conferir os outros formulários de pessoa alterados no Lote A e aplicar o mesmo padrão onde o conteúdo passar da tela a 1280x720.
- [ ] `gate --changed --base main` no `frontend/` e `npx tsc -b`.

### Task 1: robô passa para humano quando a mídia falha

**Files:**
- Modify: `backend/src/modules/bots/bot-reply.service.ts`
- Test: `backend/src/modules/bots/bot-reply.k3.spec.ts` ou spec novo no mesmo diretório

**Interfaces:**
- Consumes: `handleFailure(conversationId, botId, fallbackMessage, err)`.
- Produces: nenhuma interface nova.

Hoje `buildFiles` roda fora do `try/catch` do Dify. Uma falha no storage ou no upload relança, o BullMQ esgota as tentativas e o cliente fica sem resposta, sem pausa e sem aviso.

- [ ] Teste RED: `store.getBuffer` rejeita. Espera uma contingência enviada quando o bot tem `fallbackMessage`, `setBotPaused` chamado, `bot.reply_failed` auditado, `dify.chat` não chamado, a promessa resolve (não relança) e a trava é liberada.
- [ ] Teste RED: `dify.uploadFile` rejeita, com as mesmas expectativas.
- [ ] Teste RED: bot sem `fallbackMessage` e mídia falhando pausa sem enviar nada.
- [ ] Implementar: falha de `buildFiles` vai para `handleFailure` e retorna.
- [ ] `gate --changed --base main` no `backend/`, com `TESTCONTAINERS_ENABLED=1`.

### Task 2: passagem de pendências explica permissão e lista incompleta

**Files:**
- Modify: `frontend/src/features/team-pendencies/handover-api.ts`
- Modify: `frontend/src/features/team-pendencies/components/pendency-handover-dialog.tsx`
- Modify: `frontend/src/release-notes.ts`
- Test: specs existentes desses módulos

**Interfaces:**
- Consumes: `truncated` da lista de pendências (`features/team-pendencies/schemas.ts`).
- Produces: nenhuma interface nova.

- [ ] Teste RED: `team_whatsapp.forbidden` e `auth.permission_denied` mostram "Você não tem permissão para passar pendências. Fale com um administrador."
- [ ] Teste RED: com `truncated: true`, o diálogo mostra "A lista pode estar incompleta porque há mais de 2.000 pendências abertas. Confira depois se ficou alguma com esta pessoa."
- [ ] Teste RED (controle): com `truncated: false`, o aviso não aparece.
- [ ] Implementar.
- [ ] Entrada `2026.11.21.5` no topo de `RELEASE_NOTES`, em linguagem do operador: se o robô não conseguir ler uma mídia, a conversa passa para a equipe; a passagem de pendências avisa sobre falta de permissão e lista incompleta. Se `release-notes.passagem.spec.ts` exigir a entrada do K3 no topo, passar a localizá-la pela versão, mantendo as demais asserções.
- [ ] `gate --changed --base main` no `frontend/` e `npx tsc -b`.

### Task 3: conflito ao salvar vínculo em português

**Files:**
- Modify: `frontend/src/features/users/error-messages.ts` (confirmar se é o mapa usado pelo formulário; `submit-error.ts` é o outro candidato)
- Test: spec existente do módulo

**Interfaces:**
- Consumes: código `user.concurrent_admin_change`, devolvido com 409 por `users.service.ts`. O código do back não muda.
- Produces: nenhuma interface nova.

- [ ] Teste RED: o código `user.concurrent_admin_change` resulta em "Outra pessoa alterou este cadastro agora. Recarregue a página e tente de novo."
- [ ] Teste de controle: um código desconhecido segue com o texto genérico atual.
- [ ] Implementar no mapa que o formulário de pessoa realmente usa.
- [ ] `gate --changed --base main` no `frontend/` e `npx tsc -b`.

## Estado

- 21/11/2026, sobre `main` em `84ca962`. Tasks E1 e E2 no PR #26 (`fix/e2e-ci-runner`), com o e2e de volta (5/5). Tasks 1, 2 e 3 aceitas em `fix/achados-pos-plano`, empilhada no #26.
- A Task 1 teve uma rodada de correção: a falha de mídia não grava mais mensagem de erro, caminho ou nome de arquivo no log e na auditoria.
- Gates completos contra `origin/main`, sozinhos: back 7810/7840 (30 ignorados), cobertura 95,7% de linhas e 87,9% de branches; front 2768/2768, cobertura 90,5% e 84,6%. O FAIL é da dívida legada de lint, sonar e complexidade. Contra o K3, nada novo nos arquivos deste lote. Os 84 itens "novos" estão em `chat.repository.spec.ts`, que este lote não altera: são os mesmos achados deslocados pelo ajuste de tamanho feito no fim do K3.
- Backlog: reabertura quando o banco falha depois de gravar a mensagem (K1:52,57); erro de banco no meio da passagem de turno (K3:45); `setDifyConversationId` fora de try/catch; caminho de erro do Dify grava até 300 caracteres da resposta na auditoria, sem verificação de dado pessoal; `JSON.stringify` fraco no teste `sendBotReply lança`.
- Próximo passo: merge e deploy só com pedido explícito.
