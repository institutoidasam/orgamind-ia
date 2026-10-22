import { addDays, monthRange, weekRange } from '@/lib/civil-date';

export type PeriodMode = 'week' | 'month';

/** Período mostrado: a semana ou o mês que contém `anchor`. */
export function periodRange(mode: PeriodMode, anchor: string): { from: string; to: string } {
  return mode === 'week' ? weekRange(anchor) : monthRange(anchor);
}

/** Nova âncora ao navegar: uma semana ou um mês para trás (-1) ou para frente (1). */
export function stepAnchor(mode: PeriodMode, anchor: string, direction: -1 | 1): string {
  const { from, to } = periodRange(mode, anchor);
  if (mode === 'week') return addDays(from, 7 * direction);
  return direction > 0 ? addDays(to, 1) : addDays(from, -1);
}
