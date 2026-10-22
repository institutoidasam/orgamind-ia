import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { civilDateSchema } from '../../../schemas/contracts/civil-date.schema';

const MAX_SECTORS = 100;
const MAX_LEVELS = 50;

/**
 * Alvo setor (C5/C7). `date` = data da escala refeita no servidor, valendo para
 * todos os setores; `includeOff` acrescenta quem está de folga/férias e só vale
 * em "Todos os turnos". Nível: sem `levelIds` (ou vazio) e sem `withoutLevel` =
 * todos; senão passa quem tem um dos níveis, ou não tem nível e `withoutLevel`.
 */
const sectorTargetSchema = z
  .object({
    type: z.literal('sector'),
    sectorIds: z.array(z.string().min(1)).min(1).max(MAX_SECTORS),
    // Id de Shift ativo; ausente = todos os turnos (só quem tem WORK no dia).
    shiftId: z.string().min(1).optional(),
    // Seleção manual: só estes recebem; o servidor revalida contra a escala da data.
    userIds: z.array(z.string().min(1)).min(1).max(500).optional(),
    date: civilDateSchema,
    includeOff: z.boolean().optional(),
    // Ids de StaffLevel ativos; o servidor recusa inexistente ou inativo (422).
    levelIds: z.array(z.string().min(1)).max(MAX_LEVELS).optional(),
    withoutLevel: z.boolean().optional(),
  })
  .refine((t) => !(t.includeOff === true && t.shiftId !== undefined), {
    message: 'includeOff só vale sem shiftId (todos os turnos)',
    path: ['includeOff'],
  });

/**
 * D7: `sectorId` sozinho (aba aberta no deploy) vira `sectorIds: [sectorId]`
 * antes da validação; com os dois juntos o corpo é recusado.
 */
function sectorIdAlias(raw: unknown, ctx: z.RefinementCtx): unknown {
  if (typeof raw !== 'object' || raw === null || !('sectorId' in raw))
    return raw;
  const { sectorId, ...target } = raw as Record<string, unknown>;
  if (target.sectorIds !== undefined) {
    ctx.addIssue({
      code: 'custom',
      message: 'sectorId e sectorIds não vão juntos',
      path: ['sectorId'],
    });
    return raw;
  }
  return { ...target, sectorIds: [sectorId] };
}

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
    target: z.preprocess(
      sectorIdAlias,
      z.discriminatedUnion('type', [
        z.object({ type: z.literal('user'), userId: z.string().min(1) }),
        sectorTargetSchema,
      ]),
    ),
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
