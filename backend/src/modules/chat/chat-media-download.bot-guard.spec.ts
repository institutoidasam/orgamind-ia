import { describe, it, expect, vi } from 'vitest';
import { mockDeep } from 'vitest-mock-extended';
import type { Job } from 'bullmq';
import { ChatMediaDownloadProcessor } from './chat-media-download.processor';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { WhatsappProvidersService } from '../whatsapp-providers/whatsapp-providers.service';
import { TwilioMediaService } from '../whatsapp-providers/twilio-media.service';
import { ChatEventsService } from './chat-events.service';
import type { MediaStore } from '../../shared/media/media-store.port';
import type { ChatMediaDownloadJob } from '../queue/queue.constants';

const mediaJob = (fromMe: boolean, over: Partial<ChatMediaDownloadJob> = {}) =>
  ({
    data: {
      messageMediaId: 'mm1',
      messageId: 'm1',
      conversationId: 'c1',
      instanceId: 'i1',
      evolutionInstanceName: 'orgamind',
      providerMessageId: 'WA1',
      remoteJid: '55@s.whatsapp.net',
      kind: 'IMAGE',
      mimeType: 'image/jpeg',
      fromMe,
      ...over,
    } satisfies ChatMediaDownloadJob,
    attemptsMade: 0,
    opts: { attempts: 3 },
  }) as unknown as Job<ChatMediaDownloadJob>;

/** Processor com a Evolution devolvendo a imagem e o canal COM robô; a mensagem foi recebida há `ageMs`. */
function setup(ageMs: number) {
  const prisma = mockDeep<PrismaService>();
  const wa = mockDeep<WhatsappProvidersService>();
  const botAdd = vi.fn();
  const proc = new ChatMediaDownloadProcessor(
    prisma,
    wa,
    mockDeep<TwilioMediaService>(),
    mockDeep<ChatEventsService>(),
    mockDeep<MediaStore>(),
    { add: botAdd } as never,
  );
  wa.getMediaBase64.mockResolvedValue({
    base64: Buffer.from('img').toString('base64'),
    mimeType: 'image/jpeg',
  });
  prisma.messageMedia.update.mockResolvedValue({} as never);
  prisma.message.findUnique.mockResolvedValue({
    receivedAt: new Date(Date.now() - ageMs),
  } as never);
  prisma.channel.findUnique.mockResolvedValue({ botId: 'b1' } as never);
  return { proc, prisma, botAdd };
}

describe('K3-7(c) sem loop: mídia enviada não gera resposta do robô', () => {
  it('K3-7(c): mídia fromMe — não enfileira', async () => {
    // Mensagem de AGORA e canal COM robô: o controle positivo (fromMe false) é o teste vizinho "enqueues a bot
    // reply for live (recent) inbound media". Só `!d.fromMe` (chat-media-download.processor.ts) separa os dois.
    const { proc, prisma, botAdd } = setup(0);
    await proc.process(mediaJob(true));
    expect(prisma.messageMedia.update.mock.calls[0]?.[0]).toMatchObject({
      data: { status: 'READY' },
    });
    expect(botAdd).not.toHaveBeenCalled();
  });
});

describe('K3-7(d) o robô não inicia conversa: mídia importada', () => {
  it('mídia importada recente (imported: true, recebida há 1 min, canal com robô) — não enfileira bot.reply', async () => {
    const { proc, prisma, botAdd } = setup(60_000);
    await proc.process(mediaJob(false, { imported: true }));
    // Baixou e gravou (READY): só a resposta do robô é barrada pela marca, não pela idade.
    expect(prisma.messageMedia.update.mock.calls[0]?.[0]).toMatchObject({
      data: { status: 'READY' },
    });
    expect(botAdd).not.toHaveBeenCalled();
  });

  it('mídia ao vivo recente sem a marca — enfileira bot.reply uma vez, jobId = messageId', async () => {
    const { proc, botAdd } = setup(60_000);
    await proc.process(mediaJob(false));
    expect(botAdd).toHaveBeenCalledTimes(1);
    expect(botAdd).toHaveBeenCalledWith(
      'reply',
      { conversationId: 'c1', messageId: 'm1' },
      { jobId: 'm1' },
    );
  });
});
