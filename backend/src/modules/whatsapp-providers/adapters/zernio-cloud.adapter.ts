import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import { createHmac, timingSafeEqual } from 'crypto';
import type {
  SendTemplateInput,
  SendResult,
  NormalizedEvent,
} from '../../../schemas/contracts/whatsapp.schema';
import type {
  MessageProvider,
  InboundMessageEvent,
  InboundChatMessage,
  SendChatTextArgs,
} from '../ports/message-provider.port';
import { makeProfile } from '../ports/provider-profile';
import { PROVIDER_TRAITS } from '../../../schemas/contracts/channel-provider.schema';
import { WhatsappSendError } from '../errors/whatsapp.errors';
import { classifyZernioError } from './zernio-error-mapper';
import {
  OPT_IN_BUTTON,
  OPT_OUT_BUTTON,
  isZernioOptInButton,
  isZernioOptOutButton,
  squashButton,
} from '../../../schemas/contracts/consent-button.schema';

const DEFAULT_BASE_URL = 'https://zernio.com/api/v1';

// Zernio inbox status events → our normalized ack union. `message.edited` /
// `message.deleted` / `reaction.received` carry no delivery-ack meaning.
const STATUS_MAP: Record<string, NormalizedEvent['status'] | undefined> = {
  'message.sent': 'sent',
  'message.delivered': 'delivered',
  'message.read': 'read',
  'message.failed': 'failed',
};

// Zernio attachment.type → our InboundChatMessage.kind.
const ATTACHMENT_KIND: Record<string, InboundChatMessage['kind']> = {
  image: 'IMAGE',
  video: 'VIDEO',
  audio: 'AUDIO',
  file: 'DOCUMENT',
  document: 'DOCUMENT',
  sticker: 'STICKER',
  location: 'LOCATION',
  contact: 'CONTACT',
  contacts: 'CONTACT',
};

type ZernioAttachment = {
  id?: string;
  type?: string;
  url?: string;
  filename?: string;
  previewUrl?: string;
};

type ZernioMessage = {
  /**
   * Zernio's INTERNAL id (a Mongo ObjectId, e.g. `a1b2c3d4e5f6a7b8c9d00003`) —
   * NOT the WhatsApp message id. Only a fallback for `platformMessageId`.
   */
  id?: string;
  /**
   * The WAMID — the Meta message id (`wamid.…`). This is the id that
   * `POST /inbox/conversations` returns as `data.messageId` and that the send
   * path persists as `providerMessageId`, so it is the ONLY id a status event
   * can be matched by. (The REST inbox, confusingly, returns the wamid as
   * `messages[].id`; the webhook splits the two. Always normalize to the wamid.)
   */
  platformMessageId?: string;
  /** Text lives in `message` (API schema); real webhook payloads use `text`. */
  message?: string;
  text?: string;
  senderId?: string;
  senderName?: string;
  attachments?: ZernioAttachment[];
};

/**
 * Everything interactive that a user does arrives on the SAME `message.received`
 * event, inside `metadata` — not in `message`. This is where a **button tap**
 * lives, and therefore where the mandatory MARKETING opt-out button lands.
 *
 * Two flavours, per the API docs:
 *  - **Template** button (our case): the payload rides in `metadata.buttonPayload`
 *    and `interactiveType` comes back EMPTY.
 *  - **Interactive** message button/list: `interactiveType` is
 *    `button_reply` | `list_reply` | `nfm_reply` and the id we defined rides in
 *    `metadata.interactiveId`.
 */
type ZernioMetadata = {
  interactiveType?: string;
  interactiveId?: string;
  buttonPayload?: string;
};

type ZernioWebhookEnvelope = {
  id?: string;
  event?: string;
  message?: ZernioMessage;
  conversation?: {
    id?: string;
    participantId?: string;
    participantName?: string;
  };
  account?: { id?: string; platform?: string };
  metadata?: ZernioMetadata;
  statusAt?: string;
  timestamp?: string;
  error?: { code?: number | string; title?: string; message?: string } | null;
};

type ZernioErrorBody = {
  error?: string;
  type?: string;
  code?: number | string;
  param?: string;
  platform?: string;
  platformError?: {
    code?: number | string;
    error?: { code?: number | string };
  };
};

type ZernioSendResponse = {
  success?: boolean;
  data?: { messageId?: string; conversationId?: string; sentAt?: string };
};

/**
 * Request body of `POST /inbox/conversations` — o MESMO endpoint serve os dois
 * envios, e a diferença é o corpo:
 *
 *  - TEMPLATE  → `{accountId, participantId, templateName, templateLanguage,
 *                 templateParams, headerMedia?}` — reabre a conversa (única
 *                 forma de falar FORA da janela de 24h);
 *  - TEXTO LIVRE → `{accountId, participantId, message}` — mensagem de sessão,
 *                 só DENTRO da janela de 24h.
 *
 * É união, não campos opcionais: o template continua EXIGINDO os seus, e um
 * texto livre nunca pode escorregar com metade de um template no corpo.
 *
 * `skipDmCheck` (documentado no schema) é o bypass da checagem de DM do
 * X/Twitter — sem semântica no WhatsApp. NÃO é enviado, de propósito.
 */
type ZernioTemplateBody = {
  accountId: string;
  participantId: string;
  templateName: string;
  templateLanguage: string;
  templateParams: string[];
  /** Media header override; omitted entirely for BODY-only templates. */
  headerMedia?: SendTemplateInput['headerMedia'];
};

type ZernioFreeFormBody = {
  accountId: string;
  participantId: string;
  /** O texto da mensagem de sessão (campo `message` do schema da API). */
  message: string;
};

type ZernioConversationBody = ZernioTemplateBody | ZernioFreeFormBody;

/** `+55...` / `whatsapp:+55...` → the bare international digits (no `+`). */
function digitsOnly(value: string): string {
  return value.replace(/\D/g, '');
}

/**
 * The id a Zernio event must be keyed by: the WAMID (`message.platformMessageId`),
 * falling back to Zernio's internal ObjectId (`message.id`) only when the event
 * carries no wamid.
 *
 * This is THE correctness pivot of the adapter. The send path stores
 * `data.messageId` — which the live API returns as the **wamid** — in
 * `Message.providerMessageId`. The status webhook, however, puts its internal
 * Mongo ObjectId in `message.id` and the wamid in `message.platformMessageId`.
 * Keying off `message.id` therefore matched NOTHING: every Zernio message stayed
 * stuck in SENT, with no delivered/read/failed ever recorded.
 */
function eventMessageId(m: ZernioMessage | undefined): string | undefined {
  const wamid = m?.platformMessageId?.trim();
  if (wamid) return wamid;
  return m?.id?.trim() || undefined;
}

/**
 * O VOCABULÁRIO DE CONSENTIMENTO mora agora num CONTRATO PURO
 * (`schemas/contracts/consent-button.schema.ts`) — extração MECÂNICA, sem
 * mudar uma vírgula de regra (este spec passou sem edição nenhuma).
 *
 * O motivo é o loop do rótulo: como o Zernio não transporta payload de
 * quick_reply, o clique só é reconhecível pelo RÓTULO, e o rótulo é escolhido na
 * CRIAÇÃO do template. Enquanto a lista fechada morava aqui dentro (um arquivo
 * que arrasta Nest/Prisma/axios), o módulo `templates` não conseguia validar
 * contra ela e a UI não conseguia oferecê-la — só COPIAR. Duas cópias divergem,
 * e a divergência apaga consentimento em silêncio. Uma fonte, nenhuma cópia.
 *
 * Reexportado para não quebrar quem importa do adapter.
 */
export {
  isZernioOptInButton,
  isZernioOptOutButton,
} from '../../../schemas/contracts/consent-button.schema';

/**
 * The button the user tapped, normalized to the port's contract: opt-out
 * signals collapse to the canonical `optout`, opt-in signals to `optin_yes`,
 * and every other button keeps its raw payload/id.
 * Returns undefined when the event is not a button tap at all.
 */
function buttonPayloadOf(
  metadata: ZernioMetadata | undefined,
  label: string | undefined,
): string | undefined {
  const raw =
    metadata?.buttonPayload?.trim() || metadata?.interactiveId?.trim() || undefined;
  // NOT a button tap → nothing to canonicalize. This is the guard that keeps
  // someone TYPING "sim" from ever becoming consent: below this line we only
  // consider the label because a tap has already been proven. Do not weaken it.
  if (!raw) return undefined;
  // Opt-out FIRST, always: "Não quero receber" is a refusal, even though it
  // contains "quero receber".
  if (isZernioOptOutButton(raw, label, squashButton(raw), squashButton(label)))
    return OPT_OUT_BUTTON;
  if (isZernioOptInButton(raw, label)) return OPT_IN_BUTTON;
  return raw;
}

/**
 * Zernio `templateParams` is a flat POSITIONAL array (header, body, buttons).
 * Our `variables` map is keyed by the numbered placeholder ("1","2",…), so we
 * order by numeric key — 1, 2, 10 (NOT lexicographic 1, 10, 2) — and emit the
 * values. Non-numeric keys sort after, lexicographically, for determinism.
 */
function orderedTemplateParams(variables: Record<string, string>): string[] {
  return Object.keys(variables)
    .sort((a, b) => {
      const na = Number(a);
      const nb = Number(b);
      const aNum = Number.isFinite(na);
      const bNum = Number.isFinite(nb);
      if (aNum && bNum) return na - nb;
      if (aNum) return -1;
      if (bNum) return 1;
      return a.localeCompare(b);
    })
    .map((k) => variables[k]);
}

/**
 * WhatsApp via Zernio (official Meta route). The provider registry wires it by
 * DI token; `implements MessageProvider` gives structural verification against
 * the port.
 */
@Injectable()
export class ZernioCloudAdapter implements MessageProvider {
  readonly name = 'zernio' as const;
  readonly profile = makeProfile(PROVIDER_TRAITS.ZERNIO, ['campaignSend', 'inboxChat']);

  private readonly logger = new Logger(ZernioCloudAdapter.name);
  private readonly http: AxiosInstance;
  private readonly webhookSecret?: string;

  constructor(config: ConfigService) {
    const apiKey = config.get<string>('ZERNIO_API_KEY') ?? '';
    const baseURL =
      config.get<string>('ZERNIO_BASE_URL')?.trim() || DEFAULT_BASE_URL;
    this.webhookSecret =
      config.get<string>('ZERNIO_WEBHOOK_SECRET')?.trim() || undefined;
    this.http = axios.create({
      baseURL,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      // Zernio has no documented Retry-After; a generous 30s avoids ambiguous
      // client timeouts on a POST that may already have been accepted+billed.
      timeout: 30_000,
    });
  }

  /**
   * O accountId (número WhatsApp conectado) do canal. Sem env fallback: falha
   * rápido e FATAL em vez de POSTar algo que o Zernio rejeitaria com
   * "accountId is required".
   */
  private requireAccountId(zernioAccountId?: string | null): string {
    const accountId = zernioAccountId?.trim();
    if (!accountId) {
      throw new WhatsappSendError(
        'Canal Zernio sem accountId: configure o accountId (número WhatsApp conectado) do canal para enviar.',
        'zernio.account_missing',
        undefined,
        true,
      );
    }
    return accountId;
  }

  /**
   * TEXTO LIVRE (mensagem de sessão) — a resposta manual do operador no inbox.
   *
   * Sem isto, o único canal do cliente (ZERNIO) não deixava responder NINGUÉM:
   * quem respondia à campanha ficava falando sozinho. É o MESMO
   * `POST /inbox/conversations` do template, com `message` no lugar do bloco de
   * template — o `data.messageId` volta como o wamid, então o casamento dos
   * eventos de status (sent/delivered/read/failed) funciona de graça, sem uma
   * linha nova no parseWebhook.
   *
   * A JANELA DE 24h NÃO É CHECADA AQUI, de propósito: o guard vive no
   * ChatService (`assertSessionWindowOpen`), ANTES de criar a mensagem e antes
   * de gastar a requisição. O 131047 que o `toSendError` classifica é a rede de
   * segurança da corrida com o fechamento da janela, não o plano A.
   *
   * CITAÇÃO: o body do Zernio não tem campo de reply. `quotedWaMessageId` é
   * deliberadamente IGNORADO (persistido localmente, nunca inventado no wire).
   */
  async sendChatText(args: SendChatTextArgs): Promise<SendResult> {
    const body: ZernioFreeFormBody = {
      accountId: this.requireAccountId(args.zernioAccountId),
      participantId: digitsOnly(args.toE164),
      message: args.text,
    };
    return this.postConversation(body);
  }

  async sendTemplate(input: SendTemplateInput): Promise<SendResult> {
    const accountId = this.requireAccountId(input.zernioAccountId);
    const body: ZernioTemplateBody = {
      accountId,
      participantId: digitsOnly(input.toE164),
      templateName: input.templateName,
      templateLanguage: input.language,
      templateParams: orderedTemplateParams(input.variables),
    };
    // Only attach the key when the caller actually has a media header —
    // templates with a media header already render their APPROVED sample asset
    // when `headerMedia` is absent, and a `headerMedia: undefined` key would
    // serialize into the JSON body as a field Zernio has to reject.
    if (input.headerMedia) body.headerMedia = input.headerMedia;
    return this.postConversation(body);
  }

  private async postConversation(body: ZernioConversationBody): Promise<SendResult> {
    try {
      const { data } = await this.http.post<ZernioSendResponse>(
        '/inbox/conversations',
        body,
      );
      const messageId = data?.data?.messageId;
      if (!messageId) {
        throw new WhatsappSendError(
          'Zernio aceitou o envio mas não retornou messageId.',
          'zernio.no_message_id',
          JSON.stringify(data ?? {}),
          false,
        );
      }
      const sentAt = data?.data?.sentAt;
      return {
        providerMessageId: messageId,
        acceptedAt: sentAt ? new Date(sentAt) : new Date(),
      };
    } catch (err) {
      if (err instanceof WhatsappSendError) throw err;
      throw this.toSendError(err);
    }
  }

  /**
   * Maps an axios error (Zernio envelope, Meta platformError, or a raw network
   * failure) into a classified {@link WhatsappSendError} — same convention as the
   * Twilio adapter (PT operator message in arg1, raw provider text preserved).
   */
  private toSendError(err: unknown): WhatsappSendError {
    const e = err as {
      code?: string;
      message?: string;
      response?: { status?: number; data?: ZernioErrorBody };
    };
    let providerMessage =
      e.response?.data?.error ?? e.message ?? 'Falha no envio via Zernio';
    const type = e.response?.data?.type;
    let code: string | undefined;

    if (e.response) {
      const data = e.response.data;
      // Prefer the upstream Meta code when Zernio wrapped a platform_error,
      // then the Zernio code, then the bare HTTP status (covers 429/5xx bodies
      // that omit a machine code).
      const platformCode =
        data?.platformError?.code ?? data?.platformError?.error?.code;
      const raw = platformCode ?? data?.code ?? e.response.status;
      code = raw != null ? String(raw) : undefined;
    } else {
      const netCode = e.code;
      if (
        netCode === 'ECONNREFUSED' ||
        netCode === 'ENOTFOUND' ||
        netCode === 'EAI_AGAIN'
      ) {
        code = 'zernio.unreachable';
        providerMessage = `Zernio inacessível (${netCode})`;
      } else {
        // ECONNABORTED (timeout), ECONNRESET, socket hang up, etc. — the POST
        // may have been accepted+billed, so this is INDETERMINATE (non-fatal).
        code = 'zernio.timeout';
        providerMessage = e.message ?? 'Timeout ao falar com o Zernio';
      }
    }

    const cls = classifyZernioError(code, type, providerMessage);
    this.logger.error({ code, type, fatal: cls.fatal }, 'zernio send failed');
    return new WhatsappSendError(
      cls.message,
      cls.code,
      providerMessage,
      cls.fatal,
    );
  }

  /**
   * ZW — o evento de status, agora COM O TELEFONE.
   *
   * O `recipientPhone` (de `conversation.participantId`, que vem sem o '+') é o
   * que torna o BROADCAST rastreável. Sondagem ao vivo (13/07, produção):
   *
   *  - `GET /broadcasts/{id}/recipients` **não devolve wamid**, nem
   *    `sentAt`/`deliveredAt`/`readAt`, nem `errorCode` — e o `status` de lá fica
   *    CONGELADO em `pending` (50/50 destinatários ainda `pending` 30 min depois
   *    do disparo, com entregas já confirmadas por webhook). O polling não pode
   *    ser a fundação: a fundação dele não existe.
   *  - o WEBHOOK, sim, chega em TEMPO REAL e traz o wamid em
   *    `message.platformMessageId` — inclusive para mensagens de BROADCAST.
   *
   * Como o `/send` do broadcast não devolve wamid nenhum, a Message nasce sem
   * `providerMessageId` e o casamento por wamid acha NADA. O telefone é o único
   * elo — e é por ele que o `WebhooksService` acha a linha e CARIMBA o wamid.
   */
  parseWebhook(payload: unknown): NormalizedEvent[] {
    const p = (payload ?? {}) as ZernioWebhookEnvelope;
    const status = p.event ? STATUS_MAP[p.event] : undefined;
    if (!status) return [];
    const providerMessageId = eventMessageId(p.message);
    if (!providerMessageId) return [];
    const err = p.error ?? undefined;
    // O telefone do destinatário. `participantId` vem SEM o '+' (ex.:
    // "5592986550101"); `Contact.phoneE164` é guardado COM. Normaliza — e nunca
    // inventa: sem participantId, o campo fica `undefined` e o fallback por
    // telefone simplesmente não roda.
    const digits = digitsOnly(String(p.conversation?.participantId ?? ''));
    return [
      {
        providerMessageId,
        status,
        errorCode: err?.code != null ? String(err.code) : undefined,
        errorMessage: err?.message ?? err?.title ?? undefined,
        recipientPhone: digits ? `+${digits}` : undefined,
        // `statusAt` é a hora REAL da transição (o `timestamp` é a hora em que o
        // Zernio nos entregou o evento). É ele que dá a ORDEM verdadeira quando
        // `sent` e `delivered` chegam quase juntos.
        occurredAt: p.statusAt
          ? new Date(p.statusAt)
          : p.timestamp
            ? new Date(p.timestamp)
            : new Date(),
      },
    ];
  }

  parseInboundMessages(payload: unknown): InboundMessageEvent[] {
    const p = (payload ?? {}) as ZernioWebhookEnvelope;
    if (p.event !== 'message.received') return [];
    const providerMessageId = eventMessageId(p.message);
    const phone = p.conversation?.participantId ?? p.message?.senderId;
    if (!providerMessageId || !phone) return [];
    const digits = digitsOnly(String(phone));
    if (!digits) return [];
    const label = p.message?.message ?? p.message?.text;
    const buttonPayload = buttonPayloadOf(p.metadata, label);
    return [
      {
        fromE164: `+${digits}`,
        // The docs never state where (or whether) the tapped button's LABEL is
        // delivered for WhatsApp, so on a button tap `text` may well be empty.
        // Fall back to the payload so the REVOKE keeps a textual evidence trail.
        text: label ?? buttonPayload,
        receivedAt: p.timestamp ? new Date(p.timestamp) : new Date(),
        providerMessageId,
        buttonPayload,
      },
    ];
  }

  parseInboundChatMessages(payload: unknown): InboundChatMessage[] {
    const p = (payload ?? {}) as ZernioWebhookEnvelope;
    if (p.event !== 'message.received') return [];
    const providerMessageId = eventMessageId(p.message);
    const phone = p.conversation?.participantId ?? p.message?.senderId;
    if (!providerMessageId || !phone) return [];
    const digits = digitsOnly(String(phone));
    if (!digits) return [];

    const attachments = Array.isArray(p.message?.attachments)
      ? p.message.attachments
      : [];
    const first = attachments[0];
    const kind: InboundChatMessage['kind'] = first
      ? (ATTACHMENT_KIND[(first.type ?? '').toLowerCase()] ?? 'UNSUPPORTED')
      : 'TEXT';
    const label = p.message?.message ?? p.message?.text;
    const buttonPayload = buttonPayloadOf(p.metadata, label);
    // A button tap may arrive with no text at all (undocumented for WhatsApp) —
    // show the payload so the chat isn't a blank bubble and the REVOKE has
    // evidence.
    const text = label && label.length > 0 ? label : buttonPayload;

    return [
      {
        providerMessageId,
        remoteJid: `${digits}@s.whatsapp.net`,
        phoneE164: `+${digits}`,
        isGroup: false,
        fromMe: false,
        pushName:
          p.conversation?.participantName ?? p.message?.senderName ?? undefined,
        kind,
        text: text && text.length > 0 ? text : undefined,
        buttonPayload,
        media: first
          ? { fileName: first.filename }
          : undefined,
        receivedAt: p.timestamp ? new Date(p.timestamp) : new Date(),
      },
    ];
  }

  /**
   * Validate Zernio's `X-Zernio-Signature`: HMAC-SHA256 of the RAW request body
   * with `ZERNIO_WEBHOOK_SECRET`, lowercase hex, no `sha256=` prefix. Compared
   * constant-time. Fails closed (returns false) when the signature or the secret
   * is absent, so an unconfigured secret rejects rather than trusts.
   */
  verifyZernioSignature(rawBody: Buffer, signature?: string): boolean {
    if (!signature || !this.webhookSecret) return false;
    const expected = createHmac('sha256', this.webhookSecret)
      .update(rawBody)
      .digest('hex');
    const a = Buffer.from(expected);
    const b = Buffer.from(signature);
    // timingSafeEqual throws on length mismatch — guard first (a wrong-length
    // signature is simply invalid).
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  // fetchMessageStatus is intentionally NOT implemented — Zernio does not
  // document a per-message status GET, so `supportsStatusPollingFor` resolves
  // to false for this provider (reconciliation relies on webhooks).
}

/** ZC — o evento `whatsapp.template.status_updated`, normalizado. */
export type ZernioTemplateStatusEvent = {
  /** O `message_template_id` da Meta — a chave mais confiável de casamento. */
  zernioTemplateId?: string;
  metaName: string;
  language: string;
  /** Status CRU da Meta: pode ser DISABLED, IN_APPEAL, PENDING_DELETION… */
  status?: string;
  /** Motivo da Meta. Vem 'NONE' quando não há — quem grava filtra. */
  reason?: string;
};

/**
 * ZC — o webhook de aprovação de template.
 *
 * O orgamind **já estava inscrito** neste evento no painel do Zernio, mas o
 * `parseWebhook` o descartava (o STATUS_MAP só cobre `message.*`) — ou seja, o
 * sinal chegava e ia para o lixo. É ele que permite atualizar o status NA HORA e
 * manter a reconciliação como uma rede de segurança espaçada (1h), em vez de
 * polling: o balde do Zernio é de 60 req/min POR CHAVE e é o MESMO do envio.
 *
 * A Meta **não manda a category nem o status anterior** aqui — por isso o
 * casamento é por templateId (ou canal+nome+idioma) e só o status é tocado.
 *
 * Devolve `null` para qualquer outro evento, ou quando falta o nome (sem nome
 * não há como casar a row).
 */
export function parseZernioTemplateStatusEvent(
  payload: unknown,
): ZernioTemplateStatusEvent | null {
  const p = (payload ?? {}) as {
    event?: unknown;
    template?: Record<string, unknown>;
  };
  if (p.event !== 'whatsapp.template.status_updated') return null;

  const t = p.template;
  if (typeof t !== 'object' || t === null) return null;

  const metaName = typeof t.name === 'string' ? t.name.trim() : '';
  if (!metaName) return null;

  const templateId = t.templateId ?? t.id;

  return {
    zernioTemplateId:
      templateId != null && String(templateId).length > 0
        ? String(templateId)
        : undefined,
    metaName,
    // O idioma faz parte da chave única: um `boas_vindas` pt_BR e um en_US são
    // templates DIFERENTES. pt_BR é o default do projeto.
    language: typeof t.language === 'string' && t.language ? t.language : 'pt_BR',
    status: typeof t.status === 'string' ? t.status : undefined,
    reason: typeof t.reason === 'string' ? t.reason : undefined,
  };
}
