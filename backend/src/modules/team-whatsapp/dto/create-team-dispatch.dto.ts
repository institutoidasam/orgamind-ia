import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { civilDateSchema } from '../../../schemas/contracts/civil-date.schema';

/**
 * Alvo setor (C7). `date` = data da escala refeita no servidor; `includeOff`
 * acrescenta quem está de folga/férias e só vale em "Todos os turnos".
 */
const sectorTargetSchema = z
  .object({
    type: z.literal('sector'),
    sectorId: z.string().min(1),
    // Id de Shift ativo; ausente = todos os turnos (só quem tem WORK no dia).
    shiftId: z.string().min(1).optional(),
    // Seleção manual: só estes recebem; o servidor revalida contra a escala da data.
    userIds: z.array(z.string().min(1)).min(1).max(500).optional(),
    date: civilDateSchema,
    includeOff: z.boolean().optional(),
  })
  .refine((t) => !(t.includeOff === true && t.shiftId !== undefined), {
    message: 'includeOff só vale sem shiftId (todos os turnos)',
    path: ['includeOff'],
  });

/**
 * Corpo do POST /internal/team-whatsapp/dispatches. Texto livre de 1 a 2000
 * caracteres, sem template nem variáveis; o conteúdo não é aparado, mas
 * só-espaços é inválido. `when` (C7): ausente = `'now'`; `'shift_start'` agenda
 * para o início do turno na data e exige alvo setor com `shiftId`.
 */
export const createTeamDispatchSchema = z
  .object({
    channelId: z.string().min(1),
    text: z
      .string()
      .min(1)
      .max(2000)
      .refine((s) => s.trim().length > 0, 'Texto vazio'),
    when: z.enum(['now', 'shift_start']).optional(),
    target: z.discriminatedUnion('type', [
      z.object({ type: z.literal('user'), userId: z.string().min(1) }),
      sectorTargetSchema,
    ]),
  })
  .refine(
    (b) =>
      b.when !== 'shift_start' ||
      (b.target.type === 'sector' && b.target.shiftId !== undefined),
    {
      message: "when 'shift_start' exige alvo setor com shiftId",
      path: ['when'],
    },
  );

export class CreateTeamDispatchDto extends createZodDto(
  createTeamDispatchSchema,
) {}
export type CreateTeamDispatchInput = z.infer<typeof createTeamDispatchSchema>;
