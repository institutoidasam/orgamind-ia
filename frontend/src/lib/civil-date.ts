/**
 * Aritmética de calendário em datas civis 'YYYY-MM-DD'. Sem fuso: tudo em UTC
 * só para o `Date` não deslocar o dia; "hoje" vem sempre do servidor.
 */

const DAY_MS = 86_400_000;

function toUtc(date: string): number {
  const [year, month, day] = date.split('-').map(Number);
  return Date.UTC(year, month - 1, day);
}

function fromUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  return fromUtc(toUtc(date) + days * DAY_MS);
}

/** 1 = segunda … 7 = domingo. */
export function isoWeekday(date: string): number {
  return new Date(toUtc(date)).getUTCDay() || 7;
}

export function mondayOf(date: string): string {
  return addDays(date, 1 - isoWeekday(date));
}

/** Segunda a domingo da semana de `date`. */
export function weekRange(date: string): { from: string; to: string } {
  const from = mondayOf(date);
  return { from, to: addDays(from, 6) };
}

/** Primeiro ao último dia do mês de `date`. */
export function monthRange(date: string): { from: string; to: string } {
  const [year, month] = date.split('-').map(Number);
  return {
    from: fromUtc(Date.UTC(year, month - 1, 1)),
    to: fromUtc(Date.UTC(year, month, 0)),
  };
}

/** Todas as datas de `from` a `to`, inclusive nas duas pontas. */
export function daysBetween(from: string, to: string): string[] {
  const count = Math.round((toUtc(to) - toUtc(from)) / DAY_MS) + 1;
  return Array.from({ length: Math.max(count, 0) }, (_, i) => addDays(from, i));
}

/** '2026-10-21' → '21/10'. */
export function formatDayMonth(date: string): string {
  const [, month, day] = date.split('-');
  return `${day}/${month}`;
}
