# GoZap: checar a vaga do plano antes de criar a conexão

> Execução: skill `sdd`, uma task. Ledger em `.superpowers/sdd/2026-10-23-gozap-limite-instancias/progress.md`.

## Contexto (diagnóstico de 23/10/2026)

- Em 23/10, entre 13:33:52 e 13:34:09 UTC, o cliente do GBR tentou 3 vezes "Nova conexão GoZap" (`POST /whatsapp/channels`). As 3 tentativas voltaram 502 (`gozap.creation_failed`).
- O motivo devolvido pelo GoZap não ficou em log: `describeHttpError` reduz o erro a `HTTP 502`, e o serviço não registra nada.
- A conta GoZap é compartilhada entre o GBR e o Picoa (memória `gbr-gozap-conta-picoa`) e está no plano Básico, com **1 instância**.
- `GET /instance/all` (header `admintoken`) devolve `{ instances: [...], success }`. Hoje há só a instância "robo" do Picoa, desconectada desde 19/10 ("client not running").
- Criar uma segunda instância dá 502 no GoZap e, segundo o comentário em `create-gozap-channel-dialog.tsx`, já derrubou em produção a instância que estava no ar.
- Hoje a única trava é o aviso fixo com checkbox. O backend chama `POST /instance/create` sem saber se há vaga.

## Objetivo

O backend consulta as vagas da conta antes de criar e recusa com mensagem clara quando o plano está cheio, **sem** chamar `POST /instance/create`. Falhas do GoZap passam a deixar o motivo no log, sem segredo.

## Constraints globais

- `GET /instance/all` traz o `token` de TODAS as instâncias da conta, inclusive as do Picoa. Desse retorno só se leem `id`, `name` e `status`. Nada dele vai para log, resposta ou mensagem de erro além do nome e do status.
- Nenhum token (admin ou de instância) em log, resposta ou mensagem de erro. Segue o padrão já documentado no serviço ("NUNCA `{ err }` cru").
- Mensagens em pt-BR, para o operador.

## Task 1: vaga do plano antes de `POST /instance/create`

Crítico: segredo — lê a lista de instâncias da conta compartilhada, que contém os tokens de todas as instâncias; contrato público — código de erro novo em `POST /whatsapp/channels`, consumido pelo front.

**Arquivos (ownership):**
- `backend/src/modules/whatsapp-providers/gozap-instances.service.ts` e spec;
- `backend/src/shared/config/env.schema.ts` e spec;
- os compose de deploy que já repassam `GOZAP_*`;
- `frontend/src/features/whatsapp/components/create-gozap-channel-dialog.tsx` e spec;
- o mapa de mensagens de erro do front, se o dialog usar um.

**Contrato:**
- `GOZAP_MAX_INSTANCES`: inteiro ≥ 1, opcional, default 1. String vazia vale como ausente (mesmo `preprocess` de `GOZAP_CHECK_RATE_PER_MIN`). Repassado nos compose como `${GOZAP_MAX_INSTANCES:-}`.
- Em `createChannel`, depois do guard de nome duplicado e antes do `POST /instance/create`, vem `GET /instance/all` com `admintoken`. Conte `instances.length`.
  - Se `count >= limite`: `DomainError` `gozap.instance_limit_reached`, status 409. Mensagem: `A conta GoZap já usa {count} de {limite} instância(s) do plano: {nome (status), ...}. Para conectar um número novo, remova uma conexão que não é mais usada ou aumente o plano do GoZap.` Status em pt-BR: connected → conectada, disconnected → desconectada, connecting → conectando; outro valor sai como veio.
  - Se o `GET` falhar (rede, 4xx/5xx, corpo sem `instances` array): `DomainError` `gozap.capacity_check_failed`, status 502. Mensagem: `Não foi possível consultar as vagas da conta GoZap. Tente de novo em alguns minutos.` Também não chama create (falha fechada).
- `describeHttpError` passa a incluir, quando existir, o texto do erro do GoZap: `response.data.error` ou `response.data.message`, se for string, cortado em 200 caracteres. Fica `HTTP 502: <texto>`.
- Quando `POST /instance/create` falha, o serviço faz `logger.warn` com o nome do canal e o `describeHttpError`, sem token.
- Front, no dialog:
  - `gozap.instance_limit_reached` e `gozap.capacity_check_failed` mostram a mensagem do backend no alerta inline que já existe;
  - `gozap.creation_failed` continua como hoje;
  - o corpo do erro sai por `readApiErrorBody`, por causa do ky 2 (memória `front-ky2-error-body`).

**Testes (TDD):**
- Service:
  - conta cheia (1 instância, limite 1) → 409 com o nome e o status na mensagem, e `post('/instance/create')` não é chamado;
  - conta com vaga (0 instâncias) → create é chamado;
  - limite 2 com 1 instância → create é chamado;
  - `GET /instance/all` com 500 → 502 `capacity_check_failed`, sem create;
  - a mensagem e o log não contêm o `token` das instâncias da lista (use um token-sentinela no mock);
  - create com 502 e `data.error` → a mensagem contém o texto, e o `logger.warn` é chamado sem token.
- Env:
  - default 1;
  - `''` vira 1;
  - `'3'` vira 3;
  - `'0'` é rejeitado.
- Front: 409 `gozap.instance_limit_reached` mostra a mensagem do backend no dialog.

**Aceite:** `gate --changed --base origin/main` verde em `backend/` (com `TESTCONTAINERS_ENABLED=1`) e em `frontend/`; revisão `revisor` opus.
