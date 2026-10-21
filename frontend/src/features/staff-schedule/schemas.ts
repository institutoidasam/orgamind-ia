import { z } from 'zod';
import { shiftRefSchema } from '@/features/shifts/schemas';

/**
 * Espelho à mão do contrato do back (`backend/src/schemas/contracts/staff-schedule.schema.ts`).
 * O back é a fonte: mudou lá, muda aqui no mesmo PR.
 */

/** Data civil 'YYYY-MM-DD' (o front não faz conta de fuso). */
export const civilDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** Situação de uma pessoa num dia (C3). */
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

export const staffScheduleSchema = z.object({
  template: z.enum(['WEEKLY', 'WEEKLY_ROTATION', 'TWELVE_36', 'CUSTOM']),
  startDate: civilDateSchema,
  cycleLength: z.number().int().min(1).max(28),
  days: z.array(z.string().nullable()),
});

export const staffExceptionKindSchema = z.enum(['DAY_OFF', 'VACATION', 'SHIFT_SWAP', 'OTHER_SECTOR']);

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

export const sectorRefSchema = z.object({ id: z.string(), name: z.string() });

/** `sectors` = setores que o ator alcança (destinos permitidos de "Outro setor"). */
export const scheduleOptionsSchema = z.object({
  today: civilDateSchema,
  sectors: sectorRefSchema.array(),
  shifts: shiftRefSchema.array(),
});

export const boardRowSchema = z.object({
  userId: z.string(),
  name: z.string(),
  jobTitle: z.string().nullable(),
  fromOtherSector: z.boolean(),
  canEdit: z.boolean(),
  profileShiftId: z.string().nullable(),
  schedule: staffScheduleSchema.nullable(),
  days: z
    .object({ date: civilDateSchema, situation: daySituationSchema, exceptionId: z.string().nullable() })
    .array(),
});

export const scheduleBoardSchema = z.object({
  sectorId: z.string(),
  from: civilDateSchema,
  to: civilDateSchema,
  today: civilDateSchema,
  sectors: sectorRefSchema.array(),
  shifts: shiftRefSchema.extend({ isActive: z.boolean() }).array(),
  rows: boardRowSchema.array(),
  exceptions: staffExceptionSchema.array(),
});

/** `adjusted` = exceções anteriores da pessoa recortadas ou substituídas. */
export const createExceptionResponseSchema = z.object({
  exception: staffExceptionSchema,
  adjusted: z.number().int().min(0),
});

export type DaySituation = z.infer<typeof daySituationSchema>;
export type StaffSchedule = z.infer<typeof staffScheduleSchema>;
/** Corpo do PUT da escala (C5): o próprio ciclo, com `days.length === cycleLength`. */
export type PutScheduleInput = StaffSchedule;
export type ScheduleTemplate = StaffSchedule['template'];
export type StaffExceptionKind = z.infer<typeof staffExceptionKindSchema>;
export type StaffException = z.infer<typeof staffExceptionSchema>;
export type SectorRef = z.infer<typeof sectorRefSchema>;
export type ScheduleOptions = z.infer<typeof scheduleOptionsSchema>;
export type BoardRow = z.infer<typeof boardRowSchema>;
export type ScheduleBoard = z.infer<typeof scheduleBoardSchema>;
export type BoardQuery = { sectorId: string; from: string; to: string };
export type CreateExceptionResponse = z.infer<typeof createExceptionResponseSchema>;

/** Corpo do POST: `shiftId`/`sectorId` só quando o tipo exige; `note` aparada, ausente se vazia. */
export type CreateExceptionInput = {
  kind: StaffExceptionKind;
  startDate: string;
  endDate: string;
  shiftId?: string;
  sectorId?: string;
  note?: string;
};
