import { z } from "zod";

const phoneDigitsOk = (v: string) => {
  const digits = v.replace(/\D/g, "");
  return digits.length >= 10 && digits.length <= 15;
};
const PHONE_DIGITS_MESSAGE = "Informe DDD + número";
const requiredPhone = z
  .string()
  .trim()
  .min(1, "Telefone obrigatório")
  .refine(phoneDigitsOk, PHONE_DIGITS_MESSAGE);
const optionalPhone = z
  .string()
  .trim()
  .optional()
  .refine((v) => !v || phoneDigitsOk(v), PHONE_DIGITS_MESSAGE);

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
  phoneE164: z.string().nullable(),
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
    phone: requiredPhone,
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
  phone: z.string().optional(),
});

/** Quem já tem telefone pode trocar, não apagar; quem não tem pode continuar sem. */
export const editUserSchemaFor = (hadPhone: boolean) =>
  editUserSchema.extend({ phone: hadPhone ? requiredPhone : optionalPhone });

export type UserSummary = z.infer<typeof userSummarySchema>;
export type InviteUserInput = z.infer<typeof inviteUserSchema>;
export type InviteUserOutput = z.output<typeof inviteUserSchema>;
export type EditUserInput = z.infer<typeof editUserSchema>;
