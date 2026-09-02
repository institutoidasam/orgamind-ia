import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const updateUserSchema = z
  .object({
    name: z.string().max(120).optional(),
    role: z.enum(['ADMIN', 'OPERATOR']).optional(),
  })
  .refine((d) => d.name !== undefined || d.role !== undefined, {
    message: 'At least one of name or role must be provided',
  });

export class UpdateUserDto extends createZodDto(updateUserSchema) {}
