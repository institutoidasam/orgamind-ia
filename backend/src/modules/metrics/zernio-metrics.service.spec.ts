import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mockDeep, type MockProxy } from 'vitest-mock-extended';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { ZernioMetricsService } from './zernio-metrics.service';

const CHANNEL = 'ch1';

/** O disparo REAL do painel do Zernio (capturado ao vivo). */
const PANEL_BROADCAST = {
  id: 'row1',
  zernioId: 'a1b2c3d4e5f6a7b8c9d00004',
  channelId: CHANNEL,
  campaignId: null, // ← painel do Zernio
  name: 'Primeira Campanha',
  status: 'completed',
  templateName: 'bem_vindo_mg',
  messagePreview: 'Template: bem_vindo_mg',
  recipientCount: 120,
  sentCount: 2,
  deliveredCount: 10,
  readCount: 71,
  failedCount: 37,
  skippedCount: 0,
  startedAt: new Date('2026-07-11T22:00:28.573Z'),
  completedAt: new Date('2026-07-11T22:09:04.516Z'),
  zernioCreatedAt: new Date('2026-07-11T21:59:01.784Z'),
};

describe('ZernioMetricsService', () => {
  let prisma: MockProxy<PrismaService>;
  let service: ZernioMetricsService;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-12T15:00:00Z'));

    prisma = mockDeep<PrismaService>();
    prisma.channel.findMany.mockResolvedValue([
      { id: CHANNEL, name: 'Canal MG', phoneE164: '+5592319979 92' },
    ] as never);
    prisma.zernioBroadcast.findMany.mockResolvedValue([PANEL_BROADCAST] as never);
    prisma.zernioAnalyticsSnapshot.findMany.mockResolvedValue([
      { channelId: CHANNEL, sent: 121, received: 18, read: 68, failed: 0 },
      { channelId: CHANNEL, sent: 0, received: 5, read: 4, failed: 0 },
    ] as never);
    prisma.message.groupBy.mockResolvedValue([] as never);

    service = new ZernioMetricsService(prisma);
  });

  afterEach(() => vi.useRealTimers());

  it('marca o disparo SEM campanha como vindo do PAINEL do Zernio', async () => {
    const res = await service.getMetrics(30);

    const b = res.channels[0].broadcasts[0];
    expect(b.origin).toBe('ZERNIO_PANEL');
    expect(res.channels[0].totals.fromZernioPanel).toBe(1);
    expect(res.channels[0].totals.fromPicoa).toBe(0);
  });

  it('marca como ORGAMIND o disparo vinculado a uma campanha daqui', async () => {
    prisma.zernioBroadcast.findMany.mockResolvedValue([
      { ...PANEL_BROADCAST, campaignId: 'camp1' },
    ] as never);

    const res = await service.getMetrics(30);

    expect(res.channels[0].broadcasts[0].origin).toBe('ORGAMIND');
    expect(res.channels[0].totals.fromPicoa).toBe(1);
    expect(res.channels[0].totals.fromZernioPanel).toBe(0);
  });

  it('ENTREGUES = delivered + read (os contadores são partição, não funil)', async () => {
    const res = await service.getMetrics(30);

    const b = res.channels[0].broadcasts[0];
    // 10 entregues + 71 lidas = 81 chegaram ao aparelho. Quem leu, recebeu.
    expect(b.reachedCount).toBe(81);
    // 81/120 = 67,5% — e NÃO 10/2 = 500%, que é o que `delivered/sent` daria.
    expect(b.deliveryRate).toBeCloseTo(67.5, 1);
    expect(b.readRate).toBeCloseTo(59.17, 1); // 71/120
  });

  it('disparo do ORGAMIND já é funil (webhook) — a lida NÃO conta duas vezes', async () => {
    // Contadores REAIS de prod (13/07): o webhook grava um funil cumulativo
    // (sent ⊇ delivered ⊇ read — ver zernio-broadcast-counters.ts). Somar
    // delivered + read aqui contaria as 31 lidas duas vezes: (38+31)/45 dava
    // os 153,3% de "entrega" que apareceram na tela.
    prisma.zernioBroadcast.findMany.mockResolvedValue([
      {
        ...PANEL_BROADCAST,
        campaignId: 'camp1', // ← disparo do orgamind
        recipientCount: 45,
        sentCount: 39,
        deliveredCount: 38,
        readCount: 31,
        failedCount: 6,
      },
    ] as never);

    const res = await service.getMetrics(30);

    const b = res.channels[0].broadcasts[0];
    expect(b.reachedCount).toBe(38); // as 31 lidas JÁ estão nas 38 entregues
    expect(b.deliveryRate).toBeCloseTo(84.4, 1); // 38/45 — nunca 153%
    expect(b.readRate).toBeCloseTo(68.9, 1); // 31/45
    expect(b.sentCount).toBe(39); // funil não é re-somado
  });

  it('a linha do painel vira funil na resposta: enviadas = tudo que saiu', async () => {
    const res = await service.getMetrics(30);

    const b = res.channels[0].broadcasts[0];
    // Partição do Zernio (2 sent + 10 delivered + 71 read) → funil:
    // 83 saíram, 81 chegaram, 71 leram. Uma tabela com "Enviadas 2" ao lado
    // de "Entregues 81" não é um número, é uma charada.
    expect(b.sentCount).toBe(83);
    expect(b.deliveredCount).toBe(81);
    expect(b.readCount).toBe(71);
  });

  it('total do canal soma funil com funil — sem misturar as semânticas', async () => {
    prisma.zernioBroadcast.findMany.mockResolvedValue([
      PANEL_BROADCAST, // painel: partição 2/10/71 → funil 83/81/71
      {
        ...PANEL_BROADCAST,
        id: 'row2',
        zernioId: 'b2',
        campaignId: 'camp1', // orgamind: já é funil 39/38/31
        recipientCount: 45,
        sentCount: 39,
        deliveredCount: 38,
        readCount: 31,
        failedCount: 6,
      },
    ] as never);

    const res = await service.getMetrics(30);

    const t = res.channels[0].totals;
    expect(t.reachedCount).toBe(119); // 81 (painel) + 38 (orgamind)
    expect(t.deliveryRate).toBeCloseTo(72.1, 1); // 119/165
    // O total geral repete a mesma conta.
    expect(res.totals.reachedCount).toBe(119);
    expect(res.totals.deliveryRate).toBeCloseTo(72.1, 1);
  });

  it('linha órfã de campanha apagada (convertida para partição no delete) mantém as taxas', async () => {
    // O delete da campanha faz SetNull no campaignId E converte os contadores
    // funil→partição no mesmo commit (CampaignsRepository.delete). Esta é a
    // outra metade do contrato: a linha órfã, agora lida como painel, tem de
    // reproduzir as MESMAS taxas de quando era funil do orgamind — 38/45 = 84,4%,
    // nunca os 153% do double-count.
    prisma.zernioBroadcast.findMany.mockResolvedValue([
      {
        ...PANEL_BROADCAST,
        campaignId: null, // órfã pós-delete
        recipientCount: 45,
        sentCount: 1, // partição: funnelToPartition({39,38,31,6})
        deliveredCount: 7,
        readCount: 31,
        failedCount: 6,
      },
    ] as never);

    const res = await service.getMetrics(30);

    const b = res.channels[0].broadcasts[0];
    expect(b.origin).toBe('ZERNIO_PANEL');
    expect(b.reachedCount).toBe(38); // 7 + 31 — o funil reconstituído
    expect(b.deliveryRate).toBeCloseTo(84.4, 1);
    expect(b.sentCount).toBe(39); // 1 + 7 + 31
  });

  it('taxa é null (não 0%) quando o disparo não tem destinatário', async () => {
    prisma.zernioBroadcast.findMany.mockResolvedValue([
      {
        ...PANEL_BROADCAST,
        recipientCount: 0,
        sentCount: 0,
        deliveredCount: 0,
        readCount: 0,
        failedCount: 0,
      },
    ] as never);

    const res = await service.getMetrics(30);

    // "0%" leria como "falhou tudo"; a verdade é "não há denominador".
    expect(res.channels[0].broadcasts[0].deliveryRate).toBeNull();
  });

  it('soma os contadores no total do canal e no total geral', async () => {
    prisma.zernioBroadcast.findMany.mockResolvedValue([
      PANEL_BROADCAST,
      { ...PANEL_BROADCAST, id: 'row2', zernioId: 'b2', recipientCount: 1, deliveredCount: 1, sentCount: 0, readCount: 0, failedCount: 0 },
    ] as never);

    const res = await service.getMetrics(30);

    expect(res.totals.broadcasts).toBe(2);
    expect(res.totals.recipientCount).toBe(121);
    expect(res.totals.reachedCount).toBe(82); // (10+71) + 1
    expect(res.totals.failedCount).toBe(37);
  });

  it('traz o volume do Zernio somado no período (snapshots diários)', async () => {
    const res = await service.getMetrics(30);

    expect(res.channels[0].volume).toEqual({
      sent: 121,
      received: 23, // 18 + 5
      read: 72, // 68 + 4
      failed: 0,
    });
  });

  it('volume é null quando o snapshot diário ainda não rodou', async () => {
    prisma.zernioAnalyticsSnapshot.findMany.mockResolvedValue([] as never);

    const res = await service.getMetrics(30);

    expect(res.channels[0].volume).toBeNull();
  });

  it('conta o que o ORGAMIND enviou (Message) — a diferença para o volume é o que saiu por fora', async () => {
    prisma.message.groupBy.mockResolvedValue([
      { instanceId: CHANNEL, _count: { _all: 15 } },
    ] as never);

    const res = await service.getMetrics(30);

    // O Zernio viu 121 saírem do número; o orgamind disparou 15 → 106 saíram do
    // painel. É exatamente o ponto cego que a tela mostra.
    expect(res.channels[0].picoaSent).toBe(15);
    expect(res.channels[0].volume?.sent).toBe(121);
  });

  it('a janela do período vira o filtro de data (30 dias)', async () => {
    await service.getMetrics(30);

    const where = prisma.zernioBroadcast.findMany.mock.calls[0][0]?.where as {
      zernioCreatedAt: { gte: Date };
    };
    expect(where.zernioCreatedAt.gte).toEqual(new Date('2026-06-12T15:00:00.000Z'));
    expect(prisma.zernioBroadcast.findMany.mock.calls[0][0]?.orderBy).toEqual({
      zernioCreatedAt: 'desc',
    });
  });

  it('canal ZERNIO sem nenhum disparo aparece na lista (zerado), não some', async () => {
    prisma.zernioBroadcast.findMany.mockResolvedValue([] as never);
    prisma.zernioAnalyticsSnapshot.findMany.mockResolvedValue([] as never);

    const res = await service.getMetrics(30);

    expect(res.channels).toHaveLength(1);
    expect(res.channels[0].totals.broadcasts).toBe(0);
    expect(res.channels[0].broadcasts).toEqual([]);
  });
});
