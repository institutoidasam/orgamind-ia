/**
 * "Novidades" — histórico de melhorias visíveis ao operador, em PT-BR.
 *
 * Alimenta o badge "Novo", o diálogo "Novidades" e o rodapé de versão (ver
 * `frontend/src/lib/use-release-notes.ts`,
 * `frontend/src/components/layout/release-notes-dialog.tsx` e
 * `frontend/src/components/layout/footer.tsx`). Não depende de rede — o
 * build já carrega esta lista.
 *
 * Toda mudança visível ao operador entra aqui (ver `frontend/CLAUDE.md`).
 * `RELEASE_NOTES` fica em ordem DECRESCENTE por `version` — a entrada nova
 * sempre no topo do array.
 */

/** Um item de novidade. `where`, quando presente, é uma rota interna (ex.: '/contacts'). */
export type ReleaseNoteItem = {
  text: string;
  where?: string;
};

/**
 * `version` no formato 'YYYY.MM.DD' ou 'YYYY.MM.DD.n' (o `.n` desempata mais
 * de uma entrada no mesmo dia). `date` é 'YYYY-MM-DD'.
 */
export type ReleaseNote = {
  version: string;
  date: string;
  title: string;
  items: ReleaseNoteItem[];
};

export const RELEASE_NOTES: readonly ReleaseNote[] = [
  {
    version: '2026.11.21.5',
    date: '2026-11-21',
    title: 'Mídia ilegível e avisos na passagem de pendências',
    items: [
      {
        text: 'Se o robô não conseguir ler uma mídia enviada pelo contato, ele pausa e a conversa passa para a equipe.',
      },
      {
        text: 'Ao passar pendências, a tela avisa quando você não tem permissão para isso e quando a lista pode estar incompleta, para você conferir se alguma ficou com a pessoa.',
        where: '/pendencias-equipe',
      },
    ],
  },
  {
    version: '2026.11.21.4',
    date: '2026-11-21',
    title: 'Passagem de turno',
    items: [
      {
        text: 'Passar meu turno: na caixa, passe suas conversas abertas a outra pessoa, com uma observação. Quem recebe encontra-as no filtro "Recebidas na passagem de turno".',
        where: '/inbox',
      },
      {
        text: 'Passar minhas pendências: na tela de pendências da equipe, passe suas pendências a outra pessoa, com uma observação.',
        where: '/pendencias-equipe',
      },
      {
        text: 'Cada mensagem enviada à equipe mostra uma etiqueta, e o topo da conversa mostra o último envio à equipe.',
        where: '/inbox',
      },
    ],
  },
  {
    version: '2026.11.21.3',
    date: '2026-11-21',
    title: 'Pendências da equipe',
    items: [
      {
        text: 'Nova tela de pendências da equipe: cada pendência mostra o responsável, o prazo de 60 minutos, as anotações e o encerramento.',
        where: '/pendencias-equipe',
      },
      {
        text: 'O menu de pendências mostra o número de pendências sem responsável com o prazo de ciência vencido.',
        where: '/pendencias-equipe',
      },
      {
        text: 'No resultado do alerta, a pessoa cuja tratativa foi encerrada mostra quem encerrou e o motivo, sem mudar de grupo.',
      },
    ],
  },
  {
    version: '2026.11.21.2',
    date: '2026-11-21',
    title: 'Caixa: situação da conversa e um atendente por vez',
    items: [
      {
        text: 'Cada conversa mostra a situação: Pendente, Em atendimento ou Resolvida. A lista abre com as abertas (pendentes e em atendimento); o seletor "Abertas/Resolvidas" mostra as resolvidas.',
        where: '/inbox',
      },
      {
        text: 'Resolver encerra a conversa e Reabrir a traz de volta. Uma conversa resolvida volta sozinha às abertas quando a pessoa escreve de novo.',
        where: '/inbox',
      },
      {
        text: 'Só quem está atendendo responde. Conversas já atribuídas passam a exigir "Assumir conversa" de quem não é o atendente, inclusive do administrador. Responder numa conversa sem atendente já assume a conversa.',
        where: '/inbox',
      },
      {
        text: 'Transferir passa a conversa a outro atendente ativo, e a lista traz só quem pode recebê-la. Remover atendente devolve a conversa para Pendente.',
        where: '/inbox',
      },
      {
        text: 'Histórico da conversa mostra quem resolveu, assumiu, transferiu ou reabriu, com a data e a observação, quando houver.',
        where: '/inbox',
      },
    ],
  },
  {
    version: '2026.11.21.1',
    date: '2026-11-21',
    title: 'Panorama da fábrica e cuidados ao inativar setor e nível',
    items: [
      {
        text: 'Na Visão geral há o bloco "Operação da fábrica": um cartão por setor com as contagens do dia escolhido por turno, folga, férias e sem escala. Os números são da escala do dia, não de agora. Os nomes só aparecem quando você clica em "Ver pessoas", e "Ver escala" e "Enviar mensagem" abrem a escala e o envio já com o setor e a data. Supervisor e Operador veem só os setores que gerem.',
        where: '/dashboard',
      },
      {
        text: 'Um setor com pessoas ativas, exceções de escala de hoje em diante ou envios agendados não é mais inativado: a tela mostra o que prende o setor e o que fazer para liberar. Setor sem uso pede confirmação antes de ser inativado.',
        where: '/setores',
      },
      {
        text: 'Um nível com pessoas ativas não é mais desativado: a tela mostra quantas são e manda trocar o nível no cadastro delas. Nível sem uso pede confirmação antes de ser desativado.',
        where: '/niveis',
      },
      {
        text: 'A trilha de alterações de turno e de nível mostra o antes e depois, inclusive a ordem (Início, Término, Nome, Situação e Ordem).',
        where: '/trilha',
      },
      {
        text: 'Reativar uma pessoa que está em setor ou nível inativo é recusado, com o aviso para reativar o setor ou o nível, ou trocar o dela, antes.',
        where: '/users',
      },
    ],
  },
  {
    version: '2026.11.20.3',
    date: '2026-11-20',
    title: 'WhatsApp da equipe: alerta urgente com confirmação "OK"',
    items: [
      {
        text: 'A finalidade Urgência agora é um alerta com confirmação: no fim de todo alerta vai a linha "Responda OK para confirmar que recebeu." e a pessoa confirma respondendo OK no WhatsApp. Na tela de envio a linha aparece embaixo da caixa de texto, sem edição, e conta nos 2000 caracteres (o seu texto vai até 1959). Na revisão aparece o prazo de ciência: 15 minutos, contados da confirmação do envio.',
        where: '/whatsapp-equipe',
      },
      {
        text: 'No resultado do alerta, o painel de pendências mostra quem já confirmou e quem ainda não, com o prazo. Passado o prazo só mudam o rótulo e a ordem: nenhuma mensagem sai sozinha.',
        where: '/whatsapp-equipe',
      },
      {
        text: 'Dá para mandar um lembrete só às pessoas pendentes (no máximo 3 por alerta, com 5 minutos de intervalo) e registrar a ciência manual de quem avisou por outro meio, com a opção de desfazer.',
        where: '/whatsapp-equipe',
      },
      {
        text: 'Nova permissão "Criar alerta urgente". Até o administrador ligar "Criar alerta urgente" para outros papéis, só ele cria alerta: Supervisor e Operador deixam de ver a finalidade Urgência nesta atualização, e quem tem "Enviar WhatsApp à equipe" continua usando as outras finalidades.',
        where: '/whatsapp-equipe',
      },
    ],
  },
  {
    version: '2026.11.20.2',
    date: '2026-11-20',
    title: 'WhatsApp da equipe: resultado do envio com hora, conexão e repetições',
    items: [
      {
        text: 'No resultado do envio, cada pessoa mostra a hora em que a situação aconteceu, na coluna "Quando" (dia/mês e hora, no horário de Manaus). Onde não há hora (Na fila, Falhou, Situação incerta, Pulado, Agendado e Cancelado), aparece "—".',
        where: '/whatsapp-equipe',
      },
      {
        text: 'Embaixo do número, o resultado mostra a hora em que a conexão foi conferida antes de mandar ("conexão conferida às HH:mm:ss"). Envios antigos mostram só o número.',
        where: '/whatsapp-equipe',
      },
      {
        text: 'A coluna "Tentativas" também diz quantas vezes a pessoa foi repetida pelo botão "Repetir", por exemplo "2 · repetido 1×".',
        where: '/whatsapp-equipe',
      },
      {
        text: 'Quem fica "Na fila" sem envio em andamento passa sozinho, entre 30 e 35 minutos depois, para "Falhou" (por exemplo "Saiu da fila sem envio"; na maioria dos casos dá para usar o "Repetir"), "Aceito pelo WhatsApp" (se a mensagem saiu) ou "Situação incerta" (se ela pode ter saído). Envio grande que ainda está saindo aos poucos continua "Na fila". O sistema nunca reenvia sozinho.',
        where: '/whatsapp-equipe',
      },
      {
        text: 'A mensagem que não saiu porque a pessoa foi pulada deixa de aparecer "na fila" no chat.',
        where: '/whatsapp-equipe',
      },
    ],
  },
  {
    version: '2026.11.20.1',
    date: '2026-11-20',
    title: 'WhatsApp da equipe: agendamento, histórico e envio conferido',
    items: [
      {
        text: 'Agora você pode agendar o envio para uma data e hora (até 30 dias à frente). Agendamento não vale para Urgência, e a mensagem da atividade sai antes do início dela.',
        where: '/whatsapp-equipe',
      },
      {
        text: 'O botão "Preencher com os dados da atividade" copia os dados da atividade para a mensagem. Se os dados da atividade mudarem depois, um aviso aparece para você conferir.',
        where: '/whatsapp-equipe',
      },
      {
        text: 'O texto que você digitou não se perde se você fechar a janela de envio.',
        where: '/whatsapp-equipe',
      },
      {
        text: 'Envios agendados saem para a lista que você conferiu. No momento do disparo, quem entrou de férias, de folga, saiu do setor ou do turno, ou foi desativado é pulado, e ninguém é acrescentado. Quando o envio era para todos os aptos, quem passou a se enquadrar depois aparece no histórico do envio, sem receber. Quem você incluiu pela opção "Incluir quem está de folga" continua recebendo, mesmo que a folga seja lançada depois. Envios agendados antes desta versão seguem a regra anterior: saem para a lista da criação.',
        where: '/whatsapp-equipe',
      },
      {
        text: 'Um envio agendado que não saiu até 2 horas depois da hora marcada não é mais enviado e aparece como "Não enviado: passou da hora".',
        where: '/whatsapp-equipe',
      },
      {
        text: 'Se a pessoa trocou de telefone depois que o envio foi criado, a mensagem não sai para ela: nem para o número antigo, nem para o novo. Ela aparece como pulada, com "Telefone mudou depois da criação do envio", e o botão "Repetir" também não reenvia.',
        where: '/whatsapp-equipe',
      },
      {
        text: 'O histórico ganhou filtros por período, finalidade e situação. No detalhe do envio você busca por nome, e a lista mostra a data de referência de cada envio.',
        where: '/whatsapp-equipe',
      },
    ],
  },
  {
    version: '2026.11.20',
    date: '2026-11-20',
    title: 'WhatsApp da equipe com finalidade e prévia do público',
    items: [
      {
        text: 'Ao enviar para um setor, escolha primeiro a finalidade: Aviso de turno, Reunião, Alinhamento, Palestra, Hora extra ou Urgência. Cada uma pede os dados certos (data, hora e local da atividade, motivo da urgência) e já define quem entra no público.',
        where: '/whatsapp-equipe',
      },
      {
        text: 'A prévia mostra quem vai receber e quem fica de fora, agrupado por motivo, e o painel da regra explica o público antes de você confirmar. O que impede o envio aparece por extenso perto do botão.',
        where: '/whatsapp-equipe',
      },
      {
        text: 'A opção "Incluir quem está de folga" não inclui mais quem está de férias. Férias nunca recebem.',
      },
      {
        text: 'No histórico, cada envio mostra a finalidade, a base e os dados da atividade; ao abrir o resultado, você vê o painel da regra e quem ficou de fora, por motivo. Envios feitos antes aparecem como equipe em serviço (regra anterior).',
        where: '/whatsapp-equipe',
      },
      {
        text: 'Se a tela de WhatsApp da equipe já estava aberta antes da atualização, recarregue a página antes de enviar.',
      },
    ],
  },
  {
    version: '2026.11.19.4',
    date: '2026-11-19',
    title: 'Importar pessoas por planilha',
    items: [
      {
        text: 'Em Administração > Importar pessoas, baixe o modelo, envie a planilha (CSV ou XLSX, até 5.000 linhas) e confira as colunas.',
        where: '/importar-pessoas',
      },
      {
        text: 'A prévia mostra o que cada linha vai fazer (criar, atualizar, sem alteração ou por que não entra) e você escolhe o que gravar. Nada é gravado antes de confirmar.',
      },
      {
        text: 'As linhas que não entraram saem num relatório para baixar. Cada importação fica registrada na Trilha de alterações, no tipo Planilhas; o administrador libera a importação para Supervisor e Operador em Permissões.',
      },
    ],
  },
  {
    version: '2026.11.19.3',
    date: '2026-11-19',
    title: 'Exportar pessoas e escala',
    items: [
      {
        text: 'Em Usuários e na página de cada setor, o botão Exportar baixa a lista de pessoas em CSV ou XLSX, filtrada por setor, turno, situação e data de referência.',
        where: '/users',
      },
      {
        text: 'Na Escala, o botão Exportar baixa o quadro do setor e do período na tela.',
        where: '/escala',
      },
      {
        text: 'Quem não pode ver o telefone completo recebe o telefone mascarado, e toda exportação fica registrada na Trilha de alterações, no tipo Planilhas. O administrador libera a exportação para Supervisor e Operador em Permissões.',
      },
    ],
  },
  {
    version: '2026.11.19.2',
    date: '2026-11-19',
    title: 'Histórico de vínculos',
    items: [
      {
        text: 'Trocar o setor, o turno ou o nível de alguém não muda mais o passado: a escala de dias anteriores e os envios antigos continuam mostrando onde a pessoa estava. A troca vale a partir de hoje, e o histórico de cada pessoa aparece em Histórico, na seção Vínculos.',
      },
      {
        text: 'No WhatsApp da equipe, a lista de uma data que já passou mostra quem estava no setor naquele dia. Isso inclui o atalho do turno da noite em andamento, que usa a data de ontem.',
      },
    ],
  },
  {
    version: '2026.11.19.1',
    date: '2026-11-19',
    title: 'Permissões por ação',
    items: [
      {
        text: 'O administrador agora define, em Configurações → Permissões, o que Supervisor e Operador podem fazer: cadastrar pessoas, inativar, alterar a escala, manter setores, ver o telefone completo, enviar WhatsApp à equipe, enviar a todos os setores de uma vez e consultar o histórico das pessoas.',
        where: '/configuracoes',
      },
      {
        text: 'Nada mudou para quem já usava o sistema: cada um continua podendo fazer o mesmo que antes.',
      },
    ],
  },
  {
    version: '2026.11.19',
    date: '2026-11-19',
    title: 'Ficha da pessoa e trilha de alterações',
    items: [
      {
        text: 'Cada pessoa pode ter matrícula. A busca da lista de usuários e da página do setor também acha pela matrícula.',
        where: '/users',
      },
      {
        text: 'Ao cadastrar alguém, informe a autorização de contato: termo assinado, ficha de admissão, aceite pelo WhatsApp ou outro. Quem fica sem autorização não recebe mensagens da equipe. Quem já estava cadastrado aparece como "Cadastro anterior — origem não verificada" e continua recebendo.',
        where: '/users',
      },
      {
        text: 'No lugar de excluir, use Inativar. A pessoa deixa de receber mensagens e de entrar no sistema, e o histórico fica guardado. Reativar devolve tudo.',
        where: '/users',
      },
      {
        text: 'Toda alteração no cadastro pede o motivo.',
      },
      {
        text: 'A nova tela Trilha de alterações mostra quem mudou o quê, quando, o antes e o depois, e o motivo. Na lista, a ação Histórico mostra as alterações de uma pessoa.',
        where: '/trilha',
      },
    ],
  },
  {
    version: '2026.11.11',
    date: '2026-11-11',
    title: 'WhatsApp só pela Evolution',
    items: [
      {
        text: 'O WhatsApp agora funciona só pela Evolution. Números de outras integrações aparecem em Conexões como desligados; ligue as áreas a um número Evolution.',
        where: '/connect',
      },
    ],
  },
  {
    version: '2026.11.10',
    date: '2026-11-10',
    title: 'Número próprio por área e envio mais rastreável no WhatsApp da equipe',
    items: [
      {
        text: 'Cada área tem o próprio número de WhatsApp. Escolha o número de cada área em Conexões. Área sem número fica bloqueada e marcada, até você escolher um.',
        where: '/connect',
      },
      {
        text: 'No envio, o sistema escolhe o número da área sozinho e confere se ele está conectado antes de mandar.',
        where: '/whatsapp-equipe',
      },
      {
        text: 'Na tela de resultado, cada mensagem mostra a situação: "Aceito pelo WhatsApp", "Entregue", "Lido" ou "Respondeu". Nas falhas, use "Repetir" para tentar de novo.',
        where: '/whatsapp-equipe',
      },
      {
        text: 'Um mesmo envio pode ter vários turnos. O histórico agora é paginado, para navegar pelos envios antigos.',
        where: '/whatsapp-equipe',
      },
    ],
  },
  {
    version: '2026.10.23',
    date: '2026-10-23',
    title: 'Aviso de plano cheio ao criar conexão GoZap',
    items: [
      {
        text: 'Ao criar uma "Nova conexão GoZap" com o plano já cheio, o sistema avisa antes de criar e mostra qual conexão está ocupando a vaga. Para liberar, remova uma conexão que não é mais usada ou aumente o plano do GoZap.',
        where: '/connect',
      },
    ],
  },
  {
    version: '2026.10.22',
    date: '2026-10-22',
    title: 'Pessoas no setor, níveis e envio para vários setores',
    items: [
      {
        text: 'Na página do setor, use "Adicionar pessoas" para incluir uma pessoa nova, vários contatos de uma vez ou alguém já cadastrado. Quem só recebe WhatsApp entra "Sem acesso", sem e-mail e sem senha.',
        where: '/setores',
      },
      {
        text: 'Cada pessoa pode ter um nível: Coordenador, Líder, Funcionário ou Operador. A lista de níveis pode ser editada.',
        where: '/niveis',
      },
      {
        text: 'No WhatsApp da equipe, escolha um ou mais setores e o nível. Para mandar só para os coordenadores, marque os setores e o nível Coordenador.',
        where: '/whatsapp-equipe',
      },
      {
        text: 'Em Usuários, quem não entra no sistema aparece como "Sem acesso" e pode receber acesso depois.',
        where: '/users',
      },
    ],
  },
  {
    version: '2026.10.21.1',
    date: '2026-10-21',
    title: 'Escala da equipe, turnos com horário e envio agendado',
    items: [
      {
        text: 'Cadastre os turnos com nome e horário. Confira os horários de "1º turno" (06:00–14:00) e "2º turno" (14:00–22:00), que vieram do cadastro anterior.',
        where: '/turnos',
      },
      {
        text: 'Monte a escala de cada pessoa com os modelos Semanal, Rodízio semanal ou 12x36 e marque folga, férias, troca de turno ou outro setor.',
        where: '/escala',
      },
      {
        text: 'No WhatsApp da equipe, escolha a data e veja quem está escalado, de folga e sem telefone. Agende o envio para o início do turno e cancele se precisar.',
        where: '/whatsapp-equipe',
      },
      { text: 'Usuários ganham o campo Função.', where: '/users' },
    ],
  },
  {
    version: '2026.10.21',
    date: '2026-10-21',
    title: 'Turnos no WhatsApp da equipe',
    items: [
      {
        text: 'O cadastro de usuário ganhou o campo Turno (1º turno, 2º turno ou sem turno), e a lista de usuários mostra o turno de cada pessoa.',
        where: '/users',
      },
      {
        text: 'No WhatsApp da equipe, escolha o setor e o turno, marque as pessoas e envie para todos do turno ou só para as selecionadas. Antes de enviar, você confere os nomes de quem vai receber e de quem fica de fora por não ter telefone.',
        where: '/whatsapp-equipe',
      },
      {
        text: 'Em Envios recentes, "Ver destinatários" mostra todos que estavam no envio, com o turno e a situação de cada um.',
        where: '/whatsapp-equipe',
      },
    ],
  },
  {
    version: '2026.10.19',
    date: '2026-10-19',
    title: 'WhatsApp da equipe: canais mais claros e motivos dos envios',
    items: [
      {
        text: 'No "Enviar WhatsApp", os canais desconectados ou aguardando conexão aparecem desabilitados, com a situação de cada um. Havendo um só canal conectado, ele já vem escolhido.',
        where: '/whatsapp-equipe',
      },
      {
        text: 'Em "Envios recentes", o botão "Ver motivos" mostra quem falhou ou foi pulado e por quê.',
        where: '/whatsapp-equipe',
      },
      {
        text: '"Copiar senha" da senha temporária agora funciona também quando o navegador bloqueia a área de transferência: a senha fica selecionada para você copiar com Ctrl+C.',
        where: '/users',
      },
    ],
  },
  {
    version: '2026.10.16',
    date: '2026-10-16',
    title: 'Telefone no cadastro e WhatsApp para a equipe',
    items: [
      {
        text: '"Convidar usuário" agora se chama "Cadastrar usuário" e pede o telefone (WhatsApp) da pessoa. A lista de usuários mostra o telefone de cada um.',
        where: '/users',
      },
      {
        text: 'Nova tela "WhatsApp da equipe": o administrador e o gestor do setor mandam uma mensagem de WhatsApp para uma pessoa ou para o setor inteiro. As mensagens saem aos poucos, no ritmo do canal: para um setor grande pode levar alguns minutos. As respostas chegam no WhatsApp do número conectado.',
        where: '/whatsapp-equipe',
      },
      { text: 'O link "Ver" das Novidades só aparece quando você tem acesso à tela.' },
    ],
  },
  {
    version: '2026.10.10',
    date: '2026-10-10',
    title: 'Comunicação entre setores no OrgaMind',
    items: [
      {
        text: 'A Visão geral, a Caixa de entrada, as Demandas e os Comunicados agora acompanham a comunicação entre setores da GBR Componentes.',
        where: '/dashboard',
      },
      {
        text: 'Administradores podem organizar Setores, Usuários e Números e canais; os demais papéis veem somente as ações autorizadas.',
        where: '/setores',
      },
    ],
  },
  {
    version: '2026.10.08',
    date: '2026-10-08',
    title: 'Nova identidade visual do OrgaMind',
    items: [
      {
        text: 'A navegação, as telas de acesso, as campanhas e o Inbox receberam a nova identidade visual, com superfícies mais claras, azul-marinho e acentos laranja.',
      },
    ],
  },
  {
    version: '2026.08.25.2',
    date: '2026-08-25',
    title: 'Excluir quem já recebeu, canais e templates ficaram mais claros',
    items: [
      {
        text: 'No assistente de campanha, "Excluir quem já recebeu" agora tem a opção de valer para QUALQUER campanha anterior, não só para quem já recebeu o mesmo modelo de mensagem.',
        where: '/campaigns/new',
      },
      {
        text: 'A lista de canais mostra se cada número está Conectado, Conectando… ou Desconectado.',
        where: '/connect',
      },
      {
        text: 'Ao criar um template, o idioma virou uma lista (em vez de texto livre) e um aviso explica como {{1}}, {{2}} são preenchidas com o dado do contato.',
        where: '/templates',
      },
    ],
  },
  {
    version: '2026.08.25.1',
    date: '2026-08-25',
    title: 'Números inválidos: filtre, exporte e exclua',
    items: [
      {
        text: 'A lista de contatos ganhou o filtro "Validação": veja de uma vez quais números são válidos, quais são inválidos confirmados e quais ninguém checou ainda.',
        where: '/contacts',
      },
      {
        text: 'Quem já recebeu alguma mensagem entregue passa a contar como número válido — não aparece mais como "não validado".',
        where: '/contacts',
      },
      {
        text: '"Exportar planilha" baixa exatamente a lista que está na tela, com telefone, nome, cidade, grupo, tags, situação e motivo — pronta para devolver a quem passou os contatos.',
        where: '/contacts',
      },
      {
        text: 'Dá para apagar de uma vez todos os inválidos confirmados, digitando a contagem para confirmar. O aviso explica que isso apaga também o histórico de mensagens dessas pessoas.',
        where: '/contacts',
      },
      {
        text: 'No assistente de campanha, "Apenas números válidos" virou "Excluir inválidos confirmados" — antes, numa base sem validação, aquele filtro deixava a campanha sem ninguém.',
        where: '/campaigns/new',
      },
      {
        text: 'Validar números voltou a funcionar: agora usa o canal que estiver conectado, avisa do risco de bloqueio, roda devagar e mostra o progresso.',
        where: '/contacts',
      },
    ],
  },
  {
    version: '2026.08.25',
    date: '2026-08-25',
    title: 'Envio em lotes: você vê quantos faltam',
    items: [
      {
        text: 'Uma campanha agora é isso: uma mensagem para o público inteiro, enviada em lotes — não tudo de uma vez.',
        where: '/campaigns/new',
      },
      {
        text: '"Disparar" virou o 1º lote, do tamanho que o teto de hoje do canal permite. Para criar sem enviar nada ainda, use "Criar sem enviar".',
        where: '/campaigns/new',
      },
      {
        text: 'O cabeçalho da campanha mostra Público · Já receberam · Em fila · Restam — você vê quantos faltam sem abrir nada, e um botão: "Enviar próximo lote".',
        where: '/campaigns',
      },
      {
        text: '"Disparar de novo para TODOS" agora pede para digitar quantas pessoas receberiam a mensagem pela 2ª vez, antes de confirmar.',
        where: '/campaigns',
      },
      {
        text: 'Na lista, cada campanha mostra, por exemplo, "500 / 13.400 · restam 12.900" — e, quando ela parou, diz por quê.',
        where: '/campaigns',
      },
      {
        text: 'Saiu o campo "Limitar aos primeiros": era ele que fazia o disparo repetir sempre as mesmas pessoas mais antigas.',
        where: '/campaigns/new',
      },
    ],
  },
  {
    version: '2026.08.23',
    date: '2026-08-23',
    title: 'Ninguém recebe a mesma mensagem duas vezes',
    items: [
      {
        text: 'Uma trava no banco de dados impede que a mesma pessoa receba duas mensagens vivas da mesma campanha ao mesmo tempo — mesmo quando ela tem dois números de telefone cadastrados.',
      },
      {
        text: 'Contatos duplicados pelo 9º dígito do celular foram fundidos em um único cadastro.',
        where: '/contacts',
      },
      {
        text: '"Reenviar falhas" agora conta pessoas que ainda não receberam, não tentativas de envio.',
        where: '/campaigns',
      },
      {
        text: 'Respostas de quem recebeu mensagem pelo canal GoZap voltam a aparecer no Inbox.',
        where: '/inbox',
      },
    ],
  },
  {
    version: '2026.07.27',
    date: '2026-07-27',
    title: 'Você vê quem já recebeu',
    items: [
      {
        text: 'Nova coluna e filtro "Campanhas recebidas" na lista de contatos, mostrando quais campanhas cada pessoa já recebeu.',
        where: '/contacts',
      },
      {
        text: 'Aba "Falhas" na página da campanha, com o motivo de cada falha de envio.',
        where: '/campaigns',
      },
    ],
  },
  {
    version: '2026.07.24',
    date: '2026-07-24',
    title: 'Excluir quem já recebeu',
    items: [
      {
        text: 'No assistente de nova campanha, marque campanhas ou templates anteriores para não repetir o envio a quem já recebeu.',
        where: '/campaigns/new',
      },
      {
        text: 'O motivo de cada falha (sem WhatsApp, opt-out, telefone inválido…) agora fica gravado no cadastro do contato.',
        where: '/contacts',
      },
    ],
  },
  {
    version: '2026.07.23',
    date: '2026-07-23',
    title: 'Disparar não reenvia',
    items: [
      {
        text: 'Disparar de novo, agendar ou reenviar falhas nunca manda mensagem para quem já recebeu.',
        where: '/campaigns',
      },
      {
        text: 'Só "Disparar novamente para todos" repete o envio — de propósito, para quando você realmente quer alcançar todo mundo de novo.',
        where: '/campaigns',
      },
    ],
  },
];

/** A entrada mais nova — `RELEASE_NOTES` é mantido em ordem decrescente. */
export function latestRelease(): ReleaseNote {
  return RELEASE_NOTES[0];
}

/**
 * Dias corridos desde a versão mais nova (`now`, por padrão, é o momento
 * atual). Compara a meia-noite LOCAL dos dois lados (a versão mais nova e
 * `now`) e arredonda para o inteiro mais próximo — não para baixo — para não
 * sofrer artefato de fuso horário / horário de verão (um dia de virada pode
 * ter só 23h, o que faria um `Math.floor` de ms cru subtrair 1 dia do
 * resultado). Mesmo padrão de `formatRelativeToToday` em
 * `frontend/src/lib/format-date-ptbr.ts`.
 *
 * Alimenta o teste-lembrete acima: se ninguém atualizar `RELEASE_NOTES` por
 * muito tempo, a suíte de testes começa a falhar sozinha — é a guarda de
 * frescor que substitui um lembrete manual.
 */
export function daysSinceLatestRelease(now: Date = new Date()): number {
  const [year, month, day] = latestRelease().date.split('-').map(Number);
  const target = new Date(year, month - 1, day);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((today.getTime() - target.getTime()) / (24 * 60 * 60 * 1000));
}
