import { mondayOf } from '@/lib/civil-date';
import type { StaffSchedule } from './schemas';

/**
 * Modelos prontos do editor de escala (D5): só preenchem o ciclo; o servidor guarda o que
 * recebe. Semanal e Rodízio alinham o início à segunda-feira da semana escolhida.
 */

export type PresetTemplate = Exclude<StaffSchedule['template'], 'CUSTOM'>;

const WORK_DAYS = 5;
const WEEKEND_DAYS = 2;

const workWeek = (shiftId: string): (string | null)[] => [
  ...Array<string>(WORK_DAYS).fill(shiftId),
  ...Array<null>(WEEKEND_DAYS).fill(null),
];

/** Segunda a sexta no turno, sábado e domingo de folga. */
export function weekly(shiftId: string, anyDate: string): StaffSchedule {
  return { template: 'WEEKLY', startDate: mondayOf(anyDate), cycleLength: 7, days: workWeek(shiftId) };
}

/** Semana A e semana B (segunda a sexta), fins de semana de folga. */
export function weeklyRotation(input: { shiftA: string; shiftB: string; anyDate: string }): StaffSchedule {
  return {
    template: 'WEEKLY_ROTATION',
    startDate: mondayOf(input.anyDate),
    cycleLength: 14,
    days: [...workWeek(input.shiftA), ...workWeek(input.shiftB)],
  };
}

/** Um dia de trabalho, um de folga. */
export function twelve36(shiftId: string, startDate: string): StaffSchedule {
  return { template: 'TWELVE_36', startDate, cycleLength: 2, days: [shiftId, null] };
}

/** Ciclo livre: todos os dias de folga até a pessoa preencher. */
export function custom(cycleLength: number, startDate: string): StaffSchedule {
  return { template: 'CUSTOM', startDate, cycleLength, days: Array<null>(cycleLength).fill(null) };
}

/** Muda o tamanho do ciclo: mantém o prefixo e completa com folga. */
export function resizeCycle(schedule: StaffSchedule, cycleLength: number): StaffSchedule {
  const days = Array.from({ length: cycleLength }, (_, i) => schedule.days[i] ?? null);
  return { ...schedule, cycleLength, days };
}

export type PresetInput = { shiftA: string; shiftB: string; startDate: string };

/** Aplica um modelo pronto com os turnos escolhidos. */
export function applyPreset(template: PresetTemplate, input: PresetInput): StaffSchedule {
  if (template === 'WEEKLY') return weekly(input.shiftA, input.startDate);
  if (template === 'TWELVE_36') return twelve36(input.shiftA, input.startDate);
  return weeklyRotation({ shiftA: input.shiftA, shiftB: input.shiftB, anyDate: input.startDate });
}
