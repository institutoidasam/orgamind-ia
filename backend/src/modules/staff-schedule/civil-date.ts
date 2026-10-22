import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';
import { civilDateSchema } from '../../schemas/contracts/civil-date.schema';
import { TIMEZONE_DEFAULT } from '../../schemas/contracts/schedule.schema';

/**
 * Data civil 'YYYY-MM-DD': um dia do calendário de Manaus, sem hora nem fuso.
 * A aritmética de calendário (addDays, diffDays, isoWeekday) roda em UTC, onde
 * todo dia tem 24 h; o fuso só entra em todayIn/timeIn/zonedStart.
 */
export type CivilDate = string;

const DAY_MS = 86_400_000;

export function isCivilDate(s: string): boolean {
  return civilDateSchema.safeParse(s).success;
}

/** "Hoje" no fuso (padrão America/Manaus). Única fonte de "hoje" do backend. */
export function todayIn(
  now: Date,
  timeZone: string = TIMEZONE_DEFAULT,
): CivilDate {
  return formatInTimeZone(now, timeZone, 'yyyy-MM-dd');
}

/** Hora local 'HH:mm' no fuso (padrão America/Manaus). */
export function timeIn(now: Date, timeZone: string = TIMEZONE_DEFAULT): string {
  return formatInTimeZone(now, timeZone, 'HH:mm');
}

export function addDays(date: CivilDate, days: number): CivilDate {
  return fromDbDate(new Date(toDbDate(date).getTime() + days * DAY_MS));
}

/** Dias de calendário de `earlier` até `later` (negativo se `later` vem antes). */
export function diffDays(later: CivilDate, earlier: CivilDate): number {
  const ms = toDbDate(later).getTime() - toDbDate(earlier).getTime();
  return Math.round(ms / DAY_MS);
}

/** Dia da semana ISO: 1 = segunda … 7 = domingo. */
export function isoWeekday(date: CivilDate): number {
  return toDbDate(date).getUTCDay() || 7;
}

/** Instante em que o relógio do fuso marca `hhmm` na data civil `date`. */
export function zonedStart(
  date: CivilDate,
  hhmm: string,
  timeZone: string = TIMEZONE_DEFAULT,
): Date {
  return fromZonedTime(`${date}T${hhmm}:00`, timeZone);
}

/** Data civil → valor de coluna `@db.Date` (meia-noite UTC do mesmo dia). */
export function toDbDate(date: CivilDate): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

/** Valor de coluna `@db.Date` (meia-noite UTC) → data civil. */
export function fromDbDate(d: Date): CivilDate {
  return d.toISOString().slice(0, 10);
}

/** '2026-10-21' → '21/10'. */
export function formatDayMonth(date: CivilDate): string {
  return `${date.slice(8, 10)}/${date.slice(5, 7)}`;
}
