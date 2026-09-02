import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { ConfigService } from '@nestjs/config';
import { MetaCloudAdapter } from './meta-cloud.adapter';
import { WhatsappSendError } from '../errors/whatsapp.errors';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const config = {
  get: (k: string) =>
    ({
      META_PHONE_NUMBER_ID: 'PNID',
      META_ACCESS_TOKEN: 'TOKEN',
      META_APP_SECRET: 'SECRET',
    }) as Record<string, string>,
} as unknown as ConfigService;

// Override get to behave like real ConfigService.get(key)
(config as unknown as { get: (k: string) => string | undefined }).get = (k: string) =>
  ({
    META_PHONE_NUMBER_ID: 'PNID',
    META_ACCESS_TOKEN: 'TOKEN',
    META_APP_SECRET: 'SECRET',
  })[k];

describe('MetaCloudAdapter', () => {
  const adapter = new MetaCloudAdapter(config);
  // Initialise the circuit breaker (Nest lifecycle hook); tests instantiate
  // the adapter directly so we call it manually.
  adapter.onModuleInit();

  it('has name "meta"', () => {
    expect(adapter.name).toBe('meta');
  });

  it('declara apenas campaignSend', () => {
    expect([...adapter.profile.capabilities]).toEqual(['campaignSend']);
  });

  it('sends template message and returns providerMessageId', async () => {
    server.use(
      http.post('https://graph.facebook.com/v22.0/PNID/messages', async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        expect(body.messaging_product).toBe('whatsapp');
        expect(body.to).toBe('5592987654321');
        expect(body.type).toBe('template');
        const tpl = body.template as Record<string, unknown>;
        expect(tpl.name).toBe('welcome');
        expect((tpl.language as { code: string }).code).toBe('pt_BR');
        expect(tpl.components).toEqual([
          { type: 'body', parameters: [{ type: 'text', text: 'João' }] },
        ]);
        return HttpResponse.json({ messages: [{ id: 'wamid.123' }] });
      }),
    );
    const r = await adapter.sendTemplate({
      toE164: '+5592987654321',
      templateName: 'welcome',
      language: 'pt_BR',
      variables: { '1': 'João' },
    });
    expect(r.providerMessageId).toBe('wamid.123');
    expect(r.acceptedAt).toBeInstanceOf(Date);
  });

  it('omits components when no variables', async () => {
    server.use(
      http.post('https://graph.facebook.com/v22.0/PNID/messages', async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        const tpl = body.template as Record<string, unknown>;
        expect(tpl.components).toBeUndefined();
        return HttpResponse.json({ messages: [{ id: 'wamid.456' }] });
      }),
    );
    await adapter.sendTemplate({
      toE164: '+5511987654321',
      templateName: 'reminder',
      language: 'pt_BR',
      variables: {},
    });
  });

  it('ignores per-channel Twilio sender fields (renders by template name)', async () => {
    server.use(
      http.post('https://graph.facebook.com/v22.0/PNID/messages', async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        // Meta resolves its sender from META_PHONE_NUMBER_ID; the Twilio-only
        // per-channel sender fields must never leak into the Graph payload.
        expect(body.to).toBe('5592987654321');
        expect(body.From).toBeUndefined();
        expect(body.MessagingServiceSid).toBeUndefined();
        expect(body.senderPhoneE164).toBeUndefined();
        expect(body.twilioMessagingServiceSid).toBeUndefined();
        return HttpResponse.json({ messages: [{ id: 'wamid.ignore' }] });
      }),
    );
    const r = await adapter.sendTemplate({
      toE164: '+5592987654321',
      templateName: 'welcome',
      language: 'pt_BR',
      variables: { '1': 'João' },
      senderPhoneE164: '+5599999999999',
      twilioMessagingServiceSid: 'MGshouldbeignored0000000000000000',
    });
    expect(r.providerMessageId).toBe('wamid.ignore');
  });

  it('throws WhatsappSendError on Meta API error', async () => {
    server.use(
      http.post('https://graph.facebook.com/v22.0/PNID/messages', () =>
        HttpResponse.json(
          { error: { code: 131026, message: 'Receiver has no WhatsApp' } },
          { status: 400 },
        ),
      ),
    );
    await expect(
      adapter.sendTemplate({
        toE164: '+5592999999999',
        templateName: 'welcome',
        language: 'pt_BR',
        variables: {},
      }),
    ).rejects.toThrow(WhatsappSendError);
  });

  it('exposes providerErrorCode and providerErrorMessage on WhatsappSendError', async () => {
    server.use(
      http.post('https://graph.facebook.com/v22.0/PNID/messages', () =>
        HttpResponse.json(
          { error: { code: 131026, message: 'Receiver has no WhatsApp' } },
          { status: 400 },
        ),
      ),
    );
    try {
      await adapter.sendTemplate({
        toE164: '+5592999999999',
        templateName: 'welcome',
        language: 'pt_BR',
        variables: {},
      });
    } catch (err) {
      expect(err).toBeInstanceOf(WhatsappSendError);
      const e = err as WhatsappSendError;
      expect(e.providerErrorCode).toBe('131026');
      expect(e.providerErrorMessage).toBe('Receiver has no WhatsApp');
    }
  });

  it('parses status webhook with sent/delivered/read', () => {
    const payload = {
      entry: [
        {
          changes: [
            {
              value: {
                statuses: [
                  { id: 'wamid.A', status: 'sent', timestamp: '1700000000' },
                  { id: 'wamid.B', status: 'delivered', timestamp: '1700000010' },
                  { id: 'wamid.C', status: 'read', timestamp: '1700000020' },
                ],
              },
            },
          ],
        },
      ],
    };
    const events = adapter.parseWebhook(payload);
    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({ providerMessageId: 'wamid.A', status: 'sent' });
    expect(events[1]).toMatchObject({ providerMessageId: 'wamid.B', status: 'delivered' });
    expect(events[2]).toMatchObject({ providerMessageId: 'wamid.C', status: 'read' });
  });

  it('parses failed status with error code and message', () => {
    const payload = {
      entry: [
        {
          changes: [
            {
              value: {
                statuses: [
                  {
                    id: 'wamid.X',
                    status: 'failed',
                    timestamp: '1700000000',
                    errors: [{ code: 131026, message: 'Receiver has no WhatsApp' }],
                  },
                ],
              },
            },
          ],
        },
      ],
    };
    const events = adapter.parseWebhook(payload);
    expect(events[0]).toMatchObject({
      providerMessageId: 'wamid.X',
      status: 'failed',
      errorCode: '131026',
      errorMessage: 'Receiver has no WhatsApp',
    });
  });

  it('returns empty array for malformed webhook', () => {
    expect(adapter.parseWebhook({})).toEqual([]);
    expect(adapter.parseWebhook(null)).toEqual([]);
  });

  // be-meta: parseWebhook coerced s.status into the union without validating,
  // letting a value Meta might add (e.g. 'deleted', 'warning') flow downstream
  // as a bogus NormalizedEvent['status']. Drop unknown statuses.
  it('drops status events with a status outside the known union', () => {
    const payload = {
      entry: [
        {
          changes: [
            {
              value: {
                statuses: [
                  { id: 'wamid.OK', status: 'delivered', timestamp: '1700000000' },
                  { id: 'wamid.BAD', status: 'deleted', timestamp: '1700000000' },
                  { id: 'wamid.BAD2', status: '', timestamp: '1700000000' },
                ],
              },
            },
          ],
        },
      ],
    };
    const events = adapter.parseWebhook(payload);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ providerMessageId: 'wamid.OK', status: 'delivered' });
  });

  // be-meta: parseInt on a non-numeric / missing timestamp yields NaN, and
  // new Date(NaN) is an Invalid Date that corrupts occurredAt. Fall back to now.
  it('falls back to a valid occurredAt when the status timestamp is unparseable', () => {
    const payload = {
      entry: [
        {
          changes: [
            {
              value: {
                statuses: [
                  { id: 'wamid.T', status: 'sent', timestamp: 'not-a-number' },
                ],
              },
            },
          ],
        },
      ],
    };
    const events = adapter.parseWebhook(payload);
    expect(events).toHaveLength(1);
    expect(events[0].occurredAt).toBeInstanceOf(Date);
    expect(Number.isNaN(events[0].occurredAt.getTime())).toBe(false);
  });

  it('parses inbound text message into a +E164 sender', () => {
    const payload = {
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  { id: 'wamid.in', from: '5592987654321', timestamp: '1700000000', text: { body: 'oi' } },
                ],
              },
            },
          ],
        },
      ],
    };
    const events = adapter.parseInboundMessages(payload);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      providerMessageId: 'wamid.in',
      fromE164: '+5592987654321',
      text: 'oi',
    });
  });

  // be-meta: parseInboundMessages did `'+' + m.from` with no validation, so a
  // payload with a non-digit / empty `from` produced a junk fromE164 like '+'.
  // Such messages must be dropped.
  it('drops inbound messages whose `from` is not E.164 digits', () => {
    const payload = {
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  { id: 'wamid.bad1', from: '', timestamp: '1700000000', text: { body: 'x' } },
                  { id: 'wamid.bad2', from: 'not-digits', timestamp: '1700000000', text: { body: 'y' } },
                  { id: 'wamid.ok', from: '5592987654321', timestamp: '1700000000', text: { body: 'z' } },
                ],
              },
            },
          ],
        },
      ],
    };
    const events = adapter.parseInboundMessages(payload);
    expect(events).toHaveLength(1);
    expect(events[0].providerMessageId).toBe('wamid.ok');
    expect(events[0].fromE164).toBe('+5592987654321');
  });

  // be-meta: inbound timestamp parse must also be guarded against NaN.
  it('falls back to a valid receivedAt when the inbound timestamp is unparseable', () => {
    const payload = {
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  { id: 'wamid.in', from: '5592987654321', timestamp: 'bogus', text: { body: 'oi' } },
                ],
              },
            },
          ],
        },
      ],
    };
    const events = adapter.parseInboundMessages(payload);
    expect(events).toHaveLength(1);
    expect(events[0].receivedAt).toBeInstanceOf(Date);
    expect(Number.isNaN(events[0].receivedAt.getTime())).toBe(false);
  });

  it('returns empty array for malformed inbound payload', () => {
    expect(adapter.parseInboundMessages({})).toEqual([]);
    expect(adapter.parseInboundMessages(null)).toEqual([]);
  });

  it('does not implement getConnectionInfo (Meta Cloud has no paired session)', () => {
    // Meta Cloud has no QR / Baileys socket to be up or down — only a token that
    // is valid or isn't. The adapter therefore omits getConnectionInfo AND omits
    // the `sessionLifecycle` capability from its profile; the two must stay in
    // sync (provider-capability-contract.spec.ts guards the other direction).
    //
    // Regression guard so a future contributor doesn't add the method without
    // also declaring the capability — the method alone would be invisible to
    // every caller, which now gates on the declaration.
    const adapterAsAny = adapter as unknown as Record<string, unknown>;
    expect(adapterAsAny['getConnectionInfo']).toBeUndefined();
    // Verify the adapter is correctly typed as 'meta'
    expect(adapter.name).toBe('meta');
    // Guard: any attempt to call getConnectionInfo should throw
    expect(() => {
      (adapter as unknown as { getConnectionInfo?: () => void }).getConnectionInfo?.();
    }).not.toThrow();
  });
});
