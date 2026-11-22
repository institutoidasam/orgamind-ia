import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/** C2: query do GET /internal/team-whatsapp/person-route (`userId`). */
export const personRouteQuerySchema = z.object({
  userId: z.string().min(1),
});

export class PersonRouteQueryDto extends createZodDto(personRouteQuerySchema) {}
