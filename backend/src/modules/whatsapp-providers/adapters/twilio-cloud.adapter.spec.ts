import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { createHmac } from 'crypto';
import { ConfigService } from '@nestjs/config';
import { TwilioCloudAdapter } from './twilio-cloud.adapter';
import { WhatsappSendError } from '../errors/whatsapp.errors';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const ACCOUNT_SID = 'AC00000000000000000000000000000000';
const AUTH_TOKEN = 'the-auth-token';
const MESSAGES_URL = `https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}/Messages.json`;

function makeConfig(overrides: Record<string, string | undefined> = {}) {
  const values: Record<string, string | undefined> = {
    TWILIO_ACCOUNT_SID: ACCOUNT_SID,
    TWILIO_AUTH_TOKEN: AUTH_TOKEN,
    TWILIO_WHATSAPP_FROM: 'whatsapp:+14155238886',
    ...overrides,
  };
  return {
    get: (k: string) => values[k],
  } as unknown as ConfigService;
}

/** Parse a captured form-urlencoded request body into a plain object. */
async function formBody(request: Request): Promise<Record<string, string>> {
  const text = await request.text();
  return Object.fromEntries(new URLSearchParams(text));
}

describe('TwilioCloudAdapter', () => {
  const adapter = new TwilioCloudAdapter(makeConfig());

  it('has name "twilio"', () => {
    expect(adapter.name).toBe('twilio');
  });

  it('declara statusPolling e inboxChat, mas NÃO chatMedia (stubs lançam)', () => {
    expect(adapter.profile.capabilities.has('statusPolling')).toBe(true);
    expect(adapter.profile.capabilities.has('inboxChat')).toBe(true);
    expect(adapter.profile.capabilities.has('chatMedia')).toBe(false);
  });

  describe('sendTemplate', () => {
    it('posts To/From/Body with basic auth and one whatsapp: prefix', async () => {
      let seenAuth: string | null = null;
      server.use(
        http.post(MESSAGES_URL, async ({ request }) => {
          seenAuth = request.headers.get('authorization');
          const body = await formBody(request);
          expect(body.To).toBe('whatsapp:+5592987654321');
          expect(body.From).toBe('whatsapp:+14155238886');
          expect(body.Body).toBe('Olá João');
          expect(body.ContentSid).toBeUndefined();
          return HttpResponse.json({ sid: 'SM123', status: 'queued' });
        }),
      );

      const r = await adapter.sendTemplate({
        toE164: '+5592987654321',
        templateName: 'welcome',
        language: 'pt_BR',
        variables: {},
        body: 'Olá João',
      });

      expect(r.providerMessageId).toBe('SM123');
      expect(r.acceptedAt).toBeInstanceOf(Date);
      const expectedAuth =
        'Basic ' +
        Buffer.from(`${ACCOUNT_SID}:${AUTH_TOKEN}`).toString('base64');
      expect(seenAuth).toBe(expectedAuth);
    });

    it('normalises a From without the whatsapp: prefix to exactly one prefix', async () => {
      const bare = new TwilioCloudAdapter(
        makeConfig({ TWILIO_WHATSAPP_FROM: '+14155238886' }),
      );
      server.use(
        http.post(MESSAGES_URL, async ({ request }) => {
          const body = await formBody(request);
          expect(body.From).toBe('whatsapp:+14155238886');
          return HttpResponse.json({ sid: 'SM999', status: 'queued' });
        }),
      );
      await bare.sendTemplate({
        toE164: '+5511999999999',
        templateName: 'x',
        language: 'pt_BR',
        variables: {},
        body: 'hi',
      });
    });

    it('uses ContentSid + ContentVariables when templateName is a Content SID', async () => {
      server.use(
        http.post(MESSAGES_URL, async ({ request }) => {
          const body = await formBody(request);
          expect(body.ContentSid).toBe('HX00000000000000000000000000000000');
          expect(body.ContentVariables).toBe(JSON.stringify({ '1': 'João' }));
          expect(body.Body).toBeUndefined();
          return HttpResponse.json({ sid: 'SMcontent', status: 'queued' });
        }),
      );
      const r = await adapter.sendTemplate({
        toE164: '+5592987654321',
        templateName: 'HX00000000000000000000000000000000',
        language: 'pt_BR',
        variables: { '1': 'João' },
      });
      expect(r.providerMessageId).toBe('SMcontent');
    });

    it('sends MessagingServiceSid instead of From when configured', async () => {
      const svc = new TwilioCloudAdapter(
        makeConfig({
          TWILIO_MESSAGING_SERVICE_SID: 'MG00000000000000000000000000000000',
        }),
      );
      server.use(
        http.post(MESSAGES_URL, async ({ request }) => {
          const body = await formBody(request);
          expect(body.MessagingServiceSid).toBe(
            'MG00000000000000000000000000000000',
          );
          expect(body.From).toBeUndefined();
          return HttpResponse.json({ sid: 'SMsvc', status: 'queued' });
        }),
      );
      await svc.sendTemplate({
        toE164: '+5511999999999',
        templateName: 'x',
        language: 'pt_BR',
        variables: {},
        body: 'hi',
      });
    });

    it('throws WhatsappSendError with Twilio code/message on API error', async () => {
      server.use(
        http.post(MESSAGES_URL, () =>
          HttpResponse.json(
            { code: 21211, message: "Invalid 'To' Phone Number" },
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
          body: 'hi',
        });
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(WhatsappSendError);
        const e = err as WhatsappSendError;
        expect(e.providerErrorCode).toBe('21211');
        expect(e.providerErrorMessage).toBe("Invalid 'To' Phone Number");
      }
    });
  });

  describe('per-channel sender (R1)', () => {
    // Precedence under test:
    //   channel MessagingServiceSid > channel From (phoneE164) > env MSS > env From
    it('uses the CHANNEL phoneE164 as From, overriding the env From', async () => {
      const a = new TwilioCloudAdapter(
        makeConfig({ TWILIO_WHATSAPP_FROM: 'whatsapp:+14155238886' }),
      );
      server.use(
        http.post(MESSAGES_URL, async ({ request }) => {
          const body = await formBody(request);
          expect(body.From).toBe('whatsapp:+5592111111111');
          expect(body.MessagingServiceSid).toBeUndefined();
          return HttpResponse.json({ sid: 'SMchFrom', status: 'queued' });
        }),
      );
      await a.sendTemplate({
        toE164: '+5511999999999',
        templateName: 'x',
        language: 'pt_BR',
        variables: {},
        body: 'hi',
        senderPhoneE164: '+5592111111111',
      });
    });

    it('prefers the channel phoneE164 (From) over an env MessagingServiceSid', async () => {
      const a = new TwilioCloudAdapter(
        makeConfig({
          TWILIO_MESSAGING_SERVICE_SID: 'MGenv0000000000000000000000000000',
        }),
      );
      server.use(
        http.post(MESSAGES_URL, async ({ request }) => {
          const body = await formBody(request);
          expect(body.From).toBe('whatsapp:+5592111111111');
          expect(body.MessagingServiceSid).toBeUndefined();
          return HttpResponse.json({ sid: 'SMchOverEnvMss', status: 'queued' });
        }),
      );
      await a.sendTemplate({
        toE164: '+5511999999999',
        templateName: 'x',
        language: 'pt_BR',
        variables: {},
        body: 'hi',
        senderPhoneE164: '+5592111111111',
      });
    });

    it('uses the CHANNEL twilioMessagingServiceSid (no From), overriding the env From', async () => {
      const a = new TwilioCloudAdapter(
        makeConfig({ TWILIO_WHATSAPP_FROM: 'whatsapp:+14155238886' }),
      );
      server.use(
        http.post(MESSAGES_URL, async ({ request }) => {
          const body = await formBody(request);
          expect(body.MessagingServiceSid).toBe(
            'MGchannel00000000000000000000000',
          );
          expect(body.From).toBeUndefined();
          return HttpResponse.json({ sid: 'SMchMss', status: 'queued' });
        }),
      );
      await a.sendTemplate({
        toE164: '+5511999999999',
        templateName: 'x',
        language: 'pt_BR',
        variables: {},
        body: 'hi',
        twilioMessagingServiceSid: 'MGchannel00000000000000000000000',
      });
    });

    it('channel MessagingServiceSid takes precedence over channel phoneE164', async () => {
      const a = new TwilioCloudAdapter(makeConfig());
      server.use(
        http.post(MESSAGES_URL, async ({ request }) => {
          const body = await formBody(request);
          expect(body.MessagingServiceSid).toBe(
            'MGchannel00000000000000000000000',
          );
          expect(body.From).toBeUndefined();
          return HttpResponse.json({ sid: 'SMboth', status: 'queued' });
        }),
      );
      await a.sendTemplate({
        toE164: '+5511999999999',
        templateName: 'x',
        language: 'pt_BR',
        variables: {},
        body: 'hi',
        senderPhoneE164: '+5592111111111',
        twilioMessagingServiceSid: 'MGchannel00000000000000000000000',
      });
    });

    it('falls back to the env From when the channel has no sender (compat)', async () => {
      const a = new TwilioCloudAdapter(
        makeConfig({ TWILIO_WHATSAPP_FROM: 'whatsapp:+14155238886' }),
      );
      server.use(
        http.post(MESSAGES_URL, async ({ request }) => {
          const body = await formBody(request);
          expect(body.From).toBe('whatsapp:+14155238886');
          expect(body.MessagingServiceSid).toBeUndefined();
          return HttpResponse.json({ sid: 'SMenvFrom', status: 'queued' });
        }),
      );
      await a.sendTemplate({
        toE164: '+5511999999999',
        templateName: 'x',
        language: 'pt_BR',
        variables: {},
        body: 'hi',
      });
    });

    it('normalises a bare +E164 channel From to exactly one whatsapp: prefix', async () => {
      const a = new TwilioCloudAdapter(makeConfig());
      server.use(
        http.post(MESSAGES_URL, async ({ request }) => {
          const body = await formBody(request);
          expect(body.From).toBe('whatsapp:+5592111111111');
          return HttpResponse.json({ sid: 'SMnorm1', status: 'queued' });
        }),
      );
      await a.sendTemplate({
        toE164: '+5511999999999',
        templateName: 'x',
        language: 'pt_BR',
        variables: {},
        body: 'hi',
        senderPhoneE164: '+5592111111111',
      });
    });

    it('accepts a channel From that already carries the whatsapp: prefix (no double prefix)', async () => {
      const a = new TwilioCloudAdapter(makeConfig());
      server.use(
        http.post(MESSAGES_URL, async ({ request }) => {
          const body = await formBody(request);
          expect(body.From).toBe('whatsapp:+5592111111111');
          return HttpResponse.json({ sid: 'SMnorm2', status: 'queued' });
        }),
      );
      await a.sendTemplate({
        toE164: '+5511999999999',
        templateName: 'x',
        language: 'pt_BR',
        variables: {},
        body: 'hi',
        senderPhoneE164: 'whatsapp:+5592111111111',
      });
    });

    it('throws a fatal PT domain error when neither the channel nor the env define a sender', async () => {
      const a = new TwilioCloudAdapter(
        makeConfig({ TWILIO_WHATSAPP_FROM: undefined }),
      );
      // No HTTP handler registered — a request would fail the msw
      // onUnhandledRequest:'error' guard, proving we threw BEFORE POSTing.
      try {
        await a.sendTemplate({
          toE164: '+5511999999999',
          templateName: 'x',
          language: 'pt_BR',
          variables: {},
          body: 'hi',
        });
        expect.unreachable('should have thrown');
      } catch (err) {
        const e = err as WhatsappSendError;
        expect(e).toBeInstanceOf(WhatsappSendError);
        expect(e.fatal).toBe(true);
        expect(e.providerErrorCode).toBe('twilio.sender_missing');
        expect(e.message).toMatch(/remetente/i);
      }
    });
  });

  describe('delivery hardening', () => {
    it('attaches StatusCallback when TWILIO_WEBHOOK_URL is set', async () => {
      const withCb = new TwilioCloudAdapter(
        makeConfig({ TWILIO_WEBHOOK_URL: 'https://picoa.app.br/api/webhooks/twilio' }),
      );
      server.use(
        http.post(MESSAGES_URL, async ({ request }) => {
          const body = await formBody(request);
          expect(body.StatusCallback).toBe(
            'https://picoa.app.br/api/webhooks/twilio',
          );
          return HttpResponse.json({ sid: 'SMcb', status: 'queued' });
        }),
      );
      await withCb.sendTemplate({
        toE164: '+5511999999999',
        templateName: 'x',
        language: 'pt_BR',
        variables: {},
        body: 'hi',
      });
    });

    it('omits StatusCallback when TWILIO_WEBHOOK_URL is unset', async () => {
      server.use(
        http.post(MESSAGES_URL, async ({ request }) => {
          const body = await formBody(request);
          expect(body.StatusCallback).toBeUndefined();
          return HttpResponse.json({ sid: 'SMnocb', status: 'queued' });
        }),
      );
      await adapter.sendTemplate({
        toE164: '+5511999999999',
        templateName: 'x',
        language: 'pt_BR',
        variables: {},
        body: 'hi',
      });
    });

    it('marks a permanent Twilio code (21211) as fatal', async () => {
      server.use(
        http.post(MESSAGES_URL, () =>
          HttpResponse.json(
            { code: 21211, message: "Invalid 'To' Phone Number" },
            { status: 400 },
          ),
        ),
      );
      try {
        await adapter.sendChatText({
          instanceName: 'd',
          toE164: '+5592999999999',
          text: 'hi',
        });
        expect.unreachable('should have thrown');
      } catch (err) {
        expect((err as WhatsappSendError).fatal).toBe(true);
      }
    });

    it('keeps a transient Twilio code (63018) non-fatal', async () => {
      server.use(
        http.post(MESSAGES_URL, () =>
          HttpResponse.json(
            { code: 63018, message: 'Rate limit exceeded for Channel' },
            { status: 429 },
          ),
        ),
      );
      try {
        await adapter.sendChatText({
          instanceName: 'd',
          toE164: '+5592999999999',
          text: 'hi',
        });
        expect.unreachable('should have thrown');
      } catch (err) {
        expect((err as WhatsappSendError).fatal).toBe(false);
      }
    });

    it('classifies a no-response network error as an indeterminate twilio.* code (non-fatal)', async () => {
      server.use(http.post(MESSAGES_URL, () => HttpResponse.error()));
      try {
        await adapter.sendChatText({
          instanceName: 'd',
          toE164: '+5592999999999',
          text: 'hi',
        });
        expect.unreachable('should have thrown');
      } catch (err) {
        const e = err as WhatsappSendError;
        expect(e.fatal).toBe(false);
        expect(e.providerErrorCode?.startsWith('twilio.')).toBe(true);
      }
    });

    it('fetchMessageStatus maps delivered/failed and surfaces the error code', async () => {
      const MSG = (sid: string) =>
        `https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}/Messages/${sid}.json`;
      server.use(
        http.get(MSG('SMdel'), () =>
          HttpResponse.json({ status: 'delivered', error_code: null }),
        ),
        http.get(MSG('SMfail'), () =>
          HttpResponse.json({ status: 'undelivered', error_code: 63003 }),
        ),
        http.get(MSG('SMq'), () =>
          HttpResponse.json({ status: 'queued', error_code: null }),
        ),
      );
      expect((await adapter.fetchMessageStatus('SMdel')).status).toBe('delivered');
      const fail = await adapter.fetchMessageStatus('SMfail');
      expect(fail.status).toBe('failed');
      expect(fail.errorCode).toBe('63003');
      expect((await adapter.fetchMessageStatus('SMq')).status).toBeUndefined();
    });
  });

  describe('sendChatText', () => {
    it('posts a free-form Body to the resolved To', async () => {
      server.use(
        http.post(MESSAGES_URL, async ({ request }) => {
          const body = await formBody(request);
          expect(body.To).toBe('whatsapp:+5592987654321');
          expect(body.Body).toBe('resposta do bot');
          return HttpResponse.json({ sid: 'SMchat', status: 'queued' });
        }),
      );
      const r = await adapter.sendChatText({
        instanceName: 'default',
        toE164: '+5592987654321',
        text: 'resposta do bot',
      });
      expect(r.providerMessageId).toBe('SMchat');
    });

    // R1 multi-número: o remetente do CANAL (senderPhoneE164 /
    // twilioMessagingServiceSid) vence o From do env — mesma precedência do
    // sendTemplate.
    it('usa o remetente do canal (senderPhoneE164) em vez do From do env', async () => {
      server.use(
        http.post(MESSAGES_URL, async ({ request }) => {
          const body = await formBody(request);
          expect(body.From).toBe('whatsapp:+559231550103');
          expect(body.MessagingServiceSid).toBeUndefined();
          return HttpResponse.json({ sid: 'SMchat2', status: 'queued' });
        }),
      );
      const r = await adapter.sendChatText({
        instanceName: '',
        toE164: '+5592987654321',
        text: 'oi',
        senderPhoneE164: '+559231550103',
      });
      expect(r.providerMessageId).toBe('SMchat2');
    });

    it('usa o MessagingServiceSid do canal quando presente', async () => {
      server.use(
        http.post(MESSAGES_URL, async ({ request }) => {
          const body = await formBody(request);
          expect(body.MessagingServiceSid).toBe('MG00000000000000000000000000000000');
          expect(body.From).toBeUndefined();
          return HttpResponse.json({ sid: 'SMchat3', status: 'queued' });
        }),
      );
      const r = await adapter.sendChatText({
        instanceName: '',
        toE164: '+5592987654321',
        text: 'oi',
        twilioMessagingServiceSid: 'MG00000000000000000000000000000000',
      });
      expect(r.providerMessageId).toBe('SMchat3');
    });
  });

  describe('parseInboundChatMessages', () => {
    it('maps a Twilio inbound form payload to an InboundChatMessage', () => {
      const payload = {
        MessageSid: 'SMinbound',
        From: 'whatsapp:+5592987654321',
        To: 'whatsapp:+14155238886',
        Body: 'oi tudo bem?',
        NumMedia: '0',
        ProfileName: 'Maria',
        WaId: '5592987654321',
      };
      const [m] = adapter.parseInboundChatMessages(payload);
      expect(m.providerMessageId).toBe('SMinbound');
      expect(m.phoneE164).toBe('+5592987654321');
      expect(m.text).toBe('oi tudo bem?');
      expect(m.kind).toBe('TEXT');
      expect(m.isGroup).toBe(false);
      expect(m.fromMe).toBe(false);
      expect(m.pushName).toBe('Maria');
    });

    /**
     * CTWA / Free Entry Point (spec §3.4). O inbound que vem de um anúncio
     * Click-to-WhatsApp carrega um REFERRAL — e o `ReferralCtwaClid` é evidência
     * verificável na Meta/Twilio, muito mais forte que qualquer linha que o
     * orgamind escreva sobre si mesmo. Hoje o orgamind descartava tudo isso.
     */
    it('mapeia o referral de um Click-to-WhatsApp Ad (§3.4)', () => {
      const payload = {
        MessageSid: 'SMctwa',
        From: 'whatsapp:+5592987654321',
        Body: 'Autorizo o IDASAM. [ADS-JULHO]',
        NumMedia: '0',
        ReferralCtwaClid: 'ctwa_abc123',
        ReferralHeadline: 'Participe dos cursos do IDASAM',
        ReferralBody: 'Inscrições abertas',
        ReferralSourceId: '120210000000',
        ReferralSourceUrl: 'https://fb.me/anuncio',
      };
      const [m] = adapter.parseInboundChatMessages(payload);
      expect(m.referral).toEqual({
        ctwaClid: 'ctwa_abc123',
        headline: 'Participe dos cursos do IDASAM',
        body: 'Inscrições abertas',
        sourceId: '120210000000',
        sourceUrl: 'https://fb.me/anuncio',
      });
    });

    it('deixa `referral` indefinido num inbound orgânico (sem anúncio)', () => {
      const payload = {
        MessageSid: 'SMorg',
        From: 'whatsapp:+5592987654321',
        Body: 'oi',
        NumMedia: '0',
      };
      const [m] = adapter.parseInboundChatMessages(payload);
      expect(m.referral).toBeUndefined();
    });

    it('maps image media to kind IMAGE with mimeType + url', () => {
      const payload = {
        MessageSid: 'MMimg',
        From: 'whatsapp:+5592987654321',
        Body: '',
        NumMedia: '1',
        MediaContentType0: 'image/jpeg',
        MediaUrl0: 'https://api.twilio.com/media/abc',
      };
      const [m] = adapter.parseInboundChatMessages(payload);
      expect(m.kind).toBe('IMAGE');
      expect(m.media?.mimeType).toBe('image/jpeg');
      expect(m.media?.url).toBe('https://api.twilio.com/media/abc');
      expect(m.text).toBeUndefined();
    });

    it('keeps the Body as caption when it accompanies media', () => {
      const payload = {
        MessageSid: 'MMcap',
        From: 'whatsapp:+5592987654321',
        Body: 'olha essa foto',
        NumMedia: '1',
        MediaContentType0: 'image/png',
        MediaUrl0: 'https://api.twilio.com/media/cap',
      };
      const [m] = adapter.parseInboundChatMessages(payload);
      expect(m.kind).toBe('IMAGE');
      expect(m.text).toBe('olha essa foto');
    });

    it('maps video media to kind VIDEO', () => {
      const payload = {
        MessageSid: 'MMvid',
        From: 'whatsapp:+5592987654321',
        NumMedia: '1',
        MediaContentType0: 'video/mp4',
        MediaUrl0: 'https://api.twilio.com/media/vid',
      };
      const [m] = adapter.parseInboundChatMessages(payload);
      expect(m.kind).toBe('VIDEO');
      expect(m.media?.url).toBe('https://api.twilio.com/media/vid');
    });

    it('maps audio media (voice note) to kind AUDIO', () => {
      const payload = {
        MessageSid: 'MMaud',
        From: 'whatsapp:+5592987654321',
        NumMedia: '1',
        MediaContentType0: 'audio/ogg',
        MediaUrl0: 'https://api.twilio.com/media/aud',
      };
      const [m] = adapter.parseInboundChatMessages(payload);
      expect(m.kind).toBe('AUDIO');
      expect(m.media?.mimeType).toBe('audio/ogg');
    });

    it('maps any other mimetype (pdf) to kind DOCUMENT', () => {
      const payload = {
        MessageSid: 'MMdoc',
        From: 'whatsapp:+5592987654321',
        NumMedia: '1',
        MediaContentType0: 'application/pdf',
        MediaUrl0: 'https://api.twilio.com/media/doc',
      };
      const [m] = adapter.parseInboundChatMessages(payload);
      expect(m.kind).toBe('DOCUMENT');
    });

    it('processes only the first media when NumMedia > 1', () => {
      const payload = {
        MessageSid: 'MMmulti',
        From: 'whatsapp:+5592987654321',
        NumMedia: '2',
        MediaContentType0: 'image/jpeg',
        MediaUrl0: 'https://api.twilio.com/media/first',
        MediaContentType1: 'image/png',
        MediaUrl1: 'https://api.twilio.com/media/second',
      };
      const messages = adapter.parseInboundChatMessages(payload);
      expect(messages).toHaveLength(1);
      expect(messages[0].media?.url).toBe('https://api.twilio.com/media/first');
      expect(messages[0].media?.mimeType).toBe('image/jpeg');
    });

    it('maps a quick-reply button press to TEXT with the payload preserved', () => {
      const payload = {
        MessageSid: 'SMbtn',
        From: 'whatsapp:+5592987654321',
        Body: 'Parar',
        NumMedia: '0',
        ButtonText: 'Parar',
        ButtonPayload: 'optout',
      };
      const [m] = adapter.parseInboundChatMessages(payload);
      expect(m.kind).toBe('TEXT');
      expect(m.text).toBe('Parar');
      expect(m.buttonPayload).toBe('optout');
    });

    it('maps Latitude/Longitude to kind LOCATION with "lat,long" text', () => {
      const payload = {
        MessageSid: 'SMloc',
        From: 'whatsapp:+5592987654321',
        NumMedia: '0',
        Latitude: '-3.10719',
        Longitude: '-60.026',
      };
      const [m] = adapter.parseInboundChatMessages(payload);
      expect(m.kind).toBe('LOCATION');
      expect(m.text).toBe('-3.10719,-60.026');
    });

    it('prefers the location Label/Address as text when present (Evolution parity)', () => {
      const payload = {
        MessageSid: 'SMloc2',
        From: 'whatsapp:+5592987654321',
        NumMedia: '0',
        Latitude: '-3.10719',
        Longitude: '-60.026',
        Label: 'Teatro Amazonas',
        Address: 'Largo de São Sebastião, Manaus',
      };
      const [m] = adapter.parseInboundChatMessages(payload);
      expect(m.kind).toBe('LOCATION');
      expect(m.text).toBe('Teatro Amazonas');
    });

    it('maps OriginalRepliedMessageSid to quotedWaMessageId', () => {
      const payload = {
        MessageSid: 'SMreply',
        From: 'whatsapp:+5592987654321',
        Body: 'sim, confirmo',
        NumMedia: '0',
        OriginalRepliedMessageSid: 'SMoriginal',
      };
      const [m] = adapter.parseInboundChatMessages(payload);
      expect(m.kind).toBe('TEXT');
      expect(m.quotedWaMessageId).toBe('SMoriginal');
    });

    it('returns [] for a status callback (no inbound message)', () => {
      const payload = {
        MessageSid: 'SMx',
        MessageStatus: 'delivered',
        To: 'whatsapp:+55',
      };
      expect(adapter.parseInboundChatMessages(payload)).toEqual([]);
    });
  });

  describe('parseWebhook (status callbacks)', () => {
    it('maps a delivered status callback to an ack event', () => {
      const events = adapter.parseWebhook({
        MessageSid: 'SMabc',
        MessageStatus: 'delivered',
      });
      expect(events).toHaveLength(1);
      expect(events[0].providerMessageId).toBe('SMabc');
      expect(events[0].status).toBe('delivered');
      expect(events[0].occurredAt).toBeInstanceOf(Date);
    });

    it('maps failed/undelivered to failed and drops non-terminal statuses', () => {
      expect(
        adapter.parseWebhook({ MessageSid: 'S1', MessageStatus: 'failed' })[0]
          .status,
      ).toBe('failed');
      expect(
        adapter.parseWebhook({
          MessageSid: 'S2',
          MessageStatus: 'undelivered',
        })[0].status,
      ).toBe('failed');
      expect(
        adapter.parseWebhook({ MessageSid: 'S3', MessageStatus: 'queued' }),
      ).toEqual([]);
    });
  });

  describe('parseInboundMessages', () => {
    it('maps an inbound text to a simple InboundMessageEvent', () => {
      const [e] = adapter.parseInboundMessages({
        MessageSid: 'SMin',
        From: 'whatsapp:+5592987654321',
        Body: 'parar',
      });
      expect(e.fromE164).toBe('+5592987654321');
      expect(e.text).toBe('parar');
      expect(e.providerMessageId).toBe('SMin');
      expect(e.buttonPayload).toBeUndefined();
    });

    // T8 — opt-out por botão: o handler de STOP keywords consome
    // InboundMessageEvent, então o ButtonPayload (id estável do quick-reply,
    // ex. `optout`) precisa chegar até ele.
    it('propaga ButtonPayload para o InboundMessageEvent (opt-out por botão)', () => {
      const [e] = adapter.parseInboundMessages({
        MessageSid: 'SMbtn',
        From: 'whatsapp:+5592987654321',
        Body: 'Parar de receber',
        ButtonText: 'Parar de receber',
        ButtonPayload: 'optout',
      });
      expect(e.buttonPayload).toBe('optout');
      expect(e.providerMessageId).toBe('SMbtn');
    });
  });

  describe('verifyTwilioSignature', () => {
    // Canonical Twilio documentation input; the expected signature is computed
    // by the published Twilio algorithm (URL + sorted key+value, HMAC-SHA1,
    // base64) with AuthToken "12345".
    const sigAdapter = new TwilioCloudAdapter(
      makeConfig({ TWILIO_AUTH_TOKEN: '12345' }),
    );
    const url = 'https://mycompany.com/myapp.php?foo=1&bar=2';
    const params = {
      CallSid: 'CA1234567890ABCDE',
      Caller: '+14158675310',
      Digits: '1234',
      From: '+14158675310',
      To: '+18005551212',
    };
    // Independently-derived reference value (raw Node crypto, same algorithm).
    const good = (() => {
      let s = url;
      for (const k of Object.keys(params).sort())
        s += k + (params as Record<string, string>)[k];
      return createHmac('sha1', '12345')
        .update(Buffer.from(s, 'utf-8'))
        .digest('base64');
    })();

    it('accepts a known-good signature', () => {
      expect(sigAdapter.verifyTwilioSignature(url, params, good)).toBe(true);
    });

    it('is stable against the fixed published vector', () => {
      expect(good).toBe('GvWf1cFY/Q7PnoempGyD5oXAezc=');
    });

    it('rejects a tampered signature', () => {
      expect(
        sigAdapter.verifyTwilioSignature(url, params, 'AAAA' + good.slice(4)),
      ).toBe(false);
    });

    it('rejects when a param value was altered', () => {
      expect(
        sigAdapter.verifyTwilioSignature(
          url,
          { ...params, Digits: '9999' },
          good,
        ),
      ).toBe(false);
    });

    it('rejects when the URL differs', () => {
      expect(sigAdapter.verifyTwilioSignature(url + '&x=1', params, good)).toBe(
        false,
      );
    });
  });

  describe('unsupported Fase 2 methods', () => {
    it('throws for sendMedia / getMediaBase64 / findChats', async () => {
      await expect(adapter.sendMedia({} as never)).rejects.toThrow(/Twilio/);
      await expect(adapter.getMediaBase64('i', {})).rejects.toThrow(/Twilio/);
      await expect(adapter.findChats('i')).rejects.toThrow(/Twilio/);
    });
  });
});
