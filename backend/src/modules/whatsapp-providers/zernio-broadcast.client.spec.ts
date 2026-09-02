import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { ConfigService } from '@nestjs/config';
import type Redis from 'ioredis';
import { ZernioBroadcastClient } from './zernio-broadcast.client';
import { ZernioHttpError } from './zernio-api.client';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const BASE = 'https://zernio.test/api/v1';
const CHANNEL = 'ch1';
const BID = 'bc_123';

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

function makeClient() {
  const values: Record<string, string | undefined> = {
    ZERNIO_API_KEY: 'zk_test',
    ZERNIO_BASE_URL: BASE,
  };
  const config = { get: (k: string) => values[k] } as unknown as ConfigService;
  let clock = 1_000_000;
  const redis = fakeRedis(() => clock);
  const sleeps: number[] = [];

  class TestClient extends ZernioBroadcastClient {
    protected override async delay(ms: number): Promise<void> {
      sleeps.push(ms);
      clock += ms;
    }
    protected override now(): number {
      return clock;
    }
  }
  return { client: new TestClient(config, redis), sleeps };
}

describe('createBroadcast', () => {
  it('POSTa profileId/accountId/platform/name/template e devolve o id do disparo', async () => {
    let body: Record<string, unknown> | undefined;
    server.use(
      http.post(`${BASE}/broadcasts`, async ({ request }) => {
        body = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({
          success: true,
          broadcast: { id: BID, status: 'draft' },
        });
      }),
    );

    const { client } = makeClient();
    const id = await client.createBroadcast(CHANNEL, {
      profileId: 'prof_1',
      accountId: 'acc_1',
      name: 'Campanha X — lote 1',
      templateName: 'bem_vindo_mg',
      templateLanguage: 'pt_BR',
      variableMapping: { '1': { field: 'custom', customValue: 'Matheus' } },
    });

    expect(id).toBe(BID);
    expect(body).toMatchObject({
      profileId: 'prof_1',
      accountId: 'acc_1',
      platform: 'whatsapp',
      name: 'Campanha X — lote 1',
      template: {
        name: 'bem_vindo_mg',
        language: 'pt_BR',
        variableMapping: { '1': { field: 'custom', customValue: 'Matheus' } },
      },
    });
  });

  it('resposta sem id => erro (não dá para seguir sem a chave do disparo)', async () => {
    server.use(
      http.post(`${BASE}/broadcasts`, () => HttpResponse.json({ success: true })),
    );
    const { client } = makeClient();
    await expect(
      client.createBroadcast(CHANNEL, {
        profileId: 'p',
        accountId: 'a',
        name: 'n',
        templateName: 't',
        templateLanguage: 'pt_BR',
        variableMapping: {},
      }),
    ).rejects.toThrow(/sem id|não retornou/i);
  });
});

describe('addRecipients — fatiamento + AUTO-BACKOFF', () => {
  it('fatia em blocos do tamanho pedido: 120 telefones / chunk 50 => 3 requisições', async () => {
    const batches: string[][] = [];
    server.use(
      http.post(`${BASE}/broadcasts/${BID}/recipients`, async ({ request }) => {
        const b = (await request.json()) as { phones: string[] };
        batches.push(b.phones);
        return HttpResponse.json({ success: true, added: b.phones.length, skipped: 0 });
      }),
    );

    const phones = Array.from({ length: 120 }, (_, i) => `+5592900000${i}`);
    const { client } = makeClient();
    const res = await client.addRecipients(CHANNEL, BID, phones, 50);

    expect(batches.map((b) => b.length)).toEqual([50, 50, 20]);
    expect(batches.flat()).toEqual(phones); // ninguém perdido, ninguém repetido
    expect(res.added).toBe(120);
    expect(res.chunkUsed).toBe(50);
  });

  it('★ 400 "Maximum 20 recipients" => LÊ o corpo, encolhe para 20 e RETENTA o mesmo bloco', async () => {
    const accepted: string[][] = [];
    server.use(
      http.post(`${BASE}/broadcasts/${BID}/recipients`, async ({ request }) => {
        const b = (await request.json()) as { phones: string[] };
        if (b.phones.length > 20) {
          return HttpResponse.json(
            { error: 'Maximum 20 recipients per request' },
            { status: 400 },
          );
        }
        accepted.push(b.phones);
        return HttpResponse.json({ success: true, added: b.phones.length, skipped: 0 });
      }),
    );

    const phones = Array.from({ length: 50 }, (_, i) => `+559290000${i}`);
    const { client } = makeClient();
    const res = await client.addRecipients(CHANNEL, BID, phones, 50);

    // Nenhum bloco maior que 20 entrou, e a lista inteira entrou.
    expect(accepted.every((b) => b.length <= 20)).toBe(true);
    expect(accepted.flat()).toEqual(phones);
    expect(res.added).toBe(50);
    expect(res.chunkUsed).toBe(20);
  });

  it('400 que NÃO é de tamanho (telefone inválido) NÃO encolhe — sobe o erro', async () => {
    let calls = 0;
    server.use(
      http.post(`${BASE}/broadcasts/${BID}/recipients`, () => {
        calls += 1;
        return HttpResponse.json(
          { error: 'Invalid phone number: 55' },
          { status: 400 },
        );
      }),
    );

    const { client } = makeClient();
    await expect(
      client.addRecipients(CHANNEL, BID, ['+5592900001', '+5592900002'], 50),
    ).rejects.toBeInstanceOf(ZernioHttpError);
    // UMA tentativa. Encolher não conserta um telefone ruim; só gasta o balde.
    expect(calls).toBe(1);
  });

  it('lista vazia => nenhuma requisição (um /recipients vazio é um 400 de graça)', async () => {
    server.use(
      http.post(`${BASE}/broadcasts/${BID}/recipients`, () => {
        throw new Error('não deveria ter sido chamado');
      }),
    );
    const { client } = makeClient();
    const res = await client.addRecipients(CHANNEL, BID, [], 50);
    expect(res.added).toBe(0);
  });
});

describe('sendBroadcast / cancelBroadcast', () => {
  it('send dispara e devolve os contadores do Zernio', async () => {
    server.use(
      http.post(`${BASE}/broadcasts/${BID}/send`, () =>
        HttpResponse.json({
          success: true,
          status: 'sending',
          sent: 0,
          failed: 0,
          recipientCount: 50,
        }),
      ),
    );
    const { client } = makeClient();
    const res = await client.sendBroadcast(CHANNEL, BID);
    expect(res.recipientCount).toBe(50);
    expect(res.status).toBe('sending');
  });

  it('★ cancel é o KILL-SWITCH: aborta o disparo em voo', async () => {
    let cancelled = false;
    server.use(
      http.post(`${BASE}/broadcasts/${BID}/cancel`, () => {
        cancelled = true;
        return HttpResponse.json({ success: true, status: 'cancelled' });
      }),
    );
    const { client } = makeClient();
    await expect(client.cancelBroadcast(CHANNEL, BID)).resolves.toBe(true);
    expect(cancelled).toBe(true);
  });

  it('cancel de um disparo que já terminou (404/409) => false, NUNCA explode', async () => {
    // O kill-switch roda em best-effort sobre N disparos: um que já acabou não
    // pode derrubar o cancelamento dos outros.
    server.use(
      http.post(`${BASE}/broadcasts/${BID}/cancel`, () =>
        HttpResponse.json({ error: 'broadcast already completed' }, { status: 409 }),
      ),
    );
    const { client } = makeClient();
    await expect(client.cancelBroadcast(CHANNEL, BID)).resolves.toBe(false);
  });
});

describe('listRecipients — a FONTE DA VERDADE do status (polling, não webhook)', () => {
  it('normaliza status/wamid/erro/timestamps por destinatário', async () => {
    server.use(
      http.get(`${BASE}/broadcasts/${BID}/recipients`, () =>
        HttpResponse.json({
          recipients: [
            {
              phone: '+5592991110001',
              status: 'delivered',
              messageId: 'wamid.HBgN1',
              sentAt: '2026-07-13T10:00:00Z',
              deliveredAt: '2026-07-13T10:00:05Z',
            },
            {
              phone: '5592991110002',
              status: 'failed',
              errorCode: 131026,
              errorExplanation: 'Message undeliverable',
            },
          ],
          pagination: { hasMore: false, total: 2 },
        }),
      ),
    );

    const { client } = makeClient();
    const page = await client.listRecipients(CHANNEL, BID, 0);

    expect(page.hasMore).toBe(false);
    expect(page.items).toHaveLength(2);
    expect(page.items[0]).toMatchObject({
      phone: '+5592991110001',
      status: 'delivered',
      messageId: 'wamid.HBgN1',
    });
    // errorCode vira STRING — é assim que o orgamind casa com os mappers da Meta.
    expect(page.items[1]).toMatchObject({
      phone: '+5592991110002', // normalizado para E.164 com '+'
      status: 'failed',
      errorCode: '131026',
      messageId: null,
    });
  });

  it('status desconhecido do Zernio não derruba a página inteira — vira null', async () => {
    server.use(
      http.get(`${BASE}/broadcasts/${BID}/recipients`, () =>
        HttpResponse.json({
          recipients: [
            { phone: '+5592991110003', status: 'quantum_superposition' },
            { phone: '+5592991110004', status: 'sent', messageId: 'wamid.X' },
          ],
          pagination: { hasMore: false },
        }),
      ),
    );

    const { client } = makeClient();
    const page = await client.listRecipients(CHANNEL, BID, 0);
    expect(page.items).toHaveLength(2);
    expect(page.items[0].status).toBeNull();
    expect(page.items[1].status).toBe('sent');
  });

  // ── ZW — O QUE O `/recipients` DEVOLVE DE VERDADE ────────────────────────
  //
  // Sondagem AO VIVO (13/07, conta de produção). O endpoint devolve, por
  // destinatário, EXATAMENTE isto — e nada mais:
  //
  //   { id, contactId, channelId, platformIdentifier, contactName,
  //     status, errorExplanation }
  //
  // NÃO existe `messageId` (o wamid). NÃO existem `sentAt`/`deliveredAt`/
  // `readAt`. NÃO existe `errorCode`. O telefone vem em `platformIdentifier` —
  // e NÃO num campo `phone`, que era o que o cliente procurava (e não achava:
  // sem telefone, `parseRecipient` DESCARTAVA a linha inteira e o polling não
  // reconciliava ninguém).
  it('ZW: lê o telefone de `platformIdentifier` — o shape REAL da API', async () => {
    server.use(
      http.get(`${BASE}/broadcasts/${BID}/recipients`, () =>
        HttpResponse.json({
          recipients: [
            {
              id: 'a1b2c3d4e5f6a7b8c9d00008',
              contactId: 'a1b2c3d4e5f6a7b8c9d00006',
              channelId: 'a1b2c3d4e5f6a7b8c9d00007',
              platformIdentifier: '5592995550101',
              contactName: '+5592995550101',
              status: 'pending',
              errorExplanation: null,
            },
            {
              id: 'a1b2c3d4e5f6a7b8c9d00009',
              platformIdentifier: '5592991110002',
              contactName: '+5592991110002',
              status: 'failed',
              errorExplanation: 'Message undeliverable',
            },
          ],
          pagination: { hasMore: false, total: 2 },
        }),
      ),
    );

    const { client } = makeClient();
    const page = await client.listRecipients(CHANNEL, BID, 0);

    expect(page.items).toHaveLength(2);
    // O telefone, normalizado para E.164 — casado com Contact.phoneE164.
    expect(page.items[0]).toMatchObject({
      phone: '+5592995550101',
      status: 'pending',
    });
    expect(page.items[1]).toMatchObject({
      phone: '+5592991110002',
      status: 'failed',
      errorExplanation: 'Message undeliverable',
    });
    // E o que a API NÃO dá — e que o desenho antigo assumia que dava.
    expect(page.items[1].errorCode).toBeNull();
  });
});
