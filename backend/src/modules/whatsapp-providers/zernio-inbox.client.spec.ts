import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { ConfigService } from '@nestjs/config';
import type Redis from 'ioredis';
import { ZernioInboxClient, ZernioRateLimitError } from './zernio-inbox.client';
import {
  acquireZernioSendSlot,
  ZERNIO_SEND_MIN_INTERVAL_MS,
} from '../queue/zernio-throttle.helper';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const API_KEY = 'zk_test_key';
const BASE = 'https://zernio.test/api/v1';
const CONVERSATIONS_URL = `${BASE}/inbox/conversations`;
const MESSAGES_URL = `${BASE}/inbox/conversations/:conversationId/messages`;
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

/**
 * Relógio VIRTUAL: só anda quando o cliente dorme. É o que permite afirmar
 * "100 requisições e nenhuma excedeu 1 req/s" sem esperar 100 segundos de
 * verdade — e sem `vi.useFakeTimers`, que brigaria com o msw.
 */
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

  class TestClient extends ZernioInboxClient {
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

describe('ZernioInboxClient', () => {
  it('lista conversas com Bearer e devolve o cursor da próxima página', async () => {
    let seenAuth: string | null = null;
    let seenQuery: URLSearchParams | null = null;
    server.use(
      http.get(CONVERSATIONS_URL, ({ request }) => {
        seenAuth = request.headers.get('authorization');
        seenQuery = new URL(request.url).searchParams;
        return HttpResponse.json({
          data: [
            {
              id: 'c1',
              accountId: 'acc1',
              platform: 'whatsapp',
              participantId: '559285550102',
              participantName: 'Gomes',
              participantPicture: 'https://cdn/pic.jpg',
              lastMessage: 'Tudo bem',
              updatedTime: '2026-07-11T22:27:30.000Z',
              unreadCount: 1,
            },
          ],
          pagination: { hasMore: true, nextCursor: 'CUR2' },
        });
      }),
    );

    const page = await makeClient().listConversations(CHANNEL, 'acc1');

    expect(seenAuth).toBe(`Bearer ${API_KEY}`);
    expect(seenQuery!.get('accountId')).toBe('acc1');
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).toBe('CUR2');
    expect(page.items).toEqual([
      {
        id: 'c1',
        accountId: 'acc1',
        platform: 'whatsapp',
        participantId: '559285550102',
        participantName: 'Gomes',
        participantPicture: 'https://cdn/pic.jpg',
        lastMessage: 'Tudo bem',
        updatedTime: '2026-07-11T22:27:30.000Z',
        unreadCount: 1,
      },
    ]);
  });

  // A doc descreve `{data,pagination}` e foi o que a API devolveu ao vivo, mas
  // respostas com `conversations` já foram observadas. Aceitar as duas chaves
  // custa uma linha e evita um sync silenciosamente vazio.
  it('aceita a resposta com a chave `conversations` (além de `data`)', async () => {
    server.use(
      http.get(CONVERSATIONS_URL, () =>
        HttpResponse.json({
          conversations: [
            { id: 'c9', accountId: 'acc1', platform: 'whatsapp', participantId: '5592988887777' },
          ],
        }),
      ),
    );

    const page = await makeClient().listConversations(CHANNEL, 'acc1');

    expect(page.items).toHaveLength(1);
    expect(page.items[0].id).toBe('c9');
    // Sem bloco `pagination` => fim da paginação (nunca um loop infinito).
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
  });

  it('repassa o cursor na página seguinte', async () => {
    let seenCursor: string | null = null;
    server.use(
      http.get(CONVERSATIONS_URL, ({ request }) => {
        seenCursor = new URL(request.url).searchParams.get('cursor');
        return HttpResponse.json({ data: [], pagination: { hasMore: false, nextCursor: null } });
      }),
    );

    await makeClient().listConversations(CHANNEL, 'acc1', 'CUR2');

    expect(seenCursor).toBe('CUR2');
  });

  /**
   * A ÂNCORA desta feature. `GET /inbox/conversations/{id}/messages` responde
   * 400 sem `accountId` — o param é obrigatório (OpenAPI 3.1 do Zernio, seção
   * /inbox). Foi o que fez o endpoint parecer inexistente.
   */
  it('exige accountId na query das mensagens (sem ele a API devolve 400)', async () => {
    let seenAccountId: string | null = null;
    server.use(
      http.get(MESSAGES_URL, ({ request, params }) => {
        const url = new URL(request.url);
        seenAccountId = url.searchParams.get('accountId');
        if (!seenAccountId) {
          return HttpResponse.json({ error: 'accountId is required' }, { status: 400 });
        }
        expect(params.conversationId).toBe('c1');
        return HttpResponse.json({
          messages: [
            {
              id: 'wamid.ABC',
              conversationId: 'c1',
              accountId: 'acc1',
              platform: 'whatsapp',
              message: 'Pode contar comigo',
              senderId: '559299550101',
              senderName: 'Rosete',
              senderPhoneNumber: '+559299550101',
              direction: 'incoming',
              createdAt: '2026-07-12T01:12:14.000Z',
              attachments: [],
            },
          ],
          pagination: { hasMore: false, nextCursor: null },
        });
      }),
    );

    const page = await makeClient().listMessages(CHANNEL, 'c1', 'acc1');

    expect(seenAccountId).toBe('acc1');
    expect(page.items).toHaveLength(1);
    // `id` É o wamid nesta API REST (≠ do webhook, onde `id` é o ObjectId do
    // Mongo e o wamid vive em `platformMessageId`). É a chave de dedupe.
    expect(page.items[0].id).toBe('wamid.ABC');
    expect(page.items[0].direction).toBe('incoming');
    expect(page.items[0].message).toBe('Pode contar comigo');
  });

  it('pede as mensagens em ordem cronológica (asc) e devolve o cursor', async () => {
    let seenSort: string | null = null;
    server.use(
      http.get(MESSAGES_URL, ({ request }) => {
        seenSort = new URL(request.url).searchParams.get('sortOrder');
        return HttpResponse.json({
          messages: [],
          pagination: { hasMore: true, nextCursor: 'MCUR2' },
        });
      }),
    );

    const page = await makeClient().listMessages(CHANNEL, 'c1', 'acc1');

    expect(seenSort).toBe('asc');
    expect(page.nextCursor).toBe('MCUR2');
    expect(page.hasMore).toBe(true);
  });

  it('não está configurado sem ZERNIO_API_KEY', () => {
    expect(makeClient({ ZERNIO_API_KEY: undefined }).configured).toBe(false);
    expect(makeClient().configured).toBe(true);
  });
});

/**
 * O incidente: o operador clicou "Sincronizar inbox", o sync disparou ~100
 * requisições (1 por conversa) sem espaçamento, o Zernio devolveu 429 e o
 * operador levou um HTTP 500 — com ZERO conversas importadas.
 */
describe('ZernioInboxClient — balde de 60 req/min (o 429 que virou 500 em prod)', () => {
  it('100 requisições: nenhuma excede o balde de 1 req/s', async () => {
    const { client, now } = makeHarness();
    const stamps: number[] = [];
    server.use(
      http.get(CONVERSATIONS_URL, () => {
        stamps.push(now()); // relógio virtual: só anda quando o cliente dorme
        return HttpResponse.json({ data: [], pagination: { hasMore: false } });
      }),
    );

    for (let i = 0; i < 100; i++) {
      await client.listConversations(CHANNEL, 'acc1');
    }

    expect(stamps).toHaveLength(100);
    const gaps = stamps.slice(1).map((t, i) => t - stamps[i]);
    // A afirmação que o incidente exige: NENHUM par consecutivo abaixo de 1s.
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(ZERNIO_SEND_MIN_INTERVAL_MS);
    // 100 requisições ⇒ ao menos 99 segundos de janela. Antes: tudo num piscar.
    expect(stamps[99] - stamps[0]).toBeGreaterThanOrEqual(
      99 * ZERNIO_SEND_MIN_INTERVAL_MS,
    );
  });

  it('bebe do MESMO balde do envio (não é um balde paralelo)', async () => {
    const { client, redis } = makeHarness();
    server.use(
      http.get(CONVERSATIONS_URL, () =>
        HttpResponse.json({ data: [], pagination: { hasMore: false } }),
      ),
    );

    await client.listConversations(CHANNEL, 'acc1');
    // O sync acabou de gastar o slot do canal → o ENVIO no mesmo canal tem de
    // ser recusado. Se cada um tivesse a sua chave, os dois passariam = 2 req/s.
    const envio = await acquireZernioSendSlot(redis, CHANNEL);

    expect(envio.acquired).toBe(false);
  });

  it('429 com Retry-After: 5 → espera 5s, retenta e conclui (não propaga erro)', async () => {
    const { client, sleeps } = makeHarness();
    let calls = 0;
    server.use(
      http.get(MESSAGES_URL, () => {
        calls += 1;
        if (calls === 1) {
          return HttpResponse.json(
            { error: 'rate limit exceeded' },
            { status: 429, headers: { 'Retry-After': '5' } },
          );
        }
        return HttpResponse.json({
          messages: [{ id: 'wamid.OK', direction: 'incoming', createdAt: '2026-07-12T01:00:00Z' }],
          pagination: { hasMore: false },
        });
      }),
    );

    const page = await client.listMessages(CHANNEL, 'c1', 'acc1');

    expect(calls).toBe(2); // retentou
    expect(page.items[0].id).toBe('wamid.OK'); // e concluiu
    // Respeitou o Retry-After do provedor: 5s, não um backoff inventado.
    expect(sleeps).toContain(5_000);
  });

  it('429 com X-RateLimit-Reset (sem Retry-After) → espera até o reset', async () => {
    const { client, sleeps, now } = makeHarness();
    let calls = 0;
    const resetAt = Math.floor((now() + 8_000) / 1000); // unix ts, 8s à frente
    server.use(
      http.get(CONVERSATIONS_URL, () => {
        calls += 1;
        if (calls === 1) {
          return HttpResponse.json(
            { error: 'rate limit' },
            { status: 429, headers: { 'X-RateLimit-Reset': String(resetAt) } },
          );
        }
        return HttpResponse.json({ data: [], pagination: { hasMore: false } });
      }),
    );

    await client.listConversations(CHANNEL, 'acc1');

    expect(calls).toBe(2);
    expect(sleeps.some((ms) => ms >= 7_000 && ms <= 9_000)).toBe(true);
  });

  it('429 sem cabeçalho → backoff exponencial com teto', async () => {
    const { client, sleeps } = makeHarness();
    let calls = 0;
    server.use(
      http.get(CONVERSATIONS_URL, () => {
        calls += 1;
        if (calls <= 3) return HttpResponse.json({}, { status: 429 });
        return HttpResponse.json({ data: [], pagination: { hasMore: false } });
      }),
    );

    await client.listConversations(CHANNEL, 'acc1');

    expect(calls).toBe(4);
    // Backoff dos 429 (o throttle também dorme; olhamos os saltos exponenciais).
    const backoffs = sleeps.filter((ms) => ms >= 1_000);
    expect(backoffs.length).toBeGreaterThanOrEqual(3);
    expect(Math.max(...sleeps)).toBeLessThanOrEqual(60_000); // teto
  });

  it('429 que não cede → erro TIPADO (o chamador conta como falha, não 500)', async () => {
    const { client } = makeHarness();
    server.use(
      http.get(CONVERSATIONS_URL, () =>
        HttpResponse.json({}, { status: 429, headers: { 'Retry-After': '1' } }),
      ),
    );

    await expect(client.listConversations(CHANNEL, 'acc1')).rejects.toBeInstanceOf(
      ZernioRateLimitError,
    );
  });

  it('erro que NÃO é 429 (401) sobe na hora, sem retentar', async () => {
    const { client } = makeHarness();
    let calls = 0;
    server.use(
      http.get(CONVERSATIONS_URL, () => {
        calls += 1;
        return HttpResponse.json({ error: 'unauthorized' }, { status: 401 });
      }),
    );

    await expect(client.listConversations(CHANNEL, 'acc1')).rejects.toThrow();
    expect(calls).toBe(1); // 401 é fatal: retentar só queima o balde
  });
});
