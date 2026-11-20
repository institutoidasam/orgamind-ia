import type {
  DispatchCounts,
  TeamAudienceBase,
  TeamAudienceRuleView,
  TeamDispatchState,
  TeamExclusionReason,
  TeamPurpose,
  TeamSchedulePolicy,
} from "./schemas";

/** Finalidade como o operador a vê (CF10). */
export const PURPOSE_LABEL: Record<TeamPurpose, string> = {
  shift_notice: "Aviso de turno",
  meeting: "Reunião",
  alignment: "Alinhamento",
  lecture: "Palestra",
  overtime: "Hora extra",
  urgency: "Urgência",
};

export const BASE_LABEL: Record<TeamAudienceBase, string> = {
  on_duty: "Equipe em serviço",
  assigned: "Equipe vinculada",
};

/** Envio anterior à finalidade (`base` nula): valia a escala do dia. */
export const LEGACY_BASE_LABEL = "equipe em serviço (regra anterior)";

/** Motivos de exclusão da prévia e do histórico (GF6). Marcado e excluído mantém o motivo próprio. */
export const EXCLUSION_LABEL: Record<TeamExclusionReason, string> = {
  not_selected: "Não selecionado",
  day_off: "Folga",
  vacation: "Férias",
  other_sector: "Em outro setor nesta data",
  other_shift: "Fora do turno nesta data",
  no_phone: "Sem telefone",
  not_authorized: "Contato não autorizado",
  suppressed: "Número bloqueado",
};

export const INCLUDE_OFF_LABEL = "Incluir quem está de folga";

/** 'YYYY-MM-DD' → 'DD/MM'. Reslice puro, sem `Date` (fuso). */
function dayMonth(date: string): string {
  const [, month, day] = date.split("-");
  return `${day}/${month}`;
}

/** Frase que explica a base e por que quem está de folga entra ou sai (aparece na prévia, na confirmação e no histórico). */
export function basePhrase(
  base: TeamAudienceBase,
  includeOff: boolean,
  date: string,
): string {
  const day = dayMonth(date);
  if (base === "on_duty") {
    return `Equipe em serviço: quem a escala de ${day} põe para trabalhar nos setores e turnos escolhidos. Quem está de folga ou de férias fica de fora.`;
  }
  const head = `Equipe vinculada: quem tem os setores e turnos escolhidos no cadastro em ${day}.`;
  return includeOff
    ? `${head} Quem está de folga entra porque a opção foi marcada; quem está de férias fica de fora.`
    : `${head} Quem está de folga fica de fora porque a opção não foi marcada; quem está de férias também.`;
}

const IMMEDIATE_LABEL = "Envio imediato";
const FROZEN_RECHECK_LABEL =
  "Lista conferida agora; no disparo, quem deixar de se enquadrar é pulado e ninguém é acrescentado";
const LEGACY_SCHEDULE_LABEL =
  "Regra anterior: sai para a lista da criação, sem reconferência";

/**
 * Como o disparo trata o público (G3): imediato; agendado com reconferência (`frozen_recheck`); agendado
 * criado antes do G (política nula): dispara pela regra anterior, sem reconferência.
 */
export function policyLabel(
  when: TeamAudienceRuleView["when"],
  policy: TeamSchedulePolicy | null,
): string {
  if (when === "now" || policy === "immediate") return IMMEDIATE_LABEL;
  return policy === "frozen_recheck"
    ? FROZEN_RECHECK_LABEL
    : LEGACY_SCHEDULE_LABEL;
}

/** Situação gravada do envio como o operador a lê (filtro "Situação" do histórico). */
export const DISPATCH_STATE_LABEL: Record<TeamDispatchState, string> = {
  DISPATCHED: "Enviado",
  SCHEDULED: "Agendado",
  CANCELLED: "Cancelado",
  EXPIRED: "Não enviado: passou da hora",
};

/** Tolerância do disparo: agendado vencido há mais que isso nunca sai (G5); o back usa o mesmo valor. */
export const SCHEDULE_GRACE_MS = 2 * 60 * 60 * 1000;

/** DG16: agendado para antes de `now` − 2 h nunca sai; exatamente 2 h ainda não está vencido. */
export function isLapsed(scheduledFor: string, now: Date): boolean {
  return Date.parse(scheduledFor) < now.getTime() - SCHEDULE_GRACE_MS;
}

const NOBODY_RECEIVED_LABEL = "Ninguém recebeu";

/** DG9: nada na fila nem a caminho nem entregue; só pulados, falhas certas ou cancelados. */
function nobodyReceived(counts: DispatchCounts): boolean {
  const { queued, scheduled, sent, delivered, read, replied, uncertain } =
    counts;
  return (
    queued + scheduled + sent + delivered + read + replied + uncertain === 0
  );
}

/**
 * Situação exibida do envio (DG9, DG16). `EXPIRED`, ou agendado vencido há mais de 2 h com o worker parado
 * (ainda `SCHEDULED` no banco), é "Não enviado: passou da hora"; `DISPATCHED` em que ninguém recebeu é
 * "Ninguém recebeu", nunca sucesso. Só rótulo: o filtro do histórico segue o estado gravado. `now` vem do chamador.
 */
export function dispatchSituation(
  item: {
    state: TeamDispatchState;
    counts: DispatchCounts;
    scheduledFor: string | null;
  },
  now: Date,
): string {
  const { state, counts, scheduledFor } = item;
  const lapsed =
    state === "SCHEDULED" &&
    scheduledFor !== null &&
    isLapsed(scheduledFor, now);
  if (lapsed) return DISPATCH_STATE_LABEL.EXPIRED;
  if (state === "DISPATCHED" && nobodyReceived(counts))
    return NOBODY_RECEIVED_LABEL;
  return DISPATCH_STATE_LABEL[state];
}

/** Dia, mês, ano e hora de um instante (ISO) em Manaus (UTC-4, sem horário de verão); o front não faz conta de fuso. */
const MANAUS_FORMAT = new Intl.DateTimeFormat("pt-BR", {
  timeZone: "America/Manaus",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

export function manausDateTime(iso: string): {
  date: string;
  dayMonth: string;
  time: string;
} {
  const part = Object.fromEntries(
    MANAUS_FORMAT.formatToParts(new Date(iso)).map(({ type, value }) => [
      type,
      value,
    ]),
  );
  const dayMonth = `${part.day}/${part.month}`;
  return {
    date: `${dayMonth}/${part.year}`,
    dayMonth,
    time: `${part.hour}:${part.minute}`,
  };
}

/** Quando o envio sai: agora, no início do turno (hora do servidor) ou em data e hora livres (Manaus). */
export function whenText({
  when,
  scheduledFor,
}: Pick<TeamAudienceRuleView, "when" | "scheduledFor">): string {
  if (when === "now") return "Agora";
  if (when === "at") {
    if (!scheduledFor) return "Em data e hora escolhidas";
    const { date, time } = manausDateTime(scheduledFor);
    return `Em ${date} às ${time}`;
  }
  return scheduledFor
    ? `No início do turno (${new Date(scheduledFor).toLocaleString("pt-BR")})`
    : "No início do turno";
}
