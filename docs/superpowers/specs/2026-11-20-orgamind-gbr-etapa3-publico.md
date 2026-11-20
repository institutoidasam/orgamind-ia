# OrgaMind — Etapa 3 do plano GBR: público certo e composição do envio

## Intenção

Terceira etapa do plano entregue à GBR (`reports/plano-gbr/`), na ordem pedida pelo usuário em 19/11/2026. Itens da etapa: PUB-01, PUB-02, PUB-03, MSG-01, PUB-04 e DAT-01. **PUB-01** (vários turnos no mesmo envio) e **PUB-03** ("fora: não selecionado") já foram feitos no PR #11 (spec `2026-11-10-orgamind-numero-por-area-envio-rastreavel.md`, seção 4). Esta spec cobre o resto:

- **PUB-02**: a base do público depende da finalidade (equipe em serviço ou equipe vinculada); folga e férias deixam de andar juntas;
- **MSG-01**: finalidade do envio, dados da atividade (data, hora e local) separados do momento do disparo, agendamento em data e hora livres, política do agendamento registrada;
- **PUB-04**: prévia nominal calculada no servidor, com todos os motivos de exclusão, o painel da regra usada e as travas do botão;
- **DAT-01**: fotografia completa de cada envio (finalidade, base, regra, incluídos e excluídos com motivo, telefone usado) e histórico com busca.

**Por que agora:** hoje o envio para a equipe sempre usa a escala do dia. Uma reunião marcada para quinta convida quem trabalha na quinta, não a equipe do setor; quem está de férias entra junto com quem está de folga; e o histórico não diz qual regra montou o público. O caderno da GBR diz que "o público de uma mensagem depende da finalidade" (C19-27).

**De onde vêm as regras.** O Caderno e o Escopo da GBR de 28/10/2026. As três regras que o caderno deixa pendentes (férias, congelar ou recalcular o agendamento, base fixa ou escolhida) foram decididas pelo Conselho T em 20/11/2026 (`~/.claude/tribunais/2026-11-20/conselho-T/sentenca-T.md`) e estão marcadas **(conselho T)**, provisórias até a GBR confirmar. O que é escolha minha está marcado *(decisão minha)*.

**Fontes:** `escopo.txt` e `caderno.txt` em `.superpowers/sdd/2026-11-19-orgamind-gbr-etapa1-lote-a-ficha-trilha/fontes/` (linhas citadas como C e E); mapas do código em `.superpowers/sdd/2026-11-20-orgamind-gbr-etapa3-publico/fontes/` (`mapa-envio-back.md`, `mapa-escala-vinculo.md`, `mapa-front-envio.md`, `mapa-caderno-escopo.md`).

**Vocabulário:**
- "Envio" é um disparo de WhatsApp para a equipe (`TeamWhatsappDispatch`); "destinatário" é cada pessoa dele.
- "Equipe em serviço" é quem a escala da data põe para trabalhar no setor e turno (inclui o remanejado para o setor; exclui quem foi remanejado para fora).
- "Equipe vinculada" é quem tem o setor e o turno no cadastro (vínculo habitual) na data, trabalhe ou não nesse dia.
- "Data de referência" é a data cuja escala e cujo vínculo valem para o público.
- "Alcance" são os setores que o usuário gerencia (ADMIN alcança todos).

## Objetivos

1. Quem envia escolhe a finalidade, e o sistema monta o público pela regra da finalidade, explicando na prévia quem entra, quem fica de fora e por quê.
2. Reunião, palestra e hora extra levam data, hora e local da atividade, separados da hora em que a mensagem sai.
3. A mensagem pode ser agendada para uma data e hora livres, além de "agora" e "início do turno".
4. Quem está de férias nunca recebe; quem está de folga só entra quando a finalidade permite e a pessoa marcou.
5. O operador confirma exatamente a lista que viu; se o público mudar até a confirmação, o sistema avisa em vez de enviar a outra lista.
6. O histórico mostra, para cada envio, a finalidade, a base, a regra, os dados da atividade, quem recebeu, quem ficou de fora e por quê, mesmo depois que o cadastro ou a escala mudarem.

## Não objetivos

- Ciência individual, confirmação de presença ou disponibilidade e pendências com responsável (MSG-02, INT-04): ficam para a etapa deles. Entregue ou lido continua não sendo confirmação.
- Aprovação de envio por outra pessoa, prioridade e passagem de turno na caixa de respostas.
- Alterar escala por resposta à hora extra (o caderno proíbe: C211-212).
- Editar um envio agendado. Continua só cancelar e criar de novo.
- Mudar o envio direto a uma pessoa (menu da pessoa): não ganha finalidade nesta etapa **(conselho T)**.
- Data operacional nova para turno noturno: continua a regra de hoje, o turno pertence à data em que começa (ver "Para a GBR confirmar").
- Mudar campanhas, segmentos e o público de marketing.

## Anti-objetivos (falha mesmo que funcione)

- Uma pessoa de férias receber mensagem de qualquer finalidade.
- O envio sair para uma lista diferente da que o operador conferiu na prévia, sem aviso.
- Um envio agendado mandar mensagem a alguém que não estava na lista da criação.
- Mandar mensagem para um número que não era o da pessoa quando o operador conferiu.
- O histórico de um envio antigo mudar porque o cadastro, o vínculo ou a escala mudaram.
- Um envio em que ninguém recebeu aparecer como sucesso.

## Restrições

- Mesmo módulo e mesmas rotas do envio para a equipe (`backend/src/modules/team-whatsapp/`, `frontend/src/features/team-whatsapp/`); permissões de hoje (`equipe.enviar`, `equipe.disparo_amplo`, `telefone.ver_completo`); sem chave nova.
- O disparo agendado continua idempotente: dois ticks do worker nunca enviam a mesma mensagem duas vezes.
- Telefone, bloqueio e autorização de contato continuam conferidos no envio de cada mensagem, como hoje.
- Fuso de Manaus em todas as datas e horas, como no resto do sistema.
- Envios e agendados criados antes desta versão continuam válidos e aparecem no histórico como estão. "Antes desta versão" tem dois critérios *(revisão 2, N1)*: **para mostrar** no histórico, é o envio sem finalidade gravada (C5); **para disparar** pela regra antiga, é o agendado sem política gravada (campo nulo). Um envio do Lote F tem finalidade e, se agendado, política nula.
- **Os Lotes F e G vão para produção juntos** *(decisão minha; revisão 1, I7)*: o PR do F não é publicado sozinho, porque sem a reconferência do G um agendado criado na janela mandaria mensagem a quem entrou de férias depois. No F, o agendado grava política nula e dispara pela regra antiga.

## O que fica decidido

### Comum aos dois lotes

#### C1. Finalidades

Lista fixa (matriz do caderno, C184-217):

| Finalidade | Base | Folga | Dados obrigatórios | Momento do disparo |
|---|---|---|---|---|
| Aviso de turno | Equipe em serviço | fora, sem opção | data e turno | agora, início do turno, data e hora |
| Reunião | Equipe vinculada | opção "Incluir folga", marcada | data, hora e local da atividade | agora, data e hora |
| Alinhamento | escolha: vinculada (padrão) ou em serviço | opção só na base vinculada, desmarcada | nenhum além do texto; se informar a atividade, data e hora obrigatórias, local opcional | agora, data e hora |
| Palestra | Equipe vinculada | opção "Incluir folga", marcada | data, hora e local da atividade | agora, data e hora |
| Hora extra | Equipe vinculada + seleção nominal obrigatória | opção "Incluir folga", desmarcada | data, hora e local da atividade | agora, data e hora |
| Urgência | Equipe em serviço | fora, sem opção | motivo e data | só agora |

- Envio para a equipe exige finalidade. O padrão da tela é "Aviso de turno", que é o comportamento de hoje.
- **Folga marcada por padrão** em Reunião e Palestra, desmarcada em Alinhamento e Hora extra *(decisão minha; o caderno mostra a folga "incluída no exemplo" de reunião e palestra, C196, C206, C234)*. O rótulo passa de "incluir folga/férias" para "Incluir quem está de folga".
- **Alinhamento na base em serviço não tem opção de folga** *(decisão minha; o caderno diz "configurável", C201, mas a base em serviço já deixa a folga fora no aviso de turno e na urgência)*.
- **Base (conselho T):** "A finalidade define a base. Aviso de turno e Urgência: equipe em serviço (escala da data; folga fora, sem opção). Reunião, Palestra e Hora extra: equipe vinculada (setor e turno do cadastro na data), com a opção 'Incluir folga'. Alinhamento: o operador escolhe entre equipe vinculada (padrão) e equipe em serviço. A base aparece sempre na prévia, na confirmação e no histórico, com a frase que explica por que quem está de folga entra ou sai. Fora do Alinhamento o operador não troca a base; ajusta setores, turnos e pessoas. Envios anteriores a esta versão aparecem como 'equipe em serviço (regra anterior)'." O servidor recusa base diferente da fixada com 422.
- **"Incluir folga" na base vinculada vale com qualquer seleção de turnos** *(decisão minha; PUB-02 pede "incluir folga também quando o envio tem um turno específico")*: o turno escolhido é o turno do cadastro, e quem está de folga nesse dia entra se a opção estiver marcada. Na base em serviço não há opção de folga.
- **Férias (conselho T):** "Quem está de férias na data de referência fica fora do público em todas as finalidades, inclusive por seleção nominal. A pessoa aparece na prévia e no histórico entre os excluídos, com o motivo 'Férias', separado de 'Folga'. A opção 'Incluir folga' passa a incluir só quem está de folga; antes incluía também quem estava de férias, e essa mudança vai nas notas de versão. Nesta etapa não há opção, permissão nem configuração para incluir férias. O envio direto a uma pessoa não muda nesta etapa."
- Setores, turnos, níveis e "somente os marcados" continuam como hoje (PUB-01 e PUB-03). A seleção nominal só restringe, nunca amplia (E181-182). Na hora extra, marcar pelo menos uma pessoa é obrigatório.

#### C2. Data de referência

- A data de referência vai sempre explícita no pedido; o servidor nunca a deduz do relógio *(revisão 1, I1)*. A tela a preenche conforme a finalidade, e o atalho de hoje ("turno noturno em andamento" sugere a véspera) continua só na tela.
- Aviso de turno: a data escolhida na tela (como hoje).
- Reunião, Palestra e Hora extra: a data da atividade.
- Alinhamento: a data da atividade, se informada; senão, a data escolhida na tela.
- Urgência: a data escolhida na tela, que vem preenchida com hoje (ou com a véspera pelo atalho do turno noturno em andamento). Um envio tem uma data só: para alcançar ao mesmo tempo o turno noturno que começou ontem e o turno de dia de hoje, são dois envios.
- A equipe vinculada de uma data é o vínculo que vale naquele dia — setor, turno e nível: o histórico de vínculo para data passada e o cadastro para hoje e o futuro, como o quadro da escala já faz.

#### C3. Quem entra e quem fica de fora

- **Equipe em serviço:** quem a escala da data põe para trabalhar num dos setores e turnos escolhidos. Remanejado para o setor entra; quem foi remanejado para outro setor sai do setor de origem, com o motivo "Em outro setor nesta data". Folga e férias ficam de fora com o motivo.
- **Equipe vinculada:** quem tem um dos setores e turnos escolhidos no vínculo da data. Quem trabalha em outro setor nesse dia (remanejado) entra pelo setor do vínculo. Troca de turno não muda a pessoa de turno nesta base. Folga entra só com "Incluir folga"; férias, nunca. Com "todos os turnos", entra também quem tem o setor sem turno no vínculo e quem tem turno inativo no vínculo; com turnos escolhidos, só quem tem um deles *(decisão minha; revisão 1, M10)*. Filtro de nível usa o nível do vínculo da data.
- Cada pessoa conta uma vez, mesmo que caia em vários setores (como hoje).
- **Motivos de exclusão mostrados** *(decisão minha: os do escopo PUB-04, mais os que já existem)*:
  - "Não selecionado" (PUB-03);
  - "Folga" e "Férias";
  - "Em outro setor nesta data" (só na base em serviço);
  - "Fora do turno nesta data" (só na base em serviço: vinculado ao setor, mas a escala o põe em outro turno ou em nenhum);
  - "Sem telefone", "Contato não autorizado", "Número bloqueado" (os de hoje).
- Pessoa inativa não aparece na prévia (não faz parte da equipe); "Inativa" só aparece na reconferência do agendado (G3) *(revisão 1, I5)*.
- Quem não tem relação com os setores escolhidos não aparece na lista.
- **Seleção nominal** *(revisão 1, I3)*: um id marcado é válido se a pessoa tem relação com os setores e turnos escolhidos na base da finalidade, entre os incluídos ou entre os excluídos com motivo; fora disso, 422 `invalid_selection`, como hoje. Quem foi marcado e está excluído mantém o motivo próprio ("Férias", "Folga", "Sem telefone"...), nunca "Não selecionado". Na tela, só dá para marcar quem está em "Vão receber" ou em "Não selecionado" (fora da seleção nominal, mas apto); o caso de marcado e excluído acontece quando a escala muda depois de marcar ou por chamada direta à API, e a tela mostra essa pessoa em "Marcados que ficam de fora", só para desmarcar *(fechamento do Lote F, revisões T14 e varredura)*.

#### C4. Prévia no servidor

- A prévia passa a ser calculada pelo servidor (rota nova de prévia, com o mesmo corpo do envio), com a mesma função que monta o público no envio. Hoje ela é calculada na tela a partir do quadro.
- A prévia aceita texto vazio e seleção vazia (a hora extra precisa ver os candidatos antes de marcar alguém) e devolve as travas do botão como lista; o 422 com o texto da trava fica só no envio *(revisão 2, N4)*. Id marcado sem relação com os setores e turnos escolhidos: a prévia responde 422 `invalid_selection`, como o envio *(revisão 3)*.
- **Quem pode pedir a prévia** *(revisão 1, I4)*: as mesmas travas do envio — `equipe.enviar`, alcance em todos os setores pedidos (403 fora dele, sem dizer quais setores existem) e `equipe.disparo_amplo` quando o envio seria amplo. A prévia não mostra quem está fora do alcance.
- Mostra: "Vão receber (n)" com nome, setor, turno e nível; "Ficam de fora (n)" agrupados por motivo; e o **painel da regra**: finalidade, base (com a frase da folga), setores, turnos, níveis, folga incluída ou não, data de referência, dados da atividade, momento do disparo e política do agendamento.
- O telefone na prévia segue `telefone.ver_completo`, como hoje.
- **Confirmar o que foi visto** *(decisão minha; mesma lição do Lote E; revisão 1, I2)*: a prévia devolve uma impressão do público que cobre a regra, os incluídos, os excluídos com o motivo e o telefone de cada um (resumo, sem expor o número). O envio leva essa impressão; se o servidor calcular outra coisa na hora de criar — outra pessoa, outro motivo ou outro telefone —, responde 409 `audience_changed` "O público mudou depois da prévia. Confira de novo antes de enviar." e não cria nada. A tela fecha a confirmação e relê a prévia. A comparação da impressão vem antes da validação da seleção nominal: marcado que perdeu a relação com o setor entre a prévia e a confirmação dá 409, não 422 *(revisão 2, N3)*.
- **Travas do botão** (C296-297, E159-161): público vazio; texto vazio; dado obrigatório da finalidade faltando; motivo da urgência faltando; hora extra sem pessoa marcada; disparo no passado; disparo (agora ou agendado) depois do início da atividade, "A mensagem precisa sair antes do início da atividade." *(revisão 1, M11)*; número da área indisponível (como hoje). Cada trava aparece por extenso perto do botão. O servidor confere as mesmas regras e responde 422 com o texto.

#### C5. Envios antigos

- Envio sem finalidade gravada (criado antes desta versão): finalidade "—", base "equipe em serviço (regra anterior)", sem dados de atividade; o resto do histórico como hoje.
- Envio direto a uma pessoa não tem finalidade nem base (não muda nesta etapa): no histórico aparece como antes, sem finalidade, base nem "regra anterior"; "regra anterior" é só de envio a setor criado antes desta versão *(decisão do construtor no fechamento do Lote F, revisão final I1; a GBR pode pedir finalidade também no envio a uma pessoa)*.
- Agendado sem política gravada e ainda pendente: dispara pela regra antiga **(conselho T)**. Inclui os agendados criados no Lote F antes do G, que vão juntos para produção.

### Lote F — Finalidade e público (PUB-02, PUB-04 e a parte de finalidade do MSG-01)

#### F1. Tela de envio

- Primeiro campo: finalidade. Trocar a finalidade ajusta base, opção de folga, campos obrigatórios e momentos de disparo permitidos; a seleção de pessoas é refeita.
- Campos da atividade (Reunião, Palestra, Hora extra; opcionais no Alinhamento): data, hora de início e local (até 120 caracteres). Urgência: campo "Motivo da urgência" (até 200 caracteres).
- No Alinhamento, um controle "Base do público": "Equipe vinculada" (padrão) ou "Equipe em serviço". Nas outras finalidades a base aparece como texto, sem controle.
- "Incluir folga" aparece só na base vinculada.
- A prévia vem do servidor e se atualiza quando os filtros mudam. Antes de confirmar, o diálogo mostra o painel da regra e a contagem.
- Envio "agora" e "início do turno" continuam como hoje; o agendamento em data e hora livres é do Lote G.

#### F2. Gravação do envio

- O envio grava: finalidade, base, folga incluída, dados da atividade, motivo da urgência e a regra (setores, turnos, níveis, seleção, data de referência).
- Os excluídos da prévia são gravados com o motivo (nome, setor e turno considerados, sem telefone), para o histórico mostrar quem ficou de fora sem recalcular.
- Trilha: os registros de hoje (`team_whatsapp.dispatch`, `team_whatsapp.schedule`) passam a levar a finalidade e a base; sem nome, telefone nem texto, como hoje.

#### F3. Histórico (o que já aparece)

- A lista e o detalhe mostram finalidade, base e dados da atividade; o detalhe mostra o painel da regra e os excluídos por motivo, lidos do que foi gravado.

### Lote G — Agendamento e fotografia (MSG-01 e DAT-01)

#### G1. Agendar para data e hora livres

- Novo momento "Data e hora": qualquer data e hora futura, até 30 dias à frente *(decisão minha)*, em todas as finalidades menos Urgência.
- O disparo precisa ser antes do início da atividade (trava de C4).
- Urgência agendada: 422.
- "Início do turno" continua só no Aviso de turno com um turno.

#### G2. Texto a partir dos dados da atividade (rascunho)

- Botão "Preencher com os dados da atividade": monta o texto com finalidade, data, hora e local, para o operador completar (C305-307). Não é template do WhatsApp; é texto livre.
- Se o operador mudar data, hora ou local depois de preencher, a tela mostra "Os dados da atividade mudaram depois que o texto foi preenchido. Confira o texto." e o botão de enviar só libera depois de "Preencher de novo" ou de marcar "Conferi o texto" *(decisão minha)*.
- Nada é guardado como rascunho no servidor *(decisão minha)*: fechar a tela perde o texto, como hoje.

#### G3. Política do agendamento (conselho T)

> "O público de um envio agendado é congelado na criação, em todas as finalidades: é a lista que o operador conferiu na prévia. Na hora do disparo o sistema reconfere essa lista com as mesmas regras da prévia, sobre a mesma data de referência, e só pode retirar pessoas, nunca acrescentar. Quem deixou de se enquadrar é pulado com o motivo: 'Férias', 'Folga', 'Saiu do setor ou turno' ou 'Inativa'. Telefone, bloqueio e autorização de contato continuam conferidos no envio de cada mensagem. Quem passou a se enquadrar depois do agendamento não recebe; quando o envio era para 'todos os aptos', o histórico lista essas pessoas como 'entraram depois do agendamento, não receberam'. O envio grava a política 'congelado com reconferência'; o histórico mostra a foto da criação, a hora da reconferência e quem foi pulado. Se todos forem pulados, o histórico mostra 'ninguém recebeu', nunca sucesso. Se a reconferência falhar, nada é enviado e o sistema tenta de novo no minuto seguinte. Agendados criados antes desta versão disparam pela regra antiga."

- "Folga" na reconferência só retira quem não estava de folga na criação e a folga não foi incluída; quem entrou por "Incluir folga" continua *(leitura da sentença, item 4 das consequências)*.
- **Motivos da reconferência** *(revisão 1, M12)*: "Férias" e "Folga" como na prévia; "Em outro setor nesta data" e "Fora do turno nesta data" da prévia viram, na reconferência, "Saiu do setor ou turno"; "Inativa" só existe aqui.
- **Invariantes do disparo** (sentença T, consequência 3): só quem ganha o claim do agendado reconfere; só destinatários ainda agendados mudam de estado; nenhuma linha de destinatário é inserida (quem "entrou depois" fica num registro à parte, com nome, setor e turno, sem telefone); dois ticks ao mesmo tempo resultam em um envio só; erro na reconferência não envia nada, nem parte, e o envio continua agendado.
- **Teto de atraso** *(decisão minha; ponto 9 da sentença; revisão 1, I6)*: agendado que não disparou até 2 horas depois da hora marcada (worker parado) não sai mais. O teto entra na mesma condição atômica que pega o agendado para disparar (só pega quem está agendado, venceu e não passou de 2 horas), para um tick não disparar enquanto outro o marca como vencido. O envio vencido passa a um estado próprio, "Não enviado: passou da hora", sai da lista de agendados e mostra no histórico o aviso para reenviar; os destinatários ficam pulados com esse motivo. Vale também para os agendados antigos. Se a reconferência falhar por erro, tenta de novo a cada minuto dentro desse prazo.
- Envio "agora" também grava a política ("envio imediato") para o histórico ficar uniforme.

#### G4. Telefone congelado (DAT-01)

- O número de cada destinatário é gravado na criação do envio, agora ou agendado (hoje só o número da área é gravado).
- No envio de cada mensagem (inclusive no "Repetir"), se o telefone atual da pessoa não for o gravado, a mensagem não sai e o destinatário fica **pulado** com "Telefone mudou depois da criação do envio" *(decisão minha: nunca mandar para um número que o operador não conferiu, nem para um número antigo que pode ser de outra pessoa; revisão 1, I6)*. Pulado não é falha: o "Repetir" não o pega, e o histórico sugere criar um envio novo. O histórico mostra o número usado conforme `telefone.ver_completo`.
- Destinatário de envio antigo, sem telefone gravado, continua usando o telefone atual (inclusive no "Repetir").
- Bloqueio e autorização de contato continuam conferidos no envio, como hoje.

#### G5. Histórico com busca

- Filtros no histórico: período (data de criação), finalidade e situação *(revisão 1, M14: o escopo não pede busca em texto livre nem filtro por autor; ficam fora)*. Quem não é ADMIN continua vendo só os próprios.
- Paginação como hoje (20 por página).
- No detalhe: busca por nome entre os destinatários e os excluídos.
- A data de referência (`rosterDate`), que já é gravada, aparece na lista.

## Para a GBR confirmar

- **Base do público por finalidade** (conselho T): aviso de turno e urgência em serviço; reunião, palestra e hora extra pelo vínculo; alinhamento à escolha. O operador não troca a base fora do alinhamento.
- **Férias** (conselho T): sempre fora, inclusive por seleção nominal; sem opção para incluir. A opção "Incluir folga" deixou de incluir férias.
- **Folga:** fora no aviso de turno e na urgência, sem opção; opcional em reunião, palestra, hora extra e alinhamento pelo vínculo, marcada por padrão em reunião e palestra; o alinhamento na base em serviço não tem opção de folga. Quem autoriza incluir folga continua sendo quem envia (C732 pendente).
- **Agendamento** (conselho T): congelado com reconferência que só retira; quem entrou depois não recebe e aparece no histórico.
- **Teto de atraso do agendado:** 2 horas depois da hora marcada.
- **Telefone congelado:** se a pessoa trocou de telefone depois da criação do envio, a mensagem não sai e ela fica pulada (o "Repetir" não a pega).
- **Histórico:** filtros por período, finalidade e situação, e busca por nome no detalhe; sem busca no texto da mensagem nem filtro por autor.
- **Envio direto a uma pessoa de férias** (conselho T): hoje sai; vale decidir se deve ser barrado.
- **Turno noturno:** continua pertencendo à data em que começa (C728).
- **Urgência:** só "agora", base em serviço, sem folga, uma data por envio (turno noturno de ontem e turno de dia de hoje são dois envios); lista de motivos é texto livre (o caderno não traz lista).
- **Agendamento:** até 30 dias à frente; mensagem de atividade precisa sair antes do início dela.
- **Rascunho:** só na tela, não fica guardado.
- **Envio direto a uma pessoa sem finalidade** (fechamento do Lote F): continua sem finalidade e sem base, e o histórico o mostra como antes; vale decidir se a finalidade também deve ser pedida nesse envio.
- **Marcado que ficou de fora** (fechamento do Lote F): aparece em "Marcados que ficam de fora", só para desmarcar, e também no grupo do motivo em "Ficam de fora".

## Aceite

**Lote F**
1. (Cenário 1, T06) Aviso de turno para um setor: entram só os escalados e os remanejados para o setor; folga e férias aparecem fora com o motivo; quem foi remanejado para outro setor aparece como "Em outro setor nesta data".
2. (Cenário 2, T04) Reunião em dois setores e dois turnos, com "Incluir folga": entram os vinculados, inclusive quem está de folga; quem está de férias fica fora; cada pessoa aparece uma vez.
3. Reunião sem "Incluir folga": quem está de folga fica fora com "Folga".
4. (Cenário 5) Palestra sem hora ou sem local: o botão fica travado com o texto da trava, e o servidor responde 422 se chamado direto.
5. (Cenário 4, T05) Seleção de duas pessoas: só elas recebem; as outras aparecem como "Não selecionado".
6. (Cenário 6) Hora extra sem pessoa marcada: travada; com uma pessoa marcada, só ela; se ela estiver de férias, fica fora e o público vazio trava o envio.
7. (Cenário 8) Pessoa de férias marcada nominalmente numa reunião: não entra; aparece como "Férias".
8. (Cenário 10, T09 parcial) Urgência para duas pessoas: exige motivo, só "agora", base em serviço; a revisão mostra os nomes.
9. (Cenário 7) Remanejado de A para B na data: entra em B num aviso de turno de B; num convite por vínculo de A, entra em A.
10. Alinhamento nas duas bases dá públicos diferentes quando há folga e remanejado; em outra finalidade, mandar base diferente da fixada responde 422.
11. Escala alterada entre a prévia e a confirmação: o envio responde 409 "O público mudou depois da prévia…" e nada é criado.
12. O histórico do envio mostra finalidade, base, painel da regra e excluídos por motivo; editar a pessoa ou a escala depois não muda o que aparece (T01).
13. Envio antigo aparece com finalidade "—" e base "equipe em serviço (regra anterior)".
14. Em cada finalidade, a prévia mostra "Férias" e "Folga" como motivos separados; a opção se chama "Incluir quem está de folga" e vem marcada em Reunião e Palestra.
15. Aviso de turno: pessoa do setor que a escala põe em outro turno aparece como "Fora do turno nesta data".
16. Telefone de um incluído trocado entre a prévia e a confirmação: 409 `audience_changed`.
17. Gestor pedindo prévia de setor que não gerencia: 403; sem `telefone.ver_completo`, a prévia mostra telefones mascarados.
18. Urgência com a data da véspera (turno noturno em andamento): entram os escalados no turno noturno que começou ontem.
19. Trilha do envio com finalidade e base, sem nome, telefone nem texto.

**Lote G**
20. Agendar reunião para daqui a 3 dias às 9h (atividade às 14h): sai na hora marcada para a lista da criação.
21. (T07) Agendar aviso de turno e lançar férias para uma pessoa depois: no disparo ela é pulada com "Férias"; os outros recebem; o histórico mostra a foto da criação, a hora da reconferência e o pulado.
22. (T07) Agendar para "todos os aptos" e acrescentar uma pessoa ao setor depois: ela não recebe e aparece como "entraram depois do agendamento, não receberam".
23. Reunião com "Incluir folga" e folga lançada depois para um convidado: ele continua recebendo.
24. Todos pulados na reconferência: o histórico mostra "ninguém recebeu", nunca sucesso.
25. Dois ticks do worker ao mesmo tempo: cada mensagem sai uma vez; erro na reconferência não envia nada e o envio segue agendado.
26. Agendado vencido há mais de 2 horas (worker parado): não sai e aparece "Não enviado: passou da hora".
27. Agendado criado antes desta versão dispara pela regra antiga.
28. Pessoa troca de telefone depois do agendamento: a mensagem dela não sai e ela aparece pulada com "Telefone mudou depois da criação do envio"; o "Repetir" não a pega.
29. Preencher o texto com os dados da atividade, mudar a hora: aparece o aviso e o botão só libera depois de preencher de novo ou marcar "Conferi o texto".
30. Mensagem de reunião agendada para depois do início da reunião: travada com o texto.
31. Histórico: filtrar por finalidade, período e situação; buscar uma pessoa no detalhe.
32. (T07) Aviso de turno agendado e troca de turno lançada depois para uma pessoa: no disparo ela é pulada com "Saiu do setor ou turno".
33. (T07) Reunião agendada e férias lançadas depois para um convidado: ele é pulado com "Férias"; o mesmo vale para a hora extra nominal.
34. (T07) Pessoa transferida de setor depois do agendamento de um envio por vínculo: pulada com "Saiu do setor ou turno".
35. (T07) Aviso de turno agendado para o turno noturno: a reconferência usa a data de referência gravada, não a data do disparo.
36. Agendado antigo vencido há mais de 2 horas: também não sai e aparece "Não enviado: passou da hora".
37. Agendar para mais de 30 dias à frente ou agendar Urgência: 422 com o texto.
38. "Repetir" em envio antigo, sem telefone gravado: usa o telefone atual da pessoa.
39. (T07) Aviso de turno agendado e folga lançada depois para uma pessoa: no disparo ela é pulada com "Folga".

## Fica com o construtor

- Forma da impressão do público da prévia (hash ou lista) e onde guardar a regra e os excluídos (colunas ou JSON), desde que o histórico leia o gravado.
- Posição da reconferência no disparo (dentro da transação do claim ou logo depois), desde que valham as invariantes do disparo (G3, aceite 25).
- Texto exato do preenchimento da atividade e das frases da base.
- Divisão em tasks e ordem; os dois lotes podem virar dois PRs, F antes de G.
