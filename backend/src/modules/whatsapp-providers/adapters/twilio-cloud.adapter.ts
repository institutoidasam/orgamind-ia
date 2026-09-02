import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import { createHmac, timingSafeEqual } from 'crypto';
import type { Env } from '../../../shared/config/env.schema';
import type {
  SendTemplateInput,
  SendResult,
  NormalizedEvent,
} from '../../../schemas/contracts/whatsapp.schema';
import type {
  MessageProvider,
  InboundMessageEvent,
  InboundChatMessage,
  InboundReferral,
  SendChatTextArgs,
  MediaDownload,
  SendMediaArgs,
  SendAudioArgs,
} from '../ports/message-provider.port';
import { makeProfile } from '../ports/provider-profile';
import { PROVIDER_TRAITS } from '../../../schemas/contracts/channel-provider.schema';
import {
  WhatsappSendError,
  TwilioSenderMissingError,
} from '../errors/whatsapp.errors';
import { classifyTwilioError } from './twilio-error-mapper';

// A Twilio Content template SID (HX + 32 hex). When the campaign's templateName
// is one of these, we send it via ContentSid/ContentVariables (approved
// templates, outside the 24h window). Anything else is a free-form Body send —
// which is what the Sandbox / inside-24h-window path uses in Fase 0.
const CONTENT_SID_RE = /^HX[0-9a-fA-F]{32}$/;

// Twilio message statuses we care about, mapped to our normalized ack union.
// `queued`/`sending`/`accepted` are pre-delivery and carry no ack meaning.
const STATUS_MAP: Record<string, NormalizedEvent['status'] | undefined> = {
  sent: 'sent',
  delivered: 'delivered',
  read: 'read',
  failed: 'failed',
  undelivered: 'failed',
};

type TwilioForm = Record<string, unknown>;

function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/** Strip any leading `whatsapp:` prefixes and re-apply exactly one. */
function withWhatsappPrefix(value: string): string {
  const bare = value.replace(/^(whatsapp:)+/i, '');
  return `whatsapp:${bare}`;
}

/** `whatsapp:+55...` / `+55...` → the bare digits (no `+`, no prefix). */
function jidDigits(from: string): string {
  return from.replace(/^whatsapp:/i, '').replace(/\D/g, '');
}

/**
 * C3 / spec §3.4 — referral de um Click-to-WhatsApp Ad.
 *
 * O `ReferralCtwaClid` é o discriminante: sem ele não houve anúncio, e os demais
 * campos (headline/body/source) são decoração de um referral que não existe. Ele
 * é a evidência de proveniência mais forte disponível — verificável na
 * Meta/Twilio, ao contrário de qualquer coisa que o orgamind afirme sobre si mesmo.
 */
function parseReferral(p: TwilioForm): InboundReferral | undefined {
  const ctwaClid = asString(p.ReferralCtwaClid);
  if (!ctwaClid) return undefined;
  return {
    ctwaClid,
    headline: asString(p.ReferralHeadline),
    body: asString(p.ReferralBody),
    sourceId: asString(p.ReferralSourceId),
    sourceUrl: asString(p.ReferralSourceUrl),
  };
}

/** Twilio `MediaContentType0` MIME → our normalized message kind. */
function kindForMime(mime: string | undefined): InboundChatMessage['kind'] {
  if (!mime) return 'DOCUMENT';
  if (mime.startsWith('image/')) return 'IMAGE';
  if (mime.startsWith('video/')) return 'VIDEO';
  if (mime.startsWith('audio/')) return 'AUDIO';
  return 'DOCUMENT';
}

@Injectable()
export class TwilioCloudAdapter implements MessageProvider {
  readonly name = 'twilio' as const;
  readonly profile = makeProfile(PROVIDER_TRAITS.TWILIO, ['campaignSend', 'statusPolling', 'inboxChat']);

  // getConnectionInfo / media / labels / presence are intentionally NOT
  // implemented for Twilio in Fase 0 (see the throwing stubs at the bottom).

  private readonly logger = new Logger(TwilioCloudAdapter.name);
  private readonly http: AxiosInstance;
  private readonly authToken: string;
  private readonly from: string;
  private readonly messagingServiceSid?: string;
  /**
   * Public callback URL Twilio should POST delivery/status acks to. When set,
   * we attach it as a per-message `StatusCallback` so callbacks are requested
   * regardless of the Messaging Service console config — the ONLY thing
   * `TWILIO_WEBHOOK_URL` otherwise did was validate inbound signatures, which
   * does NOT make Twilio emit callbacks. Without this, accepted messages stay
   * SENT forever with no delivered/failed signal.
   */
  private readonly statusCallbackUrl?: string;

  constructor(private readonly config: ConfigService<Env>) {
    const accountSid = config.get('TWILIO_ACCOUNT_SID', { infer: true }) ?? '';
    this.authToken = config.get('TWILIO_AUTH_TOKEN', { infer: true }) ?? '';
    this.from = config.get('TWILIO_WHATSAPP_FROM', { infer: true }) ?? '';
    this.messagingServiceSid = config.get('TWILIO_MESSAGING_SERVICE_SID', {
      infer: true,
    });
    this.statusCallbackUrl =
      config.get('TWILIO_WEBHOOK_URL', { infer: true })?.trim() || undefined;
    this.http = axios.create({
      baseURL: `https://api.twilio.com/2010-04-01/Accounts/${accountSid}`,
      auth: { username: accountSid, password: this.authToken },
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      // Twilio recommends >= 30s; a tight 10s made latency spikes under a bulk
      // blast time out ambiguously (message maybe billed) → double-send on retry.
      timeout: 30_000,
    });
  }

  /**
   * Common form fields for a send: sender (From or MessagingServiceSid) + To.
   *
   * R1 — multi-number: the sender is resolved from the CHANNEL first, falling
   * back to the env. Precedence (highest → lowest):
   *   1. channel MessagingServiceSid   (`sender.messagingServiceSid`)
   *   2. channel From / phoneE164      (`sender.phoneE164`)
   *   3. env  MessagingServiceSid      (`TWILIO_MESSAGING_SERVICE_SID`)
   *   4. env  From                     (`TWILIO_WHATSAPP_FROM`)
   * When NONE of the four resolve, we throw a fatal domain error instead of
   * POSTing a request with no sender (see {@link TwilioSenderMissingError}).
   */
  private senderFields(
    toE164: string,
    sender?: { phoneE164?: string; messagingServiceSid?: string },
  ): Record<string, string> {
    const fields: Record<string, string> = {
      To: withWhatsappPrefix(toE164),
    };

    // Treat empty/whitespace as "absent" so a blank env var can't win over a
    // real channel value (and so an all-blank config trips the guard below).
    const channelMss = sender?.messagingServiceSid?.trim() || undefined;
    const channelFrom = sender?.phoneE164?.trim() || undefined;
    const envMss = this.messagingServiceSid?.trim() || undefined;
    const envFrom = this.from?.trim() || undefined;

    if (channelMss) {
      fields.MessagingServiceSid = channelMss;
    } else if (channelFrom) {
      fields.From = withWhatsappPrefix(channelFrom);
    } else if (envMss) {
      fields.MessagingServiceSid = envMss;
    } else if (envFrom) {
      fields.From = withWhatsappPrefix(envFrom);
    } else {
      throw new TwilioSenderMissingError();
    }

    // Request per-message delivery/status callbacks (delivered/failed/read).
    if (this.statusCallbackUrl) {
      fields.StatusCallback = this.statusCallbackUrl;
    }
    return fields;
  }

  private async post(fields: Record<string, string>): Promise<SendResult> {
    try {
      const { data } = await this.http.post<{ sid: string }>(
        '/Messages.json',
        new URLSearchParams(fields),
      );
      return {
        providerMessageId: data.sid,
        acceptedAt: new Date(),
      };
    } catch (err) {
      const e = err as {
        code?: string;
        response?: { data?: { code?: number | string; message?: string } };
        message?: string;
      };
      // Distinguish "Twilio rejected it" (has an HTTP response body + code) from
      // "we never got an answer" (timeout / socket reset / DNS). The latter is
      // INDETERMINATE — Twilio may have accepted AND billed the message — so we
      // must NOT blindly resend; surface `twilio.timeout` so the processor parks
      // it instead of re-charging. A pure connection failure (never reached
      // Twilio) is safe to retry → `twilio.unreachable`.
      let code = e.response?.data?.code?.toString();
      let message = e.response?.data?.message ?? e.message;
      if (!e.response) {
        const netCode = e.code;
        if (netCode === 'ECONNREFUSED' || netCode === 'ENOTFOUND' || netCode === 'EAI_AGAIN') {
          code = 'twilio.unreachable';
          message = `Twilio inacessível (${netCode})`;
        } else {
          // ECONNABORTED (timeout), ECONNRESET, socket hang up, etc.
          code = 'twilio.timeout';
          message = e.message ?? 'Timeout ao falar com a Twilio';
        }
      }
      const cls = classifyTwilioError(code, message);
      this.logger.error({ code, message, fatal: cls.fatal }, 'twilio send failed');
      // Put the mapped, operator-facing message (Portuguese; falls back to the
      // raw Twilio text for unknown codes) in the primary `message` slot — same
      // convention as the Evolution adapter — so Message.errorMessage is readable.
      // The raw Twilio text is preserved as providerMessage for debugging.
      throw new WhatsappSendError(cls.message, code, message, cls.fatal);
    }
  }

  /**
   * Fetch the current delivery status of a previously-sent message from Twilio's
   * REST API. Used by the status reconciler to recover linhas SENT that never
   * received a status callback (webhook off/lagging). Returns the normalized
   * status (undefined for pre-delivery states like queued/sent) + the raw code.
   */
  async fetchMessageStatus(sid: string): Promise<{
    status?: NormalizedEvent['status'];
    rawStatus: string;
    errorCode?: string;
  }> {
    const { data } = await this.http.get<{
      status?: string;
      error_code?: number | string | null;
    }>(`/Messages/${encodeURIComponent(sid)}.json`);
    const raw = (data.status ?? '').toLowerCase();
    return {
      status: STATUS_MAP[raw],
      rawStatus: raw,
      errorCode:
        data.error_code != null ? String(data.error_code) : undefined,
    };
  }

  async sendTemplate(input: SendTemplateInput): Promise<SendResult> {
    // R1: the channel's sender (derived by sendVia from Channel.phoneE164 /
    // Channel.twilioMessagingServiceSid) wins over the env; senderFields
    // encodes the full precedence + the missing-sender guard.
    const fields = this.senderFields(input.toE164, {
      phoneE164: input.senderPhoneE164,
      messagingServiceSid: input.twilioMessagingServiceSid,
    });
    if (CONTENT_SID_RE.test(input.templateName)) {
      fields.ContentSid = input.templateName;
      if (Object.keys(input.variables).length > 0) {
        fields.ContentVariables = JSON.stringify(input.variables);
      }
    } else {
      // Free-form / Sandbox path: send the rendered body text. Fall back to the
      // template name only if a caller omitted an explicit body.
      fields.Body = input.body ?? input.templateName;
    }
    return this.post(fields);
  }

  async sendChatText(args: SendChatTextArgs): Promise<SendResult> {
    // R1 — o remetente do CANAL (injetado por sendChatTextVia) vence o env;
    // mesma precedência do sendTemplate (ver senderFields).
    const fields = this.senderFields(args.toE164, {
      phoneE164: args.senderPhoneE164,
      messagingServiceSid: args.twilioMessagingServiceSid,
    });
    fields.Body = args.text;
    return this.post(fields);
  }

  /** True when the payload is a Twilio status callback (not an inbound message). */
  private isStatusCallback(p: TwilioForm): boolean {
    return (
      typeof p.MessageStatus === 'string' || typeof p.SmsStatus === 'string'
    );
  }

  parseWebhook(payload: unknown): NormalizedEvent[] {
    const p = (payload ?? {}) as TwilioForm;
    const sid = asString(p.MessageSid) ?? asString(p.SmsSid);
    const rawStatus = asString(p.MessageStatus) ?? asString(p.SmsStatus);
    if (!sid || !rawStatus) return [];
    const status = STATUS_MAP[rawStatus.toLowerCase()];
    if (!status) return [];
    return [
      {
        providerMessageId: sid,
        status,
        errorCode: asString(p.ErrorCode),
        // Twilio status callbacks carry no reliable timestamp; stamp now.
        occurredAt: new Date(),
      },
    ];
  }

  parseInboundChatMessages(payload: unknown): InboundChatMessage[] {
    const p = (payload ?? {}) as TwilioForm;
    if (this.isStatusCallback(p)) return [];
    const sid = asString(p.MessageSid) ?? asString(p.SmsSid);
    const from = asString(p.From);
    if (!sid || !from) return [];
    const digits = jidDigits(from);
    if (!digits) return [];

    const numMedia = Number(asString(p.NumMedia) ?? '0');
    const hasMedia = Number.isFinite(numMedia) && numMedia > 0;
    const body = asString(p.Body);
    let text = body && body.length > 0 ? body : undefined;
    const buttonText = asString(p.ButtonText);
    const latitude = asString(p.Latitude);
    const longitude = asString(p.Longitude);

    let kind: InboundChatMessage['kind'] = 'TEXT';
    let media: InboundChatMessage['media'];
    if (hasMedia) {
      // WhatsApp delivers one media per message, but Twilio's contract allows
      // MediaUrl0..N (MMS heritage). We map only media 0 — a NumMedia > 1
      // payload is logged and its extra attachments are dropped by design.
      if (numMedia > 1) {
        this.logger.warn(
          { sid, numMedia },
          'twilio inbound with NumMedia > 1 — processing only MediaUrl0',
        );
      }
      const mime = asString(p.MediaContentType0);
      kind = kindForMime(mime);
      // Body alongside media is the caption — keep it as `text`.
      media = { mimeType: mime, url: asString(p.MediaUrl0) };
    } else if (latitude && longitude) {
      // Location pin. Evolution surfaces the place name/address as `text`;
      // Twilio gives Label/Address for named places — same fallback chain,
      // then bare "lat,long" for a raw pin.
      kind = 'LOCATION';
      text =
        asString(p.Label) ?? asString(p.Address) ?? `${latitude},${longitude}`;
    } else if (buttonText) {
      // Quick-reply / CTA button press: the visible label is the message text;
      // the stable action id (ButtonPayload, e.g. `optout`) rides alongside.
      kind = 'TEXT';
      text = buttonText;
    }

    return [
      {
        providerMessageId: sid,
        remoteJid: `${digits}@s.whatsapp.net`,
        phoneE164: `+${digits}`,
        isGroup: false,
        fromMe: false,
        pushName: asString(p.ProfileName),
        kind,
        text,
        buttonPayload: asString(p.ButtonPayload),
        referral: parseReferral(p),
        media,
        quotedWaMessageId: asString(p.OriginalRepliedMessageSid),
        receivedAt: new Date(),
      },
    ];
  }

  parseInboundMessages(payload: unknown): InboundMessageEvent[] {
    const p = (payload ?? {}) as TwilioForm;
    if (this.isStatusCallback(p)) return [];
    const sid = asString(p.MessageSid) ?? asString(p.SmsSid);
    const from = asString(p.From);
    if (!sid || !from) return [];
    const digits = jidDigits(from);
    if (!digits) return [];
    return [
      {
        fromE164: `+${digits}`,
        text: asString(p.Body),
        receivedAt: new Date(),
        providerMessageId: sid,
        // T8: id estável do quick-reply (ex. `optout`) — consumido pelo
        // handler de STOP keywords para opt-out por botão.
        buttonPayload: asString(p.ButtonPayload),
      },
    ];
  }

  /**
   * Validate Twilio's `X-Twilio-Signature`. Twilio's algorithm: take the full
   * request URL, append every POST param as `key+value` sorted by key (no
   * delimiters), HMAC-SHA1 with the AuthToken, base64. Compared constant-time.
   */
  verifyTwilioSignature(
    url: string,
    params: Record<string, unknown>,
    signature: string | undefined,
  ): boolean {
    if (!signature || !this.authToken) return false;
    let data = url;
    for (const key of Object.keys(params).sort()) {
      const value = params[key];
      // Twilio POST params are always strings; coerce defensively without
      // stringifying an object into "[object Object]".
      data += key + (typeof value === 'string' ? value : '');
    }
    const expected = createHmac('sha1', this.authToken)
      .update(Buffer.from(data, 'utf-8'))
      .digest('base64');
    const a = Buffer.from(expected);
    const b = Buffer.from(signature);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  // ── Fase 2 / unsupported by Twilio provider ───────────────────────────────
  async markMessageAsRead(): Promise<void> {
    /* not supported by Twilio provider (Fase 2) */
  }
  async sendPresence(): Promise<void> {
    /* not supported by Twilio provider (Fase 2) */
  }
  async getMediaBase64(): Promise<MediaDownload> {
    throw new Error('getMediaBase64 not supported by Twilio provider (Fase 2)');
  }
  async sendMedia(_args: SendMediaArgs): Promise<never> {
    throw new Error('sendMedia not supported by Twilio provider (Fase 2)');
  }
  async sendWhatsAppAudio(_args: SendAudioArgs): Promise<never> {
    throw new Error(
      'sendWhatsAppAudio not supported by Twilio provider (Fase 2)',
    );
  }
  async findChats(): Promise<never> {
    throw new Error('findChats not supported by Twilio provider (Fase 2)');
  }
  async findMessages(): Promise<never> {
    throw new Error('findMessages not supported by Twilio provider (Fase 2)');
  }
}
