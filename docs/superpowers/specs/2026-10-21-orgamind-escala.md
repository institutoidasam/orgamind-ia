# OrgaMind — módulo de escala: turnos cadastráveis, escala por pessoa, envio por data e agendado

## Intenção

O cliente (GBR) quer mandar WhatsApp para a equipe que **está trabalhando** num dia e turno, conferindo antes quem recebe, quem está de folga e quem está sem telefone. Ele também quer que avisos comuns saiam no início do turno, que urgências alcancem todos os turnos e que o histórico guarde quem estava escalado e quem recebeu.

A primeira versão (PR #7, em produção desde 21/10/2026) entregou um turno fixo por pessoa (`User.shift`, com `FIRST`/`SECOND`) e o envio por setor + turno com seleção de nomes. Este módulo completa o pedido: turnos com horário, escala que muda conforme o rodízio, filtro por data, folga, envio agendado, histórico com a foto da escala e campo "função".

O usuário vai apresentar ao cliente quando estiver em produção. Ajustes vêm depois, conforme o retorno do cliente. Por isso, a regra é **configurável e simples de mudar**: modelos prontos para o caso comum, edição livre para o resto.

As decisões abaixo foram propostas por mim e aceitas pelo usuário em 21/10/2026 ("está bom, pode seguir" e "continue"). O que está marcado *(decisão minha)* foi detalhado depois, para fechar o desenho.

## Objetivos

1. Turnos cadastráveis, com nome e horário.
2. Escala por pessoa como um ciclo que se repete (rodízio automático), mais exceções por data.
3. Um quadro da escala por setor, para ver e editar.
4. Envio do WhatsApp da equipe por **setor + data + turno**, mostrando escalados, folgas e quem está sem telefone.
5. Envio agendado para o início do turno, com cancelamento.
6. Histórico com a foto da escala no momento do envio.
7. Campo "função" na pessoa.

## Não objetivos

- Ponto eletrônico, banco de horas, horas extras e jornada parcial dentro do turno.
- Pedido ou aprovação de troca de turno entre pessoas.
- Feriados automáticos. Feriado se marca como exceção.
- Mensagem recorrente automática (por exemplo, todo dia às 06:00). O agendamento é por envio, um de cada vez.
- Filtro por função.
- Escala em Comunicados, Demandas ou outros módulos.
- Exportar ou imprimir a escala.
- Notificar a pessoa quando a escala dela muda.

## Anti-objetivos (falha mesmo que funcione)

- Alguém receber uma mensagem que não estava na lista conferida antes de enviar ou agendar.
- Um envio agendado sair duas vezes, ou sair depois de cancelado.
- "Hoje" ser calculado em UTC: à noite em Manaus, o sistema mostraria a escala do dia seguinte.
- Quem ainda não tem escala sumir da tela de envio. Hoje essas pessoas aparecem pelo turno do cadastro.
- Perder o turno que o cliente já cadastrou na primeira versão.

## Restrições

- Stack e padrões atuais do repositório:
  - backend NestJS + Prisma + Zod (`createZodDto`) + BullMQ;
  - frontend React + TanStack Query/Router + Radix;
  - testes com Vitest; integração com testcontainers.
- Fuso: `America/Manaus` (UTC−4, sem horário de verão), o mesmo `TIMEZONE_DEFAULT` das campanhas (`backend/src/worker.ts`). Datas da escala são datas civis (`YYYY-MM-DD`) nesse fuso.
- Política de envio inalterada (`team-whatsapp.policy.ts`): o ADMIN alcança todos os setores ativos e o gestor (`Sector.managerId`), os setores que gerencia.
- Pipeline do envio reaproveitado:
  - `TeamWhatsappDispatch` com um `TeamWhatsappRecipient` por pessoa;
  - fila `TEAM_WHATSAPP_SEND` com um job por destinatário;
  - pulados com motivo (`NO_PHONE`, `SUPPRESSED`); canal, texto de até 2000 caracteres, supressão e pacing atuais.
- O agendamento segue o padrão já usado nas campanhas: um tick por minuto (job repetível em `worker.ts` + processor, como `scheduler.processor.ts`) procura o que venceu e dispara.
- Migrações sem perda de dados. O deploy em produção acontece num VPS com pouca memória: não acrescentar serviço novo no compose.

## O que fica decidido

### 1. Turnos cadastráveis

- Entidade **Turno**: nome (único), horário de início e de fim (`HH:mm`), ativo/inativo e ordem de exibição.
  - Fim menor ou igual ao início significa que o turno atravessa a meia-noite (ex.: "Noite 22:00–06:00").
  - Um turno pertence à data em que **começa**.
- Tela **Turnos**, só para o ADMIN: criar, editar, desativar e reordenar.
  - Não se apaga turno usado em escala ou histórico; ele é desativado.
  - Turno inativo não aparece para nova escala nem para envio, mas continua no histórico.
  - *(Decisão minha)* Um turno **não pode ser desativado enquanto está em uso**:
    - como turno do cadastro de alguém;
    - num dia de ciclo de escala;
    - numa exceção de hoje em diante;
    - num envio agendado pendente.
    A tela diz onde ele está em uso. Assim ninguém some da escala por causa de um turno desativado.
  - *(Decisão minha)* Mudar o horário de um turno vale para novos agendamentos. Envio já agendado mantém a hora gravada, e a lista de agendados mostra essa hora.
- **Migração da primeira versão**:
  - `FIRST` e `SECOND` viram os turnos "1º turno" e "2º turno", com horários iniciais 06:00–14:00 e 14:00–22:00 *(decisão minha: são só valores de partida; a nota de Novidades pede ao ADMIN que confira)*.
  - `User.shift` vira referência ao Turno ("turno do cadastro"), com o valor atual preservado.
  - O mesmo vale para o turno gravado em envios e destinatários do histórico.
  - O enum `WorkShift` deixa de existir.
- Os rótulos "1º turno"/"2º turno" fixos no frontend (`frontend/src/lib/work-shift.ts`) dão lugar aos turnos vindos da API.

### 2. Escala por pessoa (ciclo que se repete)

- Cada pessoa tem **no máximo uma escala**, com:
  - data de início;
  - tamanho do ciclo, de 1 a 28 dias;
  - para cada dia do ciclo, um turno ou "folga".
- O dia D, a partir da data de início, cai no dia `(D − início) mod tamanho` do ciclo.
- **Modelos prontos** preenchem o ciclo, e depois tudo pode ser editado:
  - **Semanal**: ciclo de 7 dias; segunda a sexta num turno escolhido, sábado e domingo de folga. A data de início se alinha à segunda-feira da semana escolhida.
  - **Rodízio semanal**: ciclo de 14 dias; uma semana de segunda a sexta no turno A, a seguinte no turno B, fins de semana de folga.
  - **12x36**: ciclo de 2 dias, com trabalho num turno e depois folga.
  - **Personalizado**: o usuário escolhe o tamanho e marca cada dia.
- A escala vale para o **setor principal** da pessoa (`User.sectorId`). Trabalho em outro setor se marca como exceção.
- **Quem não tem escala** (ou antes da data de início dela) continua como hoje: escalado **todos os dias** no turno do cadastro. Sem turno no cadastro, aparece como "sem escala" e não entra em nenhum turno.

### 3. Exceções por data

- Uma exceção cobre um dia ou um período contínuo de uma pessoa e tem um destes tipos:
  - **Folga**: não trabalha;
  - **Férias**: não trabalha, com rótulo próprio;
  - **Troca de turno**: trabalha em outro turno;
  - **Outro setor**: trabalha em outro setor, num turno escolhido.
- A exceção vence o ciclo. *(Decisão minha: exceções não se sobrepõem para a mesma pessoa e o mesmo dia; criar uma que se sobrepõe recorta ou substitui a anterior nos dias em comum, com aviso na tela.)*
- Campo de observação opcional, como "atestado" ou "feriado".

### 4. Quadro da escala do setor

- Tela **Escala**, com seletor de setor e período (semana ou mês, com navegação). Um setor alcançado só por uma pessoa já vem escolhido.
- O quadro tem:
  - uma linha por pessoa ativa do setor principal, com nome e função;
  - abaixo, separadas e marcadas "de outro setor", as pessoas que vêm por exceção naquele período;
  - uma coluna por dia;
  - em cada célula, o nome curto do turno, "Folga", "Férias" ou vazio para "sem escala".
- Ações na tela:
  - Clicar numa célula permite marcar folga, férias, troca de turno ou outro setor naquele dia (ou período), e também remover a exceção.
  - "Editar escala" na linha da pessoa abre o modelo, a data de início e o ciclo.
- **Quem edita**: o ADMIN, em qualquer setor; o gestor, nas pessoas cujo setor principal ele gerencia. *(Decisão minha: o gestor do setor de destino não edita quem vem de fora, mas vê essas pessoas no quadro dele.)*
- *(Decisão minha)* Na exceção **"Outro setor"**, o gestor só escolhe como destino um setor que **também gerencia**; o ADMIN escolhe qualquer setor ativo. Assim, nenhum gestor põe gente na lista de envio de um setor que não alcança. O servidor aplica a regra, inclusive pela API.
- Ver a escala segue a mesma regra de quem pode enviar: ADMIN e gestor.

### 5. Envio por setor, data e turno

- A tela **WhatsApp da equipe** ganha o seletor **Data**, que começa em hoje no fuso de Manaus, além de Setor e Turno.
  - O Turno lista os turnos ativos mais "Todos os turnos".
  - A lista mostra quem está **escalado** naquele setor, data e turno, inclusive quem vem de outro setor por exceção.
- Abaixo da lista, dois grupos informativos, sem caixa de seleção:
  - **"De folga"**: folga ou férias naquela data, entre as pessoas do setor;
  - **"Sem telefone"**.
- **"Todos os turnos"**:
  - alcança todos os escalados do setor no dia, em qualquer turno;
  - quem tem turno no cadastro e não tem escala também conta.
  - A caixa **"incluir quem está de folga"** acrescenta à lista, para seleção, quem está de folga ou de férias. Ela só aparece em "Todos os turnos" (urgência).
- Seleção, "Enviar para todos (N)", "Enviar para selecionados (M)", diálogo com os nomes e "Ficam de fora (sem telefone)" funcionam como hoje.
- **O servidor refaz a escala** da data no momento do POST. Seleção com alguém fora da escala calculada (ou de folga, sem a opção de incluir folga) dá 422 `team_whatsapp.invalid_selection`, como hoje.
- Uma data passada pode ser consultada, mas o envio é para agora *(decisão minha: útil para conferir; o agendamento só aceita data e hora futuras)*.
- *(Decisão minha)* **Madrugada e turno que atravessa a meia-noite**:
  - A data padrão é sempre a data civil de Manaus, e "Todos os turnos" alcança os escalados **da data escolhida**.
  - Se, na hora em que a tela abre, um turno que começou na véspera ainda está em andamento, a tela mostra o aviso "A Noite de 21/10 ainda está em andamento" com o atalho "Ver esse turno". O atalho troca a data para a véspera e o turno para o que está em andamento.
  - Assim, a urgência das 02:00 chega a quem está trabalhando, com um clique e de forma explícita, sem regra escondida.

### 6. Agendamento no início do turno

- No diálogo de envio há duas opções: **"Enviar agora"** e **"No início do turno"**.
- **"No início do turno"**:
  - Só existe com um turno específico escolhido. "Todos os turnos" é sempre envio imediato.
  - A hora do disparo é a data escolhida + o horário de início do turno, no fuso de Manaus.
  - Se essa hora já passou, a opção fica desabilitada com o motivo. O servidor recusa com 422 `team_whatsapp.schedule_in_past`.
- **A lista conferida fica congelada** no momento do agendamento: só aquelas pessoas recebem, mesmo que a escala mude depois. Na hora do disparo, quem ficou inativo ou sem telefone é pulado com o motivo, como hoje.
- **Envios agendados**:
  - aparecem numa lista "Agendados" na mesma tela, com data/hora, rótulo, quantidade e o botão **"Cancelar"**, que funciona até o disparo;
  - podem ser cancelados por quem pode enviar para aquele setor;
  - cancelado não dispara.
- **Disparo**: um tick por minuto, no worker. Precisa ser idempotente, para que nem dois ticks nem um cancelamento concorrente façam o envio sair duas vezes ou depois de cancelado. *(Como conseguir isso fica com o builder.)*
- Atraso aceitável: até cerca de 1 minuto depois do início do turno. Se o worker estiver fora no horário, o envio sai quando ele voltar *(decisão minha)*, e o histórico mostra a hora real.
- *(Decisão minha)* O **canal** é escolhido no agendamento e fica gravado. Se, na hora do disparo, ele estiver inativo ou não existir mais:
  - cada destinatário falha com o motivo "Canal indisponível na hora do envio" (um código novo em `errorCode`, que já é texto livre);
  - nenhum outro canal é usado no lugar.
  Canal só desconectado segue o comportamento atual do envio imediato.

### 7. Histórico com a foto da escala

- Cada envio grava:
  - setor, data da escala e turno (nome e horário daquele momento);
  - se foi agendado e para quando;
  - quem mandou;
  - a **foto da escala** naquele momento: cada pessoa escalada no filtro (marcada ou não) e cada pessoa de folga, com nome, função e turno do dia.
- Os destinatários continuam com o resultado de sempre: na fila, enviado, falhou, pulado, mais **agendado** e **cancelado**.
- **"Ver destinatários"** mostra três grupos:
  - **Destinatários**, com o resultado;
  - **Escalados não marcados**;
  - **De folga**.
- Nenhum telefone aparece.
- O rótulo do envio inclui a data, por exemplo:
  - "Produção · Noite · 21/10 · seleção de 2";
  - "Produção · todos os turnos · 21/10".

### 8. Função

- Campo de texto livre opcional na pessoa, com até 80 caracteres (ex.: "Operador de empilhadeira").
- Fica nos diálogos "Cadastrar usuário" e "Editar usuário" e na coluna da tabela de Usuários.
- Aparece na linha do quadro da escala e na lista de seleção do envio.

### 9. Navegação e Novidades

- Itens novos no menu, no mesmo grupo de "WhatsApp da equipe" e "Setores": **Escala** e **Turnos**. Turnos aparece só para o ADMIN.
- Entrada nova no topo de `RELEASE_NOTES`, pedindo ao ADMIN que confira os horários de "1º turno" e "2º turno".

## O que fica com o builder

- Modelo de dados exato: tabelas, índices e forma de guardar o ciclo e a foto da escala.
- Contratos de API: nomes de rotas e campos, desde que back e front mudem juntos e sigam os padrões atuais (`backend/src/schemas/contracts/`).
- Como garantir a idempotência do disparo agendado.
- Layout do quadro, do editor de ciclo e da lista de agendados, seguindo os componentes existentes.
- Divisão em tasks e ordem de entrega.

## Riscos a cobrir com teste

1. Data civil em Manaus: às 21:00 de Manaus já é amanhã em UTC. "Hoje", o dia do ciclo e a hora do agendamento precisam sair em `America/Manaus`.
2. Turno que atravessa a meia-noite:
   - O agendamento da "Noite" de 21/10 dispara em 21/10 às 22:00.
   - Quem está escalado na "Noite" de 21/10 é quem a escala põe nesse turno em 21/10.
   - Às 02:00 de 22/10, a tela avisa que a Noite de 21/10 está em andamento, e o atalho leva a ela.
3. Ciclo: datas antes do início caem no turno do cadastro; o mod de ciclo de 2, 7 e 14 dias atravessa a virada de mês e de ano; exceção vence ciclo.
4. Migração: `FIRST`/`SECOND` preservados como referência aos turnos novos, inclusive nos envios do histórico; o CI `migration-drift` passa.
5. Agendado sem disparo duplo nem disparo depois de cancelado, inclusive com dois ticks ou cancelamento concorrentes.
6. Seleção pela API com alguém fora da escala da data, de folga sem a opção ou de outro setor: 422, e nada é criado. O gestor continua sem alcançar setor que não gerencia, inclusive editando escala pela API.

## Aceite

1. O ADMIN cadastra os turnos "Manhã 06:00–14:00" e "Noite 22:00–06:00". O "1º turno" e o "2º turno" migrados aparecem com as pessoas que já os tinham.
2. Com uma escala "Rodízio semanal" para João (1ª semana Manhã, 2ª semana Noite), o quadro mostra a alternância e os fins de semana como "Folga".
3. Marcar férias para Maria num período faz o quadro mostrar "Férias", e a tela de envio daqueles dias a lista em "De folga".
4. Na tela de envio, Produção + hoje + Noite lista só quem está escalado na Noite hoje. "Todos os turnos" com "incluir quem está de folga" acrescenta os de folga.
5. Agendar "No início do turno" para a Noite de hoje mostra o envio em "Agendados". Ele dispara às 22:00 de Manaus só para os nomes conferidos. Cancelar antes impede o disparo.
6. "Ver destinatários" mostra destinatários com o resultado, escalados não marcados e de folga.
7. A função aparece em Usuários, no quadro e no envio.
8. Os 6 riscos acima estão cobertos por teste.
9. `gate --changed --base origin/main` verde por task, no frontend e no backend. Gate completo por lado no fim, sem piora sobre a baseline. CI do PR verde (backend-tests, frontend-build, e2e, migration-drift). Revisão independente por task.
