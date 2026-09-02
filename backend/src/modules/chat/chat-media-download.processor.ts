import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import type { Job } from 'bullmq';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { WhatsappProvidersService } from '../whatsapp-providers/whatsapp-providers.service';
import { TwilioMediaService } from '../whatsapp-providers/twilio-media.service';
import { ChatEventsService } from './chat-events.service';
import { MEDIA_STORE, type MediaStore } from '../../shared/media/media-store.port';
import { QUEUE_NAMES, type ChatMediaDownloadJob, type BotReplyJob } from '../queue/queue.constants';

const MAX_MEDIA_BYTES = 64 * 1024 * 1024; // 64 MB stored cap

// A bot auto-reply only fires for media received within this window. The media
// processor is shared by the bulk history import, which re-enqueues downloads
// for weeks-old messages on every reconnect; without this guard the bot would
// blast unsolicited replies to every historical image/voice note.
const BOT_REPLY_MAX_AGE_MS = 5 * 60 * 1000; // 5 min

const EXT: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'video/mp4': 'mp4',
  'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'application/pdf': 'pdf',
};

@Processor(QUEUE_NAMES.CHAT_MEDIA_DOWNLOAD, { concurrency: 4 })
export class ChatMediaDownloadProcessor extends WorkerHost {
  private readonly logger = new Logger(ChatMediaDownloadProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly wa: WhatsappProvidersService,
    private readonly twilioMedia: TwilioMediaService,
    private readonly events: ChatEventsService,
    @Inject(MEDIA_STORE) private readonly store: MediaStore,
    @InjectQueue(QUEUE_NAMES.BOT_REPLY) private readonly botQueue: Queue<BotReplyJob>,
  ) { super(); }

  /**
   * Fetch the raw media bytes. Twilio media rides an authenticated URL on the
   * job (`mediaUrl`); Evolution media is fetched by message key. Both funnel
   * into the SAME store/MessageMedia persistence below, so the UI renders
   * media without knowing the provider.
   */
  private async fetchMedia(d: ChatMediaDownloadJob): Promise<{ buffer: Buffer; mimeType: string | null }> {
    if (d.mediaUrl) return this.twilioMedia.download(d.mediaUrl);
    const dl = await this.wa.getMediaBase64(d.evolutionInstanceName, { id: d.providerMessageId, remoteJid: d.remoteJid, fromMe: d.fromMe });
    return { buffer: Buffer.from(dl.base64, 'base64'), mimeType: dl.mimeType ?? null };
  }

  async process(job: Job<ChatMediaDownloadJob>): Promise<void> {
    const d = job.data;
    // Scope the retry-driving try/catch to the download + store + READY write
    // only. Post-store side effects (events.publish / botQueue.add) run after
    // and MUST NOT be able to regress an already-stored READY row to FAILED.
    try {
      const { buffer, mimeType } = await this.fetchMedia(d);
      if (buffer.length > MAX_MEDIA_BYTES) {
        this.logger.warn({ messageMediaId: d.messageMediaId, size: buffer.length }, 'media exceeds size cap, marking FAILED');
        await this.prisma.messageMedia.update({
          where: { id: d.messageMediaId },
          data: { status: 'FAILED', failureReason: `media too large (${buffer.length} bytes)` },
        });
        return;
      }
      const ext = EXT[(d.mimeType ?? mimeType ?? '').split(';')[0]] ?? 'bin';
      const key = `conv/${d.conversationId}/${d.messageId}.${ext}`;
      await this.store.put(key, buffer);
      await this.prisma.messageMedia.update({
        where: { id: d.messageMediaId },
        data: { status: 'READY', storageKey: key, mimeType: mimeType ?? d.mimeType, sizeBytes: buffer.length },
      });
    } catch (err) {
      this.logger.warn({ err, messageMediaId: d.messageMediaId }, 'media download failed');
      await this.prisma.messageMedia.update({
        where: { id: d.messageMediaId },
        data: { status: 'FAILED', failureReason: (err instanceof Error ? err.message : String(err)).slice(0, 300) },
      });
      // Rethrow only while attempts remain, so BullMQ retries; on the last
      // attempt we've already recorded FAILED, so swallow.
      if ((job.attemptsMade ?? 0) + 1 < (job.opts.attempts ?? 1)) throw err;
      return;
    }

    // Best-effort side effects: the media is already stored + READY, so a
    // transient failure here (Redis hiccup, etc.) must not fail the job.
    try {
      await this.events.publish({ type: 'media.ready', conversationId: d.conversationId, instanceId: d.instanceId, messageId: d.messageId });
      // Auto-resposta para mídia suportada (imagem/áudio) recebida de contatos.
      // Só dispara para mensagens recentes ("ao vivo"): o mesmo processor é usado
      // pelo history sync, que reenfileira mídia antiga a cada reconexão — sem
      // este guard o bot responderia mensagens de semanas atrás.
      if (!d.fromMe && (d.kind === 'IMAGE' || d.kind === 'AUDIO')) {
        const msg = await this.prisma.message.findUnique({ where: { id: d.messageId }, select: { receivedAt: true } });
        const receivedAt = msg?.receivedAt;
        const isLive = !!receivedAt && Date.now() - receivedAt.getTime() < BOT_REPLY_MAX_AGE_MS;
        if (isLive) {
          const inst = await this.prisma.channel.findUnique({ where: { id: d.instanceId }, select: { botId: true } });
          if (inst?.botId) {
            await this.botQueue.add('reply', { conversationId: d.conversationId, messageId: d.messageId }, { jobId: d.messageId });
          }
        }
      }
    } catch (err) {
      this.logger.warn({ err, messageMediaId: d.messageMediaId }, 'media post-store side effect failed');
    }
  }
}
