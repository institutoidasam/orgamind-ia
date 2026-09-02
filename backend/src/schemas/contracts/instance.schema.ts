import { z } from 'zod';
import {
  channelProviderEnum,
  type ChannelProviderContract,
} from './channel-provider.schema';
import { dateFromIso } from './date.schema';

// Re-exported for backward compatibility — the single source is now
// channel-provider.schema.ts (see that file for the rationale).
export { channelProviderEnum, type ChannelProviderContract };

// Same E.164 shape already used for sendTemplateInputSchema.toE164
// (whatsapp.schema.ts) — a leading '+' followed by 8-15 digits.
const e164Regex = /^\+\d{8,15}$/;

/**
 * POST /whatsapp/channels — creates a cloud-provider (TWILIO/ZERNIO/META)
 * channel row directly, with no external provisioning. `provider` accepts
 * the FULL ChannelProvider enum (including EVOLUTION) on purpose: an
 * EVOLUTION request must reach the controller and get a specific PT-BR
 * domain error pointing at the existing instance-provisioning flow, instead
 * of a generic zod validation failure.
 */
export const createChannelSchema = z
  .object({
    provider: channelProviderEnum,
    name: z.string().min(2).max(80),
    // ZERNIO channels carry no phone here — the number lives on the Zernio
    // account (identified by zernioAccountId). Every other cloud provider
    // (TWILIO/META) needs the E.164 sender. Enforced per-provider in the
    // superRefine below so the field can be omitted for ZERNIO.
    phoneE164: z
      .string()
      .regex(e164Regex, 'phoneE164 deve estar no formato E.164 (+DDI...)')
      .optional(),
    twilioMessagingServiceSid: z.string().min(1).optional(),
    // Required only for provider === 'ZERNIO' (see superRefine below) — the
    // Zernio account identifier for the number being registered.
    zernioAccountId: z.string().min(1).optional(),
  })
  .superRefine((data, ctx) => {
    if (data.provider === 'ZERNIO') {
      if (!data.zernioAccountId) {
        ctx.addIssue({
          code: 'custom',
          path: ['zernioAccountId'],
          message: 'zernioAccountId é obrigatório para o provedor ZERNIO',
        });
      }
    } else if (data.provider === 'GOZAP') {
      // GOZAP pareia por QR (sessionBased) — nem phoneE164 nem accountId são
      // exigidos na criação; o número só é conhecido depois do pareamento.
    } else if (!data.phoneE164) {
      ctx.addIssue({
        code: 'custom',
        path: ['phoneE164'],
        message: 'phoneE164 é obrigatório para este provedor',
      });
    }
  });
export type CreateChannelInput = z.infer<typeof createChannelSchema>;

/**
 * PATCH /whatsapp/channels/:id — as configurações do canal que o operador
 * controla pela tela. TUDO opcional: é um patch parcial, e um body vazio é um
 * no-op (não um erro).
 *
 * Um endpoint só, de propósito. "Desativar o canal" e "ligar o broadcast" são a
 * mesma classe de ação (mexer na configuração DESTE canal) e compartilham os
 * mesmos guard-rails — duplicar o caminho duplicaria também as chances de um
 * deles esquecer um guard.
 */
export const updateChannelSettingsSchema = z.object({
  /**
   * Desativar NÃO apaga o canal: as conversas e o histórico dele continuam. O que
   * muda é que ele deixa de ser oferecido nos seletores (assistente de campanha,
   * abas de número do inbox) e deixa de poder ser o padrão. É a trava contra o
   * clique errado — mandar uma campanha eleitoral pelo número errado é irreversível.
   */
  active: z.boolean().optional(),
  /**
   * ZERNIO — ligado, a campanha vira um BROADCAST NATIVO e aparece no painel do
   * Zernio. Desligado (o PADRÃO) é o envio 1-a-1, que é também o FALLBACK.
   *
   * ⚠️ O broadcast do Zernio NÃO PERSONALIZA: o `/recipients` só recebe telefones,
   * e as variáveis são resolvidas contra o CRM do Zernio (onde o contato nasce sem
   * nome). Por isso uma campanha cujo template usa variável de CAMPO cai
   * automaticamente no 1-a-1, mesmo com esta flag ligada — ver
   * `zernio-broadcast-variables.ts`. A tela diz isso ao operador.
   */
  zernioBroadcastEnabled: z.boolean().optional(),
  /**
   * Quantos destinatários por requisição ao Zernio. O teto DURO é 100 (o único
   * número que o Zernio publica); o default é 50. O backend ainda re-clampa em
   * `effectiveChunkSize` — este limite aqui é para o operador receber um erro
   * claro em vez de um silêncio.
   */
  zernioBroadcastChunk: z.number().int().min(1).max(100).optional(),
});
export type UpdateChannelSettings = z.infer<typeof updateChannelSettingsSchema>;

/** One channel row as summarized for GET /whatsapp/providers. */
export const channelSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  phoneE164: z.string().nullable(),
  isActive: z.boolean(),
  isDefault: z.boolean(),
  provider: channelProviderEnum,
  /**
   * ZERNIO — a campanha sai como BROADCAST nativo (aparece no painel do Zernio)?
   * Sem estes dois campos aqui, a tela Canais não teria como MOSTRAR o estado da
   * flag — e a única forma de ligá-la seguiria sendo SQL direto em produção.
   */
  zernioBroadcastEnabled: z.boolean().optional(),
  zernioBroadcastChunk: z.number().optional(),
  /**
   * ZERNIO — a conta WhatsApp por trás do canal. Permite ao form de cadastro
   * MARCAR no seletor as contas que já têm canal ativo, em vez de deixar o
   * operador escolher uma e só descobrir a duplicata no erro do submit
   * (channel.duplicate_zernio_account).
   */
  zernioAccountId: z.string().nullable().optional(),
  /**
   * T15 — a quota de HOJE do canal, para TODO provedor (não só EVOLUTION —
   * ver `GET /whatsapp/instances`, que só devolve canais desse provedor). O
   * wizard (passo final) e o cabeçalho de progresso da campanha resolviam o
   * canal por `/instances`, então GOZAP/ZERNIO/TWILIO/META — inclusive o
   * canal de PRODUÇÃO — nunca tinham quota nenhuma ali, e o envio ficava
   * bloqueado com "Canal não encontrado" mesmo com o canal saudável.
   *
   * Calculado com `warmupInfo` (warmup.helper.ts — a ÚNICA fonte de verdade
   * da rampa de aquecimento); este contrato só declara a FORMA do resultado.
   *
   * Todos OPCIONAIS aqui de propósito — um cliente antigo que não conhece
   * estes campos não pode quebrar — mas o service que monta
   * `GET /whatsapp/providers` SEMPRE os preenche.
   */
  dailySendLimit: z.number().optional(),
  sentToday: z.number().optional(),
  /** ISO. `null` quando o backend não tem a informação (nunca acontece hoje —
   *  a coluna do Prisma tem default — mas o contrato não assume isso). */
  sentTodayResetAt: z.string().nullable().optional(),
  /** O teto REALMENTE em vigor hoje — já considerando a rampa. */
  warmupEffectiveCap: z.number().optional(),
  /** true enquanto a rampa ainda está abaixo do `dailySendLimit` configurado. */
  warming: z.boolean().optional(),
  /** Dia 1-based da rampa; 0 quando o canal não está (ou nunca esteve) em aquecimento. */
  warmupDay: z.number().optional(),
  /**
   * O estado de conexão MAIS RECENTE do canal (`WhatsappConnectionEvent`) —
   * é o que a tela Canais usa para mostrar "conectado"/"conectando"/
   * "desconectado" por canal, em vez de deixar o operador sem nenhuma pista.
   *
   * `null`/ausente para um canal sem sessão (TWILIO/ZERNIO/META — sempre "no
   * ar" enquanto ativo, sem conceito de pareamento) OU para um canal
   * sessionBased (EVOLUTION/GOZAP) que nunca completou um ciclo de conexão.
   * Nunca inventado como "close": a ausência de dado é um estado diferente de
   * "sei que está desconectado".
   */
  connectionState: z.enum(['open', 'connecting', 'close']).nullable().optional(),
});
export type ChannelSummary = z.infer<typeof channelSummarySchema>;

/**
 * Traits de política do provider (F0 — ver PROVIDER_TRAITS em
 * channel-provider.schema.ts), espelhados aqui como schema zod puro para que
 * `providersResponseSchema` os exponha via GET /whatsapp/providers.
 */
export const providerTraitsSchema = z.object({
  official: z.boolean(),
  sessionBased: z.boolean(),
  sessionWindow: z.boolean(),
});

/**
 * GET /whatsapp/providers — configured providers on this deploy, each with
 * its declared traits + capabilities (F0 — ProviderProfile, ver
 * ports/provider-profile.ts) and its channels (active and inactive).
 * Consumed by the frontend's `useProviders()`
 * (frontend/src/features/whatsapp/api.ts) — the shape here MUST match
 * `providersResponseSchema` there exactly.
 */
export const providersResponseSchema = z.object({
  providers: z.array(
    z.object({
      provider: channelProviderEnum,
      traits: providerTraitsSchema,
      capabilities: z.array(z.string()),
      channels: z.array(channelSummarySchema),
    }),
  ),
});
export type ProvidersResponse = z.infer<typeof providersResponseSchema>;

/** Uma conta WhatsApp conectada no Zernio, como o seletor de canal a exibe. */
export const zernioAccountSchema = z.object({
  /** O `_id` da conta — é este valor que vira `Channel.zernioAccountId`. */
  id: z.string(),
  displayName: z.string().nullable(),
  phoneE164: z.string().nullable(),
  wabaId: z.string().optional(),
  qualityRating: z.string().optional(),
  messagingLimitTier: z.string().optional(),
  nameStatus: z.string().optional(),
});
export type ZernioAccountContract = z.infer<typeof zernioAccountSchema>;

/**
 * GET /whatsapp/zernio/accounts — as contas disponíveis para o seletor do form
 * de canal ZERNIO. `unavailable: true` significa "não consegui falar com o
 * Zernio agora" (NÃO "você não tem contas"): a UI deve cair no input manual em
 * vez de afirmar que não há nenhuma conta.
 */
export const zernioAccountsResponseSchema = z.object({
  accounts: z.array(zernioAccountSchema),
  unavailable: z.boolean(),
});
export type ZernioAccountsResponse = z.infer<typeof zernioAccountsResponseSchema>;

/**
 * GET /whatsapp/webhook-drops — webhooks que chegaram, autenticaram e foram
 * DESCARTADOS porque nenhum canal ativo corresponde à conta/número remetente.
 * Cada item é uma conta órfã: alguém está mandando mensagem para um número que o
 * orgamind não sabe atender, e tudo o que chega dali está sendo perdido.
 */
export const webhookDropAlertSchema = z.object({
  provider: channelProviderEnum,
  /** ZERNIO → o accountId; TWILIO → o número `To`. */
  accountRef: z.string(),
  totalCount: z.number(),
  events: z.array(z.string()),
  firstSeenAt: dateFromIso(),
  lastSeenAt: dateFromIso(),
});
export type WebhookDropAlertContract = z.infer<typeof webhookDropAlertSchema>;

export const webhookDropsResponseSchema = z.object({
  drops: z.array(webhookDropAlertSchema),
});
export type WebhookDropsResponse = z.infer<typeof webhookDropsResponseSchema>;

/**
 * ZB — GET /whatsapp/channels/health: a saúde de um canal cloud na Meta, do
 * jeito que o operador precisa VER antes de disparar (hoje ele dispara às
 * cegas).
 *
 * Os campos vêm de `GET /whatsapp/number-info` (leitura rica) com degradação
 * para `GET /accounts` → `metadata` e, por último, para o que o `zernio-tier-sync`
 * já persistiu no `Channel` — daí quase tudo ser opcional e existir um `stale`.
 * Shape é contrato duro com o `useChannelHealth()` do frontend.
 */
export const channelHealthSchema = z.object({
  channelId: z.string(),
  channelName: z.string(),
  provider: channelProviderEnum,
  zernioAccountId: z.string(),
  /** Formatado pela Meta ("+55 92 3155-0101") — é para exibir. */
  displayPhoneNumber: z.string().optional(),

  /** Ex.: `TIER_2K`. Ausente quando nem o `/accounts` respondeu. */
  messagingLimitTier: z.string().optional(),
  /** O teto em número. Tier desconhecido → o `dailySendLimit` do canal. */
  tierLimit: z.number(),
  /** Destinatários ÚNICOS nas últimas 24h ROLANTES — o que a Meta conta. */
  uniqueRecipients24h: z.number(),
  tierUsagePct: z.number(),
  /** ≥80% do teto: hora de parar de enfileirar, antes da Meta rejeitar em massa. */
  nearTierLimit: z.boolean(),

  /** GREEN | YELLOW | RED | FLAGGED | UNKNOWN. */
  qualityRating: z.string().optional(),
  /** APPROVED | DECLINED | PENDING_REVIEW | NONE | … */
  nameStatus: z.string().optional(),
  /** Ex.: `BIZ_COMMERCE_VIOLATION_OTHER` — só quando nameStatus = DECLINED. */
  nameRejectionReason: z.string().optional(),

  /** AVAILABLE | LIMITED | BLOCKED — o veredito da Meta sobre ENVIAR. */
  canSendMessage: z.string().optional(),
  /** O texto da Meta explicando o veredito. */
  canSendMessageReason: z.string().optional(),

  /** true = a leitura rica falhou; o que está aí veio do `/accounts` ou do banco. */
  stale: z.boolean(),
  syncedAt: dateFromIso(),
});
export type ChannelHealth = z.infer<typeof channelHealthSchema>;

export const channelHealthResponseSchema = z.object({
  channels: z.array(channelHealthSchema),
});
export type ChannelHealthResponse = z.infer<typeof channelHealthResponseSchema>;
