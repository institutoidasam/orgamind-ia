import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockDeep } from 'vitest-mock-extended';
import { assignedToOther } from './conversation-ownership.errors';
import { ChatMediaService } from './chat-media.service';
import { ChatRepository } from './chat.repository';
import { ChatEventsService } from './chat-events.service';
import { ConversationOwnershipService } from './conversation-ownership.service';
import { WhatsappProvidersService } from '../whatsapp-providers/whatsapp-providers.service';
import type { MediaStore } from '../../shared/media/media-store.port';

// Ordem observável: a conferência do provedor é a função de provedor ligado.
const { providerCheck } = vi.hoisted(() => ({ providerCheck: vi.fn() }));
vi.mock('../../shared/config/enabled-providers', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../../shared/config/enabled-providers')
  >()),
  isEnabledChannelProvider: providerCheck,
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
  const mocks = {
    ownership: mockDeep<ConversationOwnershipService>(),
    events: mockDeep<ChatEventsService>(),
    store: mockDeep<MediaStore>(),
    repo: mockDeep<ChatRepository>(),
    wa: mockDeep<WhatsappProvidersService>(),
  };
  const { ownership, events, store, repo, wa } = mocks;
  const svc = new ChatMediaService(store, repo, events, wa, ownership);
  repo.getConversationForSend.mockResolvedValue(conv as never);
  repo.createOutboundMediaMessage.mockResolvedValue('m1');
  repo.getMessageById.mockResolvedValue({ id: 'm1' } as never);
  wa.sendMedia.mockResolvedValue({
    providerMessageId: 'wa1',
    acceptedAt: new Date(),
  });
  return { svc, ...mocks };
}

beforeEach(() => {
  providerCheck.mockReset().mockReturnValue(true);
});

describe('ChatMediaService.sendMediaReply — trava de resposta (K1-5)', () => {
  it('ordem: assertProviderEnabled, claimForReply, depois store.put', async () => {
    const { svc, ownership, store } = setup();
    const order: string[] = [];
    providerCheck.mockImplementation(() => {
      order.push('provider');
      return true;
    });
    ownership.claimForReply.mockImplementation(() => {
      order.push('claim');
      return Promise.resolve({ changed: false });
    });
    store.put.mockImplementation(() => {
      order.push('put');
      return Promise.resolve();
    });
    await svc.sendMediaReply('c1', 'u1', file);
    expect(order).toEqual(['provider', 'claim', 'put']);
    expect(ownership.claimForReply.mock.calls).toEqual([['c1', 'u1']]);
  });

  it('claim recusa — store.put, createOutboundMediaMessage e o provedor não são chamados', async () => {
    const { svc, ownership, store, repo, wa, events } = setup();
    const refusal = assignedToOther({ id: 'u2', name: 'Ana', active: true });
    ownership.claimForReply.mockRejectedValue(refusal);
    await expect(svc.sendMediaReply('c1', 'u1', file)).rejects.toBe(refusal);
    expect(store.put.mock.calls).toHaveLength(0);
    expect(repo.createOutboundMediaMessage.mock.calls).toHaveLength(0);
    expect(wa.sendMedia.mock.calls).toHaveLength(0);
    expect(events.publish.mock.calls).toHaveLength(0);
  });
});
