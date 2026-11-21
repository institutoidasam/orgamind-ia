import type { AlertPerson, TeamAlertPanel } from "./alert-schemas";
import { teamErrorMessage } from "./error-messages";
import { manausDateTime } from "./labels";

/** O servidor aceita de 1 a 500 pessoas por lembrete (CI7). */
export const MAX_REMINDER_PEOPLE = 500;

/** Quem fica de fora do lembrete e o que fazer com cada um (I7). */
const REPEAT_HINT = "use Repetir na tabela";
const OTHER_MEANS_HINT = "tratar por outro meio (registrar ciência)";

export type Excluded = { person: AlertPerson; hint: string };

/**
 * Quem entra no lembrete (o servidor decide: `eligible`) e, entre os sem ciência, quem não entra: falha usa o
 * Repetir; pulado, na fila e o resto ficam para "outro meio", com ciência manual.
 */
export function reminderLists(panel: TeamAlertPanel): {
  eligible: AlertPerson[];
  excluded: Excluded[];
} {
  const eligible = panel.people.filter((p) => p.eligible);
  const excluded = panel.people
    .filter((p) => !p.eligible && !p.ack)
    .map((person) => ({
      person,
      hint: person.status === "FAILED" ? REPEAT_HINT : OTHER_MEANS_HINT,
    }));
  return { eligible, excluded };
}

/** Por que o botão fica desligado (limite, intervalo, lista vazia ou grande demais); `null` = pode enviar. */
export function reminderBlock(
  panel: TeamAlertPanel,
  chosen: number,
  now: Date,
): string | null {
  const { count, max, nextAllowedAt } = panel.reminders;
  if (count >= max) return teamErrorMessage("team_whatsapp.reminder_limit");
  if (nextAllowedAt && now.getTime() < Date.parse(nextAllowedAt)) {
    return `Lembrete disponível às ${manausDateTime(nextAllowedAt).time}`;
  }
  if (chosen === 0) return "Marque pelo menos uma pessoa.";
  if (chosen > MAX_REMINDER_PEOPLE) {
    return `Escolha no máximo ${MAX_REMINDER_PEOPLE} pessoas por lembrete.`;
  }
  return null;
}
