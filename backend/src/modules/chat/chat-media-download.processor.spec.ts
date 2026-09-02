import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockDeep, type MockProxy } from 'vitest-mock-extended';
import type { Job } from 'bullmq';
import { ChatMediaDownloadProcessor } from './chat-media-download.processor';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { WhatsappProvidersService } from '../whatsapp-providers/whatsapp-providers.service';
import { TwilioMediaService } from '../whatsapp-providers/twilio-media.service';
import { ChatEventsService } from './chat-events.service';
import type { MediaStore } from '../../shared/media/media-store.port';
import type { ChatMediaDownloadJob } from '../queue/queue.constants';

const jobData: ChatMediaDownloadJob = {
  messageMediaId: 'mm1', messageId: 'm1', conversationId: 'c1', instanceId: 'i1',
  evolutionInstanceName: 'orgamind', providerMessageId: 'WA1', remoteJid: '55@s.whatsapp.net', kind: 'IMAGE', mimeType: 'image/jpeg', fromMe: false,
};
const makeJob = (data: ChatMediaDownloadJob) => ({ data, attemptsMade: 0, opts: { attempts: 3 } }) as unknown as Job<ChatMediaDownloadJob>;

describe('ChatMediaDownloadProcessor', () => {
  let prisma: MockProxy<PrismaService>; let wa: MockProxy<WhatsappProvidersService>;
  let twilioMedia: MockProxy<TwilioMediaService>;
  let events: MockProxy<ChatEventsService>; let store: MockProxy<MediaStore>;
  let botAdd: ReturnType<typeof vi.fn>;
  let proc: ChatMediaDownloadProcessor;
  beforeEach(() => {
    prisma = mockDeep<PrismaService>(); wa = mockDeep<WhatsappProvidersService>();
    twilioMedia = mockDeep<TwilioMediaService>();
    events = mockDeep<ChatEventsService>(); store = mockDeep<MediaStore>();
    botAdd = vi.fn();
    const botQueue = { add: botAdd } as never;
    proc = new ChatMediaDownloadProcessor(prisma, wa, twilioMedia, events, store, botQueue);
    prisma.messageMedia.update.mockResolvedValue({} as never);
  });

  it('downloads, stores, marks READY, publishes media.ready', async () => {
    wa.getMediaBase64.mockResolvedValue({ base64: Buffer.from('img').toString('base64'), mimeType: 'image/jpeg' } as never);
    await proc.process(makeJob(jobData));
    expect(wa.getMediaBase64).toHaveBeenCalledWith('orgamind', { id: 'WA1', remoteJid: '55@s.whatsapp.net', fromMe: false });
    expect(store.put).toHaveBeenCalledWith(expect.stringContaining('c1/m1'), expect.any(Buffer));
    expect(prisma.messageMedia.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'mm1' }, data: expect.objectContaining({ status: 'READY' }) }));
    expect(events.publish).toHaveBeenCalledWith(expect.objectContaining({ type: 'media.ready', conversationId: 'c1', messageId: 'm1' }));
  });

  it('marks FAILED on download error (last attempt does not rethrow)', async () => {
    wa.getMediaBase64.mockRejectedValue(new Error('cdn expired'));
    await proc.process({ data: jobData, attemptsMade: 2, opts: { attempts: 3 } } as unknown as Job<ChatMediaDownloadJob>);
    expect(prisma.messageMedia.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'mm1' }, data: expect.objectContaining({ status: 'FAILED' }) }));
  });

  // Retry guard must rethrow while attempts remain so BullMQ retries the
  // transient failure. This only works when the queue's defaultJobOptions keep
  // attempts > 1 (regression for the "bare registerQueue" shadowing finding):
  // a first-attempt failure on a 3-attempt queue MUST rethrow.
  it('rethrows on a non-final attempt so BullMQ retries (attempts=3)', async () => {
    wa.getMediaBase64.mockRejectedValue(new Error('transient cdn 503'));
    await expect(
      proc.process({ data: jobData, attemptsMade: 0, opts: { attempts: 3 } } as unknown as Job<ChatMediaDownloadJob>),
    ).rejects.toThrow('transient cdn 503');
  });

  // The bug: if the queue config is shadowed to attempts=1, the guard
  // (attemptsMade + 1 < attempts) is false on the first try → never retries.
  it('does NOT rethrow when attempts is 1 (documents the shadowing failure mode)', async () => {
    wa.getMediaBase64.mockRejectedValue(new Error('transient cdn 503'));
    await expect(
      proc.process({ data: jobData, attemptsMade: 0, opts: { attempts: 1 } } as unknown as Job<ChatMediaDownloadJob>),
    ).resolves.toBeUndefined();
  });

  // Bug #1: history-imported (old) inbound media must NOT trigger a bot auto-reply.
  // The media processor is shared by the bulk history import, so gating the bot
  // enqueue on message recency prevents the bot answering weeks-old messages on
  // every reconnect.
  it('does NOT enqueue a bot reply for history-imported (old) inbound media', async () => {
    wa.getMediaBase64.mockResolvedValue({ base64: Buffer.from('img').toString('base64'), mimeType: 'image/jpeg' } as never);
    // Message received 30 days ago (imported), instance has a bot assigned.
    prisma.message.findUnique.mockResolvedValue({ receivedAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) } as never);
    prisma.channel.findUnique.mockResolvedValue({ botId: 'b1' } as never);
    await proc.process(makeJob(jobData));
    expect(prisma.messageMedia.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'READY' }) }));
    expect(botAdd).not.toHaveBeenCalled();
  });

  it('enqueues a bot reply for live (recent) inbound media when a bot is assigned', async () => {
    wa.getMediaBase64.mockResolvedValue({ base64: Buffer.from('img').toString('base64'), mimeType: 'image/jpeg' } as never);
    prisma.message.findUnique.mockResolvedValue({ receivedAt: new Date() } as never);
    prisma.channel.findUnique.mockResolvedValue({ botId: 'b1' } as never);
    await proc.process(makeJob(jobData));
    expect(botAdd).toHaveBeenCalledWith('reply', { conversationId: 'c1', messageId: 'm1' }, { jobId: 'm1' });
  });

  // Bug #2: a failure in a post-store side effect (events.publish / botQueue.add)
  // must NOT regress an already-stored, READY row back to FAILED.
  it('keeps media READY when a post-store side effect throws (does not flip to FAILED)', async () => {
    wa.getMediaBase64.mockResolvedValue({ base64: Buffer.from('img').toString('base64'), mimeType: 'image/jpeg' } as never);
    events.publish.mockRejectedValue(new Error('redis hiccup'));
    // First attempt of 3 — a genuine download failure here would rethrow.
    await expect(proc.process({ data: jobData, attemptsMade: 0, opts: { attempts: 3 } } as unknown as Job<ChatMediaDownloadJob>)).resolves.toBeUndefined();
    expect(store.put).toHaveBeenCalled();
    expect(prisma.messageMedia.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'READY' }) }));
    expect(prisma.messageMedia.update).not.toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'FAILED' }) }));
  });

  it('marks FAILED and does not store when media exceeds the size cap', async () => {
    const huge = Buffer.alloc(64 * 1024 * 1024 + 1).toString('base64');
    wa.getMediaBase64.mockResolvedValue({ base64: huge, mimeType: 'image/jpeg' } as never);
    await proc.process(makeJob(jobData));
    expect(store.put).not.toHaveBeenCalled();
    expect(prisma.messageMedia.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'mm1' }, data: expect.objectContaining({ status: 'FAILED' }) }));
  });

  // T6 (twilio-platform): mídia inbound Twilio chega com uma mediaUrl no job e é
  // baixada via TwilioMediaService (Basic Auth + redirect) — MESMO storage e
  // registro (MessageMedia) do fluxo Evolution, então a UI não vê diferença.
  describe('Twilio media (job com mediaUrl)', () => {
    const twilioJob: ChatMediaDownloadJob = {
      ...jobData,
      evolutionInstanceName: '',
      providerMessageId: 'MM1',
      mediaUrl: 'https://api.twilio.com/2010-04-01/Accounts/AC0/Messages/MM1/Media/ME1',
    };

    it('baixa via TwilioMediaService, persiste no mesmo storage e marca READY', async () => {
      twilioMedia.download.mockResolvedValue({ buffer: Buffer.from('tw-img'), mimeType: 'image/jpeg' });
      await proc.process(makeJob(twilioJob));
      expect(twilioMedia.download).toHaveBeenCalledWith(twilioJob.mediaUrl);
      expect(wa.getMediaBase64).not.toHaveBeenCalled();
      expect(store.put).toHaveBeenCalledWith(expect.stringContaining('c1/m1'), expect.any(Buffer));
      expect(prisma.messageMedia.update).toHaveBeenCalledWith(expect.objectContaining({
        where: { id: 'mm1' },
        data: expect.objectContaining({ status: 'READY', mimeType: 'image/jpeg' }),
      }));
      expect(events.publish).toHaveBeenCalledWith(expect.objectContaining({ type: 'media.ready' }));
    });

    it('marca FAILED quando o download da Twilio falha (última tentativa)', async () => {
      twilioMedia.download.mockRejectedValue(new Error('twilio 401'));
      await proc.process({ data: twilioJob, attemptsMade: 2, opts: { attempts: 3 } } as unknown as Job<ChatMediaDownloadJob>);
      expect(prisma.messageMedia.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'mm1' }, data: expect.objectContaining({ status: 'FAILED' }) }));
    });

    it('aplica o mesmo teto de tamanho ao download da Twilio', async () => {
      twilioMedia.download.mockResolvedValue({ buffer: Buffer.alloc(64 * 1024 * 1024 + 1), mimeType: 'video/mp4' });
      await proc.process(makeJob(twilioJob));
      expect(store.put).not.toHaveBeenCalled();
      expect(prisma.messageMedia.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'mm1' }, data: expect.objectContaining({ status: 'FAILED' }) }));
    });
  });
});
