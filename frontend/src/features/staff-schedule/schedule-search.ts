import { parseCivilDateParam } from "@/lib/civil-date-param";

export type ScheduleSearch = { sectorId?: string; date?: string };

/**
 * `?sectorId` (texto não vazio) e `?date` (data civil real); o que não for isso é descartado, sem erro.
 * As duas chaves voltam sempre (`undefined` = descartado): o TanStack Router entrega em `useSearch()` a busca
 * crua da URL com o retorno por cima (`{ ...crua, ...validada }`), então omitir a chave deixaria passar o
 * valor inválido (`date=2026-02-30` virava a semana de 02/03).
 */
export function validateScheduleSearch(
  search: Record<string, unknown>,
): ScheduleSearch {
  const sectorId =
    typeof search.sectorId === "string" && search.sectorId !== ""
      ? search.sectorId
      : undefined;
  return { sectorId, date: parseCivilDateParam(search.date) };
}

type ScheduleOptionsRef = { today: string; sectors: readonly { id: string }[] };

/**
 * Estado inicial da tela a partir da URL: o setor só vale se está no alcance da pessoa
 * (`options.sectors` já traz só os ativos); a data vira a âncora do período, senão hoje.
 */
export function initialSchedule(
  search: ScheduleSearch,
  options: ScheduleOptionsRef,
): { sectorId: string | null; anchor: string } {
  const inScope =
    search.sectorId !== undefined &&
    options.sectors.some((sector) => sector.id === search.sectorId);
  return {
    sectorId: inScope ? (search.sectorId ?? null) : null,
    anchor: search.date ?? options.today,
  };
}
