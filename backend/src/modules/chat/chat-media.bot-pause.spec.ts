import { describe, expect, it, vi } from 'vitest';
import { mockDeep } from 'vitest-mock-extended';
import { assignedToOther } from './conversation-ownership.errors';
import { ChatMediaService } from './chat-media.service';
import { ChatRepository } from './chat.repository';
import { ChatEventsService } from './chat-events.service';
import { ConversationOwnershipService } from './conversation-ownership.service';
import { WhatsappProvidersService } from '../whatsapp-providers/whatsapp-providers.service';
import type { MediaStore } from '../../shared/media/media-store.port';

vi.mock('../../shared/config/enabled-providers', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../../shared/config/enabled-providers')
  >()),
  isEnabledChannelProvider: () => true,
}));

const conv = {
  id: 'c1',
  instanceId: 'i1',
  phoneE164: '+5592991110001',
  remoteJid: '5592991110001@s.whatsapp.net',
  contactId: null,
  instance: { id: 'i1', provider: 'EVOLUTION', evolutionInstanceName: 'inst' },
};
const file = {
  buffer: Buffer.from('img'),
  originalname: 'a.png',
  mimetype: 'image/png',
  size: 3,
} as Express.Multer.File;

function setup() {
  const ownership = mockDeep<ConversationOwnershipService>();
  const repo = mockDeep<ChatRepository>();
  const wa = mockDeep<WhatsappProvidersService>();
  const svc = new ChatMediaService(
    mockDeep<MediaStore>(),
    repo,
    mockDeep<ChatEventsService>(),
    wa,
    ownership,
  );
  repo.getConversationForSend.mockResolvedValue(conv as never);
  repo.createOutboundMediaMessage.mockResolvedValue('m1');
  repo.getMessageById.mockResolvedValue({ id: 'm1' } as never);
  wa.sendMedia.mockResolvedValue({
    providerMessageId: 'wa1',
    acceptedAt: new Date(),
  });
  return { svc, ownership, repo };
}

describe('ChatMediaService.sendMediaReply — pausa do robô (K3-7a)', () => {
  it('K3-7(a): mídia na conversa que já é minha e aberta (claim changed false) — pausa o robô', async () => {
    const { svc, ownership, repo } = setup();
    ownership.claimForReply.mockResolvedValue({ changed: false });
    const order: string[] = [];
    repo.createOutboundMediaMessage.mockImplementation(() => {
      order.push('create');
      return Promise.resolve('m1');
    });
    repo.setBotPaused.mockImplementation(() => {
      order.push('pause');
      return Promise.resolve();
    });
    await svc.sendMediaReply('c1', 'u1', file);
    expect(repo.setBotPaused.mock.calls).toEqual([['c1']]);
    expect(order).toEqual(['create', 'pause']);
  });

  it('mídia de outro (409) — não pausa nem grava', async () => {
    const { svc, ownership, repo } = setup();
    ownership.claimForReply.mockRejectedValue(
      assignedToOther({ id: 'u2', name: 'Ana', active: true }),
    );
    await expect(svc.sendMediaReply('c1', 'u1', file)).rejects.toBeDefined();
    expect(repo.setBotPaused.mock.calls).toHaveLength(0);
    expect(repo.createOutboundMediaMessage.mock.calls).toHaveLength(0);
  });
});
