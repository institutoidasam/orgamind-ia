# OrgaMind — Etapa 2 do plano GBR: planilhas (exportar e importar pessoas)

## Intenção

Segunda etapa do plano entregue à GBR (`reports/plano-gbr/`), na ordem pedida pelo usuário em 19/11/2026. Cobre:

- **CAD-04**: exportar pessoas e escala em CSV e XLSX, com filtros e permissão de telefone;
- **CAD-03**: importar pessoas por CSV e XLSX, com modelo, mapeamento de colunas e prévia antes de gravar.

**Por que agora:** a GBR quer carregar e conferir lotes grandes sem depender do programador. Hoje só existe importação e exportação de **contatos** (lista de marketing), em XLSX, sem prévia. Pessoas (colaboradores, com setor, turno e matrícula) só entram uma a uma.

**De onde vêm as regras.** O Escopo e o Caderno da GBR de 28/10/2026 definem o que a função faz. A matriz de permissões das duas chaves novas foi fechada pelo Conselho R em 19/11/2026 (`~/.claude/tribunais/2026-11-19/conselho-R/sentenca-R.md`, R2) e está marcada **(conselho R2)**. O que o caderno não diz foi completado por mim e está marcado *(decisão minha)*. Tudo fica listado em "Para a GBR confirmar".

**Fontes:** `escopo.txt` e `caderno.txt` em `.superpowers/sdd/2026-11-19-orgamind-gbr-etapa1-lote-a-ficha-trilha/fontes/` (CAD-03, CAD-04, "Regra da importação", testes T02 e T03); mapas do código em `.superpowers/sdd/2026-11-19-orgamind-gbr-etapa2-planilhas/fontes/` (`mapa-import-contatos.md`, `mapa-export-auditoria-permissoes.md`, `mapa-pessoas-escala-back.md`, `mapa-front.md`).

**Vocabulário:** "pessoa" é o `User`, com ou sem login. "Vínculo" é o setor, turno e nível habituais. "Lote" é uma planilha enviada para importação. "Alcance" são os setores que o usuário gerencia (ADMIN alcança todos).

## Objetivos

1. Quem tem a permissão exporta a lista de pessoas, filtrada, em CSV ou XLSX, e o arquivo abre no Excel com acentos e colunas certos.
2. Quem tem a permissão exporta a escala de um setor num período, em CSV ou XLSX.
3. O telefone sai completo só para quem pode vê-lo; para os demais sai mascarado.
4. Toda exportação e todo lote de importação ficam registrados com autor, data e o que foi pedido.
5. Quem tem a permissão importa uma planilha de pessoas vendo, antes de gravar, o que cada linha vai fazer: criar, atualizar, nada, ou por que não entra.
6. Só o conjunto confirmado é gravado. Reimportar a mesma planilha não cria pessoas duplicadas.
7. As linhas que não entraram saem num relatório baixável, com o motivo.

## Não objetivos

- Mexer na importação e na exportação de **contatos** (`/imports`, `GET /contacts/export.xlsx`): continuam como estão.
- Criar login pela planilha. A importação só cria pessoa **sem acesso**; e-mail e perfil não são colunas.
- Criar setor, turno ou nível pela planilha. Nome que não existe invalida a linha.
- Inativar ou reativar pessoa pela planilha, e retirar autorização de contato pela planilha (ver "Para a GBR confirmar").
- Importar escala (ciclo, folgas, exceções). Só o vínculo habitual entra.
- Exportar a escala de vários setores num arquivo só.
- Agendar exportação ou enviar por e-mail.

## Anti-objetivos (falha mesmo que funcione)

- Uma célula "sim" na coluna de autorização virar autorização sem origem informada.
- Telefone completo num arquivo baixado por quem não tem `telefone.ver_completo`.
- Pessoa de setor fora do alcance aparecer na exportação, ou ser alterada pela importação, de quem não é ADMIN.
- A importação gravar por um caminho diferente do cadastro manual (sem trilha, sem histórico de vínculo, sem as mesmas validações).
- Linha não confirmada, ou inválida, entrar no banco.
- Arquivo exportado executar fórmula ao abrir (nome começando por `=`, `+`, `-` ou `@`).
- Exportação recusada baixar arquivo vazio, ou exportação feita ficar sem registro.

## Restrições

- Sem dependência nova no backend nem no frontend. XLSX com `exceljs` (já instalado); CSV lido e escrito por código próprio.
- A matriz de permissões e a regra de telefone são as do Lote B (Etapa 1); esta etapa só acrescenta as duas chaves.
- Toda gravação de pessoa passa por `UsersService` (`createPersonWithoutAccess` e `updateUser`), o caminho único do Lote C. Nenhum `prisma.user.create/update` novo.
- "Hoje" é sempre `todayIn` (America/Manaus).
- Textos de tela, de arquivo e de erro em pt-BR, escritos para quem opera.
- Migração só aditiva; nada destrutivo.

## O que fica decidido

### Comum aos dois lotes

**Permissões (conselho R2).** Duas chaves novas no catálogo do Lote B, semeadas por migração:

| Chave | Nome na tela | ADMIN | SUPERVISOR | OPERATOR | VIEWER |
|---|---|---|---|---|---|
| `pessoas.exportar` | Exportar pessoas e escala | sim | não | não | não |
| `pessoas.importar` | Importar planilha de pessoas | sim | não | não | não |

O ADMIN pode liberar as duas para Supervisor e Operador na tela de Permissões, como as outras chaves. Texto de recusa: "Você não tem permissão para exportar pessoas e escala." e "Você não tem permissão para importar planilhas de pessoas."

- **Padrão no código:** hoje a matriz padrão do Supervisor é "todas menos estrutura". Ela passa a ser uma lista explícita, sem as duas chaves novas, no backend e no frontend; a migração semeia Supervisor e Operador com as duas negadas. Sem isso, o Supervisor ganharia exportar e importar por padrão.
- **Rotas:** os dois controllers novos levam a chave na classe (`pessoas.exportar` ou `pessoas.importar`), como manda o Lote B: com a chave na classe, o papel deixa de ser conferido à parte e quem decide é a matriz (ADMIN sempre passa, VIEWER nunca). Vale para todas as rotas, inclusive a do modelo. Um teste prova que nenhuma rota deles fica sem a chave (rota sem chave e sem papel declarado cairia na regra antiga, que libera ADMIN e OPERATOR).

**Formato do CSV** *(decisão minha)*, igual na exportação, no modelo e no relatório de erros:
- UTF-8 com BOM, separador `;`, fim de linha CRLF. É o que o Excel em português abre com acentos e colunas certos.
- Campo entre aspas quando contém `;`, aspas ou quebra de linha; aspas dobradas dentro do campo.
- Texto que começa por `=`, `+`, `-`, `@`, tabulação ou retorno de carro (ou por apóstrofos seguidos de um deles) ganha um apóstrofo na frente, para a planilha não tratar como fórmula. No XLSX toda célula é gravada como texto, sem fórmula e sem apóstrofo. Na leitura (importação) de **CSV**, um apóstrofo inicial é tirado quando o que vem depois são esses caracteres (com ou sem outros apóstrofos antes); assim o que foi exportado volta igual. Célula de XLSX é lida como está.
- Telefone sai no formato nacional, `(92) 99111-2008`, que não começa por `+` e volta a ser lido pela importação. Número de fora do Brasil sai no formato internacional (`+1 415 555 2671`) e, por começar com `+`, ganha o apóstrofo da regra acima.
- Data sai como `DD/MM/AAAA`.

**Trilha.** Nova categoria de trilha **Planilhas** (`AuditCategory.SPREADSHEET`). Exportações e lotes de importação aparecem na tela Trilha de alterações com esse tipo, só para o ADMIN (regra do Lote A para a consulta geral).

- Os registros de Planilhas são gravados pelo caminho que **propaga erro** e recebe o autor explícito (`recordChange`, dentro de transação), não pelo `audit.log`, que engole a falha. Autor = quem exportou, ou quem confirmou o lote.
- O que precisa aparecer na tela (formato, filtros, data de referência, quantidade de linhas, telefone completo ou mascarado, arquivo e contagens do lote) vai nos campos de antes/depois (`changes`, com "antes" vazio), porque a tela da Trilha não mostra `metadata`.
- A categoria é passada explicitamente em cada registro (os prefixos novos não estão no mapa de prefixos). O valor novo do enum entra numa migração que não o usa.

### Lote D — Exportar pessoas e escala (CAD-04)

#### D1. Exportar pessoas

- **Rota:** `GET /internal/people-export/people?format=csv|xlsx&sectorId=&shiftId=&status=active|inactive|all&date=AAAA-MM-DD`. Exige `pessoas.exportar`.
- **Filtros:** setor (um, ou todos os do alcance), turno (um, ou todos), situação (padrão `active`), data de referência (padrão hoje).
- **Data de referência** *(decisão minha)*: decide o **vínculo** mostrado e filtrado. Hoje ou futuro: o vínculo da ficha. Data passada: o vínculo que valia naquele dia (histórico do Lote C); sem linha que cubra o dia, o da ficha. Situação, telefone, função e autorização são sempre os atuais, porque não têm histórico por data; o arquivo diz isso na aba de instruções do XLSX e a tela diz no diálogo.
- **Alcance:** ADMIN exporta todas as pessoas, inclusive as sem setor. Quem não é ADMIN exporta só pessoas cujo setor (na data de referência) está no seu alcance; pedir um setor fora do alcance responde 403; quem não gerencia nenhum setor recebe 403. **(conselho R2: "exporta só os setores que alcança")**
- **Data passada não amplia o que se vê** *(decisão minha)*: para quem não é ADMIN, pessoa que **hoje** está fora do alcance (saiu do setor depois da data) sai com o telefone mascarado, mesmo que o ator tenha `telefone.ver_completo`. Pessoa cadastrada depois da data de referência não entra no arquivo.
- **Telefone (conselho R2):** completo quando o ator tem `telefone.ver_completo` **e** (é ADMIN ou a pessoa não tem login); senão mascarado (`•••• 2008`); sem telefone, vazio. É a mesma regra da lista do setor.
- **Nome:** o nome que é o próprio telefone sai mascarado para quem não vê o telefone completo (regra do Lote B).
- **Colunas, nesta ordem** (os cabeçalhos são os mesmos do modelo de importação, para o arquivo poder voltar): `matricula`, `nome`, `telefone`, `funcao`, `setor`, `turno`, `nivel`, `autorizacao_contato` (Sim/Não), `origem_autorizacao` (Termo assinado, Ficha de admissão, Aceite por WhatsApp, Outro, Cadastro anterior), `detalhe_origem`, `data_autorizacao`, `situacao` (Ativa/Inativa), `tem_acesso` (Sim/Não).
- **Ordem das linhas:** setor, depois o nome **como sai no arquivo** (o mascarado, quando for o caso), depois id. Ordenar pelo nome real deixaria adivinhar o número escondido.
- **Sem resultado:** o arquivo sai só com o cabeçalho.
- **Limite:** 50.000 linhas; acima disso, 422 `export.too_large` com "Há pessoas demais para um arquivo só. Filtre por setor ou turno."
- **Nome do arquivo:** `pessoas-AAAA-MM-DD.csv|xlsx` (dia da exportação).
- **XLSX:** aba "Pessoas" com os dados e aba "Instruções" com: data e hora da exportação, filtros usados, significado de cada coluna e o aviso sobre a data de referência. O CSV só tem os dados.
- **Ordem da operação:** conferir permissão e alcance → contar → conferir o limite → **registrar na trilha** → enviar o arquivo. Se o registro falhar, a rota responde erro e não há arquivo. Exportação recusada não baixa nada.
- **Trilha:** ação `people.export`, categoria Planilhas, com formato, filtros, data de referência, quantidade de linhas e se o telefone saiu completo ou mascarado. Nenhum dado pessoal no registro.

#### D2. Exportar escala

- **Rota:** `GET /internal/people-export/schedule?format=csv|xlsx&sectorId=&from=&to=`. Exige `pessoas.exportar` **e** poder ver o quadro daquele setor (as mesmas regras do quadro da Escala: alcance e período de até 42 dias).
- **Conteúdo:** o que o quadro mostra. Uma linha por pessoa; colunas `nome`, `funcao`, `visitante` (Sim quando a pessoa é de outro setor) e uma coluna por dia do período, com cabeçalho `DD/MM/AAAA`.
- **Célula do dia:** nome do turno; `Folga`; `Férias`; `Em <setor>` quando trabalha em outro setor naquele dia; vazio quando não há escala. Os mesmos textos da tela.
- **Nome** mascarado como no quadro. Sem coluna de telefone.
- **Limite:** se o quadro vier cortado (mais de 500 pessoas), 422 `export.too_large` com "Há pessoas demais neste setor para um arquivo só."
- **Nome do arquivo:** `escala-<setor>-AAAA-MM-DD-a-AAAA-MM-DD.csv|xlsx` (nome do setor reduzido a letras minúsculas sem acento, números e hífen).
- **Trilha:** ação `schedule.export`, categoria Planilhas, com formato, setor, período e quantidade de linhas.

#### D3. Tela

- **Diálogo "Exportar pessoas"**: Formato (CSV ou XLSX), Setor ("Todos os setores" ou um da lista do alcance), Turno ("Todos" ou um), Situação (Ativas, Inativas, Todas), Data de referência (padrão hoje, com a frase "Em data passada, setor, turno e nível são os que valiam naquele dia. Telefone, função e situação são sempre os atuais."). Botão "Exportar". Para quem não vê telefone completo, aviso "O telefone sairá mascarado."
- **Onde abre:** botão "Exportar" no cabeçalho de **Usuários** e no cabeçalho da **página do setor** (já com o setor escolhido). Só aparece para quem tem `pessoas.exportar`.
- **Escala:** botão "Exportar" na linha de controles, com escolha de CSV ou XLSX; usa o setor e o período que estão na tela. Só aparece para quem tem `pessoas.exportar`.
- Erro da API aparece como aviso na tela (o texto da API); 403 usa o tratamento de permissão negada que já existe.
- **Permissões:** as duas chaves novas aparecem na matriz da tela de Permissões com nome e descrição.
- **Trilha:** o filtro de tipo ganha "Planilhas"; as ações novas têm rótulo em português ("Exportou pessoas", "Exportou escala").
- **Novidades:** uma entrada explicando a exportação.

### Lote E — Importar pessoas (CAD-03)

#### E1. Fluxo

Quatro passos, numa página só ("Importar pessoas"):

1. **Arquivo.** Baixar o modelo (CSV ou XLSX) e enviar a planilha preenchida.
2. **Colunas.** O sistema mostra as colunas do arquivo e sugere a qual campo cada uma corresponde; a pessoa confere e ajusta.
3. **Prévia.** Cada linha aparece com o que vai acontecer e o motivo. A pessoa escolhe o que confirmar.
4. **Resultado.** Quantas foram criadas, atualizadas e quantas falharam; botão para baixar o relatório de erros.

Abaixo dos passos, a lista dos lotes já enviados (arquivo, autor, data, situação, contagens, relatório).

#### E2. Arquivo e modelo

- **Aceita:** `.csv` e `.xlsx`, até 5 MB e 5.000 linhas de dados *(decisão minha: a base da GBR tem centenas de pessoas; o limite mantém a prévia rápida)*. Acima disso, 422 com "A planilha tem linhas demais. Envie até 5.000 por vez."
- **CSV:** separador `;` ou `,` detectado pela linha de cabeçalho; aspas no padrão; UTF-8 com ou sem BOM. Arquivo que não é UTF-8 válido é lido como Windows-1252, que é como o Excel em português salva "CSV (separado por vírgulas)".
- **XLSX:** primeira aba; cabeçalho na linha 1. Célula com fórmula vale pelo valor calculado; data do Excel vira data civil, sem fuso; número vira texto (telefone e matrícula digitados como número).
- Cabeçalho repetido, arquivo vazio ou sem linha de dados: 422 com texto próprio.
- **Modelo** (`GET /internal/people-import/template?format=csv|xlsx`): cabeçalhos `matricula`, `nome`, `telefone`, `funcao`, `setor`, `turno`, `nivel`, `autorizacao_contato`, `origem_autorizacao`, `detalhe_origem`, `data_autorizacao`, e uma linha de exemplo com matrícula `EXEMPLO`. No XLSX, uma aba "Instruções" com as regras desta seção. Linha com matrícula `EXEMPLO` é sempre ignorada na importação.
- O arquivo em si não é guardado. Ficam o nome, o tamanho, o resumo SHA-256 e as linhas lidas.
- **Prazo do que fica guardado** *(decisão minha)*: a planilha do cliente pode trazer colunas que não interessam (CPF, endereço). Ao confirmar ou descartar o lote, apagam-se as colunas **não mapeadas** de todas as linhas e o conteúdo das linhas desmarcadas ou que não serão gravadas por escolha de quem confirmou. O conteúdo de cada linha confirmada é apagado quando ela é gravada (fica só o número da linha, o resultado e a pessoa). Das linhas que não entraram por erro ficam as colunas mapeadas e o motivo, para o relatório. Linhas não gravadas por encerramento guardam as colunas mapeadas, como as de erro.

#### E3. Mapeamento de colunas

- Campos: Matrícula, Nome, Telefone, Função, Setor, Turno, Nível, Autorização de contato, Origem da autorização, Detalhe da origem, Data da autorização.
- Sugestão automática pelo cabeçalho, sem diferenciar maiúsculas, acentos, espaços e sublinhado, com sinônimos comuns (`celular`, `whatsapp`, `fone` → Telefone; `cargo` → Função; `area`, `departamento` → Setor; `registro`, `id`, `cracha` → Matrícula; `colaborador`, `funcionario` → Nome).
- Cada campo recebe no máximo uma coluna; coluna sem campo fica como "Não usar". Para seguir, precisam estar mapeados **Nome** e pelo menos um entre **Telefone** e **Matrícula** (dá para atualizar só pela matrícula; pessoa nova continua exigindo telefone).
- As colunas `situacao` e `tem_acesso` de um arquivo exportado ficam como "Não usar".
- Mudar o mapeamento refaz a prévia.

#### E4. Como cada linha é lida

- **Identificação** *(decisão minha, a partir do caderno: "identificar por matrícula quando disponível")*:
  1. Com matrícula: procura a pessoa por matrícula (sem diferenciar maiúsculas).
  2. Se não achou por matrícula, ou a linha não tem matrícula: procura pelo telefone (as duas grafias do nono dígito).
  3. Não achou: pessoa nova.
  4. Linha sem matrícula e sem telefone válido: Inválida, "Sem matrícula nem telefone para identificar".
- **Conflito:** a matrícula é de uma pessoa e o telefone é de outra; ou a pessoa achada pelo telefone já tem **outra** matrícula. A linha não entra.
- **Duplicada:** a mesma matrícula (sem diferenciar maiúsculas), ou o mesmo telefone (pelas duas grafias do nono dígito; telefone mascarado não conta), aparece em mais de uma linha do arquivo. A primeira ocorrência segue com a classificação que tiver, mesmo inválida; as seguintes ficam como duplicadas e não entram.
- **Pessoa nova** exige nome e telefone válidos. Setor, turno, nível, função e matrícula são opcionais. Em pessoa nova, nome no padrão de telefone mascarado (`•••• 2008`) deixa a linha Inválida, "Nome inválido".
- **Pessoa existente:** célula vazia **não altera** o campo. A planilha não apaga valores. Telefone mascarado (`•••• 2008`) conta como vazio. Linha em que nada muda fica como "Sem alteração". Nome no padrão de telefone mascarado (`•••• 2008`) também conta como vazio, para o arquivo exportado por quem não vê o telefone não gravar a máscara por cima do nome. A célula de nome pode vir vazia em pessoa existente.
- **Ordem das checagens.** Para o ADMIN, "Sem alteração" é decidido primeiro: compara-se cada célula, depois da mesma normalização do cadastro, com o valor atual; valor igual ao atual vale mesmo que o setor, turno ou nível esteja inativo. Para quem **não é ADMIN**, as travas de alcance, de login e de telefone vêm **antes** de "Sem alteração" (senão a resposta diria se um palpite sobre pessoa fora do alcance está certo); só a regra do setor, turno ou nível inativo igual ao atual continua valendo.
- **Pessoa inativa:** a planilha não a altera. A linha fica "Sem alteração" ou Inválida, "Pessoa inativa; reative na ficha".
- **Setor, turno e nível:** pelo nome (setor também pelo código), sem diferenciar maiúsculas e acentos, só entre os **ativos**. Não achou: linha inválida, "Setor 'X' não encontrado" (idem turno e nível). Achou mais de um: inválida, "Setor 'X' corresponde a mais de um".
- **Telefone:** mesma validação do cadastro. Inválido: "Telefone inválido". De outra pessoa: conflito.
- **O motivo nunca revela outra pessoa** (I7): em Conflito, Inválida e Duplicada, a prévia e o relatório mostram só o que veio na linha. O texto é "O telefone já pertence a outra pessoa cadastrada" ou "A matrícula já pertence a outra pessoa cadastrada", sem nome, setor ou matrícula de quem é.
- **Tamanhos:** nome até 120, função até 80, matrícula até 30, detalhe da origem até 120.
- **Autorização de contato** (regra do caderno: célula "sim" não vale sem origem verificável; conselho R1):
  - `autorizacao_contato` aceita Sim/Não (e `s`, `n`, `x`, `1`, `0`).
  - **Sim com origem válida** (Termo assinado, Ficha de admissão, Aceite por WhatsApp, Outro) autoriza. "Outro" exige o detalhe. A data não pode ser futura e aceita `DD/MM/AAAA` e `AAAA-MM-DD`. Data vazia: hoje, quando a autorização é nova ou a origem muda; em pessoa já autorizada com a mesma origem, a data vazia mantém a que está.
  - **Sim sem origem válida** *(decisão minha)*: a linha continua válida, mas a autorização **não é aplicada**, com o aviso "Autorização ignorada: falta a origem." Pessoa nova fica "Não autorizado".
  - "Cadastro anterior" não é origem aceita para autorizar. Linha com Sim e "Cadastro anterior" igual ao que a pessoa já tem não muda nada e não mostra aviso.
  - "Hoje", para a data de autorização vazia, é o dia da **gravação**.
  - **Não** em pessoa já autorizada *(decisão minha)*: ignorado, com o aviso "A planilha não retira autorização; faça na ficha da pessoa."
  - Altera a autorização pela planilha quem pode alterá-la na ficha (`canEditContactAuthorization`, Etapa 1): pessoa com login, só o ADMIN; pessoa sem login, quem pode editar a pessoa. Quando o ator não pode, as colunas de autorização daquela linha são ignoradas com o aviso "Você não pode alterar a autorização desta pessoa."
- **Quem não é ADMIN** (se o ADMIN liberar a chave) *(decisão minha: as mesmas travas da tela do setor)*:
  - precisa também de `pessoas.editar`; sem ela, as rotas de envio e de confirmação respondem 403;
  - o setor é obrigatório e precisa estar no alcance;
  - pessoa existente precisa estar hoje num setor do alcance e **não ter login**; senão, "Você não pode alterar esta pessoa.";
  - sem `telefone.ver_completo`: a pessoa só é identificada pela **matrícula** (identificar pelo telefone diria de quem é um número) e o telefone já gravado não é alterado ("Você não pode alterar o telefone desta pessoa."); telefone de pessoa nova é aceito;
  - as travas são conferidas na prévia e de novo na gravação, com as permissões daquele momento.
- **ADMIN** pode atualizar pessoa com login (nome, telefone, função, vínculo), como na tela de Usuários. Perfil e acesso nunca mudam pela planilha.

#### E5. Prévia

- Cada linha recebe uma classificação: **Criar**, **Atualizar**, **Sem alteração**, **Inválida**, **Duplicada**, **Conflito**, **Ignorada** (linha de exemplo ou em branco).
- A prévia mostra: número da linha no arquivo, classificação, nome, matrícula, setor, e — em "Atualizar" — o que muda, campo a campo (antes → depois; telefone conforme a permissão de ver telefone). Motivos e avisos por extenso.
- Contadores por classificação no topo; filtro por classificação; paginada (50 por página).
- **Avisos na linha:** pessoa nova sem autorização mostra "Esta pessoa não receberá mensagens até ter a autorização registrada."; troca de setor de pessoa com login mostra "Esta pessoa terá de entrar de novo no sistema."
- **Escolha do conjunto:** "Criar pessoas novas (n)" e "Atualizar pessoas existentes (n)", os dois marcados por padrão; e uma caixa por linha para tirar linhas individuais. Linhas inválidas, duplicadas, em conflito, sem alteração e ignoradas não têm caixa.
- Botão "Confirmar importação" mostra a contagem final ("Criar 12 e atualizar 30 pessoas") e pede confirmação.
- O lote em prévia pode ser descartado. Lotes em prévia com mais de 7 dias são apagados quando alguém envia um arquivo novo.

#### E6. Gravação

- Só as linhas confirmadas são gravadas, **uma a uma**, pelo mesmo caminho do cadastro manual: criar pessoa sem acesso, ou atualizar a pessoa. Cada uma gera a entrada normal na trilha da pessoa e, se mudou setor, turno ou nível, a linha de vínculo com início hoje.
- Motivo gravado em cada criação e alteração: "Importação de planilha: <arquivo>", cortado em 200 caracteres (limite do campo). A criação de pessoa sem acesso passa a aceitar o motivo (hoje grava vazio); o padrão das outras portas não muda.
- Cada linha é conferida de novo na hora de gravar, nesta ordem: identificar a pessoa de novo → se os valores atuais já são os da linha, registrar como "Sem alteração", sem falha (vale para linha de criação cuja pessoa já existe com os valores da linha) → só então conferir a data da última alteração e os conflitos. A prévia guarda a data da última alteração da pessoa; se for outra na gravação, a linha falha com "A pessoa foi alterada depois da prévia". Matrícula ou telefone que passou a ser de outra pessoa falha com o motivo do conflito. Linha que falha não impede as outras: não é tudo ou nada *(decisão minha)*.
- A gravação nunca aplica mais do que a prévia mostrou: o que a prévia ignorou (por exemplo, colunas de autorização que o ator não podia alterar) continua ignorado, mesmo que o ator tenha ganhado permissão depois.
- **A gravação acontece na API, em blocos pedidos pela tela** *(decisão minha)*: a tela pede um bloco, a API grava linhas por até 10 segundos (no máximo 50) e devolve o andamento ("Gravando 120 de 300"); a tela pede o próximo até acabar. Não usa a fila do worker, que não carrega o módulo de usuários. Cada gravação roda com o usuário e as permissões de **quem confirmou**, conferidas a cada bloco.
- **Só quem confirmou continua a gravação.** Se a página for fechada no meio, o lote fica "Gravação interrompida" e quem confirmou continua pelo botão "Continuar gravação". O ADMIN pode "Encerrar gravação" de qualquer lote: as linhas pendentes viram "Não gravada: gravação encerrada" e entram no relatório. Lote interrompido há mais de 7 dias é encerrado do mesmo jeito quando alguém envia um arquivo novo. Em lote encerrado, linha com reserva vencida também vira "Não gravada: gravação encerrada". O encerramento grava `people_import.completed` com as contagens, e o autor do registro é quem encerrou. Pedido de bloco de quem não confirmou o lote responde 403, inclusive para o ADMIN, que só pode encerrar.
- **Tempo e erros do pedido de bloco:** a tela espera até 120 segundos por bloco. Tempo esgotado ou erro de rede não marca falha: a tela consulta o andamento e pede de novo; linha reservada aparece como "Gravando". Se o ator perdeu `pessoas.importar` ou `pessoas.editar`, o bloco responde 403 e o lote fica "Gravação interrompida", com o aviso de permissão.
- **Reserva da linha:** só um pedido passa a linha de pendente para reservada (operação atômica), e cada pedido reserva uma linha por vez. O resultado só é gravado por quem detém a reserva. A reserva vence em 5 minutos, mais que o tempo máximo de um pedido; linha com reserva vencida volta a ficar pendente e, pela ordem de conferência acima, repetir uma que já tinha entrado dá "Sem alteração".
- Um lote só pode ser confirmado uma vez. Dois cliques, ou duas abas, não gravam duas vezes.
- **Reimportar** a mesma planilha: as linhas que entraram ficam "Sem alteração" e as que não entraram repetem a classificação; ninguém é criado em dobro.

#### E7. Relatório de erros e registro

- **Relatório** (`GET /internal/people-import/batches/:id/errors.csv`): uma linha por linha do arquivo que não entrou (inválida, duplicada, conflito, falha na gravação, não gravada por encerramento), com `linha`, as colunas **mapeadas** (com o cabeçalho original do arquivo) e `motivo`. Mesmo formato de CSV. O telefone sai como veio no arquivo, porque é o próprio arquivo de quem enviou. Baixar exige `pessoas.importar` e ser quem enviou o lote ou ADMIN.
- **Registro do lote:** arquivo, tamanho, SHA-256, autor e hora do envio, quem confirmou e quando, hora do fim, contagens (linhas, criadas, atualizadas, sem alteração, inválidas, duplicadas, conflitos, falhas).
- **Trilha:** `people_import.confirmed` e `people_import.completed`, categoria Planilhas, com o arquivo e as contagens.
- **Quem vê os lotes:** o ADMIN vê todos; os demais veem só os seus (prévia, andamento, relatório e descarte seguem a mesma regra; lote de outra pessoa responde 404).

#### E8. Tela

- Rota "Importar pessoas" no menu Administração, para quem tem `pessoas.importar`; botão "Importar planilha" no cabeçalho de Usuários.
- Os quatro passos de E1. Textos de erro e de aviso por extenso, em pt-BR.
- **Novidades:** uma entrada explicando a importação.

## Para a GBR confirmar

- **Permissões (conselho R2):** exportar e importar ficam só com o ADMIN até ele liberar na tela de Permissões.
- **Colunas** da planilha de pessoas (as onze do modelo) e os nomes dos cabeçalhos.
- **Identificação:** matrícula primeiro, telefone depois; pessoa achada pelo telefone e sem matrícula recebe a matrícula da planilha.
- **Autorização:** "Sim" sem origem não autoriza; a planilha não retira autorização; altera autorização pela planilha quem pode alterá-la na ficha.
- **A planilha não inativa nem reativa** pessoas, não cria login e não apaga valores (célula vazia não altera).
- **Gravação parcial:** linha que falha não impede as outras; o relatório lista as que não entraram.
- **Limites:** 5.000 linhas e 5 MB por planilha; 50.000 linhas por exportação; escala de um setor por arquivo, até 42 dias.
- **Data de referência** na exportação de pessoas muda só o vínculo; situação e telefone são os atuais.
- **Formato do CSV:** ponto e vírgula, UTF-8 com BOM, telefone no formato nacional.
- **Quem não é ADMIN,** se receber a permissão de importar, precisa também da de editar pessoas, só mexe em pessoas sem login dos setores que alcança, e o setor é obrigatório; sem ver telefone completo, identifica só por matrícula e não troca telefone já gravado.
- **Gravação em blocos pela tela:** se a página for fechada no meio, o lote fica interrompido; só quem confirmou continua, e o ADMIN pode encerrar.
- **Pessoa inativa** não é alterada pela planilha.
- **Exportação de data passada:** quem hoje está fora do alcance sai com telefone mascarado; quem foi cadastrado depois da data não entra.
- **O que fica guardado do lote:** colunas não usadas e linhas desmarcadas são apagadas ao confirmar ou descartar; cada linha que entra é apagada ao ser gravada; das que não entraram ficam só as colunas usadas e o motivo.
- **Relatório de erros** traz o telefone como veio no arquivo e só as colunas usadas.

Decisões tomadas na implementação do Lote D (exportar), todas *(decisão minha)*:

- **Quem exporta é decidido só pela tela de Permissões:** o ADMIN sempre pode; o Leitor nunca; Supervisor e Operador só se o ADMIN liberar "Exportar pessoas e escala".
- **Setor fora do alcance e setor inexistente dão a mesma recusa** para quem não é ADMIN (assim a recusa não revela que setores existem); para o ADMIN, setor inexistente aparece como "setor não encontrado".
- **Formato padrão do diálogo é XLSX** (abre direto no Excel e traz a aba Instruções); o CSV continua à escolha.
- **Proteção contra fórmula (apóstrofo):** vale também para texto que já começa por apóstrofo, para que exportar e reimportar devolva exatamente o mesmo texto; só se aplica ao CSV, porque no XLSX a célula já sai como texto.
- **Nome que é um e-mail sai vazio na escala exportada** (na tela da escala, quem não tem nome cadastrado aparece pelo e-mail; o arquivo não leva e-mail).
- **Limite de 20 exportações por minuto por pessoa** (contado à parte para pessoas e para escala); a 21ª no mesmo minuto é recusada e basta esperar. Motivo: cada exportação pode ler até 50.000 pessoas e o servidor atual é pequeno.
- **Trilha:** quando quem exporta não é ADMIN mas pode ver telefone completo (sai completo só para quem não tem login, e mascarado para quem tem), o registro mostra o telefone como "Completo em parte".

## Aceite

**Lote D**
1. (T03) Exportar pessoas filtradas por setor e turno, em CSV, e abrir no Excel: acentos certos, uma coluna por campo, só as pessoas do filtro.
2. O mesmo em XLSX, com a aba "Instruções".
3. Quem não tem `telefone.ver_completo` recebe o telefone mascarado; quem tem recebe completo, menos o de pessoa com login quando não é ADMIN.
4. Quem não é ADMIN, com a permissão liberada, exporta só os setores que alcança; setor fora do alcance responde 403.
5. Sem `pessoas.exportar`, a rota responde 403 e os botões não aparecem.
6. Data de referência no passado mostra o setor que a pessoa tinha naquele dia.
7. Exportar a escala de um setor e período traz os mesmos textos do quadro (turno, Folga, Férias, "Em <setor>").
8. Cada exportação aparece na Trilha, tipo Planilhas, com autor, data, filtros e quantidade.
9. Nome começando por `=` sai com apóstrofo no CSV e como texto no XLSX.
10. O arquivo de pessoas exportado pelo ADMIN, com data de referência hoje, enviado de volta na importação, dá "Sem alteração" em todas as linhas com matrícula ou telefone (inclusive pessoa inativa, pessoa com setor inativo e nome que começa por `=`). A aba "Instruções" avisa para não reimportar exportação de data passada.

**Lote E**
11. (T02) Planilha com uma linha válida, uma duplicada e uma inválida: a prévia mostra os três resultados com o motivo; só a confirmada entra; o relatório de erros traz as outras duas.
12. Modelo baixado em CSV e em XLSX; a linha de exemplo é ignorada.
13. Mapeamento: planilha com cabeçalhos diferentes (`celular`, `cargo`) é reconhecida; trocar o mapeamento refaz a prévia.
14. Atualizar por matrícula mostra antes e depois; depois de confirmar, a ficha, a trilha da pessoa e o histórico de vínculo refletem a mudança, com o motivo da importação.
15. "Sim" sem origem não autoriza e mostra o aviso; "Sim" com origem autoriza com a origem e a data.
16. Reimportar a mesma planilha não cria ninguém: as linhas que entraram ficam "Sem alteração" e as que não entraram repetem a classificação.
17. Matrícula de uma pessoa com telefone de outra fica como conflito e não entra.
18. Setor, turno ou nível que não existe, ou inativo, invalida a linha com o nome no motivo.
19. CSV salvo pelo Excel em Windows-1252 é lido com os acentos certos.
20. Linha que falha na gravação (dado mudou depois da prévia) não impede as outras e sai no relatório.
21. Confirmar duas vezes o mesmo lote não grava duas vezes.
22. Sem `pessoas.importar`, as rotas respondem 403 e a tela não aparece. Nenhuma rota dos dois controllers novos fica sem a chave. Com a matriz padrão, Supervisor e Operador não têm nenhuma das duas chaves.
23. O lote fica registrado com arquivo, autor, hora e contagens, e aparece na Trilha, tipo Planilhas.
24. Quem não é ADMIN (com as chaves liberadas) não altera pessoa com login nem de setor fora do alcance, não descobre de quem é um telefone pela prévia e não vê lote de outra pessoa.
25. Gravação interrompida no meio é continuada sem gravar duas vezes a mesma linha.
26. Depois de confirmar, as colunas não mapeadas do lote não estão mais no banco; depois de gravada, o conteúdo da linha também não.
27. Quem não é ADMIN recebe a mesma resposta ("Você não pode alterar esta pessoa.") para pessoa fora do alcance, esteja o palpite dos dados certo ou errado.
28. Arquivo exportado por quem não vê telefone completo, reimportado, não grava nome nem telefone mascarado.

## Fica com o construtor

- Nome e desenho das tabelas do lote de importação e das linhas (não reaproveitar `ImportBatch`/`ImportItem`, que são de contatos).
- Como a prévia é guardada e paginada; como a seleção de linhas é enviada na confirmação.
- Como a reserva da linha é implementada, respeitando as regras de E6.
- Onde ficam o leitor e o escritor de CSV e os textos das células da escala no backend.
- Layout exato dos passos (não há componente de passos pronto; usar os componentes de `components/ui`).
- Divisão em tasks e ordem.
