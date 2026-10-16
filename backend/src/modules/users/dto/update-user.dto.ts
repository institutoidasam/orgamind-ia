import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const updateUserSchema = z
  .object({
    name: z.string().max(120).optional(),
    role: z.enum(['ADMIN', 'OPERATOR', 'SUPERVISOR', 'VIEWER']).optional(),
    sectorId: z.string().nullable().optional(),
    isActive: z.boolean().optional(),
    // Sem null/vazio: quem já tem telefone não pode apagá-lo; ausente = mantém.
    phone: z.string().trim().min(1).max(40).optional(),
  })
  .refine(
    (d) =>
      d.name !== undefined ||
      d.role !== undefined ||
      d.sectorId !== undefined ||
      d.isActive !== undefined ||
      d.phone !== undefined,
    {
      message:
        'At least one of name, role, sectorId, isActive or phone must be provided',
    },
  );

export class UpdateUserDto extends createZodDto(updateUserSchema) {}
