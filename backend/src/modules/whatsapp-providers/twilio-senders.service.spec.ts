import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { ConfigService } from '@nestjs/config';
import {
  TwilioSendersService,
  parseMessagingLimit,
} from './twilio-senders.service';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const ACCOUNT_SID = 'AC00000000000000000000000000000000';
const AUTH_TOKEN = 'the-auth-token';
const BASE = 'https://messaging.twilio.com';
const LIST_URL = `${BASE}/v2/Channels/Senders`;

function makeConfig(overrides: Record<string, string | undefined> = {}) {
  const values: Record<string, string | undefined> = {
    TWILIO_ACCOUNT_SID: ACCOUNT_SID,
    TWILIO_AUTH_TOKEN: AUTH_TOKEN,
    ...overrides,
  };
  return { get: (k: string) => values[k] } as unknown as ConfigService;
}

/** Um sender WhatsApp como a Senders API v2 retorna. */
function rawSender(overrides: Record<string, unknown> = {}) {
  return {
    sid: 'XE00000000000000000000000000000001',
    sender_id: 'whatsapp:+5592111111111',
    status: 'ONLINE',
    properties: {
      messaging_limit: '1K Customers/24hr',
      quality_rating: 'HIGH',
    },
    ...overrides,
  };
}

// T8 — mapa do tier: "250"→250, "1K"→1000, "10K"→10000, "100K"→100000,
// "UNLIMITED"→1000000; "Unavailable"/desconhecido → null (não mexe).
describe('parseMessagingLimit', () => {
  it.each([
    ['250 Customers/24hr', 250],
    ['250', 250],
    ['1K Customers/24hr', 1000],
    ['10K Customers/24hr', 10000],
    ['100K Customers/24hr', 100000],
    ['UNLIMITED', 1000000],
    ['Unlimited Customers/24hr', 1000000],
  ])('mapeia %s → %i', (raw, expected) => {
    expect(parseMessagingLimit(raw)).toBe(expected);
  });

  it.each(['Unavailable', 'garbage', '', undefined])(
    'retorna null para %s (não mexe no canal)',
    (raw) => {
      expect(parseMessagingLimit(raw as string | undefined)).toBeNull();
    },
  );
});

describe('TwilioSendersService.listSenders', () => {
  it('GET /v2/Channels/Senders?Channel=whatsapp com Basic auth e mapeia sid/sender_id/limit/quality', async () => {
    let seenAuth: string | null = null;
    let seenChannel: string | null = null;
    server.use(
      http.get(LIST_URL, ({ request }) => {
        seenAuth = request.headers.get('authorization');
        seenChannel = new URL(request.url).searchParams.get('Channel');
        return HttpResponse.json({
          senders: [rawSender()],
          meta: { next_page_url: null },
        });
      }),
    );

    const svc = new TwilioSendersService(makeConfig());
    const senders = await svc.listSenders();

    const expectedAuth = `Basic ${Buffer.from(`${ACCOUNT_SID}:${AUTH_TOKEN}`).toString('base64')}`;
    expect(seenAuth).toBe(expectedAuth);
    expect(seenChannel).toBe('whatsapp');
    expect(senders).toEqual([
      {
        sid: 'XE00000000000000000000000000000001',
        senderId: 'whatsapp:+5592111111111',
        phoneE164: '+5592111111111',
        messagingLimit: '1K Customers/24hr',
        qualityRating: 'HIGH',
      },
    ]);
  });

  it('segue meta.next_page_url até esgotar (paginação)', async () => {
    server.use(
      http.get(LIST_URL, ({ request }) => {
        const url = new URL(request.url);
        if (url.searchParams.get('PageToken') === 'tok2') {
          return HttpResponse.json({
            senders: [
              rawSender({
                sid: 'XE00000000000000000000000000000002',
                sender_id: 'whatsapp:+5592222222222',
              }),
            ],
            meta: { next_page_url: null },
          });
        }
        return HttpResponse.json({
          senders: [rawSender()],
          meta: { next_page_url: `${LIST_URL}?Channel=whatsapp&PageToken=tok2` },
        });
      }),
    );

    const svc = new TwilioSendersService(makeConfig());
    const senders = await svc.listSenders();
    expect(senders.map((s) => s.sid)).toEqual([
      'XE00000000000000000000000000000001',
      'XE00000000000000000000000000000002',
    ]);
  });

  it('item malformado (sem sid/sender_id) é pulado sem abortar a lista', async () => {
    server.use(
      http.get(LIST_URL, () =>
        HttpResponse.json({
          senders: [{ bogus: true }, rawSender()],
          meta: { next_page_url: null },
        }),
      ),
    );
    const svc = new TwilioSendersService(makeConfig());
    const senders = await svc.listSenders();
    expect(senders).toHaveLength(1);
  });

  it('configured=false sem o grupo de credenciais Twilio', () => {
    const svc = new TwilioSendersService(
      makeConfig({ TWILIO_ACCOUNT_SID: undefined, TWILIO_AUTH_TOKEN: undefined }),
    );
    expect(svc.configured).toBe(false);
  });
});
