import { z } from 'zod';

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

export const loginResponseSchema = z.object({
  accessToken: z.string(),
  mustChangePassword: z.boolean(),
  user: z.object({
    id: z.string(),
    email: z.email(),
    name: z.string().nullable(),
    role: z.enum(['ADMIN', 'OPERATOR']),
  }),
});

export type LoginInput = z.infer<typeof loginInputSchema>;
export type LoginResponse = z.infer<typeof loginResponseSchema>;
