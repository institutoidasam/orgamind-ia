import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../shared/config/env.schema';
import { decryptToken } from '../../shared/crypto/gozap-token-cipher';
import {
  MESSAGE_PROVIDER,
  type MessageProvider,
  type InboundMessageEvent,
  type InboundChatMessage,
  type EvolutionSettings,
  type WhatsappLabel,
  type SendChatTextArgs,
  type ReadKey,
  type MediaDownload,
  type SendMediaArgs,
  type SendAudioArgs,
  type EvolutionChat,
  type EvolutionMessagesPage,
  type CheckClock,
} from './ports/message-provider.port';
import type {
  SendTemplateInput,
  SendResult,
  NormalizedEvent,
} from '../../schemas/contracts/whatsapp.schema';
import type { Channel, ChannelProvider } from '@prisma/client';
import { NotImplementedError } from '../../shared/errors/domain.error';
import { WhatsappProvidersRepository } from './whatsapp-providers.repository';
import { WhatsappInstancesRepository } from '../whatsapp-instances/whatsapp-instances.repository';
import {
  ProviderRegistry,
  ProviderNotConfiguredError,
} from './provider-registry.service';
import type { ProviderProfile } from './ports/provider-profile';

@Injectable()
export class WhatsappProvidersService {
  private readonly logger = new Logger(WhatsappProvidersService.name);

  constructor(
    @Inject(MESSAGE_PROVIDER) private readonly provider: MessageProvider,
    private readonly connectionRepo: WhatsappProvidersRepository,
    private readonly instancesRepo: WhatsappInstancesRepository,
    // The multi-provider registry. Optional at the parameter list's tail so
    // legacy unit tests that construct the service positionally keep compiling;
    // Nest always injects it. Registry-backed methods require it.
    private readonly registry: ProviderRegistry,
    // F-A Task 7: só para decifrar Channel.gozapInstanceToken on-demand in
    // sendVia — o valor cru nunca é persistido nem devolvido, só passado ao
    // adapter para a chamada HTTP de envio.
    private readonly config: ConfigService<Env>,
  ) {}

  // ── Channel-aware API (multi-provider) ────────────────────────────────────
  // These resolve the adapter that matches a channel/provider from the registry.

  /**
   * Send a template through the adapter that matches the channel's provider.
   *
   * R1 — multi-number: the send now carries the CHANNEL's own sender
   * (`phoneE164` / `twilioMessagingServiceSid`) so a second Twilio channel with
   * a different number actually sends FROM that number instead of the env
   * default. The Twilio adapter applies these with an env fallback; the Meta and
   * Evolution adapters ignore them (they resolve their sender from their own
   * env/instance). An explicit value already on `input` wins over the channel's.
   */
  sendVia(
    channel: Pick<
      Channel,
      | 'provider'
      | 'phoneE164'
      | 'twilioMessagingServiceSid'
      | 'zernioAccountId'
      | 'gozapInstanceToken'
    >,
    input: SendTemplateInput & { evolutionInstanceName?: string },
  ): Promise<SendResult> {
    return this.registry.forChannel(channel).sendTemplate({
      ...input,
      // null (channel has no value) → undefined so the adapter's env fallback
      // kicks in rather than seeing a literal null.
      senderPhoneE164: input.senderPhoneE164 ?? channel.phoneE164 ?? undefined,
      twilioMessagingServiceSid:
        input.twilioMessagingServiceSid ??
        channel.twilioMessagingServiceSid ??
        undefined,
      // The Zernio adapter sends via the account behind the channel — without
      // this the send fails with zernio.account_missing even though the channel
      // has an accountId.
      zernioAccountId:
        input.zernioAccountId ?? channel.zernioAccountId ?? undefined,
      // GoZap: the plaintext instance token exists ONLY here, in memory, for
      // the duration of this call — it is decrypted from the DB ciphertext
      // and handed straight to the adapter, never logged, never returned.
      gozapInstanceToken:
        input.gozapInstanceToken ??
        this.decryptGozapToken(channel.gozapInstanceToken),
    });
  }

  /** Decrypts Channel.gozapInstanceToken on-demand; undefined when absent or the encryption key isn't configured. */
  private decryptGozapToken(
    ciphertext: string | null | undefined,
  ): string | undefined {
    if (!ciphertext) return undefined;
    const key = this.config?.get('GOZAP_TOKEN_ENCRYPTION_KEY', { infer: true });
    if (!key) return undefined;
    return decryptToken(ciphertext, key);
  }

  /** Parse a provider webhook into normalized ack events. */
  parseWebhookFor(
    provider: ChannelProvider,
    payload: unknown,
  ): NormalizedEvent[] {
    return this.registry.forProvider(provider)?.parseWebhook(payload) ?? [];
  }

  /** Parse inbound chat messages for a specific provider. */
  parseInboundChatMessagesFor(
    provider: ChannelProvider,
    payload: unknown,
  ): InboundChatMessage[] {
    return (
      this.registry
        .forProvider(provider)
        ?.parseInboundChatMessages?.(payload) ?? []
    );
  }

  /**
   * Parse inbound messages (STOP-keyword opt-out use) for a specific provider.
   * Mirrors {@link parseInboundChatMessagesFor}: resolves the adapter that
   * matches `provider` from the registry; an adapter without the optional
   * `parseInboundMessages` method (or an unconfigured provider) returns [].
   */
  parseInboundMessagesFor(
    provider: ChannelProvider,
    payload: unknown,
  ): InboundMessageEvent[] {
    return (
      this.registry.forProvider(provider)?.parseInboundMessages?.(payload) ?? []
    );
  }

  /** Whether a provider can poll a message's delivery status by SID. */
  supportsStatusPollingFor(provider: ChannelProvider): boolean {
    const adapter = this.registry.forProvider(provider);
    return adapter != null && adapter.profile.capabilities.has('statusPolling');
  }

  /**
   * Whether a provider can send the inbox's manual/bot free-form reply
   * (`sendChatText`). Espelha `supportsStatusPollingFor`: DECLARAÇÃO, não
   * sondagem — o contrato "capacidade declarada ⇒ método implementado" é
   * guardado por `provider-capability-contract.spec.ts`.
   *
   * Existe como método próprio (em vez de `profileFor(p)?.capabilities.has(…)`
   * no chamador) porque o `ChatService` decide com ele se RECUSA a resposta: um
   * predicado que devolve `boolean` de verdade falha FECHADO quando o provider
   * não está configurado, enquanto encadear optional chaining num mock/perfil
   * ausente é exatamente como se abre um gate sem perceber.
   */
  supportsInboxChatFor(provider: ChannelProvider): boolean {
    const adapter = this.registry.forProvider(provider);
    return adapter != null && adapter.profile.capabilities.has('inboxChat');
  }

  /** Poll a provider for a message's current delivery status. */
  fetchMessageStatusFor(provider: ChannelProvider, providerMessageId: string) {
    return this.registry
      .forProvider(provider)
      ?.fetchMessageStatus?.(providerMessageId);
  }

  /** Whether a provider's credential group is configured on this deploy. */
  isProviderConfigured(provider: ChannelProvider): boolean {
    return this.registry.isConfigured(provider);
  }

  /** The providers configured on this deploy. */
  configuredProviders(): ChannelProvider[] {
    return this.registry.configured();
  }

  /** Profile declarado do adapter (traits + capacidades) — para a UI. */
  profileFor(provider: ChannelProvider): ProviderProfile | null {
    return this.registry.forProvider(provider)?.profile ?? null;
  }

  // ── Legacy single-provider API ─────────────────────────────────────────────
  // Delegates to the boot-selected MESSAGE_PROVIDER (see whatsapp-providers.
  // module.ts's `legacyProvider` factory — picks a default adapter from
  // whichever provider groups are configured, evolution > meta > twilio).
  // F6 removed the WHATSAPP_PROVIDER env selector along with `send()` and
  // `parseWebhook()` (both migrated to their channel-aware equivalents,
  // sendVia/parseWebhookFor). `parseInboundMessages`/`parseInboundChatMessages`
  // below still have real callers that don't resolve a specific channel/
  // provider (webhooks.service's STOP-keyword fallback, chat-ingest/
  // chat-history-sync) and stay until those migrate too.

  parseInboundMessages(payload: unknown): InboundMessageEvent[] {
    return this.provider.parseInboundMessages?.(payload) ?? [];
  }

  parseInboundChatMessages(payload: unknown): InboundChatMessage[] {
    return this.provider.parseInboundChatMessages?.(payload) ?? [];
  }

  // ── Evolution-only operations ─────────────────────────────────────────────
  // Chat / media / labels / settings / QR / restart / checkNumbers are all
  // Baileys-web features that only the Evolution adapter implements. They now
  // resolve the EVOLUTION adapter from the registry and throw a clear PT-BR
  // DomainError when the Evolution env group isn't configured on this deploy.

  /** Resolve the Evolution adapter or throw a PT-BR "not configured" error. */
  private evolution(): MessageProvider {
    const adapter = this.registry.forProvider('EVOLUTION');
    if (!adapter) {
      throw new ProviderNotConfiguredError('EVOLUTION');
    }
    return adapter;
  }

  async checkNumbersOnWhatsapp(
    phonesE164: string[],
    instanceName?: string,
  ): Promise<
    Array<{
      exists: boolean | null;
      jid: string | null;
      number: string;
      reason?: string;
    }>
  > {
    const provider = this.evolution();
    if (!provider.checkNumbersOnWhatsapp) {
      throw new NotImplementedError('checkNumbersOnWhatsapp');
    }
    return provider.checkNumbersOnWhatsapp(phonesE164, instanceName);
  }

  /**
   * ★ CAPACIDADE, NÃO PROVEDOR.
   *
   * O método acima resolve o adapter EVOLUTION e é o caminho legado. A partir
   * da Fase B, quem decide se dá para validar número é a PRESENÇA DO MÉTODO no
   * adapter do canal — hoje Evolution e GoZap.
   *
   * A sondagem por `typeof` é deliberada, e NÃO uma capacidade declarada
   * (`contactTools`): aquele contrato exige `checkNumbersOnWhatsapp` E
   * `fetchProfilePictureUrl` juntos, e o GoZap não tem o segundo — declará-la
   * seria mentir, que é justamente o que `provider-capability-contract.spec.ts`
   * existe para impedir.
   */
  supportsNumberCheckFor(provider: ChannelProvider): boolean {
    const adapter = this.registry.forProvider(provider);
    return typeof adapter?.checkNumbersOnWhatsapp === 'function';
  }

  /**
   * Valida números PELO CANAL, no molde de `sendVia`: o adapter sai do
   * registry pelo `provider` da linha, e o token da instância GoZap é
   * decifrado aqui, em memória, só pelo tempo da chamada — nunca logado, nunca
   * devolvido.
   */
  async checkNumbersOnWhatsappVia(
    channel: Pick<
      Channel,
      'provider' | 'evolutionInstanceName' | 'gozapInstanceToken'
    >,
    phonesE164: string[],
    opts?: { clock?: CheckClock },
  ): Promise<
    Array<{
      exists: boolean | null;
      jid: string | null;
      number: string;
      reason?: string;
    }>
  > {
    const adapter = this.registry.forChannel(channel);
    if (!adapter.checkNumbersOnWhatsapp) {
      throw new NotImplementedError('checkNumbersOnWhatsapp');
    }
    return adapter.checkNumbersOnWhatsapp(
      phonesE164,
      channel.evolutionInstanceName ?? undefined,
      {
        gozapInstanceToken: this.decryptGozapToken(channel.gozapInstanceToken),
        ...opts,
      },
    );
  }

  async fetchProfilePictureUrl(
    jid: string,
    instanceName?: string,
  ): Promise<string | null> {
    const provider = this.evolution();
    if (!provider.fetchProfilePictureUrl) {
      throw new NotImplementedError('fetchProfilePictureUrl');
    }
    return provider.fetchProfilePictureUrl(jid, instanceName);
  }

  async setSettings(
    settings: Partial<EvolutionSettings>,
    instanceName?: string,
  ): Promise<void> {
    const provider = this.evolution();
    if (!provider.setSettings) {
      throw new NotImplementedError('setSettings');
    }
    return provider.setSettings(settings, instanceName);
  }

  async fetchLabels(instanceName?: string): Promise<WhatsappLabel[]> {
    const provider = this.evolution();
    if (!provider.fetchLabels) {
      throw new NotImplementedError('fetchLabels');
    }
    return provider.fetchLabels(instanceName);
  }

  async handleContactLabel(args: {
    jid: string;
    labelId: string;
    action: 'add' | 'remove';
    instanceName?: string;
  }): Promise<void> {
    const provider = this.evolution();
    if (!provider.handleContactLabel) {
      throw new NotImplementedError('handleContactLabel');
    }
    // Default to the DB-default instance (isDefault=true) rather than the
    // provider's env-configured instance, so contact-label ops target the
    // number that is actually connected in a multi-instance setup.
    const instanceName =
      args.instanceName ??
      (await this.instancesRepo.findDefault())?.evolutionInstanceName ??
      undefined;
    return provider.handleContactLabel({ ...args, instanceName });
  }

  sendChatText(args: SendChatTextArgs): Promise<SendResult> {
    const provider = this.evolution();
    if (!provider.sendChatText)
      throw new Error('Active provider does not support manual chat replies');
    return provider.sendChatText(args);
  }

  /**
   * T6 (twilio-platform): free-form chat text routed by the CHANNEL's provider
   * (registry), mirroring {@link sendVia}. The channel's own sender
   * (phoneE164 / twilioMessagingServiceSid) is injected so a multi-number
   * deploy replies FROM the number the customer wrote to — an explicit value
   * already on `args` wins over the channel's. Adapters without chat support
   * (Meta) raise NotImplementedError.
   */
  async sendChatTextVia(
    channel: Pick<
      Channel,
      'provider' | 'phoneE164' | 'twilioMessagingServiceSid' | 'zernioAccountId'
    > &
      Partial<Pick<Channel, 'gozapInstanceToken'>>,
    args: SendChatTextArgs,
  ): Promise<SendResult> {
    const provider = this.registry.forChannel(channel);
    if (!provider.sendChatText) throw new NotImplementedError('sendChatText');
    return provider.sendChatText({
      ...args,
      senderPhoneE164: args.senderPhoneE164 ?? channel.phoneE164 ?? undefined,
      twilioMessagingServiceSid:
        args.twilioMessagingServiceSid ??
        channel.twilioMessagingServiceSid ??
        undefined,
      // O accountId do canal ZERNIO já vinha no Pick e era simplesmente
      // descartado aqui — sem ele, todo texto livre por Zernio morria em
      // "accountId is required".
      zernioAccountId:
        args.zernioAccountId ?? channel.zernioAccountId ?? undefined,
      // GOZAP: mesma regra do `sendVia` — o token EM CLARO existe só aqui, em
      // memória, pelo tempo da chamada. O que viaja pelo `channel` é o
      // ciphertext do banco; nunca logamos nem devolvemos o valor decifrado.
      // `Partial` no Pick porque a maioria dos chamadores (Twilio/Zernio) monta
      // o canal a partir de projeções que não carregam esta coluna.
      gozapInstanceToken:
        args.gozapInstanceToken ??
        this.decryptGozapToken(channel.gozapInstanceToken),
    });
  }

  markMessageAsRead(instanceName: string, keys: ReadKey[]): Promise<void> {
    const provider = this.evolution();
    return (
      provider.markMessageAsRead?.(instanceName, keys) ?? Promise.resolve()
    );
  }

  sendPresence(
    instanceName: string,
    toE164: string,
    presence: 'composing' | 'recording' | 'paused',
    delay?: number,
  ): Promise<void> {
    const provider = this.evolution();
    return (
      provider.sendPresence?.(instanceName, toE164, presence, delay) ??
      Promise.resolve()
    );
  }

  getMediaBase64(
    instanceName: string,
    key: { id: string; remoteJid: string; fromMe: boolean },
  ): Promise<MediaDownload> {
    const provider = this.evolution();
    if (!provider.getMediaBase64)
      throw new Error('Provider does not support media download');
    return provider.getMediaBase64(instanceName, key);
  }

  sendMedia(args: SendMediaArgs): Promise<SendResult> {
    const provider = this.evolution();
    if (!provider.sendMedia)
      throw new Error('Provider does not support sending media');
    return provider.sendMedia(args);
  }

  sendWhatsAppAudio(args: SendAudioArgs): Promise<SendResult> {
    const provider = this.evolution();
    if (!provider.sendWhatsAppAudio)
      throw new Error('Provider does not support sending audio');
    return provider.sendWhatsAppAudio(args);
  }

  findChats(instanceName: string): Promise<EvolutionChat[]> {
    const provider = this.evolution();
    if (!provider.findChats)
      throw new Error('Provider does not support findChats');
    return provider.findChats(instanceName);
  }

  findMessages(
    instanceName: string,
    remoteJid: string,
    page: number,
    pageSize?: number,
  ): Promise<EvolutionMessagesPage> {
    const provider = this.evolution();
    if (!provider.findMessages)
      throw new Error('Provider does not support findMessages');
    return provider.findMessages(instanceName, remoteJid, page, pageSize);
  }

  /**
   * Validate a Twilio webhook signature. Resolves the Twilio adapter from the
   * registry; a deploy without the Twilio env group has no adapter and rejects
   * (preserves the prior "missing implementation = reject" behaviour).
   */
  verifyTwilioSignature(
    url: string,
    params: Record<string, unknown>,
    signature: string | undefined,
  ): boolean {
    const twilio = this.registry.forProvider('TWILIO');
    return twilio?.verifyTwilioSignature?.(url, params, signature) ?? false;
  }

  /**
   * Validate a Zernio webhook signature. Resolves the Zernio adapter from the
   * registry; a deploy without the Zernio env group has no adapter and rejects
   * (same "missing implementation = reject" behaviour as Twilio).
   */
  verifyZernioSignature(
    rawBody: Buffer,
    signature: string | undefined,
  ): boolean {
    const zernio = this.registry.forProvider('ZERNIO');
    return zernio?.verifyZernioSignature?.(rawBody, signature) ?? false;
  }
}
