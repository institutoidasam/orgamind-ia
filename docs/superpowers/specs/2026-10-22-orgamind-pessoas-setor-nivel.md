# OrgaMind — pessoas no setor, nível hierárquico e envio para vários setores

## Intenção

O cliente (GBR) testou a escala em produção em 22/10/2026 e mandou cinco áudios (transcrições em `.superpowers/audios-cliente-2026-10-22/`). O que ele disse:

- Não consegue colocar no setor as pessoas e os números que já cadastrou: "eu tenho um setor aqui, como é que eu faço para adicionar pessoas nesse setor? Ou como eu faço para adicionar um setor a essas pessoas?"
- Na hora de disparar, só aparece quem já está dentro do setor, e ele não sabe como pôr pessoas lá.
- Por enquanto, cada pessoa fica num setor só ("depois a gente vê se dá para colocar uma pessoa em mais de um setor").
- A ideia de uso: **o RH dispara para os setores da fábrica** (TI, operacional). Cada setor tem um coordenador. O RH quer mandar **só para os coordenadores**, ou só para os líderes, ou para todo mundo. Os níveis citados são coordenador, líder, funcionário e operador. "Ainda tem a questão de turno", que já existe.

**Por que ele travou:** no sistema de hoje, uma pessoa só entra num setor se for **usuário do sistema**. Isso exige e-mail, senha temporária e o campo "Setor principal" na tela Usuários. A página do setor só lista os membros, sem ação de adicionar. Os números que ele salvou estão em **Contatos**, que não têm setor e não aparecem no envio da equipe. Para quem só recebe WhatsApp (operador de fábrica), exigir e-mail e senha não faz sentido.

O usuário vai mostrar ao cliente assim que estiver em produção. Ajustes vêm depois, conforme o retorno dele. A regra continua **configurável e simples de mudar**.

O usuário aprovou o desenho em 22/10/2026 ("Pode seguir"). Escolheu que o **gestor do setor também cadastra pessoas no próprio setor** e que o **RH entra como Administrador**. O que está marcado *(decisão minha)* foi detalhado por mim para fechar o desenho.

## Objetivos

1. Pôr pessoas num setor a partir da **página do setor**:
   - nova pessoa;
   - a partir dos **Contatos** já salvos, vários de uma vez;
   - pessoa já cadastrada, mudando-a de setor.
2. **Pessoa sem acesso ao sistema**: só recebe WhatsApp, sem e-mail, sem senha e sem login.
3. **Nível** na pessoa (Coordenador, Líder, Funcionário, Operador), numa lista editável.
4. Envio para **um ou mais setores** (ou todos), com filtro por **nível**, mantendo data e turno como hoje.
5. Telas vazias que digam o que fazer (setor sem ninguém → "Adicionar pessoas").

## Não objetivos

- Pessoa em mais de um setor ao mesmo tempo. Continua só a visita temporária da escala (exceção "Outro setor").
- Hierarquia em árvore (coordenador acima de líder, etc.). O nível é um rótulo para filtrar o envio.
- Perfil de permissão novo para o RH. Quem envia para todos os setores é o Administrador, como hoje (escolha do usuário).
- Importar pessoas de planilha direto no setor. A planilha já entra em Contatos (Importações), e de lá vai para o setor pelo objetivo 1.
- Mudar Comunicados, Demandas ou Campanhas. A única mexida nesses módulos é tirar a pessoa sem acesso dos seletores (seção 1).

## Anti-objetivos (falha mesmo que funcione)

- Alguém receber mensagem sem estar na lista conferida antes de enviar ou agendar.
- Uma pessoa sem acesso conseguir entrar no sistema.
- Um gestor de setor enviar para setor que não gerencia.
- Perder o setor, o turno, a escala ou o histórico de envio de quem já está cadastrado.
- O envio para um setor só, sem filtro de nível, mudar de comportamento.

## Restrições

- Stack e padrões atuais: NestJS + Prisma + Zod (`createZodDto`) + BullMQ; React + TanStack Query/Router + Radix; Vitest e testcontainers.
- Telefone continua único por pessoa e ligado ao Contato de mesmo número, como hoje (`UserPhoneService`).
- Pipeline do envio reaproveitado: `TeamWhatsappDispatch` com um `TeamWhatsappRecipient` por pessoa, fila `TEAM_WHATSAPP_SEND`, pulados com motivo, agendamento pelo tick já existente. A lista é refeita no servidor e comparada com a conferida (422 `invalid_selection`), como hoje.
- Política de envio: o ADMIN alcança todos os setores ativos, e o gestor (`Sector.managerId`) os setores que gerencia. Nada muda.
- Migrações sem perda de dados. O VPS de produção tem pouca memória, então nada de serviço novo no compose.
- Textos em pt-BR, no tom das telas atuais.

## O que fica decidido

### 1. Pessoa sem acesso ao sistema

- A pessoa tem **Nome** e **Telefone** (obrigatórios, telefone único como hoje). Também tem **Setor**, **Nível**, **Função** (texto livre, como hoje) e **Turno do cadastro** (como hoje).
- **Acesso ao sistema**: "Sem acesso" ou "Com acesso".
  - Com acesso: o fluxo de hoje (e-mail, perfil, senha temporária).
  - Sem acesso: sem e-mail e sem senha, e o login é recusado sempre.
- Uma pessoa sem acesso pode **receber acesso depois**: informa-se o e-mail e o perfil, e o sistema gera a senha temporária como no convite *(decisão minha)*. Tirar o acesso de quem já tem fica fora.
- Na tela **Usuários**, todos aparecem, e a coluna Acesso mostra "Sem acesso" para quem não entra no sistema. Quem é sem acesso não tem "Redefinir senha".
- Quem não tem acesso não pode ser gestor de setor, nem pode enviar ou agendar.
- A pessoa sem acesso fica **fora de todo seletor de quem age no sistema**: gestor de setor, responsável de Demanda, atribuição de conversa e notificações de Comunicados/Demandas para a equipe. Um critério único decide isso (ter acesso) *(decisão minha: senão a demanda cairia com quem nunca entra)*. Fora desses seletores, ela só aparece como destinatária do WhatsApp da equipe, na escala e nas listas de pessoas (Usuários, página do setor).
- **Como guardar** (e-mail e senha anuláveis, ou outro desenho) fica com o builder. Login, redefinição de senha, auditoria e listagens não podem quebrar quando o e-mail não existe.

### 2. Página do setor

- Botão **Adicionar pessoas**, para o ADMIN e para o **gestor do setor**, só no setor que ele gerencia (escolha do usuário). Abre um diálogo com três abas:
  - **Nova pessoa**: nome, telefone, nível, função, turno. Entra sem acesso.
  - **Dos contatos**: busca por nome ou número e seleção de vários. O nível escolhido vale para todos os selecionados. Cada contato vira uma pessoa sem acesso, com o nome e o número do contato, ligada a ele. Contato que já é pessoa aparece desabilitado, com "já é <nome> · <setor>".
  - **Já cadastrada**: busca pessoas. Escolher alguém de outro setor muda a pessoa de setor, com confirmação ("<nome> sai de <setor>"). O gestor só vê aqui pessoas **sem setor**: tirar gente de outro setor é só do ADMIN *(decisão minha)*.
- Erros por item no lote, sem perder os que deram certo: telefone inválido, número já usado por outra pessoa.
- Na lista de membros da página aparecem nome, nível, função, turno e acesso. As ações são:
  - **Editar**, que abre o mesmo cadastro;
  - **Tirar do setor**, só para pessoa sem acesso, que fica "Sem setor". Quem tem acesso muda de setor pelo cadastro, como hoje, porque não-ADMIN com acesso exige setor.
- **O que o gestor pode no próprio setor** *(decisão minha, para não abrir o cadastro de usuários)*:
  - adicionar pessoas pelas três abas, com os limites acima;
  - na pessoa sem acesso do setor, editar nome, telefone, nível, função e turno, e tirá-la do setor;
  - na pessoa com acesso do setor, editar só nível, função e turno.
- O gestor não pode dar ou tirar acesso, mudar perfil ou e-mail, mover para outro setor nem mexer em pessoa de setor que não gerencia. O servidor recusa com 403.
- A lista de níveis (seção 3) continua só do ADMIN.
- A aba **Dos contatos** usa os contatos que a pessoa já pode ver hoje. Se o gestor não tiver acesso a Contatos, a aba some para ele, e decidir isso fica com o builder conforme a regra atual de leitura de contatos.

### 3. Nível

- Lista editável **Níveis** (só ADMIN), no padrão da tela Turnos: nome, ordem, ativo/inativo, sem apagar.
- A migração cria Coordenador, Líder, Funcionário e Operador, nessa ordem, e todo mundo começa sem nível.
- Nível inativo some do cadastro novo e do filtro, mas fica nas pessoas que já o têm e no histórico.
- O nível é independente do **Gestor** do setor. O gestor é quem usa o sistema pelo setor, e o nível é só um rótulo para o envio *(decisão minha)*. A tela do setor mostra os dois.
- Cadastro de usuário (convite e edição) e página do setor ganham o campo Nível.

### 4. Envio para vários setores e por nível

- **Setores**: escolha múltipla, com a opção "Todos os setores". O ADMIN vê todos os ativos e o gestor só os seus, como hoje. Começa vazio, exceto quando só há um setor possível, que já vem escolhido como hoje.
- **Níveis**: escolha múltipla, com "Sem nível" como opção. Vazio significa todos.
- **Data** e **Turno**: iguais a hoje, valendo para todos os setores escolhidos. "Incluir quem está de folga" também continua igual.
- A lista conferida vem **agrupada por setor**, com o nível ao lado do nome. Mostra quem está de folga e quem está sem telefone, como hoje. Pessoa sem setor não entra.
- Seleção, "Enviar para todos (N)", "Enviar para selecionados (M)" e o diálogo de confirmação com os nomes ficam como hoje.
- **Agendar no início do turno** funciona igual, com o turno escolhido.
- **Histórico**: o rótulo do envio cita os setores (até dois nomes e "+N") e os níveis, por exemplo `RH, TI +2 · Coordenador · Noite · 22/10`. "Ver destinatários" agrupa por setor, com o nível da época (foto).
- Com **um setor e sem filtro de nível**, o envio é exatamente o de hoje.
- **Gestor e envios de vários setores** *(decisão minha)*: ele só cria envio dentro dos setores que gerencia. Na lista de Agendados, vê e cancela um envio só quando **todos** os setores dele são seus. Em Recentes, vê os envios que ele mesmo fez, como hoje (ele só cria envio para setores que gerencia). O ADMIN vê e cancela todos. Assim o gestor nunca vê nomes nem cancela envios de setor que não gerencia.
- O servidor refaz a lista com os mesmos setores, níveis, data e turno. Rejeita setor que o remetente não alcança (403), nível inexistente (422) e seleção que não bate (422 `invalid_selection`).

### 5. Telas vazias e ajuda

- Envio com setor sem ninguém: "Ninguém neste setor ainda. Adicionar pessoas", com link para a página do setor.
- Página do setor sem membros: a mesma chamada.
- A Novidade (release notes) explica como pôr pessoas no setor e como enviar só para coordenadores.

## Fora do escopo do builder (fica com o usuário e o cliente)

- Conferir com o cliente os nomes dos níveis, que são editáveis.
- Decidir quem do RH será Administrador.

## Critérios de aceite

1. O ADMIN abre o setor RH, adiciona 3 contatos de uma vez com o nível Funcionário, e eles aparecem na página do setor e no envio para o RH.
1b. O gestor de Operação adiciona uma pessoa nova e define o nível de alguém do próprio setor. Ele não consegue mexer em pessoa de TI, nem dar acesso a ninguém (403 no servidor).
2. Uma pessoa sem acesso não consegue entrar, nem com o número nem com nada, e aparece como "Sem acesso" em Usuários.
3. Envio para os setores TI e Operação com nível Coordenador: a lista mostra só os coordenadores dos dois, agrupados por setor, e só eles recebem.
4. O gestor de Operação só vê Operação, e o servidor recusa outro setor com 403.
5. Quem já existe continua com setor, turno, escala e histórico iguais. O envio para um setor só, sem nível, é idêntico ao de hoje.
6. Renomear "Funcionário" na lista de níveis troca o nome em todos os lugares. Nível inativo não aparece para cadastro novo.
7. Agendar para vários setores no início do turno: sai uma vez, só para a lista conferida, e cancela como hoje.
