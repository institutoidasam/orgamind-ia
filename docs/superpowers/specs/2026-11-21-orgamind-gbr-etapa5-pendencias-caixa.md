# OrgaMind — Etapa 5 do plano GBR, parte B: pendências da equipe, caixa de respostas e passagem de turno

## Intenção

Segunda parte da Etapa 5 (P1, "Governança e operação") do plano entregue à GBR (`reports/plano-gbr/`). A parte A (PAN-01 e CAD-06, Lote J) está em `docs/superpowers/specs/2026-11-21-orgamind-gbr-etapa5-panorama-estrutura.md`. Esta spec cobre:

| Item | O que pede | Lote |
|---|---|---|
| **MSG-03** (caixa) | Situação da conversa, resolver e reabrir, um atendente por vez, histórico | K1 |
| **INT-04** | Pendências de ciência para responsável humano, visão da liderança | K2 |
| **MSG-03** (turno) | Passagem de turno de conversas e pendências; etiquetas de envio na conversa; prova do robô | K3 |

**O que já existe:**

- **Caixa de entrada** (`/inbox`, rotas `internal/chat`): só ADMIN e OPERATOR entram (rotas sem `@Roles` caem na regra padrão de `roles.guard.ts:9-20`). A caixa é compartilhada na organização.
  - A conversa é única por número e pessoa (`@@unique([instanceId, remoteJid])`). Tem atendente opcional (`assignedUserId`, `assignedAt`), `archivedAt` (sem uso de produto), `lastInboundAt`, `unreadCount` e `botPausedAt`.
  - Atribuir (`POST conversations/:id/assign`) é gravação cega: confere só se o destino tem acesso, grava, pausa o robô, registra `conversation.assign` na trilha e publica `conversation.updated` no tempo real.
  - Responder tem duas rotas: texto (`POST conversations/:id/messages`, `sendReply`) e mídia (`POST conversations/:id/media`, `sendMediaReply`). Nenhuma confere quem é o atendente. As duas gravam a mensagem com o autor e pausam o robô.
  - A lista de usuários do menu de atribuição vem de `GET /users`, que só o ADMIN acessa, e traz também SUPERVISOR e VIEWER.
  - Filtros da lista: atendente (Todas, Minhas, Não atribuídas) e "Todas / Não lidas / Aguardando".
  - O tempo real (SSE) transmite todos os eventos da organização a todo conectado.
- **Alerta urgente** (Lote I): cada destinatário tem ciência (`ackAt`, `ackKind`, quem marcou e observação), a última resposta ligada (`lastReplyMessageId`) e a mensagem do envio (`messageId`). O painel do alerta agrupa em "Sem entrega", "Sem resposta", "Respondeu, sem ciência" e "Ciente", com o prazo de ciência de 15 minutos. O painel e o resultado do envio só são vistos pelo ADMIN e pelo autor (`canViewDispatch`).
- **Robô:** responde só a mensagem recebida ao vivo, com a conversa sem pausa. Atribuir, responder e o envio da equipe pausam; só "Retomar robô" retoma.

**O que falta**, e é o que esta spec decide:

- A conversa não tem situação (pendente, em atendimento, resolvida) nem histórico.
- Dois atendentes podem responder a mesma pessoa ao mesmo tempo.
- Ninguém é responsável por quem não confirmou um alerta, e a liderança não vê essas pendências.
- Não há passagem de turno.
- A conversa não mostra que mensagem veio de um envio da equipe.

**De onde vêm as regras.** Caderno e Escopo da GBR de 28/10/2026 (C350, C369-371, C422-423, C544, C610-611, C744, C748; E174-175, E229-230). O que o caderno deixa pendente foi decidido pelo Conselho W em 20/11/2026 (`~/.claude/tribunais/2026-11-20/conselho-W/sentenca-W.md`) e está marcado **(conselho W)**, provisório até a GBR confirmar. O que é escolha minha está marcado *(decisão minha)*. Seguem valendo:

- Conselho U (Lote I): ciência, prazo de 15 minutos, chave `equipe.urgencia`, lembretes.
- Conselho R, R3: sem unidade, equipe/célula ou responsável por turno.

**Fontes:** `escopo.txt` e `caderno.txt` em `.superpowers/sdd/2026-11-19-orgamind-gbr-etapa1-lote-a-ficha-trilha/fontes/`; mapa do código em `.superpowers/sdd/2026-11-21-orgamind-gbr-etapa5-governanca/fontes/mapa-respostas-pendencias.md`.

**Vocabulário:**

- "Remetente" é quem pode enviar à equipe: ADMIN, ou SUPERVISOR/OPERATOR que gere ao menos um setor ativo (`isTeamSender`).
- "Quem tem acesso à caixa" é ADMIN ou OPERATOR, ativo e com acesso ao sistema.
- "Conversa" é a da caixa. "Pendência" é a de ciência de um alerta (K2). As duas são independentes: nenhuma grava estado na outra.
- "Gravação condicional" é uma escrita que só acontece se o estado ainda for o que a tela mostrava, num único comando atômico; se não bater, nada é gravado e a resposta é 409.

## Objetivos

1. Na caixa, cada conversa mostra se está pendente, em atendimento ou resolvida, e quem a está atendendo. Resolvidas saem da lista padrão e voltam sozinhas quando a pessoa escreve de novo (MSG-03, E174-175).
2. Só uma pessoa responde a cada conversa por vez, e cada troca de atendente fica registrada com quem, quando e por quê.
3. Cada pessoa que não confirmou um alerta urgente vira uma pendência com responsável, prazo, anotações e encerramento, e a liderança vê as pendências das pessoas dos setores que gere (INT-04, C369-371, C422-423, E229-230).
4. Quem sai do turno passa conversas e pendências para um colega, numa ação, com observação.
5. Na conversa, dá para ver que mensagem veio de um envio à equipe e qual resposta o alerta registrou.
6. Testes automáticos provam que o robô não responde em pausa, não entra em loop e não inicia conversa.

## Não objetivos

- Atribuição, aviso ou escalonamento automático de pendências (C748 aberto).
- Turno do atendente, responsável por turno ou fim de turno detectado pelo sistema.
- Abrir a caixa ao SUPERVISOR ou ao VIEWER (C744 aberto).
- Pendência para outras finalidades além do alerta urgente.
- Ligar uma resposta qualquer a um envio específico fora do alerta.
- Chave de permissão nova.
- Tempo real nas pendências.

## Anti-objetivos (falha mesmo que funcione)

- Um SUPERVISOR ver pendência de pessoa fora dos setores que gere e de alerta que não enviou, por qualquer rota.
- Uma tela de pendências mostrar outra mensagem da conversa além da última resposta ligada ao alerta.
- Encerrar uma pendência criar ciência, ou tirar a pessoa do grupo em que está no painel do alerta.
- Duas pessoas responderem a mesma conversa sem que uma tenha assumido de forma registrada.
- Uma resposta ser gravada ou enviada quando o servidor recusou a reivindicação.
- Resolver, reabrir, transferir ou passar turno retomarem o robô.
- O sistema mandar mensagem a alguém por conta de pendência, prazo ou passagem de turno.
- Texto de resposta, anotação, motivo, observação, nome ou telefone de pessoas da equipe em log. A trilha guarda ids e situações, não textos.

## Restrições

- Migrações aditivas, com `lock_timeout`, sem mudar linha existente: K1 (situação e histórico da conversa) e K2 (pendência no destinatário e anotações). K3 não tem migração.
- Nenhuma chave de permissão nova: caixa pela regra de papel atual; pendências com `equipe.enviar` e `equipe.urgencia`.
- `canViewDispatch` não muda.
- Testes nunca mandam WhatsApp real.

## O que fica decidido

### Comum

- **C1. Lotes, branches e PRs** *(decisão minha)*. Três lotes, cada um com seu PR rascunho, empilhados nesta ordem sobre o Lote J:
  - K1, `feat/caixa-situacao`, sobre `feat/panorama-estrutura`;
  - K2, `feat/pendencias-equipe`, sobre K1;
  - K3, `feat/passagem-turno`, sobre K2.
  - Cada lote fecha com gates, QA local e PR antes de o próximo começar.
- **C2. Novidades.** Uma entrada por lote. A de K1 avisa que conversas já atribuídas passam a exigir "Assumir conversa" de quem não é o atendente.
- **C3. Erros.** Os 409 levam `code` e, quando a tela precisa, `detail` com id e nome do usuário do sistema envolvido (nunca dado de pessoa da equipe ou contato). O front lê pelo `readApiErrorBody`.

### K1 — Situação da conversa e um atendente por vez (conselho W, W1 parte 2 e W4)

- **K1-1. Situação.** Calculada, nunca gravada como texto:
  - "Resolvida": tem a marca de resolução (coluna nova; `archivedAt` não é reutilizado);
  - "Em atendimento": aberta e com atendente;
  - "Pendente": aberta e sem atendente.
  - Conversas existentes ficam "Em atendimento" se têm atendente e "Pendente" se não, sem migrar dados.
- **K1-2. Histórico da conversa.** Tabela nova, só de inclusão. Cada linha guarda quem (ou "Sistema"), quando, ação, de e para (usuários) e observação opcional (até 200).
  - Ações: assumiu, assumiu ao responder, transferiu, removeu atendente, resolveu, reabriu e passagem de turno (K3).
  - Visível a quem tem acesso à caixa, na própria conversa, sob "Histórico da conversa".
  - A trilha `conversation.assign` continua sendo gravada nas mudanças de atendente.
- **K1-3. Resolver.**
  - Quem: o atendente ou o ADMIN. Observação opcional (até 200).
  - Quem não é o atendente atual nem ADMIN recebe 403 `chat.not_assignee`. A mesma regra vale para "Remover atendente" e para transferir uma conversa que tem atendente (K1-7).
  - Resolver retira o atendente.
  - Gravação condicional: ainda aberta, ainda com o atendente que a tela mostrava (que é o ator, salvo o ADMIN), e sem mensagem recebida depois da última que a tela mostrava (`lastInboundAt`). Se não bater: 409 `chat.conversation_changed`, e a tela recarrega a conversa.
- **K1-4. Reabrir.**
  - **Manual:** quem tem acesso à caixa, observação opcional; volta a "Pendente".
  - **Automático:** mensagem da pessoa recebida ao vivo numa conversa resolvida a devolve a "Pendente", sem atendente, com autor "Sistema". É gravação condicional "estava resolvida", e só ela grava a linha do histórico.
  - **Ordem com o "Resolver":** a reabertura automática acontece no mesmo comando que avança `lastInboundAt`, ou depois dele. Assim, ou o "Resolver" vê o `lastInboundAt` novo e recebe 409, ou a reabertura encontra a conversa resolvida e a reabre. A mensagem nunca fica numa conversa resolvida.
  - Importação de histórico e eco de mensagem enviada não reabrem.
- **K1-5. Responder exige ser o atendente** (W4). Vale para todos, inclusive o ADMIN, e para as duas rotas de resposta, texto e mídia.
  - O servidor faz a reivindicação depois das conferências de canal e de janela e antes de gravar a mensagem. Na mídia, antes de gravar o arquivo no armazenamento, junto da conferência do provedor.
  - **Conversa sem atendente ou resolvida:** gravação condicional "ainda sem atendente" que põe quem responde como atendente, reabre se preciso e grava "assumiu ao responder".
  - **Conversa dele:** gravação condicional "ainda com ele e aberta" *(decisão minha, fecha a corrida com uma transferência no meio)*. Se falhar porque a conversa ficou sem atendente ou foi resolvida, vale o ramo anterior; se está com outro, o ramo abaixo.
  - **Conversa de outro, ou corrida perdida:** nada é gravado nem enviado. A resposta é 409 `chat.assigned_to_other`, com `detail` de id e nome do atendente.
  - A atribuição feita na reivindicação permanece mesmo se o envio ao WhatsApp falhar.
- **K1-6. Tela da conversa com outro atendente** *(decisão minha sobre o "quando")*. Quando a conversa aberta está com outro atendente, ou depois de um 409 `chat.assigned_to_other`:
  - aparece "{Nome} está atendendo esta conversa." com o botão "Assumir conversa";
  - o campo de texto continua editável e o texto digitado é mantido, mas "Enviar" fica desligado até assumir.
- **K1-7. Assumir, transferir e remover.**
  - **Assumir (para si):** qualquer um com acesso à caixa, observação opcional. Gravação condicional ao atendente que a tela mostrava; se mudou, 409 `chat.conversation_changed` com o atendente atual.
  - **Transferir a outra pessoa:** o atendente atual, o ADMIN, ou qualquer um quando a conversa está sem atendente. Mesma gravação condicional.
  - **Destino:** ativo, com acesso e ADMIN ou OPERATOR. Senão, o mesmo 404 de usuário inexistente da atribuição atual.
  - **Lista de destinos:** rota nova de leitura, para quem tem acesso à caixa, que devolve só id e nome dos ADMIN e OPERATOR ativos e com acesso. O menu de atribuição e a passagem de turno (K3) usam essa rota, e não mais `GET /users`.
  - **Remover atendente:** o atendente ou o ADMIN, com a mesma gravação condicional; volta a "Pendente".
  - **Rota atual de atribuição:** `POST conversations/:id/assign` passa a exigir o atendente que a tela mostrava, como campo obrigatório: `null` explícito quando a tela mostrava a conversa sem atendente. Sem o campo, 400. Não sobra nenhum caminho de gravação cega do atendente.
  - **Robô:** assumir, transferir e passar turno pausam o robô, como a atribuição já faz. Remover, resolver e reabrir não pausam nem retomam.
  - **Trilha:** toda troca de atendente grava `conversation.assign`, com o novo atendente ou vazio (ao remover, resolver e passar turno também).
  - Assumir e transferir numa conversa resolvida a reabrem.
- **K1-8. Atendente inativo ou sem acesso.** O nome aparece com "(inativo)". A trava continua, e qualquer um com acesso à caixa pode assumir. Nada é desfeito sozinho ao inativar o usuário.
- **K1-9. O que não passa pela trava.** Envios da equipe (recado, alerta, lembrete) e respostas do robô. Eles não mudam situação nem atendente. Marcar como lida não muda.
- **K1-10. Lista da caixa.**
  - Seletor novo de situação, "Abertas" (padrão: "Pendente" e "Em atendimento") ou "Resolvidas" *(decisão minha)*.
  - "Todas / Não lidas / Aguardando" e a busca combinam com os dois. As abas de atendente (Todas, Minhas, Não atribuídas) valem só em "Abertas" e somem em "Resolvidas", que não têm atendente.
  - Cada linha mostra a situação.
  - Toda mudança de situação ou atendente publica `conversation.updated`, como a atribuição já faz.

### K2 — Pendências da equipe (conselho W, W1 parte 1, W2 e W3)

- **K2-1. O que é pendência.** Cada destinatário de alerta urgente que o painel do alerta mostra (não os destinatários de lembrete) é uma pendência daquele alerta.
  - Dois alertas para a mesma pessoa são duas pendências, mesmo com uma conversa só.
  - Nas outras finalidades, falta de resposta não é pendência.
- **K2-2. Situação da pendência.** Calculada, nesta ordem:
  - "Ciente": tem ciência (automática ou manual, regras do conselho U). A ciência vale mesmo se chegar depois do encerramento.
  - "Encerrada sem ciência": encerrada.
  - "Sem responsável": sem responsável, ou com responsável inativo ou sem acesso ao sistema (o nome aparece como "{nome} (inativo)"). Também quando o responsável perdeu `equipe.enviar` ou deixou de ver a pendência pela função de alcance K2-4 aplicada a ele; o nome aparece como "{nome} (fora do alcance)" *(decisão minha, estende a regra do inativo da W2)*. A lista e o contador fazem esse cálculo para o responsável de cada pendência.
  - "Em tratativa — atrasada": com responsável e prazo de tratativa vencido.
  - "Em tratativa": com responsável e prazo em dia.
  - A ciência continua sendo a única verdade sobre "ciente". Encerrar não cria ciência, e o painel do alerta mantém a pessoa no grupo em que está, com a marca "Tratativa encerrada por {nome}: {motivo}".
- **K2-3. Dados novos** (migração aditiva, no destinatário ou ao lado dele): responsável, hora em que foi assumida, prazo de tratativa, encerramento (quem, quando, motivo até 200) e uma tabela de anotações (autor, hora, texto até 200).
- **K2-4. Alcance.** Uma única função no servidor, usada pela lista, pelo contador, pela lista de destinos, pela ciência manual e por todas as ações:
  - começa por `isTeamSender(ator)`: quem não é remetente não vê nenhuma pendência;
  - o ADMIN vê todas;
  - os demais veem as pendências dos alertas que enviaram e as das pessoas de setores ativos que gerem, mesmo em alerta de outro autor;
  - o setor da pessoa é o gravado no destinatário na hora do envio; se vazio (envio nominal), o setor principal atual da pessoa.
  - Pendência fora do alcance responde 404 em qualquer rota.
- **K2-5. Tela "Pendências da equipe"** (rota nova no front e rotas novas no back, com papel ADMIN, SUPERVISOR ou OPERATOR e exigência de ser remetente).
  - Quem não é remetente recebe 403 e não vê o item de menu. A tela do VIEWER não consulta. SUPERVISOR/OPERATOR sem setor gerido recebe o 403 e o item some sem erro, como no panorama.
  - **Cada linha mostra:**
    - pessoa, setor e turno gravados no envio;
    - telefone como o painel do alerta mostra (completo com `telefone.ver_completo`, mascarado sem);
    - texto do alerta, quem enviou e quando;
    - grupo do painel, prazo de ciência, responsável, situação e anotações;
    - em "Respondeu, sem ciência", o texto da última resposta ligada ao alerta (mídia só como "Áudio", "Imagem" ou "Arquivo").
  - Nenhuma outra mensagem da conversa aparece.
  - **Filtros:** situação, setor e "Minhas" (em que sou o responsável). Por padrão: "Sem responsável", "Em tratativa" e "Em tratativa — atrasada".
  - **Período** *(decisão minha)*: as abertas aparecem sem limite de data, como a W2 pede. "Ciente" e "Encerrada sem ciência" mostram os alertas dos últimos 7 dias, com opção de 30. As ações e a passagem de turno não olham período.
  - **Ordem:** "Sem responsável" com prazo de ciência vencido; depois "Em tratativa — atrasada"; depois as demais, da mais antiga para a mais nova.
  - "Abrir conversa" aparece só a quem tem acesso à caixa e só quando o alerta gerou mensagem.
  - "Ver resultado do alerta" aparece só a quem vê o envio (`canViewDispatch`).
  - Sem tempo real: a tela recarrega após cada ação e ao voltar a ela.
- **K2-6. Contador no menu.** Número de pendências "Sem responsável" com prazo de ciência vencido, no alcance de quem olha, sem limite de data. Calculado ao abrir o sistema e ao abrir a tela, sem tempo real. Só para remetentes.
- **K2-7. Ações.** Ver não exige chave. Toda escrita exige `equipe.enviar` (a ciência manual exige também `equipe.urgencia`). Todas as ações gravam de forma condicional e entram na trilha do WhatsApp da equipe, com antes e depois de responsável, situação e prazo, sem os textos.
  - **Ordem das recusas:** 403 (chave) → 404 (fora do alcance) → 409/422 (estado), como no Lote I.
  - **Assumir:** quem vê a pendência. Condição: o responsável que a tela mostrava (nenhum, ou o id do inativo ou sem acesso), sem ciência e não encerrada. Se outro assumiu antes: 409 `team_whatsapp.pendency_taken`, com o nome do responsável. Se ficou ciente ou foi encerrada: 409 `team_whatsapp.pendency_changed`.
  - **Assumir de outro:** quem vê, com observação opcional. Condição: o responsável que a tela mostrava, sem ciência e não encerrada; senão 409 `team_whatsapp.pendency_changed`. O prazo recomeça.
  - **Transferir:** o responsável ou o ADMIN passa a outro usuário ativo, com acesso, com `equipe.enviar` e que veja aquela pendência (senão 404, como usuário inexistente). Mesma condição; o prazo recomeça.
  - **Lista de destinos:** rota de leitura por pendência que devolve só id e nome dos usuários que podem recebê-la (a regra do destino acima). A passagem de turno (K3-4) usa outra rota de leitura, para remetentes com `equipe.enviar`: devolve id e nome dos remetentes ativos, com acesso e com `equipe.enviar`, sem quem sai. O servidor pula, por pendência, as que o destino não vê. Destino inativo, sem acesso, sem `equipe.enviar` ou igual a quem sai recusa o pedido inteiro com 404, como usuário inexistente.
  - **Registrar contato:** o responsável grava anotação obrigatória (até 200: o que fez e por qual meio). Condição: ainda é o responsável; senão 409 `team_whatsapp.pendency_changed`. Não muda situação nem prazo.
  - **Quem não é o responsável atual nem ADMIN** recebe 403 `team_whatsapp.not_handler` em Transferir, Registrar contato, Encerrar e Reabrir. A condição atômica de cada uma inclui o responsável que a tela mostrava; se mudou no meio, 409 `team_whatsapp.pendency_changed`.
  - **Encerrar sem ciência:** o responsável ou o ADMIN, motivo obrigatório (até 200). Condição: o mesmo responsável, sem ciência e não encerrada. Se a ciência chegou antes: 422 `team_whatsapp.ack_exists`, o mesmo código e status da ciência manual do Lote I *(decisão minha: a W2 diz 409; alinha ao Lote I)*. Se já foi encerrada ou mudou de responsável: 409 `team_whatsapp.pendency_changed`.
  - **Reabrir a tratativa:** o responsável ou o ADMIN. Condição: o mesmo responsável, encerrada e sem ciência; senão 409 `team_whatsapp.pendency_changed`. Volta a "Em tratativa" com o mesmo responsável e prazo novo.
  - **Ciência manual e desfazer:** continuam nas rotas do Lote I (`POST` e `DELETE dispatches/:id/recipients/:recipientId/ack`), com `equipe.urgencia` (conselho U). A conferência de visibilidade das duas passa a aceitar quem vê o envio **ou** tem a pendência no alcance K2-4. A ordem 403 → 404 → 422 do Lote I não muda. A tela de pendências oferece "Registrar ciência manual" e "Desfazer ciência manual", com as mesmas regras do painel.
  - **Lembrete:** não muda; continua no resultado do alerta, para quem vê o envio.
- **K2-8. Prazo de tratativa.** 60 minutos desde que a pendência foi assumida (constante única do sistema), gravado na pendência nesse momento. Vencido sem ciência nem encerramento, o rótulo vira "Em tratativa — atrasada". O prazo só muda rótulo e ordem.
- **K2-9. Setor sem gestor.** Só o ADMIN e quem enviou veem as pendências.

### K3 — Passagem de turno, etiquetas de envio e prova do robô (conselho W, W5 e itens a registrar)

- **K3-1. "Passar meu turno" na caixa.** É sempre ação manual: o sistema não detecta fim de turno, não lembra e não transfere sozinho.
  - Lista as conversas "Em atendimento" de quem sai, todas marcadas e desmarcáveis.
  - Ele escolhe um colega (ativo, com acesso, ADMIN ou OPERATOR, diferente dele) e escreve uma observação obrigatória (até 200), comum a todas.
  - O servidor transfere uma a uma, cada qual numa gravação condicional "ainda aberta e ainda com quem sai". As que mudaram são puladas.
  - A resposta traz as transferidas e as puladas com o motivo ("já resolvida", "já com outro atendente"). Repetir o pedido não duplica nada.
  - Cada conversa recebe sua linha "passagem de turno" no histórico, com de, para e a observação.
- **K3-2. "Passar as conversas de {nome}"**, só para o ADMIN, com as mesmas regras, para atendente ausente ou inativo. O histórico registra o ADMIN como autor.
- **K3-3. Filtro "Recebidas na passagem de turno".** Conversas abertas que estão com quem olha e cuja última mudança de atendente foi uma passagem de turno. Conversas "Pendentes" não têm atendente e não entram.
- **K3-4. "Passar minhas pendências"** na tela de pendências.
  - Faz o mesmo com as pendências que quem sai assumiu ("Em tratativa" e "Em tratativa — atrasada").
  - O destino precisa ver cada pendência (K2-4) e ter `equipe.enviar`. As que ele não vê são puladas com o motivo "fora do alcance do destino" e continuam com quem sai.
  - Outros motivos de pulo: "já com outro responsável", "já ciente", "já encerrada".
  - O prazo de tratativa recomeça nas transferidas.
  - A observação vira uma anotação "Passagem de turno: {observação}" em cada pendência transferida *(decisão minha)*.
  - O ADMIN pode passar as de outro.
- **K3-5. Nenhuma mensagem** é enviada a ninguém na passagem.
- **K3-6. Etiquetas de envio na conversa.** Sem coluna nova: é consulta de leitura.
  - Cada mensagem enviada que pertence a um envio da equipe leva "Envio à equipe: {finalidade} · {dd/MM HH:mm}", ou "Lembrete do alerta".
  - A mensagem recebida que o alerta registrou como resposta ou ciência leva "Resposta ao alerta de {HH:mm}".
  - No topo da conversa: "Último envio à equipe nesta conversa", com finalidade e data; se for alerta e quem olha vê a pendência (K2-4, que já exige ser remetente), também a situação da pendência.
  - "Ver resultado" só para quem vê o envio (`canViewDispatch`).
  - O texto diz "último envio", nunca "origem da resposta".
- **K3-7. Prova do robô.** Nenhuma regra nova. Testes automáticos provam:
  - (a) o robô não responde com a conversa em pausa, e envio da equipe, atribuição e resposta de atendente pausam;
  - (b) resolver, reabrir, transferir e passar turno não retomam o robô (só "Retomar robô");
  - (c) sem loop: mensagem enviada (do robô, do atendente, da equipe ou eco do próprio número) nunca gera resposta do robô, e cada mensagem recebida gera no máximo uma resposta, mesmo com evento repetido;
  - (d) o robô não inicia conversa: só responde a mensagem recebida ao vivo, nunca a histórico importado;
  - (e) resposta vazia do serviço não é enviada, e em falha sai no máximo a contingência configurada e o robô pausa.
  - Se um teste revelar que o código não garante o item, a correção entra no K3.
  - O conteúdo que o robô escreve vem de serviço externo e não é verificado por teste: é limite declarado.

## Limites conhecidos

- Conversa aberta só por envio da equipe, sem atendente, aparece como "Pendente", como já aparece hoje na lista. O filtro "Aguardando" continua separando quem escreveu por último.
- Se alguém retomar o robô numa conversa com atendente, ele volta a responder, por escolha manual.
- A ligação de resposta a envio só existe no alerta; fora dele, a conversa mostra só o último envio.

## Para a GBR confirmar

1. Os rótulos das situações, da conversa e da pendência, servem?
2. O prazo de tratativa é 60 min? O prazo deve provocar alguma ação, e por qual canal (C748)?
3. Quem é o responsável por setor e por turno? A pendência deve ir sozinha ao gestor?
4. Outras finalidades além do alerta têm resposta esperada e geram pendência?
5. O supervisor deve usar a caixa e responder pelo sistema (C744)? O gestor pode ler a resposta da pessoa?
6. Tratar pendência merece permissão própria, ou `equipe.enviar` basta?
7. O ADMIN pode responder sem assumir? Assumir de outro e resolver exigem motivo?
8. A passagem de turno deve ser obrigatória ou lembrada? O gestor pode passar conversas de um atendente?
9. Pendência aberta fica na lista e no contador sem limite de data, até alguém tratar ou encerrar. Serve? E "Ciente"/"Encerrada" olhando 7 dias (ou 30)?
10. Conversa só com envio da equipe deve aparecer como "Pendente" na caixa?

Decididas provisoriamente no K2 (21/11; detalhe em "Dúvidas de produto" do plano do K2). A recomendação é manter todas:

11. Registrar contato vale também em pendência ciente ou encerrada, se a pessoa ainda for a responsável. Assim, o contato feito no minuto em que a ciência chega não se perde. A tela só oferece o botão nas pendências abertas.
12. Se quem já é o responsável clicar em "Assumir", ou transferir para si mesmo, nada é gravado. Se a pendência mudou no meio do caminho (ficou ciente, foi encerrada ou transferida), o servidor recusa e a tela avisa.
13. O motivo do encerramento e a observação de "Assumir" viram anotações no histórico da pendência. Transferir não pede observação.
14. Uma pendência encerrada pelo ADMIN sem responsável volta a "Sem responsável" quando é reaberta.
15. O telefone da linha é o número gravado no envio. Envio antigo sem número gravado mostra "Sem telefone".
16. O período de busca usa a data do alerta. Cada consulta da lista traz no máximo 2.000 linhas, das mais novas para as mais antigas, com aviso. O contador não tem teto.
17. O contador não mostra número quando é zero, e o item do menu some enquanto carrega. Quem não envia mensagens à equipe e abre a tela pelo atalho vê só "Esta tela é para quem envia mensagens à equipe.".

## Aceite

**K1 — caixa**

1. A lista mostra a situação de cada conversa e, por padrão, só "Pendente" e "Em atendimento". O filtro "Resolvidas" mostra as resolvidas. Conversas existentes aparecem como "Em atendimento" se têm atendente e "Pendente" se não.
2. O atendente resolve com observação opcional, a conversa sai da lista padrão, o atendente é retirado e a trilha grava `conversation.assign` com atendente vazio. O ADMIN também resolve. Um OPERATOR que não é o atendente não vê "Resolver", e a API responde 403 `chat.not_assignee`.
3. Resolver com uma mensagem recebida depois da que a tela mostrava, ou com o atendente trocado, dá 409 `chat.conversation_changed`, e a tela recarrega. Teste de integração com banco real intercala "Resolver" e uma mensagem recebida nas duas ordens: a mensagem nunca fica numa conversa resolvida.
4. Mensagem recebida ao vivo numa conversa resolvida a devolve a "Pendente" sem atendente, com "Sistema" no histórico. Importação de histórico e eco não reabrem. Reabrir manual funciona para quem tem acesso à caixa.
5. Responder numa conversa sem atendente põe quem respondeu como atendente ("assumiu ao responder"). Numa resolvida, reabre e põe o atendente.
6. Responder numa conversa de outro (inclusive o ADMIN), por texto ou por mídia, dá 409 `chat.assigned_to_other` com o nome do atendente, sem mensagem gravada nem chamada ao provedor. A tela mostra "{Nome} está atendendo esta conversa.", mantém o texto e deixa "Enviar" desligado até "Assumir conversa".
7. Duas respostas simultâneas numa conversa sem atendente: uma vira atendente e envia, a outra recebe 409, e só uma mensagem é gravada (teste de integração com banco real). Resposta do atendente com uma transferência registrada no meio recebe 409 `chat.assigned_to_other`, sem mensagem gravada.
8. Assumir, transferir e remover seguem K1-7, com gravação condicional (409 `chat.conversation_changed`) e destino filtrado (404 para destino inativo, sem acesso ou SUPERVISOR/VIEWER). A rota de atribuição sem o atendente esperado é recusada (400). O OPERATOR monta "Transferir" pela lista nova de destinos, que só traz ADMIN e OPERATOR ativos. Cada mudança aparece no histórico e na trilha `conversation.assign`.
9. Atribuir pausa o robô; resolver, reabrir, transferir e remover não retomam. Envio da equipe não muda situação nem atendente.
10. Atendente inativo aparece com "(inativo)", e qualquer um com acesso à caixa assume.
11. As Novidades têm a entrada de K1, com o aviso sobre "Assumir conversa".

**K2 — pendências**

12. ADMIN vê todas as pendências. SUPERVISOR que gere um setor vê as das pessoas daquele setor, inclusive em alerta de outro autor, e as dos alertas que enviou; não vê as demais. Um teste parametrizado prova o 404 fora do alcance em toda rota de pendência (lista por id, ações, lista de destinos, ciência manual e desfazer), e o contador não conta o que está fora. VIEWER não consulta. SUPERVISOR ou OPERATOR sem setor gerido não vê o item de menu nem erro, mesmo tendo enviado alertas antes.
13. Envio nominal (setor vazio no destinatário) usa o setor principal atual da pessoa para o alcance.
14. A linha mostra os campos de K2-5. Em "Respondeu, sem ciência", aparece só o texto da última resposta ligada ao alerta, e mídia aparece como "Áudio", "Imagem" ou "Arquivo". O telefone segue `telefone.ver_completo`.
15. Ordem e filtros de K2-5. Abertas aparecem sem limite de data; "Ciente" e "Encerrada sem ciência" mostram 7 dias, ou 30 na opção; as ações valem para pendência fora do período. O contador do menu mostra as "Sem responsável" com prazo de ciência vencido no alcance, sem limite de data.
16. Assumir grava responsável e prazo de 60 min. Dois "Assumir" simultâneos: um vence e o outro recebe 409 `team_whatsapp.pendency_taken` com o nome (teste com banco real). Pendência com responsável inativo ou fora do alcance pode ser assumida por quem a vê. Quem não é responsável nem ADMIN recebe 403 `team_whatsapp.not_handler` ao transferir, registrar contato, encerrar ou reabrir.
17. Assumir de outro e transferir seguem K2-7, com 409 `team_whatsapp.pendency_changed` e 404 para destino que não vê a pendência ou não tem `equipe.enviar`. O prazo recomeça.
18. Registrar contato exige texto, só pelo responsável, e não muda situação nem prazo. Encerrar exige motivo; com ciência já registrada dá 422 `team_whatsapp.ack_exists`. Reabrir só vale para encerrada sem ciência e volta a "Em tratativa" com prazo novo. Responsável que perde `equipe.enviar` ou o setor gerido faz a pendência voltar a "Sem responsável", com "(fora do alcance)" (K2-2, revisão 2 N5).
19. Prazo vencido sem ciência vira "Em tratativa — atrasada". Ciência depois do encerramento põe a pendência em "Ciente".
20. O painel do alerta mantém a pessoa no grupo e mostra "Tratativa encerrada por {nome}: {motivo}".
21. Ciência manual e desfazer pela tela de pendências funcionam para quem tem `equipe.urgencia` e vê a pendência, mesmo sem ver o envio, nas rotas do Lote I com a ordem 403 → 404 → 422.
22. "Abrir conversa" só aparece a ADMIN e OPERATOR e só quando há mensagem do envio. "Ver resultado do alerta" só ao ADMIN e ao autor.
23. A trilha registra assumir, transferir, registrar contato, encerrar e reabrir com ids e situações, sem textos. Nenhum log tem texto, nome ou telefone.
24. As Novidades têm a entrada de K2.

**K3 — passagem, etiquetas e robô**

25. "Passar meu turno" transfere as conversas marcadas ao colega escolhido, com observação obrigatória. As que mudaram no meio voltam como puladas com o motivo. Repetir o pedido não duplica histórico.
26. O ADMIN passa as conversas de outro atendente, e o histórico registra o ADMIN.
27. Quem recebe vê o filtro "Recebidas na passagem de turno" com as conversas que recebeu.
28. A lista de destinos da passagem traz só remetentes ativos com `equipe.enviar`, sem quem sai; destino fora dessa regra recusa o pedido com 404. "Passar minhas pendências" transfere as que o destino vê, pula as outras com "fora do alcance do destino", recomeça o prazo e grava a anotação "Passagem de turno: …". O ADMIN passa as pendências de outro responsável com as mesmas regras.
29. A conversa mostra as etiquetas de K3-6, e "Ver resultado" só para quem vê o envio. Sem a pendência no alcance, o topo não mostra a situação dela.
30. Os testes (a) a (e) de K3-7 passam.
31. As Novidades têm a entrada de K3.

## Fica com o construtor

- Nomes de colunas, tabelas, enums e rotas, e o formato das respostas, desde que sigam esta spec.
- Se a situação da conversa vai como campo calculado na resposta da lista ou é calculada no front a partir dos campos.
- Componentes, chaves de query e o formato visual, seguindo o padrão da caixa e do painel do alerta.
- Paginação da lista de pendências e índices novos.
- A ordem e o texto dos testes, desde que cada aceite tenha teste.

## Correções da revisão 1 (20/11)

Revisão em `.superpowers/sdd/2026-11-21-orgamind-gbr-etapa5-governanca/spec-review-B-1.md`. Aplicadas: rota de mídia na trava (1); reabertura no mesmo comando de `lastInboundAt` (2); listas de destinos na caixa e na pendência (3); alcance começa por `isTeamSender` e responsável sem acesso vira "Sem responsável" (4); ciência manual e desfazer nas rotas do Lote I com o alcance K2-4 (5); condições de cada ação (6); `ack_exists` 422 e códigos do "Assumir" (7); abertas sem limite de data, alinhado à W2 (8); seletor "Abertas/Resolvidas" (9); robô e trilha nas trocas, condição do "Remover" (10); condição "ainda comigo" (11); rota de atribuição exige o atendente esperado (12); aceites novos (13).

## Correções da revisão 2 (20/11)

Revisão em `spec-review-B-2.md` (mesma pasta): APPROVED, 7 Minor aplicados: mídia recusada antes de gravar o arquivo (N1); "conversa dele" sem atendente cai no ramo de reivindicação (N2); 403 `chat.not_assignee` e `team_whatsapp.not_handler` e o ator na condição atômica (N3); 422 marcado como decisão minha (N4); alcance aplicado ao responsável e rótulo "(fora do alcance)" (N5); lista de destinos da passagem (N6); aceites de período, corrida, responsável inativo, trilha ao resolver e campo obrigatório do atendente esperado (N7).
