import { describe, it, expect, beforeEach } from 'vitest';
import { mockDeep, type MockProxy } from 'vitest-mock-extended';
import { ChatService } from './chat.service';
import { ChatRepository } from './chat.repository';
import { ChatEventsService } from './chat-events.service';
import { WhatsappProvidersService } from '../whatsapp-providers/whatsapp-providers.service';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { AuditService } from '../../shared/audit/audit.service';

// Characterization tests for sendReply pinning the dispatch flow that the
// attemptSend()/dispatchOutbound() extraction must preserve:
//   - quoted fields normalized ONCE (undefined -> null) and shared between
//     createOutboundMessage and the provider call,
//   - SENT path: markChatSent, touchConversationOutbound, message.created +
//     conversation.updated published,
//   - FAILED path: markChatFailed, NO touch, message.created published but NO
//     conversation.updated.

const conv = {
  id: 'c1', instanceId: 'i1', phoneE164: '+5592999', remoteJid: '5592999@s.whatsapp.net',
  contactId: 'ct1', unreadCount: 0, instance: { id: 'i1', evolutionInstanceName: 'picoa', provider: 'EVOLUTION' },
};

describe('ChatService.sendReply — dispatch characterization', () => {
  let repo: MockProxy<ChatRepository>;
  let events: MockProxy<ChatEventsService>;
  let wa: MockProxy<WhatsappProvidersService>;
  let svc: ChatService;
  beforeEach(() => {
    repo = mockDeep<ChatRepository>();
    events = mockDeep<ChatEventsService>();
    wa = mockDeep<WhatsappProvidersService>();
    // O ChatService recusa a resposta quando o provider do canal não declara
    // `inboxChat` (fail-closed). O mock profundo devolveria `undefined` — que é
    // recusa — então o suporte é declarado aqui explicitamente.
    wa.supportsInboxChatFor.mockReturnValue(true);
    svc = new ChatService(repo, events, wa, mockDeep<PrismaService>(), mockDeep<AuditService>());
    repo.getConversationForSend.mockResolvedValue(conv as never);
    repo.createOutboundMessage.mockResolvedValue('m1');
    repo.getMessageById.mockResolvedValue({ id: 'm1', status: 'SENT' } as never);
  });

  it('normalizes absent quoted fields to null in BOTH createOutboundMessage and the provider call', async () => {
    wa.sendChatText.mockResolvedValue({ providerMessageId: 'WA1', acceptedAt: new Date() } as never);
    await svc.sendReply('c1', 'u1', { text: 'olá' });
    expect(repo.createOutboundMessage).toHaveBeenCalledWith(
      expect.objectContaining({ quotedWaMessageId: null, quotedPreview: null }),
    );
    expect(wa.sendChatText).toHaveBeenCalledWith(
      expect.objectContaining({ quotedWaMessageId: null, quotedPreview: null }),
    );
  });

  it('passes through provided quoted fields to both the persisted row and the provider', async () => {
    wa.sendChatText.mockResolvedValue({ providerMessageId: 'WA1', acceptedAt: new Date() } as never);
    await svc.sendReply('c1', 'u1', { text: 're', quotedWaMessageId: 'Q1', quotedPreview: 'orig' });
    expect(repo.createOutboundMessage).toHaveBeenCalledWith(
      expect.objectContaining({ quotedWaMessageId: 'Q1', quotedPreview: 'orig' }),
    );
    expect(wa.sendChatText).toHaveBeenCalledWith(
      expect.objectContaining({ quotedWaMessageId: 'Q1', quotedPreview: 'orig' }),
    );
  });

  it('SENT: marks sent, touches conversation, publishes message.created AND conversation.updated', async () => {
    wa.sendChatText.mockResolvedValue({ providerMessageId: 'WA1', acceptedAt: new Date() } as never);
    await svc.sendReply('c1', 'u1', { text: 'olá' });
    expect(repo.markChatSent).toHaveBeenCalledWith('m1', 'i1', 'WA1', expect.any(Date));
    expect(repo.markChatFailed).not.toHaveBeenCalled();
    expect(repo.touchConversationOutbound).toHaveBeenCalledWith('c1', 'olá');
    expect(events.publish).toHaveBeenCalledWith(expect.objectContaining({ type: 'message.created', conversationId: 'c1', instanceId: 'i1', messageId: 'm1' }));
    expect(events.publish).toHaveBeenCalledWith(expect.objectContaining({ type: 'conversation.updated', conversationId: 'c1', instanceId: 'i1' }));
  });

  it('FAILED: marks failed, does NOT touch, publishes message.created but NOT conversation.updated', async () => {
    wa.sendChatText.mockRejectedValue(new Error('down'));
    repo.getMessageById.mockResolvedValue({ id: 'm1', status: 'FAILED' } as never);
    const out = await svc.sendReply('c1', 'u1', { text: 'olá' });
    expect(repo.markChatFailed).toHaveBeenCalledWith('m1', 'down', null);
    expect(repo.markChatSent).not.toHaveBeenCalled();
    expect(repo.touchConversationOutbound).not.toHaveBeenCalled();
    expect(events.publish).toHaveBeenCalledWith(expect.objectContaining({ type: 'message.created' }));
    expect(events.publish).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'conversation.updated' }));
    expect(out.status).toBe('FAILED');
  });

  it('FAILED with a non-Error rejection stringifies it for markChatFailed', async () => {
    wa.sendChatText.mockRejectedValue('boom-string');
    repo.getMessageById.mockResolvedValue({ id: 'm1', status: 'FAILED' } as never);
    await svc.sendReply('c1', 'u1', { text: 'olá' });
    expect(repo.markChatFailed).toHaveBeenCalledWith('m1', 'boom-string', null);
  });

  it('throws NotFound when the conversation does not exist', async () => {
    repo.getConversationForSend.mockResolvedValue(null as never);
    await expect(svc.sendReply('missing', 'u1', { text: 'x' })).rejects.toThrow();
  });

  it('throws NotFound when the persisted message cannot be re-read', async () => {
    wa.sendChatText.mockResolvedValue({ providerMessageId: 'WA1', acceptedAt: new Date() } as never);
    repo.getMessageById.mockResolvedValue(null as never);
    await expect(svc.sendReply('c1', 'u1', { text: 'x' })).rejects.toThrow();
  });
});
