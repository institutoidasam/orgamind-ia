# OrgaMind — Etapa 1 do plano GBR: cadastro confiável, trilha, permissões e vínculo com vigência

## Intenção

O plano entregue à GBR em 03/11/2026 (`reports/plano-gbr/`) tem 24 itens. O lote sem decisão da GBR foi feito em 10/11 (PR 11). Em 19/11/2026 o usuário pediu para **seguir a ordem do plano**, de forma autônoma, usando os padrões do caderno da GBR e, na dúvida, o conselho. Esta spec cobre a **Etapa 1 — Cadastro confiável e permissões**:

- **CAD-01**: editar pessoa e contato; inativar e reativar sem apagar;
- **DAT-02**: trilha de alterações com antes e depois;
- **CAD-05**: permissões por ação, separadas do acesso ao sistema;
- **CAD-02**: vínculo habitual com vigência, separado da escala do dia (**parcial**, ver Lote C).

**Por que agora:** a GBR quer manter a base de pessoas sem depender do programador, saber quem mudou o quê e controlar quem pode fazer cada ação. As etapas seguintes (planilhas, público por finalidade, alerta urgente) dependem destas quatro peças.

**Regras provisórias.** A oficina de decisões com a GBR aconteceu só em parte. As regras sem decisão foram fechadas pelo Conselho R em 19/11/2026 (`~/.claude/tribunais/2026-11-19/conselho-R/sentenca-R.md`) e estão marcadas **(conselho R1–R4)**. Os pontos marcados *(decisão minha)* foram completados por mim. Todos ficam listados em "Para a GBR confirmar".

**Fontes:** Escopo e Caderno da GBR de 28/10/2026 (texto em `.superpowers/sdd/2026-11-19-gbr-etapa1/escopo.txt` e `caderno.txt`); mapas do código na mesma pasta (`mapa-pessoas.md`, `mapa-permissoes.md`, `mapa-auditoria.md`, `mapa-vinculo.md`).

**Vocabulário:** "pessoa" é o `User`, com ou sem login. "Setor" é o `Sector` (a "área" da GBR). "Trilha" é o registro de alterações (`AuditEvent`). "Vínculo" é o setor, turno e nível habituais da pessoa.

## Objetivos

1. **Ficha completa da pessoa:** matrícula, autorização de contato com origem e data, situação (ativa ou inativa) e motivo de cada alteração.
2. **Inativar em vez de apagar:** pessoa com histórico nunca é excluída; reativar pela tela.
3. **Trilha consultável:** quem alterou, quando, o antes e o depois, e o motivo, com tela de consulta por pessoa, período e tipo.
4. **Permissões por ação**, definidas por papel numa tela do administrador, sem tirar de ninguém função que já existe.
5. **Vínculo com histórico:** trocar setor, turno ou nível não reescreve o passado.

## Não objetivos

- Importar e exportar planilhas (CAD-03 e CAD-04, Etapa 2). As chaves `pessoas.importar` e `pessoas.exportar` só entram com a função.
- Alerta urgente (MSG-02) e a chave `alerta.criar` (Etapa 4).
- Unidade e equipe/célula na estrutura **(conselho R3)**.
- Troca de vínculo com data futura ou correção retroativa **(conselho R4)**.
- Exceção de permissão por pessoa **(conselho R2)**.
- Mudar regras dos módulos legados (chat, segments, imports, metrics, contacts, campaigns, templates): continuam em `@Roles`.
- Manutenção da estrutura com dependências (CAD-06, Etapa 5), além de auditar criação e edição de setor.
- Merge, deploy e qualquer ação em produção.

## Anti-objetivos (falha mesmo que funcione)

- No dia da implantação, o envio da equipe parar ou alguém perder uma função que tinha, sem ninguém ter mexido na configuração.
- Pessoa marcada "sem autorização" receber mensagem da equipe.
- Uma alteração de pessoa, vínculo ou permissão ficar gravada sem o registro correspondente na trilha.
- Telefone completo, e-mail ou senha gravados na trilha.
- Apagar ou reescrever o histórico de envios, a escala passada ou eventos já gravados na trilha.
- O administrador conseguir se trancar para fora (ficar sem a tela de permissões).

## Restrições

- **Stack e padrões atuais:** NestJS, Prisma, Zod (`createZodDto`), BullMQ; React, TanStack Query/Router, Radix; Vitest e testcontainers. Erros de API com `code` estável e texto pt-BR.
- **Migrações sem perda de dados**, com backfill em SQL na própria migração (padrão de `20261021100000_shift_entity`). Nada de serviço novo no compose.
- **Escopo por setor não muda:** ADMIN alcança tudo; os demais só os setores que gerenciam (`Sector.managerId`). Permissão e escopo se somam.
- **Base do trabalho:** branch `feat/cadastro-permissoes`, criada sobre `feat/somente-evolution` (PR 12, empilhado no PR 11).
- **Fuso:** datas civis no fuso do app (`todayIn`, padrão America/Manaus).
- **Textos em pt-BR**, no tom das telas atuais, sem jargão técnico.
- **Entrega em três lotes, nesta ordem:** A (ficha e trilha), B (permissões), C (vínculo). Cada lote fecha com gate e commit próprios. Até o Lote B existir, o Lote A protege as funções novas por papel, com os mesmos papéis da matriz inicial.

## O que fica decidido

### Lote A — Ficha da pessoa e trilha (CAD-01 + DAT-02)

#### A1. Matrícula

- Campo opcional `matrícula` na pessoa: texto de até 30 caracteres, sem espaços nas pontas, único entre pessoas que têm matrícula, comparado sem diferenciar maiúsculas *(decisão minha)*.
- Matrícula repetida é recusada com `422 user.registration_taken` e texto "Já existe uma pessoa com esta matrícula".
- Aparece na lista de usuários, na lista de pessoas do setor e nos dois diálogos de edição.
- **Busca:** a lista de usuários (`GET /users`) ganha busca por nome ou matrícula. A busca de pessoas e candidatos do setor passa a achar também pela matrícula.

#### A2. Autorização de contato **(conselho R1)**

- **Campos na pessoa:** situação (`AUTORIZADO` | `NAO_AUTORIZADO`); origem (`TERMO_ASSINADO`, `FICHA_ADMISSAO`, `ACEITE_WHATSAPP`, `OUTRO` com texto obrigatório de até 120 caracteres, `CADASTRO_ANTERIOR`); data da autorização (data civil, pode ser nula); registrado por (nulo = migração); registrado em.
- **Migração:** toda pessoa existente fica `AUTORIZADO`, origem `CADASTRO_ANTERIOR`, data nula, registrado por nulo, registrado em = momento da migração. `CADASTRO_ANTERIOR` só existe pela migração: a API recusa esse valor em cadastro e em edição.
- **Como aparece:** "Cadastro anterior — origem não verificada"; "Termo assinado em dd/mm/aaaa"; "Sem autorização registrada".
- **Pessoa nova, igual nas três portas** (`POST /users` com ou sem login; pessoa nova no setor; "a partir de contatos"):
  - campo obrigatório "Autorização de contato", sem valor pré-marcado, com as opções Termo assinado, Ficha de admissão, Aceite pelo WhatsApp, Outro (texto) e "Sem autorização registrada";
  - uma origem escolhida grava `AUTORIZADO` com a data informada (padrão hoje; não aceita futura), autor e momento;
  - "Sem autorização registrada" grava `NAO_AUTORIZADO` e mostra "Esta pessoa não receberá mensagens até a autorização ser registrada";
  - em "a partir de contatos" a escolha é uma só para o lote, e nada é derivado de `Contact.sourceOrigin`;
  - chamada de API sem o campo grava `NAO_AUTORIZADO`.
- **Bloqueio no envio da equipe:** `NAO_AUTORIZADO` fica fora de todo envio, com motivo novo `NOT_AUTHORIZED` ("Contato não autorizado"). É conferido na montagem dos destinatários e de novo no worker, depois de sem telefone e de supressão. A supressão (pedido de sair) continua valendo por cima. `CADASTRO_ANTERIOR` não bloqueia.
- **Prévia do envio:** quem está `NAO_AUTORIZADO` aparece pelo nome nas exclusões, no grupo "Contato não autorizado", sem caixa de seleção. Havendo destinatários com `CADASTRO_ANTERIOR`, a prévia mostra uma linha informativa, sem bloqueio: "N destinatários com origem de autorização não verificada (cadastro anterior)".
- **Regularização:** selo na linha, filtro ("Origem não verificada", "Sem autorização") e contador na lista de usuários e na de pessoas do setor. Altera a autorização quem pode editar a pessoa; pessoa com login, só o ADMIN.

#### A3. Inativar e reativar; exclusão só sem histórico

- A lista de usuários e a de pessoas do setor trocam "Remover/Excluir" por **Inativar** e **Reativar**, com motivo obrigatório.
- Inativa: não recebe envio (motivo `INACTIVE`, já existente), não entra em público novo, não faz login. Continua no histórico e na trilha. As listas escondem inativos por padrão e têm o filtro "Mostrar inativos".
- **Quem inativa e reativa (conselho R2):** ADMIN, qualquer pessoa. SUPERVISOR, só pessoa **sem login** dos setores que alcança. Pessoa com login, só o ADMIN. Ninguém inativa a si mesmo, e o último ADMIN ativo não pode ser inativado (guarda que já existe).
- **Exclusão física** *(decisão minha)*: `DELETE /users/:id` continua existindo só para o ADMIN e só para pessoa **sem histórico**. Tem histórico quem aparece em envio da equipe (como destinatário ou autor), escreveu comunicado interno ou comentário, é responsável por uma demanda de comunicado, tem conversa atribuída, ou tem escala ou exceção de escala registrada (excluir a pessoa apagaria a escala passada dela). Com histórico, a API responde `409 user.has_history` com o texto "Esta pessoa tem histórico e não pode ser excluída. Inative o cadastro." A tela só oferece "Excluir cadastro" como ação secundária, e mostra essa mensagem quando recusado.
- "Tirar do setor" (pessoa sem login) continua existindo como hoje; não apaga a pessoa.

#### A4. Motivo da alteração

- Toda edição de pessoa já existente pelos dois diálogos (lista de usuários e pessoa do setor) pede **Motivo da alteração**, obrigatório, de 3 a 200 caracteres *(decisão minha, a partir do caderno: "alterações cadastrais têm autor, data e motivo")*. Vale também para inativar, reativar e alterar a autorização.
- Sem motivo, a API responde `422 user.reason_required`.
- Mover e tirar pessoas do setor em lote aceitam motivo opcional *(decisão minha)*.
- Cadastro de pessoa nova não pede motivo.

#### A5. Trilha de alterações (DAT-02)

- **O que cada registro guarda:** autor, data e hora, tipo da alteração, a pessoa afetada (quando houver), o motivo e, por campo alterado, o **antes** e o **depois**. Campos que não mudaram não entram.
- **Dados pessoais na trilha** *(decisão minha)*: telefone entra mascarado, só os 4 últimos dígitos (`•••• 1234`). E-mail entra mascarado (`a•••@dominio`). Senha nunca entra. Nome, função, matrícula, setor, turno, nível, situação e autorização entram por extenso (setor, turno e nível pelo nome, com o id junto).
- **Gravação junto com a mudança:** alterações de pessoa, autorização, situação, vínculo, setor e permissões gravam a trilha **na mesma transação** da mudança. Se a trilha falhar, a mudança não é gravada. Os demais registros de auditoria continuam como hoje.
- **O que passa a ser registrado com antes e depois:**
  - pessoa: criação, edição de qualquer campo da ficha, autorização, inativar, reativar, exclusão, concessão de acesso e troca de papel;
  - pessoas do setor: edição, mover, tirar, adicionar;
  - setor: criação e edição (nome, gestor, ativo), que hoje não são registradas;
  - escala: os quatro registros que já existem passam a apontar a pessoa afetada, para aparecerem na ficha dela.
- **Registros antigos** continuam visíveis na consulta, sem antes e depois.
- **Consulta:**
  - tela **Trilha de alterações** no menu, com filtro por pessoa (nome ou matrícula), período e tipo (Pessoa, Vínculo e setor, Escala, Estrutura, Permissões), paginada, mais recentes primeiro;
  - seção **Histórico** na ficha da pessoa, com as alterações daquela pessoa;
  - **quem consulta (conselho R2):** ADMIN vê tudo. SUPERVISOR consulta pela ficha das pessoas que alcança (pessoa, vínculo e escala). A consulta geral e as mudanças de estrutura e de permissões ficam só para o ADMIN.
- A trilha é só de leitura: não há edição nem exclusão de registro.

#### A6. Novidades

- Uma nota de versão em **Novidades** explicando matrícula, autorização de contato, inativar no lugar de excluir, motivo da alteração e a tela da trilha.

### Lote B — Permissões por ação (CAD-05) **(conselho R2)**

#### B1. Mecanismo

- Permissões nomeadas por papel, guardadas no banco. **ADMIN tem todas, fixo. VIEWER não tem nenhuma, fixo.** A tela edita apenas SUPERVISOR e OPERATOR. Sem exceção por pessoa.
- Nas rotas cobertas, a checagem de papel (`@Roles`, `WRITE_ROLES`, `SENDER_ROLES`) é trocada pela permissão. O escopo por setor continua igual e se soma à permissão.
- Leituras, `/users`, números e canais e os módulos legados seguem em `@Roles`.
- "Definir permissões" não é chave gravada: é regra fixa do ADMIN.
- A migração semeia a matriz inicial. Um teste prova que, para cada papel e cada função que já existia, o resultado é o mesmo de antes.
- Toda alteração da matriz grava na trilha (antes e depois por chave e papel).
- As permissões efetivas vão na resposta do login e em `GET /auth/me` (novo). Menu e botões das telas cobertas leem delas. Sem cache nesta etapa: a permissão é lida do banco a cada requisição.
- Uma chave só entra na tabela e na tela na etapa em que a função que ela controla é entregue.
- Recusa por falta de permissão: `403 auth.permission_denied`, com texto pt-BR dizendo qual ação não é permitida.

#### B2. Chaves desta etapa e matriz inicial

| Chave | O que controla | ADMIN | SUPERVISOR | OPERATOR | VIEWER |
|---|---|---|---|---|---|
| `pessoas.editar` | Cadastrar e editar pessoas nos setores que alcança | sim | sim | sim | não |
| `pessoas.inativar` | Inativar e reativar pessoa sem login dos setores que alcança | sim | sim | não | não |
| `escala.alterar` | Alterar escala nos setores que alcança | sim | sim | sim | não |
| `estrutura.manter` | Criar e editar setores, turnos e níveis | sim | não | não | não |
| `telefone.ver_completo` | Ver o telefone completo | sim | sim | sim | não |
| `equipe.enviar` | Enviar WhatsApp à equipe nos setores que alcança | sim | sim | sim | não |
| `equipe.disparo_amplo` | Enviar a todos os setores de uma vez | sim | sim | sim | não |
| `trilha.consultar` | Consultar a trilha pela ficha das pessoas que alcança | sim | sim | não | não |

- A matriz inicial não é mais restritiva que o comportamento atual para função que já existe; para função nova o padrão é restritivo.
- `pessoas.inativar`: vale só para pessoa sem login dos setores que o ator alcança; pessoa com login, só o ADMIN. Motivo obrigatório.
- `estrutura.manter`: hoje é só ADMIN; a chave permite ao ADMIN liberar para outro papel.
- Escolher ou trocar o gestor de um setor continua exclusivo do ADMIN, mesmo para quem recebe `estrutura.manter` *(decisão minha)*: sem isso, quem tem a chave poderia se pôr como gestor de qualquer setor e alcançar pessoas, telefones e envios de lá. Recusa: `403 sector.manager_admin_only`, "Só o administrador escolhe o gestor do setor."

#### B3. Telefone completo

- Com a matriz inicial nada muda em relação a hoje.
- Quem tem a chave vê o telefone como hoje. A regra atual da tela do setor continua e independe da chave: telefone de pessoa com login, só o ADMIN vê.
- Quem **não** tem a chave recebe da API só os 4 últimos dígitos (`•••• 1234`) e a indicação de que há telefone, na lista do setor, nos candidatos (pessoas e contatos) e na lista de destinatários do envio. O grupo "Sem telefone" continua correto. Não edita telefone já gravado, mas pode digitar o de pessoa nova. A busca passa a ser só por nome e matrícula.
- A lista de destinatários do envio continua mostrando o telefone de quem tem login para quem tem a chave (como hoje); fica anotado para a GBR.

#### B4. Disparo amplo **(conselho R2.3)**

- Disparo amplo é o envio da equipe por setor cujo alvo inclui **todos os setores ativos** da organização, quando há mais de um setor ativo. Envio a um ou a vários setores sem cobrir todos não é amplo. Envio a uma pessoa nunca é amplo.
- A regra é conferida na criação do envio, imediato ou agendado, e fica em uma única função.
- O alcance continua limitado aos setores que o ator gerencia.
- Sem a chave, o envio é recusado com `403 team_whatsapp.broad_send_denied` e o texto "Você não tem permissão para enviar a todos os setores de uma vez. Desmarque um setor ou peça ao administrador."

#### B5. Tela Permissões

- Em Configurações, só para o ADMIN: tabela com uma linha por permissão (nome e explicação curta em pt-BR) e uma coluna por papel. ADMIN aparece marcado e travado; VIEWER, desmarcado e travado. SUPERVISOR e OPERATOR têm caixas de marcar.
- Salvar pede confirmação mostrando o que muda. Há o botão "Restaurar padrão".
- A mudança vale na requisição seguinte de cada usuário, sem novo login.

#### B6. Novidades

- Nota de versão explicando a tela de permissões e que nada mudou para quem já usava.

### Lote C — Vínculo com vigência (CAD-02, parcial) **(conselho R3 e R4)**

- **Parcial:** o histórico guarda setor, turno e nível. Unidade e equipe/célula aguardam a GBR ("Pontos a confirmar — Estrutura"). Não criar colunas, tabelas nem telas para elas.
- **Histórico de vínculo:** cada pessoa tem uma linha aberta com setor, turno e nível atuais, e linhas fechadas para os vínculos anteriores, com início e fim (datas civis).
- **Migração:** uma linha aberta por pessoa com os valores atuais, início em branco (significa "anterior ao histórico") e sem fim. Consultas tratam início em branco como "desde sempre". A migração confere as contagens: uma linha por pessoa, valores iguais aos da ficha.
- **Troca:** a troca de setor, turno ou nível vale a partir de **hoje**. Não se aceita data futura nem passada. A linha anterior fecha na véspera e a nova abre hoje. Duas trocas no mesmo dia atualizam a linha aberta do dia, sem vínculo de duração zero; a trilha registra cada uma.
- **Um caminho só de escrita:** toda gravação de setor, turno ou nível da pessoa (criação, edição, mover, tirar do setor, a partir de contatos) passa por uma única função que, na mesma transação, atualiza o histórico, o espelho em `User.sectorId/shiftId/levelId` e a trilha.
- **Leituras:**
  - sem data (permissão do gestor, listagem do setor, token, montagem do envio) usam o espelho, como hoje;
  - com **data passada** (quadro da escala e lista do dia do envio) usam o vínculo vigente naquela data;
  - hoje e datas futuras usam o vínculo aberto.
- **Ficha:** seção "Vínculos" com o histórico (setor, turno, nível, de, até), mais recente primeiro.
- **Histórico de envios** não muda: já guarda a foto de setor, turno e nível de cada destinatário.
- **Novidades:** nota de versão explicando que trocar o setor de alguém não muda mais o passado.

## Para a GBR confirmar

- **Autorização (R1):** quais origens valem, quem registra, e o prazo para regularizar o "cadastro anterior".
- **Permissões (R2):** a matriz inteira, em especial inativar, disparo amplo e telefone; se o telefone de quem tem login deve aparecer na lista de destinatários; a definição de disparo amplo.
- **Estrutura (R3):** se existem unidade e equipe/célula na operação real.
- **Vigência (R4):** troca com data futura e correção retroativa.
- **Decisões minhas:** motivo obrigatório em toda edição da ficha; telefone e e-mail mascarados na trilha; exclusão física só sem histórico; matrícula opcional e única; responsável por demanda de comunicado conta como histórico; escolher o gestor do setor fica só com o administrador, mesmo para quem pode manter a estrutura.
- **Decisões minhas no Lote B (19/11):**
  - Pessoa criada de contato sem nome tem o número como nome. Para quem não tem "ver telefone completo", esse nome sai mascarado (`•••• 1234`) em todas as telas (setor, envio, escala, trilha), as listas são ordenadas pelo nome exibido e a busca por dígitos não procura no nome. O que está gravado não muda.
  - O disparo amplo é conferido só na criação do envio; repetir um envio e executar um agendado não conferem de novo.
  - Perder a disputa de gravação da matriz responde conflito (409) com pedido para recarregar.
  - O papel VIEWER aparece como "Leitura".
  - Limitação conhecida: as telas legadas de Contatos e de Inbox ainda mostram o telefone completo ao Operador, mesmo sem a permissão. A GBR decide se entram na regra.
- **Decisões minhas no Lote C (19/11):**
  - Envio da equipe com **data passada** usa o vínculo daquela data, na lista e na criação do envio: um envio novo para o setor A com a data de ontem alcança quem estava em A ontem, mesmo que hoje esteja em outro setor, e o remetente vê essa pessoa na lista (telefone conforme "ver telefone completo"). Para hoje e datas futuras nada muda. Isso vale também no dia a dia: o atalho "Ver esse turno" do turno da noite em andamento usa a data de ontem, então todo envio para a noite feito depois da meia-noite já segue o vínculo de ontem. A sentença R4 cita a lista do dia entre as leituras com data passada.
  - No quadro da escala de datas passadas a pessoa aparece na linha do setor em que estava; os dias em que já estava em outro setor saem como "Em <setor>". Quem pode editar e quem pode ver o quadro continua decidido pelo setor atual.
  - Em data passada, quem hoje é do setor mas naquele dia estava em outro e trabalhou ali por "Outro setor" aparece como visitante.
  - A pessoa cadastrada depois deste lote tem o vínculo com início no dia do cadastro; "Anterior ao histórico" só aparece em quem já existia na migração.
  - Duas trocas no mesmo dia que voltam ao valor original deixam duas linhas iguais em sequência (não se junta linha fechada).
  - A seção "Vínculos" fica no diálogo Histórico da pessoa e usa a mesma permissão e o mesmo alcance do Histórico: o supervisor vê os setores, turnos e níveis anteriores de quem hoje está no setor dele.
  - Setor, turno e nível com histórico não podem mais ser apagados direto no banco (o sistema só inativa, como antes).
  - Vínculo não conta como histórico que impede excluir a pessoa: as linhas saem junto com ela.

## Aceite

Lote A:
1. **T01 (parte):** editar o telefone e a situação de uma pessoa muda o público de um envio novo; os destinatários de um envio anterior continuam iguais.
2. Editar uma pessoa sem motivo é recusado; com motivo, a trilha mostra autor, data, motivo e o antes e depois só dos campos alterados, com telefone mascarado.
3. Pessoa `NAO_AUTORIZADO` não recebe: aparece na prévia em "Contato não autorizado" e, se a autorização for retirada depois de um envio agendado, o worker pula com `NOT_AUTHORIZED`.
4. Depois da migração, todas as pessoas existentes continuam recebendo e aparecem como "Cadastro anterior — origem não verificada"; a prévia mostra a linha informativa com a contagem.
5. As três portas de criação pedem a autorização; a API sem o campo grava `NAO_AUTORIZADO`; `CADASTRO_ANTERIOR` é recusado.
6. Inativar tira a pessoa dos envios e do login; reativar devolve. Excluir pessoa com histórico responde 409; sem histórico, exclui.
7. Busca por matrícula acha a pessoa na lista de usuários e na de pessoas do setor; matrícula repetida é recusada.
8. Se a gravação da trilha falhar, a alteração da pessoa não fica gravada.
9. A tela Trilha filtra por pessoa, período e tipo; SUPERVISOR não abre a consulta geral e só vê o histórico de pessoa que alcança.

Lote B:
10. Para cada papel e cada função já existente, o resultado com a matriz inicial é igual ao de antes (teste de paridade).
11. Desmarcar `escala.alterar` do OPERATOR faz a alteração de escala dele responder 403 na requisição seguinte; marcar de novo devolve.
12. ADMIN e VIEWER não são editáveis, nem pela API.
13. Sem `telefone.ver_completo`, as três listas devolvem o telefone mascarado e o grupo "Sem telefone" continua correto.
14. Envio a todos os setores ativos sem `equipe.disparo_amplo` é recusado com 403; a um subconjunto, passa.
15. `GET /auth/me` e o login devolvem as permissões efetivas; menu e botões seguem a permissão.
16. Alterar a matriz grava na trilha, visível só para o ADMIN.

Lote C:
17. **T01 (completo):** trocar o setor de uma pessoa muda o público de envios novos; a escala de datas passadas e os envios antigos continuam mostrando o setor antigo.
18. Depois da migração há exatamente uma linha aberta por pessoa, igual à ficha.
19. Duas trocas no mesmo dia deixam uma linha aberta só, e duas entradas na trilha.
20. Nenhum caminho grava setor, turno ou nível da pessoa fora da função única (teste que cobre criação, edição, mover, tirar e a partir de contatos).
21. A ficha mostra o histórico de vínculos com de e até.

Geral: gate completo sem violação nova nem agravada contra a base; boot real da API e do worker; QA visual das telas novas na stack local.

## Fica com o construtor

- Nomes de tabelas, colunas, rotas e componentes, seguindo o padrão do código.
- Como a trilha grava dentro da transação e como a consulta por pessoa é indexada.
- Onde ficam, na tela, o selo, os filtros e os contadores, seguindo o desenho atual das listas.
- Estratégia de migração e de testes, dentro das restrições acima.
