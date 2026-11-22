import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/** C5: paginação das listas do WhatsApp da equipe (histórico e agendados). */
export const pageQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
});

export type PageQuery = z.infer<typeof pageQuerySchema>;

export class PageQueryDto extends createZodDto(pageQuerySchema) {}
