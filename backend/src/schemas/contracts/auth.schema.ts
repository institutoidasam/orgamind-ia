import { z } from 'zod';
import { permissionKeySchema } from './permissions.schema';

// Normalize email at the input boundary: trim + lowercase BEFORE validating,
// then pipe into z.email(). Order matters in zod v4 — chaining `.trim()` after
// `z.email()` would validate the raw (possibly padded/mixed-case) value first
// and reject it. Normalizing here keeps login case-insensitive and stops the
// case-sensitive `email String @unique` Postgres column from minting duplicate
// accounts that differ only by case.
const normalizedEmail = z.string().trim().toLowerCase().pipe(z.email());

export const loginInputSchema = z.object({
  email: normalizedEmail,
  password: z.string().min(8).max(200),
});

// Usuário da sessão: igual no login e em `GET /auth/me`. `permissions` são as
// efetivas do papel, lidas do banco a cada resposta e nunca postas no JWT (GB3).
export const currentAuthUserSchema = z.object({
  id: z.string(),
  email: z.email(),
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
  permissions: permissionKeySchema.array(),
});

export const loginResponseSchema = z.object({
  accessToken: z.string(),
  mustChangePassword: z.boolean(),
  user: currentAuthUserSchema,
});

export const meResponseSchema = z.object({
  user: currentAuthUserSchema,
  mustChangePassword: z.boolean(),
});

export type LoginInput = z.infer<typeof loginInputSchema>;
export type LoginResponse = z.infer<typeof loginResponseSchema>;
export type MeResponse = z.infer<typeof meResponseSchema>;
