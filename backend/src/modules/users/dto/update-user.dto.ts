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
    // Turno (id de Shift). Ausente = mantém; null = limpa (sem turno).
    shiftId: z.string().min(1).nullable().optional(),
    // Função. Ausente = mantém; null ou vazio = limpa. Apara e limita a 80.
    jobTitle: z.string().trim().max(80).nullable().optional(),
    // Nível (id de StaffLevel). Ausente = mantém; null = limpa. Inexistente, ou
    // inativo e diferente do atual = 422 users.invalid_level (UsersService).
    levelId: z.string().min(1).nullable().optional(),
  })
  // O objeto já descarta chaves desconhecidas: basta um campo definido.
  .refine((d) => Object.values(d).some((value) => value !== undefined), {
    message:
      'At least one of name, role, sectorId, isActive, phone, shiftId, jobTitle or levelId must be provided',
  });

export class UpdateUserDto extends createZodDto(updateUserSchema) {}
