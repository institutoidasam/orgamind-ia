import { z } from "zod";
import { shiftRefSchema } from "@/features/shifts/schemas";
import { civilDateSchema } from "@/features/staff-schedule/schemas";

/**
 * Espelho tolerante de `backend/src/schemas/contracts/team-panorama.schema.ts` (CJ1).
 * O back é a fonte; aqui a ausência de contagem lê como zero, a de lista como vazia
 * e a de `overLimit` como falso, para um campo novo do servidor não derrubar o bloco.
 */

const count = z
  .number()
  .int()
  .nonnegative()
  .nullish()
  .transform((n) => n ?? 0);

export const panoramaCountsSchema = z.object({
  byShift: z
    .array(z.object({ shiftId: z.string(), count }))
    .nullish()
    .transform((list) => list ?? []),
  otherShifts: count,
  dayOff: count,
  vacation: count,
  noSchedule: count,
  noPhone: count,
  notAuthorized: count,
});

export const panoramaSectorSchema = z.object({
  sectorId: z.string(),
  name: z.string(),
  overLimit: z
    .boolean()
    .nullish()
    .transform((flag) => flag ?? false),
  counts: panoramaCountsSchema.nullish().transform((c) => c ?? null),
});

export const teamPanoramaSchema = z.object({
  date: civilDateSchema,
  today: civilDateSchema,
  shifts: shiftRefSchema.array(),
  inProgress: z
    .object({ date: civilDateSchema, shift: shiftRefSchema })
    .nullish()
    .transform((p) => p ?? null),
  sectors: panoramaSectorSchema.array(),
});

export type PanoramaCounts = z.infer<typeof panoramaCountsSchema>;
export type PanoramaSector = z.infer<typeof panoramaSectorSchema>;
export type TeamPanorama = z.infer<typeof teamPanoramaSchema>;
