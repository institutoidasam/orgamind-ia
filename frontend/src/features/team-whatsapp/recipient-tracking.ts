import { manausDateTime } from "./labels";
import type { DispatchRecipient, RecipientStatus } from "./schemas";

type WhenFields = Pick<
  DispatchRecipient,
  "status" | "acceptedAt" | "deliveredAt" | "readAt" | "repliedAt"
>;

const WHEN_FIELD: Partial<
  Record<RecipientStatus, Exclude<keyof WhenFields, "status">>
> = {
  SENT: "acceptedAt",
  DELIVERED: "deliveredAt",
  READ: "readAt",
  REPLIED: "repliedAt",
};

/** Hora (ISO) do estado que a linha mostra (H4); `null` nos estados sem hora gravada ou com a hora nula. */
export function recipientWhen(item: WhenFields): string | null {
  const field = WHEN_FIELD[item.status];
  return field ? item[field] : null;
}

/** "dd/mm HH:mm" em Manaus, ou "—" sem hora. */
export function recipientWhenText(item: WhenFields): string {
  const iso = recipientWhen(item);
  if (!iso) return "—";
  const { dayMonth, time } = manausDateTime(iso);
  return `${dayMonth} ${time}`;
}

/** "conexão conferida às HH:mm:ss" (Manaus, H1). Manaus tem deslocamento de horas inteiras: os segundos são os do UTC. */
export function connectionCheckedText(iso: string): string {
  const seconds = String(new Date(iso).getUTCSeconds()).padStart(2, "0");
  return `conexão conferida às ${manausDateTime(iso).time}:${seconds}`;
}

/** Tentativas e, com repetição manual, "2 · repetido 1×"; "— · repetido 1×" se a repetição ainda não chegou ao provedor. */
export function attemptsText(attempts: number, manualRetries: number): string {
  const base = attempts > 0 ? String(attempts) : "—";
  return manualRetries > 0 ? `${base} · repetido ${manualRetries}×` : base;
}
