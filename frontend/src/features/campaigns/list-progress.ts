import type { CampaignSummary } from './schemas';

/**
 * O PROGRESSO DA CAMPANHA NA LISTA — sem uma consulta de audiência por linha.
 *
 * Tudo sai de dois lugares que a listagem JÁ traz: `totalRecipients` (que desde
 * a A.4 é o público elegível vivo, e não "o que sobrou no último tick") e as
 * contagens por status. Uma linha da lista não pode custar uma resolução de
 * filtro — com 40 campanhas isso seria 40 varreduras da base a cada abertura.
 */

const RECEBERAM = ['SENT', 'DELIVERED', 'READ'] as const;

function contarPorStatus(c: CampaignSummary, statuses: readonly string[]): number {
  return (c.statusCounts ?? []).reduce(
    (total, s) => (statuses.includes(s.status) ? total + s._count : total),
    0,
  );
}

export function contagemDaLinha(c: CampaignSummary): {
  sent: number;
  total: number;
  restam: number;
} {
  const sent = contarPorStatus(c, RECEBERAM);
  const total = c.totalRecipients ?? 0;
  return { sent, total, restam: Math.max(0, total - sent) };
}

/**
 * "500 / 13.400 · restam 12.900" — a frase que o operador pediu, literalmente.
 *
 * Fix round 1 (review) — linha LEGADA: `totalRecipients` zerado (ou ausente)
 * mas já com gente que recebeu. Acontece em campanhas de antes da A.4 (quando
 * `totalRecipients` ainda não era o público elegível vivo) que o backend
 * nunca recalculou. "500 / 0 · restam 0" leria como uma campanha vazia que já
 * terminou — quando na verdade ela despachou 500 mensagens de verdade. Nesse
 * caso a linha muda de forma: só o que se sabe com certeza (`sent`).
 */
export function textoDaLinha(c: CampaignSummary): string {
  const { sent, total, restam } = contagemDaLinha(c);
  if (total === 0 && sent > 0) {
    return `${sent.toLocaleString('pt-BR')} enviadas`;
  }
  return `${sent.toLocaleString('pt-BR')} / ${total.toLocaleString('pt-BR')} · restam ${restam.toLocaleString('pt-BR')}`;
}

/**
 * "25/08 09:00" no fuso da campanha — usado pelo rótulo de agendamento.
 *
 * Exportada (achado 3b, review final): o cabeçalho de progresso
 * (`campaign-progress-header.tsx`) reusa o MESMO formato para o aviso "esta
 * campanha está agendada para {data}" — a mesma frase de agendamento não pode
 * ter duas datas escritas de jeitos diferentes na mesma tela.
 */
export function formatarDataHora(valor: string | Date, timezone: string): string {
  const data = new Date(valor);
  if (Number.isNaN(data.getTime())) return '';
  const opcoesData: Intl.DateTimeFormatOptions = { day: '2-digit', month: '2-digit' };
  const opcoesHora: Intl.DateTimeFormatOptions = {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  };
  try {
    const dia = data.toLocaleDateString('pt-BR', { ...opcoesData, timeZone: timezone });
    const hora = data.toLocaleTimeString('pt-BR', { ...opcoesHora, timeZone: timezone });
    return `${dia} ${hora}`;
  } catch {
    // Fuso inválido gravado na campanha: melhor a hora local do que quebrar a tela.
    return `${data.toLocaleDateString('pt-BR', opcoesData)} ${data.toLocaleTimeString('pt-BR', opcoesHora)}`;
  }
}

/**
 * O rótulo de uma campanha QUEUED — ainda não começou a disparar.
 *
 * Fix round 1 (review, achado Importante) — sem este ramo, uma campanha
 * agendada para amanhã de manhã lia "Em andamento — próximo lote disponível"
 * na lista: nada tinha sido enviado, e não havia lote nenhum para o operador
 * acompanhar. `ONCE_AT` mostra a data e hora do disparo; `DAILY_AT`/`WEEKLY`/
 * `INTERVAL` (recorrentes) mostram só a hora da próxima rodada — a data muda
 * a cada execução, a hora não. Sem `nextRunAt` (ou `scheduleType` ausente/
 * `IMMEDIATE`, que não tem "próxima vez" nenhuma) não há informação de
 * agendamento — "Na fila" é o rótulo mais honesto que sobra.
 */
function textoAgendamento(c: CampaignSummary): string {
  if (!c.nextRunAt) return 'Na fila';
  const timezone = c.timezone ?? 'America/Manaus';
  if (c.scheduleType === 'ONCE_AT') {
    return `Agendada — ${formatarDataHora(c.nextRunAt, timezone)}`;
  }
  if (
    c.scheduleType === 'DAILY_AT' ||
    c.scheduleType === 'WEEKLY' ||
    c.scheduleType === 'INTERVAL'
  ) {
    const data = new Date(c.nextRunAt);
    const opcoesHora: Intl.DateTimeFormatOptions = {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    };
    // Minor 12 (review final) — simetria com `formatarDataHora` (o irmão do
    // ramo ONCE_AT acima): um fuso inválido gravado na campanha não pode
    // quebrar a linha inteira da lista, só perder a conversão de fuso.
    let hora = '';
    if (!Number.isNaN(data.getTime())) {
      try {
        hora = data.toLocaleTimeString('pt-BR', { ...opcoesHora, timeZone: timezone });
      } catch {
        hora = data.toLocaleTimeString('pt-BR', opcoesHora);
      }
    }
    return `Recorrente — próxima ${hora}`;
  }
  return 'Na fila';
}

/**
 * O status COMO O OPERADOR O ENTENDE — não o enum do banco.
 *
 * "Em curso" não diz se ele precisa fazer alguma coisa. Estas frases dizem:
 * só uma delas ("Aguardando canal") exige ação humana, e uma ("Aguardando
 * teto") existe para ele NÃO fazer nada — foi por não saber disso que ele
 * criou campanhas novas e caiu na armadilha do recorte.
 *
 * A ordem das perguntas importa: canal caído vence teto esgotado, porque o
 * primeiro não se resolve sozinho e o segundo sim. QUEUED (ainda não
 * despachou nada) vem logo depois do canal — antes das perguntas de "quanto
 * falta"/"quota de hoje", que só fazem sentido para uma campanha que já
 * começou a enviar.
 */
export function statusDoOperador(args: {
  campaign: CampaignSummary;
  /** `quotaRestante(canal)` do canal da campanha. `undefined` = desconhecida. */
  quotaRestante?: number;
  /** Hora do próximo reset no fuso da campanha, de `horaDoReset`. */
  reset?: string | null;
}): string {
  const c = args.campaign;
  if (c.status === 'CANCELLED') return 'Cancelada';
  if (c.status === 'COMPLETED') return 'Concluída';
  if (c.status === 'FAILED') return 'Falhou';
  if (c.status === 'DRAFT') {
    // Achado 3(a) (Importante, review final) — `create()` deixa a linha em
    // DRAFT; `QUEUED` só existe pelos microssegundos entre o tick pegar o
    // agendamento e enfileirar de verdade. Uma campanha agendada (A.3 —
    // "Continuar automaticamente", ou um ONCE_AT futuro) passa a MAIOR PARTE
    // da vida em DRAFT com `nextRunAt`+`scheduleEnabled` já gravados — sem
    // este check, o ramo `Agendada — …`/`Recorrente — …` de
    // `textoAgendamento` (abaixo, no ramo QUEUED) era INALCANÇÁVEL na
    // prática, e a lista mentia "Rascunho — nada foi enviado ainda" para uma
    // campanha que VAI disparar sozinha.
    if (c.nextRunAt && c.scheduleEnabled) return textoAgendamento(c);
    return 'Rascunho — nada foi enviado ainda';
  }

  if (contarPorStatus(c, ['WAITING_INSTANCE']) > 0) return 'Aguardando canal';

  if (c.status === 'QUEUED') return textoAgendamento(c);

  const { restam } = contagemDaLinha(c);
  if (restam === 0) return 'Todo mundo já recebeu';

  if (args.quotaRestante === 0) {
    return args.reset
      ? `Aguardando teto (reinicia ${args.reset})`
      : 'Aguardando teto do canal';
  }
  return 'Em andamento — próximo lote disponível';
}
