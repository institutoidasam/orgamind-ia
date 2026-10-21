import { z } from 'zod';

/** Espelha `workShiftSchema` de `backend/src/schemas/contracts/user.schema.ts`. */
export const workShiftSchema = z.enum(['FIRST', 'SECOND']);
export type WorkShift = z.infer<typeof workShiftSchema>;

export const SHIFT_LABEL: Record<WorkShift, string> = { FIRST: '1º turno', SECOND: '2º turno' };
export const NO_SHIFT_LABEL = 'Sem turno';

export function shiftLabel(shift: WorkShift | null): string {
  return shift ? SHIFT_LABEL[shift] : NO_SHIFT_LABEL;
}
