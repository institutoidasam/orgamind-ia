import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { api } from '@/lib/api-client';

/**
 * C3 — pontos de coleta wa.me/QR (spec §3.1).
 *
 * Cada linha é um cartaz/prancheta/bio/anúncio, identificado por um TOKEN DE
 * ORIGEM legível (`FEIRA-MANAUS-2026`). O link que o painel mostra — e que o QR
 * carrega — tem como texto pré-preenchido a própria DECLARAÇÃO DE CONSENTIMENTO
 * da finalidade: quem toca em "enviar" pratica o ato afirmativo, e o inbound
 * chega com um `wamid` verificável na Twilio.
 *
 * `grants` é o funil: quantos consentimentos já vieram DESTE token. Um QR de
 * feira com muitos inbounds e poucos GRANTs significa que o titular está
 * apagando o texto antes de enviar — problema de copy, não de canal (spec §7).
 */
export const optInLinkSchema = z.object({
  id: z.string(),
  token: z.string(),
  purposeKey: z.string(),
  purposeLabel: z.string(),
  consentTextVersion: z.string(),
  /** O texto que o wa.me pré-preenche — e que o inbound tem de CASAR. */
  expectedText: z.string(),
  /** `https://wa.me/<digits>?text=…` — é isto que vira o QR Code. */
  url: z.string(),
  senderDigits: z.string(),
  channelId: z.string().nullable(),
  channelName: z.string().nullable(),
  description: z.string().nullable(),
  active: z.boolean(),
  grants: z.number(),
  createdAt: z.coerce.date(),
});
export type OptInLink = z.infer<typeof optInLinkSchema>;

const optInLinkListSchema = z.array(optInLinkSchema);

export type CreateOptInLinkInput = {
  token: string;
  purposeKey: string;
  channelId: string;
  description?: string;
};

export function useOptInLinks() {
  return useQuery({
    queryKey: ['consent', 'links'] as const,
    queryFn: async () => optInLinkListSchema.parse(await api.get('consent/links').json()),
  });
}

export function useCreateOptInLink() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateOptInLinkInput) =>
      optInLinkSchema.parse(await api.post('consent/links', { json: input }).json()),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['consent', 'links'] }),
  });
}

/**
 * Desativar tira o cartaz de circulação para inbounds FUTUROS. Não invalida
 * nenhum consentimento já colhido por ele — revogar ≠ apagar, e o ponto de
 * coleta é parte da trilha de prova. Por isso não existe "excluir".
 */
export function useSetOptInLinkActive() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, active }: { id: string; active: boolean }) =>
      optInLinkSchema.parse(await api.patch(`consent/links/${id}`, { json: { active } }).json()),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['consent', 'links'] }),
  });
}
