import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const updateUserSchema = z
  .object({
    name: z.string().max(120).optional(),
    role: z.enum(['ADMIN', 'OPERATOR', 'SUPERVISOR', 'VIEWER']).optional(),
    sectorId: z.string().nullable().optional(),
    isActive: z.boolean().optional(),
  })
  .refine(
    (d) =>
      d.name !== undefined ||
      d.role !== undefined ||
      d.sectorId !== undefined ||
      d.isActive !== undefined,
    {
      message: 'At least one of name or role must be provided',
    },
  );

export class UpdateUserDto extends createZodDto(updateUserSchema) {}
