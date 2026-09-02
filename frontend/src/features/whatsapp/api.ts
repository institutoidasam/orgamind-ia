import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { api } from '@/lib/api-client';
import { instanceSchema, instanceQrSchema, type Instance, type CreateInstanceInput } from './schemas';

export type WhatsappLabel = {
  id: string;
  name: string;
  /** Evolution can return either a string-encoded code or a number. */
  color: string | number;
};

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
    onSuccess: () => qc.invalidateQueries({ queryKey: ['whatsapp', 'instances'] }),
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
    onSuccess: () => qc.invalidateQueries({ queryKey: ['whatsapp', 'instances'] }),
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
});
export type ChannelSummary = z.infer<typeof channelSummarySchema>;

const providerTraitsSchema = z.object({
  official: z.boolean(),
  sessionBased: z.boolean(),
  sessionWindow: z.boolean(),
});
export type ProviderTraits = z.infer<typeof providerTraitsSchema>;

const providersResponseSchema = z.object({
  providers: z.array(
    z.object({
      provider: z.enum(CHANNEL_PROVIDERS),
      traits: providerTraitsSchema,
      capabilities: z.array(z.string()),
      channels: z.array(channelSummarySchema),
    }),
  ),
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
 * Um webhook que chegou, autenticou e foi DESCARTADO porque nenhum canal ativo
 * corresponde à conta/número que o enviou — ou seja, dados sendo perdidos agora.
 */
const webhookDropAlertSchema = z.object({
  provider: z.enum(CHANNEL_PROVIDERS),
  /** ZERNIO → o accountId; TWILIO → o número `To`. */
  accountRef: z.string(),
  totalCount: z.number(),
  events: z.array(z.string()),
  firstSeenAt: z.coerce.date(),
  lastSeenAt: z.coerce.date(),
});
export type WebhookDropAlert = z.infer<typeof webhookDropAlertSchema>;

const webhookDropsResponseSchema = z.object({
  drops: z.array(webhookDropAlertSchema),
});

/**
 * As contas órfãs: estamos recebendo eventos delas e não temos canal para
 * atendê-las. Backing do banner da página Canais.
 *
 * O incidente que originou isto: os webhooks de uma conta Zernio sem canal
 * chegavam, autenticavam e viravam `logger.warn` + HTTP 200. Um disparo real de
 * ~100 mensagens foi perdido e a interface não deu UM sinal. Por isso este query
 * faz polling: a perda em curso precisa aparecer na tela sozinha, sem um F5.
 */
export function useWebhookDrops() {
  return useQuery({
    queryKey: ['whatsapp', 'webhook-drops'] as const,
    queryFn: async () => {
      const json = await api.get('whatsapp/webhook-drops').json();
      return webhookDropsResponseSchema.parse(json);
    },
    refetchInterval: 60_000,
    retry: false,
  });
}

/**
 * Uma conta WhatsApp conectada no Zernio (GET /whatsapp/zernio/accounts). O `id`
 * é o `_id` da conta — exatamente o valor que vai em `zernioAccountId`.
 */
const zernioAccountSchema = z.object({
  id: z.string(),
  displayName: z.string().nullable(),
  phoneE164: z.string().nullable(),
  wabaId: z.string().optional(),
  qualityRating: z.string().optional(),
  messagingLimitTier: z.string().optional(),
  nameStatus: z.string().optional(),
});
export type ZernioAccount = z.infer<typeof zernioAccountSchema>;

const zernioAccountsResponseSchema = z.object({
  accounts: z.array(zernioAccountSchema),
  /** true = não deu para falar com o Zernio agora (≠ "você não tem contas"). */
  unavailable: z.boolean(),
});

/**
 * As contas Zernio disponíveis, para o SELETOR do form de canal ZERNIO.
 *
 * Existe por causa de um incidente: o `zernioAccountId` era digitado à mão, e um
 * id errado fazia o orgamind descartar em silêncio todos os webhooks daquela conta
 * (um disparo de ~100 mensagens foi perdido assim). Escolher da lista real torna
 * o erro de digitação impossível.
 */
export function useZernioAccounts(enabled = true) {
  return useQuery({
    queryKey: ['whatsapp', 'zernio', 'accounts'] as const,
    enabled,
    queryFn: async () => {
      const json = await api.get('whatsapp/zernio/accounts').json();
      return zernioAccountsResponseSchema.parse(json);
    },
    // A lista muda quando o cliente conecta/desconecta uma WABA no Zernio —
    // raro, mas não "nunca". 5 min é o suficiente para não repetir a chamada a
    // cada remount do form.
    staleTime: 5 * 60_000,
    retry: false,
  });
}

/**
 * ZB — a saúde de um canal cloud na Meta (GET /whatsapp/channels/health).
 * Espelha `channelHealthSchema` do backend
 * (backend/src/schemas/contracts/instance.schema.ts) — contrato duro.
 */
const channelHealthSchema = z.object({
  channelId: z.string(),
  channelName: z.string(),
  provider: z.enum(CHANNEL_PROVIDERS),
  zernioAccountId: z.string(),
  displayPhoneNumber: z.string().optional(),
  messagingLimitTier: z.string().optional(),
  tierLimit: z.number(),
  uniqueRecipients24h: z.number(),
  tierUsagePct: z.number(),
  nearTierLimit: z.boolean(),
  qualityRating: z.string().optional(),
  nameStatus: z.string().optional(),
  nameRejectionReason: z.string().optional(),
  canSendMessage: z.string().optional(),
  canSendMessageReason: z.string().optional(),
  stale: z.boolean(),
  syncedAt: z.coerce.date(),
});
export type ChannelHealth = z.infer<typeof channelHealthSchema>;

const channelHealthResponseSchema = z.object({
  channels: z.array(channelHealthSchema),
});

/**
 * A saúde dos canais cloud — o que o operador precisa ver ANTES de disparar.
 *
 * SEM `refetchInterval`, de propósito (≠ useWebhookDrops): cada leitura custa
 * requisições no balde do Zernio (60 req/min POR CHAVE) e esse balde é o MESMO
 * do envio. Um card de saúde em polling roubaria vazão da campanha que ele
 * existe para proteger. `staleTime` curto porque a informação (quanto do tier já
 * foi gasto) muda a cada disparo — mas só quando alguém está olhando.
 */
export function useChannelHealth(enabled = true) {
  return useQuery({
    queryKey: ['whatsapp', 'channels', 'health'] as const,
    enabled,
    queryFn: async () => {
      const json = await api.get('whatsapp/channels/health').json();
      return channelHealthResponseSchema.parse(json);
    },
    staleTime: 60_000,
    retry: false,
  });
}

/**
 * POST /whatsapp/channels payload. Mirrors the backend `createChannelSchema`
 * (backend/src/schemas/contracts/instance.schema.ts). EVOLUTION is a valid
 * enum member here but the backend rejects it with a PT-BR 400 — those
 * channels are provisioned through the instance/QR flow instead.
 *
 * `phoneE164` and `zernioAccountId` are both optional at this (payload-typing)
 * level: which one is actually required depends on `provider` (TWILIO needs
 * phoneE164, ZERNIO needs zernioAccountId — the number lives on the Zernio
 * account, not here). That per-provider requirement is enforced client-side
 * by `create-channel-form.tsx`'s own zod schema before the request is sent.
 */
export const createChannelInputSchema = z.object({
  provider: z.enum(CHANNEL_PROVIDERS),
  name: z.string(),
  phoneE164: z.string().optional(),
  twilioMessagingServiceSid: z.string().optional(),
  zernioAccountId: z.string().optional(),
});
export type CreateChannelInput = z.infer<typeof createChannelInputSchema>;

/**
 * Registers a cloud-provider (TWILIO/ZERNIO/META) channel via
 * POST /whatsapp/channels — no external provisioning, the number is already
 * live on the provider side. EVOLUTION is rejected by the backend (created via
 * the QR/instance flow). On success invalidates `['whatsapp','providers']` so
 * the Canais page's per-provider channel lists refetch.
 */
export function useCreateChannel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateChannelInput) =>
      api.post('whatsapp/channels', { json: input }).json<ChannelSummary>(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['whatsapp', 'providers'] }),
  });
}

// ---------------------------------------------------------------------------
// GoZap channel lifecycle (F-A Task 8) — GOZAP is session-based (QR pairing,
// same family as EVOLUTION/Baileys) but PROVISIONS EXTERNALLY: creating a
// channel makes the backend call out to the GoZap SaaS to spin up an
// instance, encrypt its token and arm the webhook (see POST /whatsapp/channels'
// GOZAP branch, whatsapp-providers.controller.ts). That's why creation only
// takes `name` — no phoneE164/zernioAccountId, which `createChannelSchema`'s
// `superRefine` already forbids for this provider — and why QR/remove get
// their own channel-scoped endpoints instead of reusing EVOLUTION's
// instance-scoped ones.
// ---------------------------------------------------------------------------

/**
 * Creates a GOZAP channel — POST /whatsapp/channels with `{ provider: 'GOZAP',
 * name }` only. Deliberately NOT built on top of `useCreateChannel`'s
 * `CreateChannelInput` (which carries optional phoneE164/zernioAccountId for
 * the no-provisioning cloud providers): that shape would let a caller pass
 * fields the backend already rejects for GOZAP, for no benefit here. The
 * response never carries a token — `channelSummarySchema` has no such field.
 */
export function useCreateGozapChannel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { name: string }) => {
      const json = await api
        .post('whatsapp/channels', { json: { provider: 'GOZAP', name: input.name } })
        .json();
      return channelSummarySchema.parse(json);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['whatsapp', 'providers'] }),
  });
}

/**
 * QR do canal GOZAP — GET /whatsapp/channels/:id/qr, análogo a
 * `useInstanceQr` (EVOLUTION) mas sobre um `Channel` cloud, não uma
 * `Instance`. Reusa `qrRefetchInterval`: para de pollar assim que
 * `state === 'open'`. Isso importa dos dois lados — o backend também
 * cacheia o QR por 25s (evitar recriar sessão a cada poll); parar de pollar
 * aqui assim que conecta é a outra metade dessa proteção.
 */
export function useGozapQr(channelId: string | undefined) {
  return useQuery({
    queryKey: ['whatsapp', 'channels', channelId, 'qr'],
    enabled: !!channelId,
    queryFn: async () => {
      const json = await api.get(`whatsapp/channels/${channelId}/qr`).json();
      return instanceQrSchema.parse(json);
    },
    refetchInterval: (query) => qrRefetchInterval(query.state.data?.state),
  });
}

/**
 * Remove um canal GOZAP — DELETE /whatsapp/channels/:id. O backend só aceita
 * esta rota para provider GOZAP (derruba a instância no GoZap e desativa a
 * row); TWILIO/ZERNIO/META não têm limpeza externa e não têm rota própria
 * ainda — este hook não deve ser usado para eles.
 */
export function useDeleteGozapChannel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await api.delete(`whatsapp/channels/${id}`);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['whatsapp', 'providers'] }),
  });
}

/**
 * As configurações do canal — PATCH /whatsapp/channels/:id. Patch PARCIAL: manda
 * só o que mudou.
 *
 * Um endpoint só para ativar/desativar E para o broadcast do Zernio, de
 * propósito: são a mesma classe de ação (mexer na config DESTE canal) e
 * compartilham os mesmos guard-rails no backend.
 *
 * DESATIVAR NÃO APAGA: o canal, suas conversas e seu histórico continuam. Ele só
 * some dos SELETORES (assistente de campanha, abas de número do inbox) e deixa de
 * poder ser o padrão. É a trava contra disparar pelo número errado — o que, numa
 * campanha eleitoral, é irreversível.
 *
 * Invalida `['whatsapp','providers']` (página Canais + seletor do assistente) e
 * `['chat']` (abas de número do inbox) — os dois têm de refletir na hora.
 */
export function useUpdateChannel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      ...settings
    }: {
      id: string;
      active?: boolean;
      zernioBroadcastEnabled?: boolean;
      zernioBroadcastChunk?: number;
    }) =>
      api
        .patch(`whatsapp/channels/${id}`, { json: settings })
        .json<ChannelSummary>(),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['whatsapp', 'providers'] });
      void qc.invalidateQueries({ queryKey: ['chat'] });
    },
  });
}

const zernioSyncEnqueuedSchema = z.object({
  runId: z.string(),
  status: z.string(),
  /** false => já havia um sync em curso; o backend devolveu o run existente. */
  enqueued: z.boolean(),
});
export type ZernioSyncEnqueued = z.infer<typeof zernioSyncEnqueuedSchema>;

const zernioSyncStatusSchema = z.object({
  runId: z.string().nullable(),
  /** PENDING | RUNNING | PAUSED | SUCCEEDED | FAILED | IDLE. */
  status: z.string(),
  total: z.number(),
  processed: z.number(),
  imported: z.number(),
  failed: z.number(),
  error: z.string().nullable(),
});
export type ZernioSyncStatus = z.infer<typeof zernioSyncStatusSchema>;

/** Estados em que o job ainda tem trabalho pela frente (⇒ continua o polling). */
export const ZERNIO_SYNC_ACTIVE = ['PENDING', 'RUNNING', 'PAUSED'];

/**
 * ENFILEIRA o sync do inbox do Zernio e volta na hora (202).
 *
 * Antes esta chamada era SÍNCRONA, com `timeout: 180_000` — o backfill percorria
 * ~100 conversas (uma requisição ao Zernio por conversa) DENTRO da request. O
 * balde do Zernio é de 60 req/min: na 61ª conversa vinha 429 e o operador levava
 * um **HTTP 500**, depois de encarar uma tela travada por minutos, sem nada
 * importado. Agora o trabalho roda num job e o progresso vem do `useZernioSyncStatus`.
 */
export function useSyncZernioInbox() {
  return useMutation({
    mutationFn: async (id: string) => {
      const json = await api.post(`whatsapp/channels/${id}/sync-inbox`).json();
      return zernioSyncEnqueuedSchema.parse(json);
    },
  });
}

/**
 * O progresso do job ("42 de 100 conversas…"). Só consulta enquanto há um sync
 * em curso, e para de pedir assim que ele termina — nada de polling eterno.
 */
export function useZernioSyncStatus(channelId: string | null) {
  return useQuery({
    queryKey: ['whatsapp', 'zernio-sync', channelId],
    enabled: !!channelId,
    queryFn: async () => {
      const json = await api
        .get(`whatsapp/channels/${channelId}/sync-inbox/status`)
        .json();
      return zernioSyncStatusSchema.parse(json);
    },
    refetchInterval: (q) =>
      q.state.data && ZERNIO_SYNC_ACTIVE.includes(q.state.data.status) ? 2000 : false,
  });
}
