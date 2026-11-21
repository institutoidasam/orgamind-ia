import type { TeamPurpose } from "./schemas";

/**
 * Espelho do servidor (DI3, CI9): `backend/src/modules/team-whatsapp/` acrescenta `\n\n` + esta linha ao fim de todo
 * alerta urgente e fixa o prazo de ciência em 15 minutos. O front só mostra e soma; mexeu lá, mexa aqui.
 */
export const ALERT_CONFIRM_LINE = "Responda OK para confirmar que recebeu.";

/** `'\n\n'` (2) + a linha (39). */
export const ALERT_CONFIRM_SUFFIX_LENGTH = 41;

export const ALERT_ACK_DEADLINE_MINUTES = 15;

/** Tamanho do texto como o servidor o grava: na Urgência, o do operador mais a linha fixa (o corpo enviado segue cru). */
export function finalTextLength(
  text: string,
  purpose: TeamPurpose | undefined,
): number {
  return purpose === "urgency"
    ? text.length + ALERT_CONFIRM_SUFFIX_LENGTH
    : text.length;
}
