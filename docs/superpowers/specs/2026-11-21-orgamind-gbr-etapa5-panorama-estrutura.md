# OrgaMind — Etapa 5 do plano GBR, parte A: panorama da fábrica e manutenção da estrutura

## Intenção

Quinta etapa do plano entregue à GBR (`reports/plano-gbr/`), na ordem pedida pelo usuário em 19/11/2026. A Etapa 5 (P1, "Governança e operação") tem cinco itens:

| Item | O que pede | Onde fica |
|---|---|---|
| **PAN-01** | Panorama da fábrica: todos os setores na data | Esta spec, Lote J |
| **CAD-06** | Manutenção de setores, turnos e responsáveis, com as dependências à mostra | Esta spec, Lote J |
| **MSG-01b** | Agendamento com opção de recalcular o público | Esta spec registra que **não** é construído agora |
| **INT-04** | Pendências para responsável humano | Parte B, com outro conselho |
| **MSG-03** | Caixa de respostas e passagem de turno | Parte B, com outro conselho |

**O que já existe:**

- **Escala e envio:**
  - `GET internal/team-whatsapp/roster?sectorIds&date` devolve vários setores de uma vez. Cada pessoa vem com a situação na data (em serviço num turno, folga, férias ou sem escala), telefone conforme `telefone.ver_completo` e autorização de contato. O alcance é o do envio: ADMIN vê todos; SUPERVISOR e OPERATOR, os setores ativos que gerem.
  - A "Visão geral" (`/dashboard`, a tela de entrada) mostra só os indicadores das comunicações internas.
  - `/escala` e `/whatsapp-equipe` não aceitam parâmetros na URL.
  - Mover pessoas em lote para um setor já existe (`POST …/people/move`, na tela de pessoas do setor de destino).
- **Estrutura:** setores, turnos e níveis têm cadastro com `estrutura.manter` (padrão: só o ADMIN) e nenhum é excluído; inativar é edição.
  - **Turno:** já bloqueia a desativação quando está em uso (409 `shifts.in_use`, com `detail` listando só os tipos de uso) e a tela mostra "Em uso" com quatro contagens.
  - **Setor:** a trilha grava antes e depois.
  - **Turno e nível:** a trilha grava só quem e quando.
- **Agendamento:** público congelado na criação e reconferido no disparo, que só retira (conselho T, Lote G). O histórico mostra a política, a foto, a hora da reconferência, quem foi pulado e quem entrou depois.

**O que falta**, e é o que esta spec decide:

- **Panorama:** os setores do dia numa tela só, com atalhos para a escala e para o envio.
- **Estrutura:**
  - setor e nível em uso são inativados sem conferir nada;
  - as dependências não aparecem antes da alteração;
  - turno e nível não gravam o antes e depois.

**De onde vêm as regras.** Caderno e Escopo da GBR de 28/10/2026. O que o caderno deixa pendente foi decidido pelo Conselho V em 20/11/2026 (`~/.claude/tribunais/2026-11-20/conselho-V/sentenca-V.md`) e está marcado **(conselho V)**, provisório até a GBR confirmar. O que é escolha minha está marcado *(decisão minha)*. Seguem valendo:

- Conselho R, R3: unidade e equipe/célula não são criadas até a GBR confirmar a estrutura real.
- Conselho T, T2: agendamento congelado com reconferência que só retira.

**Fontes:**

- `escopo.txt` e `caderno.txt` em `.superpowers/sdd/2026-11-19-orgamind-gbr-etapa1-lote-a-ficha-trilha/fontes/` (linhas citadas como C e E).
- Mapas do código em `.superpowers/sdd/2026-11-21-orgamind-gbr-etapa5-governanca/fontes/`: `mapa-caderno-escopo-e5.md`, `mapa-panorama.md`, `mapa-estrutura.md` e `mapa-agendamento-recalcular.md`.

**Vocabulário:**

- "Remetente" é quem pode enviar à equipe: ADMIN, ou SUPERVISOR/OPERATOR que gere ao menos um setor ativo (`isTeamSender`).
- "Alcance" são os setores que o remetente vê no envio: todos os ativos para o ADMIN, e os ativos que gere para os demais.
- "Situação na data" é a da escala resolvida para o dia, nesta ordem de prioridade: exceção, ciclo, cadastro. Ela é uma de quatro: em serviço num turno, folga, férias ou sem escala.
- "Em uso" é ter dependências que impedem inativar (E2 e E3).

## Objetivos

1. Quem envia à equipe abre a tela de entrada e vê, para o dia escolhido, quantas pessoas de cada setor do seu alcance estão em serviço em cada turno, de folga, de férias ou sem escala, e quantas das que estão em serviço não têm telefone ou autorização de contato (cenário 3, Tela 01).
2. A partir do cartão do setor, a pessoa abre a escala daquele setor e daquele dia ou começa uma mensagem para ele. Pelo botão "Mensagem para vários setores", começa uma mensagem para várias áreas, sempre passando pela prévia.
3. Setor e nível em uso não são inativados. As dependências aparecem antes da alteração, com o que fazer para liberar.
4. Toda alteração de setor, turno e nível fica na trilha com quem, quando, antes e depois (DAT-02).

## Não objetivos

- Recalcular o público do agendado (MSG-01b): ver "Agendamento" abaixo.
- Unidade e equipe/célula, responsável por turno ou por equipe (conselho R).
- Indicador por hora ("em serviço agora"): o panorama é por dia e turno.
- Ampliar o alcance de SUPERVISOR, OPERATOR ou VIEWER (pergunta à GBR).
- Pendências de respostas, responsável pela tratativa e caixa de respostas (parte B).
- Transferir em lote as exceções ou os envios agendados de um setor que vai ser inativado.

## Anti-objetivos (falha mesmo que funcione)

- A tela de entrada carregar nome ou telefone de pessoas sem um clique de "Ver pessoas", ou para quem não é remetente.
- Um SUPERVISOR ver contagens de setor fora do alcance dele.
- O panorama marcar setores no envio por conta própria: o botão "vários setores" não pré-marca nada, e o envio nunca pula a prévia.
- Um setor com pessoas ativas, exceções futuras de pessoas ativas ou envio agendado pendente ficar inativo, por qualquer caminho da API.
- Uma pessoa ser reativada num setor ou nível inativo (E10).
- Um nível com pessoas ativas ficar desativado.
- Nome, telefone ou e-mail de pessoas aparecerem no `detail` do 409.
- Telefone ou e-mail de pessoas aparecerem na trilha de estrutura. A trilha do setor continua guardando o gestor como id e nome, como já faz.

## Restrições

- Nenhuma migração: tudo usa as tabelas que já existem.
- Nenhuma chave de permissão nova: panorama com a regra de remetente; estrutura com `estrutura.manter`; gestor do setor só pelo ADMIN.
- O panorama não consulta bloqueio nem consentimento por pessoa, que é o caro do público do envio. Ele conta pela escala do dia, que é o mesmo caminho do roster: `loadDayPeopleMany` com a situação resolvida.
- Testes nunca mandam WhatsApp real.

## O que fica decidido

### Comum

- **C1. Base, branch e PR.** O branch `feat/panorama-estrutura` parte do Lote I (`122e821`, PR #21). Panorama e estrutura vão num lote só, o **Lote J**, com um PR empilhado sobre o #21 *(decisão minha: dois itens pequenos e independentes, com arquivos separados; um fechamento só)*.
- **C2. Novidades.** Uma entrada nova descreve o panorama, o bloqueio de setor e nível em uso, a confirmação ao inativar e a trilha de turno e nível.

### Panorama da fábrica (PAN-01) — conselho V

- **P1. Onde e quem.**
  - **Lugar:** um bloco no topo da "Visão geral" (`/dashboard`), acima dos indicadores de comunicações e independente deles. Aparece mesmo quando o resto da tela está no estado vazio, carrega depois dos indicadores e, se falhar, mostra "Não foi possível carregar o panorama" com "Tentar de novo", sem derrubar a tela.
  - **Quem vê:** só remetentes. VIEWER e quem não gere setor não veem o bloco.
  - **Consulta:** a tela do VIEWER não faz a consulta. Para ADMIN, SUPERVISOR e OPERATOR a tela consulta o panorama, porque a sessão não informa quem gere setor. O SUPERVISOR ou OPERATOR que não gere setor recebe o 403 de remetente (`team_whatsapp.forbidden`), e o bloco simplesmente não aparece, sem mensagem de erro. Qualquer outro erro mostra a falha de P1 *(decisão minha, ajuste ao texto da sentença V, que dizia que a tela deles não faz a consulta: a sessão não informa quem gere setor, e a resposta 403 não traz dado nenhum)*.
  - **Textos:** título "Operação da fábrica"; subtítulo "Panorama de todos os setores" para ADMIN e "Panorama dos seus setores" para os demais.
- **P2. Dados.**
  - **Rota:** rota nova de leitura `GET internal/team-whatsapp/panorama?date=AAAA-MM-DD`, sem lista de setores. O servidor aplica o alcance do ator, e quem não é remetente recebe o mesmo 403 do roster.
  - **Resposta:** só contagens por setor, sem nome nem telefone. Ela traz:
    - os turnos ativos (id, nome, início, fim), por `sortOrder` e depois nome;
    - o turno da noite em andamento (P7);
    - por setor do alcance (id, nome), em ordem de nome:
      - em serviço por turno ativo;
      - em serviço em turno inativo ("Outros turnos");
      - folga, férias e sem escala;
      - entre os em serviço, sem telefone (`hasPhone` falso) e sem autorização de contato (a mesma regra que faz a prévia agrupar alguém como não autorizado).
  - **Quem conta:** só pessoas ativas. A pessoa conta no setor em que atua na data, como no roster: quem trabalha emprestado conta no setor do empréstimo, e não também no de origem.
  - **Quem fica de fora:** pessoa ativa sem setor no cadastro e sem escala em nenhum setor não aparece em nenhum cartão.
  - **Data:** data civil válida. Data ausente ou inválida dá 400, com o mesmo erro de data do roster.
  - **Trilha:** a leitura não grava trilha, como o roster.
  - **Muitas pessoas:** o panorama funciona com mais de 2000 pessoas no alcance, porque a contagem é feita por setor ou em grupos de setores. O teto de 2000 do roster não vale para o alcance inteiro. Um setor que sozinho passe de 2000 pessoas mostra, no lugar das contagens, "Setor com mais de 2000 pessoas: veja na Escala", sem "Ver pessoas" *(decisão minha)*.
- **P3. Cartão do setor.**
  - "Em serviço em {data}", com uma linha por turno ativo: "{turno} ({início}–{fim}): N".
  - Se houver alguém em serviço em turno inativo, aparece "Outros turnos: N" logo depois das linhas de turno *(decisão minha)*.
  - Abaixo: "Folga: N", "Férias: N", "Sem escala: N".
  - Entre os em serviço, só quando N > 0: "Sem telefone: N" e "Sem autorização de contato: N".
  - Setor sem ninguém em nenhuma situação mostra "Ninguém na escala deste dia".
  - A data aparece no formato dd/MM.
- **P4. Ver pessoas.**
  - "Ver pessoas" expande o cartão e só então busca o roster daquele setor e daquela data (rota existente).
  - Mostra os nomes por turno e situação, com o telefone como a tela de envio já mostra: completo com `telefone.ver_completo`, mascarado sem ela.
  - Fechar o cartão não refaz a busca.
- **P5. Ações.**
  - "Ver escala" abre `/escala?sectorId=…&date=…`.
  - "Enviar mensagem" abre `/whatsapp-equipe?sectorIds=…&date=…` com aquele setor marcado.
  - O botão "Mensagem para vários setores" aparece só quando o alcance tem dois ou mais setores. Ele abre `/whatsapp-equipe?date=…` com a lista de setores visível e nenhum pré-marcado. Prévia, disparo amplo e confirmação não mudam.
  - Os botões de envio só aparecem para quem tem `equipe.enviar`.
- **P6. Parâmetros nas telas.**
  - `/escala` passa a aceitar `sectorId` e `date`. A data vira a âncora do período no modo atual da tela.
  - `/whatsapp-equipe` passa a aceitar `sectorIds` (lista) e `date`. A data da URL vira a data da tela, aceita nas mesmas condições do seletor de data da própria tela. Nas finalidades em que a data de referência é a da atividade (Reunião, Palestra, Hora extra e o Alinhamento com data), ela continua sendo a da atividade, como hoje.
  - Parâmetro inválido, de setor inativo ou fora do alcance é ignorado, sem erro: a tela abre como abriria sem ele.
  - Os parâmetros só preenchem o estado inicial; depois disso a tela funciona como hoje *(decisão minha)*.
- **P7. Turno da noite.** Quando um turno que atravessa a meia-noite, iniciado ontem, ainda está em andamento, o bloco mostra o atalho "O turno {nome} de ontem ainda está em andamento. Ver {dd/MM}", que troca a data para ontem.
  - A regra é a mesma que a tela de envio já usa, e o servidor a devolve na resposta do panorama.
  - O atalho só aparece quando a data escolhida é hoje.
- **P8. Data e atualização.**
  - A data padrão é hoje (Manaus), com seletor.
  - O aviso fixo no bloco diz: "As contagens vêm da escala do dia, não da hora. Quem recebe uma mensagem só é definido na prévia do envio, que também confere bloqueios."
  - O bloco não atualiza sozinho: recarrega ao trocar a data ou ao voltar à tela.

### Estrutura: setor, turno e nível (CAD-06) — conselho V

- **E1. Sem exclusão.** Inativar continua sendo edição, com `estrutura.manter`; o gestor do setor continua definido só pelo ADMIN. Unidade e equipe/célula seguem fora (conselho R).
- **E2. Setor em uso não é inativado.** Está em uso quando tem:
  1. pessoas ativas com ele como setor principal;
  2. exceções de escala de hoje em diante (Manaus) que apontam para ele, de pessoas ativas *(decisão minha: a exceção de pessoa inativa não aparece no quadro da Escala nem afeta o público, e bloquearia sem saída pela tela)*;
  3. envios da equipe agendados e ainda pendentes que o incluem: envio em estado agendado com o setor entre os setores do envio. Envio agendado a uma pessoa não conta.
  - **Recusa:** a API devolve 409 `sector.in_use`. O `detail` traz só tipo e contagem dos tipos com contagem maior que zero, no formato `people=3, exceptions=1, scheduled=2`, sem dado pessoal.
  - **Concorrência:** a conferência e a gravação ocorrem na mesma transação, com a linha do setor travada.
  - **Limite conhecido:**
    - criar agendado, exceção ou vínculo não trava o setor; o que for criado no mesmo instante da inativação segue a regra atual, e o agendado dispara, inclusive pelo número da área (E6);
    - no nível vale o mesmo: a edição da pessoa não trava o nível;
    - a reativação de uma pessoa (E10) e a inativação do setor ou do nível ao mesmo tempo seguem o mesmo limite.
- **E3. Nível com pessoas ativas não é desativado:** 409 `levels.in_use`, com `detail` no mesmo formato (`people=N`), conferido na mesma transação da gravação. O turno segue como está (409 `shifts.in_use`).
- **E4. Dependências antes da alteração.**
  - **Onde aparecem:** a tela do setor e a lista de níveis mostram "Em uso", no molde do turno. Os dados vêm junto com o setor e com a lista de níveis, que a API passa a devolver, sem tela nova *(decisão minha: como o turno faz)*.
  - **Textos do setor:** "N pessoa(s) ativa(s) neste setor", "N exceção(ões) de escala de hoje em diante", "N envio(s) agendado(s)".
  - **Texto do nível:** "N pessoa(s) ativa(s) com este nível".
  - **Com qualquer dependência:**
    - a opção "Inativo" do setor e o botão "Desativar" do nível ficam desligados, com "Em uso: não pode ser inativado";
    - o que fazer no setor: trazer as pessoas para outro setor pela tela de pessoas do setor de destino, remover as exceções na Escala, cancelar ou aguardar os envios agendados;
    - o que fazer no nível: trocar o nível no cadastro das pessoas.
  - **Informação que não bloqueia:** "N pessoa(s) inativa(s) mantêm o vínculo".
- **E5. Uso que surgiu depois.** Se a API devolver o 409 porque o uso surgiu depois de abrir a tela, aparece "Este setor está em uso e não pode ser inativado." ou "Este nível está em uso e não pode ser desativado.", e as dependências são recarregadas.
- **E6. Confirmação.**
  - **Setor sem uso:** inativar pede confirmação: "Inativar {setor}? Ele sai das listas de envio, escala e cadastro. O histórico é mantido.", com "Cancelar" e "Inativar setor".
  - **Nível sem uso:** "Desativar o nível {nome}? Ele sai do cadastro novo e do filtro de envio.", com "Cancelar" e "Desativar".
  - **Número da área:** não bloqueia. Se o setor tem número próprio da área, a confirmação acrescenta: "O número da área continua ligado a este setor e nenhum envio sai por ele enquanto o setor estiver inativo. Para usar o número em outra área, desvincule-o antes."
- **E7. Edições que continuam livres:** renomear, trocar o gestor e reativar, sempre com trilha.
- **E8. Trilha (DAT-02).**
  - **Setor:** já grava antes e depois, na criação e na alteração, com o gestor como id e nome.
  - **Turno e nível:** passam a gravar, na mesma transação e na categoria Estrutura, quem, quando e os valores de nome, horário (turno) e ativo. Na criação grava os valores iniciais, como o setor faz; na alteração, o antes e o depois.
  - **Reordenar:** grava a ordem antes e depois.
  - **Sem mudança:** alteração que não muda nada não grava evento.
  - **Dado pessoal:** a trilha de estrutura não leva telefone nem e-mail.
- **E9. Fora desta etapa:** comunicações internas abertas do setor não entram na conta de "em uso".
- **E10. Reativar pessoa em setor ou nível inativo.**
  - **Recusa:** reativar uma pessoa cujo setor principal está inativo devolve 409 `user.sector_inactive`, com a mensagem "O setor desta pessoa está inativo. Reative o setor ou troque o setor antes de reativar a pessoa." Com o nível inativo, 409 `user.level_inactive`, com a mensagem "O nível desta pessoa está desativado. Reative o nível ou troque o nível antes de reativar a pessoa." *(decisão minha: sem isso, a reativação contorna E2 e E3)*.
  - **Quando vale:** só quando a pessoa passa de inativa para ativa. Editar uma pessoa que já está ativa não muda: o nível desativado que já é dela continua aceito, como hoje.
  - **Onde vale:** na ficha da pessoa e na tela de pessoas do setor. A importação não reativa ninguém: ela já recusa pessoa inativa.
  - **Trocar e reativar juntos:** é aceito quando o setor ou o nível novo está ativo.

### Agendamento: recalcular o público (MSG-01b) — conselho V

- **A1. Não construído nesta etapa.** A opção de recalcular o público na hora do envio depende da decisão "Agendamento" da GBR (C740). Continua valendo, sem mudança, a regra do conselho T: público congelado na criação, com reconferência no disparo que só retira.
  - Não há opção nova na tela, valor novo de política, campo novo, permissão nova nem código de erro novo.
  - A "regra usada" que o caderno pede já fica registrada em cada envio agendado: política "congelado com reconferência", foto da criação, hora da reconferência, quem foi pulado e por quê e, nos envios para "todos os aptos", quem entrou depois e não recebeu.
- **A2. Plano.** O item MSG-01b em `reports/plano-gbr/dados.py` passa a "aguarda a GBR (C740)", com o texto "Recalcular o público na hora do envio: só se a GBR escolher; até lá vale o congelado com reconferência". O texto anterior ("nova foto e registro das diferenças") fica superado.
- **A3. Se a GBR escolher recalcular**, o tema volta ao conselho com este ponto de partida:
  - só envios para "todos os aptos", nunca seleção nominal;
  - política gravada própria;
  - quem entra passa pelas conferências de telefone, bloqueio e autorização;
  - o histórico lista quem entrou e quem saiu.

## Para a GBR confirmar

1. **Agendamento (C740):** congelar ou recalcular? Se recalcular, por finalidade ou por envio, e quem entra depois recebe sem prévia?
2. **Panorama:** supervisor e operador veem todos os setores (C131) ou só os que gerem? VIEWER vê algo?
3. **Panorama:** o indicador é por dia e turno ou por hora ("agora")? Qual a data padrão na madrugada do turno da noite?
4. **Panorama:** nomes e telefones podem aparecer na tela inicial, ou só contagens?
5. **Estrutura:** setor e nível em uso bloqueiam a inativação ou só avisam? Exceção futura conta como uso?
6. **Estrutura:** quem pode inativar setor, turno e nível além do ADMIN?
7. **Número da área de um setor inativo:** fica preso ao setor, é desvinculado ou passa para outra área?

## Aceite

**Panorama**

1. ADMIN na "Visão geral" vê "Operação da fábrica" e "Panorama de todos os setores", com um cartão por setor ativo em ordem de nome e as contagens de hoje por turno ativo, folga, férias e sem escala. O bloco aparece também quando o resto da tela está no estado vazio. O aviso fixo de P8 está no bloco.
2. SUPERVISOR que gere dois setores vê só esses dois, com "Panorama dos seus setores". VIEWER não vê o bloco, e nenhuma chamada ao panorama sai da tela dele. OPERATOR ou SUPERVISOR sem setor gerido não vê o bloco nem mensagem de erro.
3. A rota devolve só contagens, sem nome nem telefone. Quem não é remetente recebe 403, e data inválida recebe 400. A trilha não ganha evento de leitura. Com mais de 2000 pessoas no alcance o panorama responde normalmente, e um setor que sozinho passa de 2000 mostra "Setor com mais de 2000 pessoas: veja na Escala", sem "Ver pessoas". Os dois casos têm teste.
4. Contagem:
   - quem trabalha emprestado em outro setor na data conta lá, e não no de origem;
   - férias contam em "Férias", folga em "Folga", e quem não tem escala em "Sem escala";
   - pessoa inativa não conta;
   - entre os em serviço, quem não tem telefone conta em "Sem telefone", e quem não tem autorização em "Sem autorização de contato";
   - quem está em serviço em turno inativo aparece em "Outros turnos";
   - setor sem ninguém mostra "Ninguém na escala deste dia".
   Na mesma data, os números batem com o roster.
5. "Ver pessoas" só busca o roster no clique, e fechar e abrir de novo não refaz a busca. Mostra os nomes por turno, com o telefone mascarado para quem não tem `telefone.ver_completo`. Trocar a data recarrega o bloco, que não atualiza sozinho.
6. "Ver escala" abre a escala do setor na data. "Enviar mensagem" abre o envio com o setor marcado e a data. Parâmetro inválido ou fora do alcance é ignorado, sem erro.
7. "Mensagem para vários setores" só aparece com dois ou mais setores no alcance e `equipe.enviar`, e abre o envio sem setor marcado. Sem `equipe.enviar`, nenhum botão de envio aparece.
8. Com um turno da noite de ontem em andamento e a data de hoje escolhida, aparece o atalho que troca a data para ontem.
9. Falha do panorama mostra o erro com "Tentar de novo", e os indicadores de comunicações continuam.
10. As Novidades têm a entrada do lote (C2).

**Estrutura**

11. Setor com pessoa ativa, com exceção de hoje em diante de pessoa ativa ou com envio agendado pendente que o inclui não é inativado. A API responde 409 `sector.in_use` com as contagens e nenhum dado pessoal. A tela desliga "Inativo" e mostra as dependências e o que fazer. Exceção de pessoa inativa e envio agendado a uma pessoa não bloqueiam.
12. A conferência de uso roda dentro da transação que grava a inativação, com a linha do setor travada. O teste de integração com banco real prova que uma dependência que já existe quando a transação começa sempre bloqueia.
13. Setor sem uso é inativado depois da confirmação. Com número próprio da área, a confirmação traz o aviso do número. Pessoas inativas continuam com o vínculo, e o histórico não muda.
14. Nível com pessoa ativa não é desativado (409 `levels.in_use`), e a tela desliga "Desativar". Nível sem uso é desativado depois da confirmação.
15. Um 409 que chega depois de a tela abrir mostra a mensagem e recarrega as dependências.
16. A trilha registra a criação e a alteração de turno e de nível com quem, quando e os valores. Reordenar grava a ordem antes e depois. Alteração sem mudança não grava nada. Os eventos aparecem na consulta da trilha, na categoria Estrutura.
17. Renomear, trocar o gestor e reativar seguem livres, com trilha.
18. Reativar uma pessoa cujo setor está inativo dá 409 `user.sector_inactive`. Com o nível desativado, 409 `user.level_inactive`. Isso vale na ficha e na tela de pessoas do setor, e a tela mostra a mensagem. Trocar para um setor ou nível ativo e reativar na mesma gravação funciona. Editar uma pessoa já ativa com nível desativado continua aceito.

**Agendamento**

19. Nada muda no agendamento. O plano (`dados.py`) mostra o MSG-01b como "aguarda a GBR (C740)".

## Fica com o construtor

- Formato exato da resposta do panorama e de como as dependências vêm junto com o setor e os níveis, desde que sigam P2 e E4.
- Componentes, chaves de query e o formato visual dos cartões, seguindo o padrão das telas da escala e da Visão geral.
- Onde extrair a contagem de uso do setor e do nível: no molde de `usage()` dos turnos.
- A ordem e o texto dos testes, desde que cada aceite tenha teste.
