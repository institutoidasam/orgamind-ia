import { parseCivilDateParam } from "@/lib/civil-date-param";

/** `sectorIds` chega como um texto só, com os ids separados por vírgula. */
export type SendSearch = { sectorIds?: string; date?: string };

/** Estado inicial da tela de envio: `null` = nada vindo da URL (vale o comportamento de hoje). */
export type SendInitial = { sectorIds: string[] | null; date: string | null };

const ID_SEPARATOR = ",";

function splitIds(text: string): string[] {
  return text
    .split(ID_SEPARATOR)
    .map((id) => id.trim())
    .filter((id) => id !== "");
}

/** Texto com vírgulas ou lista de textos (a URL `?sectorIds=["a","b"]`); o que não é texto cai fora. */
function idsFrom(value: unknown): string[] {
  if (typeof value === "string") return splitIds(value);
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .flatMap(splitIds);
}

/**
 * `?sectorIds` e `?date` (data civil real); o que não for isso é descartado, sem erro. As duas chaves voltam
 * sempre (`undefined` = descartado): o TanStack Router entrega em `useSearch()` a busca crua da URL com o
 * retorno por cima, então omitir a chave deixaria passar o valor inválido.
 */
export function validateSendSearch(
  search: Record<string, unknown>,
): SendSearch {
  const ids = idsFrom(search.sectorIds);
  return {
    sectorIds: ids.length > 0 ? ids.join(ID_SEPARATOR) : undefined,
    date: parseCivilDateParam(search.date),
  };
}

/**
 * Estado inicial a partir da URL: só entram os setores do alcance (`sectors` já traz só os ativos que a pessoa
 * pode usar); lista que sobra vazia = nenhum pré-marcado. A data vale se é data civil real, como no campo "Data".
 */
export function initialSendFilters(
  search: SendSearch,
  sectors: readonly { id: string }[],
): SendInitial {
  const inScope = new Set(sectors.map((sector) => sector.id));
  const ids = [...new Set(idsFrom(search.sectorIds))].filter((id) =>
    inScope.has(id),
  );
  return {
    sectorIds: ids.length > 0 ? ids : null,
    date: parseCivilDateParam(search.date) ?? null,
  };
}
