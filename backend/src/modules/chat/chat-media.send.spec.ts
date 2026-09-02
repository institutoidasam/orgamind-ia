import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockDeep, type MockProxy } from 'vitest-mock-extended';
import { ChatMediaService } from './chat-media.service';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { ChatRepository } from './chat.repository';
import { ChatEventsService } from './chat-events.service';
import { WhatsappProvidersService } from '../whatsapp-providers/whatsapp-providers.service';
import type { MediaStore } from '../../shared/media/media-store.port';

const conv = { id: 'c1', instanceId: 'i1', phoneE164: '+5592', remoteJid: '55@s.whatsapp.net', contactId: null, unreadCount: 0, instance: { id: 'i1', evolutionInstanceName: 'picoa' } };

describe('ChatMediaService.sendMediaReply', () => {
  let prisma: MockProxy<PrismaService>; let store: MockProxy<MediaStore>; let repo: MockProxy<ChatRepository>;
  let events: MockProxy<ChatEventsService>; let wa: MockProxy<WhatsappProvidersService>; let svc: ChatMediaService;
  beforeEach(() => {
    prisma = mockDeep<PrismaService>(); store = mockDeep<MediaStore>(); repo = mockDeep<ChatRepository>();
    events = mockDeep<ChatEventsService>(); wa = mockDeep<WhatsappProvidersService>();
    svc = new ChatMediaService(prisma, store, repo, events, wa);
    repo.getConversationForSend.mockResolvedValue(conv as never);
    repo.createOutboundMediaMessage.mockResolvedValue('m1');
    repo.getMessageById.mockResolvedValue({ id: 'm1', status: 'SENT', kind: 'IMAGE' } as never);
  });

  it('stores the upload, sends image via provider, marks SENT', async () => {
    wa.sendMedia.mockResolvedValue({ providerMessageId: 'WA9', acceptedAt: new Date() } as never);
    const file = { buffer: Buffer.from('img'), originalname: 'a.png', mimetype: 'image/png', size: 3 } as Express.Multer.File;
    const out = await svc.sendMediaReply('c1', 'u1', file, 'legenda');
    expect(store.put).toHaveBeenCalledWith(expect.stringContaining('c1/'), expect.any(Buffer));
    expect(wa.sendMedia).toHaveBeenCalledWith(expect.objectContaining({ instanceName: 'picoa', toE164: '+5592', mediatype: 'image', mimetype: 'image/png', caption: 'legenda' }));
    expect(repo.markChatSent).toHaveBeenCalled();
    expect(out.status).toBe('SENT');
  });

  it('uses sendWhatsAppAudio for audio mime', async () => {
    wa.sendWhatsAppAudio.mockResolvedValue({ providerMessageId: 'WA10', acceptedAt: new Date() } as never);
    const file = { buffer: Buffer.from('aud'), originalname: 'v.ogg', mimetype: 'audio/ogg', size: 3 } as Express.Multer.File;
    await svc.sendMediaReply('c1', 'u1', file);
    expect(wa.sendWhatsAppAudio).toHaveBeenCalledWith(expect.objectContaining({ instanceName: 'picoa', toE164: '+5592' }));
  });

  // audio caption (Baixo › Chat/Inbox): a WhatsApp voice note cannot carry a
  // caption, so an audio caption is never delivered. It must NOT be persisted to
  // `content` (else the UI shows a caption the recipient never received).
  it('strips the caption when sending audio (voice notes cannot carry a caption)', async () => {
    wa.sendWhatsAppAudio.mockResolvedValue({ providerMessageId: 'WA10', acceptedAt: new Date() } as never);
    const file = { buffer: Buffer.from('aud'), originalname: 'v.ogg', mimetype: 'audio/ogg', size: 3 } as Express.Multer.File;
    await svc.sendMediaReply('c1', 'u1', file, 'legenda do audio');
    expect(repo.createOutboundMediaMessage).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'AUDIO', content: null }),
    );
  });

  it('keeps the caption for non-audio media (image)', async () => {
    wa.sendMedia.mockResolvedValue({ providerMessageId: 'WA9', acceptedAt: new Date() } as never);
    const file = { buffer: Buffer.from('img'), originalname: 'a.png', mimetype: 'image/png', size: 3 } as Express.Multer.File;
    await svc.sendMediaReply('c1', 'u1', file, 'legenda');
    expect(repo.createOutboundMediaMessage).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'IMAGE', content: 'legenda' }),
    );
  });

  it('marks FAILED when the provider send throws', async () => {
    wa.sendMedia.mockRejectedValue(new Error('down'));
    repo.getMessageById.mockResolvedValue({ id: 'm1', status: 'FAILED', kind: 'IMAGE' } as never);
    const file = { buffer: Buffer.from('img'), originalname: 'a.png', mimetype: 'image/png', size: 3 } as Express.Multer.File;
    const out = await svc.sendMediaReply('c1', 'u1', file);
    expect(repo.markChatFailed).toHaveBeenCalled();
    expect(repo.touchConversationOutbound).not.toHaveBeenCalled();
    expect(out.status).toBe('FAILED');
  });

  // storageKey collision (Baixo › Chat/Inbox): two same-ms / same-size outbound
  // uploads must NOT produce the same storage key (the second would overwrite
  // the first). A uuid/message id makes it unique, like the inbound path.
  it('generates a unique storageKey even for same-ms / same-size uploads', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-15T00:00:00.000Z')); // freeze Date.now()
    try {
      wa.sendMedia.mockResolvedValue({ providerMessageId: 'WA9', acceptedAt: new Date() } as never);
      const file = () => ({ buffer: Buffer.from('img'), originalname: 'a.png', mimetype: 'image/png', size: 3 }) as Express.Multer.File;
      await svc.sendMediaReply('c1', 'u1', file());
      await svc.sendMediaReply('c1', 'u1', file());
      const key1 = store.put.mock.calls[0][0];
      const key2 = store.put.mock.calls[1][0];
      expect(key1).not.toBe(key2);
      expect(key1).toMatch(/^conv\/c1\//);
    } finally {
      vi.useRealTimers();
    }
  });
});
