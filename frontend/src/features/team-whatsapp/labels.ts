import type {
  TeamAudienceBase,
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
const SHIFT_START_LABEL = "No início do turno, para a lista conferida agora";

/**
 * Como o disparo trata o público. No F o agendado não tem política (nula: dispara pela regra antiga);
 * o G acrescenta os textos de 'frozen_recheck' e do agendamento livre.
 */
export function policyLabel(
  when: "now" | "shift_start",
  policy: TeamSchedulePolicy | null,
): string {
  return when === "now" || policy === "immediate"
    ? IMMEDIATE_LABEL
    : SHIFT_START_LABEL;
}
