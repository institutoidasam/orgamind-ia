import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockDeep, type MockProxy } from 'vitest-mock-extended';
import { ZernioTierSyncProcessor } from './zernio-tier-sync.processor';
import {
  ZernioAccountsService,
  type ZernioAccount,
} from './zernio-accounts.service';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { AuditService } from '../../shared/audit/audit.service';

function makeAccount(overrides: Partial<ZernioAccount> = {}): ZernioAccount {
  return {
    id: 'a1b2c3d4e5f6a7b8c9d0e1f2',
    displayName: 'Canal do Matheus - CONTINUUM',
    phoneE164: '+5592319979 92'.replace(/\s/g, ''),
    wabaId: '1015066594463529',
    qualityRating: 'GREEN',
    messagingLimitTier: 'TIER_2K',
    nameStatus: 'DECLINED',
    ...overrides,
  };
}

function makeChannel(overrides: Record<string, unknown> = {}) {
  return {
    id: 'chan-zr',
    provider: 'ZERNIO',
    zernioAccountId: 'a1b2c3d4e5f6a7b8c9d0e1f2',
    phoneE164: '+5592319979 92'.replace(/\s/g, ''),
    dailySendLimit: 250,
    qualityRating: 'GREEN',
    isActive: true,
    ...overrides,
  } as never;
}

describe('ZernioTierSyncProcessor', () => {
  let prisma: MockProxy<PrismaService>;
  let accounts: { configured: boolean; listAccounts: ReturnType<typeof vi.fn> };
  let audit: MockProxy<AuditService>;
  let campaigns: { cancel: ReturnType<typeof vi.fn> };
  let proc: ZernioTierSyncProcessor;

  beforeEach(() => {
    prisma = mockDeep<PrismaService>();
    accounts = {
      configured: true,
      listAccounts: vi.fn().mockResolvedValue([]),
    };
    audit = mockDeep<AuditService>();
    campaigns = { cancel: vi.fn().mockResolvedValue(undefined) };
    proc = new ZernioTierSyncProcessor(
      accounts as unknown as ZernioAccountsService,
      prisma,
      audit,
      campaigns as never,
    );
    prisma.channel.findMany.mockResolvedValue([] as never);
    prisma.campaign.findMany.mockResolvedValue([] as never);
  });

  it('no-op quando a credencial do Zernio não está configurada', async () => {
    accounts.configured = false;
    await proc.process();
    expect(accounts.listAccounts).not.toHaveBeenCalled();
    expect(prisma.channel.findMany).not.toHaveBeenCalled();
  });

  it('só considera canais ZERNIO ativos (filtro do findMany)', async () => {
    accounts.listAccounts.mockResolvedValue([makeAccount()]);

    await proc.process();

    expect(prisma.channel.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ provider: 'ZERNIO', isActive: true }),
      }),
    );
  });

  // ZC — o `profileId` é OBRIGATÓRIO no `POST /broadcasts` e os canais criados
  // antes do campo estão com NULL. Este job já lê `GET /accounts` (onde o
  // profileId vive) toda rodada — o backfill sai de graça, e sem ele a campanha
  // nativa do Zernio falharia justamente nos canais antigos.
  it('faz backfill do zernioProfileId nos canais que ainda não o têm', async () => {
    prisma.channel.findMany.mockResolvedValue([
      makeChannel({ dailySendLimit: 2000, zernioProfileId: null }),
    ] as never);
    accounts.listAccounts.mockResolvedValue([
      makeAccount({ profileId: 'a1b2c3d4e5f6a7b8c9d00001' }),
    ]);

    await proc.process();

    expect(prisma.channel.update).toHaveBeenCalledWith({
      where: { id: 'chan-zr' },
      data: { zernioProfileId: 'a1b2c3d4e5f6a7b8c9d00001' },
    });
  });

  it('não reescreve o zernioProfileId quando já está correto', async () => {
    prisma.channel.findMany.mockResolvedValue([
      makeChannel({
        dailySendLimit: 2000,
        zernioProfileId: 'a1b2c3d4e5f6a7b8c9d00001',
      }),
    ] as never);
    accounts.listAccounts.mockResolvedValue([
      makeAccount({ profileId: 'a1b2c3d4e5f6a7b8c9d00001' }),
    ]);

    await proc.process();

    expect(prisma.channel.update).not.toHaveBeenCalled();
  });

  // O casamento é por zernioAccountId (o `_id` do Zernio), NUNCA por telefone:
  // o telefone da Meta vem formatado e um canal pode nem tê-lo preenchido.
  it('casa canal × conta pelo zernioAccountId e atualiza dailySendLimit + audit', async () => {
    prisma.channel.findMany.mockResolvedValue([makeChannel()] as never);
    accounts.listAccounts.mockResolvedValue([makeAccount()]); // TIER_2K → 2000 ≠ 250

    await proc.process();

    expect(prisma.channel.update).toHaveBeenCalledWith({
      where: { id: 'chan-zr' },
      data: { dailySendLimit: 2000 },
    });
    expect(audit.log).toHaveBeenCalledWith(
      'channel.tier_sync',
      'Channel',
      'chan-zr',
      expect.objectContaining({
        previousLimit: 250,
        newLimit: 2000,
        messagingLimitTier: 'TIER_2K',
        qualityRating: 'GREEN',
        zernioAccountId: 'a1b2c3d4e5f6a7b8c9d0e1f2',
      }),
    );
  });

  it.each([
    ['TIER_50', 50],
    ['TIER_250', 250],
    ['TIER_1K', 1000],
    ['TIER_2K', 2000],
    ['TIER_10K', 10000],
    ['TIER_100K', 100000],
    ['TIER_UNLIMITED', 1000000],
  ])('mapeia %s → dailySendLimit %i', async (tier, expected) => {
    prisma.channel.findMany.mockResolvedValue([
      makeChannel({ dailySendLimit: 1 }),
    ] as never);
    accounts.listAccounts.mockResolvedValue([
      makeAccount({ messagingLimitTier: tier }),
    ]);

    await proc.process();

    expect(prisma.channel.update).toHaveBeenCalledWith({
      where: { id: 'chan-zr' },
      data: { dailySendLimit: expected },
    });
  });

  it.each(['TIER_5K', undefined])(
    'tier desconhecido/ausente (%s) → NÃO mexe no canal',
    async (tier) => {
      prisma.channel.findMany.mockResolvedValue([makeChannel()] as never);
      accounts.listAccounts.mockResolvedValue([
        makeAccount({ messagingLimitTier: tier }),
      ]);

      await proc.process();

      expect(prisma.channel.update).not.toHaveBeenCalled();
      expect(audit.log).not.toHaveBeenCalled();
    },
  );

  it('NÃO atualiza quando o limite já é o mesmo (sem update, sem audit)', async () => {
    prisma.channel.findMany.mockResolvedValue([
      makeChannel({ dailySendLimit: 2000 }),
    ] as never);
    accounts.listAccounts.mockResolvedValue([makeAccount()]);

    await proc.process();

    expect(prisma.channel.update).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });

  it('canal sem conta correspondente no Zernio → não mexe', async () => {
    prisma.channel.findMany.mockResolvedValue([
      makeChannel({ zernioAccountId: 'conta-que-sumiu' }),
    ] as never);
    accounts.listAccounts.mockResolvedValue([makeAccount()]);

    await proc.process();

    expect(prisma.channel.update).not.toHaveBeenCalled();
  });

  it('falha ao atualizar UM canal não aborta os demais', async () => {
    prisma.channel.findMany.mockResolvedValue([
      makeChannel(),
      makeChannel({ id: 'chan-zr2', zernioAccountId: 'conta-2' }),
    ] as never);
    accounts.listAccounts.mockResolvedValue([
      makeAccount(),
      makeAccount({ id: 'conta-2', messagingLimitTier: 'TIER_10K' }),
    ]);
    prisma.channel.update
      .mockRejectedValueOnce(new Error('db blip'))
      .mockResolvedValueOnce({});

    await expect(proc.process()).resolves.not.toThrow();

    expect(prisma.channel.update).toHaveBeenCalledTimes(2);
    expect(prisma.channel.update).toHaveBeenLastCalledWith({
      where: { id: 'chan-zr2' },
      data: { dailySendLimit: 10000 },
    });
  });

  // O qualityRating é persistido para que a PRÓXIMA rodada possa detectar a
  // transição (é a transição que dispara o kill-switch de qualidade).
  it('persiste o qualityRating quando ele muda, mesmo sem mudança de tier', async () => {
    prisma.channel.findMany.mockResolvedValue([
      makeChannel({ dailySendLimit: 2000, qualityRating: null }),
    ] as never);
    accounts.listAccounts.mockResolvedValue([makeAccount()]);

    await proc.process();

    expect(prisma.channel.update).toHaveBeenCalledWith({
      where: { id: 'chan-zr' },
      data: { qualityRating: 'GREEN' },
    });
  });
});

// ── ZA3: kill-switch de QUALIDADE ────────────────────────────────────────────
// O qualityRating da Meta é calculado sobre bloqueios e denúncias dos
// DESTINATÁRIOS nos últimos 7 dias. Sair de GREEN é o aviso que precede a queda
// de tier e a restrição da conta — e o número do cliente acabou de SUBIR para
// GREEN. Continuar disparando sobre um número em YELLOW/RED é a maneira mais
// rápida de perdê-lo: as campanhas ativas daquele canal são canceladas (o mesmo
// mecanismo do kill-switch de template) + audit.
describe('ZernioTierSyncProcessor — queda de qualityRating (ZA3)', () => {
  let prisma: MockProxy<PrismaService>;
  let accounts: { configured: boolean; listAccounts: ReturnType<typeof vi.fn> };
  let audit: MockProxy<AuditService>;
  let campaigns: { cancel: ReturnType<typeof vi.fn> };
  let proc: ZernioTierSyncProcessor;

  beforeEach(() => {
    prisma = mockDeep<PrismaService>();
    accounts = {
      configured: true,
      listAccounts: vi.fn().mockResolvedValue([]),
    };
    audit = mockDeep<AuditService>();
    campaigns = { cancel: vi.fn().mockResolvedValue(undefined) };
    proc = new ZernioTierSyncProcessor(
      accounts as unknown as ZernioAccountsService,
      prisma,
      audit,
      campaigns as never,
    );
    prisma.channel.findMany.mockResolvedValue([
      makeChannel({ dailySendLimit: 2000, qualityRating: 'GREEN' }),
    ] as never);
    prisma.campaign.findMany.mockResolvedValue([
      { id: 'camp-1' },
      { id: 'camp-2' },
    ] as never);
  });

  it('GREEN → RED: pausa (cancela) as campanhas ativas do canal + audit', async () => {
    accounts.listAccounts.mockResolvedValue([
      makeAccount({ qualityRating: 'RED' }),
    ]);

    await proc.process();

    // Só as campanhas ATIVAS daquele canal.
    expect(prisma.campaign.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          defaultInstanceId: 'chan-zr',
          status: { in: ['RUNNING', 'QUEUED'] },
        }),
      }),
    );
    expect(campaigns.cancel).toHaveBeenCalledWith('camp-1');
    expect(campaigns.cancel).toHaveBeenCalledWith('camp-2');
    expect(audit.log).toHaveBeenCalledWith(
      'channel.quality_drop',
      'Channel',
      'chan-zr',
      expect.objectContaining({
        previousQualityRating: 'GREEN',
        qualityRating: 'RED',
        pausedCampaigns: ['camp-1', 'camp-2'],
      }),
    );
    // E o novo estado fica persistido (senão a próxima rodada re-dispararia).
    expect(prisma.channel.update).toHaveBeenCalledWith({
      where: { id: 'chan-zr' },
      data: { qualityRating: 'RED' },
    });
  });

  it.each(['YELLOW', 'FLAGGED'])(
    'GREEN → %s também pausa as campanhas (é a TRANSIÇÃO que importa, não só RED)',
    async (rating) => {
      accounts.listAccounts.mockResolvedValue([
        makeAccount({ qualityRating: rating }),
      ]);

      await proc.process();

      expect(campaigns.cancel).toHaveBeenCalledTimes(2);
    },
  );

  it('já estava RED e continua RED → NÃO re-dispara (sem cancelamento novo)', async () => {
    prisma.channel.findMany.mockResolvedValue([
      makeChannel({ dailySendLimit: 2000, qualityRating: 'RED' }),
    ] as never);
    accounts.listAccounts.mockResolvedValue([
      makeAccount({ qualityRating: 'RED' }),
    ]);

    await proc.process();

    expect(campaigns.cancel).not.toHaveBeenCalled();
  });

  it('GREEN → GREEN não pausa nada', async () => {
    accounts.listAccounts.mockResolvedValue([makeAccount()]); // GREEN

    await proc.process();

    expect(campaigns.cancel).not.toHaveBeenCalled();
    expect(prisma.campaign.findMany).not.toHaveBeenCalled();
  });

  it('RED → GREEN (recuperação) não pausa nada', async () => {
    prisma.channel.findMany.mockResolvedValue([
      makeChannel({ dailySendLimit: 2000, qualityRating: 'RED' }),
    ] as never);
    accounts.listAccounts.mockResolvedValue([makeAccount()]); // GREEN

    await proc.process();

    expect(campaigns.cancel).not.toHaveBeenCalled();
  });

  it('falha ao cancelar UMA campanha não impede o cancelamento das demais', async () => {
    accounts.listAccounts.mockResolvedValue([
      makeAccount({ qualityRating: 'RED' }),
    ]);
    campaigns.cancel
      .mockRejectedValueOnce(new Error('db blip'))
      .mockResolvedValueOnce(undefined);

    await expect(proc.process()).resolves.not.toThrow();

    expect(campaigns.cancel).toHaveBeenCalledTimes(2);
  });
});
