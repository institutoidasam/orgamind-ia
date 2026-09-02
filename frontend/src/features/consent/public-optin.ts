import { useMutation, useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { api } from '@/lib/api-client';

/**
 * C4 — a landing pública `/opt-in` (spec §3.2).
 *
 * As duas únicas rotas do orgamind que respondem sem login. O que a página exibe
 * ao lado do checkbox NÃO é copy do frontend: é o corpo do `ConsentText`
 * VERSIONADO da finalidade, servido pelo backend. É de propósito — o corpo é a
 * prova (art. 8º §2º), e uma prova que o React pode reescrever num deploy não
 * prova nada em 2028.
 */
export const publicConsentTextSchema = z.object({
  purposeKey: z.string(),
  purposeLabel: z.string(),
  /** Versão do texto canônico exibido — vai gravada em cada consentimento. */
  version: z.string(),
  /** Corpo canônico já renderizado (com a URL da política resolvida). */
  body: z.string(),
});
export type PublicConsentText = z.infer<typeof publicConsentTextSchema>;

/**
 * `suppressed` = o número pediu PARAR. A landing NÃO o ressuscita: um formulário
 * aberto não prova posse do número, e qualquer um digitaria o telefone de um
 * terceiro para reinscrevê-lo. O retorno vem com a instrução de voltar pelo
 * WhatsApp, que é o canal autenticado por posse.
 */
export const publicOptInResultSchema = z.object({
  status: z.enum(['ok', 'suppressed']),
  message: z.string(),
});
export type PublicOptInResult = z.infer<typeof publicOptInResultSchema>;

export type PublicOptInInput = {
  phone: string;
  name?: string;
  purposeKey: string;
  accepted: boolean;
  /** Honeypot: sempre vazio num humano. Ver opt-in-form.tsx. */
  website?: string;
  /** ISO — quando a página renderizou o texto (evidência + time-to-submit). */
  renderedAt?: string;
};

export function usePublicConsentText(purposeKey: string) {
  return useQuery({
    queryKey: ['public', 'consent-text', purposeKey] as const,
    queryFn: async () =>
      publicConsentTextSchema.parse(
        await api.get('public/consent-text', { searchParams: { purposeKey } }).json(),
      ),
    // Uma finalidade inexistente é 404 e continua 404 — retentar só atrasa a tela
    // de erro para quem abriu um QR com o link errado.
    retry: false,
    staleTime: 10 * 60_000,
  });
}

export function usePublicOptIn() {
  return useMutation({
    mutationFn: async (input: PublicOptInInput) =>
      publicOptInResultSchema.parse(await api.post('public/opt-in', { json: input }).json()),
  });
}
