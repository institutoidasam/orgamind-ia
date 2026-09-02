import type {
  SendTemplateInput,
  SendResult,
  NormalizedEvent,
} from '../../../schemas/contracts/whatsapp.schema';
import type { ProviderProfile } from './provider-profile';

/**
 * Per-instance Baileys flags exposed by Evolution's `/settings/{find,set}`
 * endpoints. Only Evolution implements these — Meta Cloud has no equivalent.
 */
export type EvolutionSettings = {
  rejectCall: boolean;
  msgCall: string;
  groupsIgnore: boolean;
  alwaysOnline: boolean;
  readMessages: boolean;
  readStatus: boolean;
  syncFullHistory: boolean;
};

/**
 * Evolution v2 returns label `color` as a string-encoded numeric code
 * (e.g. "0", "1") in some installs and a number in others. The downstream
 * UI only renders it for display, so we tolerate both.
 */
export type WhatsappLabel = {
  id: string;
  name: string;
  color: string | number;
};

export type InboundMessageEvent = {
  fromE164: string;
  text?: string;
  receivedAt: Date;
  providerMessageId: string;
  /**
   * Interactive-button reply id (Twilio `ButtonPayload`, e.g. `optout`) — o
   * handler de STOP keywords usa para opt-out por botão.
   *
   * Twilio e Zernio preenchem; Evolution deixa unset. O valor é CANONICALIZADO
   * pelo adapter: qualquer sinal de opt-out vira o literal `optout` (é por ele
   * que `webhooks.service` casa). Na Zernio isso é obrigatório porque o botão de
   * opt-out NATIVO de MARKETING da Meta manda o rótulo localizado
   * ("Parar promoções"), não um id que a gente escolheu.
   */
  buttonPayload?: string;
};

export type InboundChatMedia = {
  mimeType?: string;
  fileName?: string;
  sizeBytes?: number;
  durationSec?: number;
  width?: number;
  height?: number;
  /**
   * Provider-hosted media URL (Twilio `MediaUrl0`). Requires provider
   * credentials (Basic Auth) to download — NEVER expose to the frontend;
   * the chat-media download pipeline fetches and re-hosts it. Evolution
   * media is fetched by message key instead, so it leaves this unset.
   */
  url?: string;
};

export type InboundChatMessage = {
  providerMessageId: string;
  remoteJid: string;
  /** Real phone (+E164) for @s.whatsapp.net; null for an unresolved @lid. */
  phoneE164: string | null;
  /** The alternate JID from the key (remoteJidAlt) — the real phone JID when the primary is a @lid. */
  altJid?: string | null;
  isGroup: boolean;
  fromMe: boolean;
  pushName?: string;
  kind:
    | 'TEXT'
    | 'IMAGE'
    | 'VIDEO'
    | 'AUDIO'
    | 'DOCUMENT'
    | 'STICKER'
    | 'LOCATION'
    | 'CONTACT'
    | 'UNSUPPORTED';
  text?: string;
  /**
   * Interactive-button reply id (Twilio `ButtonPayload` — the stable `id`
   * defined on the template's actions, e.g. `optout`). The button's visible
   * label rides in `text` (on Zernio the label is undocumented, so `text` may
   * fall back to the payload itself). Twilio and Zernio populate it; Evolution
   * leaves it unset. Opt-out signals are canonicalized to `optout` by the
   * adapter.
   */
  buttonPayload?: string;
  /**
   * C3 / spec §3.4 — referral de um **Click-to-WhatsApp Ad** (CTWA). Presente só
   * quando o titular chegou por um anúncio do Facebook/Instagram; é ele que
   * destrava o **Free Entry Point** (72h em que qualquer mensagem é grátis) e é
   * a evidência mais forte que existe de proveniência: o `ctwaClid` é verificável
   * na Meta/Twilio, ao contrário de qualquer linha que o orgamind escreva sobre si
   * mesmo.
   *
   * Atenção ao que ele NÃO é: o clique no anúncio consente *aquela conversa*,
   * não marketing contínuo. O consentimento continua vindo do ato afirmativo (o
   * texto que casa com a declaração) — o referral só ATRIBUI esse ato ao anúncio.
   *
   * Só Twilio popula hoje (`ReferralCtwaClid` e amigos); Evolution/Zernio não.
   */
  referral?: InboundReferral;
  /** Speech-to-text transcript for voice notes (Evolution speechToText). */
  transcript?: string | null;
  media?: InboundChatMedia;
  quotedWaMessageId?: string;
  quotedPreview?: string;
  receivedAt: Date;
};

/** Referral de anúncio Click-to-WhatsApp (spec §3.4). */
export type InboundReferral = {
  /** Click id do anúncio — a chave verificável na Meta/Twilio. */
  ctwaClid: string;
  headline?: string;
  body?: string;
  sourceId?: string;
  sourceUrl?: string;
};

/**
 * Relógio injetável para os caminhos que precisam de RITMO (hoje só o
 * `/chat/check` do GoZap). Existe para que o teste prove o intervalo entre
 * chamadas sem esperar de verdade — um teste que dorme 1,5s por número seria
 * abandonado no primeiro CI lento, e o ritmo é justamente o que protege o
 * canal de um bloqueio.
 */
export type CheckClock = {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
};

export type ConnectionState = 'open' | 'connecting' | 'close';

export type InstanceConnectionInfo = {
  state: ConnectionState;
  qrBase64?: string; // PNG data URI for rendering in <img src=...>
  pairingCode?: string;
  /**
   * If the underlying provider has a record of the last disconnection,
   * surface its reason code (e.g. Baileys statusReason 401, 408, 440).
   * The UI can use this to explain WHY the session is unstable rather
   * than showing only a generic "connecting" state.
   */
  disconnectionReasonCode?: number | null;
  disconnectionAt?: string | null;
  /** Profile fields — populated by Evolution adapter when state=open. */
  ownerJid?: string | null;
  profileName?: string | null;
  profilePictureUrl?: string | null;
};

export interface MessageProvider {
  readonly name: 'meta' | 'evolution' | 'twilio' | 'zernio' | 'gozap';
  /**
   * Perfil DECLARADO do provider (traits + capacidades). Declarado, não sondado:
   * adapters com stubs-que-lançam (Twilio chat/media) tornariam `typeof fn`
   * mentiroso. É a fonte que o endpoint /whatsapp/providers expõe à UI.
   */
  readonly profile: ProviderProfile;
  sendTemplate(
    input: SendTemplateInput & { evolutionInstanceName?: string },
  ): Promise<SendResult>;
  parseWebhook(payload: unknown): NormalizedEvent[];
  parseInboundMessages?(payload: unknown): InboundMessageEvent[];
  parseInboundChatMessages?(payload: unknown): InboundChatMessage[];
  /**
   * Fetch a message's CURRENT delivery status from the provider's REST API by
   * its provider message id. Optional — only Cloud providers (Twilio) that
   * accept-then-deliver asynchronously expose this. Used by the status
   * reconciler to resolve rows stuck in SENT when a status callback never
   * arrived (webhook off/lagging). Returns the normalized status (undefined for
   * pre-delivery states like queued/sent) plus the raw status + error code.
   */
  fetchMessageStatus?(providerMessageId: string): Promise<{
    status?: NormalizedEvent['status'];
    rawStatus: string;
    errorCode?: string;
  }>;
  /**
   * Returns connection info (state + optional QR for Web-emulated providers).
   * Meta-style providers return state but never a QR.
   * Optional `instanceName` overrides the adapter's singleton instance — used
   * by the multi-instance router; omit to fall back to the default.
   */
  getConnectionInfo?(instanceName?: string): Promise<InstanceConnectionInfo>;
  /**
   * Bulk-check whether a list of E.164 phone numbers exist on WhatsApp.
   * Optional — only session/Web-emulated providers expose this (Evolution via
   * `/chat/whatsappNumbers`, GoZap via `/chat/check`, um número por vez).
   * Returns one entry per input number; `number` volta SEM o "+", na mesma
   * grafia recebida — é a chave com que o chamador casa o resultado de volta
   * no contato.
   * `instanceName` mira uma instância específica (Evolution). `opts` carrega o
   * que é POR PROVEDOR: o token da instância GoZap (que não é um nome) e o
   * relógio dos testes. Um adapter que ignore `opts` continua compatível.
   *
   * `exists` é TRI-STATE (fix round 2, design ruling — revisão da Task 11):
   *   - `true` / `false`: confirmado (existe / não existe no WhatsApp).
   *     `jid: null` sempre que `false`.
   *   - `null`: NÃO confirmado (ex.: GoZap devolveu `IsIn:true` mas de OUTRO
   *     assinante — `reason: 'gozap.check_mismatch'`). Existe justamente para
   *     que `null` NUNCA vire `false` na mão de um consumidor: o único
   *     consumidor real hoje (`contact-sync.processor.ts`) grava
   *     `whatsappValid:false` de forma DURÁVEL a partir de `exists:false` — um
   *     "incerto" reportado como `false` viraria uma mentira permanente no
   *     contato. Um adapter que só sabe confirmar/negar (Evolution) nunca
   *     devolve `null`.
   */
  checkNumbersOnWhatsapp?(
    phonesE164: string[],
    instanceName?: string,
    opts?: { gozapInstanceToken?: string; clock?: CheckClock },
  ): Promise<
    Array<{
      exists: boolean | null;
      jid: string | null;
      number: string;
      reason?: string;
    }>
  >;
  /**
   * Fetch the WhatsApp profile picture URL for a contact (by JID). Returns
   * null if the user has no picture or has restricted profile access.
   * Optional — Meta Cloud API does not expose profile pictures of recipients.
   * Optional `instanceName` targets a specific instance; omit for default.
   */
  fetchProfilePictureUrl?(
    jid: string,
    instanceName?: string,
  ): Promise<string | null>;
  /**
   * Persist per-instance settings (partial update). Caller passes only the
   * keys they want to change; the provider merges with current state.
   * Optional `instanceName` targets a specific instance; omit for default.
   */
  setSettings?(
    settings: Partial<EvolutionSettings>,
    instanceName?: string,
  ): Promise<void>;
  /**
   * List the WhatsApp Business labels the user has created on their device.
   * Returns empty list when the provider doesn't support labels (Meta Cloud).
   * Optional `instanceName` targets a specific instance; omit for default.
   */
  fetchLabels?(instanceName?: string): Promise<WhatsappLabel[]>;
  /**
   * Add or remove a single label on a chat. Optional — only Evolution
   * supports labels (they are a WA Business client feature, not a Cloud
   * API concept).
   * Pass `instanceName` inside args to target a specific instance; omit for default.
   */
  handleContactLabel?(args: {
    jid: string;
    labelId: string;
    action: 'add' | 'remove';
    instanceName?: string;
  }): Promise<void>;
  /**
   * Envia texto livre (mensagem de sessão) — a resposta manual do inbox.
   * Implementado por EVOLUTION, TWILIO e ZERNIO. Nos dois últimos o envio só é
   * legal DENTRO da janela de 24h da Meta; o guard vive no ChatService
   * (`assertSessionWindowOpen`), não aqui. A citação (`quotedWaMessageId`) só é
   * honrada pelo Evolution — Twilio e Zernio não têm campo de reply no wire.
   */
  sendChatText?(args: SendChatTextArgs): Promise<SendResult>;
  /** Mark one or more messages as read. Evolution only. */
  markMessageAsRead?(instanceName: string, keys: ReadKey[]): Promise<void>;
  /** Send a presence update (typing / recording / paused). Evolution only. */
  sendPresence?(
    instanceName: string,
    toE164: string,
    presence: 'composing' | 'recording' | 'paused',
    delay?: number,
  ): Promise<void>;
  /** Download media as base64 from a message key. Evolution only. */
  getMediaBase64?(
    instanceName: string,
    key: { id: string; remoteJid: string; fromMe: boolean },
  ): Promise<MediaDownload>;
  /** Send an image/video/document as base64. Evolution only. */
  sendMedia?(args: SendMediaArgs): Promise<SendResult>;
  /** Send a voice/audio message as base64. Evolution only. */
  sendWhatsAppAudio?(args: SendAudioArgs): Promise<SendResult>;
  /** List all known chats for the instance. Evolution only. */
  findChats?(instanceName: string): Promise<EvolutionChat[]>;
  /** Paginate messages for a specific chat JID. Evolution only. */
  findMessages?(
    instanceName: string,
    remoteJid: string,
    page: number,
    pageSize?: number,
  ): Promise<EvolutionMessagesPage>;
  /**
   * Validate Twilio's `X-Twilio-Signature` for an inbound webhook. Twilio
   * provider only — other providers don't implement it (callers treat a missing
   * implementation as "reject").
   */
  verifyTwilioSignature?(
    url: string,
    params: Record<string, unknown>,
    signature: string | undefined,
  ): boolean;
  /**
   * Validate Zernio's `X-Zernio-Signature` (HMAC-SHA256 of the raw body, lower
   * hex, no prefix) for an inbound webhook. Zernio provider only — a missing
   * implementation is treated as "reject".
   */
  verifyZernioSignature?(
    rawBody: Buffer,
    signature: string | undefined,
  ): boolean;
}

export type ReadKey = { remoteJid: string; fromMe: boolean; id: string };

export type SendChatTextArgs = {
  /** Evolution instance name; cloud adapters (Twilio) ignore it — pass ''. */
  instanceName: string;
  toE164: string;
  text: string;
  quotedWaMessageId?: string | null;
  quotedPreview?: string | null;
  delay?: number;
  /**
   * R1 multi-número (Twilio): remetente do CANAL — vence o From/MSS do env.
   * Injetado por WhatsappProvidersService.sendChatTextVia; Evolution ignora.
   */
  senderPhoneE164?: string;
  twilioMessagingServiceSid?: string;
  /**
   * Conta (número WhatsApp) do canal ZERNIO. Injetado por
   * WhatsappProvidersService.sendChatTextVia a partir do canal, exatamente como
   * o remetente da Twilio; sem ele o Zernio rejeita com "accountId is required".
   * Ignorado pelos demais adapters.
   */
  zernioAccountId?: string;
  /**
   * Token da INSTÂNCIA GoZap (o token da sessão pareada, nunca o admin token de
   * gerência). Mesma injeção do `zernioAccountId`: quem preenche é
   * `WhatsappProvidersService.sendChatTextVia`, decifrando
   * `Channel.gozapInstanceToken` na hora da chamada — o valor em claro existe só
   * em memória, nunca é logado nem devolvido. Sem ele o GoZap rejeita o envio.
   * Ignorado pelos demais adapters.
   */
  gozapInstanceToken?: string;
};

export type MediaDownload = {
  base64: string;
  mimeType: string;
  fileName?: string;
};
export type SendMediaArgs = {
  instanceName: string;
  toE164: string;
  mediatype: 'image' | 'video' | 'document';
  mimetype: string;
  mediaBase64: string;
  fileName?: string;
  caption?: string;
  quotedWaMessageId?: string | null;
  quotedPreview?: string | null;
  delay?: number;
};
export type SendAudioArgs = {
  instanceName: string;
  toE164: string;
  audioBase64: string;
  quotedWaMessageId?: string | null;
  quotedPreview?: string | null;
  delay?: number;
};

export type EvolutionChat = {
  remoteJid: string;
  name: string | null;
  profilePicUrl: string | null;
  unreadCount: number;
  altJid: string | null;
};
export type EvolutionMessagesPage = {
  records: unknown[];
  total: number;
  pages: number;
  currentPage: number;
};

export const MESSAGE_PROVIDER = Symbol('MESSAGE_PROVIDER');
