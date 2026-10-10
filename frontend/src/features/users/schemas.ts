import { z } from "zod";

export const userSummarySchema = z.object({
  id: z.string(),
  email: z.string().email(),
  name: z.string().nullable(),
  role: z.enum(["ADMIN", "SUPERVISOR", "OPERATOR", "VIEWER"]),
  sectorId: z.string().nullable().optional().default(null),
  sector: z
    .object({
      id: z.string(),
      name: z.string(),
      code: z.string(),
      isActive: z.boolean().default(true),
    })
    .nullable()
    .optional()
    .default(null),
  isActive: z.boolean().optional().default(true),
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

export const inviteUserSchema = z
  .object({
    email: z.string().email("Email inválido"),
    name: z.string().max(120).optional(),
    role: z
      .enum(["ADMIN", "SUPERVISOR", "OPERATOR", "VIEWER"])
      .default("OPERATOR"),
    sectorId: z.string().nullable().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.role !== "ADMIN" && !value.sectorId) {
      ctx.addIssue({
        code: "custom",
        path: ["sectorId"],
        message: "Selecione o setor principal",
      });
    }
  });

export const editUserSchema = z.object({
  name: z.string().max(120).optional(),
  role: z.enum(["ADMIN", "SUPERVISOR", "OPERATOR", "VIEWER"]).optional(),
  sectorId: z.string().nullable().optional(),
  isActive: z.boolean().optional(),
});

export type UserSummary = z.infer<typeof userSummarySchema>;
export type InviteUserInput = z.infer<typeof inviteUserSchema>;
export type InviteUserOutput = z.output<typeof inviteUserSchema>;
export type EditUserInput = z.infer<typeof editUserSchema>;
