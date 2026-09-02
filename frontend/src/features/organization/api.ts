import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { api } from '@/lib/api-client';

/**
 * A identidade da organização TITULAR deste deploy.
 *
 * O orgamind nasceu para uma organização só e carregava o nome dela HARDCODED nos
 * textos que vão para o titular dos dados — o texto de consentimento, a landing
 * pública `/opt-in`, o texto do wa.me/QR. Isso não é copy: a Meta exige que o
 * texto de opt-in nomeie o negócio e a LGPD exige controlador determinado (art.
 * 8º). Um titular do cliente A autorizando "a organização B" produz um
 * consentimento incoerente — colhido de gente real.
 *
 * Aqui a identidade é CONFIGURAÇÃO: um singleton (o orgamind é single-tenant por
 * instalação), semeado do env e editável em Configurações.
 */
export const organizationSchema = z.object({
  id: z.string(),
  /** Nome curto — o rótulo do dia a dia (cabeçalho da landing, mensagens). */
  name: z.string(),
  /** Razão social por extenso — é ela que vai DENTRO do texto de consentimento. */
  legalName: z.string(),
  privacyPolicyUrl: z.string().nullable(),
  supportContact: z.string().nullable(),
});
export type Organization = z.infer<typeof organizationSchema>;

export type UpdateOrganizationInput = {
  name?: string;
  legalName?: string;
  privacyPolicyUrl?: string | null;
  supportContact?: string | null;
};

const ORGANIZATION_KEY = ['organization'] as const;

/** ADMIN — a tela de Configurações. */
export function useOrganization() {
  return useQuery({
    queryKey: ORGANIZATION_KEY,
    queryFn: async () =>
      organizationSchema.parse(await api.get('organization').json()),
  });
}

/**
 * Salvar NÃO reescreve consentimento nenhum: os `ConsentText` publicados e os
 * eventos já colhidos seguem apontando para o texto que a pessoa leu — é o que
 * os torna prova (art. 8º §2º). Para colher sob o nome novo, o operador publica
 * uma versão NOVA do texto (Opt-in → Finalidades → Texto), que já vem sugerida
 * com esta identidade.
 */
export function useUpdateOrganization() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: UpdateOrganizationInput) =>
      organizationSchema.parse(
        await api.patch('organization', { json: input }).json(),
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ORGANIZATION_KEY });
      // O rascunho de texto sugerido ao admin é composto com esta identidade.
      qc.invalidateQueries({ queryKey: ['consent', 'purposes'] });
    },
  });
}

/**
 * A MESMA identidade, sem login — a landing `/opt-in` é aberta no celular de
 * quem não tem conta no orgamind (QR de cartaz) e precisa nomear a organização no
 * cabeçalho, no título e até na tela de erro. Não há segredo: esta identidade
 * está impressa no cartaz que gerou o QR.
 */
export function usePublicOrganization() {
  return useQuery({
    queryKey: ['public', 'organization'] as const,
    queryFn: async () =>
      organizationSchema.parse(await api.get('public/organization').json()),
    staleTime: 10 * 60_000,
    retry: false,
  });
}
