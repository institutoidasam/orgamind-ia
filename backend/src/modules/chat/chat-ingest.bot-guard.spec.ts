import { describe, it, expect, vi } from 'vitest';
import { mockDeep } from 'vitest-mock-extended';
import { Prisma } from '@prisma/client';
import { ChatIngestService } from './chat-ingest.service';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { WhatsappProvidersService } from '../whatsapp-providers/whatsapp-providers.service';
import { ChatEventsService } from './chat-events.service';
import { ConsentService } from '../consent/consent.service';
import { OptInLinkService } from '../consent/optin-link.service';
import type { InboundChatMessage } from '../whatsapp-providers/ports/message-provider.port';
import type { ChatMediaDownloadJob } from '../queue/queue.constants';

vi.mock('./conversation-inbound', () =>
  vi.importActual('./conversation-inbound.test-fixtures'),
);

/** K3-7 (c)/(d): o recebimento é o único lugar que enfileira `bot.reply` de TEXTO. */
const REPLY_ARGS = [
  'reply',
  { conversationId: 'c1', messageId: 'm1' },
  { jobId: 'm1' },
] as const;

/** Redis com estado: `set` grava, `get` lê — a chave de dedup precisa existir de verdade. */
function statefulRedis() {
  const store = new Map<string, string>();
  return {
    get: vi.fn((k: string) => Promise.resolve(store.get(k) ?? null)),
    set: vi.fn(
      (k: string, v: string) => (store.set(k, v), Promise.resolve('OK')),
    ),
  };
}

/** Canal COM robô, mensagem recebida AGORA: só o código sob teste impede o enqueue. */
function make() {
  const prisma = mockDeep<PrismaService>();
  const redis = statefulRedis();
  const botQueue = { add: vi.fn().mockResolvedValue({}) };
  const mediaQueue = { add: vi.fn() };
  prisma.channel.findUnique.mockResolvedValue({
    evolutionInstanceName: 'picoa-x',
    botId: 'bot1',
  } as never);
  prisma.contact.findMany.mockResolvedValue([]);
  prisma.conversation.upsert.mockResolvedValue({ id: 'c1' } as never);
  prisma.message.create.mockResolvedValue({ id: 'm1', media: null } as never);
  prisma.message.findUnique.mockResolvedValue(null);
  prisma.conversation.update.mockResolvedValue({} as never);
  const links = mockDeep<OptInLinkService>();
  links.matchInbound.mockResolvedValue(null);
  const svc = new ChatIngestService(
    prisma,
    mockDeep<WhatsappProvidersService>(),
    mockDeep<ChatEventsService>(),
    redis as never,
    mediaQueue as never,
    botQueue as never,
    mockDeep<ConsentService>(),
    links,
  );
  return { svc, prisma, redis, botQueue, mediaQueue };
}

const msg = (over: Partial<InboundChatMessage> = {}): InboundChatMessage => ({
  providerMessageId: 'WA-P1',
  remoteJid: '5592991110001@s.whatsapp.net',
  phoneE164: '+5592991110001',
  isGroup: false,
  fromMe: false,
  pushName: 'Ze',
  kind: 'TEXT',
  text: 'oi',
  transcript: null,
  receivedAt: new Date(),
  ...over,
});

describe('K3-7(c) sem loop: mensagem enviada nunca gera resposta do robô', () => {
  it('K3-7(c): eco fromMe — não enfileira', async () => {
    const { svc, prisma, botQueue } = make();
    // Trava `isInbound &&` de chat-ingest.service.ts:787: sem ela o eco (que o robô/atendente/equipe/celular
    // acabou de mandar) dispararia outra resposta, para sempre.
    const persisted = await svc.ingestMessages(
      [msg({ fromMe: true, providerMessageId: 'WA-ECHO' })],
      'i1',
    );
    expect(persisted).toBe(1);
    expect(prisma.message.create.mock.calls[0]?.[0]).toMatchObject({
      data: { direction: 'OUTBOUND' },
    });
    expect(botQueue.add).not.toHaveBeenCalled();
  });
});

describe('K3-7(c) sem loop: cada mensagem recebida gera no máximo uma resposta', () => {
  it('K3-7(c): mesmo providerMessageId duas vezes (chave Redis) — um enqueue com jobId = message.id', async () => {
    const { svc, prisma, botQueue } = make();
    // Trava a chave `chat:inbound:<id>` (`redis.get` em :485 e `redis.set` em :804): sem uma delas a segunda
    // entrega regravaria e enfileiraria de novo (aqui não há BullMQ para deduplicar o jobId).
    const first = await svc.ingestMessages([msg()], 'i1');
    const second = await svc.ingestMessages([msg()], 'i1');
    expect([first, second]).toEqual([1, 0]);
    expect(prisma.message.create.mock.calls).toHaveLength(1);
    expect(botQueue.add).toHaveBeenCalledTimes(1);
    expect(botQueue.add).toHaveBeenCalledWith(...REPLY_ARGS);
  });

  it('K3-7(c): reentrega que cai no P2002 — não enfileira (limite declarado: nunca duplica)', async () => {
    const { svc, prisma, redis, botQueue } = make();
    // DT8: o enqueue (:788) vem ANTES da chave Redis (:804). Fila fora do ar: a 1ª entrega estoura sem chave;
    // a reentrega cai no P2002 (:770) e devolve antes do enqueue — a mensagem fica sem resposta, nunca em dobro.
    botQueue.add.mockRejectedValueOnce(new Error('fila indisponível'));
    await expect(svc.ingestMessages([msg()], 'i1')).rejects.toThrow(
      'fila indisponível',
    );
    expect(redis.set).not.toHaveBeenCalled();
    prisma.message.create.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('duplicada', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );
    await expect(svc.ingestMessages([msg()], 'i1')).resolves.toBe(0);
    expect(botQueue.add).toHaveBeenCalledTimes(1);
    expect(redis.set).toHaveBeenCalledWith(
      'chat:inbound:WA-P1',
      '1',
      'EX',
      72 * 3600,
    );
  });
});

describe('K3-7(d) o robô não inicia conversa: histórico importado não gera resposta', () => {
  it('K3-7(d): backfill de texto — não enfileira', async () => {
    const { svc, prisma, botQueue } = make();
    // Trava `!backfill` de chat-ingest.service.ts:787: o sync do Zernio relê dias de conversa de uma vez.
    const persisted = await svc.ingestMessages([msg()], 'i1', {
      backfill: true,
    });
    expect(persisted).toBe(1);
    expect(prisma.message.create.mock.calls).toHaveLength(1);
    expect(botQueue.add).not.toHaveBeenCalled();
  });
});

describe('K3-7(d) o robô não inicia conversa: marca de importado no download', () => {
  it('ingest com backfill enfileira o download com imported: true; ao vivo, sem imported true', async () => {
    const { svc, prisma, mediaQueue } = make();
    prisma.message.create.mockResolvedValue({
      id: 'm1',
      media: { id: 'mm1' },
    } as never);
    const image = (id: string) =>
      msg({
        providerMessageId: id,
        kind: 'IMAGE',
        text: undefined,
        media: { mimeType: 'image/jpeg' },
      });
    await svc.ingestMessages([image('WA-LIVE')], 'i1');
    await svc.ingestMessages([image('WA-OLD')], 'i1', { backfill: true });
    const calls = mediaQueue.add.mock.calls as [string, ChatMediaDownloadJob][];
    const [live, imported] = calls.map(([, payload]) => payload);
    expect(mediaQueue.add).toHaveBeenCalledTimes(2);
    expect(live).not.toMatchObject({ imported: true });
    expect(imported).toMatchObject({ imported: true });
  });
});
