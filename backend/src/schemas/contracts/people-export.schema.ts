import { z } from 'zod';
import { civilDateSchema } from './civil-date.schema';

export const spreadsheetFormatSchema = z.enum(['csv', 'xlsx']);

/** `sectorId=` (vazio) vale "todos": some do objeto, como se não viesse. */
const optionalId = z
  .string()
  .trim()
  .optional()
  .transform((value) => (value ? value : undefined));

/** D1: `GET /internal/people-export/people`. */
export const peopleExportQuerySchema = z.object({
  format: spreadsheetFormatSchema,
  sectorId: optionalId,
  shiftId: optionalId,
  status: z.enum(['active', 'inactive', 'all']).default('active'),
  // Ausente = hoje (`todayIn`, fuso de Manaus), resolvido no serviço.
  date: civilDateSchema.optional(),
});

/** D2: `GET /internal/people-export/schedule`. */
export const scheduleExportQuerySchema = z.object({
  format: spreadsheetFormatSchema,
  sectorId: z.string().min(1),
  from: civilDateSchema,
  to: civilDateSchema,
});

export type SpreadsheetFormatParam = z.infer<typeof spreadsheetFormatSchema>;
export type PeopleExportQuery = z.infer<typeof peopleExportQuerySchema>;
export type ScheduleExportQuery = z.infer<typeof scheduleExportQuerySchema>;

/** Acima disso a exportação é recusada com 422 `export.too_large`. */
export const PEOPLE_EXPORT_ROW_CAP = 50_000;
