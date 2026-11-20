import { formatDatePtBr } from "@/lib/format-date-ptbr";
import type { TeamActivity } from "./schemas";

/** `25/11/2026 às 09:30 · Sala 2`, só com o que veio; sem nada (ou sem atividade) devolve null. */
export function activityText(activity: TeamActivity | null): string | null {
  if (!activity) return null;
  const when = [
    activity.date ? formatDatePtBr(activity.date) : null,
    activity.time,
  ]
    .filter(Boolean)
    .join(" às ");
  return [when, activity.place].filter(Boolean).join(" · ") || null;
}
