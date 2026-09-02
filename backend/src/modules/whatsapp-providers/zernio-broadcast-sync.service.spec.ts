import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockDeep, type MockProxy } from 'vitest-mock-extended';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { ZernioBroadcastSyncService } from './zernio-broadcast-sync.service';
import type {
  ZernioAnalyticsClient,
  ZernioBroadcastItem,
} from './zernio-analytics.client';

const CHANNEL = 'ch1';
const ACCOUNT = 'a1b2c3d4e5f6a7b8c9d0e1f2';

/** O disparo real capturado ao vivo na conta do cliente. */
function broadcast(over: Partial<ZernioBroadcastItem> = {}): ZernioBroadcastItem {
  return {
    id: 'b-live',
    accountId: ACCOUNT,
    accountName: 'Matheus Garcia',
    platform: 'whatsapp',
    name: 'Primeira Campanha',
    status: 'completed',
    messagePreview: 'Template: bem_vindo_mg',
    templateName: 'bem_vindo_mg',
    scheduledAt: '2026-07-11T22:10:00.000Z',
    startedAt: '2026-07-11T22:00:28.573Z',
    completedAt: '2026-07-11T22:09:04.516Z',
    createdAt: '2026-07-11T21:59:01.784Z',
    recipientCount: 120,
    sentCount: 2,
    deliveredCount: 10,
    readCount: 71,
    failedCount: 37,
    skippedCount: 0,
    ...over,
  };
}

describe('ZernioBroadcastSyncService', () => {
  let prisma: MockProxy<PrismaService>;
  let client: MockProxy<ZernioAnalyticsClient>;
  let service: ZernioBroadcastSyncService;

  beforeEach(() => {
    prisma = mockDeep<PrismaService>();
    client = mockDeep<ZernioAnalyticsClient>();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).configured = true;

    prisma.channel.findMany.mockResolvedValue([
      { id: CHANNEL, zernioAccountId: ACCOUNT },
    ] as never);
    // Sem campanha ativa: o sync tem o balde para si.
    prisma.campaign.findFirst.mockResolvedValue(null as never);
    prisma.zernioBroadcast.upsert.mockResolvedValue({} as never);

    service = new ZernioBroadcastSyncService(prisma, client);
  });

  it('pagina por OFFSET seguindo o hasMore (skip 0 → 100) e espelha as 2 páginas', async () => {
    client.listBroadcasts
      .mockResolvedValueOnce({
        items: [broadcast({ id: 'b1' })],
        hasMore: true,
        total: 2,
      })
      .mockResolvedValueOnce({
        items: [broadcast({ id: 'b2' })],
        hasMore: false,
        total: 2,
      });

    const res = await service.syncBroadcasts();

    expect(client.listBroadcasts).toHaveBeenNthCalledWith(1, [CHANNEL], 0);
    // Offset, não cursor: a 2ª página é skip=100 (o tamanho da página).
    expect(client.listBroadcasts).toHaveBeenNthCalledWith(2, [CHANNEL], 100);
    expect(res.broadcasts).toBe(2);
  });

  it('faz upsert IDEMPOTENTE por zernioId (rodar de novo reescreve a mesma linha)', async () => {
    client.listBroadcasts.mockResolvedValue({
      items: [broadcast()],
      hasMore: false,
      total: 1,
    });

    await service.syncBroadcasts();

    const call = prisma.zernioBroadcast.upsert.mock.calls[0][0];
    expect(call.where).toEqual({ zernioId: 'b-live' });
    // Os contadores são reescritos a cada rodada — é assim que a tela vê o
    // disparo evoluir de `sending` para `completed`.
    expect(call.update).toMatchObject({
      status: 'completed',
      recipientCount: 120,
      sentCount: 2,
      deliveredCount: 10,
      readCount: 71,
      failedCount: 37,
      templateName: 'bem_vindo_mg',
    });
    expect(call.create).toMatchObject({
      zernioId: 'b-live',
      channelId: CHANNEL,
      name: 'Primeira Campanha',
    });
    expect(call.update.startedAt).toEqual(new Date('2026-07-11T22:00:28.573Z'));
  });

  it('NUNCA reescreve o campaignId: o vínculo é de quem criou o disparo, não do sync', async () => {
    client.listBroadcasts.mockResolvedValue({
      items: [broadcast()],
      hasMore: false,
      total: 1,
    });

    await service.syncBroadcasts();

    const call = prisma.zernioBroadcast.upsert.mock.calls[0][0];
    expect(call.update).not.toHaveProperty('campaignId');
  });

  it('casa o disparo com o canal pelo accountId', async () => {
    prisma.channel.findMany.mockResolvedValue([
      { id: 'chA', zernioAccountId: 'accA' },
      { id: 'chB', zernioAccountId: 'accB' },
    ] as never);
    client.listBroadcasts.mockResolvedValue({
      items: [broadcast({ id: 'b1', accountId: 'accB' })],
      hasMore: false,
      total: 1,
    });

    await service.syncBroadcasts();

    expect(prisma.zernioBroadcast.upsert.mock.calls[0][0].create).toMatchObject({
      channelId: 'chB',
    });
  });

  it('disparo de uma conta SEM canal no orgamind é PULADO (e contado), não derruba o sync', async () => {
    client.listBroadcasts.mockResolvedValue({
      items: [
        broadcast({ id: 'b1', accountId: 'conta-desconhecida' }),
        broadcast({ id: 'b2' }),
      ],
      hasMore: false,
      total: 2,
    });

    const res = await service.syncBroadcasts();

    expect(res.skipped).toBe(1);
    expect(res.broadcasts).toBe(1);
    expect(prisma.zernioBroadcast.upsert).toHaveBeenCalledTimes(1);
  });

  it('CEDE o balde quando há campanha ativa e devolve o ponto de retomada', async () => {
    prisma.campaign.findFirst.mockResolvedValue({ id: 'camp1' } as never);

    const res = await service.syncBroadcasts();

    // O envio tem prioridade: o sync nem chega a bater no Zernio.
    expect(client.listBroadcasts).not.toHaveBeenCalled();
    expect(res.paused).toBe(true);
    expect(res.resumeSkip).toBe(0);
  });

  it('cede no MEIO da paginação, guardando o skip da página que faltou', async () => {
    client.listBroadcasts.mockResolvedValueOnce({
      items: [broadcast({ id: 'b1' })],
      hasMore: true,
      total: 200,
    });
    // A campanha entra em curso DEPOIS da 1ª página.
    prisma.campaign.findFirst
      .mockResolvedValueOnce(null as never)
      .mockResolvedValueOnce({ id: 'camp1' } as never);

    const res = await service.syncBroadcasts();

    expect(client.listBroadcasts).toHaveBeenCalledTimes(1);
    expect(res.paused).toBe(true);
    expect(res.resumeSkip).toBe(100);
    expect(res.broadcasts).toBe(1); // o que já entrou, entrou
  });

  it('retoma do skip que o run anterior deixou', async () => {
    client.listBroadcasts.mockResolvedValue({
      items: [],
      hasMore: false,
      total: 0,
    });

    await service.syncBroadcasts({ startSkip: 100 });

    expect(client.listBroadcasts).toHaveBeenCalledWith([CHANNEL], 100);
  });

  it('sem canal ZERNIO ativo NÃO fala com o Zernio (não gasta o balde à toa)', async () => {
    prisma.channel.findMany.mockResolvedValue([] as never);

    const res = await service.syncBroadcasts();

    expect(client.listBroadcasts).not.toHaveBeenCalled();
    expect(res.reason).toMatch(/canal/i);
  });

  it('sem ZERNIO_API_KEY vira no-op', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).configured = false;

    const res = await service.syncBroadcasts();

    expect(client.listBroadcasts).not.toHaveBeenCalled();
    expect(res.reason).toMatch(/ZERNIO_API_KEY/);
  });

  it('ignora disparo que não é de WhatsApp (a conta Zernio pode ter outras redes)', async () => {
    client.listBroadcasts.mockResolvedValue({
      items: [broadcast({ id: 'ig', platform: 'instagram' })],
      hasMore: false,
      total: 1,
    });

    const res = await service.syncBroadcasts();

    expect(prisma.zernioBroadcast.upsert).not.toHaveBeenCalled();
    expect(res.broadcasts).toBe(0);
  });

  it('um upsert que falha não leva junto os outros disparos da página', async () => {
    client.listBroadcasts.mockResolvedValue({
      items: [broadcast({ id: 'b1' }), broadcast({ id: 'b2' })],
      hasMore: false,
      total: 2,
    });
    prisma.zernioBroadcast.upsert
      .mockRejectedValueOnce(new Error('deadlock'))
      .mockResolvedValueOnce({} as never);

    const res = await service.syncBroadcasts();

    expect(res.failed).toBe(1);
    expect(res.broadcasts).toBe(1);
  });

  it('para no teto de páginas — um hasMore eterno não pode virar laço infinito', async () => {
    client.listBroadcasts.mockResolvedValue({
      items: [broadcast()],
      hasMore: true, // MENTE para sempre
      total: 999_999,
    });

    await service.syncBroadcasts();

    expect(client.listBroadcasts.mock.calls.length).toBeLessThanOrEqual(50);
    expect(client.listBroadcasts.mock.calls.length).toBeGreaterThan(1);
  });

  // ── ZW — O ESPELHO NÃO PODE PISAR NO QUE O WEBHOOK APUROU ────────────────
  //
  // Os contadores agregados do `GET /broadcasts` estão QUEBRADOS: o disparo real
  // acima veio com `sentCount: 2` e `deliveredCount: 10` — mais entregues do que
  // enviadas, incoerente e CONGELADO. Para um disparo que o ORGAMIND criou, quem
  // sabe a verdade são as nossas Messages (que o webhook mantém em dia).
  //
  // Sem isto, o sync de 15 em 15 minutos reescreveria, por cima do que o webhook
  // apurou, os números errados do Zernio — e a tela voltaria a mentir sozinha.
  describe('ZW — contadores de um disparo do ORGAMIND', () => {
    it('NÃO sobrescreve os contadores de um disparo com Messages nossas (o webhook é a verdade)', async () => {
      client.listBroadcasts.mockResolvedValue({
        items: [broadcast()],
        hasMore: false,
        total: 1,
      } as never);
      // Este disparo é do orgamind: tem campanha e tem Messages nossas.
      prisma.zernioBroadcast.findUnique.mockResolvedValue({
        id: 'local-1',
        campaignId: 'camp-1',
      } as never);

      await service.syncBroadcasts();

      const call = prisma.zernioBroadcast.upsert.mock.calls[0][0];
      // Os metadados do Zernio continuam vindo (nome, status, datas)...
      expect(call.update).toMatchObject({ name: 'Primeira Campanha' });
      // ...mas os CONTADORES, não: quem manda neles é o webhook.
      expect(call.update).not.toHaveProperty('sentCount');
      expect(call.update).not.toHaveProperty('deliveredCount');
      expect(call.update).not.toHaveProperty('readCount');
      expect(call.update).not.toHaveProperty('failedCount');
    });

    it('um disparo feito PELO PAINEL (sem campanha nossa) continua espelhando os contadores do Zernio', async () => {
      // Aqui o Zernio é a ÚNICA fonte que existe: o orgamind não tem Message
      // nenhuma desse disparo. Números tortos são melhores que nenhum número.
      client.listBroadcasts.mockResolvedValue({
        items: [broadcast()],
        hasMore: false,
        total: 1,
      } as never);
      prisma.zernioBroadcast.findUnique.mockResolvedValue(null as never);

      await service.syncBroadcasts();

      const call = prisma.zernioBroadcast.upsert.mock.calls[0][0];
      expect(call.update).toMatchObject({
        sentCount: 2,
        deliveredCount: 10,
        readCount: 71,
        failedCount: 37,
      });
    });
  });
});
