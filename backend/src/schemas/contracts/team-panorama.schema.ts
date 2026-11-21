import { z } from 'zod';
import { civilDateSchema } from './civil-date.schema';
import { shiftRefSchema } from './shift.schema';

/** Query do GET /internal/team-whatsapp/panorama: só a data civil, como o roster. */
export const teamPanoramaQuerySchema = z.object({ date: civilDateSchema });

const countSchema = z.number().int().nonnegative();

/**
 * Contagens de um setor na data (DJ4). `noPhone` e `notAuthorized` valem só
 * entre os em serviço e são disjuntos: quem está sem telefone não conta de novo
 * como sem autorização (mesma ordem da prévia).
 */
export const panoramaCountsSchema = z.object({
  byShift: z.array(z.object({ shiftId: z.string(), count: countSchema })),
  otherShifts: countSchema,
  dayOff: countSchema,
  vacation: countSchema,
  noSchedule: countSchema,
  noPhone: countSchema,
  notAuthorized: countSchema,
});

/** Setor do alcance; `counts` é nulo quando o setor sozinho passa do limite. */
export const panoramaSectorSchema = z.object({
  sectorId: z.string(),
  name: z.string(),
  overLimit: z.boolean(),
  counts: panoramaCountsSchema.nullable(),
});

/** Só ids, nomes de setor e turno e contagens: nenhum dado de pessoa (GJ3). */
export const teamPanoramaResponseSchema = z.object({
  date: civilDateSchema,
  today: civilDateSchema,
  shifts: shiftRefSchema.array(),
  inProgress: z
    .object({ date: civilDateSchema, shift: shiftRefSchema })
    .nullable(),
  sectors: panoramaSectorSchema.array(),
});

export type TeamPanoramaQuery = z.infer<typeof teamPanoramaQuerySchema>;
export type TeamPanoramaResponse = z.infer<typeof teamPanoramaResponseSchema>;
export type PanoramaCounts = z.infer<typeof panoramaCountsSchema>;
