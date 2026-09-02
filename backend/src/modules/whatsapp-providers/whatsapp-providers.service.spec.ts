import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import { WhatsappProvidersService } from './whatsapp-providers.service';
import type { MessageProvider } from './ports/message-provider.port';
import { WhatsappProvidersRepository } from './whatsapp-providers.repository';
import { WhatsappInstancesRepository } from '../whatsapp-instances/whatsapp-instances.repository';
import { NotImplementedError } from '../../shared/errors/domain.error';
import { ProviderRegistry } from './provider-registry.service';
import { encryptToken } from '../../shared/crypto/gozap-token-cipher';

/**
 * A registry that resolves EVERY provider to the given adapter — so the
 * Evolution-only ops (which now resolve `forProvider('EVOLUTION')`) and the
 * Twilio signature check forward to the same mock the tests set up.
 */
function registryFor(adapter: MessageProvider): ProviderRegistry {
  return {
    forProvider: vi.fn().mockReturnValue(adapter),
    forChannel: vi.fn().mockReturnValue(adapter),
    isConfigured: vi.fn().mockReturnValue(true),
    configured: vi.fn().mockReturnValue([]),
  } as unknown as ProviderRegistry;
}

// F-A Task 7: sendVia decrypts Channel.gozapInstanceToken via ConfigService.
const GOZAP_TEST_KEY = 'a'.repeat(64); // 32 bytes em hex — mesma KEY do gozap-token-cipher.spec
function makeConfig(o: Record<string, string | undefined> = {}): ConfigService {
  const v: Record<string, string | undefined> = {
    GOZAP_TOKEN_ENCRYPTION_KEY: GOZAP_TEST_KEY,
    ...o,
  };
  return { get: (k: string) => v[k] } as unknown as ConfigService;
}

/**
 * The service is a thin pass-through over the active MessageProvider. The
 * value of these tests is twofold:
 *  1. Confirm we forward to the provider with the same arguments and surface
 *     the provider's return value verbatim.
 *  2. Confirm that for *optional* methods on the port, the service raises
 *     NotImplementedError when the active provider doesn't expose them
 *     (e.g. Meta Cloud has no /settings, /labels, etc).
 */
describe('WhatsappProvidersService', () => {
  type FullProvider = Required<MessageProvider>;
  let provider: FullProvider;
  let service: WhatsappProvidersService;

  beforeEach(() => {
    provider = {
      name: 'evolution',
      sendTemplate: vi.fn(),
      parseWebhook: vi.fn(),
      parseInboundMessages: vi.fn(),
      getConnectionInfo: vi.fn(),
      checkNumbersOnWhatsapp: vi.fn(),
      fetchProfilePictureUrl: vi.fn(),
      setSettings: vi.fn(),
      fetchLabels: vi.fn(),
      handleContactLabel: vi.fn(),
      sendChatText: vi.fn(),
    } as unknown as FullProvider;
    const noopRepo = {
      findLastEvent: vi.fn(),
      createEvent: vi.fn(),
      deleteOldEvents: vi.fn(),
    } as unknown as WhatsappProvidersRepository;
    const noopInstancesRepo = {
      findById: vi.fn().mockResolvedValue(null),
      findDefault: vi.fn().mockResolvedValue(null),
    } as unknown as WhatsappInstancesRepository;
    service = new WhatsappProvidersService(
      provider,
      noopRepo,
      noopInstancesRepo,
      registryFor(provider),
      makeConfig(),
    );
  });

  // ---------- pass-through behaviour ----------
  // F6 removed the legacy `providerName` getter, `send()`, and `parseWebhook()`
  // — callers now route explicitly via a channel/provider (sendVia,
  // parseWebhookFor). `parseInboundMessages`/`parseInboundChatMessages` still
  // delegate to the boot-selected MESSAGE_PROVIDER (see whatsapp-providers.
  // module.ts) for their remaining channel-agnostic callers.

  it('parseInboundMessages() forwards when provider implements it', () => {
    const inboundMock = provider.parseInboundMessages as unknown as ReturnType<typeof vi.fn>;
    inboundMock.mockReturnValueOnce([
      { providerMessageId: 'M', fromE164: '+1', text: 'hi', receivedAt: new Date(0) },
    ]);
    const events = service.parseInboundMessages({ event: 'messages.upsert' });
    expect(events).toHaveLength(1);
  });

  it('parseInboundMessages() returns [] when provider lacks the method', () => {
    delete (provider as Partial<FullProvider>).parseInboundMessages;
    expect(service.parseInboundMessages({})).toEqual([]);
  });

  // --- T5b: parseInboundMessagesFor — the registry-resolved counterpart of
  // parseInboundMessages, used by webhooks.service's STOP-keyword opt-out on a
  // multi-provider deploy. Mirrors parseInboundChatMessagesFor's pattern.
  it('parseInboundMessagesFor() forwards to the adapter resolved for the given provider', () => {
    const inboundMock = provider.parseInboundMessages as unknown as ReturnType<typeof vi.fn>;
    inboundMock.mockReturnValueOnce([
      { providerMessageId: 'M2', fromE164: '+1', text: 'stop', receivedAt: new Date(0) },
    ]);
    const events = service.parseInboundMessagesFor('TWILIO', { MessageSid: 'M2' });
    expect(events).toHaveLength(1);
    expect(inboundMock).toHaveBeenCalledWith({ MessageSid: 'M2' });
  });

  it('parseInboundMessagesFor() returns [] when the resolved adapter lacks parseInboundMessages', () => {
    delete (provider as Partial<FullProvider>).parseInboundMessages;
    expect(service.parseInboundMessagesFor('TWILIO', {})).toEqual([]);
  });

  it('parseInboundMessagesFor() returns [] when the provider is not configured on this deploy', () => {
    const registry = { forProvider: vi.fn().mockReturnValue(null) } as unknown as ProviderRegistry;
    const repo = {
      findLastEvent: vi.fn(),
      createEvent: vi.fn(),
      deleteOldEvents: vi.fn(),
    } as unknown as WhatsappProvidersRepository;
    const instancesRepo = {
      findById: vi.fn().mockResolvedValue(null),
      findDefault: vi.fn().mockResolvedValue(null),
    } as unknown as WhatsappInstancesRepository;
    const svc = new WhatsappProvidersService(
      provider,
      repo,
      instancesRepo,
      registry,
      makeConfig(),
    );
    expect(svc.parseInboundMessagesFor('TWILIO', {})).toEqual([]);
  });

  // --- T6 (twilio-platform): sendChatTextVia — chat livre roteado pelo canal
  // (registry.forChannel), com o remetente do CANAL vencendo o env (R1).
  it('sendChatTextVia() resolve o adapter do canal e injeta o remetente do canal', async () => {
    const sendMock = provider.sendChatText as unknown as ReturnType<typeof vi.fn>;
    sendMock.mockResolvedValueOnce({ providerMessageId: 'SM1', acceptedAt: new Date(0) });
    const channel = {
      provider: 'TWILIO',
      phoneE164: '+14155238886',
      twilioMessagingServiceSid: null,
      zernioAccountId: null,
    } as never;
    const r = await service.sendChatTextVia(channel, {
      instanceName: '', toE164: '+5592999', text: 'oi',
      quotedWaMessageId: null, quotedPreview: null,
    });
    expect(r.providerMessageId).toBe('SM1');
    expect(sendMock).toHaveBeenCalledWith(expect.objectContaining({
      toE164: '+5592999', text: 'oi', senderPhoneE164: '+14155238886',
    }));
  });

  it('sendChatTextVia() injeta o MessagingServiceSid do canal quando presente', async () => {
    const sendMock = provider.sendChatText as unknown as ReturnType<typeof vi.fn>;
    sendMock.mockResolvedValueOnce({ providerMessageId: 'SM2', acceptedAt: new Date(0) });
    const channel = {
      provider: 'TWILIO', phoneE164: null,
      twilioMessagingServiceSid: 'MG123', zernioAccountId: null,
    } as never;
    await service.sendChatTextVia(channel, { instanceName: '', toE164: '+5592999', text: 'oi' });
    expect(sendMock).toHaveBeenCalledWith(expect.objectContaining({ twilioMessagingServiceSid: 'MG123' }));
  });

  it('sendChatTextVia() lança NotImplementedError quando o adapter não suporta chat', async () => {
    delete (provider as Partial<FullProvider>).sendChatText;
    await expect(
      service.sendChatTextVia({ provider: 'META', phoneE164: null, twilioMessagingServiceSid: null, zernioAccountId: null } as never, {
        instanceName: '', toE164: '+1', text: 'x',
      }),
    ).rejects.toBeInstanceOf(NotImplementedError);
  });

  it('checkNumbersOnWhatsapp() forwards', async () => {
    const checkMock = provider.checkNumbersOnWhatsapp as unknown as ReturnType<typeof vi.fn>;
    checkMock.mockResolvedValueOnce([{ exists: true, jid: 'J', number: '5592987654321' }]);
    const r = await service.checkNumbersOnWhatsapp(['+5592987654321']);
    expect(r).toHaveLength(1);
    expect(checkMock).toHaveBeenCalledWith(['+5592987654321'], undefined);
  });

  it('fetchProfilePictureUrl() forwards', async () => {
    const picMock = provider.fetchProfilePictureUrl as unknown as ReturnType<typeof vi.fn>;
    picMock.mockResolvedValueOnce('https://x.example/p.jpg');
    const r = await service.fetchProfilePictureUrl('jid');
    expect(r).toBe('https://x.example/p.jpg');
  });

  it('setSettings() forwards', async () => {
    const setMock = provider.setSettings as unknown as ReturnType<typeof vi.fn>;
    setMock.mockResolvedValueOnce(undefined);
    await service.setSettings({ rejectCall: true });
    expect(setMock).toHaveBeenCalledWith({ rejectCall: true }, undefined);
  });

  it('fetchLabels() forwards', async () => {
    const labelsMock = provider.fetchLabels as unknown as ReturnType<typeof vi.fn>;
    labelsMock.mockResolvedValueOnce([{ id: 'l1', name: 'VIP', color: '0' }]);
    const r = await service.fetchLabels();
    expect(r).toHaveLength(1);
  });

  it('handleContactLabel() forwards args', async () => {
    const handleMock = provider.handleContactLabel as unknown as ReturnType<typeof vi.fn>;
    handleMock.mockResolvedValueOnce(undefined);
    await service.handleContactLabel({ jid: 'J', labelId: 'l1', action: 'add' });
    expect(handleMock).toHaveBeenCalledWith({ jid: 'J', labelId: 'l1', action: 'add' });
  });

  // ---------- NotImplementedError when method missing ----------

  it.each([
    ['checkNumbersOnWhatsapp', () => service.checkNumbersOnWhatsapp(['+1'])],
    ['fetchProfilePictureUrl', () => service.fetchProfilePictureUrl('jid')],
    ['setSettings', () => service.setSettings({})],
    ['fetchLabels', () => service.fetchLabels()],
    [
      'handleContactLabel',
      () => service.handleContactLabel({ jid: 'J', labelId: 'l', action: 'add' }),
    ],
  ] as const)(
    'throws NotImplementedError when provider lacks %s',
    async (methodName, invoke) => {
      delete (provider as Record<string, unknown>)[methodName];
      await expect(invoke()).rejects.toBeInstanceOf(NotImplementedError);
    },
  );
});

describe('WhatsappProvidersService — handleContactLabel & sendVia', () => {
  function makeProvider(overrides: Partial<Required<MessageProvider>> = {}): Required<MessageProvider> {
    return {
      name: 'evolution',
      sendTemplate: vi.fn(),
      parseWebhook: vi.fn(),
      parseInboundMessages: vi.fn(),
      getConnectionInfo: vi.fn().mockResolvedValue({ state: 'open' }),
      checkNumbersOnWhatsapp: vi.fn(),
      fetchProfilePictureUrl: vi.fn(),
      setSettings: vi.fn(),
      fetchLabels: vi.fn(),
      handleContactLabel: vi.fn(),
      ...overrides,
    } as unknown as Required<MessageProvider>;
  }

  function makeRepo(overrides: Partial<WhatsappProvidersRepository> = {}): WhatsappProvidersRepository {
    return {
      findLastEvent: vi.fn().mockResolvedValue(null),
      createEvent: vi.fn(),
      deleteOldEvents: vi.fn(),
      ...overrides,
    } as unknown as WhatsappProvidersRepository;
  }

  function makeInstancesRepo(
    overrides: Partial<WhatsappInstancesRepository> = {},
  ): WhatsappInstancesRepository {
    return {
      findById: vi.fn().mockResolvedValue(null),
      ...overrides,
    } as unknown as WhatsappInstancesRepository;
  }

  function makeService(
    provider: Required<MessageProvider>,
    repo: WhatsappProvidersRepository,
    instancesRepo: WhatsappInstancesRepository = makeInstancesRepo(),
    config: ConfigService = makeConfig(),
  ) {
    return new WhatsappProvidersService(
      provider as unknown as MessageProvider,
      repo,
      instancesRepo,
      registryFor(provider as unknown as MessageProvider),
      config,
    );
  }

  it('handleContactLabel() defaults to the DB-default instance when no instanceName given', async () => {
    const provider = makeProvider();
    const instancesRepo = makeInstancesRepo({
      findDefault: vi.fn().mockResolvedValue({ evolutionInstanceName: 'picoa-default-xyz' }),
    });
    const svc = makeService(provider, makeRepo(), instancesRepo);
    await svc.handleContactLabel({ jid: 'J', labelId: 'l1', action: 'add' });
    expect(provider.handleContactLabel).toHaveBeenCalledWith(
      expect.objectContaining({ jid: 'J', labelId: 'l1', action: 'add', instanceName: 'picoa-default-xyz' }),
    );
  });

  it('handleContactLabel() keeps an explicit instanceName and does not resolve the default', async () => {
    const provider = makeProvider();
    const findDefault = vi.fn();
    const svc = makeService(provider, makeRepo(), makeInstancesRepo({ findDefault }));
    await svc.handleContactLabel({ jid: 'J', labelId: 'l', action: 'add', instanceName: 'explicit-inst' });
    expect(provider.handleContactLabel).toHaveBeenCalledWith(
      expect.objectContaining({ instanceName: 'explicit-inst' }),
    );
    expect(findDefault).not.toHaveBeenCalled();
  });

  // ── R1: sendVia derives the Twilio sender from the CHANNEL ─────────────────
  describe('sendVia — per-channel Twilio sender', () => {
    const baseInput = {
      toE164: '+5511999999999',
      templateName: 'x',
      language: 'pt_BR',
      variables: {},
      body: 'hi',
    };

    it('forwards the channel phoneE164 as senderPhoneE164 to the adapter', async () => {
      const sendTemplate = vi
        .fn()
        .mockResolvedValue({ providerMessageId: 'SM', acceptedAt: new Date() });
      const svc = makeService(makeProvider({ sendTemplate }), makeRepo());
      await svc.sendVia(
        {
          provider: 'TWILIO',
          phoneE164: '+5592111111111',
          twilioMessagingServiceSid: null,
        } as never,
        baseInput as never,
      );
      expect(sendTemplate).toHaveBeenCalledWith(
        expect.objectContaining({
          senderPhoneE164: '+5592111111111',
          twilioMessagingServiceSid: undefined,
        }),
      );
    });

    it('forwards the channel twilioMessagingServiceSid to the adapter', async () => {
      const sendTemplate = vi
        .fn()
        .mockResolvedValue({ providerMessageId: 'SM', acceptedAt: new Date() });
      const svc = makeService(makeProvider({ sendTemplate }), makeRepo());
      await svc.sendVia(
        {
          provider: 'TWILIO',
          phoneE164: null,
          twilioMessagingServiceSid: 'MGabc0000000000000000000000000000',
        } as never,
        baseInput as never,
      );
      expect(sendTemplate).toHaveBeenCalledWith(
        expect.objectContaining({
          senderPhoneE164: undefined,
          twilioMessagingServiceSid: 'MGabc0000000000000000000000000000',
        }),
      );
    });

    it('forwards the channel zernioAccountId to the adapter (else zernio.account_missing)', async () => {
      const sendTemplate = vi
        .fn()
        .mockResolvedValue({ providerMessageId: 'ZM', acceptedAt: new Date() });
      const svc = makeService(makeProvider({ sendTemplate }), makeRepo());
      await svc.sendVia(
        {
          provider: 'ZERNIO',
          phoneE164: null,
          twilioMessagingServiceSid: null,
          zernioAccountId: 'acc-123',
        } as never,
        baseInput as never,
      );
      expect(sendTemplate).toHaveBeenCalledWith(
        expect.objectContaining({ zernioAccountId: 'acc-123' }),
      );
    });

    it('passes undefined sender fields when the channel carries neither', async () => {
      const sendTemplate = vi
        .fn()
        .mockResolvedValue({ providerMessageId: 'SM', acceptedAt: new Date() });
      const svc = makeService(makeProvider({ sendTemplate }), makeRepo());
      await svc.sendVia(
        {
          provider: 'TWILIO',
          phoneE164: null,
          twilioMessagingServiceSid: null,
        } as never,
        baseInput as never,
      );
      expect(sendTemplate).toHaveBeenCalledWith(
        expect.objectContaining({
          senderPhoneE164: undefined,
          twilioMessagingServiceSid: undefined,
        }),
      );
    });
  });

  // ── F-A Task 7: sendVia decrypts the channel's gozapInstanceToken ──────────
  describe('sendVia — GoZap instance token decryption', () => {
    const baseInput = {
      toE164: '+5511999999999',
      templateName: 'x',
      language: 'pt_BR',
      variables: {},
      body: 'hi',
    };

    it('decrypts channel.gozapInstanceToken and forwards the PLAINTEXT to the adapter', async () => {
      const sendTemplate = vi
        .fn()
        .mockResolvedValue({ providerMessageId: 'GM', acceptedAt: new Date() });
      const svc = makeService(makeProvider({ sendTemplate }), makeRepo());
      const ciphertext = encryptToken('inst_tok', GOZAP_TEST_KEY);

      await svc.sendVia(
        { provider: 'GOZAP', gozapInstanceToken: ciphertext } as never,
        baseInput as never,
      );

      expect(sendTemplate).toHaveBeenCalledWith(
        expect.objectContaining({ gozapInstanceToken: 'inst_tok' }),
      );
      // O ciphertext do banco nunca é o que chega ao adapter.
      expect(sendTemplate).not.toHaveBeenCalledWith(
        expect.objectContaining({ gozapInstanceToken: ciphertext }),
      );
    });

    it('forwards undefined when the channel carries no gozapInstanceToken', async () => {
      const sendTemplate = vi
        .fn()
        .mockResolvedValue({ providerMessageId: 'GM', acceptedAt: new Date() });
      const svc = makeService(makeProvider({ sendTemplate }), makeRepo());

      await svc.sendVia(
        { provider: 'GOZAP', gozapInstanceToken: null } as never,
        baseInput as never,
      );

      expect(sendTemplate).toHaveBeenCalledWith(
        expect.objectContaining({ gozapInstanceToken: undefined }),
      );
    });

    it('an explicit input.gozapInstanceToken wins over the channel-derived one', async () => {
      const sendTemplate = vi
        .fn()
        .mockResolvedValue({ providerMessageId: 'GM', acceptedAt: new Date() });
      const svc = makeService(makeProvider({ sendTemplate }), makeRepo());
      const ciphertext = encryptToken('inst_tok', GOZAP_TEST_KEY);

      await svc.sendVia(
        { provider: 'GOZAP', gozapInstanceToken: ciphertext } as never,
        { ...baseInput, gozapInstanceToken: 'explicit_tok' } as never,
      );

      expect(sendTemplate).toHaveBeenCalledWith(
        expect.objectContaining({ gozapInstanceToken: 'explicit_tok' }),
      );
    });
  });
});
