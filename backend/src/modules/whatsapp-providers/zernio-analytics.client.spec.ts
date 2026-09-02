import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { ConfigService } from '@nestjs/config';
import type Redis from 'ioredis';
import { ZernioAnalyticsClient } from './zernio-analytics.client';
import { ZernioRateLimitError } from './zernio-api.client';
import { zernioThrottleKey } from '../queue/zernio-throttle.helper';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const API_KEY = 'zk_test_key';
const BASE = 'https://zernio.test/api/v1';
const BROADCASTS_URL = `${BASE}/broadcasts`;
const VOLUME_URL = `${BASE}/analytics/inbox/volume`;
const CHANNEL = 'ch1';

/** `SET key v PX ms NX` de verdade — a semântica que dá sentido ao throttle. */
function fakeRedis(now: () => number) {
  const store = new Map<string, number>();
  return {
    set: vi.fn((key: string, _v: string, _px: string, ms: number) => {
      const expiry = store.get(key);
      if (expiry !== undefined && expiry > now()) return Promise.resolve(null);
      store.set(key, now() + ms);
      return Promise.resolve('OK');
    }),
    pttl: vi.fn((key: string) => {
      const expiry = store.get(key);
      if (expiry === undefined) return Promise.resolve(-2);
      const left = expiry - now();
      return Promise.resolve(left > 0 ? left : -2);
    }),
  } as unknown as Redis;
}

/** Relógio VIRTUAL: só anda quando o cliente dorme (ver o spec do inbox). */
function makeHarness(overrides: Record<string, string | undefined> = {}) {
  const values: Record<string, string | undefined> = {
    ZERNIO_API_KEY: API_KEY,
    ZERNIO_BASE_URL: BASE,
    ...overrides,
  };
  const config = { get: (k: string) => values[k] } as unknown as ConfigService;
  let clock = 1_000_000;
  const now = () => clock;
  const redis = fakeRedis(now);
  const sleeps: number[] = [];

  class TestClient extends ZernioAnalyticsClient {
    protected override async delay(ms: number): Promise<void> {
      sleeps.push(ms);
      clock += ms;
    }
    protected override now(): number {
      return clock;
    }
  }

  return { client: new TestClient(config, redis), sleeps, now, redis };
}

const makeClient = (o: Record<string, string | undefined> = {}) =>
  makeHarness(o).client;

/** Um broadcast como o Zernio de verdade o devolve (capturado ao vivo). */
const LIVE_BROADCAST = {
  id: 'a1b2c3d4e5f6a7b8c9d00004',
  name: 'Primeira Campanha',
  platform: 'whatsapp',
  accountId: 'a1b2c3d4e5f6a7b8c9d0e1f2',
  accountName: 'Matheus Garcia',
  status: 'completed',
  messagePreview: 'Template: bem_vindo_mg',
  scheduledAt: '2026-07-11T22:10:00.000Z',
  startedAt: '2026-07-11T22:00:28.573Z',
  completedAt: '2026-07-11T22:09:04.516Z',
  recipientCount: 120,
  sentCount: 2,
  deliveredCount: 10,
  readCount: 71,
  failedCount: 37,
  skippedCount: 0,
  createdAt: '2026-07-11T21:59:01.784Z',
};

describe('ZernioAnalyticsClient', () => {
  describe('listBroadcasts', () => {
    it('pagina por OFFSET (limit/skip) e devolve os contadores do disparo', async () => {
      let seenAuth: string | null = null;
      let seenQuery: URLSearchParams | null = null;
      server.use(
        http.get(BROADCASTS_URL, ({ request }) => {
          seenAuth = request.headers.get('authorization');
          seenQuery = new URL(request.url).searchParams;
          return HttpResponse.json({
            success: true,
            broadcasts: [LIVE_BROADCAST],
            pagination: { total: 120, limit: 100, skip: 100, hasMore: true },
          });
        }),
      );

      const page = await makeClient().listBroadcasts([CHANNEL], 100);

      expect(seenAuth).toBe(`Bearer ${API_KEY}`);
      // O `/broadcasts` NÃO é por cursor: é `skip` (offset). Mandar `cursor`
      // aqui seria silenciosamente ignorado e a mesma página voltaria sempre.
      expect(seenQuery!.get('skip')).toBe('100');
      expect(seenQuery!.get('limit')).toBe('100');
      expect(seenQuery!.get('cursor')).toBeNull();

      expect(page.hasMore).toBe(true);
      expect(page.total).toBe(120);
      expect(page.items).toHaveLength(1);
      expect(page.items[0]).toMatchObject({
        id: 'a1b2c3d4e5f6a7b8c9d00004',
        accountId: 'a1b2c3d4e5f6a7b8c9d0e1f2',
        name: 'Primeira Campanha',
        status: 'completed',
        recipientCount: 120,
        sentCount: 2,
        deliveredCount: 10,
        readCount: 71,
        failedCount: 37,
        skippedCount: 0,
      });
    });

    it('extrai o templateName do messagePreview ("Template: bem_vindo_mg")', async () => {
      server.use(
        http.get(BROADCASTS_URL, () =>
          HttpResponse.json({
            broadcasts: [
              LIVE_BROADCAST,
              { ...LIVE_BROADCAST, id: 'b2', messagePreview: 'Olá, tudo bem?' },
            ],
            pagination: { hasMore: false },
          }),
        ),
      );

      const page = await makeClient().listBroadcasts([CHANNEL], 0);

      expect(page.items[0].templateName).toBe('bem_vindo_mg');
      // Disparo de texto livre não tem template — e null é a resposta honesta.
      expect(page.items[1].templateName).toBeNull();
    });

    it('sem bloco `pagination` assume que ACABOU (nunca lê a mesma página para sempre)', async () => {
      server.use(
        http.get(BROADCASTS_URL, () =>
          HttpResponse.json({ broadcasts: [LIVE_BROADCAST] }),
        ),
      );

      const page = await makeClient().listBroadcasts([CHANNEL], 0);
      expect(page.hasMore).toBe(false);
    });

    it('pula o broadcast sem id ou sem accountId em vez de derrubar a página', async () => {
      server.use(
        http.get(BROADCASTS_URL, () =>
          HttpResponse.json({
            broadcasts: [
              { name: 'sem id', accountId: 'acc1' },
              { id: 'b2', name: 'sem conta' },
              LIVE_BROADCAST,
            ],
            pagination: { hasMore: false },
          }),
        ),
      );

      const page = await makeClient().listBroadcasts([CHANNEL], 0);
      expect(page.items.map((b) => b.id)).toEqual([LIVE_BROADCAST.id]);
    });

    it('espera o balde COMPARTILHADO com o envio (a MESMA chave do throttle)', async () => {
      server.use(
        http.get(BROADCASTS_URL, () =>
          HttpResponse.json({ broadcasts: [], pagination: { hasMore: false } }),
        ),
      );
      const { client, sleeps, redis } = makeHarness();

      await client.listBroadcasts([CHANNEL], 0);
      await client.listBroadcasts([CHANNEL], 100);

      // A 2ª chamada esperou o slot de 1s do canal — e a chave é a do ENVIO.
      expect(sleeps.length).toBeGreaterThanOrEqual(1);
      expect(redis.set).toHaveBeenCalledWith(
        zernioThrottleKey(CHANNEL),
        '1',
        'PX',
        1000,
        'NX',
      );
    });

    it('paga um slot POR CANAL ativo: a listagem é global e bebe do balde de todos', async () => {
      server.use(
        http.get(BROADCASTS_URL, () =>
          HttpResponse.json({ broadcasts: [], pagination: { hasMore: false } }),
        ),
      );
      const { client, redis } = makeHarness();

      await client.listBroadcasts(['chA', 'chB'], 0);

      // `/broadcasts` não aceita filtro por conta: uma requisição serve os dois
      // canais e consome o balde dos dois. Cobrar só um deles roubaria vazão do
      // envio do outro sem pagar por ela.
      expect(redis.set).toHaveBeenCalledWith(
        zernioThrottleKey('chA'),
        '1',
        'PX',
        1000,
        'NX',
      );
      expect(redis.set).toHaveBeenCalledWith(
        zernioThrottleKey('chB'),
        '1',
        'PX',
        1000,
        'NX',
      );
    });

    it('obedece ao `Retry-After` no 429 e retenta', async () => {
      let calls = 0;
      server.use(
        http.get(BROADCASTS_URL, () => {
          calls += 1;
          if (calls === 1) {
            return new HttpResponse(null, {
              status: 429,
              headers: { 'retry-after': '3' },
            });
          }
          return HttpResponse.json({
            broadcasts: [LIVE_BROADCAST],
            pagination: { hasMore: false },
          });
        }),
      );
      const { client, sleeps } = makeHarness();

      const page = await client.listBroadcasts([CHANNEL], 0);

      expect(page.items).toHaveLength(1);
      expect(sleeps).toContain(3000); // 3s, o que o PROVEDOR mandou
    });

    it('429 teimoso vira ZernioRateLimitError (tipado) em vez de AxiosError cru', async () => {
      server.use(
        http.get(BROADCASTS_URL, () => new HttpResponse(null, { status: 429 })),
      );

      await expect(
        makeHarness().client.listBroadcasts([CHANNEL], 0),
      ).rejects.toBeInstanceOf(ZernioRateLimitError);
    });
  });

  describe('getInboxVolume', () => {
    it('lê o volume da conta no período (summary + timeseries + byPlatform)', async () => {
      let seenQuery: URLSearchParams | null = null;
      server.use(
        http.get(VOLUME_URL, ({ request }) => {
          seenQuery = new URL(request.url).searchParams;
          return HttpResponse.json({
            success: true,
            from: '2026-06-01',
            to: null,
            summary: {
              received: 23,
              sent: 121,
              read: 72,
              failed: 0,
              uniqueConversations: 16,
            },
            timeseries: [
              { date: '2026-07-11', sent: 121, received: 18, read: 68, failed: 0 },
              { date: '2026-07-12', sent: 0, received: 3, read: 4, failed: 0 },
            ],
            byPlatform: [
              { platform: 'whatsapp', sent: 121, received: 23, read: 72, failed: 0 },
            ],
          });
        }),
      );

      const vol = await makeClient().getInboxVolume(
        CHANNEL,
        'acc1',
        '2026-06-01',
        '2026-07-12',
      );

      expect(seenQuery!.get('accountId')).toBe('acc1');
      expect(seenQuery!.get('fromDate')).toBe('2026-06-01');
      expect(seenQuery!.get('toDate')).toBe('2026-07-12');

      expect(vol.summary).toEqual({
        received: 23,
        sent: 121,
        read: 72,
        failed: 0,
        uniqueConversations: 16,
      });
      expect(vol.timeseries).toEqual([
        { date: '2026-07-11', sent: 121, received: 18, read: 68, failed: 0 },
        { date: '2026-07-12', sent: 0, received: 3, read: 4, failed: 0 },
      ]);
    });

    it('resposta vazia/torta vira zeros — o job diário não pode quebrar por isso', async () => {
      server.use(http.get(VOLUME_URL, () => HttpResponse.json({ success: true })));

      const vol = await makeClient().getInboxVolume(CHANNEL, 'acc1', '2026-06-01');

      expect(vol.summary.sent).toBe(0);
      expect(vol.timeseries).toEqual([]);
    });

    it('também passa pelo balde do envio', async () => {
      server.use(http.get(VOLUME_URL, () => HttpResponse.json({ success: true })));
      const { client, redis } = makeHarness();

      await client.getInboxVolume(CHANNEL, 'acc1', '2026-06-01');

      expect(redis.set).toHaveBeenCalledWith(
        zernioThrottleKey(CHANNEL),
        '1',
        'PX',
        1000,
        'NX',
      );
    });
  });

  it('sem ZERNIO_API_KEY o cliente se declara não configurado (o sync vira no-op)', () => {
    expect(makeClient({ ZERNIO_API_KEY: undefined }).configured).toBe(false);
    expect(makeClient().configured).toBe(true);
  });
});
