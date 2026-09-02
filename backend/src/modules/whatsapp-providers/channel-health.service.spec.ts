import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockDeep, MockProxy } from 'vitest-mock-extended';
import { ChannelHealthService } from './channel-health.service';
import { ZernioAccountsService } from './zernio-accounts.service';
import { PrismaService } from '../../shared/prisma/prisma.service';

/** Um canal ZERNIO ativo, como o Prisma o devolve (só os campos usados). */
function channel(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ch_1',
    name: 'Canal do Matheus',
    provider: 'ZERNIO',
    isActive: true,
    zernioAccountId: 'acc_1',
    phoneE164: '+5592315550101',
    dailySendLimit: 2000,
    qualityRating: 'GREEN',
    ...overrides,
  };
}

describe('ChannelHealthService', () => {
  let prisma: MockProxy<PrismaService>;
  let accounts: MockProxy<ZernioAccountsService>;
  let service: ChannelHealthService;

  beforeEach(() => {
    prisma = mockDeep<PrismaService>();
    accounts = mockDeep<ZernioAccountsService>();
    // `configured` é readonly na classe — o mock precisa do valor explícito, e
    // configurable para que um teste possa desligá-lo.
    Object.defineProperty(accounts, 'configured', {
      value: true,
      configurable: true,
    });
    prisma.channel.findMany.mockResolvedValue([channel()] as never);
    prisma.message.groupBy.mockResolvedValue([] as never);
    accounts.listAccounts.mockResolvedValue([]);
    accounts.fetchNumberInfo.mockResolvedValue(null);
    service = new ChannelHealthService(prisma, accounts);
  });

  it('devolve a saúde do number-info: tier, qualidade, nameStatus e can_send_message', async () => {
    accounts.fetchNumberInfo.mockResolvedValue({
      accountId: 'acc_1',
      displayPhoneNumber: '+55 92 3155-0101',
      messagingLimitTier: 'TIER_2K',
      qualityRating: 'GREEN',
      nameStatus: 'DECLINED',
      nameRejectionReason: 'BIZ_COMMERCE_VIOLATION_OTHER',
      canSendMessage: 'LIMITED',
      canSendMessageReason: 'Your display name has not been approved yet.',
    });

    const { channels } = await service.list();

    expect(channels).toHaveLength(1);
    expect(channels[0]).toMatchObject({
      channelId: 'ch_1',
      channelName: 'Canal do Matheus',
      provider: 'ZERNIO',
      messagingLimitTier: 'TIER_2K',
      tierLimit: 2000,
      qualityRating: 'GREEN',
      nameStatus: 'DECLINED',
      nameRejectionReason: 'BIZ_COMMERCE_VIOLATION_OTHER',
      canSendMessage: 'LIMITED',
      canSendMessageReason: 'Your display name has not been approved yet.',
      displayPhoneNumber: '+55 92 3155-0101',
      stale: false,
    });
    expect(channels[0].syncedAt).toBeInstanceOf(Date);
  });

  // O teto da Meta conta usuários ÚNICOS em 24h ROLANTES — a MESMA contagem que
  // a guarda rolante do send-message.processor faz antes de cada envio. O card
  // mostra o mesmo número que a guarda usa para BLOQUEAR, senão o operador vê um
  // teto e bate noutro.
  it('conta destinatários ÚNICOS nas últimas 24h (não mensagens)', async () => {
    prisma.message.groupBy.mockResolvedValue([
      { contactId: 'c1' },
      { contactId: 'c2' },
      { contactId: 'c3' },
    ] as never);

    const { channels } = await service.list();

    expect(channels[0].uniqueRecipients24h).toBe(3);
    const where = (prisma.message.groupBy as unknown as ReturnType<typeof vi.fn>)
      .mock.calls[0][0];
    expect(where).toMatchObject({
      by: ['contactId'],
      where: {
        instanceId: 'ch_1',
        direction: 'OUTBOUND',
        contactId: { not: null },
      },
    });
  });

  // >80% do teto = a hora de parar de enfileirar. Passar do teto faz a Meta
  // rejeitar em massa → o quality rating despenca → o tier CAI. O alerta tem de
  // aparecer ANTES do estouro, não depois.
  it.each([
    [1599, 2000, false, 79],
    [1600, 2000, true, 80],
    [1900, 2000, true, 95],
    [2000, 2000, true, 100],
  ])(
    '%i/%i destinatários → nearTierLimit=%s (%i%%)',
    async (used, limit, expected, pct) => {
      prisma.channel.findMany.mockResolvedValue([
        channel({ dailySendLimit: limit }),
      ] as never);
      prisma.message.groupBy.mockResolvedValue(
        Array.from({ length: used }, (_, i) => ({ contactId: `c${i}` })) as never,
      );
      accounts.fetchNumberInfo.mockResolvedValue({
        accountId: 'acc_1',
        messagingLimitTier: 'TIER_2K',
      });

      const { channels } = await service.list();

      expect(channels[0].nearTierLimit).toBe(expected);
      expect(channels[0].tierUsagePct).toBe(pct);
    },
  );

  // Tier desconhecido (a Meta vai APOSENTAR TIER_2K/10K no Q2/2026) → o teto do
  // canal (dailySendLimit) prevalece, e a barra continua fazendo sentido. Nunca
  // dividir por zero nem inventar um teto.
  it('tier ausente/desconhecido → cai no dailySendLimit do canal', async () => {
    accounts.fetchNumberInfo.mockResolvedValue({
      accountId: 'acc_1',
      messagingLimitTier: 'TIER_QUALQUER_COISA_NOVA',
    });

    const { channels } = await service.list();

    expect(channels[0].tierLimit).toBe(2000);
  });

  // number-info fora do ar não pode apagar a saúde da tela: `GET /accounts` já
  // traz tier/qualidade/nameStatus em `metadata`. Só o `can_send_message` se
  // perde — e o card marca `stale` para o operador saber que a leitura é a de
  // trás.
  it('number-info indisponível → degrada para o metadata de GET /accounts', async () => {
    accounts.fetchNumberInfo.mockResolvedValue(null);
    accounts.listAccounts.mockResolvedValue([
      {
        id: 'acc_1',
        displayName: 'Matheus',
        phoneE164: '+5592315550101',
        messagingLimitTier: 'TIER_2K',
        qualityRating: 'GREEN',
        nameStatus: 'DECLINED',
      },
    ]);

    const { channels } = await service.list();

    expect(channels[0]).toMatchObject({
      messagingLimitTier: 'TIER_2K',
      qualityRating: 'GREEN',
      nameStatus: 'DECLINED',
      tierLimit: 2000,
      canSendMessage: undefined,
      stale: true,
    });
  });

  // Zernio inteiramente fora do ar: sobra o que o tier-sync gravou no canal.
  // Melhor um dado velho e ROTULADO como velho do que uma tela vazia.
  it('Zernio fora do ar → usa o que está persistido no canal, marcado como stale', async () => {
    accounts.fetchNumberInfo.mockResolvedValue(null);
    accounts.listAccounts.mockRejectedValue(new Error('ECONNREFUSED'));

    const { channels } = await service.list();

    expect(channels[0]).toMatchObject({
      qualityRating: 'GREEN', // Channel.qualityRating, gravado pelo tier-sync
      tierLimit: 2000, // Channel.dailySendLimit
      stale: true,
    });
  });

  it('sem credencial Zernio → lista vazia, sem chamar a API', async () => {
    Object.defineProperty(accounts, 'configured', {
      value: false,
      configurable: true,
    });

    const { channels } = await service.list();

    expect(channels).toEqual([]);
    expect(accounts.fetchNumberInfo).not.toHaveBeenCalled();
    expect(accounts.listAccounts).not.toHaveBeenCalled();
  });

  // Um canal a meio da configuração (sem accountId) não tem o que consultar —
  // e a query do `GET /accounts` custa balde de rate limit.
  it('ignora canais ZERNIO sem zernioAccountId', async () => {
    prisma.channel.findMany.mockResolvedValue([
      channel({ zernioAccountId: null }),
    ] as never);

    const { channels } = await service.list();

    expect(channels).toEqual([]);
    expect(accounts.fetchNumberInfo).not.toHaveBeenCalled();
  });
});
