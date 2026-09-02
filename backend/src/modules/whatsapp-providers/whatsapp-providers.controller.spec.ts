import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockDeep, MockProxy } from 'vitest-mock-extended';
import { WhatsappProvidersController } from './whatsapp-providers.controller';
import type { WhatsappProvidersService } from './whatsapp-providers.service';
import { WhatsappInstancesRepository } from '../whatsapp-instances/whatsapp-instances.repository';
import { InstanceNotFoundError } from '../whatsapp-instances/errors/instance.errors';
import { AuditService } from '../../shared/audit/audit.service';
import { DomainError } from '../../shared/errors/domain.error';
import { ZernioAccountsService } from './zernio-accounts.service';
import { WebhookDropsService } from './webhook-drops.service';
import { ChannelHealthService } from './channel-health.service';
import { GozapInstancesService } from './gozap-instances.service';
import { WhatsappProvidersRepository } from './whatsapp-providers.repository';
import type { CreateChannelDto } from './dto/create-channel.dto';
import { PROVIDER_TRAITS } from '../../schemas/contracts/channel-provider.schema';
import { makeProfile } from './ports/provider-profile';

/**
 * The controller is a thin HTTP surface: each endpoint dispatches to one
 * service method. The point of these tests is to lock that mapping in place
 * — flipping any decorator to a different service method should fail here.
 */
describe('WhatsappProvidersController', () => {
  let svc: {
    [K in keyof WhatsappProvidersService]: ReturnType<typeof vi.fn>;
  };
  let instancesRepo: MockProxy<WhatsappInstancesRepository>;
  let audit: MockProxy<AuditService>;
  let zernioAccounts: MockProxy<ZernioAccountsService>;
  let drops: MockProxy<WebhookDropsService>;
  let health: MockProxy<ChannelHealthService>;
  let gozapInstances: MockProxy<GozapInstancesService>;
  let providersRepo: MockProxy<WhatsappProvidersRepository>;
  let controller: WhatsappProvidersController;

  beforeEach(() => {
    svc = {
      sendVia: vi.fn(),
      parseWebhookFor: vi.fn(),
      parseInboundChatMessagesFor: vi.fn(),
      parseInboundMessagesFor: vi.fn(),
      supportsStatusPollingFor: vi.fn(),
      fetchMessageStatusFor: vi.fn(),
      parseInboundMessages: vi.fn(),
      parseInboundChatMessages: vi.fn(),
      getConnectionInfo: vi.fn(),
      checkNumbersOnWhatsapp: vi.fn(),
      fetchProfilePictureUrl: vi.fn(),
      setSettings: vi.fn(),
      fetchLabels: vi.fn(),
      handleContactLabel: vi.fn(),
      sendChatText: vi.fn(),
      markMessageAsRead: vi.fn(),
      sendPresence: vi.fn(),
      getMediaBase64: vi.fn(),
      sendMedia: vi.fn(),
      sendWhatsAppAudio: vi.fn(),
      findChats: vi.fn(),
      findMessages: vi.fn(),
      verifyTwilioSignature: vi.fn(),
      isProviderConfigured: vi.fn().mockReturnValue(true),
      configuredProviders: vi.fn().mockReturnValue([]),
      profileFor: vi.fn().mockReturnValue(null),
    } as unknown as typeof svc;
    instancesRepo = mockDeep<WhatsappInstancesRepository>();
    instancesRepo.findById.mockResolvedValue(null);
    instancesRepo.findDefault.mockResolvedValue(null);
    instancesRepo.listAll.mockResolvedValue([]);
    instancesRepo.findActiveByProviderAndPhone.mockResolvedValue(null);
    instancesRepo.findActiveByZernioAccountId.mockResolvedValue(null);
    audit = mockDeep<AuditService>();
    zernioAccounts = mockDeep<ZernioAccountsService>();
    // Default: Zernio indisponível → caminho de DEGRADAÇÃO (cria mesmo assim,
    // sem verificação). É o default que não altera o comportamento esperado
    // pelos testes pré-existentes; os testes de validação sobrescrevem.
    zernioAccounts.lookup.mockResolvedValue({
      status: 'unavailable',
      reason: 'not stubbed',
    });
    zernioAccounts.listAccounts.mockResolvedValue([]);
    drops = mockDeep<WebhookDropsService>();
    drops.listUnresolved.mockResolvedValue([]);
    health = mockDeep<ChannelHealthService>();
    gozapInstances = mockDeep<GozapInstancesService>();
    providersRepo = mockDeep<WhatsappProvidersRepository>();
    // Default: nenhum canal tem evento de conexão — connectionState fica
    // null. Os testes de conexão sobrescrevem.
    providersRepo.lastStateByInstanceIds.mockResolvedValue(new Map());
    controller = new WhatsappProvidersController(
      svc as unknown as WhatsappProvidersService,
      instancesRepo,
      audit,
      zernioAccounts,
      drops,
      health,
      gozapInstances,
      providersRepo,
    );
  });

  // ZB — o endpoint que a página Canais consome antes de qualquer disparo.
  describe('GET /whatsapp/channels/health', () => {
    it('devolve a saúde dos canais como o serviço a compôs', async () => {
      const channels = [
        {
          channelId: 'ch_1',
          channelName: 'Canal do Matheus',
          provider: 'ZERNIO' as const,
          zernioAccountId: 'acc_1',
          tierLimit: 2000,
          uniqueRecipients24h: 1700,
          tierUsagePct: 85,
          nearTierLimit: true,
          qualityRating: 'GREEN',
          nameStatus: 'DECLINED',
          canSendMessage: 'LIMITED',
          stale: false,
          syncedAt: new Date(),
        },
      ];
      health.list.mockResolvedValue({ channels });

      await expect(controller.channelsHealth()).resolves.toEqual({ channels });
    });
  });

  it('GET /whatsapp/labels with no instanceId calls findDefault and fetchLabels with its evolutionInstanceName', async () => {
    instancesRepo.findDefault.mockResolvedValue({
      evolutionInstanceName: 'default-evo',
    } as never);
    svc.fetchLabels.mockResolvedValue([]);
    await controller.listLabels();
    expect(instancesRepo.findDefault).toHaveBeenCalledTimes(1);
    expect(svc.fetchLabels).toHaveBeenCalledWith('default-evo');
  });

  it('GET /whatsapp/labels with instanceId calls findById and fetchLabels with its evolutionInstanceName', async () => {
    instancesRepo.findById.mockResolvedValue({
      evolutionInstanceName: 'specific-evo',
    } as never);
    svc.fetchLabels.mockResolvedValue([]);
    await controller.listLabels('some-uuid');
    expect(instancesRepo.findById).toHaveBeenCalledWith('some-uuid');
    expect(svc.fetchLabels).toHaveBeenCalledWith('specific-evo');
  });

  it('GET /whatsapp/labels falls back to undefined when no instance record found', async () => {
    instancesRepo.findDefault.mockResolvedValue(null);
    svc.fetchLabels.mockResolvedValue([]);
    await controller.listLabels();
    expect(svc.fetchLabels).toHaveBeenCalledWith(undefined);
  });

  it('GET /whatsapp/labels with an unresolvable instanceId throws instead of falling back to the default number', async () => {
    instancesRepo.findById.mockResolvedValue(null);
    svc.fetchLabels.mockResolvedValue([]);
    await expect(controller.listLabels('stale-uuid')).rejects.toBeInstanceOf(
      InstanceNotFoundError,
    );
    expect(svc.fetchLabels).not.toHaveBeenCalled();
  });

  // T8: GET /whatsapp/providers — consumed by the frontend's useProviders()
  // (frontend/src/features/whatsapp/api.ts, providersResponseSchema). The
  // shape here MUST match exactly: { providers: [{ provider, channels }] }.
  describe('GET /whatsapp/providers', () => {
    // T15 — dailySendLimit/sentToday/sentTodayResetAt/warmupStartedAt são os
    // campos do `Channel` (Prisma) que o controller lê para calcular a quota
    // do resumo (warmupInfo). `warmupStartedAt: null` por padrão ⇒ sem rampa
    // ⇒ warmupEffectiveCap === dailySendLimit, warming: false, warmupDay: 0 —
    // o mesmo que `warmupInfo` devolve para qualquer canal fora de aquecimento.
    const channel = (over: Record<string, unknown>) => ({
      id: 'c1',
      name: 'Default',
      phoneE164: '+5592987654321',
      isActive: true,
      isDefault: true,
      apiKey: 'should-never-leak',
      evolutionInstanceName: 'evo-1',
      dailySendLimit: 500,
      sentToday: 0,
      sentTodayResetAt: new Date('2026-08-24T00:00:00.000Z'),
      warmupStartedAt: null,
      ...over,
    });

    it('only lists CONFIGURED providers (registry), each with its channels grouped', async () => {
      svc.configuredProviders.mockReturnValue(['EVOLUTION', 'TWILIO']);
      instancesRepo.listAll.mockResolvedValue([
        channel({ id: 'e1', provider: 'EVOLUTION' }),
        channel({ id: 't1', provider: 'TWILIO', isDefault: false }),
        // Not configured on this deploy — must be excluded entirely.
        channel({ id: 'm1', provider: 'META' }),
      ] as never);

      const result = await controller.providers();

      expect(result).toEqual({
        providers: [
          {
            provider: 'EVOLUTION',
            // profileFor não foi mockado com um profile real neste teste
            // (default: null) — cai no fallback: traits vêm de
            // PROVIDER_TRAITS e capabilities fica vazio.
            traits: PROVIDER_TRAITS.EVOLUTION,
            capabilities: [],
            channels: [
              {
                id: 'e1',
                name: 'Default',
                phoneE164: '+5592987654321',
                isActive: true,
                isDefault: true,
                provider: 'EVOLUTION',
                dailySendLimit: 500,
                sentToday: 0,
                sentTodayResetAt: '2026-08-24T00:00:00.000Z',
                warmupEffectiveCap: 500,
                warming: false,
                warmupDay: 0,
                connectionState: null,
              },
            ],
          },
          {
            provider: 'TWILIO',
            traits: PROVIDER_TRAITS.TWILIO,
            capabilities: [],
            channels: [
              {
                id: 't1',
                name: 'Default',
                phoneE164: '+5592987654321',
                isActive: true,
                isDefault: false,
                provider: 'TWILIO',
                dailySendLimit: 500,
                sentToday: 0,
                sentTodayResetAt: '2026-08-24T00:00:00.000Z',
                warmupEffectiveCap: 500,
                warming: false,
                warmupDay: 0,
                connectionState: null,
              },
            ],
          },
        ],
      });
    });

    // A tela Canais mostra "conectado/conectando/desconectado" por canal —
    // sem isto o operador não tinha NENHUM sinal do estado da conexão. Prova
    // que o controller repassa o Map de lastStateByInstanceIds para o campo
    // certo, por id, sem misturar canais.
    it('traz o connectionState mais recente de cada canal (lastStateByInstanceIds, por id)', async () => {
      svc.configuredProviders.mockReturnValue(['GOZAP']);
      instancesRepo.listAll.mockResolvedValue([
        channel({ id: 'g1', provider: 'GOZAP' }),
        channel({ id: 'g2', provider: 'GOZAP', isDefault: false }),
      ] as never);
      providersRepo.lastStateByInstanceIds.mockResolvedValue(
        new Map([
          ['g1', 'open'],
          ['g2', 'connecting'],
        ]),
      );

      const result = await controller.providers();

      expect(providersRepo.lastStateByInstanceIds).toHaveBeenCalledWith(['g1', 'g2']);
      const byId = new Map(result.providers[0].channels.map((c) => [c.id, c.connectionState]));
      expect(byId.get('g1')).toBe('open');
      expect(byId.get('g2')).toBe('connecting');
    });

    // Um canal sem evento nenhum (nunca conectou, ou não é sessionBased) não
    // pode virar "close" inventado — precisa ficar null, senão a tela mentiria
    // "desconectado" para um canal TWILIO que está perfeitamente ativo.
    it('connectionState fica null quando o canal não tem evento nenhum', async () => {
      svc.configuredProviders.mockReturnValue(['TWILIO']);
      instancesRepo.listAll.mockResolvedValue([
        channel({ id: 't1', provider: 'TWILIO' }),
      ] as never);
      providersRepo.lastStateByInstanceIds.mockResolvedValue(new Map());

      const result = await controller.providers();

      expect(result.providers[0].channels[0].connectionState).toBeNull();
    });

    // T15 — a causa raiz que esta task corrige: `GET /whatsapp/instances` só
    // devolve canais EVOLUTION, então o wizard e o cabeçalho de progresso
    // (que resolviam o canal por ali) nunca viam a quota de um canal GOZAP —
    // o canal de PRODUÇÃO. Isto prova que `GET /whatsapp/providers` agora
    // devolve a quota também para GOZAP.
    it('T15 — o resumo de um canal GOZAP traz a quota (dailySendLimit/sentToday/warmupEffectiveCap)', async () => {
      svc.configuredProviders.mockReturnValue(['GOZAP']);
      instancesRepo.listAll.mockResolvedValue([
        channel({
          id: 'g1',
          provider: 'GOZAP',
          dailySendLimit: 500,
          sentToday: 120,
          sentTodayResetAt: new Date('2026-08-24T13:00:00.000Z'),
          warmupStartedAt: null,
        }),
      ] as never);

      const result = await controller.providers();

      expect(result.providers[0].channels[0]).toMatchObject({
        id: 'g1',
        provider: 'GOZAP',
        dailySendLimit: 500,
        sentToday: 120,
        sentTodayResetAt: '2026-08-24T13:00:00.000Z',
        warmupEffectiveCap: 500,
        warming: false,
        warmupDay: 0,
      });
    });

    // T15 — prova que o controller DELEGA para `warmupInfo` (única fonte de
    // verdade da rampa) em vez de reimplementar a conta: um canal em
    // aquecimento (dia 2 — índice 1) tem que trazer o teto da RAMPA (50, não
    // os 500 configurados).
    it('T15 — em aquecimento, o teto do resumo é o da rampa (delega para warmupInfo)', async () => {
      svc.configuredProviders.mockReturnValue(['GOZAP']);
      const warmupStartedAt = new Date(Date.now() - 24 * 60 * 60 * 1000);
      instancesRepo.listAll.mockResolvedValue([
        channel({
          id: 'g2',
          provider: 'GOZAP',
          dailySendLimit: 500,
          sentToday: 10,
          warmupStartedAt,
        }),
      ] as never);

      const result = await controller.providers();

      expect(result.providers[0].channels[0]).toMatchObject({
        warmupEffectiveCap: 50,
        warming: true,
        warmupDay: 2,
      });
    });

    it('expõe o zernioAccountId no resumo — é o que deixa o form marcar a conta como "já cadastrada"', async () => {
      svc.configuredProviders.mockReturnValue(['ZERNIO']);
      instancesRepo.listAll.mockResolvedValue([
        channel({ id: 'z1', provider: 'ZERNIO', zernioAccountId: 'a1b2c3d4e5f6a7b8c9d0e1f2' }),
      ] as never);

      const result = await controller.providers();

      expect(result.providers[0].channels[0]).toMatchObject({
        id: 'z1',
        zernioAccountId: 'a1b2c3d4e5f6a7b8c9d0e1f2',
      });
    });

    it('never leaks apiKey/evolutionInstanceName in the channel summary', async () => {
      svc.configuredProviders.mockReturnValue(['EVOLUTION']);
      instancesRepo.listAll.mockResolvedValue([
        channel({ id: 'e1', provider: 'EVOLUTION' }),
      ] as never);

      const result = await controller.providers();

      const summary = result.providers[0].channels[0];
      expect(summary).not.toHaveProperty('apiKey');
      expect(summary).not.toHaveProperty('evolutionInstanceName');
    });

    it('includes BOTH active and inactive channels (isActive surfaced, never filtered out)', async () => {
      svc.configuredProviders.mockReturnValue(['EVOLUTION']);
      instancesRepo.listAll.mockResolvedValue([
        channel({ id: 'active', provider: 'EVOLUTION', isActive: true }),
        channel({ id: 'inactive', provider: 'EVOLUTION', isActive: false, isDefault: false }),
      ] as never);

      const result = await controller.providers();

      expect(result.providers[0].channels).toHaveLength(2);
      expect(result.providers[0].channels.map((c) => c.id).sort()).toEqual(['active', 'inactive']);
    });

    it('a configured provider with zero channels still appears with an empty array', async () => {
      svc.configuredProviders.mockReturnValue(['EVOLUTION', 'META']);
      instancesRepo.listAll.mockResolvedValue([
        channel({ id: 'e1', provider: 'EVOLUTION' }),
      ] as never);

      const result = await controller.providers();

      expect(result.providers.find((p) => p.provider === 'META')).toEqual({
        provider: 'META',
        traits: PROVIDER_TRAITS.META,
        capabilities: [],
        channels: [],
      });
    });

    it('returns an empty providers array when nothing is configured', async () => {
      svc.configuredProviders.mockReturnValue([]);

      const result = await controller.providers();

      expect(result).toEqual({ providers: [] });
      expect(instancesRepo.listAll).not.toHaveBeenCalled();
    });

    // F0/T4: expõe o profile declarado do adapter (traits + capacidades) —
    // é o que deixa o frontend parar de manter sua própria cópia duplicada.
    it('inclui traits e capabilities de cada provider configurado', async () => {
      svc.configuredProviders.mockReturnValue(['EVOLUTION']);
      // Fixture deliberadamente FORA de ordem alfabética — se o controller só
      // repassasse `profile.capabilities` sem ordenar, a asserção abaixo (valor
      // literal) pegaria isso. Uma fixture já alfabética não falsificaria nada:
      // ordenar uma cópia do próprio resultado e comparar com ele mesmo passa
      // mesmo sem nenhum `.sort()` no controller.
      svc.profileFor.mockImplementation((p: string) =>
        makeProfile(PROVIDER_TRAITS[p as keyof typeof PROVIDER_TRAITS], [
          'statusPolling',
          'campaignSend',
        ]),
      );

      const res = await controller.providers();
      const evo = res.providers.find((p) => p.provider === 'EVOLUTION');
      expect(evo?.traits).toEqual({ official: false, sessionBased: true, sessionWindow: false });
      // Valor literal esperado — não uma cópia ordenada do próprio resultado.
      expect(evo?.capabilities).toEqual(['campaignSend', 'statusPolling']);
    });
  });

  // T8: POST /whatsapp/channels — creates a cloud-provider channel row
  // directly (no external provisioning). EVOLUTION is rejected here — it
  // still goes through the existing instance-provisioning flow
  // (POST /whatsapp/instances).
  describe('POST /whatsapp/channels', () => {
    const body: CreateChannelDto = {
      provider: 'TWILIO',
      name: 'Vendas Twilio',
      phoneE164: '+5592987654321',
    } as CreateChannelDto;

    it('creates a cloud channel row via the instances repository', async () => {
      instancesRepo.createOrReactivateCloudChannel.mockResolvedValue({
        id: 'c1',
        name: 'Vendas Twilio',
        provider: 'TWILIO',
        phoneE164: '+5592987654321',
        apiKey: null,
      } as never);

      const result = await controller.createChannel(body);

      expect(instancesRepo.createOrReactivateCloudChannel).toHaveBeenCalledWith({
        provider: 'TWILIO',
        name: 'Vendas Twilio',
        phoneE164: '+5592987654321',
        twilioMessagingServiceSid: undefined,
        zernioAccountId: undefined,
        // Só ZERNIO valida a conta contra a API do provedor; nos demais o campo
        // é sempre null (nunca "verificado" por acidente).
        zernioAccountVerifiedAt: null,
      });
      expect(result).toMatchObject({ id: 'c1', provider: 'TWILIO' });
    });

    it('forwards twilioMessagingServiceSid when provided', async () => {
      instancesRepo.createOrReactivateCloudChannel.mockResolvedValue({ id: 'c1' } as never);

      await controller.createChannel({
        ...body,
        twilioMessagingServiceSid: 'MGxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      } as CreateChannelDto);

      expect(instancesRepo.createOrReactivateCloudChannel).toHaveBeenCalledWith(
        expect.objectContaining({
          twilioMessagingServiceSid: 'MGxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
        }),
      );
    });

    it('never returns apiKey on the created channel (A5)', async () => {
      instancesRepo.createOrReactivateCloudChannel.mockResolvedValue({
        id: 'c1',
        provider: 'TWILIO',
        apiKey: 'must-not-leak',
      } as never);

      const result = await controller.createChannel(body);

      expect(result).not.toHaveProperty('apiKey');
    });

    it('audits the channel creation', async () => {
      instancesRepo.createOrReactivateCloudChannel.mockResolvedValue({
        id: 'c1',
        name: 'Vendas Twilio',
        provider: 'TWILIO',
        phoneE164: '+5592987654321',
      } as never);

      await controller.createChannel(body);

      expect(audit.log).toHaveBeenCalledWith(
        'instance.create',
        'WhatsappInstance',
        'c1',
        expect.objectContaining({ provider: 'TWILIO' }),
      );
    });

    it('rejects provider=EVOLUTION with a PT-BR 400 pointing at the existing instance flow', async () => {
      await expect(
        controller.createChannel({ ...body, provider: 'EVOLUTION' } as CreateChannelDto),
      ).rejects.toMatchObject({ status: 400 });
      await expect(
        controller.createChannel({ ...body, provider: 'EVOLUTION' } as CreateChannelDto),
      ).rejects.toBeInstanceOf(DomainError);
      expect(instancesRepo.createOrReactivateCloudChannel).not.toHaveBeenCalled();
    });

    it('rejects a provider that is not configured on this deploy (400)', async () => {
      svc.isProviderConfigured.mockReturnValue(false);

      await expect(controller.createChannel(body)).rejects.toMatchObject({
        status: 400,
      });
      expect(instancesRepo.createOrReactivateCloudChannel).not.toHaveBeenCalled();
    });

    // F-A Task 7: GOZAP has EXTERNAL provisioning (unlike TWILIO/ZERNIO/META,
    // which just persist a row) — the controller delegates the whole thing to
    // GozapInstancesService instead of instancesRepo.createOrReactivateCloudChannel.
    it('provider=GOZAP delegates to gozapInstances.createChannel and returns its result verbatim', async () => {
      gozapInstances.createChannel.mockResolvedValue({
        id: 'gz-ch1',
        name: 'Canal GoZap',
        provider: 'GOZAP',
      } as never);

      const result = await controller.createChannel({
        provider: 'GOZAP',
        name: 'Canal GoZap',
      } as CreateChannelDto);

      expect(gozapInstances.createChannel).toHaveBeenCalledWith({
        name: 'Canal GoZap',
      });
      expect(instancesRepo.createOrReactivateCloudChannel).not.toHaveBeenCalled();
      expect(result).toMatchObject({ id: 'gz-ch1', provider: 'GOZAP' });
    });

    it('provider=GOZAP still checks isProviderConfigured before delegating', async () => {
      svc.isProviderConfigured.mockReturnValue(false);

      await expect(
        controller.createChannel({ provider: 'GOZAP', name: 'Canal GoZap' } as CreateChannelDto),
      ).rejects.toMatchObject({ status: 400 });
      expect(gozapInstances.createChannel).not.toHaveBeenCalled();
    });

    it('checks configuration for the REQUESTED provider, not a hardcoded one', async () => {
      svc.isProviderConfigured.mockImplementation((p: string) => p === 'ZERNIO');
      instancesRepo.createOrReactivateCloudChannel.mockResolvedValue({ id: 'c1', provider: 'ZERNIO' } as never);

      await controller.createChannel({ ...body, provider: 'ZERNIO' } as CreateChannelDto);

      expect(svc.isProviderConfigured).toHaveBeenCalledWith('ZERNIO');
      expect(instancesRepo.createOrReactivateCloudChannel).toHaveBeenCalled();
    });

    // T9: no DB-level unique constraint covers provider+phoneE164 (phoneE164
    // is nullable and shared across providers by design), so a second ACTIVE
    // channel with the same provider+phone would silently split delivery
    // across two rows. Guard it at the app layer instead.
    it('rejects a duplicate ACTIVE channel with the same provider+phoneE164 (400 PT)', async () => {
      instancesRepo.findActiveByProviderAndPhone.mockResolvedValue({
        id: 'existing-1',
        provider: 'TWILIO',
        phoneE164: '+5592987654321',
      } as never);

      await expect(controller.createChannel(body)).rejects.toMatchObject({
        status: 400,
        code: 'channel.duplicate_phone',
      });
      expect(instancesRepo.findActiveByProviderAndPhone).toHaveBeenCalledWith(
        'TWILIO',
        '+5592987654321',
      );
      expect(instancesRepo.createOrReactivateCloudChannel).not.toHaveBeenCalled();
    });

    it('allows creation when no ACTIVE duplicate exists for that provider+phone', async () => {
      instancesRepo.findActiveByProviderAndPhone.mockResolvedValue(null);
      instancesRepo.createOrReactivateCloudChannel.mockResolvedValue({ id: 'c1', provider: 'TWILIO' } as never);

      await controller.createChannel(body);

      expect(instancesRepo.createOrReactivateCloudChannel).toHaveBeenCalled();
    });

    // Z3: ZERNIO channels forward zernioAccountId end to end and get an
    // additional dedupe guard (same-account reuse across two active channels
    // would let a campaign silently split delivery, same rationale as T9's
    // provider+phone guard).
    describe('zernioAccountId', () => {
      const zernioBody = {
        provider: 'ZERNIO',
        name: 'Vendas Zernio',
        phoneE164: '+5592987654321',
        zernioAccountId: 'acc-123',
      } as unknown as CreateChannelDto;

      it('forwards zernioAccountId to createCloudChannel', async () => {
        instancesRepo.createOrReactivateCloudChannel.mockResolvedValue({
          id: 'c1',
          provider: 'ZERNIO',
        } as never);

        await controller.createChannel(zernioBody);

        expect(instancesRepo.createOrReactivateCloudChannel).toHaveBeenCalledWith(
          expect.objectContaining({
            provider: 'ZERNIO',
            zernioAccountId: 'acc-123',
          }),
        );
      });

      it('rejects a duplicate ACTIVE channel with the same zernioAccountId (400 PT)', async () => {
        instancesRepo.findActiveByZernioAccountId.mockResolvedValue({
          id: 'existing-zernio',
          provider: 'ZERNIO',
          zernioAccountId: 'acc-123',
        } as never);

        await expect(
          controller.createChannel(zernioBody),
        ).rejects.toMatchObject({
          status: 400,
          code: 'channel.duplicate_zernio_account',
        });
        expect(instancesRepo.findActiveByZernioAccountId).toHaveBeenCalledWith(
          'acc-123',
        );
        expect(instancesRepo.createOrReactivateCloudChannel).not.toHaveBeenCalled();
      });

      it('the duplicate zernioAccountId error message is PT-BR', async () => {
        instancesRepo.findActiveByZernioAccountId.mockResolvedValue({
          id: 'existing-zernio',
        } as never);

        await expect(
          controller.createChannel(zernioBody),
        ).rejects.toMatchObject({
          message: expect.stringMatching(/j[áa] existe um canal/i),
        });
      });

      it('allows creation when no ACTIVE duplicate exists for that zernioAccountId', async () => {
        instancesRepo.findActiveByZernioAccountId.mockResolvedValue(null);
        instancesRepo.createOrReactivateCloudChannel.mockResolvedValue({
          id: 'c1',
          provider: 'ZERNIO',
        } as never);

        await controller.createChannel(zernioBody);

        expect(instancesRepo.createOrReactivateCloudChannel).toHaveBeenCalled();
      });

      it('does not check zernioAccountId dedupe for non-ZERNIO providers', async () => {
        instancesRepo.createOrReactivateCloudChannel.mockResolvedValue({
          id: 'c1',
          provider: 'TWILIO',
        } as never);

        await controller.createChannel(body); // provider TWILIO, no zernioAccountId

        expect(instancesRepo.findActiveByZernioAccountId).not.toHaveBeenCalled();
      });
    });

    /**
     * INCIDENTE DE PRODUÇÃO: um canal criado com um `zernioAccountId` digitado
     * errado não faz NADA falhar no cadastro — mas todo webhook daquela conta
     * chega, autentica, não resolve canal nenhum e é descartado em silêncio.
     * Um disparo de ~100 mensagens foi perdido assim. A criação passa a validar
     * o id contra `GET /accounts` do Zernio.
     */
    describe('validação do zernioAccountId contra a API do Zernio', () => {
      const zernioBody = {
        provider: 'ZERNIO',
        name: 'Vendas Zernio',
        zernioAccountId: 'acc-123',
      } as unknown as CreateChannelDto;

      const conta = {
        id: 'acc-123',
        displayName: 'Canal CONTINUUM',
        phoneE164: '+5592999998888',
        qualityRating: 'GREEN',
      };

      it('accountId inexistente → erro PT-BR listando as contas disponíveis (id + número + nome)', async () => {
        zernioAccounts.lookup.mockResolvedValue({
          status: 'not_found',
          accounts: [
            conta,
            {
              id: 'acc-999',
              displayName: 'Outro canal',
              phoneE164: '+5592777776666',
            },
          ],
        } as never);

        const err = await controller
          .createChannel(zernioBody)
          .catch((e: unknown) => e);

        expect(err).toBeInstanceOf(DomainError);
        expect(err).toMatchObject({
          status: 400,
          code: 'channel.zernio_account_not_found',
        });
        const message = (err as DomainError).message;
        // A mensagem tem de ser acionável: o operador precisa ver QUAIS ids
        // existem para escolher o certo, com número e nome para reconhecê-los.
        expect(message).toMatch(/acc-123/);
        expect(message).toMatch(/acc-999/);
        expect(message).toMatch(/\+5592999998888/);
        expect(message).toMatch(/Canal CONTINUUM/);
        expect(instancesRepo.createOrReactivateCloudChannel).not.toHaveBeenCalled();
      });

      it('accountId válido → cria o canal com phoneE164 preenchido a partir da conta e marcado como verificado', async () => {
        zernioAccounts.lookup.mockResolvedValue({
          status: 'found',
          account: conta,
        } as never);
        instancesRepo.createOrReactivateCloudChannel.mockResolvedValue({
          id: 'c1',
          provider: 'ZERNIO',
        } as never);

        await controller.createChannel(zernioBody);

        expect(zernioAccounts.lookup).toHaveBeenCalledWith('acc-123');
        expect(instancesRepo.createOrReactivateCloudChannel).toHaveBeenCalledWith(
          expect.objectContaining({
            provider: 'ZERNIO',
            zernioAccountId: 'acc-123',
            // Bônus: o canal ZERNIO passa a ter número (antes ficava null e
            // atrapalhava o inbox).
            phoneE164: '+5592999998888',
            zernioAccountVerifiedAt: expect.any(Date),
          }),
        );
      });

      it('Zernio fora do ar → NÃO bloqueia a criação (degrada), mas deixa o canal sem verificação', async () => {
        zernioAccounts.lookup.mockResolvedValue({
          status: 'unavailable',
          reason: 'ECONNREFUSED',
        } as never);
        instancesRepo.createOrReactivateCloudChannel.mockResolvedValue({
          id: 'c1',
          provider: 'ZERNIO',
        } as never);

        const result = await controller.createChannel(zernioBody);

        expect(result).toMatchObject({ id: 'c1' });
        expect(instancesRepo.createOrReactivateCloudChannel).toHaveBeenCalledWith(
          expect.objectContaining({
            zernioAccountId: 'acc-123',
            // null = pendente de revalidação (a indisponibilidade do Zernio não
            // pode impedir a configuração, mas não podemos fingir que validamos).
            zernioAccountVerifiedAt: null,
          }),
        );
      });

      it('não valida contra o Zernio para provedores não-ZERNIO', async () => {
        instancesRepo.createOrReactivateCloudChannel.mockResolvedValue({
          id: 'c1',
          provider: 'TWILIO',
        } as never);

        await controller.createChannel(body);

        expect(zernioAccounts.lookup).not.toHaveBeenCalled();
      });

      it('um phoneE164 explícito no body vence o número da conta Zernio', async () => {
        zernioAccounts.lookup.mockResolvedValue({
          status: 'found',
          account: conta,
        } as never);
        instancesRepo.createOrReactivateCloudChannel.mockResolvedValue({
          id: 'c1',
        } as never);

        await controller.createChannel({
          ...zernioBody,
          phoneE164: '+5511333334444',
        } as CreateChannelDto);

        expect(instancesRepo.createOrReactivateCloudChannel).toHaveBeenCalledWith(
          expect.objectContaining({ phoneE164: '+5511333334444' }),
        );
      });
    });
  });

  /**
   * GET /whatsapp/zernio/accounts — as contas disponíveis para o seletor do form
   * de canal ZERNIO. Digitar o id à mão é exatamente o que causou o incidente.
   */
  describe('GET /whatsapp/zernio/accounts', () => {
    it('lista as contas do Zernio', async () => {
      const accounts = [
        {
          id: 'acc-123',
          displayName: 'Canal CONTINUUM',
          phoneE164: '+5592999998888',
          qualityRating: 'GREEN',
          messagingLimitTier: 'TIER_1K',
          nameStatus: 'DECLINED',
        },
      ];
      zernioAccounts.listAccounts.mockResolvedValue(accounts as never);

      await expect(controller.zernioAccountsList()).resolves.toEqual({
        accounts,
        unavailable: false,
      });
    });

    it('Zernio fora do ar → 200 com unavailable=true (o form cai no input manual)', async () => {
      zernioAccounts.listAccounts.mockRejectedValue(new Error('ECONNREFUSED'));

      await expect(controller.zernioAccountsList()).resolves.toEqual({
        accounts: [],
        unavailable: true,
      });
    });
  });

  /**
   * F-A Task 7: QR do canal GOZAP — endpoint próprio (não reusa
   * /whatsapp/instances/:id/qr, que é Evolution-only), delega inteiramente a
   * GozapInstancesService.getConnectionInfo.
   */
  describe('GET /whatsapp/channels/:id/qr', () => {
    it('delegates to gozapInstances.getConnectionInfo and returns its result verbatim', async () => {
      gozapInstances.getConnectionInfo.mockResolvedValue({
        state: 'connecting',
        qrBase64: 'data:image/png;base64,AAAA',
      });

      const result = await controller.gozapQr('gz-ch1');

      expect(gozapInstances.getConnectionInfo).toHaveBeenCalledWith('gz-ch1');
      expect(result).toEqual({
        state: 'connecting',
        qrBase64: 'data:image/png;base64,AAAA',
      });
    });
  });

  /**
   * Review fix (Important 1): sem esta rota, um canal GOZAP não tinha NENHUM
   * jeito de ser removido — o DELETE /whatsapp/instances/:id existente é
   * Evolution-only e nunca chama DELETE /instance no GoZap.
   */
  describe('DELETE /whatsapp/channels/:id', () => {
    it('delegates to gozapInstances.remove', async () => {
      gozapInstances.remove.mockResolvedValue(undefined);

      await controller.removeChannel('gz-ch1');

      expect(gozapInstances.remove).toHaveBeenCalledWith('gz-ch1');
    });
  });

  /**
   * GET /whatsapp/webhook-drops — o endpoint de saúde que expõe a perda. Sem
   * ele, "estamos jogando webhooks fora" continuaria sendo uma informação que só
   * existe no log.
   */
  describe('GET /whatsapp/webhook-drops', () => {
    it('expõe as contas órfãs (conta, contagem, eventos) para o banner da página Canais', async () => {
      const alerta = {
        provider: 'ZERNIO' as const,
        accountRef: 'a1b2c3d4e5f6a7b8c9d0e1f2',
        totalCount: 33,
        events: ['message.delivered', 'message.read', 'message.received'],
        firstSeenAt: new Date('2026-07-10T10:00:00Z'),
        lastSeenAt: new Date('2026-07-10T13:00:00Z'),
      };
      drops.listUnresolved.mockResolvedValue([alerta]);

      await expect(controller.webhookDrops()).resolves.toEqual({ drops: [alerta] });
    });

    it('sem drops → lista vazia (nenhum alerta é mostrado)', async () => {
      drops.listUnresolved.mockResolvedValue([]);

      await expect(controller.webhookDrops()).resolves.toEqual({ drops: [] });
    });
  });

  /**
   * CANAL ÚNICO — o operador precisa poder DESATIVAR um canal pela tela.
   *
   * O incidente que isto previne: existem duas contas Zernio na base, e só UMA
   * pode disparar. A outra continuava aparecendo como opção no assistente de
   * campanha — um clique errado mandaria a campanha inteira pelo número
   * proibido, e não há como despublicar uma mensagem de WhatsApp.
   *
   * Desativar NÃO apaga: o histórico e as conversas do canal continuam. O que
   * muda é que ele some dos SELETORES (assistente de campanha, abas do inbox) e
   * o webhook que chegar para ele segue sendo descartado+registrado (WebhookDrop).
   */
  describe('PATCH /whatsapp/channels/:id (ativar/desativar + broadcast)', () => {
    const ZERNIO_CHANNEL = {
      id: 'ch-zernio',
      name: 'Matheus Garcia',
      provider: 'ZERNIO' as const,
      phoneE164: '+559231550101',
      zernioAccountId: 'a1b2c3d4e5f6a7b8c9d0e1f2',
      isActive: true,
      isDefault: true,
      zernioBroadcastEnabled: false,
      zernioBroadcastChunk: 50,
      apiKey: 'segredo-que-nao-pode-vazar',
    };

    const twilioChannel = {
      ...ZERNIO_CHANNEL,
      id: 'ch-twilio',
      provider: 'TWILIO' as const,
      zernioAccountId: null,
    };

    it('desativa o canal e devolve a linha atualizada', async () => {
      instancesRepo.findById.mockResolvedValue(ZERNIO_CHANNEL as never);
      instancesRepo.updateSettings.mockResolvedValue({
        ...ZERNIO_CHANNEL,
        isActive: false,
        isDefault: false,
      } as never);

      const out = await controller.updateChannel('ch-zernio', { active: false });

      expect(instancesRepo.updateSettings).toHaveBeenCalledWith('ch-zernio', {
        isActive: false,
        isDefault: false,
      });
      expect(out.isActive).toBe(false);
    });

    /**
     * `findDefault()` NÃO filtra isActive. Um canal desativado que continuasse
     * `isDefault` seguiria sendo escolhido pelo roteador como padrão do provedor
     * — a desativação não teria servido para nada.
     */
    it('desativar LIMPA o isDefault — senão o canal desativado continua sendo o padrão', async () => {
      instancesRepo.findById.mockResolvedValue(ZERNIO_CHANNEL as never);
      instancesRepo.updateSettings.mockResolvedValue({
        ...ZERNIO_CHANNEL,
        isActive: false,
        isDefault: false,
      } as never);

      const out = await controller.updateChannel('ch-zernio', { active: false });

      expect(out.isDefault).toBe(false);
    });

    it('reativa um canal desativado', async () => {
      instancesRepo.findById.mockResolvedValue({
        ...ZERNIO_CHANNEL,
        isActive: false,
        isDefault: false,
      } as never);
      instancesRepo.updateSettings.mockResolvedValue({
        ...ZERNIO_CHANNEL,
        isActive: true,
        isDefault: false,
      } as never);

      const out = await controller.updateChannel('ch-zernio', { active: true });

      expect(instancesRepo.updateSettings).toHaveBeenCalledWith('ch-zernio', {
        isActive: true,
      });
      expect(out.isActive).toBe(true);
    });

    /**
     * O MESMO guard do POST /whatsapp/channels. Sem ele, reativar um canal cuja
     * conta Zernio já foi assumida por outro canal ATIVO deixaria DOIS canais
     * ativos com o mesmo `zernioAccountId` — e a entrega de uma campanha se
     * dividiria em silêncio entre as duas linhas.
     */
    it('reativar com a conta Zernio já tomada por outro canal ATIVO → recusa', async () => {
      instancesRepo.findById.mockResolvedValue({
        ...ZERNIO_CHANNEL,
        isActive: false,
      } as never);
      instancesRepo.findActiveByZernioAccountId.mockResolvedValue({
        id: 'outro-canal-ativo',
      } as never);

      await expect(
        controller.updateChannel('ch-zernio', { active: true }),
      ).rejects.toBeInstanceOf(DomainError);
      expect(instancesRepo.updateSettings).not.toHaveBeenCalled();
    });

    it('id inexistente → InstanceNotFoundError', async () => {
      instancesRepo.findById.mockResolvedValue(null);

      await expect(
        controller.updateChannel('nao-existe', { active: false }),
      ).rejects.toBeInstanceOf(InstanceNotFoundError);
      expect(instancesRepo.updateSettings).not.toHaveBeenCalled();
    });

    it('nunca devolve a apiKey', async () => {
      instancesRepo.findById.mockResolvedValue(ZERNIO_CHANNEL as never);
      instancesRepo.updateSettings.mockResolvedValue({
        ...ZERNIO_CHANNEL,
        isActive: false,
      } as never);

      const out = await controller.updateChannel('ch-zernio', { active: false });

      expect(out).not.toHaveProperty('apiKey');
    });

    // F-A Task 7: este endpoint é GENÉRICO (qualquer provider) — um canal
    // GOZAP passa por ele (ex.: desativar) e o token cifrado NUNCA pode sair,
    // nem no ramo que faz update, nem no ramo no-op (body vazio).
    it('nunca devolve gozapInstanceToken (nem no update, nem no ramo no-op)', async () => {
      const GOZAP_CHANNEL = {
        id: 'ch-gozap',
        name: 'Canal GoZap',
        provider: 'GOZAP' as const,
        isActive: true,
        isDefault: false,
        gozapInstanceToken: 'segredo-cifrado-nao-pode-vazar',
        apiKey: null,
      };
      instancesRepo.findById.mockResolvedValue(GOZAP_CHANNEL as never);
      instancesRepo.updateSettings.mockResolvedValue({
        ...GOZAP_CHANNEL,
        isActive: false,
      } as never);

      const updated = await controller.updateChannel('ch-gozap', { active: false });
      expect(updated).not.toHaveProperty('gozapInstanceToken');

      const noop = await controller.updateChannel('ch-gozap', {});
      expect(noop).not.toHaveProperty('gozapInstanceToken');
    });

    it('registra no audit quem mexeu no canal', async () => {
      instancesRepo.findById.mockResolvedValue(ZERNIO_CHANNEL as never);
      instancesRepo.updateSettings.mockResolvedValue({
        ...ZERNIO_CHANNEL,
        isActive: false,
      } as never);

      await controller.updateChannel('ch-zernio', { active: false });

      expect(audit.log).toHaveBeenCalledWith(
        'instance.update_settings',
        'WhatsappInstance',
        'ch-zernio',
        expect.objectContaining({ active: false }),
      );
    });

    // ── BROADCAST DO ZERNIO ───────────────────────────────────────────────────
    //
    // As duas colunas (`zernioBroadcastEnabled`, `zernioBroadcastChunk`) decidem
    // se a campanha vira um broadcast NATIVO (que aparece no painel do Zernio) ou
    // sai pelo 1-a-1 (o padrão, e o fallback). Até agora só dava para ligá-las com
    // SQL direto em produção.

    it('liga o broadcast do Zernio pelo MESMO endpoint', async () => {
      instancesRepo.findById.mockResolvedValue(ZERNIO_CHANNEL as never);
      instancesRepo.updateSettings.mockResolvedValue({
        ...ZERNIO_CHANNEL,
        zernioBroadcastEnabled: true,
      } as never);

      const out = await controller.updateChannel('ch-zernio', {
        zernioBroadcastEnabled: true,
      });

      expect(instancesRepo.updateSettings).toHaveBeenCalledWith('ch-zernio', {
        zernioBroadcastEnabled: true,
      });
      expect(out.zernioBroadcastEnabled).toBe(true);
    });

    it('grava o tamanho do bloco de destinatários', async () => {
      instancesRepo.findById.mockResolvedValue(ZERNIO_CHANNEL as never);
      instancesRepo.updateSettings.mockResolvedValue({
        ...ZERNIO_CHANNEL,
        zernioBroadcastChunk: 80,
      } as never);

      const out = await controller.updateChannel('ch-zernio', {
        zernioBroadcastChunk: 80,
      });

      expect(instancesRepo.updateSettings).toHaveBeenCalledWith('ch-zernio', {
        zernioBroadcastChunk: 80,
      });
      expect(out.zernioBroadcastChunk).toBe(80);
    });

    /**
     * Broadcast é uma capacidade do ZERNIO. Aceitar a flag num canal TWILIO
     * gravaria uma configuração que nunca teria efeito — e o operador ficaria
     * esperando um broadcast que não existe.
     */
    it('recusa configurar broadcast em canal que não é ZERNIO', async () => {
      instancesRepo.findById.mockResolvedValue(twilioChannel as never);

      await expect(
        controller.updateChannel('ch-twilio', { zernioBroadcastEnabled: true }),
      ).rejects.toBeInstanceOf(DomainError);
      expect(instancesRepo.updateSettings).not.toHaveBeenCalled();
    });

    it('body vazio → não escreve nada (nada a fazer não é um erro)', async () => {
      instancesRepo.findById.mockResolvedValue(ZERNIO_CHANNEL as never);

      await controller.updateChannel('ch-zernio', {});

      expect(instancesRepo.updateSettings).not.toHaveBeenCalled();
    });
  });
});
