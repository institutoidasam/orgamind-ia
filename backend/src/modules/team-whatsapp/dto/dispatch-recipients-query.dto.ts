import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { teamRecipientStatusSchema } from '../../../schemas/contracts/team-whatsapp.schema';
import { pageQuerySchema } from './page-query.dto';

/**
 * C5: `GET dispatches/:id/recipients?status&page&pageSize`. Como a paginação do
 * histórico, mas com `pageSize` 1..100 (padrão 50) e o filtro opcional `status`
 * (um valor do enum; outro → 400).
 */
export const dispatchRecipientsQuerySchema = pageQuerySchema.extend({
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
  status: teamRecipientStatusSchema.optional(),
});

export type DispatchRecipientsQuery = z.infer<
  typeof dispatchRecipientsQuerySchema
>;

export class DispatchRecipientsQueryDto extends createZodDto(
  dispatchRecipientsQuerySchema,
) {}
