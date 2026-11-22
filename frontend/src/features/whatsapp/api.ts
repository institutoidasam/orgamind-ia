import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { api } from '@/lib/api-client';
import { sectorsKey } from '@/features/internal-admin/api';
import {
  channelSectorSchema,
  instanceSchema,
  instanceQrSchema,
  type Instance,
  type CreateInstanceInput,
} from './schemas';

export type WhatsappLabel = {
  id: string;
  name: string;
  /** Evolution can return either a string-encoded code or a number. */
  color: string | number;
};

/**
 * Criar ou remover um número muda o número de áreas (criar associa; remover as
 * deixa sem número): a lista do número e os setores (selo e aviso) recarregam.
 */
function refreshWithSectors(qc: QueryClient, key: readonly string[]) {
  return Promise.all([
    qc.invalidateQueries({ queryKey: key }),
    qc.invalidateQueries({ queryKey: sectorsKey }),
  ]);
}

export function useWhatsappLabels() {
  return useQuery({
    queryKey: ['whatsapp', 'labels'] as const,
    queryFn: () =>
      api.get('whatsapp/labels').json<WhatsappLabel[]>(),
  });
}

// ---------------------------------------------------------------------------
// Multi-instance CRUD hooks (Fase 5)
// ---------------------------------------------------------------------------

const instanceListSchema = z.array(instanceSchema);

export function useInstances() {
  return useQuery({
    queryKey: ['whatsapp', 'instances'],
    queryFn: async () => {
      const json = await api.get('whatsapp/instances').json();
      return instanceListSchema.parse(json);
    },
    // Keep the connected-instance list (used by the inbox tab bar) reasonably
    // fresh in long-lived views; the list is small so 30s polling is cheap.
    refetchInterval: 30_000,
  });
}

export function useCreateInstance() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateInstanceInput) => {
      const json = await api.post('whatsapp/instances', { json: input }).json();
      return instanceSchema.parse(json);
    },
    onSuccess: () => refreshWithSectors(qc, ['whatsapp', 'instances']),
  });
}

export function useUpdateInstance(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: Partial<Instance>) => {
      const json = await api.patch(`whatsapp/instances/${id}`, { json: input }).json();
      return instanceSchema.parse(json);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['whatsapp', 'instances'] }),
  });
}

export function useSetDefaultInstance() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await api.patch(`whatsapp/instances/${id}`, { json: { isDefault: true } });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['whatsapp', 'instances'] }),
  });
}

export function useDeleteInstance() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await api.delete(`whatsapp/instances/${id}`);
    },
    onSuccess: () => refreshWithSectors(qc, ['whatsapp', 'instances']),
  });
}

export function useRestartInstance() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await api.post(`whatsapp/instances/${id}/restart`);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['whatsapp', 'instances'] }),
  });
}

/**
 * Poll every 3s WHILE waiting for the scan, but STOP once the instance is
 * connected. The backend's /qr endpoint calls Evolution's /instance/connect
 * whenever the state isn't 'open' (its QR cache is stale) — and that spawns a
 * fresh Baileys socket. If we kept polling after a paired session merely blips
 * to 'connecting' (a normal reconnect), each poll would spawn a competing
 * socket → a `conflict/replaced` storm that destroys the session instead of
 * letting Baileys resume it. Stopping at 'open' lets a transient reconnect heal
 * on its own. Exported for unit testing.
 */
export function qrRefetchInterval(state: string | undefined): number | false {
  return state === 'open' ? false : 3_000;
}

export function useInstanceQr(id: string | undefined) {
  return useQuery({
    queryKey: ['whatsapp', 'instances', id, 'qr'],
    enabled: !!id,
    queryFn: async () => {
      const json = await api.get(`whatsapp/instances/${id}/qr`).json();
      return instanceQrSchema.parse(json);
    },
    refetchInterval: (query) => qrRefetchInterval(query.state.data?.state),
  });
}

// ---------------------------------------------------------------------------
// Multi-provider channels (Fase multi-provider — F1)
// ---------------------------------------------------------------------------
//
// `ChannelProvider` is the UPPERCASE enum mirroring Prisma's
// `ChannelProvider { EVOLUTION TWILIO ZERNIO META GOZAP }`: each configured
// channel declares its own provider, and a deploy can have channels across
// several providers at once — there is no single deploy-global "the" provider
// (the legacy lowercase `useProvider()` hook backed by that model was removed
// in F6).

export const CHANNEL_PROVIDERS = ['EVOLUTION', 'TWILIO', 'ZERNIO', 'META', 'GOZAP'] as const;
export type ChannelProvider = (typeof CHANNEL_PROVIDERS)[number];

const channelSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  phoneE164: z.string().nullable(),
  isActive: z.boolean(),
  isDefault: z.boolean(),
  provider: z.enum(CHANNEL_PROVIDERS),
  /**
   * ZERNIO — a campanha sai como BROADCAST nativo (e aparece no painel do
   * Zernio)? Sem estes dois campos a tela Canais não teria como MOSTRAR o estado
   * da flag, e ligá-la seguiria exigindo SQL direto em produção.
   *
   * Opcionais porque só o ZERNIO os tem; um canal TWILIO simplesmente não os traz.
   */
  zernioBroadcastEnabled: z.boolean().optional(),
  /** Destinatários por requisição ao Zernio (1..100, default 50). */
  zernioBroadcastChunk: z.number().optional(),
  /**
   * ZERNIO — a conta WhatsApp por trás do canal. É com isto que o form de
   * cadastro marca "já cadastrada" no seletor de contas, em vez de deixar o
   * operador descobrir a duplicata só no erro do submit.
   */
  zernioAccountId: z.string().nullable().optional(),
  /**
   * T15 — a quota de HOJE do canal, para TODO provedor. Espelha
   * `channelSummarySchema` do backend (instance.schema.ts) — contrato duro.
   * `GET /whatsapp/instances` (useInstances) só cobre EVOLUTION; o wizard e
   * o cabeçalho de progresso resolviam o canal por ali, então GOZAP (o canal
   * de PRODUÇÃO)/ZERNIO/TWILIO/META nunca tinham quota nenhuma — ver
   * `resolveCampaignChannel` (features/campaigns/resolve-channel.ts).
   *
   * Opcionais aqui de propósito, espelhando o backend: o service SEMPRE os
   * preenche, mas o contrato não pode quebrar um payload mais antigo.
   */
  dailySendLimit: z.number().optional(),
  sentToday: z.number().optional(),
  sentTodayResetAt: z.string().nullable().optional(),
  warmupEffectiveCap: z.number().optional(),
  warming: z.boolean().optional(),
  warmupDay: z.number().optional(),
  /**
   * O estado de conexão mais recente do canal — "conectado"/"conectando"/
   * "desconectado" na tela Canais. `null`/ausente para um canal sem sessão
   * (TWILIO/ZERNIO/META) ou que nunca completou um ciclo de conexão; nunca
   * tratar ausência como "desconectado".
   */
  connectionState: z.enum(['open', 'connecting', 'close']).nullable().optional(),
  /** As áreas ativas que o número atende (C1); o back sempre preenche em GoZap/Evolution. */
  sectors: z.array(channelSectorSchema).optional(),
});
export type ChannelSummary = z.infer<typeof channelSummarySchema>;

const providerTraitsSchema = z.object({
  official: z.boolean(),
  sessionBased: z.boolean(),
  sessionWindow: z.boolean(),
});
export type ProviderTraits = z.infer<typeof providerTraitsSchema>;

/**
 * Um número de integração desligada (C3) — só o ADMIN recebe; os demais papéis
 * recebem `[]`. Espelha `disabledChannelSchema` do backend (instance.schema.ts).
 */
const disabledChannelSchema = z.object({
  id: z.string(),
  name: z.string(),
  provider: z.enum(CHANNEL_PROVIDERS),
  phoneE164: z.string().nullable(),
  sectorNames: z.array(z.string()),
});
export type DisabledChannel = z.infer<typeof disabledChannelSchema>;

const providersResponseSchema = z.object({
  providers: z.array(
    z.object({
      provider: z.enum(CHANNEL_PROVIDERS),
      traits: providerTraitsSchema,
      capabilities: z.array(z.string()),
      channels: z.array(channelSummarySchema),
    }),
  ),
  /** `.default([])` tolera a api antiga durante o deploy (C3). */
  disabledChannels: z.array(disabledChannelSchema).default([]),
});
export type ProvidersResponse = z.infer<typeof providersResponseSchema>;

/**
 * All configured channels grouped by provider. Backs the topbar's provider
 * scope selector (only shown when 2+ providers are configured) and any
 * future provider-aware screens (F2–F5).
 */
export function useProviders(options?: {
  refetchInterval?: number | false;
  /**
   * T15 fix round 1 (#2, review Opus) — `staleTime: Infinity` (abaixo) é
   * certo para o caso comum (a lista de provedores só muda no redeploy), mas
   * os campos de QUOTA (`sentToday`/`sentTodayResetAt`, T15) mudam a cada
   * disparo. Um consumidor que precisa da quota FRESCA no momento em que
   * monta (o cabeçalho de progresso, o passo final do assistente) passa
   * `refetchOnMount: 'always'` para forçar essa busca sem mexer no
   * `staleTime` global (que continua evitando refetch à toa no seletor de
   * canal / topbar).
   */
  refetchOnMount?: boolean | 'always';
  staleTime?: number;
}) {
  return useQuery({
    queryKey: ['whatsapp', 'providers'] as const,
    queryFn: async () => {
      const json = await api.get('whatsapp/providers').json();
      return providersResponseSchema.parse(json);
    },
    // The configured-provider set only changes on redeploy (env-driven) —
    // don't refetch on every topbar remount/refocus. `refetchInterval` is an
    // explicit per-consumer opt-in (T15 — the campaign progress header polls
    // this SAME query at 30s so the channel's quota keeps advancing while the
    // page is open; every other caller keeps the default of no polling).
    staleTime: options?.staleTime ?? Infinity,
    gcTime: Infinity,
    refetchInterval: options?.refetchInterval,
    refetchOnMount: options?.refetchOnMount,
  });
}

export type ProviderInfo = { traits: ProviderTraits; capabilities: string[] };

/**
 * Traits + capabilities do provider vindos do BACKEND (fonte única — o
 * espelho manual official-providers.ts morreu no F0). Um hook só: traits e
 * capabilities vêm da MESMA resposta da MESMA query — dois hooks separados
 * criariam dois estados de "desconhecido" que só ficariam em sincronia por
 * coincidência. `undefined` enquanto carrega ou para provider desconhecido;
 * quem consome decide o fallback seguro.
 */
export function useProviderInfo(
  provider: ChannelProvider | undefined,
): ProviderInfo | undefined {
  const { data } = useProviders();
  if (!provider) return undefined;
  const entry = data?.providers.find((p) => p.provider === provider);
  if (!entry) return undefined;
  return { traits: entry.traits, capabilities: entry.capabilities };
}

/**
 * O que muda quando o conjunto de áreas de um número muda (ou o número sai):
 * as duas listas de conexões, os setores e as pessoas por área.
 */
function invalidateChannelCaches(qc: QueryClient) {
  return Promise.all([
    qc.invalidateQueries({ queryKey: ['whatsapp', 'providers'] }),
    qc.invalidateQueries({ queryKey: ['whatsapp', 'instances'] }),
    qc.invalidateQueries({ queryKey: sectorsKey }),
    qc.invalidateQueries({ queryKey: ['sector-people'] }),
  ]);
}

const channelSectorsResultSchema = z.object({
  channelId: z.string(),
  sectors: z.array(channelSectorSchema),
  moved: z.array(z.object({ sectorId: z.string(), fromChannelId: z.string() })),
});
export type ChannelSectorsResult = z.infer<typeof channelSectorsResultSchema>;

/**
 * Define as áreas que o número atende — PUT /whatsapp/channels/:id/sectors
 * `{ sectorIds }` (só o ADMIN; GoZap e Evolution). A lista é o conjunto final:
 * área fora dela que estava neste número fica sem número. Invalida as listas de
 * conexões (as duas) e os setores, que mostram o número de cada área.
 */
export function useUpdateChannelSectors() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ channelId, sectorIds }: { channelId: string; sectorIds: string[] }) => {
      const json = await api.put(`whatsapp/channels/${channelId}/sectors`, { json: { sectorIds } }).json();
      return channelSectorsResultSchema.parse(json);
    },
    onSuccess: () => invalidateChannelCaches(qc),
  });
}

/**
 * Remove um número DESLIGADO — DELETE /whatsapp/channels/:id (só o ADMIN; 204).
 * Desativa o canal, solta as áreas ligadas a ele (ficam sem número) e falha as
 * mensagens paradas; não apaga nada no provedor. Invalida as mesmas chaves que
 * `useUpdateChannelSectors`: o bloco "Números desligados", as conexões, os
 * setores (selo e aviso de área sem número) e as pessoas por área.
 */
export function useRemoveDisabledChannel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await api.delete(`whatsapp/channels/${id}`);
    },
    onSuccess: () => invalidateChannelCaches(qc),
  });
}
