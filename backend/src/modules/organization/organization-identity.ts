/**
 * A identidade da organização TITULAR deste deploy — como CONFIGURAÇÃO.
 *
 * O orgamind nasceu para uma organização só e carregava o nome dela HARDCODED nos
 * textos que vão para o titular dos dados. Isso não é um bug de copy: a Meta
 * exige que o texto de opt-in *"clearly state the business's name"* e a LGPD
 * exige finalidade e controlador determinados (art. 8º). Um titular do cliente A
 * autorizando "a organização B" produz um consentimento incoerente — colhido de
 * gente real, e descoberto só na fiscalização.
 *
 * O orgamind é **single-tenant por instalação** (um deploy por cliente): a
 * identidade é um singleton, semeada do env e editável na tela de Configurações.
 *
 * Este módulo é PURO de propósito: ele é importado tanto pelo app (Nest) quanto
 * pelo `prisma/seed.ts` (tsx, sem container de DI).
 */

export type OrgIdentity = {
  /** Nome curto, o rótulo do dia a dia. Ex.: "CONTINUUM". */
  name: string;
  /** Razão social por extenso — é ela que a Meta e a LGPD querem no texto. */
  legalName: string;
  privacyPolicyUrl: string | null;
  supportContact: string | null;
};

/**
 * Nunca o nome de outro cliente. Um deploy sem `ORG_NAME` fica genérico e
 * visivelmente por-configurar — o que é ruim, mas honesto. Herdar o nome do
 * primeiro cliente do sistema seria mentir para o titular.
 */
export const FALLBACK_ORG_NAME = 'Organização';

/** O compose repassa `${VAR:-}` como string vazia: vazio é AUSENTE, não valor. */
function present(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function organizationFromEnv(
  env: Record<string, unknown>,
): OrgIdentity {
  const name = present(env.ORG_NAME) ?? FALLBACK_ORG_NAME;
  return {
    name,
    // Sem razão social declarada, o nome curto responde por ela. O texto de
    // consentimento não pode ficar SEM organização nomeada — isso o invalida.
    legalName: present(env.ORG_LEGAL_NAME) ?? name,
    privacyPolicyUrl: present(env.ORG_PRIVACY_POLICY_URL),
    supportContact: present(env.ORG_SUPPORT_CONTACT),
  };
}
