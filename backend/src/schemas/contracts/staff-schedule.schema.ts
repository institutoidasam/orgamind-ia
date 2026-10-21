import { z } from 'zod';
import { civilDateSchema } from './civil-date.schema';
import { shiftRefSchema } from './shift.schema';

/** C3: situação de uma pessoa numa data civil (espelha o `DaySituation` do resolvedor). */
export const daySituationSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('WORK'),
    sectorId: z.string().nullable(),
    shiftId: z.string(),
    source: z.enum(['PROFILE', 'CYCLE', 'EXCEPTION']),
  }),
  z.object({
    kind: z.literal('OFF'),
    reason: z.enum(['DAY_OFF', 'VACATION']),
    source: z.enum(['CYCLE', 'EXCEPTION']),
  }),
  z.object({ kind: z.literal('NONE') }),
]);

export const staffScheduleTemplateSchema = z.enum([
  'WEEKLY',
  'WEEKLY_ROTATION',
  'TWELVE_36',
  'CUSTOM',
]);

/** Ciclo da pessoa; `days[i]` = id do turno no dia i do ciclo, null = folga. */
export const staffScheduleSchema = z.object({
  template: staffScheduleTemplateSchema,
  startDate: civilDateSchema,
  cycleLength: z.number().int().min(1).max(28),
  days: z.array(z.string().nullable()),
});

export const staffExceptionKindSchema = z.enum([
  'DAY_OFF',
  'VACATION',
  'SHIFT_SWAP',
  'OTHER_SECTOR',
]);

/** Exceção por data; período inclusivo startDate..endDate. */
export const staffExceptionSchema = z.object({
  id: z.string(),
  userId: z.string(),
  kind: staffExceptionKindSchema,
  startDate: civilDateSchema,
  endDate: civilDateSchema,
  shiftId: z.string().nullable(),
  sectorId: z.string().nullable(),
  note: z.string().nullable(),
});

export const staffSectorRefSchema = z.object({
  id: z.string(),
  name: z.string(),
});

/** `sectors` = os que o ator alcança (destinos permitidos de "Outro setor"). */
export const staffScheduleOptionsSchema = z.object({
  today: civilDateSchema,
  sectors: staffSectorRefSchema.array(),
  shifts: shiftRefSchema.array(),
});

export const boardDaySchema = z.object({
  date: civilDateSchema,
  situation: daySituationSchema,
  exceptionId: z.string().nullable(),
});

export const boardRowSchema = z.object({
  userId: z.string(),
  name: z.string(),
  jobTitle: z.string().nullable(),
  fromOtherSector: z.boolean(),
  canEdit: z.boolean(),
  profileShiftId: z.string().nullable(),
  schedule: staffScheduleSchema.nullable(),
  days: boardDaySchema.array(),
});

/** `sectors`/`shifts` = os citados nas linhas e nas exceções (turno pode estar inativo). */
export const staffScheduleBoardSchema = z.object({
  sectorId: z.string(),
  from: civilDateSchema,
  to: civilDateSchema,
  today: civilDateSchema,
  sectors: staffSectorRefSchema.array(),
  shifts: shiftRefSchema.extend({ isActive: z.boolean() }).array(),
  rows: boardRowSchema.array(),
  exceptions: staffExceptionSchema.array(),
});

/** Período validado no serviço (422 `staff_schedule.invalid_period`), não aqui. */
export const boardQuerySchema = z.object({
  sectorId: z.string().min(1),
  from: civilDateSchema,
  to: civilDateSchema,
});

/** C5: PUT do ciclo, guardado como recebido (D5); um item de `days` por dia. */
export const putScheduleSchema = staffScheduleSchema.refine(
  (value) => value.days.length === value.cycleLength,
  { message: 'O ciclo deve ter um item por dia', path: ['days'] },
);

/** Exceção mais longa: um ano bissexto inteiro (inclusivo). */
const MAX_EXCEPTION_DAYS = 366;
const DAY_MS = 86_400_000;
type ExceptionKind = z.infer<typeof staffExceptionKindSchema>;

/** Campos exigidos (true) ou proibidos (false) por tipo de exceção. */
const KIND_FIELDS: Record<
  ExceptionKind,
  { shiftId: boolean; sectorId: boolean }
> = {
  DAY_OFF: { shiftId: false, sectorId: false },
  VACATION: { shiftId: false, sectorId: false },
  SHIFT_SWAP: { shiftId: true, sectorId: false },
  OTHER_SECTOR: { shiftId: true, sectorId: true },
};

/** Dias do período inclusivo (datas já validadas como dia real do calendário). */
function spanDays(startDate: string, endDate: string): number {
  const ms =
    Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`);
  return ms / DAY_MS + 1;
}

/** C5: corpo do POST de exceção; `note` aparada, até 200. */
export const createStaffExceptionSchema = z
  .object({
    kind: staffExceptionKindSchema,
    startDate: civilDateSchema,
    endDate: civilDateSchema,
    shiftId: z.string().min(1).optional(),
    sectorId: z.string().min(1).optional(),
    note: z.string().trim().max(200).optional(),
  })
  .superRefine((value, ctx) => {
    const days = spanDays(value.startDate, value.endDate);
    if (days < 1 || days > MAX_EXCEPTION_DAYS) {
      ctx.addIssue({
        code: 'custom',
        path: ['endDate'],
        message: `Período de 1 a ${MAX_EXCEPTION_DAYS} dias`,
      });
    }
    for (const field of ['shiftId', 'sectorId'] as const) {
      const required = KIND_FIELDS[value.kind][field];
      if ((value[field] !== undefined) === required) continue;
      ctx.addIssue({
        code: 'custom',
        path: [field],
        message: required
          ? 'Obrigatório para este tipo'
          : 'Não se aplica a este tipo',
      });
    }
  });

/** `adjusted` = exceções anteriores da pessoa recortadas ou substituídas. */
export const createStaffExceptionResponseSchema = z.object({
  exception: staffExceptionSchema,
  adjusted: z.number().int().min(0),
});

export type DaySituationContract = z.infer<typeof daySituationSchema>;
export type StaffSchedule = z.infer<typeof staffScheduleSchema>;
export type StaffException = z.infer<typeof staffExceptionSchema>;
export type StaffSectorRef = z.infer<typeof staffSectorRefSchema>;
export type StaffScheduleOptions = z.infer<typeof staffScheduleOptionsSchema>;
export type BoardDay = z.infer<typeof boardDaySchema>;
export type BoardRow = z.infer<typeof boardRowSchema>;
export type StaffScheduleBoard = z.infer<typeof staffScheduleBoardSchema>;
export type BoardQuery = z.infer<typeof boardQuerySchema>;
export type PutScheduleInput = z.infer<typeof putScheduleSchema>;
export type CreateExceptionInput = z.infer<typeof createStaffExceptionSchema>;
export type CreateStaffExceptionResponse = z.infer<
  typeof createStaffExceptionResponseSchema
>;
