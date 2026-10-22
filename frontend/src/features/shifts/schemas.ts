import { z } from 'zod';

/**
 * Espelho à mão do contrato do back (`backend/src/schemas/contracts/shift.schema.ts`).
 * O back é a fonte: mudou lá, muda aqui no mesmo PR.
 */

/** Hora 'HH:mm' de 00:00 a 23:59. */
export const hhmmSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use formato HH:mm');

export const shiftRefSchema = z.object({
  id: z.string(),
  name: z.string(),
  startTime: hhmmSchema,
  endTime: hhmmSchema,
});

export const shiftUsageKindSchema = z.enum(['users', 'schedules', 'exceptions', 'scheduled']);

const shiftUsageSchema = z.object({
  kind: shiftUsageKindSchema,
  count: z.number().int().positive(),
});

/** `crossesMidnight` = `endTime <= startTime`; o turno pertence à data em que começa. */
export const shiftAdminSchema = shiftRefSchema.extend({
  isActive: z.boolean(),
  sortOrder: z.number().int(),
  crossesMidnight: z.boolean(),
  inUse: shiftUsageSchema.array(),
});

export const shiftListSchema = z.object({ items: shiftAdminSchema.array() });

export type ShiftRef = z.infer<typeof shiftRefSchema>;
export type ShiftUsageKind = z.infer<typeof shiftUsageKindSchema>;
export type ShiftAdmin = z.infer<typeof shiftAdminSchema>;

export type CreateShiftInput = Pick<ShiftRef, 'name' | 'startTime' | 'endTime'>;
export type UpdateShiftInput = Partial<CreateShiftInput & { isActive: boolean }>;

/** Formulário do turno: nome e horários 'HH:mm'. */
export const shiftFormSchema = z.object({
  name: z.string().trim().min(1, 'Informe o nome').max(40, 'Use até 40 caracteres'),
  startTime: hhmmSchema,
  endTime: hhmmSchema,
});
