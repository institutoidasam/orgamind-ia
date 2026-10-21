import { z } from 'zod';

// Turno fixo do usuário; null = sem turno. Mesmos literais do enum Prisma WorkShift.
export const workShiftSchema = z.enum(['FIRST', 'SECOND']);
export type WorkShift = z.infer<typeof workShiftSchema>;

export const userSummarySchema = z.object({
  id: z.string(),
  email: z.string().email(),
  name: z.string().nullable(),
  role: z.enum(['ADMIN', 'OPERATOR', 'SUPERVISOR', 'VIEWER']),
  sectorId: z.string().nullable(),
  sector: z
    .object({
      id: z.string(),
      name: z.string(),
      code: z.string(),
      isActive: z.boolean(),
    })
    .nullable(),
  isActive: z.boolean(),
  lastLoginAt: z.string().nullable(),
  // E.164 do WhatsApp do usuário; null em usuários anteriores ao campo.
  phoneE164: z.string().nullable(),
  // Turno fixo; null = sem turno (usuários anteriores ao campo).
  shift: workShiftSchema.nullable(),
  createdAt: z.string(),
  createdBy: z.object({ email: z.string() }).nullable(),
});

export const userListResponseSchema = z.object({
  data: userSummarySchema.array(),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
});

export type UserSummary = z.infer<typeof userSummarySchema>;
