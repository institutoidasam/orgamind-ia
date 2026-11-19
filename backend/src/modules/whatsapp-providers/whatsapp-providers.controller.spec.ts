import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { mockDeep, MockProxy } from 'vitest-mock-extended';
import { WhatsappProvidersController } from './whatsapp-providers.controller';
import type { WhatsappProvidersService } from './whatsapp-providers.service';
import { WhatsappInstancesRepository } from '../whatsapp-instances/whatsapp-instances.repository';
import { InstanceNotFoundError } from '../whatsapp-instances/errors/instance.errors';
import { AuditService } from '../../shared/audit/audit.service';
import { DomainError } from '../../shared/errors/domain.error';
import { WebhookDropsService } from './webhook-drops.service';
import type { DisabledChannelsService } from './disabled-channels.service';
import { WhatsappProvidersRepository } from './whatsapp-providers.repository';
import type { CreateChannelDto } from './dto/create-channel.dto';
import { PROVIDER_TRAITS } from '../../schemas/contracts/channel-provider.schema';
import { makeProfile } from './ports/provider-profile';
import { RolesGuard } from '../auth/roles.guard';
import { Reflector } from '@nestjs/core';
import type { ExecutionContext } from '@nestjs/common';
import { HTTP_CODE_METADATA } from '@nestjs/common/constants';
import { routesOf } from '../../../test/routes-of';

// O usuário que o JwtStrategy deixa em req.user (sub = id do ADMIN que chama).
const ADMIN_REQ = { user: { sub: 'admin-1', role: 'ADMIN' } } as never;

/** O RolesGuard real aplicado ao handler do controller, para um papel. */
function rolesGuardFor(
  method: 'setChannelSectors' | 'removeChannel',
): (role: string) => () => boolean {
  const handler = WhatsappProvidersController.prototype[method];
  return (role) => {
    const context = {
      getHandler: () => handler,
      getClass: () => WhatsappProvidersController,
      switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }),
    } as unknown as ExecutionContext;
    return () => new RolesGuard(new Reflector()).canActivate(context);
  };
}

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
  let drops: MockProxy<WebhookDropsService>;
  let disabledChannels: MockProxy<DisabledChannelsService>;
  let providersRepo: MockProxy<WhatsappProvidersRepository>;
  let sectorChannel: {
    assertAssignable: Mock;
    assign: Mock;
    sectorsByChannel: Mock;
  };
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
    drops = mockDeep<WebhookDropsService>();
    drops.listUnresolved.mockResolvedValue([]);
    disabledChannels = mockDeep<DisabledChannelsService>();
    disabledChannels.listDisabled.mockResolvedValue([]);
    providersRepo = mockDeep<WhatsappProvidersRepository>();
    // Default: nenhum canal tem evento de conexão — connectionState fica
    // null. Os testes de conexão sobrescrevem.
    providersRepo.lastStateByInstanceIds.mockResolvedValue(new Map());
    // Default: nenhum canal tem áreas; assertAssignable devolve os ids únicos.
    sectorChannel = {
      assertAssignable: vi.fn((ids: string[]) =>
        Promise.resolve([...new Set(ids)]),
      ),
      assign: vi.fn(),
      sectorsByChannel: vi.fn().mockResolvedValue(new Map()),
    };
    controller = new WhatsappProvidersController(
      svc as unknown as WhatsappProvidersService,
      instancesRepo,
      audit,
      drops,
      providersRepo,
      disabledChannels,
    );
    // O SectorChannelService entra por propriedade (@Inject), não pelo construtor.
    Object.assign(controller, { sectorChannel });
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

    it('GET providers: canais GOZAP do banco não aparecem em providers (só o registry decide)', async () => {
      svc.configuredProviders.mockReturnValue(['EVOLUTION']);
      instancesRepo.listAll.mockResolvedValue([
        channel({ id: 'e1', provider: 'EVOLUTION' }),
        // Linha de provedor desligado no banco — fora do registry, fora da lista.
        channel({ id: 'g1', provider: 'GOZAP', isDefault: false }),
      ] as never);

      const result = await controller.providers(ADMIN_REQ);

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
                sectors: [],
              },
            ],
          },
        ],
        disabledChannels: [],
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

      const result = await controller.providers(ADMIN_REQ);

      expect(providersRepo.lastStateByInstanceIds).toHaveBeenCalledWith(['g1', 'g2']);
      const byId = new Map(result.providers[0].channels.map((c) => [c.id, c.connectionState]));
      expect(byId.get('g1')).toBe('open');
      expect(byId.get('g2')).toBe('connecting');
    });

    // Um canal sem evento nenhum (nunca conectou, ou não é sessionBased) não
    // pode virar "close" inventado — precisa ficar null, senão a tela mentiria
    // "desconectado" para um canal TWILIO que está perfeitamente ativo.
    // C1 — a tela Canais mostra as áreas que cada número atende, por nome.
    it('traz as áreas de cada canal (sectorsByChannel, por id; sem áreas = lista vazia)', async () => {
      svc.configuredProviders.mockReturnValue(['GOZAP']);
      instancesRepo.listAll.mockResolvedValue([
        channel({ id: 'g1', provider: 'GOZAP' }),
        channel({ id: 'g2', provider: 'GOZAP', isDefault: false }),
      ] as never);
      sectorChannel.sectorsByChannel.mockResolvedValue(
        new Map([
          [
            'g1',
            [
              { id: 's1', name: 'Expedição' },
              { id: 's2', name: 'Logística' },
            ],
          ],
        ]),
      );

      const result = await controller.providers(ADMIN_REQ);

      expect(sectorChannel.sectorsByChannel).toHaveBeenCalledWith(['g1', 'g2']);
      expect(
        result.providers[0].channels.map((c) =>
          (c.sectors ?? []).map((s) => s.name),
        ),
      ).toEqual([['Expedição', 'Logística'], []]);
    });

    it('connectionState fica null quando o canal não tem evento nenhum', async () => {
      svc.configuredProviders.mockReturnValue(['TWILIO']);
      instancesRepo.listAll.mockResolvedValue([
        channel({ id: 't1', provider: 'TWILIO' }),
      ] as never);
      providersRepo.lastStateByInstanceIds.mockResolvedValue(new Map());

      const result = await controller.providers(ADMIN_REQ);

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

      const result = await controller.providers(ADMIN_REQ);

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

      const result = await controller.providers(ADMIN_REQ);

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

      const result = await controller.providers(ADMIN_REQ);

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

      const result = await controller.providers(ADMIN_REQ);

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

      const result = await controller.providers(ADMIN_REQ);

      expect(result.providers[0].channels).toHaveLength(2);
      expect(result.providers[0].channels.map((c) => c.id).sort()).toEqual(['active', 'inactive']);
    });

    it('a configured provider with zero channels still appears with an empty array', async () => {
      svc.configuredProviders.mockReturnValue(['EVOLUTION', 'META']);
      instancesRepo.listAll.mockResolvedValue([
        channel({ id: 'e1', provider: 'EVOLUTION' }),
      ] as never);

      const result = await controller.providers(ADMIN_REQ);

      expect(result.providers.find((p) => p.provider === 'META')).toEqual({
        provider: 'META',
        traits: PROVIDER_TRAITS.META,
        capabilities: [],
        channels: [],
      });
    });

    it('returns an empty providers array when nothing is configured', async () => {
      svc.configuredProviders.mockReturnValue([]);

      const result = await controller.providers(ADMIN_REQ);

      expect(result).toEqual({ providers: [], disabledChannels: [] });
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

      const res = await controller.providers(ADMIN_REQ);
      const evo = res.providers.find((p) => p.provider === 'EVOLUTION');
      expect(evo?.traits).toEqual({ official: false, sessionBased: true, sessionWindow: false });
      // Valor literal esperado — não uma cópia ordenada do próprio resultado.
      expect(evo?.capabilities).toEqual(['campaignSend', 'statusPolling']);
    });
  });

  describe('GET /whatsapp/providers — disabledChannels por papel', () => {
    it('GET providers: ADMIN recebe disabledChannels do serviço', async () => {
      const disabled = [
        {
          id: 'g1',
          name: 'GBR',
          provider: 'GOZAP' as const,
          phoneE164: '+5592999990000',
          sectorNames: ['Logística'],
        },
      ];
      disabledChannels.listDisabled.mockResolvedValue(disabled);
      svc.configuredProviders.mockReturnValue(['EVOLUTION']);

      const result = await controller.providers(ADMIN_REQ);

      expect(result.disabledChannels).toEqual(disabled);
    });

    it.each(['SUPERVISOR', 'OPERATOR'])(
      'GET providers: %s recebe disabledChannels [] e o serviço nem é consultado',
      async (role) => {
        disabledChannels.listDisabled.mockResolvedValue([
          {
            id: 'g1',
            name: 'GBR',
            provider: 'GOZAP',
            phoneE164: null,
            sectorNames: [],
          },
        ]);
        svc.configuredProviders.mockReturnValue(['EVOLUTION']);

        const result = await controller.providers({
          user: { sub: 'u1', role },
        } as never);

        expect(result.disabledChannels).toEqual([]);
        expect(disabledChannels.listDisabled.mock.calls).toHaveLength(0);
      },
    );
  });

  describe('GET /whatsapp/providers — retorno antecipado com disabledChannels', () => {
    it('retorno antecipado sem providers: ADMIN ainda recebe disabledChannels não vazio', async () => {
      const disabled = [
        {
          id: 'g1',
          name: 'GBR',
          provider: 'GOZAP' as const,
          phoneE164: '+5592999990000',
          sectorNames: ['Logística'],
        },
      ];
      disabledChannels.listDisabled.mockResolvedValue(disabled);
      svc.configuredProviders.mockReturnValue([]);

      const result = await controller.providers(ADMIN_REQ);

      expect(result).toEqual({ providers: [], disabledChannels: disabled });
      expect(instancesRepo.listAll.mock.calls).toHaveLength(0);
    });
  });

  // R4: só a Evolution está ligada. Criar canal de outro provedor é 422
  // `channel.provider_disabled`, antes de qualquer outra checagem; EVOLUTION nasce
  // pelo fluxo de instância e segue com a recusa 400 de sempre.
  describe('POST /whatsapp/channels', () => {
    const body = (provider: string) =>
      ({ provider, name: 'Novo' }) as unknown as CreateChannelDto;

    it.each(['GOZAP', 'ZERNIO', 'TWILIO', 'META'])(
      'POST channels com provider %s → 422 channel.provider_disabled e nada é criado',
      (provider) => {
        // Mesmo com o registry sem o provedor (isProviderConfigured falso), o
        // erro é o 422 de desligado, não o 400 de "não configurado".
        svc.isProviderConfigured.mockReturnValue(false);

        expect(() => controller.createChannel(body(provider))).toThrow(
          expect.objectContaining({
            status: 422,
            code: 'channel.provider_disabled',
          }),
        );
        expect(
          instancesRepo.createOrReactivateCloudChannel.mock.calls,
        ).toHaveLength(0);
        expect(svc.isProviderConfigured).not.toHaveBeenCalled();
      },
    );

    it('POST channels com provider EVOLUTION → recusa 400 apontando o fluxo de instância', () => {
      expect(() => controller.createChannel(body('EVOLUTION'))).toThrow(
        expect.objectContaining({
          status: 400,
          code: 'channel.evolution_via_instance_flow',
        }),
      );
      expect(
        instancesRepo.createOrReactivateCloudChannel.mock.calls,
      ).toHaveLength(0);
    });
  });

  it('rotas removidas: zernio/accounts, channels/health e channels/:id/qr não existem mais', () => {
    const routes = routesOf(WhatsappProvidersController);

    expect(routes).not.toContain('GET /zernio/accounts');
    expect(routes).not.toContain('GET /channels/health');
    expect(routes).not.toContain('GET /channels/:id/qr');
    expect(routes).toContain('DELETE /channels/:id');
  });

  // C1 — associar áreas ao número é só do ADMIN (como conectar número).
  describe('PUT /whatsapp/channels/:id/sectors', () => {
    const guardFor = rolesGuardFor('setChannelSectors');

    it('SUPERVISOR e OPERATOR levam 403 pelo RolesGuard; ADMIN passa', () => {
      expect(guardFor('SUPERVISOR')).toThrow(
        expect.objectContaining({ status: 403 }),
      );
      expect(guardFor('OPERATOR')).toThrow(
        expect.objectContaining({ status: 403 }),
      );
      expect(guardFor('ADMIN')()).toBe(true);
    });

    it('repassa canal, áreas e o ADMIN que chamou, e devolve o resultado do serviço', async () => {
      const result = {
        channelId: 'c1',
        sectors: [{ id: 's1', name: 'Logística' }],
        moved: [{ sectorId: 's1', fromChannelId: 'c0' }],
      };
      sectorChannel.assign.mockResolvedValue(result);

      const res = await controller.setChannelSectors(
        'c1',
        { sectorIds: ['s1'] },
        ADMIN_REQ,
      );

      expect(sectorChannel.assign).toHaveBeenCalledWith({
        channelId: 'c1',
        sectorIds: ['s1'],
        actorId: 'admin-1',
      });
      expect(res).toBe(result);
    });
  });

  // R6/C4: remover um número de provedor desligado é só do ADMIN, responde 204 e
  // delega ao serviço com o id do usuário do token como autor.
  describe('DELETE /whatsapp/channels/:id', () => {
    const guardFor = rolesGuardFor('removeChannel');

    it('DELETE channels/:id exige ADMIN, responde 204 e delega a DisabledChannelsService.remove com actorId = req.user.sub', async () => {
      expect(guardFor('SUPERVISOR')).toThrow(
        expect.objectContaining({ status: 403 }),
      );
      expect(guardFor('OPERATOR')).toThrow(
        expect.objectContaining({ status: 403 }),
      );
      expect(guardFor('ADMIN')()).toBe(true);
      expect(
        Reflect.getMetadata(
          HTTP_CODE_METADATA,
          Reflect.get(
            WhatsappProvidersController.prototype,
            'removeChannel',
          ) as object,
        ),
      ).toBe(204);

      disabledChannels.remove.mockResolvedValue({
        channelId: 'gz-ch1',
        detachedSectorIds: [],
        failedMessages: 0,
      });

      await expect(
        controller.removeChannel('gz-ch1', ADMIN_REQ),
      ).resolves.toBeUndefined();

      expect(disabledChannels.remove.mock.calls).toEqual([
        [{ channelId: 'gz-ch1', actorId: 'admin-1' }],
      ]);
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
