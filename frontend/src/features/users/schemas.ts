import { z } from 'zod';

export const userSummarySchema = z.object({
  id: z.string(),
  email: z.string().email(),
  name: z.string().nullable(),
  role: z.enum(['ADMIN', 'OPERATOR']),
  lastLoginAt: z.string().nullable(),
  createdAt: z.string(),
  createdBy: z.object({ email: z.string() }).nullable(),
});

export const userListResponseSchema = z.object({
  data: userSummarySchema.array(),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
});

export const inviteUserSchema = z.object({
  email: z.string().email('Email inválido'),
  name: z.string().max(120).optional(),
  role: z.enum(['ADMIN', 'OPERATOR']).default('OPERATOR'),
});

export const editUserSchema = z.object({
  name: z.string().max(120).optional(),
  role: z.enum(['ADMIN', 'OPERATOR']).optional(),
});

export type UserSummary = z.infer<typeof userSummarySchema>;
export type InviteUserInput = z.infer<typeof inviteUserSchema>;
export type InviteUserOutput = z.output<typeof inviteUserSchema>;
export type EditUserInput = z.infer<typeof editUserSchema>;
