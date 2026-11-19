import { useQuery, useMutation, useQueryClient, queryOptions } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import type {
  Template,
  CreateTemplate,
  UpdateTemplate,
  ZernioButtonRoleValue,
} from './schemas';

import type { ChannelProvider } from '@/features/whatsapp/api';

export const templatesQueries = {
  // Templates are provider-owned (multi-provider): the campaign wizard and the
  // templates page scope the list to one provider; omit for the full list.
  list: (provider?: ChannelProvider) =>
    queryOptions({
      queryKey: ['templates', { provider: provider ?? null }],
      queryFn: () =>
        api
          .get('templates', provider ? { searchParams: { provider } } : undefined)
          .json<Template[]>(),
    }),
};

export function useTemplates(provider?: ChannelProvider) {
  return useQuery(templatesQueries.list(provider));
}

export function useCreateTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateTemplate): Promise<Template> =>
      api.post('templates', { json: input }).json<Template>(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['templates'] }),
  });
}

export function useUpdateTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      input,
    }: {
      id: string;
      input: UpdateTemplate;
    }): Promise<Template> =>
      api.patch(`templates/${id}`, { json: input }).json<Template>(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['templates'] }),
  });
}

/**
 * PATCH /templates/:id/consent-buttons — diz o que cada botão de resposta rápida
 * de um template IMPORTADO do painel do Zernio significa.
 *
 * Do rótulo sozinho é indecidível se "Bora, quero!" é um botão comum ou o "sim"
 * de um opt-in — e a diferença é 13.400 consentimentos documentados ou zero. Até
 * alguém declarar, o gate de campanha recusa o template. O backend REJEITA uma
 * declaração que o reconhecedor desmente (marcar "Bora, quero!" como opt-in não
 * faz o clique passar a ser lido).
 */
export function useDeclareConsentButtons() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: {
      id: string;
      buttons: Array<{ text: string; role: ZernioButtonRoleValue }>;
    }): Promise<Template> =>
      api
        .patch(`templates/${args.id}/consent-buttons`, {
          json: { buttons: args.buttons },
        })
        .json<Template>(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['templates'] }),
  });
}

export function useDeleteTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string): Promise<Template> =>
      api.delete(`templates/${id}`).json<Template>(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['templates'] }),
  });
}
