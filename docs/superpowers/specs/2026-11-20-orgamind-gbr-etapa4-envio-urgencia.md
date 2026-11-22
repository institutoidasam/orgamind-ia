# OrgaMind — Etapa 4 do plano GBR: envio rastreável e alerta urgente

## Intenção

Quarta etapa do plano entregue à GBR (`reports/plano-gbr/`), na ordem pedida pelo usuário em 19/11/2026. Itens: **INT-01** (conferir conexão e número de origem antes do disparo), **INT-02** (fila sem duplicidade, tentativas e repetição controlada), **INT-03** (estados por pessoa: aceito, entregue, lido, respondeu e ciente) e **MSG-02** (ocorrência urgente com motivo, envio imediato e ciência individual). Aceites do escopo: T08 e T09; cenários 9 e 10 do caderno.

**O que já existe** (o `dados.py` foi escrito em 19/11 sobre a produção; os PRs #11 a #19 já trouxeram boa parte):
- o servidor pergunta à Evolution o estado do número na hora da prévia, da confirmação e de cada mensagem da fila (cache de 15 s); desconectado, conectando ou sem resposta bloqueiam;
- um job por pessoa (`jobId` = destinatário), três tentativas, timeout nunca reenviado ("Situação incerta"), "Repetir" só para falhas certas e com chave nova por repetição;
- estados por pessoa com hora: Na fila, Aceito pelo WhatsApp, Entregue, Lido, Respondeu, Falhou, Pulado, Situação incerta; recibos repetidos ou fora de ordem não rebaixam o estado;
- a finalidade Urgência (Lote F): equipe em serviço, sem folga, motivo obrigatório, só "agora", seleção nominal.

**O que falta**, e é o que esta spec decide:
- **Rastreio** (Lote H): a hora da conferência do número no resultado; um destinatário cujo job sumiu fica "Na fila" para sempre; a mensagem preparada e depois pulada fica "na fila" no chat; o resultado não mostra quando cada fato aconteceu nem quantas vezes a pessoa foi repetida; não há uma demonstração automática de T08.
- **Alerta urgente** (Lote I): ciência individual, prazo, painel de pendências, lembrete aos pendentes e permissão própria para criar alerta.

**De onde vêm as regras.** Caderno e Escopo da GBR de 28/10/2026. O que o caderno deixa pendente sobre ciência, prazo, pendências e permissão foi decidido pelo Conselho U em 20/11/2026 (`~/.claude/tribunais/2026-11-20/conselho-U/sentenca-U.md`) e está marcado **(conselho U)**, provisório até a GBR confirmar. O que é escolha minha está marcado *(decisão minha)*.

**Fontes:** `escopo.txt` e `caderno.txt` em `.superpowers/sdd/2026-11-19-orgamind-gbr-etapa1-lote-a-ficha-trilha/fontes/` (linhas citadas como C e E); mapas do código em `.superpowers/sdd/2026-11-20-orgamind-gbr-etapa4-envio/fontes/` (`mapa-caderno-escopo.md`, `mapa-canal-fila-back.md`, `mapa-estados-respostas-back.md`, `mapa-front.md`).

**Vocabulário:**
- "Envio" é um disparo de WhatsApp para a equipe (`TeamWhatsappDispatch`); "destinatário" é cada pessoa dele (`TeamWhatsappRecipient`).
- "Alerta urgente" (ou "alerta") é o envio com finalidade Urgência criado a partir desta versão (tem prazo de ciência gravado). Urgência anterior a esta versão é "urgência antiga".
- "Lembrete" é um envio novo, ligado a um alerta, só para pessoas dele ainda sem ciência.
- "Ciência" é a confirmação da pessoa de que recebeu a orientação. É um fato separado de "Respondeu".
- "Número" é o canal (instância da Evolution) por onde a mensagem sai.

## Objetivos

1. O resultado de cada envio diz a verdade sobre cada pessoa: o que aconteceu, quando, por qual número e com que conferência de conexão; nada fica "na fila" para sempre.
2. Falha, timeout e evento repetido nunca aparecem como sucesso nem geram mensagem duplicada (T08, cenário 9), e há um teste automático que demonstra isso.
3. No alerta urgente, cada pessoa confirma que recebeu (ciência) respondendo "OK"; quem envia vê, por nome, quem confirmou, quem respondeu sem confirmar e quem não respondeu, com prazo (T09, cenário 10).
4. Quem envia pode mandar um lembrete só aos pendentes, com limite, e registrar a ciência dada por outro meio (ligação).
5. Criar alerta urgente passa a ser uma permissão própria.

## Não objetivos

- Avisar a liderança, escalonar por prazo, usar outro canal (ligação, SMS) ou criar responsável pela tratativa: é o INT-04 (Etapa 5), com a regra da GBR.
- Caixa de respostas com situação de atendimento e passagem de turno (MSG-03, Etapa 5).
- Botões interativos do WhatsApp: a Evolution não os garante em contas comuns.
- Separar "Aceito pelo WhatsApp" de "Enviado (um tique)" (ver Lote H, H5).
- Ciência em outras finalidades (reunião, palestra, hora extra): "Respondeu" continua como hoje.
- Mudar o envio direto a uma pessoa, a prévia, o agendamento ou a reconferência das Etapas anteriores.

## Anti-objetivos (falha mesmo que funcione)

- Uma pessoa aparecer como "Ciente" sem ter confirmado (resposta qualquer, resposta a outro envio, resposta de outro número, reação).
- Um lembrete chegar a quem já confirmou, a quem não era do alerta, ou sair duas vezes por dois cliques.
- Um timeout ou um job perdido ser reenviado sozinho.
- O texto da resposta, a observação da ciência manual, nome ou telefone aparecerem em log ou na trilha.
- Um SUPERVISOR ou OPERATOR sem a chave nova conseguir criar alerta, mandar lembrete ou marcar ciência pela API.

## Restrições

- Só a Evolution está ligada (`.claude/rules/whatsapp-provedores.md`); nenhuma chamada nova ao provedor além das que já existem (estado da conexão e envio de texto).
- Migrações só aditivas, com o cabeçalho das anteriores (`SET LOCAL lock_timeout = '15s'`); nenhuma linha existente muda.
- Dado pessoal: trilhas (`AuditService`) levam ids e contagens; texto da resposta e observação da ciência manual ficam só nas colunas do destinatário e na tela de quem vê o envio.
- Testes nunca mandam WhatsApp real (porta do provedor falsa); a ciência é provada por integração com mensagens recebidas simuladas.
- Sem chave de permissão nova além de `equipe.urgencia`.

## O que fica decidido

### Comum aos dois lotes

- **C1. Base e ordem.** O branch `feat/envio-rastreavel` parte do Lote G (`68f9abd`, PR #19). Lote H primeiro, Lote I depois, no mesmo branch, um PR por lote, empilhados.
- **C2. Visibilidade.** Ver o resultado, o painel e as horas segue a regra de hoje do histórico: ADMIN vê todos; os demais veem só os próprios envios. Telefone completo só com `telefone.ver_completo`.
- **C3. Situação do envio.** "Ninguém recebeu" (Lote G) continua derivado na tela; esta etapa não cria situação nova de envio.

### Lote H — Rastreio do envio (INT-01, INT-02, INT-03)

- **H1. Hora da conferência do número** *(decisão minha)*. Ao mandar cada mensagem, o processor grava no destinatário a hora da conferência de conexão que liberou aquela mensagem (`channelCheckedAt`, o `checkedAt` da porta ao vivo), **só quando o estado conferido foi `open`**. Na tabela do resultado, a coluna "Número" mostra o número e, embaixo, "conexão conferida às HH:mm:ss". Destinatário anterior a esta versão, pulado antes da conferência ou que falhou com o número desconectado ou sem conferência mostra só o número. Atende C535 e o "falta" do INT-01 ("mostrar o número de origem e a hora da última verificação").
- **H2. Destinatário preso** *(decisão minha)*. Um verificador no worker, a cada 5 minutos, olha destinatários `QUEUED` com `updatedAt` há mais de 30 minutos cujo job (`teamSendJobId(id, manualRetries)`, com o `manualRetries` lido da linha) **não existe mais na fila ou já terminou**. Job esperando, atrasado ou em andamento não é tocado (o pacing pode segurar envios grandes por muito tempo). Para cada preso, o verificador aplica a mesma leitura da mensagem que o processor usa numa tentativa repetida (`priorOutcome`):
  - sem mensagem preparada, ou com a `Message` ainda `QUEUED` (nada saiu) → "Falhou: saiu da fila sem envio" (`FAILED`, código `team_whatsapp.queue_lost`), repetível pelo "Repetir"; na mesma gravação, a `Message` `QUEUED` passa a `FAILED` com o mesmo código (reenviável), para não ficar "na fila" no chat, e o "Repetir" a reaproveita sem criar outra;
  - `messageId` gravado com a `Message` apagada → `FAILED` `team_whatsapp.message_missing` (regra de hoje do processor), não repetível;
  - `Message` aceita pelo provedor (`SENT`, `DELIVERED`, `READ`) → "Aceito pelo WhatsApp" (`SENT`, com `acceptedAt` da mensagem); os recibos seguintes seguem a regra de hoje;
  - `Message` `SENDING` ou com falha indeterminada (timeout, `sending_stuck`, código não reenviável) → "Situação incerta" (`UNCERTAIN`, código `team_whatsapp.stuck`), não repetível: pode ter saído;
  - `Message` com falha certa e reenviável → `FAILED` com o código dela, repetível conforme a regra de hoje do "Repetir" (códigos de `NOT_REPEATABLE_CODES` continuam fora).
  - A troca é condicional a `status = QUEUED` e aos mesmos `messageId` e `manualRetries` lidos (um job que termina ao mesmo tempo ou um "Repetir" no meio ganham). O verificador nunca põe nada de volta na fila. Trilha `team_whatsapp.stuck_reconciled` com o id do envio e as contagens por resultado.
- **H3. Mensagem preparada e depois pulada** *(decisão minha; backlog T9-m1 do Lote G)*. Quando uma tentativa posterior pula o destinatário (telefone mudou, sem telefone, bloqueado, sem autorização) depois de uma tentativa anterior ter preparado a `Message`, essa `Message` passa de `QUEUED` para `CANCELLED` na mesma gravação. Nada mais muda no chat.
- **H4. Resultado nominal para auditoria** *(decisão minha)*.
  - A tabela de destinatários ganha a coluna "Quando": a hora do estado de entrega que a linha mostra (`acceptedAt` em "Aceito", `deliveredAt` em "Entregue", `readAt` em "Lido", `repliedAt` em "Respondeu"). Formato `dd/mm HH:mm`; "—" nos estados sem hora gravada (Na fila, Falhou, Situação incerta, Pulado, Agendado, Cancelado). A ciência não usa esta coluna (ver I6).
  - A coluna "Tentativas" mostra também as repetições manuais: "2 · repetido 1×". A API passa a devolver `manualRetries`.
  - O resultado continua sem total e sem exportação.
- **H5. "Aceito pelo WhatsApp" continua cobrindo o "um tique"** *(decisão minha)*. A Evolution manda o estado pendente e o do servidor do WhatsApp com o mesmo sentido para o sistema (os dois viram `sent` no adaptador), e separá-los mexe no rastreio de todas as mensagens (campanhas e chat), não só no da equipe. O rótulo segue "Aceito pelo WhatsApp" até "Entregue". Vai para "Para a GBR confirmar".
- **H6. Demonstração de T08** *(decisão minha)*. Uma suíte de integração com banco real, só com a porta do provedor falsa, cobre de ponta a ponta:
  1. número desconectado na confirmação: 409 e nenhuma linha criada;
  2. número cai no meio da fila: os restantes ficam "Falhou: número desconectado", nenhum "Aceito" falso; depois de reconectar, "Repetir" manda só os falhos, uma vez cada;
  3. timeout do provedor: "Situação incerta", fora do "Repetir", sem segunda chamada ao provedor;
  4. recibo repetido e fora de ordem (lido antes de entregue, entregue duas vezes): o estado não volta e nenhuma mensagem nova é criada;
  5. dois "Repetir" ao mesmo tempo: uma chamada ao provedor por pessoa;
  6. job perdido (H2), nos quatro ramos: sem mensagem ou com a `Message` `QUEUED` → "Falhou: saiu da fila sem envio", repetível, sem segunda `Message`; `Message` aceita → "Aceito pelo WhatsApp"; `Message` `SENDING` ou com falha indeterminada → "Situação incerta"; `Message` com falha certa e reenviável → "Falhou" com o código dela, repetível. Nada é reenviado sozinho.

### Lote I — Alerta urgente com ciência (MSG-02)

- **I1. Permissão** (conselho U). "Chave nova `equipe.urgencia` ('Criar alerta urgente'), exigida junto com `equipe.enviar`. ADMIN tem sempre. SUPERVISOR e OPERATOR só têm quando o ADMIN ligar na matriz de permissões; o padrão é desligado e nenhuma linha é semeada. Sem a chave, a finalidade Urgência não aparece na tela e o servidor recusa com 403 a prévia, a criação, o lembrete e a ciência manual, com o texto 'Você não tem permissão para criar alerta urgente.'. Ver o painel de pendências não exige a chave."
  - A chave entra no catálogo (`PERMISSION_KEYS`), no texto de recusa, nas chaves do front e na tela da matriz. A checagem é por finalidade dentro do servidor (a rota é a mesma das outras finalidades) e vem antes de qualquer leitura de pessoas, junto das outras recusas 403 do envio.
  - O "Repetir" das falhas de um alerta segue a regra de hoje (`equipe.enviar` e a área), sem a chave nova: não cria alerta nem lembrete, só põe de volta na fila a mesma mensagem *(decisão minha)*.
- **I2. Linha de confirmação** (conselho U). "Todo alerta urgente termina com a linha fixa 'Responda OK para confirmar que recebeu.', acrescentada pelo servidor, visível na prévia e contada no limite do texto."
  - O servidor acrescenta a linha depois de uma linha em branco, na criação; o texto gravado no envio já a inclui. O limite de 2000 caracteres vale para o texto final: na Urgência, o DTO recusa (400) texto que, somado à linha em branco e à linha fixa, passe de 2000; o front mostra a linha fixa embaixo da caixa de texto, sem edição, e desconta o tamanho dela do contador. O texto do lembrete (`Lembrete: ` + texto do alerta) pode chegar a 2010 caracteres; isso é permitido *(decisão minha)*.
  - A impressão do público (prévia × confirmação) não muda: ela não cobre o texto.
- **I3. Prazo** (conselho U). "Todo alerta urgente tem prazo de ciência de 15 minutos, contado da confirmação do envio e igual para todas as pessoas do alerta. O valor é uma constante única do sistema, gravada em cada alerta na criação; quem envia não escolhe. O prazo aparece na confirmação e no histórico. Antes do prazo, quem não tem ciência aparece como 'Pendente', com o tempo decorrido; depois, como 'Pendente — prazo vencido'. O prazo só muda o rótulo e a ordem do painel: nenhuma mensagem sai sozinha. Ciência dada depois do prazo aparece como 'Ciente (após o prazo)', com a hora. Lembrete não reinicia o prazo. Alertas anteriores a esta versão aparecem sem prazo."
  - Coluna nova no envio: `ackDeadlineMinutes` (nulo = não é alerta: outras finalidades, urgência antiga e lembrete). "Confirmação do envio" = `createdAt` do alerta.
- **I4. Ciência** (conselho U). "Ciência é um fato separado de 'Respondeu': fica gravada com hora, forma (automática ou manual) e autor, e não muda o estado de entrega. Ciência automática: mensagem de texto da pessoa cujo conteúdo inteiro, sem diferença de maiúsculas e acentos e sem espaços ou pontuação nas pontas, seja 'ok', 'ciente', 'confirmo', 'recebido' ou o emoji de joinha. Qualquer outra resposta (outro texto, áudio, imagem, figurinha) fica como 'Respondeu, sem ciência' e continua pendente. Enquanto não houver ciência, toda mensagem seguinte da pessoa é avaliada: um 'OK' depois de um 'não entendi' vale. A ciência automática só vale se o alerta, ou um lembrete dele, for o último envio da equipe aceito para aquela pessoa naquele número e a resposta chegar em até 24 horas do aceite; fora disso a resposta só marca 'Respondeu'. Resposta a um lembrete conta para o alerta original."
  - Colunas novas no destinatário: `ackAt`, `ackKind` (`KEYWORD` | `MANUAL`), `ackByUserId` (manual), `ackNote` (manual, até 200), `ackMessageId` (a primeira mensagem recebida com palavra de ciência) e `lastReplyMessageId` (a última resposta da pessoa ligada ao alerta). Ciência, `ackMessageId` e `lastReplyMessageId` moram sempre no destinatário do **alerta original**; o destinatário do lembrete guarda `parentRecipientId` (o destinatário do alerta) e não tem ciência própria *(decisão minha)*.
  - Só mensagem do tipo texto (`kind = TEXT`) é avaliada como palavra de ciência. Imagem ou vídeo com legenda "ok", áudio, figurinha e reação (que o adaptador entrega como tipo não suportado e a ingestão grava como mensagem) contam como resposta, nunca como ciência *(decisão minha; a sentença U não conferiu a reação)*. O "joinha" aceito é o texto 👍, com ou sem modificador de tom de pele *(decisão minha)*.
  - Ligação da resposta: a ingestão do chat passa ao rastreio a mensagem recebida (id, tipo, texto) além de canal, contatos e hora. O rastreio acha o destinatário mais recente aceito para aquele número e contatos (regra de hoje). Se ele é de um alerta (ou de um lembrete, e então vale o destinatário original) e a resposta chegou até 24 h depois do aceite desse destinatário mais recente:
    - grava `lastReplyMessageId` no original, **com ou sem ciência já registrada**;
    - se o texto é palavra de ciência e o original ainda não tem `ackMessageId`, grava `ackMessageId`; se o original está sem ciência, grava também `ackAt` (hora do recebimento) e `ackKind = KEYWORD`.
  - O estado de entrega segue a regra de hoje no destinatário mais recente ("Respondeu" na primeira resposta). O retorno antecipado do `applyReply` quando o destinatário já está "Respondeu" deixa de impedir a avaliação de ciência: ele continua valendo só para o estado de entrega.
  - Toda gravação de ciência é condicional a `ackAt` nulo: mensagem repetida ou concorrente não regrava, a manual não sobrescreve a automática e vice-versa (a segunda recebe `ack_exists`). A gravação de `ackMessageId` é separada e condicional a `ackMessageId` nulo, para que um "OK" que perde a corrida para a ciência manual ainda fique guardado para o desfazer (I5).
  - Quem está em "Situação incerta" sem recibo não tem `acceptedAt` e não é candidato a resposta (regra de hoje): um "OK" dessa pessoa não chega ao alerta e ela continua pendente. É seguro (nunca dá ciência falsa); o lembrete e a ciência manual resolvem *(decisão minha)*.
  - O rastreio continua best-effort: uma falha nele deixa a pessoa pendente, nunca ciente, e não perde a mensagem recebida.
- **I5. Ciência manual** (conselho U). "Quem tem a permissão de alerta urgente e vê o envio no histórico pode marcar qualquer pessoa do alerta como ciente, com observação obrigatória de até 200 caracteres (ex.: 'confirmou por ligação'); ficam gravados autor e hora, e a ação vai para a trilha. A ciência manual pode ser desfeita por quem pode registrá-la, com registro na trilha; a automática não. A tela mostra o texto da resposta que deu a ciência e, sem ciência, o da última resposta."
  - Rotas: `POST /internal/team-whatsapp/dispatches/:id/recipients/:recipientId/ack` (`{ note }`) e `DELETE` na mesma rota. Ordem das recusas: 403 (sem `equipe.enviar` ou `equipe.urgencia`) → 404 (envio invisível ao ator ou destinatário de outro envio) → 422 (`team_whatsapp.not_an_alert`: envio que não é alerta; `team_whatsapp.ack_exists`: já tem ciência; `team_whatsapp.ack_not_manual`: desfazer automática ou inexistente) *(decisão minha)*.
  - Desfazer a manual: se o original já tem `ackMessageId` (um "OK" chegou enquanto a ciência manual valia), a ciência passa a automática com essa mensagem (`ackKind = KEYWORD`, `ackAt` = hora dela) e autor e observação são apagados; senão, a ciência inteira é apagada e a pessoa volta à pendência. O desfazer é uma única gravação condicional a `ackKind = MANUAL`, que decide na própria gravação entre virar automática ou apagar conforme o `ackMessageId` daquele instante, para não perder um "OK" que chega no meio *(decisão minha)*.
  - Trilhas `team_whatsapp.ack_manual` e `team_whatsapp.ack_manual_undo` com os ids do envio e do destinatário; sem observação, nome ou telefone.
  - O texto das respostas vem da mensagem gravada no chat; quem vê o envio vê esse texto (C422-423 pede "conteúdo recebido") *(decisão minha)*.
- **I6. Painel de pendências** (conselho U). "O resultado do alerta urgente tem um painel nominal, visível a quem já vê o envio no histórico, em quatro grupos: 'Sem entrega' (na fila, falhou, situação incerta, pulado), 'Sem resposta' (aceito, entregue ou lido), 'Respondeu, sem ciência' e 'Ciente'. Os três primeiros são pendências."
  - **Grupo de cada pessoa** *(decisão minha)*, calculado no servidor, na leitura, sobre o destinatário original e os destinatários dos lembretes dele:
    - com `ackAt` → "Ciente";
    - sem ciência, com `lastReplyMessageId` ou com "Respondeu" no original ou num lembrete → "Respondeu, sem ciência";
    - sem ciência e sem resposta, com o melhor estado de entrega entre o original e os lembretes em Aceito, Entregue ou Lido → "Sem resposta";
    - o resto (Na fila, Falhou, Situação incerta, Pulado em todos) → "Sem entrega".
    - O lembrete e a ciência manual usam a mesma função de grupo.
  - **Rótulo da ciência** *(decisão minha)*: o grupo organiza o painel; o rótulo da ciência aparece ao lado do nome no painel e numa coluna "Ciência" que a tabela de destinatários ganha só no alerta: "Ciente às HH:mm", "Ciente (manual) às HH:mm", "Ciente (após o prazo) às HH:mm", "Ciente (manual, após o prazo) às HH:mm", "Pendente · há N min" ou "Pendente — prazo vencido". Na ciência manual, o painel mostra a observação e o autor no lugar do texto da resposta (e, se houver, a última resposta abaixo). Nas outras finalidades a tabela não muda.
  - O painel fica acima da tabela de destinatários, com o prazo ("Prazo de ciência: 15 min — vence às HH:mm" ou "vencido às HH:mm"), a contagem de cada grupo, o texto da resposta que deu a ciência (ou da última resposta) e a lista dos lembretes do alerta (hora, autor, quantas pessoas). A ordem dos grupos é a da frase; dentro do grupo, por nome.
  - A tela relê o painel a cada 10 s enquanto houver pendência e o alerta tiver menos de 2 horas *(decisão minha)*.
- **I7. Lembrete** (conselho U). "A ação 'Enviar lembrete aos pendentes' exige a permissão de alerta urgente: mostra a lista nominal, da qual quem envia pode tirar nomes, confere o canal na hora e manda o texto original precedido de 'Lembrete:', com a mesma linha de confirmação. Entram no lembrete só pessoas do alerta original ainda sem ciência: as de 'Sem resposta', as de 'Respondeu, sem ciência' e as de 'situação incerta', estas marcadas na lista como 'pode já ter recebido'. O servidor refaz a lista ao confirmar e nunca acrescenta ninguém. 'Falhou' usa o 'Repetir' que já existe; 'pulado' e quem continuar sem entrega ficam como 'tratar por outro meio', com ciência manual. Limites: no máximo 3 lembretes por alerta, com 5 minutos de intervalo desde o alerta ou o lembrete anterior; dois pedidos ao mesmo tempo geram um lembrete só. O lembrete fica ligado ao alerta original e não tem painel nem lembrete próprios. Nesta etapa o sistema não avisa a liderança nem usa outro canal: o escalonamento entra com o INT-04 (Etapa 5), com a regra da GBR."
  - Rota: `POST /internal/team-whatsapp/dispatches/:id/reminders` com `{ recipientIds }` (destinatários do alerta escolhidos na tela; 1 a 500 ids, sem repetição — o mesmo teto da seleção nominal). O servidor recalcula os elegíveis do alerta e envia à interseção; ninguém de fora entra. Interseção vazia → 422 `team_whatsapp.reminder_empty`.
  - Ordem das recusas: 403 (chaves) → 404 (alerta invisível) → 403 remetente e área, como no "Repetir" (`isTeamSender`, `requireAreaOf`) → 422 `not_an_alert` → 422 `reminder_empty` → 409 `team_whatsapp.reminder_limit` (3 lembretes) → 409 `team_whatsapp.reminder_too_soon` (menos de 5 min) → 409 canal desconectado/sem conferência (regras de hoje) → gravação. A interseção, os dois 409 do limite e a troca de `reminderCount` ficam na mesma transação: pedido vazio ou recusado não consome lembrete *(decisão minha)*.
  - **Elegíveis** *(decisão minha)*: pessoa do alerta sem ciência cujo grupo (I6, sobre o original e os lembretes) é "Sem resposta" ou "Respondeu, sem ciência", ou cujo grupo é "Sem entrega" com "Situação incerta" no original ou em algum lembrete (marcada "pode já ter recebido"). Quem está em "Sem entrega" só com Falhou, Pulado ou Na fila não entra.
  - **Quem confirma depois da lista não recebe** *(decisão minha)*: ao mandar cada mensagem de lembrete, o processor confere o destinatário original; se ele já tem ciência, o destinatário do lembrete fica "Pulado: já confirmou" (motivo novo `ACKED`), sem chamada ao provedor, e a `Message` preparada, se houver, vira `CANCELLED` (como no H3). Vale também para o "Repetir" de um lembrete.
  - Pedido único: o alerta guarda `reminderCount` e `lastReminderAt`; o lembrete só é gravado se a troca condicional desses dois campos vencer, na mesma transação que cria o envio do lembrete. O segundo pedido simultâneo recebe 409 `reminder_too_soon` *(decisão minha)*.
  - O lembrete é um envio com finalidade Urgência, o mesmo motivo, o mesmo alvo (`targetType`, `targetId`) e as mesmas linhas de setor do alerta (para o "Repetir" do lembrete passar pela checagem de área), `parentDispatchId` = alerta, `ackDeadlineMinutes` nulo e destinatários com `parentRecipientId`. Telefone, número e a conferência na hora seguem as regras do envio "agora" (inclusive telefone gravado, Lote G). Texto: `Lembrete: ` + texto do alerta (que já termina com a linha de confirmação).
  - Na lista do histórico o lembrete aparece como envio próprio, com "Lembrete do alerta de dd/mm HH:mm", e o detalhe dele segue a visibilidade de hoje (autor ou ADMIN). O painel do alerta mostra os lembretes a quem vê o alerta, mesmo quando outro os mandou (por exemplo, o ADMIN num alerta do SUPERVISOR); o "Repetir" do lembrete fica com quem o vê *(decisão minha)*.
  - Trilha `team_whatsapp.reminder` com ids do alerta e do lembrete e a contagem.
- **I8. Urgência antiga.** Envio de Urgência sem prazo gravado e sem `parentDispatchId` (anterior a esta versão) aparece como hoje: sem painel, sem ciência, sem lembrete. O lembrete também não tem prazo, mas é identificado pelo `parentDispatchId`.
- **I9. Novidades.** Entrada nova em `release-notes.ts` dizendo: alerta urgente com confirmação "OK", painel de pendências, lembrete e ciência manual; a linha fixa "Responda OK para confirmar que recebeu." no fim de todo alerta; e que, até o ADMIN ligar a chave "Criar alerta urgente" para outros papéis, só ele cria alerta (quem tem `equipe.enviar` continua usando as outras finalidades).

## Para a GBR confirmar

- **Lote H:** "Aceito pelo WhatsApp" cobre o "um tique" (H5); destinatário preso há 30 min sem job vira "Falhou" repetível (nada saiu), "Aceito pelo WhatsApp" (saiu) ou "Situação incerta" (pode ter saído), nunca reenviado sozinho (H2). Decisões do plano que mudam o que a GBR vê:
  - a hora da conferência de conexão é apagada quando a tentativa termina antes de chegar ao WhatsApp (número desconectado, conexão não conferida, pessoa pulada), mesmo que uma tentativa anterior tenha conferido; o "Repetir" e o verificador de presos não apagam a hora, então quem volta para a fila ou sai dela sem envio continua mostrando a hora da última conferência que liberou uma tentativa (DH2, DH7);
  - só a mensagem que ainda estava "na fila" é cancelada quando a pessoa é pulada depois; a que já tinha falhado continua "falhou" no chat (DH3);
  - a mensagem presa que o reconciliador de campanhas já fechou como travada aparece como "Situação incerta" (DH6);
  - o preso leva de 30 a 35 minutos para sair de "Na fila", com o rótulo "Saiu da fila sem envio"; envio grande com pacing nunca é tocado enquanto o job existe (DH10, DH4);
  - a migração cria um índice que bloqueia gravações nos destinatários por alguns instantes: o deploy roda fora do horário de envio (DH1).
- **Lote I (conselho U):**
  - o texto da linha de confirmação e as palavras aceitas (ok, ciente, confirmo, recebido, 👍); reação 👍 na mensagem e imagem com legenda "ok" contam só como resposta *(decisão minha)*;
  - o prazo de 15 minutos, fixo para todos (ou por alerta);
  - quem cria alerta urgente (C744): hoje só o ADMIN até ele ligar a chave;
  - canal, contingência e escalonamento (C748): ficam para o INT-04;
  - se quem está em "situação incerta" entra no lembrete;
  - o teto de 3 lembretes com 5 minutos de intervalo;
  - se quem assume o turno pode dar ciência manual (hoje: quem tem a chave e vê o envio, isto é, o autor ou o ADMIN);
  - se a linha fixa no fim do alerta conta como "fluxo aprovado" (C364-365).
  - Decisões do plano que mudam o que a GBR vê (detalhe em "Dúvidas de produto" do plano do Lote I):
    - a resposta só vale como ciência até 24 h depois do aceite do envio mais recente para a pessoa naquele número; depois disso conta só como "Respondeu";
    - o lembrete vai para o número atual da área e para o telefone atual da pessoa (quem trocou de número depois do alerta recebe no número novo);
    - se a fila estiver fora do ar, o lembrete conta no limite de 3 e as pessoas ficam "Falhou", repetíveis;
    - se nenhum dos marcados tem telefone válido, o lembrete é recusado e não conta no limite;
    - quem confirma (ou tem a ciência manual desfeita) nos milissegundos em que o lembrete está saindo pode receber o lembrete (ou ficar "Pulado: já confirmou");
    - lembrete em que todos já tinham confirmado aparece como "Ninguém recebeu";
    - dois "OK" com segundos de diferença: a hora da ciência pode ser de um e a mensagem guardada a do outro;
    - pessoa desativada depois do alerta ainda recebe o lembrete (o "Repetir" de hoje também não confere);
    - a migração segura as tabelas do envio da equipe até terminar: deploy fora do horário de envio e com um container só.
- **Transição:** se o Lote F for à produção antes da Etapa 4, SUPERVISOR e OPERATOR perdem a Urgência na atualização seguinte; a nota de versão precisa dizer isso.

## Aceite

**Lote H**
1. (T08, cenário 9) A suíte de H6 passa inteira com banco real.
2. Destinatário enviado mostra, na coluna "Número", o número e "conexão conferida às HH:mm:ss"; o pulado antes da conferência e o que falhou com o número desconectado mostram só o número.
3. Destinatário `QUEUED` há mais de 30 min sem job: sem mensagem ou com a `Message` `QUEUED` vira "Falhou: saiu da fila sem envio" e o "Repetir" o manda uma vez, sem segunda `Message`; com a `Message` aceita vira "Aceito pelo WhatsApp"; com a `Message` `SENDING` vira "Situação incerta" e não aparece no "Repetir". Destinatário com job esperando há mais de 30 min (fila com pacing) não muda; um "Repetir" entre a leitura e a troca vence o verificador.
4. Destinatário pulado na 2ª tentativa depois de a 1ª ter preparado a mensagem: a `Message` fica `CANCELLED`.
5. A tabela mostra "Quando" com a hora do estado e "Tentativas" com "· repetido n×" depois de um "Repetir".

**Lote I**
6. (T09, cenário 10) Alerta com motivo, duas pessoas, agora: a revisão mostra os nomes e o prazo; uma responde "OK" e aparece "Ciente" com a hora e o texto; a outra aparece em "Sem resposta" e, passados 15 min, "Pendente — prazo vencido".
7. "não entendi" seguido de "Ok!" → "Ciente" (automática), com "não entendi" visível antes; "Ciente." e "👍🏽" → ciente; "ok, mas não vou" → "Respondeu, sem ciência"; áudio, imagem com legenda "ok" e reação → "Respondeu, sem ciência".
8. "OK" depois de um envio de rotina mais novo para a mesma pessoa → nada muda no alerta; "OK" 25 h depois do aceite → só "Respondeu"; "OK" de contato gêmeo (9º dígito) → ciente.
9. Lembrete: entram só "Sem resposta", "Respondeu, sem ciência" e "situação incerta" ("pode já ter recebido"); ciente, "Falhou" e pulado não entram; quem deu ciência entre abrir a lista e confirmar sai; quem dá ciência com o lembrete ainda na fila fica "Pulado: já confirmou", sem chamada ao provedor; "OK" ao lembrete deixa a pessoa ciente no alerta original; "não entendi" ao lembrete põe a pessoa em "Respondeu, sem ciência"; quem estava em "situação incerta" e recebeu o lembrete sai de "Sem entrega"; "OK" de quem está em "situação incerta" sem recibo não muda o alerta (continua pendente).
10. 4º lembrete → 409; lembrete antes de 5 min do anterior → 409; dois cliques simultâneos → um lembrete; número desconectado → 409 e nada criado; autor que deixou de gerir o setor → 403.
11. Ciência manual com observação → "Ciente (manual)", autor e hora na tela, trilha sem a observação; desfazer volta à pendência; desfazer com um "OK" recebido durante a manual → "Ciente" automática com a hora do "OK"; desfazer automática → 422; manual sobre automática (e o contrário, ao mesmo tempo) → uma só ciência, a outra recebe `ack_exists`.
12. SUPERVISOR e OPERATOR sem a chave: a finalidade Urgência não aparece; prévia, criação, lembrete e ciência manual pela API → 403 com o texto da chave, inclusive para alerta que não veem (403 antes de 404). Com a chave ligada pelo ADMIN, o SUPERVISOR cria alerta; se o ADMIN desligar a chave depois, ele continua vendo o painel do próprio alerta, sem lembrete nem ciência manual.
13. O texto gravado e enviado termina com a linha fixa; com 2001 caracteres somados, o botão trava no front e o servidor responde 400; com 2000, é aceito.
14. Urgência antiga aparece sem painel e sem ciência; reunião com resposta "OK" fica só "Respondeu".
15. Nenhum log ou trilha nova contém texto de resposta, observação, nome ou telefone.
16. Prazo: ciência 20 min depois do alerta → "Ciente (após o prazo) às HH:mm"; um lembrete aos 10 min não muda o "vence às" do alerta.
17. Falha no rastreio da resposta (erro ao gravar) → a pessoa continua pendente e a mensagem recebida fica no chat.
18. Novidades: a entrada nova aparece no topo, com a linha de confirmação e o aviso da chave.
19. "Repetir" das falhas de um alerta funciona com `equipe.enviar`, sem `equipe.urgencia`; ciência manual em envio que não é alerta → 422 `not_an_alert`; lembrete só com ids fora dos elegíveis → 422 `reminder_empty`.
20. Lembrete mandado pelo ADMIN num alerta do SUPERVISOR aparece no painel do alerta para o SUPERVISOR; o detalhe do lembrete fica com o ADMIN.
21. Destinatário preso com `Message` em falha certa e reenviável → "Falhou" com o código dela e entra no "Repetir"; a `Message` `QUEUED` do ramo "nada saiu" fica `FAILED`, sem continuar "na fila" no chat.
22. "OK" que chega ao mesmo tempo que a ciência manual: a manual vale e o `ackMessageId` fica guardado; desfazer a manual passa a ciência para automática; "OK" gravado durante o desfazer também resulta em ciência automática.

## Fica com o construtor

- Nomes de colunas, enums, rotas internas, arquivos e a divisão em tasks, respeitando os contratos acima.
- O lugar do verificador de presos no worker (fila repetível nova ou dentro de uma existente) e o tamanho do lote por ciclo.
- A normalização exata das palavras (remoção de acentos e da pontuação das pontas), desde que os casos do aceite 7 passem.
- O desenho do painel e da lista do lembrete, seguindo os componentes que já existem no resultado.
