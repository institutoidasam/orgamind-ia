import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mockDeep, type MockProxy } from 'vitest-mock-extended';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { ZernioAnalyticsSyncService } from './zernio-analytics-sync.service';
import type { ZernioAnalyticsClient } from './zernio-analytics.client';

const CHANNEL = 'ch1';
const ACCOUNT = 'a1b2c3d4e5f6a7b8c9d0e1f2';

/** O volume real capturado ao vivo na conta do cliente. */
const LIVE_VOLUME = {
  summary: { sent: 121, received: 23, read: 72, failed: 0, uniqueConversations: 16 },
  timeseries: [
    { date: '2026-07-11', sent: 121, received: 18, read: 68, failed: 0 },
    { date: '2026-07-12', sent: 0, received: 3, read: 4, failed: 0 },
  ],
};

describe('ZernioAnalyticsSyncService', () => {
  let prisma: MockProxy<PrismaService>;
  let client: MockProxy<ZernioAnalyticsClient>;
  let service: ZernioAnalyticsSyncService;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-12T15:00:00Z'));

    prisma = mockDeep<PrismaService>();
    client = mockDeep<ZernioAnalyticsClient>();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).configured = true;

    prisma.channel.findMany.mockResolvedValue([
      { id: CHANNEL, zernioAccountId: ACCOUNT },
    ] as never);
    prisma.campaign.findFirst.mockResolvedValue(null as never);
    prisma.zernioAnalyticsSnapshot.upsert.mockResolvedValue({} as never);
    client.getInboxVolume.mockResolvedValue(LIVE_VOLUME);

    service = new ZernioAnalyticsSyncService(prisma, client);
  });

  afterEach(() => vi.useRealTimers());

  it('grava um snapshot POR DIA do timeseries, com upsert por (canal, dia)', async () => {
    const res = await service.syncSnapshots();

    expect(res.days).toBe(2);
    const first = prisma.zernioAnalyticsSnapshot.upsert.mock.calls[0][0];
    expect(first.where).toEqual({
      channelId_day: { channelId: CHANNEL, day: new Date('2026-07-11T00:00:00.000Z') },
    });
    expect(first.update).toMatchObject({
      sent: 121,
      received: 18,
      read: 68,
      failed: 0,
    });
    expect(first.create).toMatchObject({ channelId: CHANNEL, sent: 121 });
  });

  it('é idempotente: reescreve o dia em vez de duplicá-lo (o dia de HOJE ainda muda)', async () => {
    await service.syncSnapshots();
    await service.syncSnapshots();

    // 2 dias × 2 execuções = 4 upserts, e nenhum `create` solto.
    expect(prisma.zernioAnalyticsSnapshot.upsert).toHaveBeenCalledTimes(4);
    expect(prisma.zernioAnalyticsSnapshot.create).not.toHaveBeenCalled();
  });

  it('pede a janela dos últimos 7 dias (o `read` chega atrasado — reler o passado recente é o ponto)', async () => {
    await service.syncSnapshots();

    expect(client.getInboxVolume).toHaveBeenCalledWith(
      CHANNEL,
      ACCOUNT,
      '2026-07-06', // hoje (12) − 6
      '2026-07-12',
    );
  });

  it('respeita uma janela maior quando pedida (backfill)', async () => {
    await service.syncSnapshots({ days: 30 });

    expect(client.getInboxVolume).toHaveBeenCalledWith(
      CHANNEL,
      ACCOUNT,
      '2026-06-13',
      '2026-07-12',
    );
  });

  it('CEDE o balde quando há campanha ativa', async () => {
    prisma.campaign.findFirst.mockResolvedValue({ id: 'camp1' } as never);

    const res = await service.syncSnapshots();

    expect(client.getInboxVolume).not.toHaveBeenCalled();
    expect(res.paused).toBe(true);
  });

  it('um canal que falha não derruba os outros', async () => {
    prisma.channel.findMany.mockResolvedValue([
      { id: 'chA', zernioAccountId: 'accA' },
      { id: 'chB', zernioAccountId: 'accB' },
    ] as never);
    client.getInboxVolume
      .mockRejectedValueOnce(new Error('429 teimoso'))
      .mockResolvedValueOnce(LIVE_VOLUME);

    const res = await service.syncSnapshots();

    expect(res.failed).toBe(1);
    expect(res.days).toBe(2); // os do canal que respondeu
  });

  it('sem canal ZERNIO ativo NÃO fala com o Zernio', async () => {
    prisma.channel.findMany.mockResolvedValue([] as never);

    const res = await service.syncSnapshots();

    expect(client.getInboxVolume).not.toHaveBeenCalled();
    expect(res.reason).toMatch(/canal/i);
  });

  it('sem ZERNIO_API_KEY vira no-op', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).configured = false;

    const res = await service.syncSnapshots();

    expect(client.getInboxVolume).not.toHaveBeenCalled();
    expect(res.reason).toMatch(/ZERNIO_API_KEY/);
  });
});
