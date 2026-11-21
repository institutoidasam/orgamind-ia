import { describe, it, expect, beforeEach } from 'vitest';
import { mockDeep, type MockProxy } from 'vitest-mock-extended';
import { ChatMediaService } from './chat-media.service';
import { ChatRepository } from './chat.repository';
import { ChatEventsService } from './chat-events.service';
import { WhatsappProvidersService } from '../whatsapp-providers/whatsapp-providers.service';
import type { MediaStore } from '../../shared/media/media-store.port';
import { NotFoundError, ConflictError } from '../../shared/errors/domain.error';
import { ChannelProviderDisabledError } from '../../shared/errors/channel-provider-disabled.error';
import { ConversationOwnershipService } from './conversation-ownership.service';

describe('ChatMediaService.getReadyMedia', () => {
  let store: MockProxy<MediaStore>;
  let repo: MockProxy<ChatRepository>; let events: MockProxy<ChatEventsService>; let wa: MockProxy<WhatsappProvidersService>;
  let svc: ChatMediaService;
  beforeEach(() => {
    store = mockDeep<MediaStore>();
    repo = mockDeep<ChatRepository>(); events = mockDeep<ChatEventsService>(); wa = mockDeep<WhatsappProvidersService>();
    svc = new ChatMediaService(
      store,
      repo,
      events,
      wa,
      mockDeep<ConversationOwnershipService>(),
    );
  });

  it('throws NotFound when media row is missing', async () => {
    repo.findMediaById.mockResolvedValue(null);
    await expect(svc.getReadyMedia('x')).rejects.toBeInstanceOf(NotFoundError);
  });
  it('throws Conflict when not READY', async () => {
    repo.findMediaById.mockResolvedValue({
      id: 'm',
      status: 'PENDING',
      storageKey: null,
      mimeType: null,
      fileName: null,
    } as never);
    await expect(svc.getReadyMedia('m')).rejects.toBeInstanceOf(ConflictError);
  });
  it('returns stream + content metadata when READY', async () => {
    repo.findMediaById.mockResolvedValue({
      id: 'm',
      status: 'READY',
      storageKey: 'conv/c/m.jpg',
      mimeType: 'image/jpeg',
      fileName: 'x.jpg',
    } as never);
    store.getStream.mockResolvedValue('STREAM' as never);
    const r = await svc.getReadyMedia('m');
    expect(store.getStream).toHaveBeenCalledWith('conv/c/m.jpg');
    expect(r.mimeType).toBe('image/jpeg');
    expect(r.stream).toBe('STREAM');
  });
});
const file = {
  buffer: Buffer.from('x'),
  mimetype: 'image/png',
  originalname: 'a.png',
  size: 1,
} as Express.Multer.File;

const convOf = (provider: 'GOZAP' | 'EVOLUTION') => ({
  id: 'c1',
  instanceId: 'i1',
  contactId: 'ct1',
  phoneE164: '+5511999990000',
  remoteJid: null,
  instance: {
    id: 'i1',
    provider,
    evolutionInstanceName: provider === 'EVOLUTION' ? 'evo-1' : null,
  },
});

describe('ChatMediaService.sendMediaReply — guard de provedor desligado', () => {
  let store: MockProxy<MediaStore>;
  let repo: MockProxy<ChatRepository>;
  let wa: MockProxy<WhatsappProvidersService>;
  let svc: ChatMediaService;
  beforeEach(() => {
    store = mockDeep<MediaStore>();
    repo = mockDeep<ChatRepository>();
    wa = mockDeep<WhatsappProvidersService>();
    svc = new ChatMediaService(
      store,
      repo,
      mockDeep<ChatEventsService>(),
      wa,
      mockDeep<ConversationOwnershipService>(),
    );
  });

  it('conversa de canal GoZap: 409 channel.provider_disabled antes de gravar arquivo ou mensagem', async () => {
    repo.getConversationForSend.mockResolvedValue(convOf('GOZAP') as never);
    const err: unknown = await svc
      .sendMediaReply('c1', 'u1', file)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChannelProviderDisabledError);
    expect(err).toMatchObject({
      code: 'channel.provider_disabled',
      status: 409,
    });
    expect(store.put.mock.calls).toHaveLength(0);
    expect(repo.createOutboundMediaMessage.mock.calls).toHaveLength(0);
    expect(wa.sendMedia.mock.calls).toHaveLength(0);
  });

  it('conversa de canal Evolution segue o caminho atual: grava, cria a mensagem e envia', async () => {
    repo.getConversationForSend.mockResolvedValue(convOf('EVOLUTION') as never);
    repo.createOutboundMediaMessage.mockResolvedValue('m1');
    wa.sendMedia.mockResolvedValue({
      providerMessageId: 'wa1',
      acceptedAt: new Date(),
    });
    repo.getMessageById.mockResolvedValue({ id: 'm1' } as never);
    await svc.sendMediaReply('c1', 'u1', file);
    expect(store.put.mock.calls).toHaveLength(1);
    expect(repo.createOutboundMediaMessage.mock.calls).toHaveLength(1);
    expect(wa.sendMedia.mock.calls).toHaveLength(1);
  });
});
