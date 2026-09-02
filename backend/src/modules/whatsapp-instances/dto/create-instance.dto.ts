import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const createInstanceSchema = z.object({
  name: z.string().min(2).max(80),
  ownerUserId: z.string().cuid().nullable().optional(),
  isDefault: z.boolean().optional(),
});

export class CreateInstanceDto extends createZodDto(createInstanceSchema) {}
