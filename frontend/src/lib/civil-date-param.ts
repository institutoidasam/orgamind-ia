const CIVIL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Data civil vinda de parâmetro de URL: texto `AAAA-MM-DD` que é data de calendário real
 * (ida e volta por `Date` UTC, então `2026-02-30` não passa). Qualquer outra coisa: `undefined`.
 */
export function parseCivilDateParam(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const match = CIVIL_DATE.exec(value);
  if (!match) return undefined;
  const [year, month, day] = [
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
  ];
  const date = new Date(Date.UTC(year, month - 1, day));
  const real =
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day;
  return real ? value : undefined;
}
