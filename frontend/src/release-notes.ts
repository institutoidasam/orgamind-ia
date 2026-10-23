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
