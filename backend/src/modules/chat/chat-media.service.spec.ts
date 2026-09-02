import { describe, it, expect, beforeEach } from 'vitest';
import { mockDeep, type MockProxy } from 'vitest-mock-extended';
import { ChatMediaService } from './chat-media.service';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { ChatRepository } from './chat.repository';
import { ChatEventsService } from './chat-events.service';
import { WhatsappProvidersService } from '../whatsapp-providers/whatsapp-providers.service';
import type { MediaStore } from '../../shared/media/media-store.port';
import { NotFoundError, ConflictError } from '../../shared/errors/domain.error';

describe('ChatMediaService.getReadyMedia', () => {
  let prisma: MockProxy<PrismaService>; let store: MockProxy<MediaStore>;
  let repo: MockProxy<ChatRepository>; let events: MockProxy<ChatEventsService>; let wa: MockProxy<WhatsappProvidersService>;
  let svc: ChatMediaService;
  beforeEach(() => {
    prisma = mockDeep<PrismaService>(); store = mockDeep<MediaStore>();
    repo = mockDeep<ChatRepository>(); events = mockDeep<ChatEventsService>(); wa = mockDeep<WhatsappProvidersService>();
    svc = new ChatMediaService(prisma, store, repo, events, wa);
  });

  it('throws NotFound when media row is missing', async () => {
    prisma.messageMedia.findUnique.mockResolvedValue(null as never);
    await expect(svc.getReadyMedia('x')).rejects.toBeInstanceOf(NotFoundError);
  });
  it('throws Conflict when not READY', async () => {
    prisma.messageMedia.findUnique.mockResolvedValue({ id: 'm', status: 'PENDING', storageKey: null, mimeType: null, fileName: null } as never);
    await expect(svc.getReadyMedia('m')).rejects.toBeInstanceOf(ConflictError);
  });
  it('returns stream + content metadata when READY', async () => {
    prisma.messageMedia.findUnique.mockResolvedValue({ id: 'm', status: 'READY', storageKey: 'conv/c/m.jpg', mimeType: 'image/jpeg', fileName: 'x.jpg' } as never);
    store.getStream.mockResolvedValue('STREAM' as never);
    const r = await svc.getReadyMedia('m');
    expect(store.getStream).toHaveBeenCalledWith('conv/c/m.jpg');
    expect(r.mimeType).toBe('image/jpeg');
    expect(r.stream).toBe('STREAM');
  });
});
