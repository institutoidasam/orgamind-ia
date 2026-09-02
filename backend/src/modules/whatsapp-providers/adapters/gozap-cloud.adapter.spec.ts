import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  afterEach,
  vi,
} from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { GozapCloudAdapter } from './gozap-cloud.adapter';
import { WhatsappSendError } from '../errors/whatsapp.errors';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const BASE = 'https://acme.gozap.dev';
function makeConfig(o: Record<string, string | undefined> = {}) {
  const v: Record<string, string | undefined> = {
    GOZAP_BASE_URL: BASE,
    GOZAP_ADMIN_TOKEN: 'admtok',
    ...o,
  };
  return { get: (k: string) => v[k] } as unknown as ConfigService;
}

describe('GozapCloudAdapter', () => {
  const adapter = new GozapCloudAdapter(makeConfig());

  it('name é "gozap" e o profile declara campaignSend + traits de sessão', () => {
    expect(adapter.name).toBe('gozap');
    expect(adapter.profile.traits.sessionBased).toBe(true);
    expect(adapter.profile.capabilities.has('campaignSend')).toBe(true);
  });

  it('NÃO declara sessionLifecycle nesta fase — o ciclo de vida (QR/conexão) vive num service dedicado (F-A Task 7), não nos métodos do port', () => {
    expect(adapter.profile.capabilities.has('sessionLifecycle')).toBe(false);
  });

  /**
   * ANTES esta linha afirmava `inboxChat === false`, e era ela que congelava o
   * defeito: sem a capacidade, o compositor da inbox ficava fechado no frontend
   * e o `ChatService` mandava todo canal sem janela de sessão para o ramo
   * Evolution, onde uma resposta manual num canal GOZAP morria em
   * `ChannelNotEvolutionError`. O envio do GoZap é real e já foi testado em
   * produção com mensagem de verdade — o que faltava era expor o texto livre
   * pelo port (`sendChatText`), e agora a capacidade é VERDADE declarada.
   */
  it('declara inboxChat — responder pelo inbox num canal GoZap funciona', () => {
    expect(adapter.profile.capabilities.has('inboxChat')).toBe(true);
    expect(typeof adapter.sendChatText).toBe('function');
  });

  describe('sendTemplate', () => {
    it('TEXT → POST /send/text com number sem "+" e token da instância', async () => {
      let seenBody: any = null;
      let seenToken: string | null = null;
      server.use(
        http.post(`${BASE}/send/text`, async ({ request }) => {
          seenToken = request.headers.get('token');
          seenBody = await request.json();
          return HttpResponse.json(
            {
              success: true,
              message: {
                id: 'MSG1',
                timestamp: '2026-07-17T12:00:00Z',
                sender: 'x@s.whatsapp.net',
              },
            },
            { status: 200 },
          );
        }),
      );
      const r = await adapter.sendTemplate({
        toE164: '+5592987654321',
        templateName: 'oi',
        language: 'pt_BR',
        variables: { '1': 'João' },
        body: 'Olá {{1}}',
        kind: 'TEXT',
        gozapInstanceToken: 'inst_tok',
      } as any);
      expect(r.providerMessageId).toBe('MSG1');
      expect(seenToken).toBe('inst_tok');
      expect(seenBody.number).toBe('5592987654321'); // sem '+'
      expect(seenBody.text).toBe('Olá João'); // corpo interpolado localmente
    });

    it('LIST → POST /send/list com sections mapeadas', async () => {
      let seenBody: any = null;
      server.use(
        http.post(`${BASE}/send/list`, async ({ request }) => {
          seenBody = await request.json();
          return HttpResponse.json({
            success: true,
            message: { id: 'X', timestamp: 't', sender: 's' },
          });
        }),
      );
      const r = await adapter.sendTemplate({
        toE164: '+5592987654321',
        templateName: 't',
        language: 'pt_BR',
        variables: {},
        kind: 'LIST',
        gozapInstanceToken: 'tok',
        interactiveConfig: {
          title: 'Título',
          description: 'Escolha uma opção',
          buttonText: 'Ver opções',
          footerText: 'Rodapé',
          sections: [
            {
              title: 'Seção 1',
              rows: [{ rowId: 'r1', title: 'Linha 1', description: 'desc' }],
            },
          ],
        },
      } as any);
      expect(r.providerMessageId).toBe('X');
      expect(seenBody.number).toBe('5592987654321');
      expect(seenBody.buttonText).toBe('Ver opções');
      expect(seenBody.sections[0].rows[0].rowId).toBe('r1');
      expect(seenBody.sections[0].rows[0].title).toBe('Linha 1');
    });

    it('BUTTONS → POST /send/button com botões mapeados', async () => {
      let seenBody: any = null;
      server.use(
        http.post(`${BASE}/send/button`, async ({ request }) => {
          seenBody = await request.json();
          return HttpResponse.json({
            success: true,
            message: { id: 'X', timestamp: 't', sender: 's' },
          });
        }),
      );
      const r = await adapter.sendTemplate({
        toE164: '+5592987654321',
        templateName: 't',
        language: 'pt_BR',
        variables: {},
        kind: 'BUTTONS',
        gozapInstanceToken: 'tok',
        interactiveConfig: {
          description: 'Escolha uma opção',
          buttons: [{ buttonId: 'b1', title: 'Sim' }],
        },
      } as any);
      expect(r.providerMessageId).toBe('X');
      expect(seenBody.number).toBe('5592987654321');
      expect(seenBody.buttons[0].id).toBe('b1');
      expect(seenBody.buttons[0].text).toBe('Sim');
    });

    it('POLL → POST /send/poll com opções mapeadas', async () => {
      let seenBody: any = null;
      server.use(
        http.post(`${BASE}/send/poll`, async ({ request }) => {
          seenBody = await request.json();
          return HttpResponse.json({
            success: true,
            message: { id: 'X', timestamp: 't', sender: 's' },
          });
        }),
      );
      const r = await adapter.sendTemplate({
        toE164: '+5592987654321',
        templateName: 't',
        language: 'pt_BR',
        variables: {},
        kind: 'POLL',
        gozapInstanceToken: 'tok',
        interactiveConfig: {
          question: 'Pergunta?',
          options: ['A', 'B'],
          selectableOptionsCount: 1,
        },
      } as any);
      expect(r.providerMessageId).toBe('X');
      expect(seenBody.number).toBe('5592987654321');
      expect(seenBody.options).toEqual(['A', 'B']);
      expect(seenBody.selectableCount).toBe(1);
    });

    it('sem gozapInstanceToken → WhatsappSendError fatal, sem POST', async () => {
      // Nenhum handler msw registrado para este teste: se o adapter tentasse
      // POSTar mesmo sem token, `onUnhandledRequest: 'error'` reprovaria o teste.
      await expect(
        adapter.sendTemplate({
          toE164: '+5592987654321',
          templateName: 't',
          language: 'pt_BR',
          variables: {},
          body: 'oi',
          kind: 'TEXT',
        } as any),
      ).rejects.toMatchObject({
        fatal: true,
        providerErrorCode: 'gozap.no_token',
      });
    });

    it('número inexistente → WhatsappSendError fatal via classifyGozapError', async () => {
      server.use(
        http.post(`${BASE}/send/text`, () =>
          HttpResponse.json(
            {
              success: false,
              error: 'Número inválido / não existe no WhatsApp',
            },
            { status: 400 },
          ),
        ),
      );
      await expect(
        adapter.sendTemplate({
          toE164: '+55x',
          templateName: 't',
          language: 'pt',
          variables: {},
          body: 'oi',
          kind: 'TEXT',
          gozapInstanceToken: 'tok',
        } as any),
      ).rejects.toMatchObject({
        fatal: true,
        providerErrorCode: 'gozap.invalid_recipient',
      });
    });

    it('timeout → WhatsappSendError INDETERMINADO (gozap.timeout, não-fatal, não reenvia)', async () => {
      server.use(http.post(`${BASE}/send/text`, () => HttpResponse.error()));
      try {
        await adapter.sendTemplate({
          // Telefone REAL de propósito: o assunto deste teste é a classificação
          // do timeout, e o `+55` que estava aqui agora morre antes na guarda
          // de destinatário (`gozap.invalid_recipient`) — que é o comportamento
          // certo, mas mascararia o que este teste mede.
          toE164: '+5592995550101',
          templateName: 't',
          language: 'pt',
          variables: {},
          body: 'oi',
          kind: 'TEXT',
          gozapInstanceToken: 'tok',
        } as any);
        expect.unreachable('deveria ter lançado');
      } catch (err) {
        expect(err).toBeInstanceOf(WhatsappSendError);
        const e = err as WhatsappSendError;
        // Mesmo padrão do `twilio.timeout`: o POST pode ter saído — status
        // indeterminado, NÃO reenviar automaticamente. `fatal: false` aqui
        // não significa "retry cego" — significa "não classificar como
        // recusa definitiva do destinatário"; a decisão de não reenviar por
        // status indeterminado é tratada a jusante (processor), chaveada
        // pelo código `gozap.timeout`.
        expect(e.providerErrorCode).toBe('gozap.timeout');
        expect(e.fatal).toBe(false);
      }
    });

    it('resposta 200 sem message.id → WhatsappSendError (contrato quebrado)', async () => {
      server.use(
        http.post(`${BASE}/send/text`, () =>
          HttpResponse.json({ success: true, message: {} }),
        ),
      );
      await expect(
        adapter.sendTemplate({
          toE164: '+5592987654321',
          templateName: 't',
          language: 'pt',
          variables: {},
          body: 'oi',
          kind: 'TEXT',
          gozapInstanceToken: 'tok',
        } as any),
      ).rejects.toBeInstanceOf(WhatsappSendError);
    });

    /**
     * Elevado de Minor na revisão da Task 5: com a terminalização de
     * gozap.timeout em paralelo (mensagens indeterminadas passam a NUNCA
     * mais ser reenviadas — nem fila, nem lote, nem botão do operador),
     * juntar TODO erro sem `.response` sob o mesmo código vira destrutivo.
     * ECONNREFUSED/ENOTFOUND/EAI_AGAIN significam que a conexão NUNCA se
     * estabeleceu — o POST nunca chegou ao GoZap, retentar é seguro. Só um
     * ECONNABORTED/reset/hang-up é de fato INDETERMINADO (a requisição
     * partiu e a resposta se perdeu). `HttpResponse.error()` do msw não
     * carrega `.code` nenhum (testado empiricamente), então essa distinção
     * só é exercitável stubando `http.post` diretamente — mesmo padrão já
     * usado em evolution-api.adapter.spec.ts.
     */
    describe('timeout vs. inacessível (client-side network codes)', () => {
      it('ECONNREFUSED → gozap.unreachable, NÃO-fatal (conexão nunca se estabeleceu)', async () => {
        const a = new GozapCloudAdapter(makeConfig());
        const post = vi.fn().mockRejectedValue({
          code: 'ECONNREFUSED',
          message: 'connect ECONNREFUSED 127.0.0.1:443',
        });
        (a as unknown as { http: unknown }).http = { post };
        try {
          await a.sendTemplate({
            toE164: '+5592987654321',
            templateName: 't',
            language: 'pt',
            variables: {},
            body: 'oi',
            kind: 'TEXT',
            gozapInstanceToken: 'tok',
          } as any);
          expect.unreachable('deveria ter lançado');
        } catch (err) {
          const e = err as WhatsappSendError;
          expect(e.providerErrorCode).toBe('gozap.unreachable');
          expect(e.fatal).toBe(false);
        }
      });

      it('ENOTFOUND → gozap.unreachable, NÃO-fatal', async () => {
        const a = new GozapCloudAdapter(makeConfig());
        const post = vi.fn().mockRejectedValue({
          code: 'ENOTFOUND',
          message: 'getaddrinfo ENOTFOUND acme.gozap.dev',
        });
        (a as unknown as { http: unknown }).http = { post };
        try {
          await a.sendTemplate({
            toE164: '+5592987654321',
            templateName: 't',
            language: 'pt',
            variables: {},
            body: 'oi',
            kind: 'TEXT',
            gozapInstanceToken: 'tok',
          } as any);
          expect.unreachable('deveria ter lançado');
        } catch (err) {
          const e = err as WhatsappSendError;
          expect(e.providerErrorCode).toBe('gozap.unreachable');
          expect(e.fatal).toBe(false);
        }
      });

      it('ECONNABORTED (timeout de verdade, sem código de conexão) → continua gozap.timeout, INDETERMINADO', async () => {
        const a = new GozapCloudAdapter(makeConfig());
        const post = vi.fn().mockRejectedValue({
          code: 'ECONNABORTED',
          message: 'timeout of 30000ms exceeded',
        });
        (a as unknown as { http: unknown }).http = { post };
        try {
          await a.sendTemplate({
            toE164: '+5592987654321',
            templateName: 't',
            language: 'pt',
            variables: {},
            body: 'oi',
            kind: 'TEXT',
            gozapInstanceToken: 'tok',
          } as any);
          expect.unreachable('deveria ter lançado');
        } catch (err) {
          const e = err as WhatsappSendError;
          expect(e.providerErrorCode).toBe('gozap.timeout');
          expect(e.fatal).toBe(false);
        }
      });
    });
  });
  /**
   * Payload REAL, capturado em produção (2026-08-07) via GOZAP_WEBHOOK_DEBUG na
   * instância do cliente. Substituiu a "interpretação provisória" anterior, que
   * lia `data.id`/`data.status`/`data.from`/`data.text`/`data.timestamp` —
   * campos que NÃO EXISTEM. O GoZap é whatsmeow (Go) e emite o evento CRU, em
   * PascalCase; por isso 100% dos eventos eram descartados em silêncio.
   */
  /**
   * INCIDENTE 2026-08-07 — a causa raiz da campanha que não entregou nada.
   * O orgamind mandava o E.164 com o 9º dígito (13) para uma conta registrada na
   * forma antiga (12). O WhatsApp aceitava e descartava calado: `Sent` para
   * sempre, sem erro. Medido no mesmo número: 13 díg. nunca entregou, 12 díg.
   * entregou em 15s.
   */
  describe('sendTemplate — resolve o número canônico antes de enviar', () => {
    const ENVIO = {
      templateName: 't',
      language: 'pt',
      variables: {},
      body: 'oi',
      kind: 'TEXT' as const,
      gozapInstanceToken: 'tok',
    };

    function stubHttp(a: GozapCloudAdapter, check: unknown) {
      const calls: Array<{ path: string; body: any }> = [];
      const post = vi.fn(async (path: string, body: any) => {
        calls.push({ path, body });
        if (path === '/chat/check') return { data: check };
        return { data: { success: true, message: { id: 'MID' } } };
      });
      (a as unknown as { http: unknown }).http = { post };
      return calls;
    }

    it('envia para o número SEM o 9º dígito quando é ele o registrado', async () => {
      const a = new GozapCloudAdapter(makeConfig());
      const calls = stubHttp(a, {
        contacts: [{ IsIn: true, PhoneNumber: '559295550101@s.whatsapp.net' }],
      });

      await a.sendTemplate({ ...ENVIO, toE164: '+5592995550101' });

      const envio = calls.find((c) => c.path !== '/chat/check');
      expect(envio!.body.number).toBe('559295550101');
    });

    it('número não registrado no WhatsApp → erro FATAL, não envio no vácuo', async () => {
      const a = new GozapCloudAdapter(makeConfig());
      stubHttp(a, { contacts: [{ IsIn: false }] });

      await expect(
        a.sendTemplate({ ...ENVIO, toE164: '+5592995550101' } as any),
      ).rejects.toMatchObject({
        providerErrorCode: 'gozap.not_on_whatsapp',
        fatal: true,
      });
    });

    it('canônico de OUTRO assinante → IGNORA e usa o original (nunca dispara para um estranho)', async () => {
      // Aconteceu de verdade: o /chat/check devolveu um número que não era o
      // pedido. Entregar para a pessoa errada é pior do que não entregar.
      const a = new GozapCloudAdapter(makeConfig());
      const calls = stubHttp(a, {
        contacts: [{ IsIn: true, PhoneNumber: '551199998888@s.whatsapp.net' }],
      });

      await a.sendTemplate({ ...ENVIO, toE164: '+5592995550101' });

      const envio = calls.find((c) => c.path !== '/chat/check');
      expect(envio!.body.number).toBe('5592995550101');
    });

    it('/chat/check indisponível → envia com o número original (best-effort)', async () => {
      const a = new GozapCloudAdapter(makeConfig());
      const post = vi.fn(async (path: string) => {
        if (path === '/chat/check') throw new Error('rede fora');
        return { data: { success: true, message: { id: 'MID' } } };
      });
      (a as unknown as { http: unknown }).http = { post };

      await expect(
        a.sendTemplate({ ...ENVIO, toE164: '+5592995550101' } as any),
      ).resolves.toMatchObject({ providerMessageId: 'MID' });
    });

    it('resolve UMA vez por destinatário — não paga /chat/check por mensagem', async () => {
      const a = new GozapCloudAdapter(makeConfig());
      const calls = stubHttp(a, {
        contacts: [{ IsIn: true, PhoneNumber: '559295550101@s.whatsapp.net' }],
      });

      await a.sendTemplate({ ...ENVIO, toE164: '+5592995550101' });
      await a.sendTemplate({ ...ENVIO, toE164: '+5592995550101' });

      expect(calls.filter((c) => c.path === '/chat/check')).toHaveLength(1);
    });
  });

  describe('parseWebhook — messages_update (events.Receipt do whatsmeow)', () => {
    /** Cópia fiel de um frame capturado, com telefones trocados. */
    function recibo(over: Record<string, unknown> = {}) {
      return {
        event: 'messages_update',
        instance_id: 'rffe51e7ef7c8ff',
        timestamp: 1786126509316,
        data: {
          Chat: '123456789012345@lid',
          Sender: '123456789012345@lid',
          MessageSender: '123456789012345@lid',
          IsFromMe: false,
          IsGroup: false,
          MessageIDs: ['ACB1CD2345FB6AF7FC89B012DE345678'],
          Timestamp: '2026-08-07T18:15:09Z',
          Type: '',
          ...over,
        },
      };
    }

    it('Type VAZIO é o recibo de ENTREGA (whatsmeow não tem tipo "delivered")', () => {
      const [e] = adapter.parseWebhook(recibo());
      expect(e.providerMessageId).toBe('ACB1CD2345FB6AF7FC89B012DE345678');
      expect(e.status).toBe('delivered');
      // ISO-8601, não epoch em segundos — `timestamp * 1000` dava NaN.
      expect(e.occurredAt).toEqual(new Date('2026-08-07T18:15:09Z'));
    });

    it('Type "read" vira read; "played" também', () => {
      expect(adapter.parseWebhook(recibo({ Type: 'read' }))[0].status).toBe(
        'read',
      );
      expect(adapter.parseWebhook(recibo({ Type: 'played' }))[0].status).toBe(
        'read',
      );
    });

    it('"read-self" é IGNORADO — é a nossa leitura em outro aparelho, não a do contato', () => {
      expect(adapter.parseWebhook(recibo({ Type: 'read-self' }))).toEqual([]);
    });

    it('um recibo pode referenciar VÁRIAS mensagens — todas viram evento', () => {
      const evs = adapter.parseWebhook(
        recibo({ MessageIDs: ['M1', 'M2', 'M3'] }),
      );
      expect(evs.map((e) => e.providerMessageId)).toEqual(['M1', 'M2', 'M3']);
      expect(evs.every((e) => e.status === 'delivered')).toBe(true);
    });

    it('só trata a categoria messages_update — um "messages" não vira ack', () => {
      expect(adapter.parseWebhook({ ...recibo(), event: 'messages' })).toEqual(
        [],
      );
      expect(adapter.parseWebhook(recibo({ MessageIDs: [] }))).toEqual([]);
      expect(
        adapter.parseWebhook({ event: 'messages_update', data: {} }),
      ).toEqual([]);
    });

    it('NUNCA lança em payload malformado/hostil — evento ignorado vira []', () => {
      for (const bad of [
        null,
        undefined,
        'string qualquer',
        42,
        [1, 2, 3],
        { data: null },
        { event: 'messages_update', data: { MessageIDs: [1, 2] } },
      ]) {
        expect(() => adapter.parseWebhook(bad)).not.toThrow();
        expect(adapter.parseWebhook(bad)).toEqual([]);
      }
    });
  });

  describe('parseInboundMessages — messages (events.Message do whatsmeow)', () => {
    function recebida(
      info: Record<string, unknown> = {},
      msg: Record<string, unknown> = {},
    ) {
      return {
        event: 'messages',
        instance_id: 'rffe51e7ef7c8ff',
        timestamp: 1786126513000,
        data: {
          Info: {
            ID: 'A1234567890C12D3456A7E890C1E2',
            Chat: '123456789012345@lid',
            Sender: '123456789012345@lid',
            SenderAlt: '5592987654321@s.whatsapp.net',
            IsFromMe: false,
            IsGroup: false,
            PushName: 'Fulano',
            Timestamp: '2026-08-07T18:15:13Z',
            Type: 'text',
            ...info,
          },
          Message: { conversation: 'PARAR', ...msg },
        },
      };
    }

    it('mapeia uma mensagem recebida (candidata a STOP/opt-out)', () => {
      const [m] = adapter.parseInboundMessages(recebida());
      expect(m.fromE164).toBe('+5592987654321');
      expect(m.text).toBe('PARAR');
      expect(m.providerMessageId).toBe('A1234567890C12D3456A7E890C1E2');
      expect(m.receivedAt).toEqual(new Date('2026-08-07T18:15:13Z'));
    });

    it('lê também extendedTextMessage.text (mensagem com citação/link)', () => {
      const evt = recebida(
        {},
        { conversation: undefined, extendedTextMessage: { text: 'SAIR' } },
      );
      expect(adapter.parseInboundMessages(evt)[0].text).toBe('SAIR');
    });

    /**
     * COMPLIANCE — o defeito mais grave da revisão de 2026-08-08.
     * O canal pareado é o aparelho do cliente, cheio de grupos reais. Sem o
     * filtro de grupo, qualquer pessoa escrevendo "não" em qualquer grupo casa
     * o STOP_REGEX e o orgamind grava um REVOKE GLOBAL + SuppressionList para um
     * terceiro que nunca pediu nada — revogação FABRICADA, em deploy eleitoral.
     */
    it('mensagem de GRUPO → IGNORA (senão um terceiro vira opt-out fabricado)', () => {
      const evt = recebida({
        IsGroup: true,
        SenderAlt: '5592911112222@s.whatsapp.net',
      });
      expect(adapter.parseInboundMessages(evt)).toEqual([]);
    });

    /**
     * COMPLIANCE — o orgamind envia templates BUTTONS/LIST. A resposta ao botão
     * chega sem `conversation`; sem ler o rótulo, o opt-out do eleitor que
     * TOCOU "Parar" era descartado e o disparo seguinte reenviava para ele.
     */
    it.each([
      [
        'buttonsResponseMessage',
        { buttonsResponseMessage: { selectedDisplayText: 'Parar' } },
      ],
      [
        'templateButtonReplyMessage',
        { templateButtonReplyMessage: { selectedDisplayText: 'Parar' } },
      ],
      ['listResponseMessage', { listResponseMessage: { title: 'Parar' } }],
    ])('resposta por %s vira texto (é o que casa o STOP_REGEX)', (_n, msg) => {
      const evt = recebida({}, { conversation: undefined, ...(msg as object) });
      expect(adapter.parseInboundMessages(evt)[0].text).toBe('Parar');
    });

    it('IsFromMe → IGNORA (senão o "PARAR" do nosso próprio template descadastraria o contato)', () => {
      expect(
        adapter.parseInboundMessages(recebida({ IsFromMe: true })),
      ).toEqual([]);
    });

    it('remetente só em @lid → IGNORA, NUNCA inventa telefone a partir do LID', () => {
      // O LID é identificador opaco. Derivar dígitos dele suprimiria um número
      // aleatório — num sistema de campanha, a pessoa errada.
      const evt = recebida({ SenderAlt: '', Sender: '123456789012345@lid' });
      expect(adapter.parseInboundMessages(evt)).toEqual([]);
    });

    it('sessão antiga (Sender já em @s.whatsapp.net) continua funcionando', () => {
      const evt = recebida({
        SenderAlt: '',
        Sender: '5592111112222@s.whatsapp.net',
      });
      expect(adapter.parseInboundMessages(evt)[0].fromE164).toBe(
        '+5592111112222',
      );
    });

    it('só trata a categoria messages', () => {
      expect(
        adapter.parseInboundMessages({
          ...recebida(),
          event: 'messages_update',
        }),
      ).toEqual([]);
      expect(
        adapter.parseInboundMessages({ event: 'messages', data: {} }),
      ).toEqual([]);
    });

    it('NUNCA lança em payload malformado/hostil — evento ignorado vira []', () => {
      for (const bad of [
        null,
        undefined,
        'x',
        42,
        { data: { Info: 123 } },
        { event: 'messages', data: { Info: { ID: 1, Sender: 2 } } },
      ]) {
        expect(() => adapter.parseInboundMessages(bad)).not.toThrow();
        expect(adapter.parseInboundMessages(bad)).toEqual([]);
      }
    });
  });
});

describe('GozapCloudAdapter.checkNumbersOnWhatsapp (B.5)', () => {
  function fakeClock() {
    let t = 0;
    // Sem `async`: o corpo não tem `await` nenhum, e a regra
    // `@typescript-eslint/require-await` marca isso. `Promise.resolve()`
    // explícito devolve o mesmo `Promise<void>` do tipo `CheckClock.sleep`.
    const sleep = vi.fn((ms: number) => {
      t += ms;
      return Promise.resolve();
    });
    return { now: () => t, sleep };
  }

  function fakeRedis() {
    const store = new Map<string, string>();
    return {
      store,
      client: {
        get: vi.fn((k: string) => Promise.resolve(store.get(k) ?? null)),
        set: vi.fn((k: string, v: string) => {
          store.set(k, v);
          return Promise.resolve('OK');
        }),
      },
    };
  }

  it('consulta /chat/check com o token da instância e o número SEM "+"', async () => {
    const seen: Array<{ token: string | null; body: unknown }> = [];
    server.use(
      http.post(`${BASE}/chat/check`, async ({ request }) => {
        seen.push({
          token: request.headers.get('token'),
          body: await request.json(),
        });
        return HttpResponse.json({
          contacts: [
            { IsIn: true, PhoneNumber: '559295550101@s.whatsapp.net' },
          ],
        });
      }),
    );
    const a = new GozapCloudAdapter(makeConfig());
    const r = await a.checkNumbersOnWhatsapp(['+5592995550101'], undefined, {
      gozapInstanceToken: 'inst-token',
      clock: fakeClock(),
    });

    expect(seen[0].token).toBe('inst-token');
    expect(seen[0].body).toEqual({ numbers: ['5592995550101'] });
    expect(r).toEqual([
      {
        exists: true,
        jid: '559295550101@s.whatsapp.net',
        number: '5592995550101',
      },
    ]);
  });

  // `number` tem de voltar EXATAMENTE como o chamador mandou (sem "+"): é a
  // chave com que o contact-sync casa o resultado de volta no contato.
  it('IsIn:false vira exists:false, jid null, e o número de ENTRADA como chave', async () => {
    server.use(
      http.post(`${BASE}/chat/check`, () =>
        HttpResponse.json({ contacts: [{ IsIn: false }] }),
      ),
    );
    const a = new GozapCloudAdapter(makeConfig());
    const r = await a.checkNumbersOnWhatsapp(['+5592988887777'], undefined, {
      gozapInstanceToken: 't',
      clock: fakeClock(),
    });
    expect(r).toEqual([{ exists: false, jid: null, number: '5592988887777' }]);
  });

  /**
   * ★ O RITMO. Consulta de existência em massa por número não-oficial é sinal
   * conhecido de bloqueio — é o risco que a própria tela avisa. 40/min = uma a
   * cada 1500ms. O relógio é INJETADO para o teste provar o intervalo sem
   * esperar de verdade.
   */
  it('respeita GOZAP_CHECK_RATE_PER_MIN: espera 1500ms entre consultas (40/min)', async () => {
    server.use(
      http.post(`${BASE}/chat/check`, () =>
        HttpResponse.json({ contacts: [{ IsIn: true }] }),
      ),
    );
    const clock = fakeClock();
    const a = new GozapCloudAdapter(makeConfig());
    await a.checkNumbersOnWhatsapp(
      ['+5592900000001', '+5592900000002', '+5592900000003'],
      undefined,
      { gozapInstanceToken: 't', clock },
    );
    // 3 números = 2 esperas: a primeira consulta sai na hora.
    expect(clock.sleep.mock.calls.map((c) => c[0])).toEqual([1500, 1500]);
  });

  it('o ritmo é configurável (120/min => 500ms)', async () => {
    server.use(
      http.post(`${BASE}/chat/check`, () =>
        HttpResponse.json({ contacts: [{ IsIn: true }] }),
      ),
    );
    const clock = fakeClock();
    const a = new GozapCloudAdapter(
      makeConfig({ GOZAP_CHECK_RATE_PER_MIN: '120' }),
    );
    await a.checkNumbersOnWhatsapp(
      ['+5592900000001', '+5592900000002'],
      undefined,
      {
        gozapInstanceToken: 't',
        clock,
      },
    );
    expect(clock.sleep).toHaveBeenCalledWith(500);
  });

  it('cache Redis de 24h: o número já checado não volta ao GoZap nem gasta ritmo', async () => {
    let calls = 0;
    server.use(
      http.post(`${BASE}/chat/check`, () => {
        calls += 1;
        return HttpResponse.json({ contacts: [{ IsIn: true }] });
      }),
    );
    const redis = fakeRedis();
    const clock = fakeClock();
    const a = new GozapCloudAdapter(makeConfig(), redis.client as never);

    await a.checkNumbersOnWhatsapp(['+5592900000001'], undefined, {
      gozapInstanceToken: 't',
      clock,
    });
    // Fix round 1 (minor): o valor cacheado carrega o CANÔNICO junto do flag
    // (`1:<canônico>`), não só `'1'` — é o que garante que um cache-hit
    // reconstrua o MESMO jid que o cache-miss original produziu (ver o teste
    // dedicado "jid é o MESMO no cache-hit e no cache-miss" abaixo). Sem
    // `PhoneNumber` na resposta, o canônico cai para o próprio `number`.
    expect(redis.client.set).toHaveBeenCalledWith(
      'gozap:check:5592900000001',
      '1:5592900000001',
      'EX',
      86400,
    );

    const again = await a.checkNumbersOnWhatsapp(
      ['+5592900000001'],
      undefined,
      {
        gozapInstanceToken: 't',
        clock,
      },
    );
    expect(calls).toBe(1);
    expect(again[0].exists).toBe(true);
    expect(clock.sleep).not.toHaveBeenCalled();
  });

  it('sem Redis configurado, funciona igual (o cache é acelerador, não fonte da verdade)', async () => {
    server.use(
      http.post(`${BASE}/chat/check`, () =>
        HttpResponse.json({ contacts: [{ IsIn: true }] }),
      ),
    );
    const a = new GozapCloudAdapter(makeConfig());
    const r = await a.checkNumbersOnWhatsapp(['+5592900000001'], undefined, {
      gozapInstanceToken: 't',
      clock: fakeClock(),
    });
    expect(r[0].exists).toBe(true);
  });

  it('sem token da instância, falha rápido e FATAL', async () => {
    const a = new GozapCloudAdapter(makeConfig());
    await expect(
      a.checkNumbersOnWhatsapp(['+5592900000001'], undefined, {
        clock: fakeClock(),
      }),
    ).rejects.toThrow(WhatsappSendError);
  });

  // Um valor que nem é telefone não pode derrubar o lote inteiro de 50: ele é
  // o próprio caso "número inválido" que a validação existe para achar.
  it('entrada que não é telefone vira exists:false em vez de abortar o lote', async () => {
    server.use(
      http.post(`${BASE}/chat/check`, () =>
        HttpResponse.json({ contacts: [{ IsIn: true }] }),
      ),
    );
    const a = new GozapCloudAdapter(makeConfig());
    const r = await a.checkNumbersOnWhatsapp(
      ['+12', '+5592900000001'],
      undefined,
      {
        gozapInstanceToken: 't',
        clock: fakeClock(),
      },
    );
    expect(r[0]).toEqual({ exists: false, jid: null, number: '12' });
    expect(r[1].exists).toBe(true);
  });

  // Falha de REDE não é resposta: marcar "inválido" aqui gravaria uma mentira
  // durável no contato. Melhor estourar e deixar o BullMQ retentar.
  it('erro HTTP do GoZap PROPAGA (nunca vira "inválido")', async () => {
    server.use(
      http.post(`${BASE}/chat/check`, () =>
        HttpResponse.json({ error: 'nope' }, { status: 500 }),
      ),
    );
    const a = new GozapCloudAdapter(makeConfig());
    await expect(
      a.checkNumbersOnWhatsapp(['+5592900000001'], undefined, {
        gozapInstanceToken: 't',
        clock: fakeClock(),
      }),
    ).rejects.toThrow();
  });

  it('lista vazia não chama o GoZap', async () => {
    const a = new GozapCloudAdapter(makeConfig());
    const r = await a.checkNumbersOnWhatsapp([], undefined, {
      gozapInstanceToken: 't',
      clock: fakeClock(),
    });
    expect(r).toEqual([]);
  });

  /**
   * O contrato `provider-capability-contract.spec.ts` exige que quem declara
   * `contactTools` implemente checkNumbersOnWhatsapp E fetchProfilePictureUrl.
   * O GoZap não tem o segundo — declarar a capacidade seria mentira, e a
   * mentira é o que aquele contrato existe para impedir.
   */
  it('NÃO declara contactTools (não implementa fetchProfilePictureUrl)', () => {
    const a = new GozapCloudAdapter(makeConfig());
    expect(a.profile.capabilities.has('contactTools')).toBe(false);
    expect(typeof a.checkNumbersOnWhatsapp).toBe('function');
  });

  // ── Fix round 1 (revisão Opus) ──────────────────────────────────────────

  // C1 Critical: `IsIn:true` de OUTRO assinante não podia virar "existe" com
  // o JID de um estranho. Aconteceu de verdade na investigação do 9º dígito
  // (`resolveWhatsappNumber` tem a mesma trava, por isso).
  //
  // Fix round 2 (design ruling): o resultado é `exists: null` (INCERTO), não
  // `false` (inválido confirmado) — `contact-sync.processor.ts` grava
  // `whatsappValid:false` de forma DURÁVEL a partir de `exists:false`; um
  // "não sei" reportado como `false` viraria mentira permanente no contato.
  it('C1: IsIn:true com o PhoneNumber de outro assinante vira exists:null (incerto), não confirma nem cacheia', async () => {
    server.use(
      http.post(`${BASE}/chat/check`, () =>
        HttpResponse.json({
          // DDD 11, nada a ver com o DDD 92 consultado — não é o 9º dígito
          // do mesmo assinante por nenhum jeito.
          contacts: [
            { IsIn: true, PhoneNumber: '5511988887777@s.whatsapp.net' },
          ],
        }),
      ),
    );
    const redis = fakeRedis();
    const a = new GozapCloudAdapter(makeConfig(), redis.client as never);
    const r = await a.checkNumbersOnWhatsapp(['+5592900000001'], undefined, {
      gozapInstanceToken: 't',
      clock: fakeClock(),
    });
    expect(r).toEqual([
      {
        exists: null,
        jid: null,
        number: '5592900000001',
        reason: 'gozap.check_mismatch',
      },
    ]);
    expect(redis.client.set).not.toHaveBeenCalled();
  });

  // Minor (fix round 2): o mismatch do C1 não pode ficar mudo — mas o warn
  // tem de ser tão phone-free quanto o resultado. Espelha o padrão de
  // `resolveWhatsappNumber` (mesmo warn, sem dado nenhum), só que aqui com
  // contexto (instância + contagem) e sem NUNCA o telefone.
  it('C1 (minor): o mismatch gera um logger.warn sem o telefone (instância + contagem)', async () => {
    server.use(
      http.post(`${BASE}/chat/check`, () =>
        HttpResponse.json({
          contacts: [
            { IsIn: true, PhoneNumber: '5511988887777@s.whatsapp.net' },
          ],
        }),
      ),
    );
    const warnSpy = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const a = new GozapCloudAdapter(makeConfig());
    await a.checkNumbersOnWhatsapp(['+5592900000001'], undefined, {
      gozapInstanceToken: 't',
      clock: fakeClock(),
    });
    const mismatchCalls = warnSpy.mock.calls.filter((c) =>
      String(c[1] ?? c[0]).includes('outro assinante'),
    );
    expect(mismatchCalls.length).toBeGreaterThan(0);
    const serializedCalls = JSON.stringify(mismatchCalls);
    expect(serializedCalls).not.toContain('5592900000001');
    warnSpy.mockRestore();
  });

  // Minor (PII, fix round 2): erro do check-path reaproveitava
  // `handleSendError`, que loga `providerMessage` (corpo de erro do
  // provedor) — e nada garante que o GoZap não ecoe o número consultado de
  // volta nesse corpo. Nem o erro lançado nem NENHUM log deste caminho pode
  // carregar um "número" (heurística: run de 8+ dígitos seguidos).
  it('PII: corpo de erro do provedor com o número ecoado não vaza no erro nem em log algum', async () => {
    server.use(
      http.post(`${BASE}/chat/check`, () =>
        HttpResponse.json(
          { error: 'invalid number 5592900000001 rejected' },
          { status: 500 },
        ),
      ),
    );
    const warnSpy = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const errorSpy = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const a = new GozapCloudAdapter(makeConfig());
    let caught: unknown;
    try {
      await a.checkNumbersOnWhatsapp(['+5592900000001'], undefined, {
        gozapInstanceToken: 't',
        clock: fakeClock(),
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    const digitRun8Plus = /\d{8,}/;
    expect(digitRun8Plus.test(JSON.stringify(caught))).toBe(false);
    expect(
      digitRun8Plus.test(
        JSON.stringify([...warnSpy.mock.calls, ...errorSpy.mock.calls]),
      ),
    ).toBe(false);
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  // C2 Critical: um 200 que a gente não entende (sem `IsIn` reconhecível)
  // nunca pode virar "não existe" silencioso — isso gravaria uma mentira de
  // 24h no contato. Vira `exists: null` (não sei), nunca `false`, e não
  // cacheia.
  describe('C2: HTTP 200 sem "IsIn" reconhecível vira exists:null (nunca "não existe" silencioso)', () => {
    it.each([
      ['contacts vazio', { contacts: [] }],
      ['corpo sem contacts', {}],
      ['corpo de erro do provedor', { error: 'instance not connected' }],
    ])('%s → exists:null com reason, e não cacheia', async (_label, body) => {
      server.use(
        http.post(`${BASE}/chat/check`, () => HttpResponse.json(body)),
      );
      const redis = fakeRedis();
      const a = new GozapCloudAdapter(makeConfig(), redis.client as never);
      const out = await a.checkNumbersOnWhatsapp(
        ['+5592900000001'],
        undefined,
        {
          gozapInstanceToken: 't',
          clock: fakeClock(),
        },
      );
      expect(out).toEqual([
        {
          exists: null,
          jid: null,
          number: '5592900000001',
          reason: 'gozap.check_unknown_response',
        },
      ]);
      expect(redis.client.set).not.toHaveBeenCalled();
    });
  });

  /**
   * ★ REVISÃO FINAL DA FASE B (importante) — A PÍLULA DE VENENO NÃO PODE
   * MAIS PARAR O LOTE.
   *
   * O método processa o lote inteiro num laço só. Quando um número recebia um
   * 200 irreconhecível, uma versão anterior deste código ENCERRAVA o lote
   * ali (o `throw` original, mais antigo, jogava fora até o já consultado;
   * o fix seguinte passou a devolver o já consultado, mas ainda parava e
   * marcava TODO o restante como não confirmado). Como `findIdsForSync` não
   * tem `orderBy`, o MESMO lote se reforma amanhã com o número-veneno na
   * MESMA posição — e todo mundo depois dele, no lote, nunca é consultado de
   * verdade. Um único número burlado (não um erro de transporte — HTTP 200,
   * corpo que só este número produziu) bastava para nunca validar o resto da
   * página.
   *
   * Agora só ESSE número vira `exists: null` com o motivo, e o laço CONTINUA
   * com os próximos — ainda pausado pelo ritmo (`lastCheckCallAt`) e ainda
   * cacheando cada veredito de verdade por número.
   */
  it('C2: 200 irreconhecível no MEIO do lote marca só aquele número como null e CONTINUA com os próximos (não para o lote)', async () => {
    let calls = 0;
    server.use(
      http.post(`${BASE}/chat/check`, () => {
        calls += 1;
        // O 2º número (só ele) devolve uma resposta irreconhecível; o 1º e o
        // 3º respondem normalmente — provando que o lote não parou nele.
        return calls === 2
          ? HttpResponse.json({ error: 'instance not connected' })
          : HttpResponse.json({ contacts: [{ IsIn: true }] });
      }),
    );
    const redis = fakeRedis();
    const a = new GozapCloudAdapter(makeConfig(), redis.client as never);

    const out = await a.checkNumbersOnWhatsapp(
      ['+5592900000001', '+5592900000002', '+5592900000003'],
      undefined,
      { gozapInstanceToken: 't', clock: fakeClock() },
    );

    // Nada se perde: 3 entram, 3 saem — e os TRÊS foram de fato consultados.
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual({
      exists: true,
      jid: '5592900000001@s.whatsapp.net',
      number: '5592900000001',
    });
    expect(out[1]).toEqual({
      exists: null,
      jid: null,
      number: '5592900000002',
      reason: 'gozap.check_unknown_response',
    });
    // O TERCEIRO agora É perguntado — o veneno ficou contido no 2º, o lote
    // continuou em vez de encerrar.
    expect(out[2]).toEqual({
      exists: true,
      jid: '5592900000003@s.whatsapp.net',
      number: '5592900000003',
    });
    expect(calls).toBe(3);
    // Os dois veredictos de verdade foram cacheados; o "não sei" do meio,
    // nunca — não vira cache de 24h.
    expect(redis.client.set).toHaveBeenCalledTimes(2);
  });

  // I1 Important: 401/403 no /chat/check significa TOKEN MORTO — cada número
  // restante do lote ia repetir o mesmo erro. Aborta o lote com um código
  // FATAL próprio em vez de continuar gastando ritmo (e risco de bloqueio)
  // numa consulta fadada a falhar.
  it('I1: 401 aborta o lote com gozap.check_unauthorized, FATAL', async () => {
    server.use(
      http.post(`${BASE}/chat/check`, () =>
        HttpResponse.json({ error: 'unauthorized' }, { status: 401 }),
      ),
    );
    const a = new GozapCloudAdapter(makeConfig());
    await expect(
      a.checkNumbersOnWhatsapp(['+5592900000001'], undefined, {
        gozapInstanceToken: 't',
        clock: fakeClock(),
      }),
    ).rejects.toMatchObject({
      providerErrorCode: 'gozap.check_unauthorized',
      fatal: true,
    });
  });

  it('I1: 503 é RETENTÁVEL (não fatal), não gozap.check_unauthorized', async () => {
    server.use(
      http.post(`${BASE}/chat/check`, () =>
        HttpResponse.json(
          { error: 'temporarily unavailable' },
          { status: 503 },
        ),
      ),
    );
    const a = new GozapCloudAdapter(makeConfig());
    await expect(
      a.checkNumbersOnWhatsapp(['+5592900000001'], undefined, {
        gozapInstanceToken: 't',
        clock: fakeClock(),
      }),
    ).rejects.toMatchObject({ fatal: false });
  });

  it('I1: o erro lançado nunca carrega o telefone nem o token da requisição', async () => {
    server.use(
      http.post(`${BASE}/chat/check`, () =>
        HttpResponse.json({ error: 'unauthorized' }, { status: 401 }),
      ),
    );
    const a = new GozapCloudAdapter(makeConfig());
    let caught: unknown;
    try {
      await a.checkNumbersOnWhatsapp(['+5592900000001'], undefined, {
        gozapInstanceToken: 'super-secret-instance-token',
        clock: fakeClock(),
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    const serialized = JSON.stringify(caught);
    expect(serialized).not.toContain('5592900000001');
    expect(serialized).not.toContain('super-secret-instance-token');
    expect(serialized).not.toContain('"config"');
  });

  // I2 Important (mandado pelo plano): `lastCallAt` era `let` LOCAL do
  // método — cada chamada de `checkNumbersOnWhatsapp` (cada lote/campanha)
  // recomeçava o ritmo do zero. O adapter é singleton do Nest; o ritmo tem
  // de valer ENTRE chamadas.
  it('I2: o ritmo persiste ENTRE chamadas (lastCallAt é campo da instância)', async () => {
    server.use(
      http.post(`${BASE}/chat/check`, () =>
        HttpResponse.json({ contacts: [{ IsIn: true }] }),
      ),
    );
    const clock = fakeClock();
    const a = new GozapCloudAdapter(makeConfig());
    await a.checkNumbersOnWhatsapp(['+5592900000001'], undefined, {
      gozapInstanceToken: 't',
      clock,
    });
    await a.checkNumbersOnWhatsapp(['+5592900000002'], undefined, {
      gozapInstanceToken: 't',
      clock,
    });
    // Duas chamadas SEPARADAS, um número cada — se o ritmo fosse local, a
    // segunda sairia sem esperar (como a primeira). Persistindo, ela espera
    // o intervalo completo, igual a um segundo número dentro do MESMO lote.
    expect(clock.sleep).toHaveBeenCalledWith(1500);
  });

  it('I2 (elapsed-aware): tempo que já passou ENTRE chamadas desconta do sleep', async () => {
    server.use(
      http.post(`${BASE}/chat/check`, () =>
        HttpResponse.json({ contacts: [{ IsIn: true }] }),
      ),
    );
    let t = 0;
    const sleep = vi.fn((ms: number) => {
      t += ms;
      return Promise.resolve();
    });
    const clock = { now: () => t, sleep };
    const a = new GozapCloudAdapter(makeConfig());
    await a.checkNumbersOnWhatsapp(['+5592900000001'], undefined, {
      gozapInstanceToken: 't',
      clock,
    });
    // 1s "passou" fazendo outra coisa (nada de sleep) entre as duas chamadas.
    t += 1000;
    await a.checkNumbersOnWhatsapp(['+5592900000002'], undefined, {
      gozapInstanceToken: 't',
      clock,
    });
    // 1500ms de intervalo - 1000ms já decorridos = 500ms restantes.
    expect(sleep).toHaveBeenCalledWith(500);
  });

  // Minor: mesma entrada tem de dar o MESMO jid, esteja em cache ou não —
  // sem isto, a PRIMEIRA checagem (cache-miss) usava o canônico devolvido
  // pelo GoZap (pode diferir no 9º dígito) e a checagem SEGUINTE (cache-hit)
  // usava `number` (a entrada) — dois jid diferentes para o mesmo telefone.
  it('jid é o MESMO no cache-hit e no cache-miss para a mesma entrada', async () => {
    server.use(
      http.post(`${BASE}/chat/check`, () =>
        HttpResponse.json({
          contacts: [
            { IsIn: true, PhoneNumber: '559295550101@s.whatsapp.net' },
          ],
        }),
      ),
    );
    const redis = fakeRedis();
    const a = new GozapCloudAdapter(makeConfig(), redis.client as never);
    const first = await a.checkNumbersOnWhatsapp(
      ['+5592995550101'],
      undefined,
      {
        gozapInstanceToken: 't',
        clock: fakeClock(),
      },
    );
    const second = await a.checkNumbersOnWhatsapp(
      ['+5592995550101'],
      undefined,
      {
        gozapInstanceToken: 't',
        clock: fakeClock(),
      },
    );
    expect(first[0].jid).toBe('559295550101@s.whatsapp.net');
    expect(second[0].jid).toBe(first[0].jid);
  });

  // Minor: resiliência do cache — Redis fora do ar não pode impedir a
  // checagem (leitura) nem derrubar o resultado (escrita).
  it('Redis.get falhando é tratado como MISS — a checagem segue normal', async () => {
    server.use(
      http.post(`${BASE}/chat/check`, () =>
        HttpResponse.json({ contacts: [{ IsIn: true }] }),
      ),
    );
    const redisClient = {
      get: vi.fn().mockRejectedValue(new Error('redis down')),
      set: vi.fn().mockResolvedValue('OK'),
    };
    const a = new GozapCloudAdapter(makeConfig(), redisClient as never);
    const r = await a.checkNumbersOnWhatsapp(['+5592900000001'], undefined, {
      gozapInstanceToken: 't',
      clock: fakeClock(),
    });
    expect(r[0].exists).toBe(true);
  });

  it('Redis.set falhando não derruba o resultado — cache é acelerador, não requisito', async () => {
    server.use(
      http.post(`${BASE}/chat/check`, () =>
        HttpResponse.json({ contacts: [{ IsIn: true }] }),
      ),
    );
    const redisClient = {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockRejectedValue(new Error('redis down')),
    };
    const a = new GozapCloudAdapter(makeConfig(), redisClient as never);
    const r = await a.checkNumbersOnWhatsapp(['+5592900000001'], undefined, {
      gozapInstanceToken: 't',
      clock: fakeClock(),
    });
    expect(r[0].exists).toBe(true);
  });
});
