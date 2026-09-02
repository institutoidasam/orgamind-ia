import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  afterEach,
} from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { createHmac } from 'crypto';
import { ConfigService } from '@nestjs/config';
import {
  ZernioCloudAdapter,
  parseZernioTemplateStatusEvent,
} from './zernio-cloud.adapter';
import { WhatsappSendError } from '../errors/whatsapp.errors';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const API_KEY = 'sk_test_0000000000000000';
const BASE_URL = 'https://zernio.com/api/v1';
const WEBHOOK_SECRET = 'whsec_test_secret';
const CONVERSATIONS_URL = `${BASE_URL}/inbox/conversations`;

function makeConfig(overrides: Record<string, string | undefined> = {}) {
  const values: Record<string, string | undefined> = {
    ZERNIO_API_KEY: API_KEY,
    ZERNIO_BASE_URL: BASE_URL,
    ZERNIO_WEBHOOK_SECRET: WEBHOOK_SECRET,
    ...overrides,
  };
  return {
    get: (k: string) => values[k],
  } as unknown as ConfigService;
}

describe('ZernioCloudAdapter', () => {
  const adapter = new ZernioCloudAdapter(makeConfig());

  it('has name "zernio"', () => {
    expect(adapter.name).toBe('zernio');
  });

  it('declara campaignSend + inboxChat, sem statusPolling (decisão registrada no adapter)', () => {
    expect(adapter.profile.capabilities.has('campaignSend')).toBe(true);
    expect(adapter.profile.capabilities.has('inboxChat')).toBe(true);
    expect(adapter.profile.capabilities.has('statusPolling')).toBe(false);
  });

  describe('sendTemplate', () => {
    it('POSTs the template to /inbox/conversations with ordered params + bearer auth', async () => {
      let seenAuth: string | null = null;
      let seenBody: Record<string, unknown> | null = null;
      server.use(
        http.post(CONVERSATIONS_URL, async ({ request }) => {
          seenAuth = request.headers.get('authorization');
          seenBody = (await request.json()) as Record<string, unknown>;
          return HttpResponse.json(
            {
              success: true,
              data: { messageId: 'msg_123', conversationId: 'conv_1' },
            },
            { status: 201 },
          );
        }),
      );

      const r = await adapter.sendTemplate({
        toE164: '+5592987654321',
        templateName: 'order_confirmation',
        language: 'pt_BR',
        // Deliberately out of order + a two-digit key to prove numeric ordering
        // (1, 2, 10) rather than lexicographic (1, 10, 2).
        variables: { '2': 'AB-1234', '1': 'João', '10': 'último' },
        zernioAccountId: 'acc_zap',
      });

      expect(r.providerMessageId).toBe('msg_123');
      expect(r.acceptedAt).toBeInstanceOf(Date);
      expect(seenAuth).toBe(`Bearer ${API_KEY}`);
      expect(seenBody).toEqual({
        accountId: 'acc_zap',
        participantId: '5592987654321',
        templateName: 'order_confirmation',
        templateLanguage: 'pt_BR',
        templateParams: ['João', 'AB-1234', 'último'],
      });
    });

    // Header de mídia: `headerMedia` sobrepõe, por envio, o asset de exemplo
    // aprovado no template. `link` precisa ser público (sem auth); `id` é um
    // media id da Meta.
    it('sends headerMedia (link) for a template with a media header', async () => {
      let seenBody: Record<string, unknown> | null = null;
      server.use(
        http.post(CONVERSATIONS_URL, async ({ request }) => {
          seenBody = (await request.json()) as Record<string, unknown>;
          return HttpResponse.json(
            { success: true, data: { messageId: 'wamid.X==' } },
            { status: 201 },
          );
        }),
      );

      await adapter.sendTemplate({
        toE164: '+5592987654321',
        templateName: 'promo',
        language: 'pt_BR',
        variables: { '1': 'João' },
        zernioAccountId: 'acc_zap',
        headerMedia: { type: 'image', link: 'https://picoa.app.br/arte.png' },
      });

      expect(seenBody).toMatchObject({
        headerMedia: { type: 'image', link: 'https://picoa.app.br/arte.png' },
      });
    });

    it('sends headerMedia (Meta media id + filename) for a document header', async () => {
      let seenBody: Record<string, unknown> | null = null;
      server.use(
        http.post(CONVERSATIONS_URL, async ({ request }) => {
          seenBody = (await request.json()) as Record<string, unknown>;
          return HttpResponse.json(
            { success: true, data: { messageId: 'wamid.X==' } },
            { status: 201 },
          );
        }),
      );

      await adapter.sendTemplate({
        toE164: '+5592987654321',
        templateName: 'nota',
        language: 'pt_BR',
        variables: {},
        zernioAccountId: 'acc_zap',
        headerMedia: { type: 'document', id: '1234567890', filename: 'nota.pdf' },
      });

      expect(seenBody).toMatchObject({
        headerMedia: { type: 'document', id: '1234567890', filename: 'nota.pdf' },
      });
    });

    // Guarda de regressão para a campanha de HOJE (templates só-BODY): sem
    // headerMedia a chave NÃO pode aparecer no corpo — nem como `undefined`.
    it('omits headerMedia entirely when the caller does not pass one', async () => {
      let seenBody: Record<string, unknown> | null = null;
      server.use(
        http.post(CONVERSATIONS_URL, async ({ request }) => {
          seenBody = (await request.json()) as Record<string, unknown>;
          return HttpResponse.json(
            { success: true, data: { messageId: 'wamid.X==' } },
            { status: 201 },
          );
        }),
      );

      await adapter.sendTemplate({
        toE164: '+5592987654321',
        templateName: 'bem_vindo_mg',
        language: 'pt_BR',
        variables: {},
        zernioAccountId: 'acc_zap',
      });

      expect(seenBody).not.toHaveProperty('headerMedia');
      expect(Object.keys(seenBody ?? {}).sort()).toEqual([
        'accountId',
        'participantId',
        'templateLanguage',
        'templateName',
        'templateParams',
      ]);
    });

    it('throws a FATAL domain error when zernioAccountId is missing (no HTTP call)', async () => {
      // No msw handler registered — onUnhandledRequest:'error' would fail the
      // test if we POSTed, proving the guard fires BEFORE any network call.
      try {
        await adapter.sendTemplate({
          toE164: '+5592987654321',
          templateName: 'x',
          language: 'pt_BR',
          variables: {},
        });
        expect.unreachable('should have thrown');
      } catch (err) {
        const e = err as WhatsappSendError;
        expect(e).toBeInstanceOf(WhatsappSendError);
        expect(e.fatal).toBe(true);
        expect(e.providerErrorCode).toBe('zernio.account_missing');
      }
    });

    it('classifies a 429 rate limit as transient (non-fatal)', async () => {
      server.use(
        http.post(CONVERSATIONS_URL, () =>
          HttpResponse.json(
            { error: 'Rate limit exceeded.', type: 'rate_limit_error' },
            { status: 429 },
          ),
        ),
      );
      try {
        await adapter.sendTemplate({
          toE164: '+5592987654321',
          templateName: 'x',
          language: 'pt_BR',
          variables: {},
          zernioAccountId: 'acc_zap',
        });
        expect.unreachable('should have thrown');
      } catch (err) {
        expect((err as WhatsappSendError).fatal).toBe(false);
      }
    });

    // O 401 real da Zernio é literalmente `{"error":"Unauthorized"}` — sem
    // `code` e sem `type`. Só chega numa regra fatal se o adapter fizer o
    // fallback do código para o STATUS HTTP. Sem isso: retry infinito.
    it('classifies a bare 401 (no code/type in the body) as FATAL', async () => {
      server.use(
        http.post(CONVERSATIONS_URL, () =>
          HttpResponse.json({ error: 'Unauthorized' }, { status: 401 }),
        ),
      );
      try {
        await adapter.sendTemplate({
          toE164: '+5592987654321',
          templateName: 'x',
          language: 'pt_BR',
          variables: {},
          zernioAccountId: 'acc_zap',
        });
        expect.unreachable('should have thrown');
      } catch (err) {
        const e = err as WhatsappSendError;
        expect(e.fatal).toBe(true);
        expect(e.providerErrorCode).toBe('401');
      }
    });

    it('classifies a 403 (inbox add-on required) as FATAL', async () => {
      server.use(
        http.post(CONVERSATIONS_URL, () =>
          HttpResponse.json(
            { error: 'Inbox addon required or profile limit reached' },
            { status: 403 },
          ),
        ),
      );
      try {
        await adapter.sendTemplate({
          toE164: '+5592987654321',
          templateName: 'x',
          language: 'pt_BR',
          variables: {},
          zernioAccountId: 'acc_zap',
        });
        expect.unreachable('should have thrown');
      } catch (err) {
        const e = err as WhatsappSendError;
        expect(e.fatal).toBe(true);
        expect(e.providerErrorCode).toBe('403');
      }
    });

    it('classifies a 4xx unapproved/missing template as FATAL', async () => {
      server.use(
        http.post(CONVERSATIONS_URL, () =>
          HttpResponse.json(
            {
              error: 'Template not found or not approved',
              type: 'platform_error',
              code: '132001',
            },
            { status: 400 },
          ),
        ),
      );
      try {
        await adapter.sendTemplate({
          toE164: '+5592987654321',
          templateName: 'not_approved',
          language: 'pt_BR',
          variables: {},
          zernioAccountId: 'acc_zap',
        });
        expect.unreachable('should have thrown');
      } catch (err) {
        const e = err as WhatsappSendError;
        expect(e.fatal).toBe(true);
        expect(e.providerErrorCode).toBe('132001');
      }
    });
  });

  /**
   * Texto livre (mensagem de sessão). Sem isto, o operador NÃO conseguia
   * responder ninguém no único canal do cliente — o mesmo
   * `POST /inbox/conversations`, agora com `message` no lugar do bloco de
   * template. Só é chamado DENTRO da janela de 24h (o guard vive no
   * ChatService); o 131047 aqui é a rede de segurança da corrida.
   */
  describe('sendChatText (texto livre)', () => {
    it('POSTa {accountId, participantId, message} — sem NENHUMA chave de template', async () => {
      let seenBody: Record<string, unknown> | null = null;
      server.use(
        http.post(CONVERSATIONS_URL, async ({ request }) => {
          seenBody = (await request.json()) as Record<string, unknown>;
          return HttpResponse.json(
            { success: true, data: { messageId: 'wamid.FREE==', sentAt: '2026-07-13T12:00:00.000Z' } },
            { status: 201 },
          );
        }),
      );

      const r = await adapter.sendChatText!({
        instanceName: '',
        toE164: '+55 92 98765-4321',
        text: 'Obrigado pelo apoio!',
        zernioAccountId: 'acc_zap',
      });

      expect(r.providerMessageId).toBe('wamid.FREE==');
      expect(r.acceptedAt).toEqual(new Date('2026-07-13T12:00:00.000Z'));
      expect(seenBody).toEqual({
        accountId: 'acc_zap',
        participantId: '5592987654321',
        message: 'Obrigado pelo apoio!',
      });
      // Explícito: nem template, nem skipDmCheck (é o bypass de DM do X/Twitter).
      const body = seenBody as unknown as Record<string, unknown>;
      expect(body).not.toHaveProperty('templateName');
      expect(body).not.toHaveProperty('templateLanguage');
      expect(body).not.toHaveProperty('templateParams');
      expect(body).not.toHaveProperty('skipDmCheck');
    });

    // O body do POST /inbox/conversations não tem campo de citação: a citação
    // é persistida localmente, mas NÃO vai no wire — jamais inventada.
    it('ignora quotedWaMessageId (a API do Zernio não tem campo de citação)', async () => {
      let seenBody: Record<string, unknown> | null = null;
      server.use(
        http.post(CONVERSATIONS_URL, async ({ request }) => {
          seenBody = (await request.json()) as Record<string, unknown>;
          return HttpResponse.json({ success: true, data: { messageId: 'wamid.Q==' } }, { status: 201 });
        }),
      );
      await adapter.sendChatText!({
        instanceName: '', toE164: '+5592987654321', text: 'oi',
        quotedWaMessageId: 'wamid.PREV==', quotedPreview: 'anterior',
        zernioAccountId: 'acc_zap',
      });
      expect(Object.keys(seenBody!).sort()).toEqual(['accountId', 'message', 'participantId']);
    });

    it('sem accountId: falha FATAL antes de qualquer request (zernio.account_missing)', async () => {
      // onUnhandledRequest: 'error' — se algo for POSTado, o teste quebra.
      await expect(
        adapter.sendChatText!({ instanceName: '', toE164: '+5592987654321', text: 'oi' }),
      ).rejects.toMatchObject({ providerErrorCode: 'zernio.account_missing', fatal: true });
    });

    it('131047 da Meta (fora da janela) é classificado como fatal com mensagem PT-BR', async () => {
      server.use(
        http.post(CONVERSATIONS_URL, () =>
          HttpResponse.json(
            { error: 'Message failed to send', type: 'platform_error', platformError: { code: 131047 } },
            { status: 400 },
          ),
        ),
      );
      try {
        await adapter.sendChatText!({
          instanceName: '', toE164: '+5592987654321', text: 'oi', zernioAccountId: 'acc_zap',
        });
        expect.unreachable('should have thrown');
      } catch (err) {
        const e = err as WhatsappSendError;
        expect(e.providerErrorCode).toBe('131047');
        expect(e.fatal).toBe(true);
        expect(e.message).toContain('janela de 24h');
      }
    });
  });

  describe('parseWebhook', () => {
    // Shape REAL do `WebhookPayloadMessageDeliveryStatus` (OpenAPI 1.0.4 +
    // webhook logs reais da conta): `message.id` é o ObjectId INTERNO do Mongo
    // do Zernio e `message.platformMessageId` é o WAMID da Meta.
    //
    // O WAMID abaixo e o `conversationId` são os que a API devolveu AO VIVO em
    // `POST /inbox/conversations` → 201 `{data:{messageId:"wamid…"}}`, ou seja:
    // é EXATAMENTE o valor que o envio persiste em `Message.providerMessageId`.
    // Casar o status por `message.id` (o bug) nunca bate com esse valor — logo
    // NENHUMA mensagem Zernio saía de SENT (sem delivered/read/failed).
    const WAMID =
      'wamid.HBgMNTU5MjkzMzU5NTI3FQIAERgSMEM4OUM4ODU3QzM4Q0I4RUQwAA==';
    const INTERNAL_ID = 'a1b2c3d4e5f6a7b8c9d00003';

    const status = (
      event: string,
      extra: Record<string, unknown> = {},
      message: Record<string, unknown> = {
        id: INTERNAL_ID,
        platformMessageId: WAMID,
        conversationId: 'a1b2c3d4e5f6a7b8c9d00003',
        platform: 'whatsapp',
      },
    ) => ({
      id: 'evt',
      event,
      message,
      statusAt: '2026-07-10T10:00:00Z',
      timestamp: '2026-07-10T10:00:01Z',
      ...extra,
    });

    it('maps message.sent/delivered/read to normalized ack events keyed by the WAMID', () => {
      for (const [event, want] of [
        ['message.sent', 'sent'],
        ['message.delivered', 'delivered'],
        ['message.read', 'read'],
      ] as const) {
        const [e] = adapter.parseWebhook(status(event));
        expect(e.status).toBe(want);
        // O id que o ENVIO gravou — não o ObjectId interno do Zernio.
        expect(e.providerMessageId).toBe(WAMID);
        expect(e.occurredAt).toBeInstanceOf(Date);
      }
    });

    it('never keys a status event by the internal Mongo id when the WAMID is present', () => {
      const [e] = adapter.parseWebhook(status('message.delivered'));
      expect(e.providerMessageId).not.toBe(INTERNAL_ID);
    });

    it('falls back to message.id when the event carries no platformMessageId', () => {
      const [e] = adapter.parseWebhook(
        status('message.sent', {}, { id: 'msg_1' }),
      );
      expect(e.providerMessageId).toBe('msg_1');
    });

    it('maps message.failed and surfaces the error code + message', () => {
      const [e] = adapter.parseWebhook(
        status('message.failed', {
          error: { code: 131021, title: 'Invalid recipient', message: 'Not a WA user' },
        }),
      );
      expect(e.status).toBe('failed');
      expect(e.providerMessageId).toBe(WAMID);
      expect(e.errorCode).toBe('131021');
      expect(e.errorMessage).toBe('Not a WA user');
    });

    it('ignores non-status events (received / started / test)', () => {
      expect(adapter.parseWebhook(status('message.received'))).toEqual([]);
      expect(adapter.parseWebhook(status('conversation.started'))).toEqual([]);
      expect(adapter.parseWebhook(status('webhook.test'))).toEqual([]);
      expect(adapter.parseWebhook({})).toEqual([]);
    });

    // ── ZW — o telefone é a CHAVE do casamento do BROADCAST ──────────────────
    //
    // O `POST /broadcasts/{id}/send` NÃO devolve os wamids, então as Messages do
    // broadcast nascem SEM `providerMessageId` e o casamento por wamid não acha
    // nada. O único elo que o evento traz é o TELEFONE — em
    // `conversation.participantId`, sem o '+'.
    //
    // Payload REAL de um `message.delivered` de BROADCAST, capturado ao vivo em
    // 13/07 na conta de produção. PROVA de que broadcast dispara webhook de
    // status por mensagem, com o wamid, em tempo real: o orgamind NUNCA enviou
    // `bem_vindo_post_1` (a campanha dele foi barrada pelo gate), logo este
    // evento só pode ter vindo do broadcast disparado pelo painel.
    it('ZW: carrega o TELEFONE do destinatário (conversation.participantId) — a chave do casamento do broadcast', () => {
      const live = {
        id: '11111111-2222-4333-8444-555555555555',
        event: 'message.delivered',
        message: {
          id: 'a1b2c3d4e5f6a7b8c9d0000b',
          conversationId: 'a1b2c3d4e5f6a7b8c9d0000a',
          platform: 'whatsapp',
          platformMessageId:
            'wamid.HBgMNTU5Mjg2MTU0Njc3FQIAERgSQ0FFQTRFQjc1QkJGOTBFRjREAA==',
          direction: 'outgoing',
          text: '[Template: bem_vindo_post_1]',
          sentAt: '2026-07-13T14:21:06.836Z',
          isRead: true,
        },
        statusAt: '2026-07-13T14:23:19.000Z',
        conversation: {
          id: 'a1b2c3d4e5f6a7b8c9d0000a',
          participantId: '5592986550101',
          participantName: '+5592986550101',
          contactId: 'a1b2c3d4e5f6a7b8c9d00005',
        },
        account: { accountId: 'a1b2c3d4e5f6a7b8c9d0e1f2' },
        timestamp: '2026-07-13T14:23:21.495Z',
      };

      const [e] = adapter.parseWebhook(live);

      expect(e.status).toBe('delivered');
      expect(e.providerMessageId).toBe(
        'wamid.HBgMNTU5Mjg2MTU0Njc3FQIAERgSQ0FFQTRFQjc1QkJGOTBFRjREAA==',
      );
      // Normalizado para E.164 — é assim que Contact.phoneE164 é guardado.
      expect(e.recipientPhone).toBe('+5592986550101');
      // `statusAt` é a ORDEM REAL do evento (não o `timestamp` da entrega).
      expect(e.occurredAt).toEqual(new Date('2026-07-13T14:23:19.000Z'));
    });

    it('ZW: sem conversation.participantId, recipientPhone fica undefined (não inventa telefone)', () => {
      const [e] = adapter.parseWebhook(status('message.delivered'));
      expect(e.recipientPhone).toBeUndefined();
    });
  });

  describe('parseInboundMessages', () => {
    const received = (msg: Record<string, unknown>) => ({
      id: 'evt',
      event: 'message.received',
      message: { id: 'msg_in', ...msg },
      conversation: { id: 'conv1', participantId: '5592987654321', participantName: 'Maria' },
      account: { id: 'acc', platform: 'whatsapp' },
      timestamp: '2026-07-10T10:00:00Z',
    });

    it('maps a message.received to an InboundMessageEvent', () => {
      const [e] = adapter.parseInboundMessages(
        received({ message: 'oi tudo bem?' }),
      );
      expect(e.fromE164).toBe('+5592987654321');
      expect(e.text).toBe('oi tudo bem?');
      expect(e.providerMessageId).toBe('msg_in');
      expect(e.receivedAt).toBeInstanceOf(Date);
    });

    // O REST (`GET /inbox/conversations/{id}/messages`) devolve `messages[].id`
    // JÁ COMO O WAMID, enquanto o webhook manda o ObjectId interno em
    // `message.id` e o wamid em `platformMessageId`. Normalizar as duas
    // superfícies para o WAMID é o que impede o backfill de duplicar o chat.
    it('keys the inbound by the WAMID (platformMessageId) when present', () => {
      const [e] = adapter.parseInboundMessages(
        received({ platformMessageId: 'wamid.INBOUND==', text: 'oi' }),
      );
      expect(e.providerMessageId).toBe('wamid.INBOUND==');
    });

    it('returns [] for non-received events', () => {
      expect(
        adapter.parseInboundMessages({ event: 'message.delivered', message: { id: 'm' } }),
      ).toEqual([]);
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Opt-out por BOTÃO. Todo template MARKETING carrega o botão de opt-out
    // OBRIGATÓRIO da Meta. O tap chega em `metadata` — que o adapter ignorava
    // por completo — então quem clicava em "Parar promoções" NÃO era suprimido e
    // continuava recebendo campanha: bloqueio → denúncia → qualityRating
    // despenca → conta restrita. É o padrão que já queimou um número no projeto.
    //
    // Contrato de saída: o handler de opt-out (`webhooks.service`) casa pelo
    // literal `buttonPayload === 'optout'` (e grava ConsentSource.WA_BUTTON +
    // suppressionReason 'button_optout'). O adapter é a camada anticorrupção:
    // canonicaliza QUALQUER sinal de opt-out da Zernio para esse literal, e
    // repassa os demais botões crus.
    // ─────────────────────────────────────────────────────────────────────────
    describe('opt-out por botão (metadata)', () => {
      it('canonicaliza o botão de opt-out de TEMPLATE (metadata.buttonPayload) para "optout"', () => {
        // Botão de template: a doc diz que `interactiveType` vem VAZIO e o
        // payload vive em `metadata.buttonPayload`.
        const [e] = adapter.parseInboundMessages({
          ...received({ text: 'Parar promoções' }),
          metadata: { buttonPayload: 'optout', interactiveType: '' },
        });
        expect(e.buttonPayload).toBe('optout');
      });

      it('canonicaliza o rótulo LOCALIZADO do botão nativo de opt-out da Meta', () => {
        // O botão de opt-out nativo da Meta não tem payload escolhido por nós —
        // ele manda o RÓTULO localizado. Precisa suprimir do mesmo jeito.
        for (const label of ['Parar promoções', 'Stop promotions']) {
          const [e] = adapter.parseInboundMessages({
            ...received({ text: label }),
            metadata: { buttonPayload: label },
          });
          expect(e.buttonPayload).toBe('optout');
        }
      });

      it('canonicaliza um button_reply cujo interactiveId é de opt-out', () => {
        const [e] = adapter.parseInboundMessages({
          ...received({ text: 'Sair' }),
          metadata: { interactiveType: 'button_reply', interactiveId: 'opt_out' },
        });
        expect(e.buttonPayload).toBe('optout');
      });

      it('NÃO suprime um botão qualquer — repassa o payload cru', () => {
        const [e] = adapter.parseInboundMessages({
          ...received({ text: 'Quero sim!' }),
          metadata: { interactiveType: 'button_reply', interactiveId: 'optin_yes' },
        });
        expect(e.buttonPayload).toBe('optin_yes');
        expect(e.buttonPayload).not.toBe('optout');
      });

      it('deixa buttonPayload unset numa mensagem de texto normal (sem metadata)', () => {
        const [e] = adapter.parseInboundMessages(received({ text: 'bom dia' }));
        expect(e.buttonPayload).toBeUndefined();
      });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Opt-in por BOTÃO — o espelho exato do bloco acima.
    //
    // `chat-ingest` só grava consentimento quando `buttonPayload === 'optin_yes'`
    // (igualdade exata). Esse literal é um id de botão que NÓS escolhemos — e o
    // envio da Zernio (`POST /inbox/conversations`) não tem campo NENHUM para
    // payload de quick_reply: só `templateParams` (variáveis posicionais). Logo
    // o literal nunca sai daqui e nunca volta: no tap chega o RÓTULO
    // ("Sim, quero receber"), o `===` falha, e o consentimento é descartado EM
    // SILÊNCIO. Numa campanha de opt-in isso significa colher milhares de
    // cliques e jogar todos fora, achando que colheu.
    //
    // O adapter é a camada anticorrupção: canonicaliza o sinal de opt-in para
    // `optin_yes`, como já faz com o de opt-out para `optout`.
    //
    // O VIÉS AQUI É O INVERSO DO OPT-OUT, e isso é a regra do bloco: no opt-out
    // o erro barato é o falso-POSITIVO (suprime um contato a mais). No opt-in o
    // erro FATAL é o falso-positivo — grava um ConsentEvent (append-only,
    // irreversível) dizendo que a pessoa autorizou quando ela não autorizou.
    // Falso-negativo o titular refaz; prova falsa não se desfaz. Por isso: lista
    // FECHADA, igualdade de valor INTEIRO, e opt-out com precedência absoluta.
    // ─────────────────────────────────────────────────────────────────────────
    describe('opt-in por botão (metadata)', () => {
      it('canonicaliza o RÓTULO do botão de template para "optin_yes"', () => {
        // O caso da campanha real: template com quick_reply "Sim, quero receber".
        // Sem payload escolhido por nós, o que volta é o rótulo.
        for (const label of [
          'Sim, quero receber',
          'sim quero receber',
          'SIM, QUERO RECEBER',
          'Sim, quero receber!',
        ]) {
          const [e] = adapter.parseInboundMessages({
            ...received({ message: label }),
            metadata: { buttonPayload: label, interactiveType: '' },
          });
          expect(e.buttonPayload).toBe('optin_yes');
        }
      });

      it('canonicaliza também no parse da INBOX (parseInboundChatMessages)', () => {
        const [e] = adapter.parseInboundChatMessages({
          ...received({ message: 'Sim, quero receber' }),
          metadata: { buttonPayload: 'Sim, quero receber', interactiveType: '' },
        });
        expect(e.buttonPayload).toBe('optin_yes');
        // O rótulo cru continua sendo o texto exibido na conversa.
        expect(e.text).toBe('Sim, quero receber');
      });

      it('canonicaliza o rótulo mesmo quando o tap chega sem texto', () => {
        const [e] = adapter.parseInboundMessages({
          ...received({}),
          metadata: { buttonPayload: 'Quero receber mensagens', interactiveType: '' },
        });
        expect(e.buttonPayload).toBe('optin_yes');
      });

      // ─── ANTI-FABRICAÇÃO: os testes que realmente importam ───

      it('"Não quero receber" é OPT-OUT, JAMAIS opt-in (contém "quero receber")', () => {
        // A armadilha do português: a afirmativa é substring PRÓPRIA da
        // negativa. Qualquer `includes('quero receber')` no matcher de opt-in
        // transforma o clique no botão NÃO em consentimento — o oposto exato da
        // vontade do titular, gravado como prova irreversível.
        for (const label of [
          'Não quero receber',
          'nao quero receber',
          'NÃO QUERO RECEBER',
          'Não, quero receber',
          'Não quero receber mensagens',
        ]) {
          const [e] = adapter.parseInboundMessages({
            ...received({ message: label }),
            metadata: { buttonPayload: label, interactiveType: '' },
          });
          expect(e.buttonPayload).toBe('optout');
          expect(e.buttonPayload).not.toBe('optin_yes');
        }
      });

      it('nenhuma negativa vira opt-in', () => {
        for (const label of [
          'Não, obrigado',
          'Prefiro não receber',
          'Agora não',
          'Parar promoções',
          'Cancelar inscrição',
          'Descadastrar',
        ]) {
          const [e] = adapter.parseInboundMessages({
            ...received({ message: label }),
            metadata: { buttonPayload: label, interactiveType: '' },
          });
          expect(e.buttonPayload).not.toBe('optin_yes');
        }
      });

      it('afirmativa GENÉRICA não vira consentimento (a finalidade não é dela)', () => {
        // A finalidade e a prova vêm da OUTBOUND da campanha, não do botão. Um
        // "Sim" de OUTRO fluxo (confirmar presença, enquete) viraria
        // consentimento para uma finalidade que o titular nunca leu. Só entram
        // rótulos que NOMEIAM o recebimento das mensagens.
        for (const label of ['Sim', 'OK', 'Confirmo', 'Claro', 'Quero', 'Talvez']) {
          const [e] = adapter.parseInboundMessages({
            ...received({ message: label }),
            metadata: { buttonPayload: label, interactiveType: '' },
          });
          expect(e.buttonPayload).not.toBe('optin_yes');
        }
      });

      it('"Pode enviar" NÃO vira opt-in — autorizar um ENVIO não é pedir MENSAGENS', () => {
        // Rótulo de botão é texto livre que o operador digita (template-form).
        // Um template alheio — "Podemos enviar seu comprovante?" com
        // [Pode enviar] / [Agora não] — geraria, com estes rótulos na lista, um
        // GRANT append-only para uma finalidade que a pessoa nunca viu. A regra
        // da lista é: só entra o que NOMEIA o RECEBIMENTO das mensagens.
        for (const label of [
          'Pode enviar',
          'pode me enviar',
          'Sim, pode enviar',
          'Autorizo o envio',
        ]) {
          const [e] = adapter.parseInboundMessages({
            ...received({ message: label }),
            metadata: { buttonPayload: label, interactiveType: '' },
          });
          expect(e.buttonPayload).not.toBe('optin_yes');
        }
      });

      it('TEXTO LIVRE nunca vira botão — digitar "sim" não é consentimento', () => {
        // A guarda inegociável: sem `metadata.buttonPayload`/`interactiveId` não
        // houve TOQUE, e sem toque não há ato afirmativo. O rótulo só é lido
        // depois que um tap já foi provado.
        for (const text of ['sim', 'Sim, quero receber', 'quero receber']) {
          const [chat] = adapter.parseInboundChatMessages(received({ message: text }));
          const [evt] = adapter.parseInboundMessages(received({ message: text }));
          expect(chat.buttonPayload).toBeUndefined();
          expect(evt.buttonPayload).toBeUndefined();
        }
      });

      it('o id canônico `optin_yes` continua passando (idempotente)', () => {
        const [e] = adapter.parseInboundMessages({
          ...received({ message: 'Quero sim!' }),
          metadata: { interactiveType: 'button_reply', interactiveId: 'optin_yes' },
        });
        expect(e.buttonPayload).toBe('optin_yes');
      });

      it('botão não relacionado passa CRU — não vira opt-in nem opt-out', () => {
        const [e] = adapter.parseInboundMessages({
          ...received({ message: 'Falar com a equipe' }),
          metadata: { buttonPayload: 'Falar com a equipe', interactiveType: '' },
        });
        expect(e.buttonPayload).toBe('Falar com a equipe');
      });
    });
  });

  describe('parseInboundChatMessages', () => {
    const received = (msg: Record<string, unknown>) => ({
      id: 'evt',
      event: 'message.received',
      message: { id: 'msg_in', ...msg },
      conversation: { id: 'conv1', participantId: '5592987654321', participantName: 'Maria' },
      account: { id: 'acc', platform: 'whatsapp' },
      timestamp: '2026-07-10T10:00:00Z',
    });

    it('maps a text inbound to a TEXT InboundChatMessage', () => {
      const [m] = adapter.parseInboundChatMessages(
        received({ message: 'olá' }),
      );
      expect(m.kind).toBe('TEXT');
      expect(m.remoteJid).toBe('5592987654321@s.whatsapp.net');
      expect(m.phoneE164).toBe('+5592987654321');
      expect(m.isGroup).toBe(false);
      expect(m.fromMe).toBe(false);
      expect(m.pushName).toBe('Maria');
      expect(m.text).toBe('olá');
    });

    it('maps an image attachment to kind IMAGE', () => {
      const [m] = adapter.parseInboundChatMessages(
        received({
          message: '',
          attachments: [
            { id: 'a1', type: 'image', url: 'https://cdn/x.jpg', filename: 'x.jpg' },
          ],
        }),
      );
      expect(m.kind).toBe('IMAGE');
      expect(m.media?.fileName).toBe('x.jpg');
    });

    it('keys the chat message by the WAMID (platformMessageId) when present', () => {
      const [m] = adapter.parseInboundChatMessages(
        received({ platformMessageId: 'wamid.INBOUND==', text: 'oi' }),
      );
      expect(m.providerMessageId).toBe('wamid.INBOUND==');
    });

    it('propaga o botão para o chat: payload canonicalizado + rótulo no texto', () => {
      const [m] = adapter.parseInboundChatMessages({
        ...received({ text: 'Parar promoções' }),
        metadata: { buttonPayload: 'optout' },
      });
      expect(m.buttonPayload).toBe('optout');
      // O rótulo que a pessoa realmente tocou — é o `evidenceText` do REVOKE.
      expect(m.text).toBe('Parar promoções');
      expect(m.kind).toBe('TEXT');
    });

    it('usa o payload do botão como texto quando a Zernio não manda rótulo', () => {
      // Buraco conhecido da doc: não é garantido que a Zernio preencha
      // `message.text` num tap de botão. Sem isso o chat mostraria vazio e o
      // REVOKE ficaria sem evidência textual.
      const [m] = adapter.parseInboundChatMessages({
        ...received({}),
        metadata: { interactiveType: 'button_reply', interactiveId: 'optin_yes' },
      });
      expect(m.buttonPayload).toBe('optin_yes');
      expect(m.text).toBe('optin_yes');
    });

    it('returns [] for non-received events', () => {
      expect(
        adapter.parseInboundChatMessages({ event: 'message.sent', message: { id: 'm' } }),
      ).toEqual([]);
    });
  });

  describe('verifyZernioSignature', () => {
    const raw = Buffer.from(
      JSON.stringify({ id: 'evt', event: 'message.received' }),
      'utf-8',
    );
    const good = createHmac('sha256', WEBHOOK_SECRET)
      .update(raw)
      .digest('hex');

    it('accepts a valid HMAC-SHA256 hex signature (no prefix)', () => {
      expect(adapter.verifyZernioSignature(raw, good)).toBe(true);
    });

    it('rejects a tampered signature of equal length (constant-time path)', () => {
      const flipped = (good[0] === '0' ? '1' : '0') + good.slice(1);
      expect(adapter.verifyZernioSignature(raw, flipped)).toBe(false);
    });

    it('rejects a signature of a different length', () => {
      expect(adapter.verifyZernioSignature(raw, 'deadbeef')).toBe(false);
    });

    it('rejects when the signature header is absent', () => {
      expect(adapter.verifyZernioSignature(raw, undefined)).toBe(false);
    });

    it('rejects (fails closed) when no webhook secret is configured', () => {
      const noSecret = new ZernioCloudAdapter(
        makeConfig({ ZERNIO_WEBHOOK_SECRET: undefined }),
      );
      expect(noSecret.verifyZernioSignature(raw, good)).toBe(false);
    });
  });
});

/**
 * ZC — o webhook de aprovação de template. O orgamind JÁ estava inscrito nele no
 * painel do Zernio, mas o parseWebhook o descartava (o STATUS_MAP só cobre
 * `message.*`): o sinal chegava e ia para o lixo.
 */
describe('parseZernioTemplateStatusEvent', () => {
  /** O payload real do evento (dossiê §3.2). */
  function event(template: Record<string, unknown> = {}) {
    return {
      id: 'evt_1',
      event: 'whatsapp.template.status_updated',
      account: { accountId: 'acc_1' },
      template: {
        templateId: '833669913010819',
        name: 'bem_vindo_mg',
        language: 'pt_BR',
        status: 'APPROVED',
        reason: 'NONE',
        ...template,
      },
      timestamp: '2026-07-12T00:00:00.000Z',
    };
  }

  it('normaliza o evento (id da Meta, nome, idioma, status, motivo)', () => {
    expect(parseZernioTemplateStatusEvent(event())).toEqual({
      zernioTemplateId: '833669913010819',
      metaName: 'bem_vindo_mg',
      language: 'pt_BR',
      status: 'APPROVED',
      reason: 'NONE',
    });
  });

  // A listagem só dá APPROVED/PENDING/REJECTED; é o WEBHOOK que amplia. O parse
  // entrega o status CRU — mapear (com perda) é trabalho de quem grava.
  it.each(['PAUSED', 'DISABLED', 'IN_APPEAL', 'PENDING_DELETION'])(
    'entrega o status %s cru, sem filtrar',
    (status) => {
      expect(parseZernioTemplateStatusEvent(event({ status }))?.status).toBe(
        status,
      );
    },
  );

  it('idioma ausente → pt_BR (o idioma faz parte da chave única)', () => {
    expect(
      parseZernioTemplateStatusEvent(event({ language: undefined }))?.language,
    ).toBe('pt_BR');
  });

  // Sem nome não há como casar a row — e uma row errada é pior do que nenhuma.
  it('sem nome → null', () => {
    expect(parseZernioTemplateStatusEvent(event({ name: '' }))).toBeNull();
  });

  it.each([
    ['outro evento', { event: 'message.received', template: { name: 'x' } }],
    ['sem bloco template', { event: 'whatsapp.template.status_updated' }],
    ['payload vazio', {}],
    ['null', null],
  ])('%s → null', (_label, payload) => {
    expect(parseZernioTemplateStatusEvent(payload)).toBeNull();
  });
});
