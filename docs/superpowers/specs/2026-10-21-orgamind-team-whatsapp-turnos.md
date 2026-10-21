# OrgaMind — turno fixo no cadastro e envio por setor e turno no WhatsApp da equipe

## Pedido

O cliente pediu escala de trabalho no envio do WhatsApp da equipe. O fluxo ideal dele é:

1. escolher o setor;
2. escolher o turno;
3. ver só as pessoas daquele setor e turno;
4. enviar para todos do turno ou só para as pessoas marcadas;
5. conferir os nomes antes de enviar.

Se marcar João e Maria, só os dois recebem. Ele também quer que urgências possam ir para todos os turnos e que o histórico guarde quem estava no turno e quem recebeu.

Decisão do usuário (21/10/2026): **fazer bem simples, só com primeiro e segundo turno fixos**. Escala por data, rodízio, folga e cadastro de turnos (com horários) ficam para um módulo próprio, se o cliente pedir.

## Situação atual

- `User` tem `sectorId` (setor principal), `phoneE164` e `isActive`. Não existe nenhum conceito de turno.
- A página `/whatsapp-equipe` mostra um card por setor com os membros, um botão "Enviar ao setor" e, em cada pessoa, um "Enviar". Abaixo ficam os "Envios recentes", com "Ver motivos" (PR #6).
- O `POST /internal/team-whatsapp/dispatches` aceita `target: { type: 'user', userId } | { type: 'sector', sectorId }`. Quem envia é o ADMIN e o gestor do setor (`Sector.managerId`), e a regra fica em `team-whatsapp.policy.ts`.
- O envio é assíncrono: um `TeamWhatsappRecipient` por pessoa, um job por destinatário, e cada pulado é registrado com o motivo (`NO_PHONE`, `SUPPRESSED`).

## Resultado

### 1. Turno no cadastro de usuário

- Enum novo `WorkShift { FIRST, SECOND }` e coluna `User.shift WorkShift?`, que pode ser nula. Nulo quer dizer "sem turno", e todos os usuários existentes começam assim.
- Rótulos na tela: "1º turno", "2º turno" e "Sem turno".
- Os diálogos "Cadastrar usuário" e "Editar usuário" ganham o campo **Turno**: um select com "Sem turno", "1º turno" e "2º turno". É opcional e começa em "Sem turno" no cadastro.
- A tabela de Usuários ganha a coluna **Turno**.

### 2. Envio por setor e turno

- **Alvo setor, com filtro:** `target: { type: 'sector', sectorId, shift?, userIds? }`.
  - `shift: 'FIRST' | 'SECOND'` envia só para os membros desse turno. Sem `shift`, vale "todos os turnos": todos os membros, inclusive quem está sem turno.
  - `userIds` é a seleção manual. Vão receber **apenas** esses usuários, que precisam ser membros ativos do setor e pertencer ao turno filtrado, se houver um. Ids repetidos contam uma vez só. Se algum id estiver fora do setor ou do turno, inativo ou não existir, a resposta é 422 `team_whatsapp.invalid_selection` e nada é criado. O caso de a lista ter mudado depois de carregar a tela também cai aqui.
  - Sem `shift` e sem `userIds`, o comportamento é o de hoje.
- **Alvo pessoa** (`{ type: 'user', userId }`): continua igual. É usado pelo "Enviar WhatsApp" da tela Usuários.
- A **política** não muda. O ADMIN alcança qualquer setor ativo e o gestor, só os setores que gerencia; `userIds` não abre caminho para outro setor. Também continuam iguais o canal, o texto (até 2000 caracteres), a supressão, o pacing, a fila e os códigos de erro atuais.
- O **filtro é refeito no servidor** no momento do POST, com os dados atuais. O que a tela mostrou não é confiável.

### 3. Histórico

- `TeamWhatsappDispatch.shift WorkShift?`: o filtro de turno usado, com nulo para "todos os turnos" e para o alvo pessoa.
- `TeamWhatsappRecipient.shift WorkShift?`: o turno do destinatário no momento do envio. É isso que registra quem estava escalado.
- O `targetLabel` gravado no envio passa a incluir o turno e a seleção:
  - "Produção · 2º turno";
  - "Produção · todos os turnos";
  - "Produção · 2º turno · seleção de 2".
- Em "Envios recentes", **"Ver motivos" vira "Ver destinatários"**. A lista mostra todos os destinatários do envio, com nome, turno e situação: na fila, enviado, falhou com o motivo, pulado com o motivo. Nenhum telefone aparece. *(Decisão minha: o pedido é guardar quem recebeu, e mostrar só falhas não responde isso.)*

### 4. Tela "WhatsApp da equipe"

- No topo ficam dois seletores: **Setor**, com os setores que o usuário alcança (pré-selecionado se houver só um), e **Turno**, com "1º turno", "2º turno" e "Todos os turnos". Turno não tem valor padrão: até escolher setor e turno, a lista mostra "Escolha o setor e o turno".
- Com os dois escolhidos, a lista mostra os **membros ativos** daquele setor e turno, com caixa de seleção, nome, turno e telefone ou "sem telefone".
  - Quem está sem telefone tem a caixa desabilitada.
  - Com 1º ou 2º turno escolhido, uma nota diz "N pessoa(s) deste setor estão sem turno definido — defina em Usuários" quando houver alguém nessa situação.
  - "Marcar todos" marca ou desmarca as pessoas habilitadas.
- Há duas ações: **"Enviar para todos do turno (N)"** e **"Enviar para selecionados (M)"**. A segunda fica desabilitada sem nenhuma marcação. N conta quem tem telefone.
- O **diálogo "Enviar WhatsApp"** mostra o destino (setor e turno), a lista de nomes que vão receber, a lista "Ficam de fora (sem telefone)" quando houver, o canal e o texto. No sucesso continua o toast atual, com os pulados. O erro `team_whatsapp.invalid_selection` aparece como "A lista de pessoas mudou. Atualize a página e confira de novo."
- Saem os cards por setor e o "Enviar" por pessoa: a seleção cobre os dois casos. Ficam o estado vazio para quem não é ADMIN nem gestor e os "Envios recentes".
- **Novidades:** entrada nova no topo de `RELEASE_NOTES` com `where: '/whatsapp-equipe'`.

## Contratos

- `POST /users` e `PATCH /users/:id` aceitam `shift?: 'FIRST' | 'SECOND' | null`. No PATCH, campo ausente mantém o valor e `null` limpa. `GET /users`: cada item ganha `shift: 'FIRST' | 'SECOND' | null`. O contrato `backend/src/schemas/contracts/user.schema.ts` e o schema do frontend mudam juntos.
- `GET /internal/team-whatsapp/targets`: cada membro ganha `shift`.
- `POST /internal/team-whatsapp/dispatches`: o alvo setor ganha `shift?` e `userIds?` (array de 1 a 500 ids). O erro novo é 422 `team_whatsapp.invalid_selection`.
- `GET /internal/team-whatsapp/dispatches`: cada item ganha `target.shift`, e cada envio passa a trazer a lista de todos os destinatários (`{ userId, name, shift, status, reason }`) no lugar da lista só de falhas e pulados. Front e back sobem juntos; não há outro consumidor.
- Migração aditiva, com o enum e três colunas que podem ser nulas, e sem backfill.

## Fora do escopo

Escala por data, rodízio, folga, cadastro de turnos com horários, envio agendado para o início do turno, o campo "função", filtro por turno em Comunicados, Demandas ou outros módulos, e o provedor oficial.

## Riscos a cobrir (Review Focus)

1. Chamada direta à API com `userIds` de outro setor, de outro turno ou de usuário inativo, inclusive de um gestor tentando alcançar quem não gerencia: 422 `invalid_selection` (ou o 403 de hoje, para setor fora da política), e nada é criado.
2. O turno de alguém muda entre carregar a tela e enviar: o servidor usa o turno atual. Se a seleção ficou inválida, a resposta é 422 e o envio não sai parcial.
3. "Todos os turnos" inclui quem está sem turno; 1º ou 2º turno não inclui.
4. Selecionado sem telefone, ou com telefone suprimido, enviado pela API: é pulado com o motivo, como hoje. Ids repetidos não geram dois envios.
5. Editar usuário sem mandar `shift` não apaga o turno; mandar `null` apaga.

## Aceite

1. O ADMIN cadastra e edita o turno do usuário, e a tabela mostra o turno. Usuários antigos aparecem como "Sem turno".
2. Na tela, escolher Produção e 2º turno lista só os membros ativos do 2º turno. "Enviar para selecionados" com João e Maria cria um envio com exatamente esses dois destinatários. "Enviar para todos do turno" cria um envio para todos os do turno que têm telefone. "Todos os turnos" alcança o setor inteiro.
3. O diálogo lista os nomes que vão receber e os que ficam de fora por falta de telefone antes do botão Enviar.
4. Os envios recentes mostram o setor e o turno no rótulo. "Ver destinatários" lista todos, com turno e situação.
5. Os 5 riscos acima estão cobertos por teste.
6. `gate --changed --base origin/main` verde por task, no frontend e no backend. Gate completo por lado, no fim, sem piora sobre a baseline de `a68a532`. CI do PR verde (backend-tests, frontend-build, e2e, migration-drift). Revisão independente por task.
