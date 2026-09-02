import { z } from 'zod';

export const userSummarySchema = z.object({
  id: z.string(),
  email: z.string().email(),
  name: z.string().nullable(),
  role: z.enum(['ADMIN', 'OPERATOR']),
  lastLoginAt: z.string().nullable(),
  createdAt: z.string(),
  createdBy: z
    .object({ email: z.string() })
    .nullable(),
});

export const userListResponseSchema = z.object({
  data: userSummarySchema.array(),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
});

export type UserSummary = z.infer<typeof userSummarySchema>;
