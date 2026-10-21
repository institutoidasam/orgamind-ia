import { z } from 'zod';
import { workShiftSchema, type WorkShift } from '@/lib/work-shift';

/** Espelha `backend/src/schemas/contracts/team-whatsapp.schema.ts` (GC7). */

const personSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  email: z.string(),
});

export const teamConnectionStateSchema = z.enum(['open', 'connecting', 'close']);

export const teamChannelSchema = z.object({
  id: z.string(),
  name: z.string(),
  phoneE164: z.string().nullable(),
  provider: z.enum(['GOZAP', 'EVOLUTION']),
  // null = sem evento recente (eventos expiram em 7 dias); não significa desconectado.
  connectionState: teamConnectionStateSchema.nullable(),
});

export const teamMemberSchema = personSchema.extend({
  phoneE164: z.string().nullable(),
  isActive: z.boolean(),
  // null = sem turno definido.
  shift: workShiftSchema.nullable(),
});

export const teamSectorSchema = z.object({
  id: z.string(),
  name: z.string(),
  code: z.string(),
  members: teamMemberSchema.array(),
});

export const teamTargetsSchema = z.object({
  channels: teamChannelSchema.array(),
  sectors: teamSectorSchema.array(),
});

export const dispatchResultSchema = z.object({
  dispatchId: z.string(),
  queued: z.number().int(),
  skipped: z
    .object({
      userId: z.string(),
      name: z.string(),
      reason: z.enum(['NO_PHONE', 'SUPPRESSED']),
    })
    .array(),
});

export const dispatchCountsSchema = z.object({
  queued: z.number().int(),
  sent: z.number().int(),
  failed: z.number().int(),
  skipped: z.number().int(),
});

export const dispatchRecipientSchema = z.object({
  // null = usuário apagado depois do envio.
  userId: z.string().nullable(),
  name: z.string(),
  shift: workShiftSchema.nullable(),
  status: z.enum(['QUEUED', 'SENT', 'FAILED', 'SKIPPED']),
  // errorCode quando FAILED; 'NO_PHONE' | 'SUPPRESSED' quando SKIPPED; senão null.
  reason: z.string().nullable(),
});

export const dispatchListSchema = z.object({
  items: z
    .object({
      id: z.string(),
      createdAt: z.string(),
      author: personSchema.nullable(),
      target: z.object({
        type: z.enum(['user', 'sector']),
        id: z.string(),
        label: z.string(),
        // Filtro de turno do envio; null = todos os turnos ou alvo pessoa.
        shift: workShiftSchema.nullable(),
      }),
      // null = canal removido depois do envio.
      channel: z.object({ id: z.string(), name: z.string() }).nullable(),
      counts: dispatchCountsSchema,
      // Todos os destinatários, por nome, sem telefone.
      recipients: dispatchRecipientSchema.array(),
    })
    .array(),
});

export type TeamTargets = z.infer<typeof teamTargetsSchema>;
export type TeamSector = z.infer<typeof teamSectorSchema>;
export type TeamMember = z.infer<typeof teamMemberSchema>;
export type TeamChannel = z.infer<typeof teamChannelSchema>;
export type DispatchResult = z.infer<typeof dispatchResultSchema>;
export type DispatchList = z.infer<typeof dispatchListSchema>;
export type DispatchRecipient = z.infer<typeof dispatchRecipientSchema>;

export type RecipientPreview = { id: string; name: string };

export type SendTarget =
  | { type: 'user'; userId: string; label: string }
  | {
      type: 'sector';
      sectorId: string;
      /** "Produção · 2º turno" / "Produção · todos os turnos" / "… · seleção de 2" */
      label: string;
      shift: WorkShift | null; // null = todos os turnos (não envia `shift`)
      userIds: string[] | null; // null = todos do turno (não envia `userIds`)
      recipients: RecipientPreview[]; // vão receber (têm telefone)
      leftOut: RecipientPreview[]; // ficam de fora (sem telefone)
    };

/** Corpo de `POST /internal/team-whatsapp/dispatches`. */
export type CreateDispatchInput = {
  channelId: string;
  text: string;
  target:
    | { type: 'user'; userId: string }
    | { type: 'sector'; sectorId: string; shift?: WorkShift; userIds?: string[] };
};
