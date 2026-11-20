import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { teamRecipientStatusSchema } from '../../../schemas/contracts/team-whatsapp.schema';
import { pageQuerySchema } from './page-query.dto';

const MAX_NAME_QUERY = 80;

/**
 * C5: `GET dispatches/:id/recipients?status&page&pageSize&q`. Como a paginação
 * do histórico, mas com `pageSize` 1..100 (padrão 50) e o filtro opcional
 * `status` (um valor do enum; outro → 400). `q` (DG13) = busca pelo nome
 * exibido: aparada, 1..80; vazia depois de aparar = sem busca.
 */
export const dispatchRecipientsQuerySchema = pageQuerySchema.extend({
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
  status: teamRecipientStatusSchema.optional(),
  q: z
    .string()
    .trim()
    .max(MAX_NAME_QUERY)
    .transform((q) => q || undefined)
    .optional(),
});

export type DispatchRecipientsQuery = z.infer<
  typeof dispatchRecipientsQuerySchema
>;

export class DispatchRecipientsQueryDto extends createZodDto(
  dispatchRecipientsQuerySchema,
) {}
