import { describe, it, expect, beforeEach } from 'vitest';
import { mockDeep, type MockProxy } from 'vitest-mock-extended';
import { ChatService } from './chat.service';
import { ChatRepository } from './chat.repository';
import { ChatEventsService } from './chat-events.service';
import { WhatsappProvidersService } from '../whatsapp-providers/whatsapp-providers.service';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { AuditService } from '../../shared/audit/audit.service';
import { WhatsappSendError } from '../whatsapp-providers/errors/whatsapp.errors';

const conv = {
  id: 'c1',
  instanceId: 'i1',
  phoneE164: '+5592999',
  remoteJid: '5592999@s.whatsapp.net',
  contactId: null,
  unreadCount: 0,
  instance: { id: 'i1', evolutionInstanceName: 'picoa', provider: 'EVOLUTION' },
};

describe('ChatService chat-send failure messages', () => {
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
    repo.getMessageById.mockResolvedValue({ id: 'm1', status: 'FAILED' } as never);
  });

  it('sendReply marks FAILED with a clear disconnected message (no auto-retry promise) on a session_closed WhatsappSendError', async () => {
    wa.sendChatText.mockRejectedValue(
      new WhatsappSendError(
        'Conexão com o WhatsApp caiu momentaneamente. Tentando reenviar automaticamente; reconecte em /connect.',
        'evolution.session_closed',
      ),
    );
    await svc.sendReply('c1', 'u1', { text: 'olá' });
    expect(repo.markChatFailed).toHaveBeenCalledTimes(1);
    const [, msg] = repo.markChatFailed.mock.calls[0];
    expect(msg).not.toContain('automaticamente');
    expect(msg).toContain('WhatsApp desconectado');
  });

  it('sendReply marks FAILED with the raw message for a generic Error', async () => {
    wa.sendChatText.mockRejectedValue(new Error('boom'));
    await svc.sendReply('c1', 'u1', { text: 'olá' });
    expect(repo.markChatFailed).toHaveBeenCalledWith('m1', 'boom', null);
  });
});
