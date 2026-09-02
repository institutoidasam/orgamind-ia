import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';

export const syncContactsSchema = z.object({
  mode: z.enum(['unvalidated', 'all']).default('unvalidated'),
});

export class SyncContactsDto extends createZodDto(syncContactsSchema) {}

/**
 * `since` é o `startedAt` que `POST /contacts/sync` devolveu — o marco a
 * partir do qual "checado" conta. String ISO validada (`z.iso.datetime`, o
 * mesmo idioma de `schedule.schema.ts`), não `z.coerce.date()`: o tipo de
 * ENTRADA de `z.coerce.date()` é `Date`, que o `toJSONSchema` do zod v4 não
 * consegue representar — derruba o Swagger no boot (ver
 * `openapi-representability.spec.ts`). A conversão para `Date` acontece no
 * controller, na borda.
 */
export const syncProgressQuerySchema = z.object({
  since: z.iso.datetime({ offset: true }),
});

export class SyncProgressDto extends createZodDto(syncProgressQuerySchema) {}
