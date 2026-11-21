import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { civilDateSchema } from '../../../schemas/contracts/civil-date.schema';
import { hhmmSchema } from '../../../schemas/contracts/shift.schema';
import {
  teamAudienceBaseSchema,
  teamPurposeSchema,
  teamWhenSchema,
} from '../../../schemas/contracts/team-whatsapp.schema';
import { ALERT_CONFIRM_SUFFIX } from '../team-alert.rules';

const MAX_SECTORS = 100;
const MAX_LEVELS = 50;
export const MAX_SHIFTS = 20;
const MAX_SELECTED = 500;
const MAX_TEXT = 2000;
const MAX_PLACE = 120;
const MAX_URGENCY_REASON = 200;
// Impressão do público devolvida pela prévia (HMAC-SHA256 em hex).
const AUDIENCE_KEY = /^[0-9a-f]{64}$/;

/**
 * Alvo setor (C5/C7). `date` = data de referência (escala e vínculo), valendo
 * para todos os setores; `includeOff` (ausente = false) acrescenta quem está de
 * folga, com qualquer seleção de turnos. Nível: sem `levelIds` (ou vazio) e sem `withoutLevel` =
 * todos; senão passa quem tem um dos níveis, ou não tem nível e `withoutLevel`.
 */
const sectorTargetSchema = z.object({
  type: z.literal('sector'),
  sectorIds: z.array(z.string().min(1)).min(1).max(MAX_SECTORS),
  // Ids de Shift ativos (D9); ausente = todos os turnos.
  shiftIds: z.array(z.string().min(1)).min(1).max(MAX_SHIFTS).optional(),
  // Seleção nominal: só restringe; o servidor confere contra o público da data.
  // Vazia só na prévia (a hora extra vê os candidatos antes de marcar alguém).
  userIds: z.array(z.string().min(1)).max(MAX_SELECTED).optional(),
  date: civilDateSchema,
  includeOff: z.boolean().optional(),
  // Ids de StaffLevel ativos; o servidor recusa inexistente ou inativo (422).
  levelIds: z.array(z.string().min(1)).max(MAX_LEVELS).optional(),
  withoutLevel: z.boolean().optional(),
});
/** No envio, a seleção nominal, quando vem, tem de 1 a 500 ids. */
const sendSectorTargetSchema = sectorTargetSchema.extend({
  userIds: z.array(z.string().min(1)).min(1).max(MAX_SELECTED).optional(),
});
const userTargetSchema = z.object({
  type: z.literal('user'),
  userId: z.string().min(1),
});

/**
 * Apelido de lista (D7/D9): `single` sozinho (aba aberta no deploy) vira
 * `list: [single]` antes da validação; com os dois juntos o corpo é recusado.
 */
function aliasToList(single: string, list: string) {
  return (raw: unknown, ctx: z.RefinementCtx): unknown => {
    if (typeof raw !== 'object' || raw === null || !(single in raw)) return raw;
    const { [single]: value, ...target } = raw as Record<string, unknown>;
    if (target[list] !== undefined) {
      ctx.addIssue({
        code: 'custom',
        message: `${single} e ${list} não vão juntos`,
        path: [single],
      });
      return raw;
    }
    return { ...target, [list]: [value] };
  };
}

const sectorIdAlias = aliasToList('sectorId', 'sectorIds');
const shiftIdAlias = aliasToList('shiftId', 'shiftIds');
const targetAliases = (raw: unknown, ctx: z.RefinementCtx): unknown =>
  shiftIdAlias(sectorIdAlias(raw, ctx), ctx);

/**
 * Atividade (GF11): data, hora `HH:mm` e local (aparado, até 120). Todos
 * opcionais aqui: a finalidade decide o que falta, e a falta vira trava.
 */
const activityInputSchema = z.object({
  date: civilDateSchema.optional(),
  time: hhmmSchema.optional(),
  place: z.string().trim().max(MAX_PLACE).optional(),
});

/** DG8: data e hora livres do disparo, dia civil e `HH:mm` em Manaus. */
const atInputSchema = z.object({ date: civilDateSchema, time: hhmmSchema });

/**
 * Campos comuns à prévia e ao envio (CF2). O texto não é aparado. `when`
 * (C7): ausente = `'now'`; `'shift_start'` agenda para o início do turno na
 * data; `'at'` (DG8) agenda para `at`. `base` ausente = a fixa/padrão da
 * finalidade. `urgencyReason` aparado, até 200.
 */
const audienceFields = {
  text: z.string().max(MAX_TEXT),
  when: teamWhenSchema.optional(),
  at: atInputSchema.optional(),
  base: teamAudienceBaseSchema.optional(),
  activity: activityInputSchema.optional(),
  urgencyReason: z.string().trim().max(MAX_URGENCY_REASON).optional(),
};

/** `'shift_start'` exige alvo setor com exatamente um turno (D9). */
const shiftStartAllowed = (b: {
  when?: string;
  target: { type: string; shiftIds?: string[] };
}) =>
  b.when !== 'shift_start' ||
  (b.target.type === 'sector' && new Set(b.target.shiftIds).size === 1);
const shiftStartIssue = {
  message: "when 'shift_start' exige alvo setor com exatamente um turno",
  path: ['when'],
};

function issue(ctx: z.RefinementCtx, path: string, message: string): void {
  ctx.addIssue({ code: 'custom', path: [path], message });
}

/**
 * DG8: `at` é obrigatório com `when: 'at'` e proibido sem ele; `'at'` só no
 * alvo setor (alvo pessoa → 400). Qualquer seleção de turnos vale.
 */
function atRules(
  b: { when?: string; at?: unknown; target: { type: string } },
  ctx: z.RefinementCtx,
): void {
  const isAt = b.when === 'at';
  if (isAt && b.at === undefined)
    issue(ctx, 'at', "when 'at' exige a data e a hora");
  if (!isAt && b.at !== undefined)
    issue(ctx, 'at', "Data e hora só vão com when 'at'");
  if (isAt && b.target.type !== 'sector')
    issue(ctx, 'when', "when 'at' só vale no envio para setor");
}

/**
 * Alerta urgente (I2/DI3): o servidor acrescenta a linha fixa ao texto gravado,
 * e o limite de 2000 vale para o texto final; na Urgência o do usuário vai até
 * 1959 (400 no caminho `text`). A prévia não muda: não cobre o texto.
 */
function alertTextRule(
  b: { purpose?: string; text: string },
  ctx: z.RefinementCtx,
): void {
  if (
    b.purpose === 'urgency' &&
    b.text.length + ALERT_CONFIRM_SUFFIX.length > MAX_TEXT
  )
    issue(
      ctx,
      'text',
      `Com a linha de confirmação, o texto passa de ${MAX_TEXT} caracteres`,
    );
}

/**
 * Corpo do POST /internal/team-whatsapp/dispatches/preview (C4). Só alvo
 * setor (alvo pessoa → 400) e sempre com finalidade. Aceita texto vazio e
 * seleção vazia (as travas voltam como lista); `audienceKey` é ignorada (só o
 * limite de 64 do envio vale).
 */
export const teamAudienceRequestSchema = z
  .object({
    ...audienceFields,
    purpose: teamPurposeSchema,
    audienceKey: z.string().max(64).optional(),
    target: z.preprocess(targetAliases, sectorTargetSchema),
  })
  .refine(shiftStartAllowed, shiftStartIssue)
  .superRefine(atRules);

const sendBodySchema = z.object({
  channelId: z.string().optional(),
  ...audienceFields,
  purpose: teamPurposeSchema.optional(),
  audienceKey: z.string().regex(AUDIENCE_KEY).optional(),
  target: z.preprocess(
    targetAliases,
    z.discriminatedUnion('type', [userTargetSchema, sendSectorTargetSchema]),
  ),
});

/**
 * Alvo pessoa não muda (GF1): sem finalidade e com texto não vazio (400).
 * Alvo setor exige a finalidade e a impressão do público da prévia; texto
 * vazio passa e vira a trava 422 `empty_text` (DF7).
 */
function sendRules(b: z.output<typeof sendBodySchema>, ctx: z.RefinementCtx) {
  if (b.target.type === 'user') {
    if (b.purpose !== undefined)
      issue(ctx, 'purpose', 'Envio a uma pessoa não tem finalidade');
    if (b.text.trim().length === 0) issue(ctx, 'text', 'Texto vazio');
    return;
  }
  if (b.purpose === undefined)
    issue(ctx, 'purpose', 'Envio para setor exige a finalidade');
  if (b.audienceKey === undefined)
    issue(ctx, 'audienceKey', 'Envio para setor exige a impressão da prévia');
}

/**
 * Corpo do POST /internal/team-whatsapp/dispatches: os campos da prévia, com
 * `audienceKey` (hex de 64) obrigatória no alvo setor. `channelId` é aceito e
 * ignorado (C3: aba aberta durante o deploy).
 */
export const createTeamDispatchSchema = sendBodySchema
  .superRefine(sendRules)
  .refine(shiftStartAllowed, shiftStartIssue)
  .superRefine(atRules)
  .superRefine(alertTextRule);

export class CreateTeamDispatchDto extends createZodDto(
  createTeamDispatchSchema,
) {}
export type CreateTeamDispatchInput = z.infer<typeof createTeamDispatchSchema>;

export class PreviewTeamDispatchDto extends createZodDto(
  teamAudienceRequestSchema,
) {}
export type TeamAudienceRequest = z.infer<typeof teamAudienceRequestSchema>;
export type SectorTargetInput = TeamAudienceRequest['target'];
