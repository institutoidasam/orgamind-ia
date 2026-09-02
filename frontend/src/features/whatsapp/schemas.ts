import { z } from 'zod';

export const instanceSchema = z.object({
  id: z.string(),
  name: z.string(),
  evolutionInstanceName: z.string(),
  phoneE164: z.string().nullable(),
  profileName: z.string().nullable(),
  profilePictureUrl: z.string().nullable(),
  ownerUserId: z.string().nullable(),
  botId: z.string().nullable().optional(),
  botDifyAppId: z.string().nullable().optional(),
  botName: z.string().nullable().optional(),
  isDefault: z.boolean(),
  isActive: z.boolean(),
  dailySendLimit: z.number(),
  sentToday: z.number(),
  // Anti-ban warm-up (computed server-side). `warmupEffectiveCap` is the cap
  // actually enforced today; `warming` is true while the ramp is below the
  // configured cap; `warmupDay` is the 1-based day of warm-up.
  warmupStartedAt: z.string().nullable().optional(),
  warmupEffectiveCap: z.number().optional(),
  warming: z.boolean().optional(),
  warmupDay: z.number().optional(),
  sentTodayResetAt: z.string().optional(),
  createdAt: z.string(),
  // Anti-ban / instance config fields
  rejectCall: z.boolean().optional(),
  msgCall: z.string().optional(),
  groupsIgnore: z.boolean().optional(),
  alwaysOnline: z.boolean().optional(),
  readMessages: z.boolean().optional(),
  readStatus: z.boolean().optional(),
  syncFullHistory: z.boolean().optional(),
  globalPresenceDelayMs: z.number().int().nonnegative().optional(),
  globalJitterMaxMs: z.number().int().nonnegative().optional(),
  sendWindowStartHour: z.number().int().min(0).max(23).optional(),
  sendWindowEndHour: z.number().int().min(0).max(23).optional(),
  sendWindowEnabled: z.boolean().optional(),
  lastConnectionState: z.enum(['open', 'connecting', 'close']).nullable(),
});
export type Instance = z.infer<typeof instanceSchema>;

export const createInstanceInputSchema = z.object({
  name: z.string().min(2, 'Nome muito curto').max(80),
  ownerUserId: z.string().cuid().nullable().optional(),
  isDefault: z.boolean().optional(),
});
export type CreateInstanceInput = z.infer<typeof createInstanceInputSchema>;

// When the instance isn't paired, the backend explains WHY it disconnected
// (mapped from the Baileys reason code) so the QR panel can show the operator
// what happened + what to do. Present only while state !== 'open'.
export const disconnectionReasonSchema = z.object({
  code: z.number().int(),
  message: z.string(),
  guidance: z.string(),
});
export type DisconnectionReason = z.infer<typeof disconnectionReasonSchema>;

export const instanceQrSchema = z.object({
  state: z.enum(['open', 'connecting', 'close']),
  qrBase64: z.string().nullable().optional(),
  pairingCode: z.string().nullable().optional(),
  disconnectionReasonCode: z.number().int().nullable().optional(),
  disconnectionAt: z.string().nullable().optional(),
  disconnectionReason: disconnectionReasonSchema.nullable().optional(),
});
export type InstanceQr = z.infer<typeof instanceQrSchema>;
