import { z } from 'zod';

const CIVIL_DATE_FORMAT = /^\d{4}-\d{2}-\d{2}$/;

// Data real do calendário: meia-noite UTC daquele dia existe e volta igual
// ('2026-02-30' vira 02/03 ou Invalid Date, e não passa).
function isRealCalendarDay(value: string): boolean {
  const midnight = new Date(`${value}T00:00:00.000Z`);
  return (
    !Number.isNaN(midnight.getTime()) &&
    midnight.toISOString().startsWith(value)
  );
}

/** Data civil 'YYYY-MM-DD' (dia do calendário de Manaus, sem hora nem fuso). */
export const civilDateSchema: z.ZodType<string> = z
  .string()
  .regex(CIVIL_DATE_FORMAT, 'Data deve estar no formato AAAA-MM-DD')
  .refine(isRealCalendarDay, 'Data inexistente no calendário');
