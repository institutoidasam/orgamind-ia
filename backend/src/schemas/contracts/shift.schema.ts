import { z } from 'zod';

/** Hora 'HH:mm' de 00:00 a 23:59. */
export const hhmmSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use formato HH:mm');

const shiftNameSchema = z.string().trim().min(1).max(40);

export const shiftRefSchema = z.object({
  id: z.string(),
  name: z.string(),
  startTime: hhmmSchema,
  endTime: hhmmSchema,
});

// 'scheduled' (envio agendado pendente) só passa a ser produzido na T8; o enum
// já nasce com os quatro motivos para o front não mudar depois.
export const shiftUsageKindSchema = z.enum([
  'users',
  'schedules',
  'exceptions',
  'scheduled',
]);

export const shiftUsageSchema = z.object({
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

export const shiftListResponseSchema = z.object({
  items: shiftAdminSchema.array(),
});

export const createShiftSchema = z.object({
  name: shiftNameSchema,
  startTime: hhmmSchema,
  endTime: hhmmSchema,
});

export const updateShiftSchema = z
  .object({
    name: shiftNameSchema.optional(),
    startTime: hhmmSchema.optional(),
    endTime: hhmmSchema.optional(),
    isActive: z.boolean().optional(),
  })
  .refine(
    (value) => Object.values(value).some((field) => field !== undefined),
    'Informe ao menos um campo',
  );

export const reorderShiftsSchema = z.object({
  ids: z.array(z.string().min(1)).min(1).max(100),
});

export type ShiftRef = z.infer<typeof shiftRefSchema>;
export type ShiftUsageKind = z.infer<typeof shiftUsageKindSchema>;
export type ShiftUsage = z.infer<typeof shiftUsageSchema>;
export type ShiftAdmin = z.infer<typeof shiftAdminSchema>;
export type ShiftListResponse = z.infer<typeof shiftListResponseSchema>;
export type CreateShiftInput = z.infer<typeof createShiftSchema>;
export type UpdateShiftInput = z.infer<typeof updateShiftSchema>;
export type ReorderShiftsInput = z.infer<typeof reorderShiftsSchema>;
