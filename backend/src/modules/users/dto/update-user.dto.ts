import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { contactAuthorizationInputSchema } from '../../../schemas/contracts/contact-authorization.schema';

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
    // Matrícula (A1). Ausente = mantém; null ou vazio = limpa.
    registration: z.string().trim().max(30).nullable().optional(),
    // Autorização de contato (A2). Ausente = mantém; nunca CADASTRO_ANTERIOR.
    contactAuthorization: contactAuthorizationInputSchema.optional(),
    // Motivo da alteração (A4): opcional aqui, o controller cobra de 3 a 200
    // (`requireReason`) e responde 422 user.reason_required.
    reason: z.string().trim().max(200).optional(),
  })
  // O objeto já descarta chaves desconhecidas: basta um campo definido, fora o
  // motivo, que sozinho não edita nada.
  .refine(
    (d) =>
      Object.entries(d).some(
        ([field, value]) => field !== 'reason' && value !== undefined,
      ),
    {
      message:
        'At least one of name, role, sectorId, isActive, phone, shiftId, jobTitle, levelId, registration or contactAuthorization must be provided',
    },
  );

export class UpdateUserDto extends createZodDto(updateUserSchema) {}
