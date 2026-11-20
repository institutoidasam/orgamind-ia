import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { civilDateSchema } from '../../../schemas/contracts/civil-date.schema';
import {
  teamDispatchStateSchema,
  teamPurposeSchema,
} from '../../../schemas/contracts/team-whatsapp.schema';
import { pageQuerySchema } from './page-query.dto';

/**
 * DG14: `GET dispatches?page&pageSize&from&to&purpose&state`. `from`/`to` = dia
 * civil de Manaus sobre `createdAt`, inclusive; `purpose` = uma das 6
 * finalidades; `state` = estado do envio (com `EXPIRED`). Todos opcionais e
 * combinados com E; `from` depois de `to` → 400.
 */
export const dispatchListQuerySchema = pageQuerySchema
  .extend({
    from: civilDateSchema.optional(),
    to: civilDateSchema.optional(),
    purpose: teamPurposeSchema.optional(),
    state: teamDispatchStateSchema.optional(),
  })
  .refine(
    ({ from, to }) => from === undefined || to === undefined || from <= to,
    { message: 'from depois de to', path: ['from'] },
  );

export type DispatchListQuery = z.infer<typeof dispatchListQuerySchema>;

export class DispatchListQueryDto extends createZodDto(
  dispatchListQuerySchema,
) {}
