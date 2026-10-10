import { z } from "zod";

export const loginInputSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, "Credenciais inválidas").max(200),
});

export const loginResponseSchema = z.object({
  accessToken: z.string(),
  mustChangePassword: z.boolean(),
  user: z.object({
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
  }),
});

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, "Obrigatório"),
    newPassword: z.string().min(8, "Mínimo 8 caracteres").max(200),
    confirmPassword: z.string(),
  })
  .refine((d) => d.newPassword === d.confirmPassword, {
    message: "As senhas não coincidem",
    path: ["confirmPassword"],
  });

export type LoginInput = z.infer<typeof loginInputSchema>;
export type LoginResponse = z.infer<typeof loginResponseSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
