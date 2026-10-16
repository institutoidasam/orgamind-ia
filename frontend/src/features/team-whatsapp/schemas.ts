import { z } from 'zod';

/** Espelha `backend/src/schemas/contracts/team-whatsapp.schema.ts` (GC7). */

const personSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  email: z.string(),
});

export const teamChannelSchema = z.object({
  id: z.string(),
  name: z.string(),
  phoneE164: z.string().nullable(),
  provider: z.enum(['GOZAP', 'EVOLUTION']),
});

export const teamMemberSchema = personSchema.extend({
  phoneE164: z.string().nullable(),
  isActive: z.boolean(),
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
      }),
      // null = canal removido depois do envio.
      channel: z.object({ id: z.string(), name: z.string() }).nullable(),
      counts: dispatchCountsSchema,
    })
    .array(),
});

export type TeamTargets = z.infer<typeof teamTargetsSchema>;
export type TeamSector = z.infer<typeof teamSectorSchema>;
export type TeamMember = z.infer<typeof teamMemberSchema>;
export type TeamChannel = z.infer<typeof teamChannelSchema>;
export type DispatchResult = z.infer<typeof dispatchResultSchema>;
export type DispatchList = z.infer<typeof dispatchListSchema>;

export type SendTarget =
  | { type: 'user'; userId: string; label: string }
  | { type: 'sector'; sectorId: string; label: string; recipientCount: number };

/** Corpo de `POST /internal/team-whatsapp/dispatches`. */
export type CreateDispatchInput = {
  channelId: string;
  text: string;
  target: { type: 'user'; userId: string } | { type: 'sector'; sectorId: string };
};
