import { z } from 'zod';

/**
 * Contratos de resposta do WhatsApp da equipe (`/internal/team-whatsapp/*`).
 * Datas serializadas como string ISO, como em `user.schema.ts`.
 */

export const teamProviderSchema = z.enum(['GOZAP', 'EVOLUTION']);
export const teamSkipReasonSchema = z.enum(['NO_PHONE', 'SUPPRESSED']);
export const teamTargetTypeSchema = z.enum(['user', 'sector']);

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
    })
    .array(),
  sectors: z
    .object({
      id: z.string(),
      name: z.string(),
      code: z.string(),
      members: personSchema
        .extend({ phoneE164: z.string().nullable(), isActive: z.boolean() })
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
      }),
      // null = canal removido depois do envio (o front mostra "canal removido").
      channel: z.object({ id: z.string(), name: z.string() }).nullable(),
      counts: teamDispatchCountsSchema,
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
