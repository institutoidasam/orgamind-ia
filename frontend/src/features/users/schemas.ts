import { z } from "zod";
import {
  authorizationChoiceError,
  contactAuthorizationSchema,
  type AuthorizationChoice,
} from "@/features/people-record/authorization";
import { reasonSchema } from "@/features/people-record/reason";

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

const emailSchema = z.string().trim().email("Email inválido");
const jobTitleSchema = z.string().trim().max(80, "Use até 80 caracteres");

const registrationSchema = z.string().trim().max(30, "Use até 30 caracteres");

/** Espelho de C4 (entrada): `CADASTRO_ANTERIOR` não existe aqui, só a migração o grava. */
const contactAuthorizationInputSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("NAO_AUTORIZADO") }),
  z.object({
    status: z.literal("AUTORIZADO"),
    source: z.enum(["TERMO_ASSINADO", "FICHA_ADMISSAO", "ACEITE_WHATSAPP", "OUTRO"]),
    note: z.string().max(120).optional(),
    date: z.string().optional(),
  }),
]);

/** Escolha da tela (nada escolhido = `null`); a regra de validade fica em `authorizationChoiceError`. */
const authorizationChoiceSchema = z.custom<AuthorizationChoice>().nullable();

const levelRefSchema = z.object({
  id: z.string(),
  name: z.string(),
  isActive: z.boolean(),
});

const sectorRefSchema = z.object({
  id: z.string(),
  name: z.string(),
  code: z.string(),
  isActive: z.boolean().default(true),
});

export const userSummarySchema = z.object({
  id: z.string(),
  // Pessoa sem acesso: sem e-mail (e o perfil gravado é só o padrão).
  email: z.string().email().nullable(),
  hasAccess: z.boolean(),
  name: z.string().nullable(),
  role: z.enum(["ADMIN", "SUPERVISOR", "OPERATOR", "VIEWER"]),
  sectorId: z.string().nullable().optional().default(null),
  sector: sectorRefSchema
    .nullable()
    .optional()
    .default(null),
  shiftId: z.string().nullable().optional().default(null),
  jobTitle: z.string().nullable().optional().default(null),
  registration: z.string().nullable().optional().default(null),
  contactAuthorization: contactAuthorizationSchema,
  levelId: z.string().nullable().optional().default(null),
  level: levelRefSchema.nullable().optional().default(null),
  isActive: z.boolean().optional().default(true),
  lastLoginAt: z.string().nullable(),
  phoneE164: z.string().nullable(),
  createdAt: z.string(),
  createdBy: z.object({ email: z.string().nullable() }).nullable(),
});

export const userListResponseSchema = z.object({
  data: userSummarySchema.array(),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
  authorizationCounts: z
    .object({ unverified: z.number().int().nonnegative(), notAuthorized: z.number().int().nonnegative() }),
});

const roleSchema = z.enum(["ADMIN", "SUPERVISOR", "OPERATOR", "VIEWER"]);

/**
 * Cadastro de pessoa. Com acesso: e-mail e perfil, setor obrigatório fora do
 * ADMIN. Sem acesso: só nome e telefone são obrigatórios; e-mail e perfil não
 * existem (o payload os omite, ver invite-payload.ts).
 */
export const inviteUserSchema = z
  .object({
    hasAccess: z.boolean().default(true),
    email: z.string().optional(),
    name: z.string().max(120).optional(),
    phone: requiredPhone,
    role: roleSchema.default("OPERATOR"),
    sectorId: z.string().nullable().optional(),
    shiftId: z.string().nullable().optional(),
    jobTitle: jobTitleSchema.optional(),
    levelId: z.string().nullable().optional(),
    registration: registrationSchema.optional(),
    authorization: authorizationChoiceSchema.default(null),
  })
  .superRefine((value, ctx) => {
    addAuthorizationIssue(ctx, value.authorization, true);
    if (!value.hasAccess) {
      if (!value.name?.trim()) {
        ctx.addIssue({ code: "custom", path: ["name"], message: "Informe o nome" });
      }
      return;
    }
    if (!emailSchema.safeParse(value.email).success) {
      ctx.addIssue({ code: "custom", path: ["email"], message: "Email inválido" });
    }
    if (value.role !== "ADMIN" && !value.sectorId) {
      ctx.addIssue({
        code: "custom",
        path: ["sectorId"],
        message: "Selecione o setor principal",
      });
    }
  });

/** Cadastro exige escolher; na edição `null` é "sem mudança" e só a escolha feita é validada. */
function addAuthorizationIssue(ctx: z.RefinementCtx, choice: AuthorizationChoice | null, required: boolean) {
  if (choice === null && !required) return;
  const message = authorizationChoiceError(choice);
  if (message) ctx.addIssue({ code: "custom", path: ["authorization"], message });
}

/** Dar acesso a quem já está cadastrado: e-mail e perfil. */
export const grantAccessSchema = z.object({
  email: emailSchema,
  role: roleSchema.default("OPERATOR"),
});

export const editUserSchema = z.object({
  name: z.string().max(120).optional(),
  role: z.enum(["ADMIN", "SUPERVISOR", "OPERATOR", "VIEWER"]).optional(),
  sectorId: z.string().nullable().optional(),
  shiftId: z.string().nullable().optional(),
  jobTitle: jobTitleSchema.nullable().optional(),
  levelId: z.string().nullable().optional(),
  phone: z.string().optional(),
  registration: registrationSchema.nullable().optional(),
  contactAuthorization: contactAuthorizationInputSchema.optional(),
  reason: z.string().max(200).optional(),
});

/**
 * Quem já tem telefone pode trocar, não apagar; quem não tem pode continuar sem.
 * Pessoa sem acesso também não fica sem nome (o servidor recusa).
 */
export const editUserSchemaFor = (hadPhone: boolean, hasAccess = true) =>
  editUserSchema
    .extend({
      phone: hadPhone ? requiredPhone : optionalPhone,
      reason: reasonSchema,
      authorization: authorizationChoiceSchema.default(null),
    })
    .superRefine((value, ctx) => {
      if (!hasAccess && !value.name?.trim()) {
        ctx.addIssue({ code: "custom", path: ["name"], message: "Informe o nome" });
      }
      addAuthorizationIssue(ctx, value.authorization, false);
    });

export type UserSummary = z.infer<typeof userSummarySchema>;
export type InviteUserInput = z.infer<typeof inviteUserSchema>;
export type InviteUserOutput = z.output<typeof inviteUserSchema>;
export type GrantAccessOutput = z.output<typeof grantAccessSchema>;
export type EditUserInput = z.infer<typeof editUserSchema>;
/** Valores do formulário de edição: o corpo do PATCH mais a escolha de autorização (só da tela). */
export type EditUserFormValues = EditUserInput & { authorization?: AuthorizationChoice | null };
