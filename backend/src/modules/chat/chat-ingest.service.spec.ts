import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockDeep, type MockProxy } from 'vitest-mock-extended';
import { ChatIngestService } from './chat-ingest.service';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { WhatsappProvidersService } from '../whatsapp-providers/whatsapp-providers.service';
import { ChatEventsService } from './chat-events.service';
import type { InboundChatMessage } from '../whatsapp-providers/ports/message-provider.port';
import { ConsentAction, ConsentSource, Prisma } from '@prisma/client';
import { ConsentService } from '../consent/consent.service';
import { OptInLinkService } from '../consent/optin-link.service';

const inbound = (over: Partial<InboundChatMessage> = {}): InboundChatMessage => ({
  providerMessageId: 'IN1', remoteJid: '5592999999999@s.whatsapp.net', phoneE164: '+5592999999999',
  isGroup: false, fromMe: false, pushName: 'Maria', kind: 'TEXT', text: 'Olá', receivedAt: new Date(), transcript: null, ...over,
});

describe('ChatIngestService', () => {
  let prisma: MockProxy<PrismaService>;
  let wa: MockProxy<WhatsappProvidersService>;
  let events: MockProxy<ChatEventsService>;
  let redis: { set: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn> };
  let mediaAdd: ReturnType<typeof vi.fn>;
  let consent: MockProxy<ConsentService>;
  let links: MockProxy<OptInLinkService>;
  let svc: ChatIngestService;

  beforeEach(() => {
    prisma = mockDeep<PrismaService>();
    wa = mockDeep<WhatsappProvidersService>();
    events = mockDeep<ChatEventsService>();
    consent = mockDeep<ConsentService>();
    // get => null means "not seen yet" (fast-path miss); set records the dedup
    // key only after a successful persist.
    redis = { set: vi.fn().mockResolvedValue('OK'), get: vi.fn().mockResolvedValue(null) };
    mediaAdd = vi.fn();
    const mediaQueue = { add: mediaAdd } as never;
    const botQueue = { add: vi.fn() } as never;
    links = mockDeep<OptInLinkService>();
    links.matchInbound.mockResolvedValue(null);
    svc = new ChatIngestService(prisma, wa, events, redis as never, mediaQueue, botQueue, consent, links);
    consent.record.mockResolvedValue({ eventId: 'ev1', created: true });
    prisma.contact.findMany.mockResolvedValue([]);
    prisma.message.findFirst.mockResolvedValue(null);
    prisma.channel.findUnique.mockResolvedValue(null);
    prisma.conversation.upsert.mockResolvedValue({ id: 'conv1', contactId: null } as never);
    prisma.message.create.mockResolvedValue({ id: 'msg1', media: null } as never);
    prisma.conversation.update.mockResolvedValue({} as never);
  });

  it('ignores group messages', async () => {
    wa.parseInboundChatMessages.mockReturnValue([inbound({ isGroup: true })]);
    await svc.ingestFromWebhook({}, 'i1');
    expect(prisma.message.create).not.toHaveBeenCalled();
  });

  it('skips when dedupe key already seen', async () => {
    wa.parseInboundChatMessages.mockReturnValue([inbound()]);
    redis.get.mockResolvedValue('1'); // fast-path hit => duplicate
    await svc.ingestFromWebhook({}, 'i1');
    expect(prisma.message.create).not.toHaveBeenCalled();
  });

  // Dedup-after-persist (Médio › Chat/Inbox): the dedup key must be set only
  // AFTER the message is persisted. If persistence throws, no key may be set —
  // otherwise the message is lost forever and the Evolution redelivery is
  // dropped as a "duplicate".
  it('does NOT set the dedup key when persistence throws (so redelivery can retry)', async () => {
    wa.parseInboundChatMessages.mockReturnValue([inbound()]);
    prisma.message.create.mockRejectedValue(new Error('db down'));
    await expect(svc.ingestFromWebhook({}, 'i1')).rejects.toThrow('db down');
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('sets the dedup key only after the message is persisted', async () => {
    wa.parseInboundChatMessages.mockReturnValue([inbound()]);
    const order: string[] = [];
    prisma.message.create.mockImplementation(async () => { order.push('persist'); return { id: 'msg1', media: null } as never; });
    redis.set.mockImplementation(async () => { order.push('dedup'); return 'OK'; });
    await svc.ingestFromWebhook({}, 'i1');
    expect(order).toEqual(['persist', 'dedup']);
  });

  // The DB-level providerMessageId @unique is the authoritative dedup: a
  // duplicate inbound that races past the Redis NX must not double-persist.
  it('treats a providerMessageId unique-violation as a duplicate (no rethrow)', async () => {
    wa.parseInboundChatMessages.mockReturnValue([inbound()]);
    prisma.message.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002', clientVersion: 'test',
      }),
    );
    await expect(svc.ingestFromWebhook({}, 'i1')).resolves.not.toThrow();
    // Duplicate => never publishes a message.created event for it.
    expect(events.publish).not.toHaveBeenCalled();
  });

  it('persists an inbound text message and bumps unreadCount', async () => {
    wa.parseInboundChatMessages.mockReturnValue([inbound()]);
    await svc.ingestFromWebhook({}, 'i1');
    expect(prisma.conversation.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { instanceId_remoteJid: { instanceId: 'i1', remoteJid: '5592999999999@s.whatsapp.net' } },
      }),
    );
    expect(prisma.message.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ direction: 'INBOUND', kind: 'TEXT', content: 'Olá', status: 'RECEIVED', conversationId: 'conv1' }) }),
    );
    expect(prisma.conversation.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'conv1' }, data: expect.objectContaining({ unreadCount: { increment: 1 }, lastMessagePreview: 'Olá', lastMessageDirection: 'INBOUND' }) }),
    );
    expect(events.publish).toHaveBeenCalledWith(expect.objectContaining({ type: 'message.created', conversationId: 'conv1' }));
  });

  // T6 (twilio-platform): janela de 24h — toda mensagem INBOUND abre/renova a
  // janela; gravamos lastInboundAt na conversa (o par contato↔canal) usando o
  // timestamp de recebimento do webhook.
  it('grava lastInboundAt na conversa em mensagens inbound (janela 24h)', async () => {
    const receivedAt = new Date('2026-07-11T12:00:00.000Z');
    wa.parseInboundChatMessages.mockReturnValue([inbound({ receivedAt })]);
    await svc.ingestFromWebhook({}, 'i1');
    expect(prisma.conversation.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'conv1' }, data: expect.objectContaining({ lastInboundAt: receivedAt }) }),
    );
  });

  it('NÃO grava lastInboundAt para eco outbound (só inbound abre a janela)', async () => {
    wa.parseInboundChatMessages.mockReturnValue([inbound({ fromMe: true, providerMessageId: 'OUT9' })]);
    prisma.message.findUnique.mockResolvedValue(null);
    await svc.ingestFromWebhook({}, 'i1');
    expect(prisma.conversation.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.not.objectContaining({ lastInboundAt: expect.anything() }) }),
    );
  });

  // T6 (twilio-platform): a mídia Twilio é baixada por URL (MediaUrl0, Basic
  // Auth) e não por message-key como no Evolution — o job de download precisa
  // carregar a URL do provedor.
  it('propaga media.url como mediaUrl no job de download (mídia Twilio)', async () => {
    wa.parseInboundChatMessages.mockReturnValue([
      inbound({ kind: 'IMAGE', text: undefined, media: { mimeType: 'image/jpeg', url: 'https://api.twilio.com/m/ME1' } }),
    ]);
    prisma.message.create.mockResolvedValue({ id: 'msg1', media: { id: 'mm1' } } as never);
    await svc.ingestFromWebhook({}, 'i1');
    expect(mediaAdd).toHaveBeenCalledWith('download', expect.objectContaining({
      messageMediaId: 'mm1', mediaUrl: 'https://api.twilio.com/m/ME1',
    }));
  });

  it('enfileira mídia Evolution (sem url) com mediaUrl null', async () => {
    wa.parseInboundChatMessages.mockReturnValue([
      inbound({ kind: 'IMAGE', text: undefined, media: { mimeType: 'image/jpeg' } }),
    ]);
    prisma.message.create.mockResolvedValue({ id: 'msg1', media: { id: 'mm1' } } as never);
    await svc.ingestFromWebhook({}, 'i1');
    expect(mediaAdd).toHaveBeenCalledWith('download', expect.objectContaining({ mediaUrl: null }));
  });

  it('links the contact when the phone matches an existing contact', async () => {
    wa.parseInboundChatMessages.mockReturnValue([inbound()]);
    prisma.contact.findMany.mockResolvedValue([{ id: 'ct1', phoneE164: '+5592999999999' }] as never);
    await svc.ingestFromWebhook({}, 'i1');
    expect(prisma.conversation.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ contactId: 'ct1' }) }),
    );
  });

  it('links a contact saved with the 9th digit when the JID arrives without it (BR 9-digit problem)', async () => {
    // Evolution echoes the legacy 8-digit JID; the contact is stored canonically
    // with the extra 9. The lookup must try both forms and still link.
    wa.parseInboundChatMessages.mockReturnValue([
      inbound({ remoteJid: '559295550101@s.whatsapp.net', phoneE164: '+559295550101' }),
    ]);
    prisma.contact.findMany.mockResolvedValue([{ id: 'ctBR', phoneE164: '+5592995550101' }] as never);

    await svc.ingestFromWebhook({}, 'i1');

    // Lookup queried BOTH the 8-digit and 9-digit forms.
    const where = prisma.contact.findMany.mock.calls[0][0]!.where as {
      phoneE164: { in: string[] };
    };
    expect(new Set(where.phoneE164.in)).toEqual(
      new Set(['+559295550101', '+5592995550101']),
    );
    // And the conversation/message linked to that contact.
    expect(prisma.conversation.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ contactId: 'ctBR' }) }),
    );
  });

  it('harvests the LID->phone mapping and resolves the @lid phone from altJid', async () => {
    wa.parseInboundChatMessages.mockReturnValue([
      inbound({ remoteJid: '192410374131731@lid', phoneE164: null, altJid: '559293550101@s.whatsapp.net', pushName: 'Jonathan' }),
    ]);
    await svc.ingestFromWebhook({}, 'i1');
    expect(prisma.lidPnMap.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { instanceId_lid: { instanceId: 'i1', lid: '192410374131731@lid' } },
        create: expect.objectContaining({ phoneE164: '+559293550101', name: 'Jonathan' }),
      }),
    );
    expect(prisma.conversation.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ phoneE164: '+559293550101', waName: 'Jonathan' }) }),
    );
  });

  it('leaves an unresolved @lid phone null (no altJid, no prior map) — never a fake phone', async () => {
    (prisma.lidPnMap.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    wa.parseInboundChatMessages.mockReturnValue([
      // pushName equal to the bare LID is not a real name → waName null
      inbound({ remoteJid: '105102346035294@lid', phoneE164: null, altJid: null, pushName: '105102346035294' }),
    ]);
    await svc.ingestFromWebhook({}, 'i1');
    expect(prisma.lidPnMap.upsert).not.toHaveBeenCalled();
    expect(prisma.conversation.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ phoneE164: null, waName: null }) }),
    );
  });

  it('does nothing when instanceId is missing', async () => {
    await svc.ingestFromWebhook({}, undefined);
    expect(wa.parseInboundChatMessages).not.toHaveBeenCalled();
  });

  // --- C1: inbound abre JANELA, nunca consentimento (o bug jurídico do T8) ---
  // O T8 fazia QUALQUER inbound de um contato conhecido setar optInAt: quem
  // respondia "não quero" ou "quem são vocês?" virava, no banco, um titular que
  // CONSENTIU (LGPD art. 5º XII / 8º §4º — e o próprio registro seria a prova,
  // produzida pelo IDASAM, de que o sistema fabricava consentimento).
  // Agora: inbound → só Conversation.lastInboundAt. Consentimento só por ato
  // afirmativo explícito (botão optin_yes), com o texto exibido como evidência.
  describe('inbound não fabrica consentimento (C1)', () => {
    const receivedAt = new Date('2026-07-11T12:00:00.000Z');

    it('inbound comum NÃO cria consentimento — só abre a janela de atendimento', async () => {
      wa.parseInboundChatMessages.mockReturnValue([
        inbound({ receivedAt, text: 'não tenho interesse' }),
      ]);
      prisma.contact.findMany.mockResolvedValue([{ id: 'ct1' }] as never);

      await svc.ingestFromWebhook({}, 'i1');

      expect(consent.record).not.toHaveBeenCalled();
      // E nada escreve os caches de opt-in na mão.
      expect(prisma.contact.update).not.toHaveBeenCalled();
      // A janela (e só ela) é aberta.
      expect(prisma.conversation.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ lastInboundAt: receivedAt }),
        }),
      );
    });

    it("botão 'optin_yes' grava GRANT com a finalidade da campanha e o texto renderizado do template", async () => {
      wa.parseInboundChatMessages.mockReturnValue([
        inbound({ buttonPayload: 'optin_yes', receivedAt, providerMessageId: 'IN-btn' }),
      ]);
      prisma.contact.findMany.mockResolvedValue([{ id: 'ct1' }] as never);
      // A OUTBOUND que exibiu o pedido de permissão — única campanha na janela.
      prisma.message.findMany.mockResolvedValue([
        {
          id: 'out1',
          providerMessageId: 'OUT-wamid',
          content: 'O IDASAM quer te enviar convites para cursos. Pode enviar?',
          campaignId: 'cmp1',
          createdAt: new Date('2026-07-11T10:00:00.000Z'),
          campaign: {
            purposeKey: 'convite_atividades',
            template: { metaName: 'picoa_teste_opt_in', twilioContentSid: 'HX123' },
          },
        },
      ] as never);

      await svc.ingestFromWebhook({}, 'i1');

      expect(consent.record).toHaveBeenCalledWith(
        expect.objectContaining({
          contactId: 'ct1',
          phoneE164: '+5592999999999',
          purposeKey: 'convite_atividades',
          action: ConsentAction.GRANT,
          source: ConsentSource.WA_BUTTON,
          // A prova é o TEXTO exibido, copiado por valor — não o nome do template.
          evidenceText: 'O IDASAM quer te enviar convites para cursos. Pode enviar?',
          occurredAt: receivedAt,
          evidence: expect.objectContaining({
            inboundWamid: 'IN-btn',
            outboundWamid: 'OUT-wamid',
            buttonPayload: 'optin_yes',
            templateName: 'picoa_teste_opt_in',
            twilioContentSid: 'HX123',
          }),
        }),
      );
    });

    it('com wamid citado, o clique é amarrado à outbound CITADA — mesmo com outra campanha depois', async () => {
      // Quando o provedor diz a QUAL mensagem o toque responde (Twilio:
      // OriginalRepliedMessageSid), a dúvida acaba: a finalidade e a prova saem
      // DAQUELA outbound, não da última campanha enviada ao contato.
      wa.parseInboundChatMessages.mockReturnValue([
        inbound({
          buttonPayload: 'optin_yes',
          receivedAt,
          providerMessageId: 'IN-btn',
          quotedWaMessageId: 'OUT-A',
        }),
      ]);
      prisma.contact.findMany.mockResolvedValue([{ id: 'ct1' }] as never);
      prisma.message.findFirst.mockResolvedValue({
        id: 'outA',
        providerMessageId: 'OUT-A',
        content: 'Podemos continuar te enviando novidades?',
        campaignId: 'cmp_optin',
        createdAt: new Date('2026-07-01T10:00:00.000Z'),
        campaign: {
          purposeKey: 'campanha_eleitoral',
          template: { metaName: 'reapresentacao', twilioContentSid: null },
        },
      } as never);
      // Uma campanha MAIS NOVA existe — e é ignorada, porque o wamid manda.
      prisma.message.findMany.mockResolvedValue([
        { id: 'outB', campaignId: 'cmp_agenda', content: 'Comício sábado', campaign: { purposeKey: 'agenda' } },
      ] as never);

      await svc.ingestFromWebhook({}, 'i1');

      expect(consent.record).toHaveBeenCalledWith(
        expect.objectContaining({
          purposeKey: 'campanha_eleitoral',
          evidenceText: 'Podemos continuar te enviando novidades?',
          evidence: expect.objectContaining({
            attribution: 'reply-wamid',
            outboundWamid: 'OUT-A',
            campaignId: 'cmp_optin',
          }),
        }),
      );
    });

    it("botão 'optin_yes' sem campanha resolvível NÃO grava consentimento (não inventa finalidade)", async () => {
      wa.parseInboundChatMessages.mockReturnValue([
        inbound({ buttonPayload: 'optin_yes', receivedAt }),
      ]);
      prisma.contact.findMany.mockResolvedValue([{ id: 'ct1' }] as never);
      prisma.message.findMany.mockResolvedValue([] as never); // nenhuma outbound de campanha

      await svc.ingestFromWebhook({}, 'i1');

      expect(consent.record).not.toHaveBeenCalled();
      expect(prisma.message.create).toHaveBeenCalled(); // o ingest segue normal
    });

    it('NÃO grava consentimento em eco outbound (só o titular consente)', async () => {
      wa.parseInboundChatMessages.mockReturnValue([
        inbound({ fromMe: true, buttonPayload: 'optin_yes', providerMessageId: 'OUT-opt' }),
      ]);
      prisma.message.findUnique.mockResolvedValue(null);
      prisma.contact.findMany.mockResolvedValue([{ id: 'ct1' }] as never);

      await svc.ingestFromWebhook({}, 'i1');

      expect(consent.record).not.toHaveBeenCalled();
    });

    it('falha ao gravar o consentimento NÃO derruba o ingest (a mensagem persiste)', async () => {
      wa.parseInboundChatMessages.mockReturnValue([
        inbound({ buttonPayload: 'optin_yes', receivedAt }),
      ]);
      prisma.contact.findMany.mockResolvedValue([{ id: 'ct1' }] as never);
      prisma.message.findMany.mockResolvedValue([
        {
          id: 'out1',
          providerMessageId: 'OUT-wamid',
          content: 'texto do template',
          campaignId: 'cmp1',
          createdAt: new Date('2026-07-11T10:00:00.000Z'),
          campaign: { purposeKey: 'convite_atividades', template: {} },
        },
      ] as never);
      consent.record.mockRejectedValue(new Error('db blip') as never);

      await expect(svc.ingestFromWebhook({}, 'i1')).resolves.not.toThrow();
      expect(prisma.message.create).toHaveBeenCalled();
    });
  });

  // --- T5b: multi-provider channel-aware routing ---
  // A Twilio inbound on a deploy that also has Evolution channels active must
  // be parsed by the TWILIO adapter (via parseInboundChatMessagesFor), not the
  // legacy env-selected adapter (which would resolve to Evolution and silently
  // drop the message — see T5b critical fix).
  it('uses parseInboundChatMessagesFor when a provider is given (multi-provider channel-aware path)', async () => {
    wa.parseInboundChatMessagesFor.mockReturnValue([inbound()]);
    await svc.ingestFromWebhook({}, 'i1', 'TWILIO');
    expect(wa.parseInboundChatMessagesFor).toHaveBeenCalledWith('TWILIO', {});
    expect(wa.parseInboundChatMessages).not.toHaveBeenCalled();
    expect(prisma.message.create).toHaveBeenCalled();
  });

  it('falls back to the legacy parseInboundChatMessages when no provider is given (Evolution-only callers unchanged)', async () => {
    wa.parseInboundChatMessages.mockReturnValue([inbound()]);
    await svc.ingestFromWebhook({}, 'i1');
    expect(wa.parseInboundChatMessages).toHaveBeenCalledWith({});
    expect(wa.parseInboundChatMessagesFor).not.toHaveBeenCalled();
    expect(prisma.message.create).toHaveBeenCalled();
  });

  it('does nothing (no adapter call at all) when instanceId is missing, even with a provider given', async () => {
    await svc.ingestFromWebhook({}, undefined, 'TWILIO');
    expect(wa.parseInboundChatMessagesFor).not.toHaveBeenCalled();
    expect(wa.parseInboundChatMessages).not.toHaveBeenCalled();
  });

  it('ignores outbound echo already persisted by ORGAMIND', async () => {
    wa.parseInboundChatMessages.mockReturnValue([inbound({ fromMe: true, providerMessageId: 'OUT1' })]);
    prisma.message.findUnique.mockResolvedValue({ id: 'existing' } as never);
    await svc.ingestFromWebhook({}, 'i1');
    expect(prisma.message.create).not.toHaveBeenCalled();
  });

  it('records an outbound echo sent from the operator phone', async () => {
    wa.parseInboundChatMessages.mockReturnValue([inbound({ fromMe: true, providerMessageId: 'OUT2', text: 'mandei pelo cel' })]);
    prisma.message.findUnique.mockResolvedValue(null);
    await svc.ingestFromWebhook({}, 'i1');
    expect(prisma.message.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ direction: 'OUTBOUND', content: 'mandei pelo cel', status: 'SENT', providerMessageId: 'OUT2' }) }),
    );
    expect(prisma.conversation.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ lastMessageDirection: 'OUTBOUND' }) }),
    );
  });

  // A1 — voice-note transcription
  it('persists transcript when an audio message carries a speech-to-text result', async () => {
    wa.parseInboundChatMessages.mockReturnValue([inbound({ kind: 'AUDIO', text: null, transcript: 'oi tudo bem?' })]);
    await svc.ingestFromWebhook({}, 'i1');
    expect(prisma.message.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ transcript: 'oi tudo bem?' }) }),
    );
  });

  it('persists transcript as null when not present', async () => {
    wa.parseInboundChatMessages.mockReturnValue([inbound({ transcript: undefined })]);
    await svc.ingestFromWebhook({}, 'i1');
    expect(prisma.message.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ transcript: null }) }),
    );
  });

  /**
   * O bloco de avatar só roda em canal EVOLUTION: `fetchProfilePictureUrl`
   * resolve sempre o adapter do Evolution e endereça a instância pelo NOME, e
   * um canal ZERNIO/TWILIO/GOZAP (sem `evolutionInstanceName`) só faria uma
   * chamada condenada. Estes testes descrevem o canal Evolution — então o canal
   * precisa dizer que é um.
   */
  function canalEvolution() {
    prisma.channel.findUnique.mockResolvedValue({
      evolutionInstanceName: 'inst-evo',
      botId: null,
    } as never);
  }

  /**
   * A conversa do titular JÁ EXISTE (é o caso normal: o disparo a abriu antes).
   * O ingest a RESOLVE (`conversation.findFirst`, por contactId/variantes/JIDs,
   * o mesmo critério do lado OUTBOUND) e a ATUALIZA — não dá upsert numa chave
   * fabricada, que era o que partia a thread em duas linhas na inbox.
   */
  function conversaExistente(over: Record<string, unknown> = {}) {
    prisma.conversation.findFirst.mockResolvedValue({
      id: 'conv1',
      remoteJid: '5592999999999@s.whatsapp.net',
      contactId: null,
      profilePicUrl: null,
      profilePicFetchedAt: null,
      lastMessageAt: null,
      lastInboundAt: null,
      ...over,
    } as never);
    prisma.conversation.update.mockResolvedValue({
      id: 'conv1',
      lastMessageAt: null,
      lastInboundAt: null,
    } as never);
  }

  /** O `data` da atualização da conversa resolvida (a 1ª chamada é a do resumo/avatar). */
  function dadosDaConversa() {
    return (prisma.conversation.update.mock.calls[0][0] as { data: Record<string, unknown> }).data;
  }

  // A2 — avatar enrichment (U2: 24h TTL refresh instead of fetch-once-forever)
  it('fetches and stores profilePicUrl (+ stamps profilePicFetchedAt) when conversation has no picture yet and JID is phone-addressed', async () => {
    canalEvolution();
    conversaExistente();
    (wa.fetchProfilePictureUrl as ReturnType<typeof vi.fn>).mockResolvedValue('https://cdn.example.com/pic.jpg');
    wa.parseInboundChatMessages.mockReturnValue([inbound()]);
    await svc.ingestFromWebhook({}, 'i1');
    expect(dadosDaConversa()).toMatchObject({
      profilePicUrl: 'https://cdn.example.com/pic.jpg',
      profilePicFetchedAt: expect.any(Date),
    });
  });

  it('nenhuma conversa ainda: cria a do JID desta mensagem, com a foto', async () => {
    canalEvolution();
    prisma.conversation.findFirst.mockResolvedValue(null);
    (wa.fetchProfilePictureUrl as ReturnType<typeof vi.fn>).mockResolvedValue('https://cdn.example.com/pic.jpg');
    wa.parseInboundChatMessages.mockReturnValue([inbound()]);
    await svc.ingestFromWebhook({}, 'i1');
    expect(prisma.conversation.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ profilePicUrl: 'https://cdn.example.com/pic.jpg', profilePicFetchedAt: expect.any(Date) }),
      }),
    );
  });

  it('skips avatar fetch when the pic exists and the stamp is fresher than 24h (no re-stamp either)', async () => {
    canalEvolution();
    conversaExistente({
      profilePicUrl: 'https://cdn.example.com/existing.jpg',
      profilePicFetchedAt: new Date(Date.now() - 60 * 60 * 1000), // 1h ago
    });
    wa.parseInboundChatMessages.mockReturnValue([inbound()]);
    await svc.ingestFromWebhook({}, 'i1');
    expect(wa.fetchProfilePictureUrl).not.toHaveBeenCalled();
    expect(dadosDaConversa()).not.toHaveProperty('profilePicFetchedAt');
    expect(dadosDaConversa()).not.toHaveProperty('profilePicUrl');
  });

  it('re-fetches the avatar when the stamp is older than 24h and updates url + stamp', async () => {
    canalEvolution();
    conversaExistente({
      profilePicUrl: 'https://cdn.example.com/old.jpg',
      profilePicFetchedAt: new Date(Date.now() - 25 * 60 * 60 * 1000), // 25h ago
    });
    (wa.fetchProfilePictureUrl as ReturnType<typeof vi.fn>).mockResolvedValue('https://cdn.example.com/new.jpg');
    wa.parseInboundChatMessages.mockReturnValue([inbound()]);
    await svc.ingestFromWebhook({}, 'i1');
    expect(wa.fetchProfilePictureUrl).toHaveBeenCalled();
    expect(dadosDaConversa()).toMatchObject({
      profilePicUrl: 'https://cdn.example.com/new.jpg',
      profilePicFetchedAt: expect.any(Date),
    });
  });

  it('re-fetches when the pic exists but was never stamped (pre-migration rows)', async () => {
    canalEvolution();
    conversaExistente({
      profilePicUrl: 'https://cdn.example.com/legacy.jpg',
      profilePicFetchedAt: null,
    });
    (wa.fetchProfilePictureUrl as ReturnType<typeof vi.fn>).mockResolvedValue('https://cdn.example.com/new.jpg');
    wa.parseInboundChatMessages.mockReturnValue([inbound()]);
    await svc.ingestFromWebhook({}, 'i1');
    expect(wa.fetchProfilePictureUrl).toHaveBeenCalled();
    expect(dadosDaConversa()).toMatchObject({
      profilePicUrl: 'https://cdn.example.com/new.jpg',
      profilePicFetchedAt: expect.any(Date),
    });
  });

  it('stamps the attempt but preserves the cached url when the fetch returns null (throttles private/404 profiles)', async () => {
    canalEvolution();
    conversaExistente({
      profilePicUrl: 'https://cdn.example.com/old.jpg',
      profilePicFetchedAt: new Date(Date.now() - 25 * 60 * 60 * 1000), // stale => attempt due
    });
    (wa.fetchProfilePictureUrl as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    wa.parseInboundChatMessages.mockReturnValue([inbound()]);
    await svc.ingestFromWebhook({}, 'i1');
    expect(dadosDaConversa().profilePicFetchedAt).toEqual(expect.any(Date));
    expect(dadosDaConversa()).not.toHaveProperty('profilePicUrl'); // cached avatar preserved
  });

  it('does not fail ingest when fetchProfilePictureUrl throws', async () => {
    canalEvolution();
    conversaExistente();
    (wa.fetchProfilePictureUrl as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('network error'));
    wa.parseInboundChatMessages.mockReturnValue([inbound()]);
    await expect(svc.ingestFromWebhook({}, 'i1')).resolves.not.toThrow();
    expect(prisma.message.create).toHaveBeenCalled();
  });

  it('skips avatar fetch for @lid JIDs (non-phone-addressed contacts)', async () => {
    canalEvolution();
    (prisma.lidPnMap.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    wa.parseInboundChatMessages.mockReturnValue([
      inbound({ remoteJid: '105102346035294@lid', phoneE164: null, altJid: null, pushName: '105102346035294' }),
    ]);
    await svc.ingestFromWebhook({}, 'i1');
    expect(wa.fetchProfilePictureUrl).not.toHaveBeenCalled();
  });
});
