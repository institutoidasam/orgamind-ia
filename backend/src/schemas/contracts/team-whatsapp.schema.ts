import { z } from 'zod';
import { workShiftSchema } from './user.schema';

/**
 * Contratos de resposta do WhatsApp da equipe (`/internal/team-whatsapp/*`).
 * Datas serializadas como string ISO, como em `user.schema.ts`.
 */

export const teamProviderSchema = z.enum(['GOZAP', 'EVOLUTION']);
export const teamSkipReasonSchema = z.enum(['NO_PHONE', 'SUPPRESSED']);
export const teamTargetTypeSchema = z.enum(['user', 'sector']);
// Último estado de conexão do canal; null = sem evento ou fora destes valores.
export const teamConnectionStateSchema = z.enum([
  'open',
  'connecting',
  'close',
]);
export const teamRecipientStatusSchema = z.enum([
  'QUEUED',
  'SENT',
  'FAILED',
  'SKIPPED',
]);

const personSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  email: z.string(),
});

export const teamTargetsResponseSchema = z.object({
  channels: z
    .object({
      id: z.string(),
      name: z.string(),
      phoneE164: z.string().nullable(),
      provider: teamProviderSchema,
      connectionState: teamConnectionStateSchema.nullable(),
    })
    .array(),
  sectors: z
    .object({
      id: z.string(),
      name: z.string(),
      code: z.string(),
      members: personSchema
        .extend({
          phoneE164: z.string().nullable(),
          isActive: z.boolean(),
          // null = sem turno definido.
          shift: workShiftSchema.nullable(),
        })
        .array(),
    })
    .array(),
});

export const createTeamDispatchResponseSchema = z.object({
  dispatchId: z.string(),
  queued: z.number().int().positive(),
  skipped: z
    .object({
      userId: z.string(),
      name: z.string(),
      reason: teamSkipReasonSchema,
    })
    .array(),
});

export const teamDispatchCountsSchema = z.object({
  queued: z.number().int().nonnegative(),
  sent: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
});

export const teamDispatchListResponseSchema = z.object({
  items: z
    .object({
      id: z.string(),
      createdAt: z.string(),
      // null quando o autor foi apagado depois do envio.
      author: personSchema.nullable(),
      target: z.object({
        type: teamTargetTypeSchema,
        id: z.string(),
        label: z.string(),
        // Filtro de turno do envio; null = todos os turnos ou alvo pessoa.
        shift: workShiftSchema.nullable(),
      }),
      // null = canal removido depois do envio (o front mostra "canal removido").
      channel: z.object({ id: z.string(), name: z.string() }).nullable(),
      counts: teamDispatchCountsSchema,
      // Todos os destinatários, por nome, sem telefone. reason = errorCode (FAILED)
      // ou skipReason (SKIPPED); null nos demais. userId null = usuário apagado.
      recipients: z
        .object({
          userId: z.string().nullable(),
          name: z.string(),
          shift: workShiftSchema.nullable(),
          status: teamRecipientStatusSchema,
          reason: z.string().nullable(),
        })
        .array(),
    })
    .array(),
});

export type TeamTargetsResponse = z.infer<typeof teamTargetsResponseSchema>;
export type CreateTeamDispatchResponse = z.infer<
  typeof createTeamDispatchResponseSchema
>;
export type TeamDispatchCounts = z.infer<typeof teamDispatchCountsSchema>;
export type TeamDispatchListResponse = z.infer<
  typeof teamDispatchListResponseSchema
>;
