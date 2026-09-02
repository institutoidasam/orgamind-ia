import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { NotFoundError, ConflictError, ChannelNotEvolutionError } from '../../shared/errors/domain.error';
import { MEDIA_STORE, type MediaStore } from '../../shared/media/media-store.port';
import { ChatRepository } from './chat.repository';
import { ChatEventsService } from './chat-events.service';
import { WhatsappProvidersService } from '../whatsapp-providers/whatsapp-providers.service';

@Injectable()
export class ChatMediaService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(MEDIA_STORE) private readonly store: MediaStore,
    private readonly repo: ChatRepository,
    private readonly events: ChatEventsService,
    private readonly wa: WhatsappProvidersService,
  ) {}

  async getReadyMedia(mediaId: string): Promise<{ stream: Readable; mimeType: string; fileName: string | null }> {
    const media = await this.prisma.messageMedia.findUnique({ where: { id: mediaId } });
    if (!media) throw new NotFoundError('Media', mediaId);
    if (media.status !== 'READY' || !media.storageKey) throw new ConflictError('Media not ready', 'media.not_ready');
    const stream = await this.store.getStream(media.storageKey);
    return { stream, mimeType: media.mimeType ?? 'application/octet-stream', fileName: media.fileName };
  }

  private mediatypeFor(mime: string): 'image' | 'video' | 'document' | 'audio' {
    if (mime.startsWith('image/')) return 'image';
    if (mime.startsWith('video/')) return 'video';
    if (mime.startsWith('audio/')) return 'audio';
    return 'document';
  }

  private kindFor(mt: 'image' | 'video' | 'document' | 'audio'): 'IMAGE' | 'VIDEO' | 'AUDIO' | 'DOCUMENT' {
    return mt === 'image' ? 'IMAGE' : mt === 'video' ? 'VIDEO' : mt === 'audio' ? 'AUDIO' : 'DOCUMENT';
  }

  async sendMediaReply(conversationId: string, userId: string, file: Express.Multer.File, caption?: string) {
    const conv = await this.repo.getConversationForSend(conversationId);
    if (!conv) throw new NotFoundError('Conversation', conversationId);
    const cappedCaption = caption?.slice(0, 4096);
    const mt = this.mediatypeFor(file.mimetype);
    const kind = this.kindFor(mt);
    const ext = (file.originalname.split('.').pop() ?? 'bin').toLowerCase().slice(0, 5);
    // Unique key (uuid) so two same-ms / same-size uploads never collide and
    // overwrite each other — mirrors the inbound path which keys by message id.
    const storageKey = `conv/${conversationId}/out-${randomUUID()}.${ext}`;
    await this.store.put(storageKey, file.buffer);
    // A WhatsApp voice note (sendWhatsAppAudio) cannot carry a caption, so we
    // never deliver one for audio. Don't persist it either, or the UI would show
    // a caption the recipient never received.
    const persistedCaption = mt === 'audio' ? null : (cappedCaption ?? null);
    const messageId = await this.repo.createOutboundMediaMessage({
      conversationId, instanceId: conv.instanceId, contactId: conv.contactId, authorUserId: userId,
      kind, content: persistedCaption, mimeType: file.mimetype, fileName: file.originalname, sizeBytes: file.size, storageKey,
    });
    let sent = false;
    try {
      const base64 = file.buffer.toString('base64');
      // Real phone when known, else the remoteJid JID (unresolved @lid).
      const target = conv.phoneE164 ?? conv.remoteJid;
      if (!conv.instance.evolutionInstanceName) throw new ChannelNotEvolutionError(conv.instanceId);
      const instanceName = conv.instance.evolutionInstanceName;
      const result = mt === 'audio'
        ? await this.wa.sendWhatsAppAudio({ instanceName, toE164: target, audioBase64: base64 })
        : await this.wa.sendMedia({ instanceName, toE164: target, mediatype: mt as 'image' | 'video' | 'document', mimetype: file.mimetype, mediaBase64: base64, fileName: file.originalname, caption: cappedCaption });
      await this.repo.markChatSent(messageId, conv.instanceId, result.providerMessageId, result.acceptedAt);
      sent = true;
    } catch (err) {
      await this.repo.markChatFailed(messageId, err instanceof Error ? err.message : String(err));
    }
    await this.events.publish({ type: 'message.created', conversationId, instanceId: conv.instanceId, messageId });
    if (sent) {
      await this.repo.touchConversationOutbound(conversationId, persistedCaption || `[${kind.toLowerCase()}]`);
    }
    const saved = await this.repo.getMessageById(messageId);
    if (!saved) throw new NotFoundError('Message', messageId);
    return saved;
  }
}
