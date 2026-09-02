import { useQuery, useMutation, useQueryClient, queryOptions } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import type {
  Template,
  SyncTemplatesResponse,
  CreateTemplate,
  UpdateTemplate,
  ZernioButtonRoleValue,
} from './schemas';
import type {
  CreateTwilioTemplateInput,
  UpdateTwilioDraftInput,
} from './twilio-schemas';
import {
  consentButtonChoicesSchema,
  type CreateZernioTemplateInput,
} from './zernio-schemas';

import type { ChannelProvider } from '@/features/whatsapp/api';

// Not exported from './schemas' (out of scope for this change) — the Zernio
// sync response additionally reports `skipped` (bad items don't abort the
// sync; see TemplatesService.syncFromZernio), unlike the Meta sync's
// `SyncTemplatesResponse`.
type SyncZernioTemplatesResponse = { synced: number; skipped: number };

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

export function useSyncTemplates() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (): Promise<SyncTemplatesResponse> =>
      api.post('templates/sync').json<SyncTemplatesResponse>(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['templates'] }),
  });
}

// Zernio equivalent of useSyncTemplates — the Zernio sync also reports how
// many items were skipped (bad items don't abort the sync; see
// TemplatesService.syncFromZernio), so the response carries `skipped` too.
export function useSyncZernioTemplates() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (): Promise<SyncZernioTemplatesResponse> =>
      api.post('templates/sync/zernio').json<SyncZernioTemplatesResponse>(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['templates'] }),
  });
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

// ── twilio-platform T5 — Content API (criar/submeter/editar rascunho) ───────
// Endpoints ADMIN do backend (templates.controller.ts): o response dos três é
// o row Template atualizado; a lista é invalidada para o badge/raw refletir.

/** POST /templates/twilio — cria o RASCUNHO na Twilio + row local (raw 'draft'). */
export function useCreateTwilioTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateTwilioTemplateInput): Promise<Template> =>
      api.post('templates/twilio', { json: input }).json<Template>(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['templates'] }),
  });
}

/** POST /templates/:id/twilio-submit — submete o rascunho à aprovação (irreversível). */
export function useSubmitTwilioTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string): Promise<Template> =>
      api.post(`templates/${id}/twilio-submit`).json<Template>(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['templates'] }),
  });
}

/** PATCH /templates/:id/twilio-draft — edita o rascunho (nome/idioma imutáveis). */
export function useUpdateTwilioDraft() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      input,
    }: {
      id: string;
      input: UpdateTwilioDraftInput;
    }): Promise<Template> =>
      api.patch(`templates/${id}/twilio-draft`, { json: input }).json<Template>(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['templates'] }),
  });
}

// ── ZB — criar template COM BOTÕES no Zernio ────────────────────────────────

/**
 * A lista FECHADA de rótulos de consentimento que o sistema reconhece.
 *
 * Buscada, nunca copiada. O clique de opt-in só é reconhecível pelo RÓTULO (o
 * Zernio não transporta payload de botão), então a lista que o form oferece TEM
 * de ser a lista que o webhook entende. Uma cópia no frontend divergiria em
 * silêncio — e "em silêncio" aqui significa 13.400 consentimentos que não foram
 * gravados.
 *
 * `staleTime: Infinity` — é um vocabulário, só muda em deploy.
 */
export function useConsentButtonChoices() {
  return useQuery({
    queryKey: ['templates', 'consent-buttons'] as const,
    queryFn: async () => {
      const json = await api.get('templates/consent-buttons').json();
      return consentButtonChoicesSchema.parse(json);
    },
    staleTime: Infinity,
    gcTime: Infinity,
    retry: 1,
  });
}

/**
 * POST /templates/zernio — cria o template DE VERDADE na Meta (via Zernio) e a
 * row local, PENDENTE de aprovação. O backend revalida os rótulos contra o
 * reconhecedor: a UI é conveniência, o servidor é a garantia.
 */
export function useCreateZernioTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateZernioTemplateInput): Promise<Template> =>
      api.post('templates/zernio', { json: input }).json<Template>(),
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
