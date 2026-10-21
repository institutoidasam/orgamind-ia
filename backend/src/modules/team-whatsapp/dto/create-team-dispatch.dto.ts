import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { workShiftSchema } from '../../../schemas/contracts/user.schema';

/**
 * Corpo do POST /internal/team-whatsapp/dispatches. Texto livre de 1 a 2000
 * caracteres, sem template nem variáveis; o conteúdo não é aparado, mas
 * só-espaços é inválido.
 */
export const createTeamDispatchSchema = z.object({
  channelId: z.string().min(1),
  text: z
    .string()
    .min(1)
    .max(2000)
    .refine((s) => s.trim().length > 0, 'Texto vazio'),
  target: z.discriminatedUnion('type', [
    z.object({ type: z.literal('user'), userId: z.string().min(1) }),
    z.object({
      type: z.literal('sector'),
      sectorId: z.string().min(1),
      // Ausente = todos os turnos (inclui quem está sem turno).
      shift: workShiftSchema.optional(),
      // Seleção manual: só estes recebem; o servidor revalida contra setor/turno atuais.
      userIds: z.array(z.string().min(1)).min(1).max(500).optional(),
    }),
  ]),
});

export class CreateTeamDispatchDto extends createZodDto(
  createTeamDispatchSchema,
) {}
export type CreateTeamDispatchInput = z.infer<typeof createTeamDispatchSchema>;
