import { z } from 'zod';

export const userSummarySchema = z.object({
  id: z.string(),
  // Pessoa sem acesso (C2): e-mail NULL e `hasAccess` false.
  email: z.string().email().nullable(),
  hasAccess: z.boolean(),
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
  // Turno do cadastro (id de Shift); null = sem turno.
  shiftId: z.string().nullable(),
  // Função exibida na escala; null = sem função.
  jobTitle: z.string().nullable(),
  // Nível (StaffLevel); null = sem nível. `level.isActive` false = nível
  // desativado que a pessoa ainda tem.
  levelId: z.string().nullable(),
  level: z
    .object({ id: z.string(), name: z.string(), isActive: z.boolean() })
    .nullable(),
  createdAt: z.string(),
  createdBy: z.object({ email: z.string().nullable() }).nullable(),
});

export const userListResponseSchema = z.object({
  data: userSummarySchema.array(),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
});

// POST /users/:id/access: a senha temporária só existe nesta resposta.
export const grantAccessResponseSchema = z.object({
  user: userSummarySchema,
  temporaryPassword: z.string(),
});

export type UserSummary = z.infer<typeof userSummarySchema>;
