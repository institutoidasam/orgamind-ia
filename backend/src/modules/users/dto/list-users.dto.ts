import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const listUsersQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  // Filtro opcional (C2): só 'true'/'false' na query; outro valor = 400.
  // Ausente = lista todos, como hoje.
  hasAccess: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
});

export class ListUsersDto extends createZodDto(listUsersQuerySchema) {}
