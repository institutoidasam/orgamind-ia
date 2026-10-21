import { addDays, type CivilDate } from './civil-date';

/** Período inclusivo startDate..endDate ('YYYY-MM-DD' ordena como texto). */
export type DateRange = { startDate: CivilDate; endDate: CivilDate };

/**
 * O que fazer com as exceções anteriores para a nova não se sobrepor (D4):
 * apagar as cobertas, encurtar as que cruzam uma ponta e, quando a nova cai no
 * meio de uma, encurtar a original até a véspera e criar a cauda (`splits`),
 * copiando kind/shiftId/sectorId/note de `fromId`.
 */
export type OverlapPlan = {
  deleteIds: string[];
  updates: { id: string; startDate: CivilDate; endDate: CivilDate }[];
  splits: { fromId: string; startDate: CivilDate; endDate: CivilDate }[];
};

/** Partes da existente que sobram fora da nova (antes e depois dela). */
function leftovers(
  existing: DateRange,
  incoming: DateRange,
): [before: DateRange | null, after: DateRange | null] {
  const before =
    existing.startDate < incoming.startDate
      ? {
          startDate: existing.startDate,
          endDate: addDays(incoming.startDate, -1),
        }
      : null;
  const after =
    existing.endDate > incoming.endDate
      ? { startDate: addDays(incoming.endDate, 1), endDate: existing.endDate }
      : null;
  return [before, after];
}

function crosses(a: DateRange, b: DateRange): boolean {
  return a.startDate <= b.endDate && b.startDate <= a.endDate;
}

function planOne(
  plan: OverlapPlan,
  existing: DateRange & { id: string },
  incoming: DateRange,
): void {
  const [before, after] = leftovers(existing, incoming);
  const kept = before ?? after;
  if (!kept) {
    plan.deleteIds.push(existing.id);
    return;
  }
  plan.updates.push({ id: existing.id, ...kept });
  if (before && after) plan.splits.push({ fromId: existing.id, ...after });
}

/** Puro; `existing` sem dia em comum com a nova fica fora do plano. */
export function planOverlap(
  existing: readonly (DateRange & { id: string })[],
  incoming: DateRange,
): OverlapPlan {
  const plan: OverlapPlan = { deleteIds: [], updates: [], splits: [] };
  for (const item of existing) {
    if (crosses(item, incoming)) planOne(plan, item, incoming);
  }
  return plan;
}
