import { describe, it, expect, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import { mockDeep, type DeepMockProxy } from 'vitest-mock-extended';
import { ChatHistorySyncService } from './chat-history-sync.service';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { WhatsappProvidersService } from '../whatsapp-providers/whatsapp-providers.service';
import { QUEUE_NAMES } from '../queue/queue.constants';

const JID = '5592991110001@s.whatsapp.net';
/** Histórico com receivedAt de AGORA: só a ausência do robô no sync impede a resposta. */
const HISTORY = [
  { providerMessageId: 'H-TEXT', fromMe: false, kind: 'TEXT', text: 'oi' },
  {
    providerMessageId: 'H-IMG',
    fromMe: false,
    kind: 'IMAGE',
    media: { mimeType: 'image/jpeg' },
  },
  { providerMessageId: 'H-OUT', fromMe: true, kind: 'TEXT', text: 'olá' },
].map((m) => ({
  ...m,
  remoteJid: JID,
  phoneE164: '+5592991110001',
  isGroup: false,
  receivedAt: new Date(),
}));

/** Um chat Evolution com as três mensagens acima; o banco aceita todas como novas. */
function stubHistory(
  prisma: DeepMockProxy<PrismaService>,
  wa: DeepMockProxy<WhatsappProvidersService>,
) {
  prisma.channel.findUnique.mockResolvedValue({
    evolutionInstanceName: 'orgamind',
    provider: 'EVOLUTION',
  } as never);
  prisma.contact.findMany.mockResolvedValue([] as never);
  prisma.conversation.upsert.mockResolvedValue({
    id: 'c1',
    lastMessageAt: null,
  } as never);
  prisma.conversation.update.mockResolvedValue({} as never);
  prisma.message.findMany.mockResolvedValue([] as never);
  prisma.message.create.mockImplementation((({
    data,
  }: {
    data: { providerMessageId: string; media?: unknown };
  }) =>
    Promise.resolve({
      id: `m-${data.providerMessageId}`,
      media: data.media ? { id: 'mm1' } : null,
    })) as never);
  wa.findChats.mockResolvedValue([
    { remoteJid: JID, name: 'Maria', profilePicUrl: null, unreadCount: 0 },
  ] as never);
  wa.findMessages.mockResolvedValue({
    records: HISTORY.map((m) => ({ key: { id: m.providerMessageId } })),
    total: 3,
    pages: 1,
    currentPage: 1,
  });
  wa.parseInboundChatMessages.mockImplementation(((p: {
    data: { key: { id: string } };
  }) => [HISTORY.find((m) => m.providerMessageId === p.data.key.id)]) as never);
}

/** Prisma/WhatsApp falsos + as DUAS filas como espiãs registradas no módulo de teste. */
async function compile() {
  const prisma = mockDeep<PrismaService>();
  const wa = mockDeep<WhatsappProvidersService>();
  const mediaQueue = { add: vi.fn() };
  const botQueue = { add: vi.fn() };
  const moduleRef = await Test.createTestingModule({
    providers: [
      ChatHistorySyncService,
      { provide: PrismaService, useValue: prisma },
      { provide: WhatsappProvidersService, useValue: wa },
      {
        provide: getQueueToken(QUEUE_NAMES.CHAT_MEDIA_DOWNLOAD),
        useValue: mediaQueue,
      },
      { provide: getQueueToken(QUEUE_NAMES.BOT_REPLY), useValue: botQueue },
    ],
  }).compile();
  stubHistory(prisma, wa);
  return {
    svc: moduleRef.get(ChatHistorySyncService),
    moduleRef,
    mediaQueue,
    botQueue,
  };
}

describe('K3-7(d) o robô não inicia conversa: histórico importado do Evolution', () => {
  it('K3-7(d): histórico Evolution importado — nenhum job bot.reply', async () => {
    const { svc, moduleRef, mediaQueue, botQueue } = await compile();
    const res = await svc.syncInstance('i1');
    // Importou de verdade (texto recebido, imagem recebida e texto enviado) e a mídia foi para o download;
    // a resposta do robô a ela é decidida no processor, que só aceita mensagem recente (teste do processor).
    expect(res.messages).toBe(3);
    expect(mediaQueue.add).toHaveBeenCalledTimes(1);
    expect(mediaQueue.add).toHaveBeenCalledWith(
      'download',
      expect.objectContaining({ messageId: 'm-H-IMG', fromMe: false }),
    );
    // Se o sync passar a injetar `bot.reply` e enfileirar, a espiã registrada acusa.
    expect(botQueue.add).not.toHaveBeenCalled();
    await moduleRef.close();
  });
});

describe('K3-7(d) o robô não inicia conversa: marca de importado no download', () => {
  it('sync de histórico enfileira o download com imported: true', async () => {
    const { svc, moduleRef, mediaQueue } = await compile();
    await svc.syncInstance('i1');
    // O processor só barra o robô por esta marca (a idade sozinha deixa passar histórico com menos de 5 min).
    expect(mediaQueue.add).toHaveBeenCalledWith(
      'download',
      expect.objectContaining({ messageId: 'm-H-IMG', imported: true }),
    );
    await moduleRef.close();
  });
});
