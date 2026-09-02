import { z } from 'zod';

/**
 * A identidade da organização titular deste deploy (§ identidade da organização).
 *
 * O orgamind é single-tenant POR INSTALAÇÃO: um deploy por cliente, uma
 * organização por deploy. A identidade é semeada do env (`ORG_NAME`,
 * `ORG_LEGAL_NAME`, …) e daqui em diante é editável pelo operador — porque é ela
 * que vai para o TITULAR dos dados: no texto de consentimento, na landing de
 * opt-in e no texto pré-preenchido do wa.me/QR.
 */

/** Vazio é AUSENTE: o `<input>` da tela manda `''` quando o operador limpa. */
const optionalText = (max: number) =>
  z.preprocess(
    (v) => (typeof v === 'string' && v.trim().length === 0 ? null : v),
    z.string().trim().max(max).nullable().optional(),
  );

export const updateOrganizationSchema = z
  .object({
    /** Nome curto — o rótulo do dia a dia (cabeçalho da landing, wa.me). */
    name: z
      .string()
      .trim()
      .min(1, 'Informe o nome da organização.')
      .max(120)
      .optional(),
    /**
     * Razão social por extenso. É ela que a Meta quer no texto de opt-in
     * (*"clearly state the business's name"*) e a que identifica o CONTROLADOR
     * perante a LGPD. Confira contra o CNPJ.
     */
    legalName: z
      .string()
      .trim()
      .min(1, 'Informe a razão social por extenso.')
      .max(240)
      .optional(),
    /** Substitui `{url}` no texto de consentimento quando presente. */
    privacyPolicyUrl: z.preprocess(
      (v) => (typeof v === 'string' && v.trim().length === 0 ? null : v),
      z
        .string()
        .trim()
        .url('A política de privacidade precisa ser uma URL (https://…).')
        .max(500)
        .nullable()
        .optional(),
    ),
    /** Canal por onde o titular fala com a organização (e-mail, telefone…). */
    supportContact: optionalText(200),
  })
  // O id do singleton não se troca, e nada além da identidade entra aqui.
  .strip();

export type UpdateOrganization = z.infer<typeof updateOrganizationSchema>;
