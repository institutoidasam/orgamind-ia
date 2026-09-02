import { z } from 'zod';
import { dateFromIso } from './date.schema';

export const sendTemplateInputSchema = z.object({
  toE164: z.string().regex(/^\+\d{8,15}$/, 'Phone must be E.164 format'),
  templateName: z.string().min(1),
  language: z.string().default('pt_BR'),
  variables: z.record(z.string(), z.string()).default({}),
  mediaUrl: z.string().url().optional(),
  /**
   * Raw template body. Required for unofficial providers (Evolution/Baileys)
   * that send plain text instead of WhatsApp Business templates. Ignored by
   * the Meta Cloud adapter, which renders the template by name on Meta's side.
   */
  body: z.string().optional(),
  /**
   * Template kind — TEXT for plain-text sends, LIST/BUTTONS/POLL for
   * interactive Evolution-only payloads. Defaults to TEXT for backward
   * compatibility. Validated against the per-kind config schema by the
   * adapter immediately before sending.
   */
  kind: z.enum(['TEXT', 'LIST', 'BUTTONS', 'POLL']).optional(),
  interactiveConfig: z.unknown().optional(),
  /**
   * Typing-indicator delay applied before the message lands. Evolution
   * shows the bot as "online → typing…" for `delay` ms before posting.
   * Capped at 60 s so a misconfigured campaign can't stall the worker.
   */
  delay: z.number().int().min(0).max(60_000).optional(),
  /**
   * Per-call Evolution instance name override. When provided, the adapter
   * uses this instead of the singleton `EVOLUTION_INSTANCE_NAME` env var.
   * The router sets this after resolving the correct instance for the tenant.
   * Optional — callers that omit it fall back to the adapter's default.
   */
  evolutionInstanceName: z.string().optional(),
  /**
   * Per-channel Twilio sender number (E.164). Derived from `Channel.phoneE164`
   * by `sendVia`. When present, the Twilio adapter sends FROM this number
   * (normalized to exactly one `whatsapp:` prefix) instead of the env-configured
   * `TWILIO_WHATSAPP_FROM`. Ignored by the Meta and Evolution adapters, which
   * resolve their sender from their own env/instance. Optional — callers that
   * omit it fall back to the env sender. (R1: multi-number Twilio.)
   */
  senderPhoneE164: z.string().optional(),
  /**
   * Per-channel Twilio Messaging Service SID. Derived from
   * `Channel.twilioMessagingServiceSid` by `sendVia`. Takes precedence over
   * `senderPhoneE164` and over the env sender. Ignored by Meta/Evolution.
   * Optional — callers that omit it fall back to the env sender. (R1.)
   */
  twilioMessagingServiceSid: z.string().optional(),
  /**
   * Per-channel Zernio social account ID (the `_id` of Zernio's `GET /accounts`)
   * that identifies WHICH connected WhatsApp number sends the template — Zernio's
   * `POST /inbox/conversations` requires an `accountId`. Derived from the channel
   * by the router. Ignored by Meta/Evolution/Twilio. Optional at the schema level,
   * but the Zernio adapter throws a fatal domain error when it's absent (there is
   * no env fallback for the sending account).
   */
  zernioAccountId: z.string().optional(),
  /**
   * Token da instância GoZap (SaaS não-oficial, sessão por QR) que identifica
   * QUAL número conectado envia o template — vai no header `token` de
   * `POST /send/*`. Derivado do canal pelo router, no mesmo padrão de
   * `zernioAccountId`. Ignorado por Meta/Evolution/Twilio/Zernio. Opcional
   * no nível do schema, mas o adapter GoZap lança um erro fatal quando ele
   * está ausente (não há fallback de env para o token de uma instância).
   */
  gozapInstanceToken: z.string().optional(),
  /**
   * Header de MÍDIA de um template aprovado (Zernio `POST /inbox/conversations`).
   * Opcional: quando ausente, a Zernio preenche o header com o asset de exemplo
   * aprovado no template — passar `headerMedia` SOBREPÕE isso por envio.
   *
   * `type` tem que bater com o tipo de header aprovado. `link` precisa ser uma
   * URL pública, alcançável SEM auth (a Meta é quem baixa). `id` é um media id
   * da Meta, alternativa ao link. `filename` só vale para `document`.
   *
   * ⚠️ Para campanha, hospede o asset em URL ESTÁVEL do próprio orgamind (ou use
   * `id`): o storage temporário da Zernio expira em 7 dias e um reenvio depois
   * disso falha com 131052 ("failed to download media"), que é NÃO-fatal no
   * mapper — ou seja, retentaria em loop.
   *
   * Ignorado por Meta/Evolution/Twilio.
   */
  headerMedia: z
    .object({
      type: z.enum(['image', 'video', 'document']),
      link: z.string().url().optional(),
      id: z.string().min(1).optional(),
      /** `document` apenas — a Zernio ignora em image/video. */
      filename: z.string().min(1).optional(),
    })
    // A doc é explícita: "Provide exactly one of `link` or `id`". Barrar aqui
    // evita um 4xx no meio de uma campanha já enfileirada.
    .refine((h) => (h.link ? 1 : 0) + (h.id ? 1 : 0) === 1, {
      message: 'headerMedia exige exatamente um de `link` ou `id`',
    })
    .optional(),
});

export const sendResultSchema = z.object({
  providerMessageId: z.string(),
  acceptedAt: dateFromIso(),
});

export const normalizedEventSchema = z.object({
  providerMessageId: z.string(),
  status: z.enum(['sent', 'delivered', 'read', 'failed']),
  errorCode: z.string().optional(),
  errorMessage: z.string().optional(),
  occurredAt: dateFromIso(),
  /**
   * ZW — o TELEFONE do destinatário (E.164, com '+'), quando o provedor o manda
   * no evento de status. É a chave de RESGATE do casamento do BROADCAST.
   *
   * Por que existe: o `POST /broadcasts/{id}/send` do Zernio devolve só
   * `{success, status, sent, failed, recipientCount}` — **nenhum wamid**. As
   * Messages do broadcast nascem, portanto, SEM `providerMessageId`, e o webhook
   * de status (que TRAZ o wamid) não casaria com nada. Com o telefone, o
   * `WebhooksService` acha a linha, CARIMBA o wamid nela, e daí em diante os
   * eventos seguintes (`delivered`, `read`) casam pelo caminho normal.
   *
   * OPCIONAL de propósito: Evolution e Twilio NÃO o preenchem — o envio 1-a-1
   * deles já grava o `providerMessageId` na hora do POST, então o casamento por
   * wamid nunca falha e o fallback por telefone jamais é acionado. Um evento sem
   * este campo se comporta EXATAMENTE como antes.
   */
  recipientPhone: z.string().optional(),
});

/**
 * Evolution per-instance Baileys flags. All optional — the controller forwards
 * a partial to the provider, which merges with current state on its side.
 */
export const evolutionSettingsSchema = z
  .object({
    rejectCall: z.boolean().optional(),
    // The /whatsapp/settings endpoint enforces a 200-char limit so operators
    // can't bypass it.
    msgCall: z.string().max(200).optional(),
    groupsIgnore: z.boolean().optional(),
    alwaysOnline: z.boolean().optional(),
    readMessages: z.boolean().optional(),
    readStatus: z.boolean().optional(),
    syncFullHistory: z.boolean().optional(),
  })
  .strict();

export type SendTemplateInput = z.infer<typeof sendTemplateInputSchema>;
export type SendResult = z.infer<typeof sendResultSchema>;
export type NormalizedEvent = z.infer<typeof normalizedEventSchema>;

/** Profile sub-object returned when provider === 'evolution' and number is connected. */
export const connectionProfileSchema = z.object({
  ownerJid: z.string().nullable(),
  phoneE164: z.string().nullable(),
  profileName: z.string().nullable(),
  profilePictureUrl: z.string().nullable(),
});

/** Single connection lifecycle event in the 24h history. */
export const connectionEventSchema = z.object({
  state: z.enum(['open', 'connecting', 'close']),
  reasonCode: z.number().int().nullable(),
  // be-bootstrap-8: zod v4 form (z.string().datetime() is deprecated).
  occurredAt: z.iso.datetime(),
});

/** Full enriched response for GET /whatsapp/connection. */
export const enrichedConnectionInfoSchema = z.object({
  state: z.enum(['open', 'connecting', 'close']),
  qrBase64: z.string().nullable().optional(),
  pairingCode: z.string().nullable().optional(),
  disconnectionReasonCode: z.number().int().nullable().optional(),
  disconnectionAt: z.string().nullable().optional(),
  provider: z.enum(['evolution', 'meta']),
  profile: connectionProfileSchema.nullable(),
  // be-bootstrap-8: zod v4 form (z.string().datetime() is deprecated).
  connectedSince: z.iso.datetime().nullable(),
  health: z.enum(['healthy', 'degraded', 'unhealthy']),
  recentEvents: z.array(connectionEventSchema),
});

export type EnrichedConnectionInfoResponse = z.infer<typeof enrichedConnectionInfoSchema>;
export type ConnectionProfile = z.infer<typeof connectionProfileSchema>;
export type ConnectionEventDto = z.infer<typeof connectionEventSchema>;
