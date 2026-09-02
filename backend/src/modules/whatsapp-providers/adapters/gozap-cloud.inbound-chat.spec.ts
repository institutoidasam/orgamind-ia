import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
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

/**
 * O BURACO QUE ESTE ARQUIVO FECHA (achados C9/C19/K3/N19–N22 da auditoria).
 *
 * O GoZap CHAMA o nosso webhook em produção — 74 POSTs em 52h, todos 200,
 * autenticados, canal resolvido. Mesmo assim NADA aparecia na inbox: o adapter
 * implementava `parseInboundMessages` (que serve o opt-out) mas NÃO
 * `parseInboundChatMessages` (que serve o chat). Como o método é OPCIONAL no
 * port e o roteador faz `?.parseInboundChatMessages?.(payload) ?? []`, toda
 * resposta de eleitor virava lista vazia — sem exceção, sem log, sem contador.
 *
 * Efeito colateral jurídico (K3): os DOIS atos de opt-in (texto do link/QR e
 * botão) moram no ChatIngestService, alimentado só por este parser. Num canal
 * GoZap a base só PERDIA audiência (o opt-out roda pelo outro parser) e nunca
 * ganhava.
 */
const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const BASE = 'https://acme.gozap.dev';
function makeConfig(o: Record<string, string | undefined> = {}) {
  const v: Record<string, string | undefined> = { GOZAP_BASE_URL: BASE, ...o };
  return { get: (k: string) => v[k] } as unknown as ConfigService;
}

const adapter = new GozapCloudAdapter(makeConfig());

/**
 * O envelope REAL, capturado de produção em 2026-08-07 (whatsmeow
 * `events.Message`, PascalCase no Info, protojson no Message). É o MESMO
 * payload que `parseInboundMessages` já consome com sucesso para o opt-out —
 * a prova de que o elo quebrado era exclusivamente o parser do chat.
 */
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
      Message: { conversation: 'Oi, tudo bem?', ...msg },
    },
  };
}

describe('GozapCloudAdapter.parseInboundChatMessages', () => {
  it('a resposta do eleitor vira uma InboundChatMessage completa (era [] — a inbox nunca recebia nada)', () => {
    const out = adapter.parseInboundChatMessages!(recebida());
    expect(out).toHaveLength(1);
    const m = out[0];
    expect(m.providerMessageId).toBe('A1234567890C12D3456A7E890C1E2');
    expect(m.phoneE164).toBe('+5592987654321');
    expect(m.isGroup).toBe(false);
    expect(m.fromMe).toBe(false);
    expect(m.kind).toBe('TEXT');
    expect(m.text).toBe('Oi, tudo bem?');
    expect(m.pushName).toBe('Fulano');
    expect(m.receivedAt).toEqual(new Date('2026-08-07T18:15:13Z'));
  });

  /**
   * A THREAD NÃO PODE PARTIR EM DUAS.
   *
   * `ChatIngestService.persistChatMessage` faz upsert da Conversation pela
   * chave EXATA `[instanceId, remoteJid]`, enquanto o espelho da campanha
   * (`resolveConversationForOutbound`) cria a conversa com o JID CANÔNICO do
   * telefone. O `Info.Chat` do GoZap em produção é um `@lid` — devolvê-lo cru
   * criaria uma SEGUNDA conversa: a bolha do disparo numa linha da inbox e a
   * resposta do eleitor noutra.
   */
  it('remoteJid é o JID canônico do TELEFONE, não o @lid do Info.Chat (senão a resposta cai numa conversa separada da bolha do disparo)', () => {
    const [m] = adapter.parseInboundChatMessages!(recebida());
    expect(m.remoteJid).toBe('5592987654321@s.whatsapp.net');
  });

  it('sessão antiga (Sender já em @s.whatsapp.net, sem SenderAlt) também resolve', () => {
    const [m] = adapter.parseInboundChatMessages!(
      recebida({ SenderAlt: '', Sender: '5592111112222@s.whatsapp.net' }),
    );
    expect(m.phoneE164).toBe('+5592111112222');
    expect(m.remoteJid).toBe('5592111112222@s.whatsapp.net');
  });

  it('lê extendedTextMessage.text (mensagem com link/citação)', () => {
    const [m] = adapter.parseInboundChatMessages!(
      recebida({}, { conversation: undefined, extendedTextMessage: { text: 'Quero saber mais' } }),
    );
    expect(m.kind).toBe('TEXT');
    expect(m.text).toBe('Quero saber mais');
  });

  describe('as três recusas que existem por bons motivos', () => {
    it('IsFromMe → IGNORA (é o eco das NOSSAS mensagens)', () => {
      expect(adapter.parseInboundChatMessages!(recebida({ IsFromMe: true }))).toEqual([]);
    });

    it('GRUPO → IGNORA (o canal pareado é o aparelho do cliente, cheio de grupos reais)', () => {
      expect(
        adapter.parseInboundChatMessages!(
          recebida({ IsGroup: true, Chat: '120363000000000000@g.us' }),
        ),
      ).toEqual([]);
    });

    it('remetente só em @lid → IGNORA, NUNCA inventa telefone a partir do LID', () => {
      expect(
        adapter.parseInboundChatMessages!(
          recebida({ SenderAlt: '', Sender: '123456789012345@lid' }),
        ),
      ).toEqual([]);
    });
  });

  /**
   * O DESCARTE QUE O ALARME NÃO ENXERGA (revisão adversarial da 1ª rodada).
   *
   * `WebhooksService.warnSilentChatDrop` só grita quando `parseInboundMessages`
   * RECONHECEU algo — e esse parser aplica a MESMA recusa de @lid/sem-ID,
   * devolvendo `[]` também. Os dois concordam em zero e o alarme cala: a
   * mensagem some com HTTP 200 e nenhum rastro, que é exatamente o incidente
   * dos 74 POSTs que este pacote existe para acabar. O WhatsApp está migrando
   * para LID; no dia em que o GoZap parar de mandar `SenderAlt`, TODA resposta
   * de eleitor evapora. A recusa continua certa (LID não é telefone); o que
   * faltava era deixar rastro.
   */
  describe('a recusa deixa RASTRO (sem PII)', () => {
    let warn: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      warn = vi
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
    });
    afterEach(() => vi.restoreAllMocks());

    function warned() {
      return warn.mock.calls.find((c) =>
        c.some((a) => typeof a === 'string' && /descartad/i.test(a)),
      );
    }

    it('remetente só em @lid → LOGA o descarte com o motivo e o instance_id', () => {
      adapter.parseInboundChatMessages!(
        recebida({ SenderAlt: '', Sender: '123456789012345@lid' }),
      );

      const call = warned();
      expect(call, 'descarte @lid saiu sem NENHUM log').toBeDefined();
      const ctx = call!.find((a) => a && typeof a === 'object') as Record<
        string,
        unknown
      >;
      expect(ctx).toMatchObject({
        instanceId: 'rffe51e7ef7c8ff',
        reason: 'remetente_sem_telefone',
      });
    });

    it('sem Info.ID → LOGA o descarte (a mensagem sumiria sem nada no log)', () => {
      adapter.parseInboundChatMessages!(recebida({ ID: undefined }));

      const call = warned();
      expect(call, 'descarte sem ID saiu sem NENHUM log').toBeDefined();
      const ctx = call!.find((a) => a && typeof a === 'object') as Record<
        string,
        unknown
      >;
      expect(ctx).toMatchObject({ reason: 'sem_id_de_mensagem' });
    });

    it('o rastro NÃO carrega telefone, JID, nome nem texto do eleitor', () => {
      adapter.parseInboundChatMessages!(
        recebida(
          { SenderAlt: '', Sender: '123456789012345@lid', PushName: 'Fulano' },
          { conversation: 'quero saber do candidato' },
        ),
      );

      const dump = JSON.stringify(warn.mock.calls);
      expect(dump).not.toContain('123456789012345');
      expect(dump).not.toContain('Fulano');
      expect(dump).not.toContain('quero saber do candidato');
    });

    it('mensagem BOA não gera alarme — senão o log vira ruído e ninguém olha', () => {
      adapter.parseInboundChatMessages!(recebida());
      expect(warned()).toBeUndefined();
    });

    it('grupo e eco (recusas de política, não perda) seguem silenciosos', () => {
      adapter.parseInboundChatMessages!(recebida({ IsFromMe: true }));
      adapter.parseInboundChatMessages!(recebida({ IsGroup: true }));
      expect(warned()).toBeUndefined();
    });
  });

  describe('opt-in por BOTÃO (K3) — o registro jurídico de consentimento', () => {
    it('toque no botão "Sim, quero receber" vira buttonPayload canônico optin_yes', () => {
      const [m] = adapter.parseInboundChatMessages!(
        recebida(
          {},
          {
            conversation: undefined,
            buttonsResponseMessage: {
              selectedButtonId: 'optin_yes',
              selectedDisplayText: 'Sim, quero receber',
            },
          },
        ),
      );
      expect(m.buttonPayload).toBe('optin_yes');
      expect(m.text).toBe('Sim, quero receber');
    });

    it('rótulo sem id nosso também casa pela lista fechada do projeto', () => {
      const [m] = adapter.parseInboundChatMessages!(
        recebida(
          {},
          {
            conversation: undefined,
            templateButtonReplyMessage: {
              selectedId: '0',
              selectedDisplayText: 'Quero receber novidades',
            },
          },
        ),
      );
      expect(m.buttonPayload).toBe('optin_yes');
    });

    /**
     * Em português o afirmativo é substring do negativo. Um falso positivo aqui
     * FABRICA um ConsentEvent append-only dizendo que um eleitor autorizou.
     */
    it('"Não quero receber" NUNCA vira optin_yes — vira optout', () => {
      const [m] = adapter.parseInboundChatMessages!(
        recebida(
          {},
          {
            conversation: undefined,
            buttonsResponseMessage: {
              selectedButtonId: 'nao_quero',
              selectedDisplayText: 'Não quero receber',
            },
          },
        ),
      );
      expect(m.buttonPayload).toBe('optout');
    });

    it('DIGITAR "sim, quero receber" NÃO é toque de botão — buttonPayload fica indefinido', () => {
      const [m] = adapter.parseInboundChatMessages!(
        recebida({}, { conversation: 'Sim, quero receber' }),
      );
      expect(m.buttonPayload).toBeUndefined();
    });

    /**
     * Assimetria deliberada: opt-OUT casa frouxo (suprimir demais é o erro
     * barato), opt-IN só por BOTÃO (fabricar consentimento é o erro caro).
     */
    it('linha de LISTA com rótulo de aceite NÃO vira optin_yes (só botão vira)', () => {
      const [m] = adapter.parseInboundChatMessages!(
        recebida(
          {},
          {
            conversation: undefined,
            listResponseMessage: {
              title: 'Quero receber',
              singleSelectReply: { selectedRowId: 'row_1' },
            },
          },
        ),
      );
      expect(m.buttonPayload).not.toBe('optin_yes');
    });

    it('linha de LISTA com rótulo de recusa VIRA optout (suprimir demais é o erro barato)', () => {
      const [m] = adapter.parseInboundChatMessages!(
        recebida(
          {},
          {
            conversation: undefined,
            listResponseMessage: {
              title: 'Parar',
              singleSelectReply: { selectedRowId: 'row_9' },
            },
          },
        ),
      );
      expect(m.buttonPayload).toBe('optout');
    });
  });

  describe('mídia e citação', () => {
    it('imagem com legenda vira kind IMAGE e a legenda vira text', () => {
      const [m] = adapter.parseInboundChatMessages!(
        recebida(
          {},
          {
            conversation: undefined,
            imageMessage: { mimetype: 'image/jpeg', caption: 'olha isso' },
          },
        ),
      );
      expect(m.kind).toBe('IMAGE');
      expect(m.text).toBe('olha isso');
    });

    /**
     * O adapter GoZap NÃO tem caminho de download de mídia. Emitir `media`
     * faria o `ChatIngestService` criar a MessageMedia e enfileirar um job que
     * só sabe buscar por Evolution (`getMediaBase64`) ou por URL da Twilio —
     * toda mídia do GoZap nasceria FAILED. Melhor a bolha honesta "📷 Imagem"
     * do que uma fila de falhas.
     */
    it('NÃO emite media (não há download de mídia no GoZap — o job nasceria condenado)', () => {
      const [m] = adapter.parseInboundChatMessages!(
        recebida({}, { conversation: undefined, imageMessage: { mimetype: 'image/jpeg' } }),
      );
      expect(m.media).toBeUndefined();
    });

    it.each([
      ['videoMessage', 'VIDEO'],
      ['audioMessage', 'AUDIO'],
      ['documentMessage', 'DOCUMENT'],
      ['stickerMessage', 'STICKER'],
      ['locationMessage', 'LOCATION'],
      ['contactMessage', 'CONTACT'],
    ])('%s → kind %s', (field, kind) => {
      const [m] = adapter.parseInboundChatMessages!(
        recebida({}, { conversation: undefined, [field]: {} }),
      );
      expect(m.kind).toBe(kind);
    });

    it('shape desconhecido vira UNSUPPORTED em vez de sumir da inbox', () => {
      const [m] = adapter.parseInboundChatMessages!(
        recebida({}, { conversation: undefined, algoQueNaoConhecemos: {} }),
      );
      expect(m.kind).toBe('UNSUPPORTED');
    });

    it('resposta a uma mensagem citada carrega o wamid citado (é o que amarra o opt-in por botão à campanha certa)', () => {
      const [m] = adapter.parseInboundChatMessages!(
        recebida(
          {},
          {
            conversation: undefined,
            extendedTextMessage: {
              text: 'sim',
              contextInfo: {
                stanzaId: 'WAMID_DA_CAMPANHA',
                quotedMessage: { conversation: 'Você autoriza receber?' },
              },
            },
          },
        ),
      );
      expect(m.quotedWaMessageId).toBe('WAMID_DA_CAMPANHA');
      expect(m.quotedPreview).toBe('Você autoriza receber?');
    });
  });

  it('só trata a categoria messages', () => {
    expect(
      adapter.parseInboundChatMessages!({ ...recebida(), event: 'messages_update' }),
    ).toEqual([]);
    expect(adapter.parseInboundChatMessages!({ event: 'messages', data: {} })).toEqual([]);
  });

  it('NUNCA lança em payload malformado/hostil — evento ignorado vira []', () => {
    for (const bad of [
      null,
      undefined,
      'x',
      42,
      [],
      { data: { Info: 123 } },
      { event: 'messages', data: { Info: { ID: 1, Sender: 2 } } },
    ]) {
      expect(() => adapter.parseInboundChatMessages!(bad)).not.toThrow();
      expect(adapter.parseInboundChatMessages!(bad)).toEqual([]);
    }
  });

  /**
   * Info VÁLIDO com corpo ilegível é o caso oposto de payload hostil: existe uma
   * mensagem, só não sabemos ler o conteúdo. Ela POUSA na inbox como
   * UNSUPPORTED — sumir de novo seria repetir exatamente o defeito que este
   * arquivo fecha.
   */
  it('corpo ilegível com Info válido POUSA na inbox como UNSUPPORTED (não some)', () => {
    const [m] = adapter.parseInboundChatMessages!({
      event: 'messages',
      data: {
        Info: { ID: 'a', Sender: '5592987654321@s.whatsapp.net' },
        Message: 'nope',
      },
    });
    expect(m.kind).toBe('UNSUPPORTED');
    expect(m.phoneE164).toBe('+5592987654321');
  });
});

/**
 * N20 — responder pelo inbox num canal GOZAP caía no ramo Evolution e estourava
 * `ChannelNotEvolutionError`. O envio do GoZap já é real e testado em produção;
 * faltava só expor o texto livre pelo port.
 */
describe('GozapCloudAdapter.sendChatText', () => {
  // Adapter NOVO por teste: `resolveWhatsappNumber` mantém um cache por número
  // dentro da instância, e um cache vazado entre testes esconderia justamente
  // a chamada ao `/chat/check` que estes testes existem para provar.
  let ad: GozapCloudAdapter;
  beforeEach(() => {
    ad = new GozapCloudAdapter(makeConfig());
  });

  /** `/chat/check` respondendo o canônico que o WhatsApp registrou. */
  function check(canonical: string) {
    return http.post(`${BASE}/chat/check`, () =>
      HttpResponse.json({
        contacts: [{ IsIn: true, PhoneNumber: `${canonical}@s.whatsapp.net` }],
      }),
    );
  }

  it('declara a capacidade inboxChat (é ela que libera o compositor da inbox)', () => {
    expect(ad.profile.capabilities.has('inboxChat')).toBe(true);
  });

  it('POST /send/text com o número sem "+" e o token da INSTÂNCIA no header', async () => {
    let seenBody: unknown = null;
    let seenToken: string | null = null;
    server.use(
      check('5592987654321'),
      http.post(`${BASE}/send/text`, async ({ request }) => {
        seenToken = request.headers.get('token');
        seenBody = await request.json();
        return HttpResponse.json({
          success: true,
          message: { id: 'MSGCHAT1', timestamp: '2026-08-07T18:20:00Z' },
        });
      }),
    );

    const res = await ad.sendChatText!({
      instanceName: '',
      toE164: '+5592987654321',
      text: 'Oi! Aqui é a equipe.',
      gozapInstanceToken: 'inst-tok',
    });

    expect(seenToken).toBe('inst-tok');
    expect(seenBody).toEqual({ number: '5592987654321', text: 'Oi! Aqui é a equipe.' });
    expect(res.providerMessageId).toBe('MSGCHAT1');
  });

  it('sem token da instância falha FATAL e claro, sem tocar o provedor', async () => {
    await expect(
      ad.sendChatText!({ instanceName: '', toE164: '+5592987654321', text: 'oi' }),
    ).rejects.toMatchObject({ providerErrorCode: 'gozap.no_token', fatal: true });
  });

  it('erro HTTP do provedor vira WhatsappSendError classificado', async () => {
    server.use(
      check('5592987654321'),
      http.post(`${BASE}/send/text`, () =>
        HttpResponse.json({ error: 'instance not connected' }, { status: 400 }),
      ),
    );
    await expect(
      ad.sendChatText!({
        instanceName: '',
        toE164: '+5592987654321',
        text: 'oi',
        gozapInstanceToken: 'inst-tok',
      }),
    ).rejects.toBeInstanceOf(WhatsappSendError);
  });

  /**
   * O DEFEITO QUE ESTE BLOCO FECHA (revisão adversarial da 1ª rodada).
   *
   * A 1ª versão deste método mandava `digitsOnly(toE164)` cru, com a
   * justificativa de que "o destinatário é a conversa que a própria pessoa
   * abriu". É FALSO para toda conversa criada pelo ESPELHO DA CAMPANHA:
   * `mirrorToInbox` passa `message.contact.phoneE164` (o número do CADASTRO,
   * 13 dígitos, com o 9º) e `resolveConversationForOutbound` grava exatamente
   * isso em `Conversation.phoneE164` — que é o que
   * `ChatService.dispatchOutbound` entrega aqui.
   *
   * E 13 dígitos numa conta registrada com 12 é o INCIDENTE 2026-08-07: o
   * WhatsApp ACEITA, devolve `message.id` e DESCARTA em silêncio. A bolha
   * viraria SENT, o operador acharia que respondeu o eleitor, e ninguém teria
   * recebido nada. Antes da 1ª rodada o mesmo clique dava erro visível; sem
   * esta resolução, daria sucesso falso — que é pior.
   */
  it('RESOLVE o número no /chat/check antes de responder: 13 dígitos numa conta de 12 sairia aceito e descartado', async () => {
    let checked: unknown = null;
    let seenBody: unknown = null;
    server.use(
      http.post(`${BASE}/chat/check`, async ({ request }) => {
        checked = await request.json();
        return HttpResponse.json({
          contacts: [{ IsIn: true, PhoneNumber: '559287654321@s.whatsapp.net' }],
        });
      }),
      http.post(`${BASE}/send/text`, async ({ request }) => {
        seenBody = await request.json();
        return HttpResponse.json({ success: true, message: { id: 'X1' } });
      }),
    );

    await ad.sendChatText!({
      instanceName: '',
      toE164: '+5592987654321',
      text: 'oi',
      gozapInstanceToken: 'inst-tok',
    });

    expect(checked).toEqual({ numbers: ['5592987654321'] });
    expect(seenBody).toEqual({ number: '559287654321', text: 'oi' });
  });

  it('número que o /chat/check diz NÃO existir no WhatsApp: falha FATAL em vez de "enviar" para o vácuo', async () => {
    let posted = false;
    server.use(
      http.post(`${BASE}/chat/check`, () =>
        HttpResponse.json({ contacts: [{ IsIn: false }] }),
      ),
      http.post(`${BASE}/send/text`, () => {
        posted = true;
        return HttpResponse.json({ success: true, message: { id: 'X' } });
      }),
    );

    await expect(
      ad.sendChatText!({
        instanceName: '',
        toE164: '+5592987654321',
        text: 'oi',
        gozapInstanceToken: 'inst-tok',
      }),
    ).rejects.toMatchObject({ providerErrorCode: 'gozap.not_on_whatsapp', fatal: true });
    expect(posted).toBe(false);
  });

  it('/chat/check devolvendo OUTRO assinante é ignorado — responde ao número original', async () => {
    let seenBody: unknown = null;
    server.use(
      check('5511999990000'),
      http.post(`${BASE}/send/text`, async ({ request }) => {
        seenBody = await request.json();
        return HttpResponse.json({ success: true, message: { id: 'X' } });
      }),
    );

    await ad.sendChatText!({
      instanceName: '',
      toE164: '+5592987654321',
      text: 'oi',
      gozapInstanceToken: 'inst-tok',
    });

    expect(seenBody).toEqual({ number: '5592987654321', text: 'oi' });
  });

  /**
   * A guarda contra o identificador OPACO. `dispatchOutbound` usa
   * `conv.phoneE164 ?? conv.remoteJid`, e um `remoteJid` `@lid` viraria, no
   * `digitsOnly`, um "telefone" INVENTADO de 15 dígitos — propaganda
   * eleitoral para um número que ninguém escolheu. Recusa antes de POSTar.
   */
  it('destinatário @lid (identificador opaco) é RECUSADO — nunca vira telefone inventado', async () => {
    let posted = false;
    server.use(
      http.post(`${BASE}/send/text`, () => {
        posted = true;
        return HttpResponse.json({ success: true, message: { id: 'X' } });
      }),
    );

    await expect(
      ad.sendChatText!({
        instanceName: '',
        toE164: '123456789012345@lid',
        text: 'oi',
        gozapInstanceToken: 'inst-tok',
      }),
    ).rejects.toMatchObject({ providerErrorCode: 'gozap.invalid_recipient', fatal: true });
    expect(posted).toBe(false);
  });

  it('JID de telefone (@s.whatsapp.net) continua sendo aceito', async () => {
    let seenBody: unknown = null;
    server.use(
      check('5592987654321'),
      http.post(`${BASE}/send/text`, async ({ request }) => {
        seenBody = await request.json();
        return HttpResponse.json({ success: true, message: { id: 'X' } });
      }),
    );

    await ad.sendChatText!({
      instanceName: '',
      toE164: '5592987654321@s.whatsapp.net',
      text: 'oi',
      gozapInstanceToken: 'inst-tok',
    });

    expect(seenBody).toEqual({ number: '5592987654321', text: 'oi' });
  });
});
