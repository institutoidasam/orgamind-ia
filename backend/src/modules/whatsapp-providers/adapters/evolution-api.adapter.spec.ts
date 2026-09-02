import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  afterEach,
  beforeEach,
  vi,
} from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { ConfigService } from '@nestjs/config';
import { EvolutionApiAdapter } from './evolution-api.adapter';
import { WhatsappSendError } from '../errors/whatsapp.errors';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const config = {
  get: (k: string) =>
    ({
      EVOLUTION_BASE_URL: 'http://evolution:8080',
      EVOLUTION_API_KEY: 'KEY',
      EVOLUTION_INSTANCE_NAME: 'picoa-test',
    })[k],
} as unknown as ConfigService;

describe('EvolutionApiAdapter', () => {
  const adapter = new EvolutionApiAdapter(config);

  it('has name "evolution"', () => {
    expect(adapter.name).toBe('evolution');
  });

  it('declara o profile completo de provider de sessão', () => {
    expect(adapter.profile.traits).toEqual({ official: false, sessionBased: true, sessionWindow: false });
    for (const cap of ['campaignSend', 'sessionLifecycle', 'inboxChat', 'chatMedia', 'contactTools', 'labels', 'historySync'] as const) {
      expect(adapter.profile.capabilities.has(cap)).toBe(true);
    }
    expect(adapter.profile.capabilities.has('statusPolling')).toBe(false);
  });

  it('sends rendered text via /message/sendText', async () => {
    server.use(
      http.post(
        'http://evolution:8080/message/sendText/picoa-test',
        async ({ request }) => {
          const body = (await request.json()) as Record<string, unknown>;
          expect(body.number).toBe('5592987654321');
          expect(body.text).toBe('Olá João!');
          return HttpResponse.json({ key: { id: 'evo_msg_1' } });
        },
      ),
    );
    const r = await adapter.sendTemplate({
      toE164: '+5592987654321',
      templateName: 'Olá {{1}}!',
      language: 'pt_BR',
      variables: { '1': 'João' },
    });
    expect(r.providerMessageId).toBe('evo_msg_1');
  });

  it('ignores per-channel Twilio sender fields (sends plain Evolution text)', async () => {
    server.use(
      http.post(
        'http://evolution:8080/message/sendText/picoa-test',
        async ({ request }) => {
          const body = (await request.json()) as Record<string, unknown>;
          // Evolution resolves its sender from the instance; the Twilio-only
          // per-channel sender fields must never appear in the payload.
          expect(body.number).toBe('5592987654321');
          expect(body.text).toBe('Olá João!');
          expect(body.From).toBeUndefined();
          expect(body.MessagingServiceSid).toBeUndefined();
          expect(body.senderPhoneE164).toBeUndefined();
          expect(body.twilioMessagingServiceSid).toBeUndefined();
          return HttpResponse.json({ key: { id: 'evo_ignore' } });
        },
      ),
    );
    const r = await adapter.sendTemplate({
      toE164: '+5592987654321',
      templateName: 'Olá {{1}}!',
      language: 'pt_BR',
      variables: { '1': 'João' },
      senderPhoneE164: '+5599999999999',
      twilioMessagingServiceSid: 'MGshouldbeignored0000000000000000',
    });
    expect(r.providerMessageId).toBe('evo_ignore');
  });

  it('parses numeric ack 3 (DELIVERY_ACK) as delivered', () => {
    const events = adapter.parseWebhook({ data: { key: { id: 'evo_X' }, status: 3 } });
    expect(events[0]).toMatchObject({
      providerMessageId: 'evo_X',
      status: 'delivered',
    });
  });

  it('parses numeric ack 4 (READ) as read', () => {
    const events = adapter.parseWebhook({ data: { key: { id: 'evo_R' }, status: 4 } });
    expect(events[0]?.status).toBe('read');
  });

  it('parses string status DELIVERY_ACK as delivered', () => {
    const events = adapter.parseWebhook({
      data: { key: { id: 'evo_Y' }, status: 'DELIVERY_ACK' },
    });
    expect(events[0]?.status).toBe('delivered');
  });

  it('accepts data.keyId fallback (messages.update payload shape)', () => {
    const events = adapter.parseWebhook({
      event: 'messages.update',
      data: { keyId: 'evo_Z', status: 'READ' },
    });
    expect(events[0]).toMatchObject({ providerMessageId: 'evo_Z', status: 'read' });
  });

  it('returns empty for malformed webhook', () => {
    expect(adapter.parseWebhook({})).toEqual([]);
  });

  it('returns empty for unknown numeric status', () => {
    const events = adapter.parseWebhook({ data: { key: { id: 'x' }, status: 99 } });
    expect(events).toEqual([]);
  });

  it('parses inbound text message', () => {
    const events = adapter.parseInboundMessages({
      event: 'messages.upsert',
      data: {
        key: { id: 'in_1', remoteJid: '5511987654321@s.whatsapp.net', fromMe: false },
        message: { conversation: 'Olá!' },
        messageTimestamp: 1700000000,
      },
    });
    expect(events[0]).toMatchObject({
      providerMessageId: 'in_1',
      fromE164: '+5511987654321',
      text: 'Olá!',
    });
  });

  it('ignores own outbound messages in inbound parser', () => {
    const events = adapter.parseInboundMessages({
      data: { key: { id: 'mine', remoteJid: '5511987654321@s.whatsapp.net', fromMe: true } },
    });
    expect(events).toEqual([]);
  });
});

/**
 * Section below covers everything the original spec didn't: list/buttons/poll
 * sends, getConnectionInfo (incl. QR caching + cache TTL), settings, labels,
 * profile picture, number validation, additional inbound parse branches, and
 * error classification routing.
 *
 * Pattern: stub the private axios `http` instance directly with vi.fn()s. Two
 * reasons: (a) finer-grained per-test mocking than MSW, (b) lets us assert on
 * the URL/body each call received without a request handler dance.
 */
describe('EvolutionApiAdapter — extended coverage', () => {
  let adapter: EvolutionApiAdapter;
  let post: ReturnType<typeof vi.fn>;
  let get: ReturnType<typeof vi.fn>;
  let del: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    adapter = new EvolutionApiAdapter(config);
    post = vi.fn();
    get = vi.fn();
    del = vi.fn();
    (adapter as unknown as { http: unknown }).http = {
      post,
      get,
      delete: del,
    };
    vi.useRealTimers();
  });

  // -------------- sendTemplate: LIST/BUTTONS/POLL --------------

  describe('sendTemplate — interactive kinds', () => {
    it('LIST: posts to /message/sendList with interpolated payload', async () => {
      post.mockResolvedValueOnce({ data: { key: { id: 'list_1' } } });
      const r = await adapter.sendTemplate({
        toE164: '+5592987654321',
        templateName: 'tpl',
        language: 'pt_BR',
        kind: 'LIST',
        variables: { name: 'Ana', city: 'Manaus' },
        delay: 1500,
        interactiveConfig: {
          title: 'Olá {{name}}',
          description: 'Cidade: {{city}}',
          buttonText: 'Ver opções',
          footerText: 'rodapé {{name}}',
          sections: [
            {
              title: 'Seção {{name}}',
              rows: [
                { rowId: 'r1', title: 'Linha {{name}}', description: 'desc {{city}}' },
                { rowId: 'r2', title: 'Linha 2' }, // no description -> defaults to ''
              ],
            },
          ],
        },
      });
      expect(r.providerMessageId).toBe('list_1');
      expect(post).toHaveBeenCalledTimes(1);
      const [url, payload] = post.mock.calls[0] as [string, Record<string, unknown>];
      expect(url).toBe('/message/sendList/picoa-test');
      expect(payload).toMatchObject({
        number: '5592987654321',
        delay: 1500,
        title: 'Olá Ana',
        description: 'Cidade: Manaus',
        buttonText: 'Ver opções',
        footerText: 'rodapé Ana',
        values: [
          {
            title: 'Seção Ana',
            rows: [
              { rowId: 'r1', title: 'Linha Ana', description: 'desc Manaus' },
              { rowId: 'r2', title: 'Linha 2', description: '' },
            ],
          },
        ],
      });
    });

    it('BUTTONS: posts to /message/sendButtons with mapped buttons', async () => {
      post.mockResolvedValueOnce({ data: { messageId: 'btn_1' } });
      const r = await adapter.sendTemplate({
        toE164: '+5592987654321',
        templateName: 'tpl',
        language: 'pt_BR',
        kind: 'BUTTONS',
        variables: { who: 'João' },
        interactiveConfig: {
          title: 'Olá {{who}}',
          description: 'Escolha {{who}}',
          footerText: 'rodapé',
          buttons: [
            { buttonId: 'b1', title: 'Sim {{who}}' },
            { buttonId: 'b2', title: 'Não' },
          ],
        },
      });
      expect(r.providerMessageId).toBe('btn_1');
      const [url, payload] = post.mock.calls[0] as [string, Record<string, unknown>];
      expect(url).toBe('/message/sendButtons/picoa-test');
      expect(payload).toMatchObject({
        number: '5592987654321',
        delay: 0,
        title: 'Olá João',
        description: 'Escolha João',
        footerText: 'rodapé',
        buttons: [
          { buttonId: 'b1', buttonText: { displayText: 'Sim João' }, type: 1 },
          { buttonId: 'b2', buttonText: { displayText: 'Não' }, type: 1 },
        ],
      });
    });

    it('POLL: posts to /message/sendPoll with name/selectableCount/values', async () => {
      post.mockResolvedValueOnce({ data: { key: { id: 'poll_1' } } });
      const r = await adapter.sendTemplate({
        toE164: '+5592987654321',
        templateName: 'tpl',
        language: 'pt_BR',
        kind: 'POLL',
        variables: { topic: 'almoço' },
        interactiveConfig: {
          question: 'Qual {{topic}}?',
          selectableOptionsCount: 2,
          options: ['Opção {{topic}}', 'Outra'],
        },
      });
      expect(r.providerMessageId).toBe('poll_1');
      const [url, payload] = post.mock.calls[0] as [string, Record<string, unknown>];
      expect(url).toBe('/message/sendPoll/picoa-test');
      expect(payload).toMatchObject({
        number: '5592987654321',
        delay: 0,
        name: 'Qual almoço?',
        selectableCount: 2,
        values: ['Opção almoço', 'Outra'],
      });
    });

    it('throws WhatsappSendError on unsupported kind', async () => {
      await expect(
        adapter.sendTemplate({
          toE164: '+5592987654321',
          templateName: 'tpl',
          language: 'pt_BR',
          // @ts-expect-error — intentional invalid kind
          kind: 'WEIRD',
          variables: {},
        }),
      ).rejects.toThrow(WhatsappSendError);
    });

    it('classifies axios error message via the error mapper', async () => {
      post.mockRejectedValueOnce({
        response: { data: { message: 'rate-overlimit' } },
      });
      await expect(
        adapter.sendTemplate({
          toE164: '+5592987654321',
          templateName: 'oi',
          language: 'pt_BR',
          variables: {},
        }),
      ).rejects.toMatchObject({
        providerErrorCode: 'evolution.rate_limited',
        fatal: false,
      });
    });

    it('throws when the send response has no message id', async () => {
      post.mockResolvedValueOnce({ data: { key: {} } });
      await expect(
        adapter.sendTemplate({
          toE164: '+5592987654321',
          templateName: 'oi',
          language: 'pt_BR',
          variables: {},
        }),
      ).rejects.toThrow(WhatsappSendError);
    });

    it('handles array message in axios error data (joined)', async () => {
      post.mockRejectedValueOnce({
        response: { data: { message: ['Connection Closed', { reason: 'replaced' }] } },
      });
      await expect(
        adapter.sendTemplate({
          toE164: '+5592987654321',
          templateName: 'oi',
          language: 'pt_BR',
          variables: {},
        }),
      ).rejects.toMatchObject({ providerErrorCode: 'evolution.session_closed' });
    });

    it('falls back to err.message when response data missing', async () => {
      post.mockRejectedValueOnce({ message: 'ECONNREFUSED' });
      await expect(
        adapter.sendTemplate({
          toE164: '+5592987654321',
          templateName: 'oi',
          language: 'pt_BR',
          variables: {},
        }),
      ).rejects.toMatchObject({ providerErrorCode: 'evolution.unreachable' });
    });
  });

  // -------------- getConnectionInfo --------------

  describe('getConnectionInfo', () => {
    it('returns state=open and no QR when socket open and no disconnection record', async () => {
      get.mockImplementation((url: string) => {
        if (url.includes('/instance/connectionState/'))
          return Promise.resolve({ data: { instance: { state: 'open' } } });
        if (url.includes('/instance/fetchInstances')) return Promise.resolve({ data: [] });
        return Promise.reject(new Error(`unexpected ${url}`));
      });
      const info = await adapter.getConnectionInfo();
      expect(info).toMatchObject({
        state: 'open',
        disconnectionReasonCode: null,
        disconnectionAt: null,
      });
    });

    it('returns QR + pairingCode when state is connecting', async () => {
      get.mockImplementation((url: string) => {
        if (url.includes('/instance/connectionState/'))
          return Promise.resolve({ data: { state: 'connecting' } });
        if (url.includes('/instance/fetchInstances')) return Promise.resolve({ data: [] });
        if (url.includes('/instance/connect/'))
          return Promise.resolve({ data: { base64: 'BASE64', pairingCode: 'AB12-CD34' } });
        return Promise.reject(new Error(`unexpected ${url}`));
      });
      const info = await adapter.getConnectionInfo();
      expect(info).toMatchObject({
        state: 'connecting',
        qrBase64: 'BASE64',
        pairingCode: 'AB12-CD34',
      });
    });

    it('caches QR within QR_CACHE_MS — only one /instance/connect hit', async () => {
      get.mockImplementation((url: string) => {
        if (url.includes('/instance/connectionState/'))
          return Promise.resolve({ data: { state: 'close' } });
        if (url.includes('/instance/fetchInstances')) return Promise.resolve({ data: [] });
        if (url.includes('/instance/connect/'))
          return Promise.resolve({ data: { base64: 'B1', pairingCode: 'P1' } });
        return Promise.reject(new Error(`unexpected ${url}`));
      });
      await adapter.getConnectionInfo();
      await adapter.getConnectionInfo();
      const connectCalls = get.mock.calls.filter((c: unknown[]) =>
        (c[0] as string).includes('/instance/connect/'),
      );
      expect(connectCalls).toHaveLength(1);
    });

    it('does NOT serve one instance QR to another — cache is per-instance', async () => {
      // Prod bug: two WhatsApp numbers connected within the 25s cache window.
      // The QR/pairingCode is cached per-process; if it is not keyed by instance
      // name, polling instance B returns instance A's QR (the operator scans the
      // wrong number and B never pairs). Both instances are unpaired (close);
      // /instance/connect returns a QR keyed by the instance name in the URL so
      // we can prove each dialog received its OWN QR.
      get.mockImplementation((url: string) => {
        if (url.includes('/instance/connectionState/'))
          return Promise.resolve({ data: { state: 'close' } });
        if (url.includes('/instance/fetchInstances')) return Promise.resolve({ data: [] });
        if (url.includes('/instance/connect/picoa-a'))
          return Promise.resolve({ data: { base64: 'QR-A', pairingCode: 'PC-A' } });
        if (url.includes('/instance/connect/picoa-b'))
          return Promise.resolve({ data: { base64: 'QR-B', pairingCode: 'PC-B' } });
        return Promise.reject(new Error(`unexpected ${url}`));
      });

      const a = await adapter.getConnectionInfo('picoa-a');
      const b = await adapter.getConnectionInfo('picoa-b');

      expect(a.qrBase64).toBe('QR-A');
      expect(a.pairingCode).toBe('PC-A');
      // The bug returns 'QR-A' here (A's cached QR bleeding into B).
      expect(b.qrBase64).toBe('QR-B');
      expect(b.pairingCode).toBe('PC-B');
    });

    it('refreshes QR after cache TTL expires', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      let connectCount = 0;
      get.mockImplementation((url: string) => {
        if (url.includes('/instance/connectionState/'))
          return Promise.resolve({ data: { state: 'close' } });
        if (url.includes('/instance/fetchInstances')) return Promise.resolve({ data: [] });
        if (url.includes('/instance/connect/')) {
          connectCount += 1;
          return Promise.resolve({ data: { base64: `B${connectCount}` } });
        }
        return Promise.reject(new Error(`unexpected ${url}`));
      });
      await adapter.getConnectionInfo();
      vi.setSystemTime(new Date('2026-01-01T00:00:30Z')); // > 25s TTL
      await adapter.getConnectionInfo();
      expect(connectCount).toBe(2);
    });

    it('surfaces disconnectionReasonCode + disconnectionAt from fetchInstances match', async () => {
      get.mockImplementation((url: string) => {
        if (url.includes('/instance/connectionState/'))
          return Promise.resolve({ data: { state: 'open' } });
        if (url.includes('/instance/fetchInstances'))
          return Promise.resolve({
            data: [
              {
                name: 'picoa-test',
                disconnectionReasonCode: 401,
                disconnectionAt: '2026-01-01T00:00:00Z',
              },
            ],
          });
        return Promise.reject(new Error(`unexpected ${url}`));
      });
      const info = await adapter.getConnectionInfo();
      expect(info.disconnectionReasonCode).toBe(401);
      expect(info.disconnectionAt).toBe('2026-01-01T00:00:00Z');
    });

    it('extracts ownerJid, profileName, profilePictureUrl from fetchInstances when state=open', async () => {
      get.mockImplementation((url: string) => {
        if (url.includes('/instance/connectionState/'))
          return Promise.resolve({ data: { instance: { state: 'open' } } });
        if (url.includes('/instance/fetchInstances'))
          return Promise.resolve({
            data: [
              {
                name: 'picoa-test',
                ownerJid: '5592987654321@s.whatsapp.net',
                profileName: 'Test User',
                profilePicUrl: 'https://example.com/pic.jpg',
              },
            ],
          });
        return Promise.reject(new Error(`unexpected ${url}`));
      });
      const info = await adapter.getConnectionInfo();
      expect(info.ownerJid).toBe('5592987654321@s.whatsapp.net');
      expect(info.profileName).toBe('Test User');
      expect(info.profilePictureUrl).toBe('https://example.com/pic.jpg');
    });

    it('returns stale cache when /instance/connect fails and we have one', async () => {
      // First call: succeed, cache QR.
      get.mockImplementation((url: string) => {
        if (url.includes('/instance/connectionState/'))
          return Promise.resolve({ data: { state: 'close' } });
        if (url.includes('/instance/fetchInstances')) return Promise.resolve({ data: [] });
        if (url.includes('/instance/connect/'))
          return Promise.resolve({ data: { base64: 'CACHED', pairingCode: 'CODE' } });
        return Promise.reject(new Error(`unexpected ${url}`));
      });
      await adapter.getConnectionInfo();
      // Second call after TTL: connect rejects, cached values are returned.
      vi.useFakeTimers();
      vi.setSystemTime(Date.now() + 60_000);
      get.mockImplementation((url: string) => {
        if (url.includes('/instance/connectionState/'))
          return Promise.resolve({ data: { state: 'close' } });
        if (url.includes('/instance/fetchInstances')) return Promise.resolve({ data: [] });
        if (url.includes('/instance/connect/')) return Promise.reject(new Error('boom'));
        return Promise.reject(new Error(`unexpected ${url}`));
      });
      const info = await adapter.getConnectionInfo();
      expect(info.qrBase64).toBe('CACHED');
      expect(info.pairingCode).toBe('CODE');
    });

    it('returns bare state when no cache and connect fails', async () => {
      get.mockImplementation((url: string) => {
        if (url.includes('/instance/connectionState/'))
          return Promise.resolve({ data: { state: 'close' } });
        if (url.includes('/instance/fetchInstances')) return Promise.resolve({ data: [] });
        if (url.includes('/instance/connect/')) return Promise.reject(new Error('boom'));
        return Promise.reject(new Error(`unexpected ${url}`));
      });
      const info = await adapter.getConnectionInfo();
      expect(info).toMatchObject({
        state: 'close',
        disconnectionReasonCode: null,
        disconnectionAt: null,
      });
    });

    it('tolerates connectionState fetch failure and falls back to close', async () => {
      get.mockImplementation((url: string) => {
        if (url.includes('/instance/connectionState/')) return Promise.reject(new Error('down'));
        if (url.includes('/instance/fetchInstances')) return Promise.resolve({ data: [] });
        if (url.includes('/instance/connect/')) return Promise.resolve({ data: {} });
        return Promise.reject(new Error(`unexpected ${url}`));
      });
      const info = await adapter.getConnectionInfo();
      expect(info.state).toBe('close');
    });
  });

  // -------------- ensureProvisioned / adminCreateInstance webhook --------------

  describe('ensureProvisioned', () => {
    it('clears only the provisioned instance QR cache, not other instances', async () => {
      post.mockResolvedValue({ data: {} });
      get.mockImplementation((url: string) => {
        if (url.includes('/instance/connectionState/'))
          return Promise.resolve({ data: { state: 'close' } });
        if (url.includes('/instance/fetchInstances')) return Promise.resolve({ data: [] });
        if (url.includes('/instance/connect/picoa-b'))
          return Promise.resolve({ data: { base64: 'QR-B' } });
        return Promise.reject(new Error(`unexpected ${url}`));
      });

      // Prime B's QR cache (one /instance/connect/picoa-b).
      await adapter.getConnectionInfo('picoa-b');

      // Provisioning a different, missing instance A must not evict B's cache.
      await adapter.ensureProvisioned('picoa-a');
      await adapter.getConnectionInfo('picoa-b');

      const connectBCalls = get.mock.calls.filter((c: unknown[]) =>
        (c[0] as string).includes('/instance/connect/picoa-b'),
      );
      expect(connectBCalls).toHaveLength(1);
    });

    it('creates the instance + arms the webhook when Evolution does not know it', async () => {
      get.mockImplementation((url: string) =>
        url.includes('/instance/fetchInstances')
          ? Promise.resolve({ data: [] })
          : Promise.reject(new Error(`unexpected ${url}`)),
      );
      post.mockResolvedValue({ data: {} });

      await adapter.ensureProvisioned('picoa-test');

      const createCall = post.mock.calls.find((c: unknown[]) => c[0] === '/instance/create');
      expect(createCall).toBeDefined();
      expect(createCall![1]).toMatchObject({ instanceName: 'picoa-test', integration: 'WHATSAPP-BAILEYS' });
      const webhookCall = post.mock.calls.find((c: unknown[]) => c[0] === '/webhook/set/picoa-test');
      expect(webhookCall).toBeDefined();
      expect((webhookCall![1] as { webhook: { events: string[] } }).webhook.events).toContain('CONNECTION_UPDATE');
    });

    it('is a no-op when the instance already exists', async () => {
      get.mockImplementation((url: string) =>
        url.includes('/instance/fetchInstances')
          ? Promise.resolve({ data: [{ name: 'picoa-test' }] })
          : Promise.reject(new Error(`unexpected ${url}`)),
      );
      post.mockResolvedValue({ data: {} });

      await adapter.ensureProvisioned('picoa-test');

      expect(post.mock.calls.some((c: unknown[]) => c[0] === '/instance/create')).toBe(false);
      expect(post.mock.calls.some((c: unknown[]) => c[0] === '/webhook/set/picoa-test')).toBe(false);
    });

    it('assumes the instance exists on a transient fetch error (never duplicate-creates)', async () => {
      get.mockRejectedValue(new Error('503'));
      post.mockResolvedValue({ data: {} });

      await adapter.ensureProvisioned('picoa-test');

      expect(post.mock.calls.some((c: unknown[]) => c[0] === '/instance/create')).toBe(false);
    });

    it('creates + arms the webhook when fetchInstances 404s the name filter (Evolution v2 reports a missing instance as 404, not [])', async () => {
      get.mockImplementation((url: string) =>
        url.includes('/instance/fetchInstances')
          ? Promise.reject(
              Object.assign(new Error('Request failed with status code 404'), {
                response: { status: 404 },
              }),
            )
          : Promise.reject(new Error(`unexpected ${url}`)),
      );
      post.mockResolvedValue({ data: {} });

      await adapter.ensureProvisioned('picoa-test');

      expect(post.mock.calls.some((c: unknown[]) => c[0] === '/instance/create')).toBe(true);
      expect(post.mock.calls.some((c: unknown[]) => c[0] === '/webhook/set/picoa-test')).toBe(true);
    });
  });

  describe('adminCreateInstance', () => {
    it('arms the webhook after creating so CONNECTION_UPDATE events flow', async () => {
      post.mockImplementation((url: string) =>
        url === '/instance/create'
          ? Promise.resolve({ data: { hash: { apikey: 'k' } } })
          : Promise.resolve({ data: {} }),
      );

      await adapter.adminCreateInstance({ instanceName: 'picoa-test' });

      const webhookCall = post.mock.calls.find((c: unknown[]) => c[0] === '/webhook/set/picoa-test');
      expect(webhookCall).toBeDefined();
    });

    // be-whatsapp-003: the per-instance Evolution apiKey is a dead secret — all
    // adapter calls authenticate with the global EVOLUTION_API_KEY (header set
    // in the constructor), and A5 already stops it leaking on read responses.
    // So adminCreateInstance must NOT surface the real key to the caller (the
    // service would otherwise persist it), shrinking the attack surface.
    it('does NOT return the real per-instance apiKey (be-whatsapp-003: dead secret not persisted)', async () => {
      post.mockImplementation((url: string) =>
        url === '/instance/create'
          ? Promise.resolve({ data: { hash: { apikey: 'super-secret-key' } } })
          : Promise.resolve({ data: {} }),
      );

      const r = await adapter.adminCreateInstance({ instanceName: 'picoa-test' });

      expect(r.apiKey).not.toBe('super-secret-key');
      expect(r.apiKey).toBe('');
    });

    // The instance must still be created even when Evolution's create response
    // omits the hash — the apiKey is no longer load-bearing, so a missing key
    // must not abort provisioning.
    it('still provisions when Evolution returns no apikey (key no longer required)', async () => {
      post.mockImplementation((url: string) =>
        url === '/instance/create'
          ? Promise.resolve({ data: {} })
          : Promise.resolve({ data: {} }),
      );

      const r = await adapter.adminCreateInstance({ instanceName: 'picoa-test' });

      expect(r.apiKey).toBe('');
      const createCall = post.mock.calls.find((c: unknown[]) => c[0] === '/instance/create');
      expect(createCall).toBeDefined();
      const webhookCall = post.mock.calls.find((c: unknown[]) => c[0] === '/webhook/set/picoa-test');
      expect(webhookCall).toBeDefined();
    });

    // Prod outage this guards: the default instance had no webhook armed and
    // nothing was ever sent (see the comment on ensureWebhookConfigured's
    // caller). Without CONNECTION_UPDATE deliveries the backend never records
    // a `state=open` event and the router parks every message in
    // WAITING_INSTANCE forever. This asserts the actual URL Evolution is told
    // to POST to, and the full event list — not just "some webhook call
    // happened".
    it('falls back to the Docker-internal default webhook URL when EVOLUTION_WEBHOOK_URL is not set', async () => {
      post.mockImplementation((url: string) =>
        url === '/instance/create'
          ? Promise.resolve({ data: { hash: { apikey: 'k' } } })
          : Promise.resolve({ data: {} }),
      );

      await adapter.adminCreateInstance({ instanceName: 'picoa-test' });

      const webhookCall = post.mock.calls.find((c: unknown[]) => c[0] === '/webhook/set/picoa-test');
      expect(webhookCall).toBeDefined();
      const webhookBody = webhookCall![1] as { webhook: { url: string; events: string[] } };
      expect(webhookBody.webhook.url).toBe('http://api:3000/webhooks/whatsapp');
      expect(webhookBody.webhook.events).toEqual([
        'MESSAGES_UPSERT',
        'MESSAGES_UPDATE',
        'CONNECTION_UPDATE',
        'QRCODE_UPDATED',
      ]);
    });

    it('arms the webhook at EVOLUTION_WEBHOOK_URL when configured (e.g. an ngrok tunnel for local QR testing)', async () => {
      const cfg = {
        get: (k: string) =>
          ({
            EVOLUTION_BASE_URL: 'http://evolution:8080',
            EVOLUTION_API_KEY: 'KEY',
            EVOLUTION_INSTANCE_NAME: 'picoa-test',
            EVOLUTION_WEBHOOK_URL: 'https://tunnel.example/webhooks/whatsapp',
          })[k],
      } as unknown as ConfigService;
      const a = new EvolutionApiAdapter(cfg);
      const p = vi.fn().mockResolvedValue({ data: {} });
      (a as unknown as { http: unknown }).http = { post: p, get: vi.fn(), delete: vi.fn() };

      await a.adminCreateInstance({ instanceName: 'picoa-test' });

      const webhookCall = p.mock.calls.find((c: unknown[]) => c[0] === '/webhook/set/picoa-test');
      expect(webhookCall).toBeDefined();
      const webhookBody = webhookCall![1] as { webhook: { url: string } };
      expect(webhookBody.webhook.url).toBe('https://tunnel.example/webhooks/whatsapp');
    });
  });

  // -------------- checkNumbersOnWhatsapp --------------

  describe('checkNumbersOnWhatsapp', () => {
    it('short-circuits to [] for empty input', async () => {
      const r = await adapter.checkNumbersOnWhatsapp([]);
      expect(r).toEqual([]);
      expect(post).not.toHaveBeenCalled();
    });

    it('strips leading + and posts raw digits', async () => {
      post.mockResolvedValueOnce({
        data: [
          { exists: true, jid: '5592987654321@s.whatsapp.net', number: '5592987654321' },
          { exists: false, jid: null, number: '5599999999999' },
        ],
      });
      const r = await adapter.checkNumbersOnWhatsapp(['+5592987654321', '+5599999999999']);
      const [url, body] = post.mock.calls[0] as [string, { numbers: string[] }];
      expect(url).toBe('/chat/whatsappNumbers/picoa-test');
      expect(body.numbers).toEqual(['5592987654321', '5599999999999']);
      expect(r).toHaveLength(2);
    });

    it('returns [] when response is non-array', async () => {
      post.mockResolvedValueOnce({ data: { something: 'unexpected' } });
      const r = await adapter.checkNumbersOnWhatsapp(['+5592987654321']);
      expect(r).toEqual([]);
    });
  });

  // -------------- fetchProfilePictureUrl --------------

  describe('fetchProfilePictureUrl', () => {
    it('returns the URL when present', async () => {
      post.mockResolvedValueOnce({
        data: { profilePictureUrl: 'https://wa.example/pic.jpg' },
      });
      const url = await adapter.fetchProfilePictureUrl('5592987654321@s.whatsapp.net');
      expect(url).toBe('https://wa.example/pic.jpg');
    });

    it('returns null when payload has no url', async () => {
      post.mockResolvedValueOnce({ data: {} });
      const url = await adapter.fetchProfilePictureUrl('jid');
      expect(url).toBeNull();
    });

    it('returns null on 404 without warn-logging', async () => {
      const warnSpy = vi.spyOn(
        (adapter as unknown as { logger: { warn: () => void } }).logger,
        'warn',
      );
      post.mockRejectedValueOnce({ response: { status: 404 } });
      const url = await adapter.fetchProfilePictureUrl('jid');
      expect(url).toBeNull();
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('logs warn and returns null on non-404 errors', async () => {
      const warnSpy = vi.spyOn(
        (adapter as unknown as { logger: { warn: () => void } }).logger,
        'warn',
      );
      post.mockRejectedValueOnce({ response: { status: 500 } });
      const url = await adapter.fetchProfilePictureUrl('jid');
      expect(url).toBeNull();
      expect(warnSpy).toHaveBeenCalled();
    });
  });

  // -------------- setSettings --------------

  describe('setSettings', () => {
    it('setSettings posts the body as-is to /settings/set/<instance>', async () => {
      post.mockResolvedValueOnce({ data: {} });
      await adapter.setSettings({ rejectCall: true, msgCall: 'oi' });
      const [url, body] = post.mock.calls[0] as [string, Record<string, unknown>];
      expect(url).toBe('/settings/set/picoa-test');
      expect(body).toEqual({ rejectCall: true, msgCall: 'oi' });
    });
  });

  // -------------- fetchLabels / handleContactLabel --------------

  describe('labels', () => {
    it('fetchLabels returns array as-is', async () => {
      get.mockResolvedValueOnce({
        data: [{ id: 'l1', name: 'VIP', color: '0' }],
      });
      const labels = await adapter.fetchLabels();
      expect(labels).toEqual([{ id: 'l1', name: 'VIP', color: '0' }]);
    });

    it('fetchLabels returns [] on error', async () => {
      get.mockRejectedValueOnce(new Error('down'));
      const labels = await adapter.fetchLabels();
      expect(labels).toEqual([]);
    });

    it('fetchLabels returns [] on non-array payload', async () => {
      get.mockResolvedValueOnce({ data: { unexpected: true } });
      const labels = await adapter.fetchLabels();
      expect(labels).toEqual([]);
    });

    it('handleContactLabel posts {number, labelId, action}', async () => {
      post.mockResolvedValueOnce({ data: {} });
      await adapter.handleContactLabel({
        jid: '5592987654321@s.whatsapp.net',
        labelId: 'l1',
        action: 'add',
      });
      const [url, body] = post.mock.calls[0] as [string, Record<string, unknown>];
      expect(url).toBe('/label/handleLabel/picoa-test');
      expect(body).toEqual({
        number: '5592987654321@s.whatsapp.net',
        labelId: 'l1',
        action: 'add',
      });
    });
  });

  // -------------- per-call instanceName overrides (multi-instance) --------------

  describe('per-call instanceName overrides', () => {
    it('checkNumbersOnWhatsapp uses provided instanceName', async () => {
      post.mockResolvedValueOnce({ data: [{ exists: true, jid: 'jid', number: '5511' }] });
      await adapter.checkNumbersOnWhatsapp(['+5511987654321'], 'other-instance');
      const [url] = post.mock.calls[0] as [string];
      expect(url).toBe('/chat/whatsappNumbers/other-instance');
    });

    it('checkNumbersOnWhatsapp falls back to singleton when omitted', async () => {
      post.mockResolvedValueOnce({ data: [] });
      await adapter.checkNumbersOnWhatsapp(['+5511987654321']);
      const [url] = post.mock.calls[0] as [string];
      expect(url).toBe('/chat/whatsappNumbers/picoa-test');
    });

    it('fetchProfilePictureUrl uses provided instanceName', async () => {
      post.mockResolvedValueOnce({ data: { profilePictureUrl: 'https://ex.com/p.jpg' } });
      await adapter.fetchProfilePictureUrl('jid', 'other-instance');
      const [url] = post.mock.calls[0] as [string];
      expect(url).toBe('/chat/fetchProfilePictureUrl/other-instance');
    });

    it('setSettings uses provided instanceName', async () => {
      post.mockResolvedValueOnce({ data: {} });
      await adapter.setSettings({ rejectCall: true }, 'other-instance');
      const [url] = post.mock.calls[0] as [string];
      expect(url).toBe('/settings/set/other-instance');
    });

    it('fetchLabels uses provided instanceName', async () => {
      get.mockResolvedValueOnce({ data: [] });
      await adapter.fetchLabels('other-instance');
      const [url] = get.mock.calls[0] as [string];
      expect(url).toBe('/label/findLabels/other-instance');
    });

    it('handleContactLabel uses instanceName from args when given', async () => {
      post.mockResolvedValueOnce({ data: {} });
      await adapter.handleContactLabel({
        jid: 'jid',
        labelId: 'l1',
        action: 'add',
        instanceName: 'other-instance',
      });
      const [url] = post.mock.calls[0] as [string];
      expect(url).toBe('/label/handleLabel/other-instance');
    });

    it('handleContactLabel falls back to singleton when instanceName omitted from args', async () => {
      post.mockResolvedValueOnce({ data: {} });
      await adapter.handleContactLabel({ jid: 'jid', labelId: 'l1', action: 'add' });
      const [url] = post.mock.calls[0] as [string];
      expect(url).toBe('/label/handleLabel/picoa-test');
    });
  });

  // -------------- per-call evolutionInstanceName override (sendTemplate) --------------

  describe('sendTemplate — per-call evolutionInstanceName override', () => {
    it('uses evolutionInstanceName from input when provided (overrides singleton)', async () => {
      post.mockResolvedValueOnce({ data: { key: { id: 'wamid-override' } } });

      await adapter.sendTemplate({
        toE164: '+5511999999999',
        templateName: 'test',
        language: 'pt_BR',
        variables: {},
        body: 'oi',
        evolutionInstanceName: 'override-instance',
      });

      expect(post).toHaveBeenCalled();
      const calledUrl = post.mock.calls[0]?.[0] as string;
      expect(calledUrl).toContain('override-instance');
      // Confirm it does NOT use the constructor-default 'picoa-test'
      expect(calledUrl).not.toContain('picoa-test');
    });

    it('falls back to singleton instance when evolutionInstanceName is omitted', async () => {
      post.mockResolvedValueOnce({ data: { key: { id: 'wamid-default' } } });

      await adapter.sendTemplate({
        toE164: '+5511999999999',
        templateName: 'test',
        language: 'pt_BR',
        variables: {},
        body: 'oi',
      });

      expect(post).toHaveBeenCalled();
      const calledUrl = post.mock.calls[0]?.[0] as string;
      expect(calledUrl).toContain('picoa-test');
    });
  });

  // -------------- parseInboundMessages additional branches --------------

  describe('parseInboundMessages additional branches', () => {
    it('returns [] when remoteJid missing', () => {
      const events = adapter.parseInboundMessages({
        data: { key: { id: 'x', fromMe: false }, message: { conversation: 'oi' } },
      });
      expect(events).toEqual([]);
    });

    it('returns [] when id missing', () => {
      const events = adapter.parseInboundMessages({
        data: {
          key: { remoteJid: '5511987654321@s.whatsapp.net', fromMe: false },
          message: { conversation: 'oi' },
        },
      });
      expect(events).toEqual([]);
    });

    it('extracts text from extendedTextMessage', () => {
      const events = adapter.parseInboundMessages({
        data: {
          key: { id: 'm1', remoteJid: '5511987654321@s.whatsapp.net', fromMe: false },
          message: { extendedTextMessage: { text: 'longer text' } },
        },
      });
      expect(events[0]?.text).toBe('longer text');
    });

    it('extracts text from buttonsResponseMessage', () => {
      const events = adapter.parseInboundMessages({
        data: {
          key: { id: 'm2', remoteJid: '5511987654321@s.whatsapp.net', fromMe: false },
          message: { buttonsResponseMessage: { selectedDisplayText: 'Sim' } },
        },
      });
      expect(events[0]?.text).toBe('Sim');
    });

    it('returns [] when remoteJid digits empty after stripping', () => {
      const events = adapter.parseInboundMessages({
        data: {
          key: { id: 'm3', remoteJid: '@g.us', fromMe: false },
          message: { conversation: 'oi' },
        },
      });
      expect(events).toEqual([]);
    });

    it('returns [] for null/missing data', () => {
      expect(adapter.parseInboundMessages(null)).toEqual([]);
      expect(adapter.parseInboundMessages({})).toEqual([]);
    });

    it('returns [] for a @lid address (LID digits are not a phone number)', () => {
      const events = adapter.parseInboundMessages({
        data: {
          key: { id: 'm4', remoteJid: '199887766554433@lid', fromMe: false },
          message: { conversation: 'STOP' },
        },
      });
      expect(events).toEqual([]);
    });

    it('returns [] for a @g.us group (group id is not a phone number)', () => {
      const events = adapter.parseInboundMessages({
        data: {
          key: { id: 'm5', remoteJid: '120363000000000000@g.us', fromMe: false },
          message: { conversation: 'STOP' },
        },
      });
      expect(events).toEqual([]);
    });
  });

  // -------------- listConnectionStates (F4: live-state reconcile source) --------------

  describe('listConnectionStates', () => {
    it('maps instanceName -> snapshot (state + device profile) from /instance/fetchInstances', async () => {
      get.mockResolvedValue({
        data: [
          {
            name: 'picoa-a',
            connectionStatus: 'open',
            ownerJid: '559231550102@s.whatsapp.net',
            profileName: 'ORGAMIND',
            profilePicUrl: 'https://pps.whatsapp.net/pic.jpg',
          },
          { name: 'picoa-b', connectionStatus: 'close' },
          { name: 'picoa-c', connectionStatus: 'connecting' },
        ],
      });

      const states = await adapter.listConnectionStates();

      expect(get).toHaveBeenCalledWith('/instance/fetchInstances');
      expect(states.get('picoa-a')).toEqual({
        state: 'open',
        ownerJid: '559231550102@s.whatsapp.net',
        profileName: 'ORGAMIND',
        profilePicUrl: 'https://pps.whatsapp.net/pic.jpg',
      });
      expect(states.get('picoa-b')).toEqual({
        state: 'close',
        ownerJid: null,
        profileName: null,
        profilePicUrl: null,
      });
      expect(states.get('picoa-c')?.state).toBe('connecting');
    });

    it('coerces non-string profile fields to null (never leaks junk shapes)', async () => {
      get.mockResolvedValue({
        data: [
          {
            name: 'picoa-a',
            connectionStatus: 'open',
            ownerJid: 12345, // junk — Evolution should send a string
            profileName: { nested: true },
            profilePicUrl: undefined,
          },
        ],
      });

      const states = await adapter.listConnectionStates();

      expect(states.get('picoa-a')).toEqual({
        state: 'open',
        ownerJid: null,
        profileName: null,
        profilePicUrl: null,
      });
    });

    it('skips entries missing name or connectionStatus', async () => {
      get.mockResolvedValue({
        data: [
          { name: 'picoa-a', connectionStatus: 'open' },
          { name: 'picoa-broken' }, // no connectionStatus
          { connectionStatus: 'open' }, // no name
        ],
      });

      const states = await adapter.listConnectionStates();

      expect(states.size).toBe(1);
      expect(states.get('picoa-a')?.state).toBe('open');
    });

    it('caches states within the 15s TTL — one fetch for repeated calls', async () => {
      // Status polling hits this every few seconds; the singleton adapter must
      // bound Evolution load to one fetchInstances per TTL window.
      get.mockResolvedValue({ data: [{ name: 'picoa-a', connectionStatus: 'open' }] });

      const first = await adapter.listConnectionStates();
      const second = await adapter.listConnectionStates();

      expect(get).toHaveBeenCalledTimes(1);
      expect(second.get('picoa-a')?.state).toBe('open');
      expect(second).toEqual(first);
    });

    it('refetches after the TTL expires', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      get.mockResolvedValue({ data: [{ name: 'picoa-a', connectionStatus: 'open' }] });

      await adapter.listConnectionStates();
      vi.setSystemTime(new Date('2026-01-01T00:00:20Z')); // > 15s TTL

      get.mockResolvedValue({ data: [{ name: 'picoa-a', connectionStatus: 'close' }] });
      const states = await adapter.listConnectionStates();

      expect(get).toHaveBeenCalledTimes(2);
      expect(states.get('picoa-a')?.state).toBe('close');
    });

    it('returns an empty Map (never throws) when Evolution errors', async () => {
      get.mockRejectedValue(new Error('ECONNREFUSED'));

      const states = await adapter.listConnectionStates();

      expect(states).toBeInstanceOf(Map);
      expect(states.size).toBe(0);
    });

    it('returns an empty Map on a non-array response body', async () => {
      get.mockResolvedValue({ data: { message: 'unexpected shape' } });

      const states = await adapter.listConnectionStates();

      expect(states.size).toBe(0);
    });
  });
});

// ── Declarative outbound proxy (EVOLUTION_PROXY_*) ───────────────────────────
// The proxy lives on the Evolution INSTANCE (Postgres) and is dropped whenever
// the instance is deleted+recreated, so without re-arming, a fresh instance
// would silently pair the next WhatsApp session from the VPS datacenter IP.
describe('EvolutionApiAdapter — declarative proxy', () => {
  const PROXY_ENV: Record<string, string | undefined> = {
    EVOLUTION_BASE_URL: 'http://evolution:8080',
    EVOLUTION_API_KEY: 'KEY',
    EVOLUTION_INSTANCE_NAME: 'picoa-test',
    EVOLUTION_PROXY_HOST: '203.0.113.77',
    EVOLUTION_PROXY_PORT: '10527',
    EVOLUTION_PROXY_PROTOCOL: 'socks5',
    EVOLUTION_PROXY_USERNAME: 'u1',
    EVOLUTION_PROXY_PASSWORD: 'p1',
  };
  const mkConfig = (o: Record<string, string | undefined> = {}) =>
    ({ get: (k: string) => ({ ...PROXY_ENV, ...o })[k] }) as unknown as ConfigService;

  function stub(a: EvolutionApiAdapter) {
    const post = vi.fn().mockResolvedValue({ data: {} });
    const get = vi.fn().mockResolvedValue({ data: [] });
    const del = vi.fn().mockResolvedValue({ data: {} });
    (a as unknown as { http: unknown }).http = { post, get, delete: del };
    return { post, get, del };
  }

  it('arms the proxy using Evolution ProxyDto shape (host/port/protocol + creds)', async () => {
    const a = new EvolutionApiAdapter(mkConfig());
    const { post } = stub(a);
    await a.ensureProxyConfigured('picoa-test');
    expect(post).toHaveBeenCalledWith('/proxy/set/picoa-test', {
      enabled: true,
      host: '203.0.113.77',
      port: '10527',
      protocol: 'socks5',
      username: 'u1',
      password: 'p1',
    });
  });

  it.each(['EVOLUTION_PROXY_HOST', 'EVOLUTION_PROXY_PORT', 'EVOLUTION_PROXY_PROTOCOL'])(
    'is a no-op when %s is missing (proxy stays unconfigured)',
    async (key) => {
      const a = new EvolutionApiAdapter(mkConfig({ [key]: undefined }));
      const { post } = stub(a);
      await a.ensureProxyConfigured('picoa-test');
      expect(post).not.toHaveBeenCalled();
    },
  );

  it('treats the compose empty-string default as absent', async () => {
    const a = new EvolutionApiAdapter(mkConfig({ EVOLUTION_PROXY_HOST: '' }));
    const { post } = stub(a);
    await a.ensureProxyConfigured('picoa-test');
    expect(post).not.toHaveBeenCalled();
  });

  it('omits username/password when they are blank (unauthenticated proxy)', async () => {
    const a = new EvolutionApiAdapter(
      mkConfig({ EVOLUTION_PROXY_USERNAME: '', EVOLUTION_PROXY_PASSWORD: '   ' }),
    );
    const { post } = stub(a);
    await a.ensureProxyConfigured('picoa-test');
    expect(post).toHaveBeenCalledWith('/proxy/set/picoa-test', {
      enabled: true,
      host: '203.0.113.77',
      port: '10527',
      protocol: 'socks5',
    });
  });

  it('is best-effort: a failing /proxy/set never blocks provisioning', async () => {
    const a = new EvolutionApiAdapter(mkConfig());
    (a as unknown as { http: unknown }).http = {
      post: vi.fn().mockRejectedValue(new Error('evolution down')),
      get: vi.fn(),
      delete: vi.fn(),
    };
    await expect(a.ensureProxyConfigured('picoa-test')).resolves.toBeUndefined();
  });

  it('re-arms the proxy on an ALREADY provisioned instance (self-heal on Conectar/QR)', async () => {
    const a = new EvolutionApiAdapter(mkConfig());
    const post = vi.fn().mockResolvedValue({ data: {} });
    // instanceExists -> true
    const get = vi.fn().mockResolvedValue({ data: [{ name: 'picoa-test' }] });
    (a as unknown as { http: unknown }).http = { post, get, delete: vi.fn() };

    await a.ensureProvisioned('picoa-test');

    // It must NOT recreate the instance...
    expect(post).not.toHaveBeenCalledWith('/instance/create', expect.anything());
    // ...but it MUST re-arm the proxy before the next socket is spawned.
    expect(post).toHaveBeenCalledWith(
      '/proxy/set/picoa-test',
      expect.objectContaining({ enabled: true, protocol: 'socks5' }),
    );
  });

  it('arms the proxy on a brand-new instance (Nova conexão)', async () => {
    const a = new EvolutionApiAdapter(mkConfig());
    const { post } = stub(a);
    await a.adminCreateInstance({ instanceName: 'picoa-novo' });
    expect(post).toHaveBeenCalledWith(
      '/proxy/set/picoa-novo',
      expect.objectContaining({ host: '203.0.113.77' }),
    );
  });
});
