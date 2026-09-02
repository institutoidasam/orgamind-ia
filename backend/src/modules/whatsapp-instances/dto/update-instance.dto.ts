import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const updateInstanceSchema = z.object({
  name: z.string().min(2).max(80).optional(),
  ownerUserId: z.string().cuid().nullable().optional(),
  isDefault: z.boolean().optional(),
  rejectCall: z.boolean().optional(),
  msgCall: z.string().max(280).optional(),
  groupsIgnore: z.boolean().optional(),
  alwaysOnline: z.boolean().optional(),
  readMessages: z.boolean().optional(),
  readStatus: z.boolean().optional(),
  syncFullHistory: z.boolean().optional(),
  globalPresenceDelayMs: z.number().int().min(0).max(60_000).optional(),
  globalJitterMaxMs: z.number().int().min(0).max(60_000).optional(),
  dailySendLimit: z.number().int().min(1).max(10_000).optional(),
  sendWindowStartHour: z.number().int().min(0).max(23).optional(),
  sendWindowEndHour: z.number().int().min(0).max(23).optional(),
  sendWindowEnabled: z.boolean().optional(),
}).refine(
  // The send worker treats the window as non-wrapping (`h >= start && h < end`),
  // so an overnight (start > end) or equal (start === end) window would defer
  // every message forever. Mirror the frontend's strict `start < end` contract.
  // Only enforced when a single PATCH carries both hours (the UI always sends
  // both together); a partial update touching only one hour is left to pass.
  (d) =>
    d.sendWindowStartHour === undefined ||
    d.sendWindowEndHour === undefined ||
    d.sendWindowStartHour < d.sendWindowEndHour,
  {
    message: 'sendWindowStartHour deve ser menor que sendWindowEndHour',
    path: ['sendWindowEndHour'],
  },
);

export class UpdateInstanceDto extends createZodDto(updateInstanceSchema) {}
