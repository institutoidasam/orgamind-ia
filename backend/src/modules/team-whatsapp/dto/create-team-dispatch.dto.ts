import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

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
    z.object({ type: z.literal('sector'), sectorId: z.string().min(1) }),
  ]),
});

export class CreateTeamDispatchDto extends createZodDto(
  createTeamDispatchSchema,
) {}
export type CreateTeamDispatchInput = z.infer<typeof createTeamDispatchSchema>;
