import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockDeep, type MockProxy } from 'vitest-mock-extended';
import { ZernioInboxSyncService } from './zernio-inbox-sync.service';
import { ChatIngestService } from './chat-ingest.service';
import { ChatEventsService } from './chat-events.service';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { WhatsappProvidersService } from '../whatsapp-providers/whatsapp-providers.service';
import { ConsentService } from '../consent/consent.service';
import { OptInLinkService } from '../consent/optin-link.service';
import type {
  ZernioInboxClient,
  ZernioConversation,
  ZernioInboxMessage,
} from '../whatsapp-providers/zernio-inbox.client';
import { MessageDirection, Prisma } from '@prisma/client';

const ACCOUNT_ID = 'acc1';
const CHANNEL_ID = 'ch1';

const conversation = (over: Partial<ZernioConversation> = {}): ZernioConversation => ({
  id: 'c1',
  accountId: ACCOUNT_ID,
  platform: 'whatsapp',
  participantId: '559285550102',
  participantName: 'Gomes',
  participantPicture: 'https://cdn/pic.jpg',
  lastMessage: 'Tudo bem',
  updatedTime: '2026-07-11T22:27:30.000Z',
  unreadCount: 1,
  ...over,
});

const message = (over: Partial<ZernioInboxMessage> = {}): ZernioInboxMessage => ({
  id: 'wamid.1',
  direction: 'incoming',
  message: 'Tudo bem',
  senderName: 'Gomes',
  senderPhoneNumber: '+559285550102',
  createdAt: '2026-07-11T22:27:30.000Z',
  attachments: [],
  ...over,
});

const zernioChannel = (over: Record<string, unknown> = {}) => ({
  id: CHANNEL_ID,
  provider: 'ZERNIO',
  isActive: true,
  zernioAccountId: ACCOUNT_ID,
  evolutionInstanceName: null,
  botId: null,
  ...over,
});

describe('ZernioInboxSyncService', () => {
  let prisma: MockProxy<PrismaService>;
  let client: MockProxy<ZernioInboxClient>;
  let consent: MockProxy<ConsentService>;
  let links: MockProxy<OptInLinkService>;
  let ingest: ChatIngestService;
  let svc: ZernioInboxSyncService;
  /** wamids já persistidos — reproduz o @unique de Message.providerMessageId. */
  let persisted: Set<string>;
  let redisStore: Map<string, string>;

  beforeEach(() => {
    prisma = mockDeep<PrismaService>();
    client = mockDeep<ZernioInboxClient>();
    consent = mockDeep<ConsentService>();
    links = mockDeep<OptInLinkService>();
    persisted = new Set();
    redisStore = new Map();

    // Redis de verdade (em memória): é ele que faz o fast-path do dedupe.
    const redis = {
      get: vi.fn(async (k: string) => redisStore.get(k) ?? null),
      set: vi.fn(async (k: string, v: string) => {
        redisStore.set(k, v);
        return 'OK';
      }),
    };

    Object.defineProperty(client, 'configured', { value: true, writable: true });
    consent.isSuppressed.mockResolvedValue(false);
    links.matchInbound.mockResolvedValue(null);
    consent.rehydrate.mockResolvedValue([]);

    prisma.channel.findUnique.mockResolvedValue(zernioChannel() as never);
    prisma.contact.findMany.mockResolvedValue([]);
    prisma.contact.create.mockResolvedValue({ id: 'contact1' } as never);
    prisma.conversation.upsert.mockResolvedValue({
      id: 'conv1',
      lastMessageAt: null,
      lastInboundAt: null,
    } as never);
    prisma.conversation.update.mockResolvedValue({} as never);
    prisma.message.findUnique.mockResolvedValue(null);
    // O @unique de providerMessageId é a dedupe AUTORITATIVA: a 2ª inserção do
    // mesmo wamid estoura P2002, exatamente como o Postgres faria.
    prisma.message.create.mockImplementation((async (args: {
      data: { providerMessageId?: string };
    }) => {
      const id = args.data.providerMessageId;
      if (id && persisted.has(id)) {
        throw new Prisma.PrismaClientKnownRequestError('dup', {
          code: 'P2002',
          clientVersion: '5',
        });
      }
      if (id) persisted.add(id);
      return { id: `msg-${id}`, media: null };
    }) as never);

    const wa = mockDeep<WhatsappProvidersService>();
    const events = mockDeep<ChatEventsService>();
    const mediaQueue = { add: vi.fn() } as never;
    const botQueue = { add: vi.fn() } as never;
    ingest = new ChatIngestService(
      prisma,
      wa,
      events,
      redis as never,
      mediaQueue,
      botQueue,
      consent,
      links,
    );
    svc = new ZernioInboxSyncService(prisma, client as never, ingest);
  });

  /** Uma única página de conversas e uma única página de mensagens. */
  function onePageEach(convs: ZernioConversation[], msgs: ZernioInboxMessage[]) {
    client.listConversations.mockResolvedValue({
      items: convs,
      hasMore: false,
      nextCursor: null,
    });
    client.listMessages.mockResolvedValue({
      items: msgs,
      hasMore: false,
      nextCursor: null,
    });
  }

  it('importa conversas e mensagens do Zernio para a inbox do orgamind', async () => {
    onePageEach([conversation()], [message()]);

    const res = await svc.syncChannel(CHANNEL_ID);

    expect(res).toMatchObject({ conversations: 1, messages: 1 });
    // As mensagens são pedidas COM o accountId (sem ele a API dá 400).
    expect(client.listMessages).toHaveBeenCalledWith(CHANNEL_ID, 'c1', ACCOUNT_ID, undefined);
    // Conversa criada no MODELO DE CHAT do orgamind (o mesmo do webhook).
    expect(prisma.conversation.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          instanceId_remoteJid: {
            instanceId: CHANNEL_ID,
            remoteJid: '559285550102@s.whatsapp.net',
          },
        },
      }),
    );
    expect(prisma.message.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          providerMessageId: 'wamid.1',
          direction: MessageDirection.INBOUND,
          content: 'Tudo bem',
          instanceId: CHANNEL_ID,
        }),
      }),
    );
  });

  it('segue o cursor até o fim (2 páginas de conversas)', async () => {
    client.listConversations
      .mockResolvedValueOnce({
        items: [conversation({ id: 'c1', participantId: '559285550102' })],
        hasMore: true,
        nextCursor: 'CUR2',
      })
      .mockResolvedValueOnce({
        items: [conversation({ id: 'c2', participantId: '559299550101' })],
        hasMore: false,
        nextCursor: null,
      });
    client.listMessages
      .mockResolvedValueOnce({ items: [message({ id: 'wamid.1' })], hasMore: false, nextCursor: null })
      .mockResolvedValueOnce({ items: [message({ id: 'wamid.2' })], hasMore: false, nextCursor: null });

    const res = await svc.syncChannel(CHANNEL_ID);

    expect(client.listConversations).toHaveBeenCalledTimes(2);
    expect(client.listConversations).toHaveBeenNthCalledWith(1, CHANNEL_ID, ACCOUNT_ID, undefined);
    expect(client.listConversations).toHaveBeenNthCalledWith(2, CHANNEL_ID, ACCOUNT_ID, 'CUR2');
    expect(res).toMatchObject({ conversations: 2, messages: 2 });
  });

  it('segue o cursor das MENSAGENS (2 páginas na mesma conversa)', async () => {
    client.listConversations.mockResolvedValue({
      items: [conversation()],
      hasMore: false,
      nextCursor: null,
    });
    client.listMessages
      .mockResolvedValueOnce({ items: [message({ id: 'wamid.1' })], hasMore: true, nextCursor: 'MCUR2' })
      .mockResolvedValueOnce({ items: [message({ id: 'wamid.2' })], hasMore: false, nextCursor: null });

    const res = await svc.syncChannel(CHANNEL_ID);

    expect(client.listMessages).toHaveBeenNthCalledWith(2, CHANNEL_ID, 'c1', ACCOUNT_ID, 'MCUR2');
    expect(res.messages).toBe(2);
  });

  // IDEMPOTÊNCIA: o job roda a cada 10 min e o operador pode clicar 2x. Rodar de
  // novo não pode duplicar NADA (dedupe por providerMessageId = wamid).
  it('rodar 2x não duplica mensagem alguma', async () => {
    onePageEach([conversation()], [message()]);

    const first = await svc.syncChannel(CHANNEL_ID);
    const second = await svc.syncChannel(CHANNEL_ID);

    expect(first.messages).toBe(1);
    expect(second.messages).toBe(0);
    expect(prisma.message.create).toHaveBeenCalledTimes(1);
    expect(persisted.size).toBe(1);
  });

  // O mesmo, com o cache do Redis FRIO (outra instância, restart): a barreira que
  // sobra é o @unique do banco (P2002) — e ela não pode explodir o sync.
  it('não duplica mesmo com o fast-path do Redis frio (P2002 é tratado)', async () => {
    onePageEach([conversation()], [message()]);
    await svc.syncChannel(CHANNEL_ID);
    redisStore.clear(); // cache frio: só o @unique protege

    const second = await svc.syncChannel(CHANNEL_ID);

    expect(second.messages).toBe(0);
    expect(prisma.message.create).toHaveBeenCalledTimes(2); // a 2ª tentou e bateu no P2002
    expect(persisted.size).toBe(1); // …e não gravou nada
  });

  // O BUG JURÍDICO que esta base já corrigiu uma vez: inbound ABRE JANELA, não
  // consente. Um backfill em massa é o pior lugar possível para fabricar
  // consentimento — importaria ~100 disparos como se fossem autorizações.
  it('cria o contato SEM gravar consentimento', async () => {
    onePageEach([conversation()], [message()]);

    await svc.syncChannel(CHANNEL_ID);

    expect(prisma.contact.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ phoneE164: '+559285550102', name: 'Gomes' }),
      }),
    );
    expect(consent.record).not.toHaveBeenCalled();
  });

  it('NÃO ressuscita um contato suprimido (SuppressionList)', async () => {
    consent.isSuppressed.mockResolvedValue(true);
    onePageEach([conversation()], [message()]);

    const res = await svc.syncChannel(CHANNEL_ID);

    expect(consent.isSuppressed).toHaveBeenCalledWith('+559285550102');
    expect(prisma.contact.create).not.toHaveBeenCalled();
    expect(consent.record).not.toHaveBeenCalled();
    // A mensagem entra na inbox mesmo assim: quem pediu PARAR continua podendo
    // falar com o IDASAM — supressão barra ENVIO, não RECEBIMENTO.
    expect(res.messages).toBe(1);
  });

  it('preenche lastInboundAt (a janela de 24h) com o inbound mais recente', async () => {
    onePageEach(
      [conversation()],
      [
        message({ id: 'wamid.1', createdAt: '2026-07-11T10:00:00.000Z' }),
        message({ id: 'wamid.2', createdAt: '2026-07-11T22:27:30.000Z' }),
      ],
    );

    await svc.syncChannel(CHANNEL_ID);

    const inboundAts = prisma.conversation.update.mock.calls
      .map((c) => (c[0] as { data: { lastInboundAt?: Date } }).data.lastInboundAt)
      .filter((d): d is Date => !!d);
    expect(inboundAts.at(-1)).toEqual(new Date('2026-07-11T22:27:30.000Z'));
  });

  it('mensagem OUTGOING não abre janela (só INBOUND preenche lastInboundAt)', async () => {
    onePageEach([conversation()], [message({ id: 'wamid.out', direction: 'outgoing' })]);

    await svc.syncChannel(CHANNEL_ID);

    expect(prisma.message.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ direction: MessageDirection.OUTBOUND }),
      }),
    );
    const anyInbound = prisma.conversation.update.mock.calls.some(
      (c) => (c[0] as { data: { lastInboundAt?: Date } }).data.lastInboundAt,
    );
    expect(anyInbound).toBe(false);
  });

  it('pula canal sem zernioAccountId', async () => {
    prisma.channel.findUnique.mockResolvedValue(
      zernioChannel({ zernioAccountId: null }) as never,
    );

    const res = await svc.syncChannel(CHANNEL_ID);

    expect(res).toMatchObject({ conversations: 0, messages: 0 });
    expect(res.skipped).toBeTruthy();
    expect(client.listConversations).not.toHaveBeenCalled();
  });

  it('pula canal inativo', async () => {
    prisma.channel.findUnique.mockResolvedValue(zernioChannel({ isActive: false }) as never);

    const res = await svc.syncChannel(CHANNEL_ID);

    expect(res.skipped).toBeTruthy();
    expect(client.listConversations).not.toHaveBeenCalled();
  });

  it('pula canal que não é ZERNIO', async () => {
    prisma.channel.findUnique.mockResolvedValue(
      zernioChannel({ provider: 'TWILIO' }) as never,
    );

    const res = await svc.syncChannel(CHANNEL_ID);

    expect(res.skipped).toBeTruthy();
    expect(client.listConversations).not.toHaveBeenCalled();
  });

  it('ignora conversas que não são de whatsapp', async () => {
    onePageEach([conversation({ platform: 'instagram' })], [message()]);

    const res = await svc.syncChannel(CHANNEL_ID);

    expect(res).toMatchObject({ conversations: 0, messages: 0 });
    expect(client.listMessages).not.toHaveBeenCalled();
  });

  // Uma conversa ruim (erro transitório do Zernio) não pode abortar o sync
  // inteiro — o resto das ~100 conversas precisa entrar.
  it('uma conversa que falha não aborta as demais', async () => {
    client.listConversations.mockResolvedValue({
      items: [conversation({ id: 'c1' }), conversation({ id: 'c2', participantId: '559299550101' })],
      hasMore: false,
      nextCursor: null,
    });
    client.listMessages
      .mockRejectedValueOnce(new Error('zernio 500'))
      .mockResolvedValueOnce({ items: [message({ id: 'wamid.2' })], hasMore: false, nextCursor: null });

    const res = await svc.syncChannel(CHANNEL_ID);

    expect(res.messages).toBe(1);
    expect(res.failed).toBe(1);
  });

  it('syncAllChannels percorre todos os canais ZERNIO ativos', async () => {
    prisma.channel.findMany.mockResolvedValue([
      { id: 'ch1' },
      { id: 'ch2' },
    ] as never);
    prisma.channel.findUnique.mockResolvedValue(zernioChannel() as never);
    onePageEach([conversation()], [message()]);

    const res = await svc.syncAllChannels();

    expect(prisma.channel.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          provider: 'ZERNIO',
          isActive: true,
          zernioAccountId: { not: null },
        }),
      }),
    );
    expect(res.channels).toBe(2);
  });

  it('vira no-op sem credencial do Zernio configurada', async () => {
    Object.defineProperty(client, 'configured', { value: false, writable: true });

    const res = await svc.syncChannel(CHANNEL_ID);

    expect(res.skipped).toBeTruthy();
    expect(client.listConversations).not.toHaveBeenCalled();
  });

  /**
   * Progresso e retomada — o que transforma o sync de "request de 3 minutos que
   * dá 500" em job observável. A tela lê exatamente estes números.
   */
  describe('progresso e retomada (job de background)', () => {
    it('reporta progresso a cada conversa ("42 de 100" nasce daqui)', async () => {
      client.listConversations.mockResolvedValue({
        items: [
          conversation({ id: 'c1', participantId: '559285550102' }),
          conversation({ id: 'c2', participantId: '559299550101' }),
        ],
        hasMore: false,
        nextCursor: null,
      });
      client.listMessages
        .mockResolvedValueOnce({ items: [message({ id: 'wamid.1' })], hasMore: false, nextCursor: null })
        .mockResolvedValueOnce({ items: [message({ id: 'wamid.2' })], hasMore: false, nextCursor: null });
      const seen: Array<{ processed: number; total: number; imported: number }> = [];

      await svc.syncChannel(CHANNEL_ID, {
        onProgress: async (p) => {
          seen.push({ processed: p.processed, total: p.total, imported: p.imported });
        },
      });

      expect(seen).toHaveLength(2);
      expect(seen[0]).toMatchObject({ processed: 1, total: 2, imported: 1 });
      expect(seen[1]).toMatchObject({ processed: 2, total: 2, imported: 2 });
    });

    it('retoma da página onde parou (startCursor), sem revisitar as anteriores', async () => {
      client.listConversations.mockResolvedValue({
        items: [conversation({ id: 'c2', participantId: '559299550101' })],
        hasMore: false,
        nextCursor: null,
      });
      client.listMessages.mockResolvedValue({
        items: [message({ id: 'wamid.2' })],
        hasMore: false,
        nextCursor: null,
      });

      await svc.syncChannel(CHANNEL_ID, { startCursor: 'CUR2' });

      // Retomou DIRETO no cursor salvo — a página 1 não é pedida de novo.
      expect(client.listConversations).toHaveBeenCalledTimes(1);
      expect(client.listConversations).toHaveBeenCalledWith(CHANNEL_ID, ACCOUNT_ID, 'CUR2');
    });

    /**
     * O teste que o incidente pede: a execução MORRE no meio (o Zernio derruba a
     * 2ª página). O que já entrou tem de continuar valendo, e a reexecução não
     * pode duplicar nada nem perder a conversa que faltava.
     */
    /**
     * PRIORIDADE DO ENVIO. O balde é um só: se o sync continuar bebendo dele
     * durante uma campanha, cada mensagem enviada disputa slot com uma leitura
     * de conversa — o disparo arrasta e, no limite, a campanha falha. O sync é
     * backfill de histórico: pode esperar. O envio, não.
     */
    it('campanha ativa no canal: o sync CEDE o balde (pausa) em vez de competir', async () => {
      prisma.campaign.findFirst.mockResolvedValue({ id: 'camp1' } as never);
      client.listConversations.mockResolvedValue({
        items: [
          conversation({ id: 'c1', participantId: '559285550102' }),
          conversation({ id: 'c2', participantId: '559299550101' }),
        ],
        hasMore: false,
        nextCursor: null,
      });

      const res = await svc.syncChannel(CHANNEL_ID);

      expect(res.paused).toBe(true);
      // O ponto que importa: NENHUMA mensagem foi pedida ao Zernio. O sync não
      // gastou um único slot do balde enquanto a campanha corre.
      expect(client.listMessages).not.toHaveBeenCalled();
      expect(res.messages).toBe(0);
    });

    it('sem campanha ativa, o sync roda normalmente', async () => {
      prisma.campaign.findFirst.mockResolvedValue(null as never);
      client.listConversations.mockResolvedValue({
        items: [conversation({ id: 'c1', participantId: '559285550102' })],
        hasMore: false,
        nextCursor: null,
      });
      client.listMessages.mockResolvedValue({
        items: [message({ id: 'wamid.1' })],
        hasMore: false,
        nextCursor: null,
      });

      const res = await svc.syncChannel(CHANNEL_ID);

      expect(res.paused).toBeFalsy();
      expect(res.messages).toBe(1);
    });

    it('a pausa guarda o cursor: o sync retoma de onde cedeu', async () => {
      prisma.campaign.findFirst.mockResolvedValue({ id: 'camp1' } as never);
      client.listConversations.mockResolvedValue({
        items: [conversation({ id: 'c1', participantId: '559285550102' })],
        hasMore: true,
        nextCursor: 'CUR2',
      });

      const res = await svc.syncChannel(CHANNEL_ID, { startCursor: 'CUR9' });

      expect(res.paused).toBe(true);
      expect(res.resumeCursor).toBe('CUR9'); // refaz a página onde parou
    });

    it('execução interrompida: reexecutar continua e não duplica', async () => {
      // 1ª execução: página 1 importa c1; a página 2 explode.
      client.listConversations
        .mockResolvedValueOnce({
          items: [conversation({ id: 'c1', participantId: '559285550102' })],
          hasMore: true,
          nextCursor: 'CUR2',
        })
        .mockRejectedValueOnce(new Error('Zernio caiu no meio'));
      client.listMessages.mockResolvedValue({
        items: [message({ id: 'wamid.1' })],
        hasMore: false,
        nextCursor: null,
      });
      let lastCursor: string | undefined;

      await expect(
        svc.syncChannel(CHANNEL_ID, {
          onProgress: async (p) => {
            lastCursor = p.nextCursor ?? lastCursor;
          },
        }),
      ).rejects.toThrow('Zernio caiu no meio');

      // O que entrou, entrou: wamid.1 está persistido.
      expect(persisted.has('wamid.1')).toBe(true);
      expect(lastCursor).toBe('CUR2'); // e sabemos de onde retomar

      // 2ª execução, retomando do cursor: traz c2 e NÃO duplica c1.
      const createsBefore = prisma.message.create.mock.calls.length;
      client.listConversations.mockReset();
      client.listConversations.mockResolvedValue({
        items: [conversation({ id: 'c2', participantId: '559299550101' })],
        hasMore: false,
        nextCursor: null,
      });
      client.listMessages.mockResolvedValue({
        items: [message({ id: 'wamid.2' })],
        hasMore: false,
        nextCursor: null,
      });

      const res = await svc.syncChannel(CHANNEL_ID, { startCursor: lastCursor });

      expect(res.messages).toBe(1); // só a NOVA
      expect(persisted.has('wamid.2')).toBe(true);
      // Nenhuma reinserção de wamid.1 (o @unique teria estourado P2002).
      const novos = prisma.message.create.mock.calls.length - createsBefore;
      expect(novos).toBe(1);
    });
  });
});
