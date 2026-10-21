import type { ShiftRef } from './schemas';

/** Quem não tem turno no cadastro. */
export const NO_SHIFT_LABEL = 'Sem turno';

export const CROSSES_MIDNIGHT_LABEL = 'atravessa a meia-noite';

/** "22:00–06:00" (travessão curto, sem espaços). */
export function shiftRangeLabel(shift: Pick<ShiftRef, 'startTime' | 'endTime'>): string {
  return `${shift.startTime}–${shift.endTime}`;
}
