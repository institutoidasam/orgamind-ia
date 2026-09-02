import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import CircuitBreaker from 'opossum';
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
  MediaDownload,
  SendMediaArgs,
  SendAudioArgs,
} from '../ports/message-provider.port';
import { makeProfile } from '../ports/provider-profile';
import { PROVIDER_TRAITS } from '../../../schemas/contracts/channel-provider.schema';
import { WhatsappSendError } from '../errors/whatsapp.errors';

// be-meta: validation helpers for webhook parsing. Meta payloads are untrusted
// input; coercing status/timestamp/from without checks corrupts events.
const KNOWN_STATUSES: ReadonlySet<NormalizedEvent['status']> = new Set([
  'sent',
  'delivered',
  'read',
  'failed',
]);

function toKnownStatus(raw: unknown): NormalizedEvent['status'] | null {
  return typeof raw === 'string' && KNOWN_STATUSES.has(raw as NormalizedEvent['status'])
    ? (raw as NormalizedEvent['status'])
    : null;
}

/**
 * Meta sends status/message timestamps as Unix seconds in a string. parseInt on
 * a missing or non-numeric value yields NaN, and new Date(NaN) is an Invalid
 * Date that corrupts occurredAt/receivedAt downstream. Fall back to "now" for
 * anything we can't parse so a malformed payload still gets a sensible date.
 */
function parseMetaTimestamp(raw: unknown): Date {
  const seconds = typeof raw === 'string' || typeof raw === 'number' ? Number(raw) : NaN;
  if (Number.isFinite(seconds) && seconds > 0) {
    return new Date(seconds * 1000);
  }
  return new Date();
}

@Injectable()
export class MetaCloudAdapter implements MessageProvider, OnModuleInit {
  readonly name = 'meta' as const;
  readonly profile = makeProfile(PROVIDER_TRAITS.META, ['campaignSend']);

  // getConnectionInfo is intentionally NOT implemented for Meta Cloud: there is
  // no paired session to be up or down (no QR, no Baileys socket), only a token
  // that is valid or isn't. That absence is DECLARED, not inferred — the profile
  // above omits `sessionLifecycle`, so callers gate on the capability instead of
  // probing `typeof adapter.getConnectionInfo`.
  // (The old service-level short-circuit, composeConnectionInfo, was deleted
  // with GET /whatsapp/connection — the QR flow now talks to the Evolution
  // adapter directly, in WhatsappInstancesController.qr.)

  private readonly logger = new Logger(MetaCloudAdapter.name);
  private readonly http: AxiosInstance;
  private readonly phoneNumberId: string;
  private breaker!: CircuitBreaker<[SendTemplateInput], SendResult>;

  constructor(private readonly config: ConfigService<Env>) {
    const token = config.get('META_ACCESS_TOKEN', { infer: true });
    this.phoneNumberId = config.get('META_PHONE_NUMBER_ID', { infer: true }) ?? '';
    this.http = axios.create({
      baseURL: 'https://graph.facebook.com/v22.0',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      timeout: 10_000,
    });
  }

  onModuleInit() {
    this.breaker = new CircuitBreaker<[SendTemplateInput], SendResult>(
      (input: SendTemplateInput) => this.doSend(input),
      {
        timeout: 15_000,
        errorThresholdPercentage: 50, // 50% failures opens the circuit
        resetTimeout: 30_000, // try again after 30s
        rollingCountTimeout: 60_000, // 1-min sliding window
        rollingCountBuckets: 10,
        name: 'meta-cloud-send',
      },
    );
    this.breaker.on('open', () =>
      this.logger.error('Circuit breaker OPEN — Meta sends paused'),
    );
    this.breaker.on('halfOpen', () =>
      this.logger.warn('Circuit breaker HALF-OPEN — probing Meta'),
    );
    this.breaker.on('close', () =>
      this.logger.log('Circuit breaker CLOSED — Meta sends resumed'),
    );
  }

  async sendTemplate(input: SendTemplateInput): Promise<SendResult> {
    try {
      return await this.breaker.fire(input);
    } catch (err) {
      // Map Opossum's open-circuit error to a domain error so the processor
      // sees a single error type and BullMQ retries it like any other failure.
      const e = err as { code?: string };
      if (e?.code === 'EOPENBREAKER') {
        throw new WhatsappSendError(
          'Meta circuit breaker open — provider unhealthy',
          'circuit_breaker_open',
        );
      }
      throw err;
    }
  }

  private async doSend(input: SendTemplateInput): Promise<SendResult> {
    const variables = Object.values(input.variables);
    const components = variables.length
      ? [
          {
            type: 'body',
            parameters: variables.map((text) => ({ type: 'text', text })),
          },
        ]
      : undefined;

    const body = {
      messaging_product: 'whatsapp',
      to: input.toE164.replace(/^\+/, ''),
      type: 'template',
      template: {
        name: input.templateName,
        language: { code: input.language },
        ...(components && { components }),
      },
    };

    try {
      const { data } = await this.http.post(`/${this.phoneNumberId}/messages`, body);
      return {
        providerMessageId: data.messages[0].id,
        acceptedAt: new Date(),
      };
    } catch (err) {
      const e = err as {
        response?: { data?: { error?: { code?: number | string; message?: string } } };
        message?: string;
      };
      const code = e.response?.data?.error?.code?.toString();
      const message = e.response?.data?.error?.message ?? e.message;
      this.logger.error({ code, message, body }, 'meta send failed');
      throw new WhatsappSendError('Meta Cloud API send failed', code, message);
    }
  }

  parseWebhook(payload: unknown): NormalizedEvent[] {
    const events: NormalizedEvent[] = [];
    const p = payload as {
      entry?: Array<{
        changes?: Array<{
          value?: {
            statuses?: Array<{
              id: string;
              status: string;
              timestamp: string;
              errors?: Array<{ code?: number | string; message?: string }>;
            }>;
          };
        }>;
      }>;
    } | null;
    if (!p?.entry) return events;
    for (const entry of p.entry) {
      for (const change of entry?.changes ?? []) {
        const statuses = change?.value?.statuses ?? [];
        for (const s of statuses) {
          // be-meta: drop statuses Meta might add that aren't in our union
          // (e.g. 'deleted', 'warning') instead of coercing junk downstream.
          const status = toKnownStatus(s.status);
          if (!status) continue;
          events.push({
            providerMessageId: s.id,
            status,
            errorCode: s.errors?.[0]?.code?.toString(),
            errorMessage: s.errors?.[0]?.message,
            occurredAt: parseMetaTimestamp(s.timestamp),
          });
        }
      }
    }
    return events;
  }

  parseInboundChatMessages(): InboundChatMessage[] {
    // Inbox feature is Evolution-only for now; Meta inbound handling stays in
    // webhooks.service (STOP-keyword opt-out). No chat persistence for Meta.
    return [];
  }

  async sendChatText(): Promise<never> {
    throw new Error('sendChatText is not supported by the Meta provider');
  }

  async markMessageAsRead(): Promise<void> { /* not supported */ }

  async sendPresence(): Promise<void> { /* not supported */ }

  async getMediaBase64(): Promise<MediaDownload> { throw new Error('getMediaBase64 not supported by Meta provider'); }
  async sendMedia(_args: SendMediaArgs): Promise<never> { throw new Error('sendMedia not supported by Meta provider'); }
  async sendWhatsAppAudio(_args: SendAudioArgs): Promise<never> { throw new Error('sendWhatsAppAudio not supported by Meta provider'); }
  async findChats(): Promise<never> { throw new Error('findChats not supported by Meta provider'); }
  async findMessages(): Promise<never> { throw new Error('findMessages not supported by Meta provider'); }

  parseInboundMessages(payload: unknown): InboundMessageEvent[] {
    const events: InboundMessageEvent[] = [];
    const p = payload as {
      entry?: Array<{
        changes?: Array<{
          value?: {
            messages?: Array<{
              id: string;
              from: string;
              timestamp: string;
              text?: { body?: string };
              button?: { text?: string };
            }>;
          };
        }>;
      }>;
    } | null;
    if (!p?.entry) return events;
    for (const entry of p.entry) {
      for (const change of entry?.changes ?? []) {
        const messages = change?.value?.messages ?? [];
        for (const m of messages) {
          // be-meta: `from` is untrusted; only digits form a valid E.164 number.
          // Drop messages with an empty/non-digit `from` instead of emitting a
          // junk fromE164 like '+' or '+not-digits'.
          const digits = typeof m.from === 'string' ? m.from.replace(/\D/g, '') : '';
          if (!digits) continue;
          const text = m.text?.body ?? m.button?.text;
          events.push({
            fromE164: '+' + digits,
            text,
            receivedAt: parseMetaTimestamp(m.timestamp),
            providerMessageId: m.id,
          });
        }
      }
    }
    return events;
  }
}
