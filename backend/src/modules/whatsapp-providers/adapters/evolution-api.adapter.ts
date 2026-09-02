import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import type { Env } from '../../../shared/config/env.schema';
import { renderTemplateBody } from '../../../shared/template/render-template-body';
import type {
  SendTemplateInput,
  SendResult,
  NormalizedEvent,
} from '../../../schemas/contracts/whatsapp.schema';
import type {
  ListConfig,
  ButtonsConfig,
  PollConfig,
  TemplateKind,
} from '../../../schemas/contracts/template.schema';
import type {
  MessageProvider,
  InboundMessageEvent,
  InboundChatMessage,
  InboundChatMedia,
  InstanceConnectionInfo,
  ConnectionState,
  EvolutionSettings,
  WhatsappLabel,
  SendChatTextArgs,
  ReadKey,
  MediaDownload,
  SendMediaArgs,
  SendAudioArgs,
  EvolutionChat,
  EvolutionMessagesPage,
} from '../ports/message-provider.port';
import { makeProfile } from '../ports/provider-profile';
import { PROVIDER_TRAITS } from '../../../schemas/contracts/channel-provider.schema';
import { WhatsappSendError } from '../errors/whatsapp.errors';
import { classifyEvolutionError } from './evolution-error-mapper';

// WhatsApp media is capped well under this; base64 inflates ~33%, so 96MB of
// response covers the largest legit document. Beyond this we refuse to buffer.
const MAX_MEDIA_RESPONSE_BYTES = 96 * 1024 * 1024;

/**
 * Per-instance snapshot from `GET /instance/fetchInstances`: live connection
 * state plus the device WhatsApp profile (phone JID, display name, photo).
 * Profile fields are null when the instance is disconnected or Evolution
 * returns junk shapes.
 */
export type EvolutionInstanceSnapshot = {
  state: string;
  ownerJid: string | null;
  profileName: string | null;
  profilePicUrl: string | null;
};

/** Coerce an untrusted Evolution field to a string or null. */
function asStringOrNull(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

/**
 * Extract the provider message id returned by every Evolution /message/send*
 * endpoint. Evolution can return either `key.id` (Baileys key shape) or a
 * top-level `messageId` string depending on the event type.
 */
function extractSentMessageId(data: unknown): string | undefined {
  const d = data as { key?: { id?: string }; messageId?: string } | null;
  return d?.key?.id ?? d?.messageId;
}

// ── sendTemplate per-kind request builders ──────────────────────────────────

/** A fully-resolved Evolution send request: endpoint path + request body. */
type EvolutionRequest = { path: string; body: Record<string, unknown> };

/** Inputs a per-kind builder needs to construct its EvolutionRequest. */
type TemplateRequestContext = {
  number: string;
  instance: string;
  input: SendTemplateInput;
  /** Interpolates `{{var}}` placeholders using the input's variable map. */
  interp: (s: string) => string;
};

// ── parseInboundChatMessages helpers ────────────────────────────────────────

type ParsedContent = { kind: InboundChatMessage['kind']; text?: string; media?: InboundChatMedia };

function toNum(v: unknown): number | undefined {
  const n = typeof v === 'string' ? parseInt(v, 10) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : undefined;
}

// Ordered extractors: first match wins. Mirrors the previous if/else chain exactly.
const CONTENT_EXTRACTORS: Array<(msg: Record<string, any>) => ParsedContent | null> = [
  (m) => (m.conversation || m.extendedTextMessage)
    ? { kind: 'TEXT', text: m.conversation ?? m.extendedTextMessage?.text }
    : null,
  (m) => m.imageMessage
    ? { kind: 'IMAGE', text: m.imageMessage.caption, media: { mimeType: m.imageMessage.mimetype, sizeBytes: toNum(m.imageMessage.fileLength), width: toNum(m.imageMessage.width), height: toNum(m.imageMessage.height) } }
    : null,
  (m) => m.videoMessage
    ? { kind: 'VIDEO', text: m.videoMessage.caption, media: { mimeType: m.videoMessage.mimetype, sizeBytes: toNum(m.videoMessage.fileLength), durationSec: toNum(m.videoMessage.seconds), width: toNum(m.videoMessage.width), height: toNum(m.videoMessage.height) } }
    : null,
  (m) => m.audioMessage
    ? { kind: 'AUDIO', media: { mimeType: m.audioMessage.mimetype, sizeBytes: toNum(m.audioMessage.fileLength), durationSec: toNum(m.audioMessage.seconds) } }
    : null,
  (m) => {
    const doc = m.documentMessage ?? m.documentWithCaptionMessage?.message?.documentMessage;
    return doc
      ? { kind: 'DOCUMENT', text: doc.caption, media: { mimeType: doc.mimetype, fileName: doc.fileName, sizeBytes: toNum(doc.fileLength) } }
      : null;
  },
  (m) => m.stickerMessage
    ? { kind: 'STICKER', media: { mimeType: m.stickerMessage.mimetype } }
    : null,
  (m) => m.locationMessage
    ? { kind: 'LOCATION', text: m.locationMessage.name ?? m.locationMessage.address }
    : null,
  (m) => (m.contactMessage || m.contactsArrayMessage)
    ? { kind: 'CONTACT', text: m.contactMessage?.displayName }
    : null,
];

// Baileys WAMessageStatus enum (numeric) — emitted by MESSAGES_UPDATE
const ACK_NUMERIC: Record<number, NormalizedEvent['status']> = {
  0: 'failed', // ERROR
  1: 'sent', // PENDING — locally queued (treat as sent for ORGAMIND)
  2: 'sent', // SERVER_ACK — WA server received (1 tick)
  3: 'delivered', // DELIVERY_ACK — recipient device received (2 grey ticks)
  4: 'read', // READ — 2 blue ticks
  5: 'read', // PLAYED — audio played
};

// Evolution string statuses — also emitted in webhooks depending on event
const ACK_STRING: Record<string, NormalizedEvent['status']> = {
  ERROR: 'failed',
  PENDING: 'sent',
  SERVER_ACK: 'sent',
  DELIVERY_ACK: 'delivered',
  READ: 'read',
  PLAYED: 'read',
};

/**
 * Evolution sends `messageTimestamp` either as Unix seconds (number or
 * numeric string) or as an ISO-ish `date_time` string. Treat anything we
 * can't parse as "now" so a malformed payload still gets a sensible
 * occurredAt rather than NaN.
 */
function parseEvolutionTimestamp(raw: number | string | undefined): Date {
  if (raw == null) return new Date();
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? new Date(raw * 1000) : new Date();
  }
  const asNumber = Number(raw);
  if (Number.isFinite(asNumber) && asNumber > 0) {
    return new Date(asNumber * 1000);
  }
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

@Injectable()
export class EvolutionApiAdapter implements MessageProvider {
  readonly name = 'evolution' as const;
  readonly profile = makeProfile(PROVIDER_TRAITS.EVOLUTION, [
    'campaignSend', 'sessionLifecycle', 'inboxChat', 'chatMedia',
    'contactTools', 'labels', 'historySync',
  ]);
  private readonly logger = new Logger(EvolutionApiAdapter.name);
  private readonly http: AxiosInstance;
  private readonly instance: string;

  /**
   * Calling Evolution's /instance/connect endpoint spawns a fresh Baileys
   * socket on every hit. If the frontend polls /whatsapp/connection every
   * 3-8s, repeated calls open multiple sockets that fight each other on
   * Meta's side and produce a `conflict/replaced` storm — looking exactly
   * like "another WhatsApp Web is logged in" even though there isn't one.
   *
   * We cache the QR/pairingCode for QR_CACHE_MS so polling the connection
   * status doesn't spawn new sockets. The cache is invalidated on `restart()`.
   *
   * Keyed by Evolution instance name: this adapter is a singleton, so a single
   * shared slot would serve one number's QR to another number's connect dialog
   * whenever two are polled within the TTL — the operator scans the wrong QR and
   * the second number never pairs. One entry per instance keeps them isolated.
   */
  private static readonly QR_CACHE_MS = 25_000;
  private readonly qrCache = new Map<
    string,
    {
      fetchedAt: number;
      qrBase64?: string;
      pairingCode?: string;
    }
  >();

  /**
   * listConnectionStates() cache. The adapter is a NestJS singleton and the
   * instances list is polled by the frontend every few seconds, so a short
   * TTL bounds Evolution load to one /instance/fetchInstances per window.
   */
  private static readonly STATES_CACHE_MS = 15_000;
  private statesCache?: {
    fetchedAt: number;
    states: Map<string, EvolutionInstanceSnapshot>;
  };

  constructor(private readonly config: ConfigService<Env>) {
    const baseURL =
      config.get('EVOLUTION_BASE_URL', { infer: true }) ?? 'http://localhost:8080';
    const apikey = config.get('EVOLUTION_API_KEY', { infer: true }) ?? '';
    this.instance =
      config.get('EVOLUTION_INSTANCE_NAME', { infer: true }) ?? 'picoa-dev';
    this.http = axios.create({
      baseURL,
      headers: { apikey, 'Content-Type': 'application/json' },
      timeout: 15_000,
    });
  }

  /**
   * Evolution Baileys does not support Meta templates — for TEXT kind we send
   * the raw body as plain text. Interactive kinds (LIST/BUTTONS/POLL) post to
   * Evolution's dedicated endpoints with the operator-defined config.
   *
   * Variable interpolation ({{var}}) runs over every operator-authored string
   * so contact data can flow into list rows, button labels, and poll options.
   *
   * Each kind has a pure builder that returns the Evolution endpoint + body to
   * POST; `sendTemplate` then runs a single post + shared id-extraction/error
   * handling. This keeps the per-kind payload shapes isolated and the dispatch
   * a flat map lookup rather than an if-ladder.
   */
  async sendTemplate(input: SendTemplateInput & { evolutionInstanceName?: string }): Promise<SendResult> {
    const instance = input.evolutionInstanceName ?? this.instance;
    const number = input.toE164.replace(/^\+/, '');
    const kind = input.kind ?? 'TEXT';

    const build = EvolutionApiAdapter.TEMPLATE_REQUEST_BUILDERS[kind];
    if (!build) {
      throw new WhatsappSendError(
        `Unsupported template kind: ${kind as string}`,
        'unsupported_kind',
      );
    }

    try {
      const { path, body } = build({
        number,
        input,
        instance,
        interp: (s) => this.interpolate(s, input.variables),
      });
      const { data } = await this.http.post(path, body);
      const id = extractSentMessageId(data);
      if (!id) {
        throw new WhatsappSendError(
          'Evolution send returned no message id',
          undefined,
          JSON.stringify(data ?? {}).slice(0, 200),
        );
      }
      return { providerMessageId: id, acceptedAt: new Date() };
    } catch (err) {
      this.handleSendError(err);
    }
  }

  /**
   * Per-kind Evolution request builders. Each returns the `/message/send*`
   * endpoint path and the request body for one template kind. Pure (no I/O):
   * `sendTemplate` does the single HTTP post and shared id/error handling.
   *
   * `delay` (ms) is accepted on every /message/send* — the bot shows
   * online + typing… for that long before the message lands. 0 == off.
   */
  private static readonly TEMPLATE_REQUEST_BUILDERS: Record<
    TemplateKind,
    (ctx: TemplateRequestContext) => EvolutionRequest
  > = {
    TEXT: ({ number, input, instance, interp }) => ({
      path: `/message/sendText/${instance}`,
      body: {
        number,
        text: interp(input.body ?? input.templateName),
        delay: input.delay ?? 0,
      },
    }),
    LIST: ({ number, input, instance, interp }) => {
      const cfg = input.interactiveConfig as ListConfig;
      return {
        path: `/message/sendList/${instance}`,
        body: {
          number,
          delay: input.delay ?? 0,
          title: interp(cfg.title),
          description: interp(cfg.description),
          buttonText: interp(cfg.buttonText),
          footerText: cfg.footerText ? interp(cfg.footerText) : undefined,
          values: cfg.sections.map((s) => ({
            title: interp(s.title),
            rows: s.rows.map((r) => ({
              title: interp(r.title),
              description: r.description ? interp(r.description) : '',
              rowId: r.rowId,
            })),
          })),
        },
      };
    },
    BUTTONS: ({ number, input, instance, interp }) => {
      const cfg = input.interactiveConfig as ButtonsConfig;
      return {
        path: `/message/sendButtons/${instance}`,
        body: {
          number,
          delay: input.delay ?? 0,
          title: cfg.title ? interp(cfg.title) : undefined,
          description: interp(cfg.description),
          footerText: cfg.footerText ? interp(cfg.footerText) : undefined,
          buttons: cfg.buttons.map((b) => ({
            buttonId: b.buttonId,
            buttonText: { displayText: interp(b.title) },
            type: 1,
          })),
        },
      };
    },
    POLL: ({ number, input, instance, interp }) => {
      const cfg = input.interactiveConfig as PollConfig;
      return {
        path: `/message/sendPoll/${instance}`,
        body: {
          number,
          delay: input.delay ?? 0,
          name: interp(cfg.question),
          selectableCount: cfg.selectableOptionsCount,
          values: cfg.options.map(interp),
        },
      };
    },
  };

  /**
   * Centralised error classification for every send path. Translates raw
   * Axios/Evolution responses into a domain `WhatsappSendError` with a
   * stable code so the worker can decide retry vs. permanent fail.
   *
   * Marked `never` so TS understands the helper always throws.
   */
  private handleSendError(err: unknown): never {
    if (err instanceof WhatsappSendError) throw err;
    const e = err as {
      response?: {
        data?: {
          message?: unknown;
          response?: { message?: unknown };
        };
      };
      message?: string;
    };
    const dataMsg = e.response?.data?.message;
    const rawMessage: unknown =
      (Array.isArray(dataMsg)
        ? dataMsg.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join('; ')
        : dataMsg) ??
      e.response?.data?.response?.message ??
      e.message;
    const classified = classifyEvolutionError(rawMessage);
    this.logger.error(
      { rawMessage, code: classified.code, fatal: classified.fatal },
      'evolution send failed',
    );
    throw new WhatsappSendError(
      classified.message,
      classified.code,
      typeof rawMessage === 'string' ? rawMessage : JSON.stringify(rawMessage),
      classified.fatal,
    );
  }

  /** Interpolate `{{key}}` placeholders using a flat string map. */
  /**
   * Delegado ao helper compartilhado: o texto que sai por AQUI tem de ser
   * idêntico, caractere a caractere, ao que o worker GRAVA em `Message.content`
   * (a bolha do Inbox e a evidência de consentimento). Duas implementações da
   * mesma interpolação acabariam divergindo.
   */
  private interpolate(text: string, vars: Record<string, string>): string {
    return renderTemplateBody(text, vars);
  }

  parseWebhook(payload: unknown): NormalizedEvent[] {
    const p = payload as
      | {
          event?: string;
          data?: {
            key?: { id?: string };
            keyId?: string;
            status?: number | string;
            messageTimestamp?: number | string;
            timestamp?: number | string;
          };
          date_time?: string;
        }
      | null;
    if (!p?.data) return [];
    const id = p.data.key?.id ?? p.data.keyId;
    if (!id) return [];

    const raw = p.data.status;
    let status: NormalizedEvent['status'] | undefined;
    if (typeof raw === 'number') status = ACK_NUMERIC[raw];
    else if (typeof raw === 'string') status = ACK_STRING[raw.toUpperCase()];
    if (!status) return [];

    // Prefer the provider-issued timestamp so a delayed/retried webhook still
    // records the real moment of the event. Fall back to `date_time` (top-level
    // payload field set by Evolution) and finally to the wall clock.
    const occurredAt = parseEvolutionTimestamp(
      p.data.messageTimestamp ?? p.data.timestamp ?? p.date_time,
    );
    return [{ providerMessageId: id, status, occurredAt }];
  }

  /**
   * Lightweight live connection state — calls ONLY /instance/connectionState,
   * never /instance/connect, so it's safe to poll (no Baileys socket spawn).
   * Returns null on error. Used by the connection-state reconciler.
   */
  async getLiveConnectionState(instanceName?: string): Promise<ConnectionState | null> {
    const instance = instanceName ?? this.instance;
    try {
      const { data } = await this.http.get(`/instance/connectionState/${instance}`);
      const raw = data?.instance?.state ?? data?.state;
      return raw === 'open' || raw === 'connecting' || raw === 'close' ? raw : null;
    } catch (err) {
      this.logger.warn({ err, instance }, 'getLiveConnectionState failed');
      return null;
    }
  }

  /**
   * Live snapshot for EVERY Evolution instance in one call
   * (`GET /instance/fetchInstances`, unfiltered). Returns a Map of
   * instanceName -> { state ('open' | 'close' | 'connecting'), ownerJid,
   * profileName, profilePicUrl } so callers can reconcile both the
   * connection state and the device WhatsApp profile.
   *
   * Cached for STATES_CACHE_MS: the instances list polls this on every
   * request, and the adapter singleton must not turn UI polling into an
   * Evolution fetchInstances storm.
   *
   * NEVER throws — on any HTTP/parse error it returns an empty Map so the
   * caller falls back to the DB-stored state.
   */
  async listConnectionStates(): Promise<Map<string, EvolutionInstanceSnapshot>> {
    const now = Date.now();
    if (
      this.statesCache &&
      now - this.statesCache.fetchedAt < EvolutionApiAdapter.STATES_CACHE_MS
    ) {
      return this.statesCache.states;
    }
    try {
      const { data } = await this.http.get('/instance/fetchInstances');
      const states = new Map<string, EvolutionInstanceSnapshot>();
      if (Array.isArray(data)) {
        for (const item of data as Array<{
          name?: unknown;
          connectionStatus?: unknown;
          ownerJid?: unknown;
          profileName?: unknown;
          profilePicUrl?: unknown;
        }>) {
          if (typeof item?.name === 'string' && typeof item?.connectionStatus === 'string') {
            states.set(item.name, {
              state: item.connectionStatus,
              ownerJid: asStringOrNull(item.ownerJid),
              profileName: asStringOrNull(item.profileName),
              profilePicUrl: asStringOrNull(item.profilePicUrl),
            });
          }
        }
      }
      this.statesCache = { fetchedAt: now, states };
      return states;
    } catch (err) {
      // Do not cache the failure — the next poll retries; callers fall back
      // to the DB state meanwhile.
      this.logger.warn({ err }, 'listConnectionStates failed; falling back to DB state');
      return new Map();
    }
  }

  async getConnectionInfo(instanceName?: string): Promise<InstanceConnectionInfo> {
    const instance = instanceName ?? this.instance;
    // 1) live socket state
    let state: ConnectionState = 'close';
    try {
      const { data } = await this.http.get(
        `/instance/connectionState/${instance}`,
      );
      const raw = data?.instance?.state ?? data?.state;
      if (raw === 'open' || raw === 'connecting' || raw === 'close') {
        state = raw;
      }
    } catch (err) {
      this.logger.warn({ err }, 'connectionState fetch failed');
    }

    // 2) pull the persisted disconnection reason — when the live socket says
    // "open" but the persisted record shows a recent reasonCode, the session
    // is actually flapping under the hood. Surfacing this lets the UI warn.
    let disconnectionReasonCode: number | null = null;
    let disconnectionAt: string | null = null;
    let ownerJid: string | null = null;
    let profileName: string | null = null;
    let profilePicUrl: string | null = null;
    try {
      const { data } = await this.http.get('/instance/fetchInstances', {
        params: { instanceName: instance },
      });
      const arr = Array.isArray(data) ? data : [];
      const match = arr.find(
        (i: { name?: string }) => i.name === instance,
      ) as
        | {
            disconnectionReasonCode?: number;
            disconnectionAt?: string;
            ownerJid?: string;
            profileName?: string;
            profilePicUrl?: string;
          }
        | undefined;
      if (match?.disconnectionReasonCode != null) {
        disconnectionReasonCode = match.disconnectionReasonCode;
      }
      if (match?.disconnectionAt) {
        disconnectionAt = match.disconnectionAt;
      }
      // Profile fields — only present when the number is (or was) connected.
      ownerJid = match?.ownerJid ?? null;
      profileName = match?.profileName ?? null;
      profilePicUrl = match?.profilePicUrl ?? null;
    } catch (err) {
      this.logger.warn({ err }, 'fetchInstances failed');
    }

    // 3) if not open, return the cached QR/pairingCode. Only hit
    //    /instance/connect when the cache is stale — that endpoint spawns
    //    a fresh Baileys socket on each call, so calling it on every poll
    //    creates a self-induced `conflict/replaced` storm.
    if (state === 'open') {
      // Connected — drop this instance's stale QR.
      this.qrCache.delete(instance);
      return { state, disconnectionReasonCode, disconnectionAt, ownerJid, profileName, profilePictureUrl: profilePicUrl };
    }

    const now = Date.now();
    const cached = this.qrCache.get(instance);
    const fresh =
      cached && now - cached.fetchedAt < EvolutionApiAdapter.QR_CACHE_MS;

    if (fresh && cached) {
      return {
        state,
        qrBase64: cached.qrBase64,
        pairingCode: cached.pairingCode,
        disconnectionReasonCode,
        disconnectionAt,
        ownerJid,
        profileName,
        profilePictureUrl: profilePicUrl,
      };
    }

    try {
      const { data } = await this.http.get(`/instance/connect/${instance}`);
      const b64 = data?.base64 as string | undefined;
      const code = data?.pairingCode as string | undefined;
      this.qrCache.set(instance, { fetchedAt: now, qrBase64: b64, pairingCode: code });
      return {
        state,
        qrBase64: b64,
        pairingCode: code,
        disconnectionReasonCode,
        disconnectionAt,
        ownerJid,
        profileName,
        profilePictureUrl: profilePicUrl,
      };
    } catch (err) {
      this.logger.warn({ err }, 'connect/QR fetch failed');
      // Surface whatever we have cached, even if stale, rather than nothing.
      if (cached) {
        return {
          state,
          qrBase64: cached.qrBase64,
          pairingCode: cached.pairingCode,
          disconnectionReasonCode,
          disconnectionAt,
          ownerJid,
          profileName,
          profilePictureUrl: profilePicUrl,
        };
      }
    }

    return { state, disconnectionReasonCode, disconnectionAt, ownerJid, profileName, profilePictureUrl: profilePicUrl };
  }

  /**
   * Tell Evolution to POST events back to our `/webhooks/whatsapp` endpoint
   * for the configured instance. We need this so MESSAGES_UPDATE (ack status
   * changes: sent → delivered → read) and inbound MESSAGES_UPSERT events
   * actually reach the backend; otherwise messages stay stuck in SENT
   * status and never advance.
   *
   * Idempotent — Evolution upserts the webhook record on each POST.
   *
   * `webhookUrl` resolves from the `EVOLUTION_WEBHOOK_URL` env var (allows
   * pointing Evolution at any reachable URL — e.g. an ngrok tunnel for
   * local QR-with-real-phone testing). Defaults to the Docker-internal
   * service URL `http://api:3000/webhooks/whatsapp`, which works for the
   * dev compose stack.
   */
  /**
   * The proxy to arm on Evolution instances, from env. Returns null when not
   * configured (host/port/protocol are all required by Evolution's ProxyDto).
   * Empty strings count as absent — the compose forwards `${VAR:-}` when unset.
   */
  private proxyConfig(): {
    enabled: true;
    host: string;
    port: string;
    protocol: string;
    username?: string;
    password?: string;
  } | null {
    const host = this.config.get('EVOLUTION_PROXY_HOST', { infer: true })?.trim();
    const port = this.config.get('EVOLUTION_PROXY_PORT', { infer: true })?.trim();
    const protocol = this.config.get('EVOLUTION_PROXY_PROTOCOL', { infer: true });
    if (!host || !port || !protocol) return null;
    const username =
      this.config.get('EVOLUTION_PROXY_USERNAME', { infer: true })?.trim() ||
      undefined;
    const password =
      this.config.get('EVOLUTION_PROXY_PASSWORD', { infer: true })?.trim() ||
      undefined;
    return {
      enabled: true,
      host,
      port,
      protocol,
      ...(username ? { username } : {}),
      ...(password ? { password } : {}),
    };
  }

  /**
   * Idempotently arm the configured outbound proxy on an Evolution instance.
   *
   * Evolution stores the proxy ON the instance (Postgres), so `restart()` —
   * which deletes + recreates the instance — silently drops it, and a freshly
   * provisioned instance is born without one. Both paths would then pair the
   * WhatsApp session from the VPS datacenter IP: the exact thing that gets the
   * number banned. Calling this after every create/heal makes the proxy
   * self-healing and declarative (driven by EVOLUTION_PROXY_*).
   *
   * Best-effort: a proxy failure must never block provisioning/QR. Credentials
   * are never logged.
   */
  async ensureProxyConfigured(instanceName?: string): Promise<void> {
    const inst = instanceName ?? this.instance;
    if (!inst) return;
    const proxy = this.proxyConfig();
    if (!proxy) return; // no proxy configured — nothing to arm
    try {
      await this.http.post(`/proxy/set/${inst}`, proxy);
      this.logger.log(
        `proxy armed for ${inst} (${proxy.protocol}://${proxy.host}:${proxy.port})`,
      );
    } catch (err) {
      this.logger.warn(
        { err },
        `ensureProxyConfigured: failed to set proxy for ${inst}`,
      );
    }
  }

  private async ensureWebhookConfigured(instanceName?: string): Promise<void> {
    const inst = instanceName ?? this.instance;
    const webhookUrl =
      this.config.get('EVOLUTION_WEBHOOK_URL', { infer: true }) ??
      'http://api:3000/webhooks/whatsapp';
    // Evolution sends a per-instance hash in `body.apikey` by default — not
    // the global EVOLUTION_API_KEY we authenticate the controller against.
    // Override by passing custom `headers.apikey` so Evolution echoes OUR
    // global key back; the controller's @Headers('apikey') check then works
    // as designed.
    const apikey = this.config.get('EVOLUTION_API_KEY', { infer: true });
    try {
      await this.http.post(`/webhook/set/${inst}`, {
        webhook: {
          enabled: true,
          url: webhookUrl,
          headers: apikey ? { apikey } : undefined,
          webhookByEvents: false,
          webhookBase64: false,
          events: [
            'MESSAGES_UPSERT',
            'MESSAGES_UPDATE',
            'CONNECTION_UPDATE',
            'QRCODE_UPDATED',
          ],
        },
      });
      this.logger.log(`Evolution webhook armed at ${webhookUrl}`);
    } catch (err) {
      this.logger.warn({ err }, 'ensureWebhookConfigured failed');
    }
  }

  /**
   * Whether Evolution actually knows about this instance. Uses fetchInstances
   * (a 200-with-array response) rather than connectionState (which 404s and is
   * harder to tell apart from auth/transient failures). On any error we assume
   * the instance exists, so a transient blip never triggers a duplicate create.
   */
  private async instanceExists(instanceName: string): Promise<boolean> {
    try {
      const { data } = await this.http.get('/instance/fetchInstances', {
        params: { instanceName },
      });
      return (
        Array.isArray(data) &&
        data.some((i: { name?: string }) => i.name === instanceName)
      );
    } catch (err) {
      // Evolution v2 returns 404 ("Instance \"X\" not found") when
      // fetchInstances is filtered by a name that doesn't exist — that's a
      // definitive "no", not a connectivity failure. Treat it as missing so
      // ensureProvisioned actually heals the orphan instead of skipping the
      // create (the old blanket "assume exists" meant a genuinely-missing
      // instance never got provisioned and every QR fetch 404'd forever).
      // Only genuine errors (network, 5xx) fall through to the conservative
      // "assume exists" that avoids duplicate-create races.
      const status = (err as { response?: { status?: number } })?.response
        ?.status;
      if (status === 404) return false;
      this.logger.warn({ err }, 'instanceExists check failed; assuming exists');
      return true;
    }
  }

  /**
   * Ensure the named instance exists on the Evolution side with its webhook
   * armed, creating it if missing. The app DB can hold a WhatsappInstance row
   * (notably the seed-created default) that was never created in Evolution —
   * connecting it then 404s forever and every message parks in
   * WAITING_INSTANCE. Calling this before serving a QR transparently heals
   * such orphans. Idempotent: a no-op once the instance exists.
   */
  async ensureProvisioned(instanceName?: string): Promise<void> {
    const inst = instanceName ?? this.instance;
    if (!inst) return;
    if (await this.instanceExists(inst)) {
      // Already provisioned — still re-arm the proxy. This runs on every
      // "Conectar (QR)" poll, so an instance whose proxy was dropped (e.g. by a
      // restart, or set up before EVOLUTION_PROXY_* existed) self-heals before
      // the next socket is spawned.
      await this.ensureProxyConfigured(inst);
      return;
    }
    this.logger.log(`Provisioning missing Evolution instance ${inst}`);
    try {
      await this.http.post('/instance/create', {
        instanceName: inst,
        integration: 'WHATSAPP-BAILEYS',
        qrcode: true,
        rejectCall: true,
        groupsIgnore: true,
      });
    } catch (err) {
      // A concurrent poll may have created it first (Evolution 403/409 on a
      // duplicate name) — tolerate and still arm the webhook below.
      this.logger.warn(
        { err },
        'ensureProvisioned: create failed (may already exist)',
      );
    }
    await this.ensureWebhookConfigured(inst);
    // Arm the outbound proxy BEFORE the socket is spawned, so the WhatsApp
    // session registers from the proxy's IP and never from the datacenter's.
    await this.ensureProxyConfigured(inst);
    // Force the next getConnectionInfo() to fetch a fresh QR for the new socket.
    // Scope to this instance so provisioning one number never drops another's QR.
    this.qrCache.delete(inst);
  }

  /**
   * Bulk-check whether numbers exist on WhatsApp. Evolution accepts up to ~50
   * numbers per request comfortably; chunking is the caller's responsibility
   * to keep payloads small. Returns one entry per input — `exists: false` and
   * `jid: null` for numbers without a WhatsApp account.
   *
   * `exists` is typed `boolean | null` on the port (fix round 2 — GoZap can
   * report `null` for an unconfirmed match). Evolution's `/chat/whatsappNumbers`
   * is a confirmed true/false check; this adapter never returns `null`.
   */
  async checkNumbersOnWhatsapp(
    phonesE164: string[],
    instanceName?: string,
  ): Promise<
    Array<{ exists: boolean | null; jid: string | null; number: string }>
  > {
    const inst = instanceName ?? this.instance;
    if (phonesE164.length === 0) return [];
    // Evolution wants raw digits (no +)
    const numbers = phonesE164.map((p) => p.replace(/^\+/, ''));
    const { data } = await this.http.post(
      `/chat/whatsappNumbers/${inst}`,
      { numbers },
    );
    return Array.isArray(data) ? data : [];
  }

  /**
   * Fetch a single contact's WhatsApp profile picture URL. Returns null if
   * the user has no picture set or has restricted profile access.
   */
  async fetchProfilePictureUrl(jid: string, instanceName?: string): Promise<string | null> {
    const inst = instanceName ?? this.instance;
    try {
      const { data } = await this.http.post(
        `/chat/fetchProfilePictureUrl/${inst}`,
        { number: jid },
      );
      const url = data?.profilePictureUrl;
      return typeof url === 'string' && url.length > 0 ? url : null;
    } catch (err) {
      // 404 is normal (no picture); only log other failures.
      const status = (err as { response?: { status?: number } })?.response
        ?.status;
      if (status !== 404) {
        this.logger.warn({ err }, 'fetchProfilePictureUrl failed');
      }
      return null;
    }
  }

  /**
   * Update per-instance Baileys flags. Accepts a partial — Evolution merges
   * with the current state on its side, so we only need to send what changed.
   */
  async setSettings(settings: Partial<EvolutionSettings>, instanceName?: string): Promise<void> {
    const inst = instanceName ?? this.instance;
    await this.http.post(`/settings/set/${inst}`, settings);
  }

  /**
   * Fetch every label the user has created in WhatsApp Business. Returns an
   * empty list (and logs) on any error so the UI can render an empty state
   * instead of crashing.
   */
  async fetchLabels(instanceName?: string): Promise<WhatsappLabel[]> {
    const inst = instanceName ?? this.instance;
    try {
      const { data } = await this.http.get(
        `/label/findLabels/${inst}`,
      );
      return Array.isArray(data) ? data : [];
    } catch (err) {
      this.logger.warn({ err }, 'fetchLabels failed');
      return [];
    }
  }

  /**
   * Add or remove a single WhatsApp label on a chat (identified by JID).
   * Caller is expected to pass a fully-formed `<digits>@s.whatsapp.net` JID —
   * `ContactsService.setLabels` builds it from `phoneE164`.
   */
  async handleContactLabel(args: {
    jid: string;
    labelId: string;
    action: 'add' | 'remove';
    instanceName?: string;
  }): Promise<void> {
    const inst = args.instanceName ?? this.instance;
    await this.http.post(`/label/handleLabel/${inst}`, {
      number: args.jid,
      labelId: args.labelId,
      action: args.action,
    });
  }

  // ── Chat outbound primitives ──

  async sendChatText(args: SendChatTextArgs): Promise<SendResult> {
    const instance = args.instanceName ?? this.instance;
    // Recipient may be a phone ("+55…") OR a full WhatsApp JID (e.g. a "@lid"
    // address). Evolution's `number` field accepts a full JID as-is; only the
    // phone form needs the leading "+" stripped.
    const number = args.toE164.includes('@')
      ? args.toE164
      : args.toE164.replace(/^\+/, '');
    const body: Record<string, unknown> = { number, text: args.text, delay: args.delay ?? 0 };
    if (args.quotedWaMessageId) {
      body.quoted = { key: { id: args.quotedWaMessageId }, message: { conversation: args.quotedPreview ?? '' } };
    }
    try {
      const { data } = await this.http.post(`/message/sendText/${instance}`, body);
      const id = extractSentMessageId(data);
      if (!id) {
        throw new WhatsappSendError('Evolution sendText returned no message id', undefined, JSON.stringify(data ?? {}).slice(0, 200));
      }
      return { providerMessageId: id, acceptedAt: new Date() };
    } catch (err) {
      this.handleSendError(err);
    }
  }

  async markMessageAsRead(instanceName: string, keys: ReadKey[]): Promise<void> {
    if (keys.length === 0) return;
    const instance = instanceName ?? this.instance;
    try {
      await this.http.post(`/chat/markMessageAsRead/${instance}`, { readMessages: keys });
    } catch (err) {
      this.logger.warn({ err }, 'markMessageAsRead failed');
    }
  }

  async sendPresence(instanceName: string, toE164: string, presence: 'composing' | 'recording' | 'paused', delay = 2000): Promise<void> {
    const instance = instanceName ?? this.instance;
    const number = toE164.replace(/^\+/, '');
    try {
      await this.http.post(`/chat/sendPresence/${instance}`, { number, delay, presence });
    } catch (err) {
      this.logger.warn({ err }, 'sendPresence failed');
    }
  }

  async getMediaBase64(instanceName: string, key: { id: string; remoteJid: string; fromMe: boolean }): Promise<MediaDownload> {
    const instance = instanceName ?? this.instance;
    const { data } = await this.http.post(
      `/chat/getBase64FromMediaMessage/${instance}`,
      { message: { key }, convertToMp4: false },
      { maxContentLength: MAX_MEDIA_RESPONSE_BYTES, maxBodyLength: MAX_MEDIA_RESPONSE_BYTES },
    );
    const d = data as { base64?: string; mimetype?: string; fileName?: string };
    if (!d?.base64) throw new Error('Evolution returned no media base64');
    return { base64: d.base64, mimeType: d.mimetype ?? 'application/octet-stream', fileName: d.fileName };
  }

  async sendMedia(args: SendMediaArgs): Promise<SendResult> {
    const instance = args.instanceName ?? this.instance;
    const number = args.toE164.replace(/^\+/, '');
    const body: Record<string, unknown> = { number, mediatype: args.mediatype, mimetype: args.mimetype, media: args.mediaBase64, fileName: args.fileName, caption: args.caption, delay: args.delay ?? 0 };
    if (args.quotedWaMessageId) body.quoted = { key: { id: args.quotedWaMessageId }, message: { conversation: args.quotedPreview ?? '' } };
    try {
      const { data } = await this.http.post(`/message/sendMedia/${instance}`, body);
      const id = extractSentMessageId(data);
      if (!id) throw new WhatsappSendError('Evolution sendMedia returned no id', undefined, JSON.stringify(data ?? {}).slice(0, 200));
      return { providerMessageId: id, acceptedAt: new Date() };
    } catch (err) { this.handleSendError(err); }
  }

  async sendWhatsAppAudio(args: SendAudioArgs): Promise<SendResult> {
    const instance = args.instanceName ?? this.instance;
    const number = args.toE164.replace(/^\+/, '');
    const body: Record<string, unknown> = { number, audio: args.audioBase64, delay: args.delay ?? 0 };
    if (args.quotedWaMessageId) body.quoted = { key: { id: args.quotedWaMessageId }, message: { conversation: args.quotedPreview ?? '' } };
    try {
      const { data } = await this.http.post(`/message/sendWhatsAppAudio/${instance}`, body);
      const id = extractSentMessageId(data);
      if (!id) throw new WhatsappSendError('Evolution sendWhatsAppAudio returned no id', undefined, JSON.stringify(data ?? {}).slice(0, 200));
      return { providerMessageId: id, acceptedAt: new Date() };
    } catch (err) { this.handleSendError(err); }
  }

  // ── History read ──

  async findChats(instanceName: string): Promise<EvolutionChat[]> {
    const instance = instanceName ?? this.instance;
    const { data } = await this.http.post(`/chat/findChats/${instance}`, {});
    const rows = Array.isArray(data) ? data : [];
    return rows.map((c: any) => ({
      remoteJid: c.remoteJid, name: c.name ?? c.pushName ?? null,
      profilePicUrl: c.profilePicUrl ?? null, unreadCount: typeof c.unreadCount === 'number' ? c.unreadCount : 0,
      // For @lid chats WhatsApp exposes the real phone JID on the message key as
      // remoteJidAlt — use it to resolve the actual number for display.
      altJid: c.lastMessage?.key?.remoteJidAlt ?? null,
    }));
  }

  async findMessages(instanceName: string, remoteJid: string, page: number, pageSize = 50): Promise<EvolutionMessagesPage> {
    const instance = instanceName ?? this.instance;
    const { data } = await this.http.post(`/chat/findMessages/${instance}`, { where: { key: { remoteJid } }, page, offset: pageSize, sort: 'asc' });
    const m = (data as { messages?: { total?: number; pages?: number; currentPage?: number; records?: unknown[] } })?.messages;
    return { records: m?.records ?? [], total: m?.total ?? 0, pages: m?.pages ?? 0, currentPage: m?.currentPage ?? page };
  }

  // ── Admin operations (consumed by WhatsappInstancesService via EVOLUTION_ADMIN_CLIENT) ──

  async adminCreateInstance(args: { instanceName: string }): Promise<{ apiKey: string }> {
    await this.http.post('/instance/create', {
      instanceName: args.instanceName,
      integration: 'WHATSAPP-BAILEYS',
      qrcode: true,
      rejectCall: true,
      groupsIgnore: true,
    });
    // be-whatsapp-003: deliberately DO NOT return the per-instance apiKey
    // Evolution hands back. Every adapter request authenticates with the global
    // EVOLUTION_API_KEY (set as the `apikey` header in the constructor), so the
    // per-instance key is never used — persisting it is a dead secret and pure
    // attack surface. A5 already strips it from read responses; here we make
    // sure the service never receives the real value to persist in the first
    // place, so the stored column stays empty. A missing key is therefore no
    // longer an error: provisioning must continue regardless.
    // Arm the webhook now — without CONNECTION_UPDATE deliveries the backend
    // never records a `state=open` connection event, so the router treats the
    // instance as permanently offline and parks every message in
    // WAITING_INSTANCE. (This was the prod outage: the default instance had no
    // webhook and nothing was ever sent.)
    await this.ensureWebhookConfigured(args.instanceName);
    // A brand-new instance ("Nova conexão") must also egress through the proxy.
    await this.ensureProxyConfigured(args.instanceName);
    return { apiKey: '' };
  }

  async adminLogout(instanceName: string): Promise<void> {
    await this.http.delete(`/instance/logout/${instanceName}`);
  }

  async adminRestart(instanceName: string): Promise<void> {
    await this.http.put(`/instance/restart/${instanceName}`);
  }

  parseInboundMessages(payload: unknown): InboundMessageEvent[] {
    const p = payload as
      | {
          event?: string;
          data?: {
            key?: { id?: string; remoteJid?: string; fromMe?: boolean };
            message?: {
              conversation?: string;
              extendedTextMessage?: { text?: string };
              buttonsResponseMessage?: { selectedDisplayText?: string };
            };
            messageTimestamp?: number;
            pushName?: string;
          };
        }
      | null;
    if (!p?.data) return [];
    if (p.data.key?.fromMe) return []; // ignore own outbound echoes
    const remoteJid = p.data.key?.remoteJid;
    const id = p.data.key?.id;
    if (!remoteJid || !id) return [];
    // Only classic phone JIDs carry a real phone number. A @lid's digits are an
    // opaque LID and a @g.us group's are a group id — never a phone, so treating
    // them as fromE164 would opt-out the wrong (or no) contact. Skip them here.
    if (!remoteJid.endsWith('@s.whatsapp.net')) return [];
    // remoteJid format: "5511987654321@s.whatsapp.net" — extract digits
    const digits = remoteJid.split('@')[0].replace(/\D/g, '');
    if (!digits) return [];

    const text =
      p.data.message?.conversation ??
      p.data.message?.extendedTextMessage?.text ??
      p.data.message?.buttonsResponseMessage?.selectedDisplayText;

    return [
      {
        providerMessageId: id,
        fromE164: `+${digits}`,
        text,
        receivedAt: new Date(
          (p.data.messageTimestamp ?? Math.floor(Date.now() / 1000)) * 1000,
        ),
      },
    ];
  }

  parseInboundChatMessages(payload: unknown): InboundChatMessage[] {
    const p = payload as {
      event?: string;
      data?: {
        key?: { id?: string; remoteJid?: string; fromMe?: boolean; participant?: string; remoteJidAlt?: string; senderPn?: string };
        pushName?: string;
        message?: Record<string, any>;
        messageType?: string;
        messageTimestamp?: number;
        speechToText?: string;
      };
    } | null;
    const d = p?.data;
    const remoteJid = d?.key?.remoteJid;
    const id = d?.key?.id;
    if (!d || !remoteJid || !id) return [];

    const isGroup = remoteJid.endsWith('@g.us');
    const digits = remoteJid.split('@')[0].replace(/\D/g, '');
    // The alternate JID (real phone JID when remoteJid is a @lid). senderPn is
    // the equivalent on some stanzas. Only meaningful as the real phone.
    const altJid = d.key?.remoteJidAlt ?? d.key?.senderPn ?? null;
    // Real phone only for classic phone JIDs; a @lid's digits are an opaque LID,
    // never a phone — leave null and let the ingest resolve it via altJid/map.
    const phoneE164 = remoteJid.endsWith('@s.whatsapp.net') ? `+${digits}` : null;
    const msg = d.message ?? {};

    let parsed: ParsedContent = { kind: 'UNSUPPORTED' };
    for (const extract of CONTENT_EXTRACTORS) {
      const r = extract(msg);
      if (r) { parsed = r; break; }
    }
    const { kind, text, media } = parsed;

    const ctx = msg.extendedTextMessage?.contextInfo
      ?? msg.imageMessage?.contextInfo
      ?? msg.videoMessage?.contextInfo
      ?? msg.audioMessage?.contextInfo
      ?? msg.documentMessage?.contextInfo;
    const quotedWaMessageId = ctx?.stanzaId;
    const quoted = ctx?.quotedMessage;
    const quotedPreview = quoted?.conversation ?? quoted?.extendedTextMessage?.text;

    // Evolution delivers exactly one message per MESSAGES_UPSERT webhook, so we
    // return a single-element array. Revisit if Evolution ever batches messages.
    return [{
      providerMessageId: id,
      remoteJid,
      phoneE164,
      altJid,
      isGroup,
      fromMe: Boolean(d.key?.fromMe),
      pushName: d.pushName ?? undefined,
      kind,
      text,
      transcript: d.speechToText ?? null,
      media,
      quotedWaMessageId,
      quotedPreview,
      receivedAt: new Date((d.messageTimestamp ?? Math.floor(Date.now() / 1000)) * 1000),
    }];
  }
}
