import { describe, it, expect, vi } from 'vitest';
import { mockDeep } from 'vitest-mock-extended';
import { ChatService } from './chat.service';
import { ChatRepository } from './chat.repository';
import { ChatEventsService } from './chat-events.service';
import { WhatsappProvidersService } from '../whatsapp-providers/whatsapp-providers.service';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { AuditService } from '../../shared/audit/audit.service';

function make() {
  const repo = mockDeep<ChatRepository>();
  const events = mockDeep<ChatEventsService>();
  const wa = mockDeep<WhatsappProvidersService>();
  // O ChatService recusa a resposta quando o provider do canal não declara
  // `inboxChat` (fail-closed). O mock profundo devolveria `undefined` — que é
  // recusa — então o suporte é declarado aqui explicitamente.
  wa.supportsInboxChatFor.mockReturnValue(true);
  const prisma = mockDeep<PrismaService>();
  const audit = mockDeep<AuditService>();
  const svc = new ChatService(repo, events, wa, prisma, audit);
  return { svc, repo, events, wa, prisma, audit };
}

const convForSend = {
  id: 'c1',
  instanceId: 'i1',
  remoteJid: '5592@s.whatsapp.net',
  phoneE164: '+5592',
  contactId: 'ct1',
  unreadCount: 0,
  instance: { id: 'i1', evolutionInstanceName: 'picoa-x', provider: 'EVOLUTION' },
} as never;

describe('ChatService.sendBotReply', () => {
  it('creates an OUTBOUND message tagged with botId (no authorUserId) and dispatches', async () => {
    const { svc, repo, wa } = make();
    repo.getConversationForSend.mockResolvedValue(convForSend);
    repo.createOutboundMessage.mockResolvedValue('m1');
    wa.sendChatText.mockResolvedValue({ providerMessageId: 'p1', acceptedAt: new Date() });

    await svc.sendBotReply('c1', 'olá do bot', 'bot1');

    expect(repo.createOutboundMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'olá do bot', authorUserId: null, botId: 'bot1' }),
    );
    expect(wa.sendPresence).toHaveBeenCalled(); // typing indicator before send
    expect(wa.sendChatText).toHaveBeenCalledWith(
      expect.objectContaining({ instanceName: 'picoa-x', text: 'olá do bot' }),
    );
  });
});

describe('ChatService handoff', () => {
  it('sendReply pauses the bot (setBotPaused)', async () => {
    const { svc, repo, wa } = make();
    repo.getConversationForSend.mockResolvedValue(convForSend);
    repo.createOutboundMessage.mockResolvedValue('m1');
    wa.sendChatText.mockResolvedValue({ providerMessageId: 'p1', acceptedAt: new Date() });
    repo.getMessageById.mockResolvedValue({ id: 'm1' } as never);

    await svc.sendReply('c1', 'user1', { text: 'resposta humana' });

    expect(repo.setBotPaused).toHaveBeenCalledWith('c1');
  });

  it('assignConversation to a user pauses the bot; unassign does not', async () => {
    const { svc, repo, prisma } = make();
    repo.findConversation.mockResolvedValue({ id: 'c1', instanceId: 'i1' } as never);
    prisma.user.findUnique.mockResolvedValue({ id: 'u1' } as never);

    await svc.assignConversation('c1', 'u1', 'actor1');
    expect(repo.setBotPaused).toHaveBeenCalledWith('c1');

    repo.setBotPaused.mockClear();
    await svc.assignConversation('c1', null, 'actor1');
    expect(repo.setBotPaused).not.toHaveBeenCalled();
  });

  it('resumeBot clears the pause', async () => {
    const { svc, repo } = make();
    repo.conversationExists.mockResolvedValue(true);
    await svc.resumeBot('c1');
    expect(repo.clearBotPaused).toHaveBeenCalledWith('c1');
  });
});
