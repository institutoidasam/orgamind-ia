import { describe, it, expect, beforeEach } from 'vitest';
import { mockDeep, type MockProxy } from 'vitest-mock-extended';
import { ChatService } from './chat.service';
import { ChatRepository } from './chat.repository';
import { ChatEventsService } from './chat-events.service';
import { WhatsappProvidersService } from '../whatsapp-providers/whatsapp-providers.service';
import { WhatsappSendError } from '../whatsapp-providers/errors/whatsapp.errors';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { AuditService } from '../../shared/audit/audit.service';

const conv = { id: 'c1', instanceId: 'i1', phoneE164: '+5592999', remoteJid: '5592999@s.whatsapp.net', contactId: null, unreadCount: 2, instance: { id: 'i1', evolutionInstanceName: 'orgamind', provider: 'EVOLUTION' } };

describe('ChatService send/read/typing', () => {
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

  it('sendReply creates msg, sends via provider, marks SENT, publishes', async () => {
    wa.sendChatText.mockResolvedValue({ providerMessageId: 'WA1', acceptedAt: new Date() } as never);
    const out = await svc.sendReply('c1', 'u1', { text: 'olá' });
    expect(repo.createOutboundMessage).toHaveBeenCalledWith(expect.objectContaining({ conversationId: 'c1', content: 'olá', authorUserId: 'u1' }));
    expect(wa.sendChatText).toHaveBeenCalledWith(expect.objectContaining({ instanceName: 'orgamind', toE164: '+5592999', text: 'olá' }));
    expect(repo.markChatSent).toHaveBeenCalledWith('m1', 'i1', 'WA1', expect.any(Date));
    expect(repo.touchConversationOutbound).toHaveBeenCalled();
    expect(events.publish).toHaveBeenCalledWith(expect.objectContaining({ type: 'message.created', conversationId: 'c1' }));
    expect(out.status).toBe('SENT');
  });

  it('sendReply sends to the remoteJid JID for an unresolved @lid conversation (null phone)', async () => {
    repo.getConversationForSend.mockResolvedValue({ ...conv, remoteJid: '192410374131731@lid', phoneE164: null } as never);
    wa.sendChatText.mockResolvedValue({ providerMessageId: 'WA1', acceptedAt: new Date() } as never);
    await svc.sendReply('c1', 'u1', { text: 'olá' });
    expect(wa.sendChatText).toHaveBeenCalledWith(expect.objectContaining({ toE164: '192410374131731@lid', text: 'olá' }));
  });

  it('sendReply sends to the real phone once a @lid conversation is resolved', async () => {
    repo.getConversationForSend.mockResolvedValue({ ...conv, remoteJid: '192410374131731@lid', phoneE164: '+559293550101' } as never);
    wa.sendChatText.mockResolvedValue({ providerMessageId: 'WA1', acceptedAt: new Date() } as never);
    await svc.sendReply('c1', 'u1', { text: 'olá' });
    expect(wa.sendChatText).toHaveBeenCalledWith(expect.objectContaining({ toE164: '+559293550101', text: 'olá' }));
  });

  it('sendReply marks FAILED on provider error and still returns the message', async () => {
    wa.sendChatText.mockRejectedValue(new Error('down'));
    repo.getMessageById.mockResolvedValue({ id: 'm1', status: 'FAILED' } as never);
    const out = await svc.sendReply('c1', 'u1', { text: 'olá' });
    expect(repo.markChatFailed).toHaveBeenCalledWith('m1', 'down', null);
    expect(repo.touchConversationOutbound).not.toHaveBeenCalled();
    expect(out.status).toBe('FAILED');
  });

  it('markRead marks read on provider + resets unread when unreadCount>0', async () => {
    repo.getUnreadInboundKeys.mockResolvedValue({ keys: [{ remoteJid: 'x', fromMe: false, id: 'A' }], nextCursor: null } as never);
    await svc.markRead('c1');
    expect(wa.markMessageAsRead).toHaveBeenCalledWith('orgamind', [{ remoteJid: 'x', fromMe: false, id: 'A' }]);
    expect(repo.resetUnread).toHaveBeenCalledWith('c1');
  });

  it('markRead is a no-op when there are no unread', async () => {
    repo.getConversationForSend.mockResolvedValue({ ...conv, unreadCount: 0 } as never);
    await svc.markRead('c1');
    expect(wa.markMessageAsRead).not.toHaveBeenCalled();
    expect(repo.resetUnread).not.toHaveBeenCalled();
  });

  // markRead pagination (Baixo › Chat/Inbox): must ack EVERY unread inbound,
  // not just the newest page, before zeroing unreadCount.
  it('markRead paginates and acks every unread page before resetting', async () => {
    repo.getConversationForSend.mockResolvedValue({ ...conv, unreadCount: 3 } as never);
    repo.getUnreadInboundKeys
      .mockResolvedValueOnce({ keys: [{ remoteJid: 'x', fromMe: false, id: 'A' }, { remoteJid: 'x', fromMe: false, id: 'B' }], nextCursor: 'rB' } as never)
      .mockResolvedValueOnce({ keys: [{ remoteJid: 'x', fromMe: false, id: 'C' }], nextCursor: null } as never);
    await svc.markRead('c1');
    expect(repo.getUnreadInboundKeys).toHaveBeenCalledTimes(2);
    // second call carried the cursor from the first page
    expect(repo.getUnreadInboundKeys.mock.calls[1]).toEqual(['c1', conv.remoteJid, expect.any(Number), 'rB']);
    // both pages acked
    expect(wa.markMessageAsRead).toHaveBeenCalledTimes(2);
    expect(wa.markMessageAsRead).toHaveBeenNthCalledWith(2, 'orgamind', [{ remoteJid: 'x', fromMe: false, id: 'C' }]);
    expect(repo.resetUnread).toHaveBeenCalledWith('c1');
  });

  it('markRead does not ack an empty page', async () => {
    repo.getUnreadInboundKeys.mockResolvedValue({ keys: [], nextCursor: null } as never);
    await svc.markRead('c1');
    expect(wa.markMessageAsRead).not.toHaveBeenCalled();
    expect(repo.resetUnread).toHaveBeenCalledWith('c1');
  });

  it('sendTyping forwards presence to the provider', async () => {
    await svc.sendTyping('c1', 'composing');
    expect(wa.sendPresence).toHaveBeenCalledWith('orgamind', '+5592999', 'composing', 3000);
  });

  // listMessages existence guard (Baixo › Chat/Inbox): use the cheap id-only
  // existence check, not the heavy 3-table-join findConversation.
  it('listMessages guards existence with conversationExists (not the joined findConversation)', async () => {
    repo.conversationExists.mockResolvedValue(true);
    repo.listMessages.mockResolvedValue({ items: [], nextCursor: null } as never);
    await svc.listMessages('c1', { limit: 30 } as never);
    expect(repo.conversationExists).toHaveBeenCalledWith('c1');
    expect(repo.findConversation).not.toHaveBeenCalled();
    expect(repo.listMessages).toHaveBeenCalledWith('c1', { limit: 30 });
  });

  it('listMessages throws NotFound when the conversation does not exist', async () => {
    repo.conversationExists.mockResolvedValue(false);
    await expect(svc.listMessages('missing', { limit: 30 } as never)).rejects.toThrow();
    expect(repo.listMessages).not.toHaveBeenCalled();
  });
});

// T6 (twilio-platform): janela de 24h da Twilio no envio de chat. Free-form só
// dentro de lastInboundAt+24h; fora (ou sem inbound), o guard falha ANTES de
// criar a mensagem/chamar a Twilio. 63016 vindo da Twilio (corrida/estado
// divergente) mapeia para a MESMA mensagem PT-BR.
describe('ChatService — janela de 24h Twilio', () => {
  const HOUR_MS = 60 * 60 * 1000;
  const WINDOW_MSG = 'Janela de 24h fechada — envie um template aprovado para reabrir a conversa.';
  const twilioInstance = {
    id: 'i2', evolutionInstanceName: null, provider: 'TWILIO',
    phoneE164: '+14155238886', twilioMessagingServiceSid: null, zernioAccountId: null,
  };
  const openConv = {
    id: 'c2', instanceId: 'i2', phoneE164: '+5592999', remoteJid: '5592999@s.whatsapp.net',
    contactId: null, unreadCount: 1, instance: twilioInstance,
    lastInboundAt: new Date(Date.now() - HOUR_MS),
  };

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
    repo.getConversationForSend.mockResolvedValue(openConv as never);
    repo.createOutboundMessage.mockResolvedValue('m2');
    repo.getMessageById.mockResolvedValue({ id: 'm2', status: 'SENT' } as never);
  });

  it('sendReply envia via sendChatTextVia (canal TWILIO) quando a janela está aberta', async () => {
    wa.sendChatTextVia.mockResolvedValue({ providerMessageId: 'SM1', acceptedAt: new Date() } as never);
    const out = await svc.sendReply('c2', 'u1', { text: 'olá' });
    expect(wa.sendChatTextVia).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'TWILIO', phoneE164: '+14155238886' }),
      expect.objectContaining({ toE164: '+5592999', text: 'olá' }),
    );
    expect(wa.sendChatText).not.toHaveBeenCalled();
    expect(repo.markChatSent).toHaveBeenCalledWith('m2', 'i2', 'SM1', expect.any(Date));
    expect(out.status).toBe('SENT');
  });

  it('sendReply lança chat.twilio_window_closed quando o último inbound passou de 24h', async () => {
    repo.getConversationForSend.mockResolvedValue({
      ...openConv, lastInboundAt: new Date(Date.now() - 25 * HOUR_MS),
    } as never);
    await expect(svc.sendReply('c2', 'u1', { text: 'olá' })).rejects.toMatchObject({
      code: 'chat.twilio_window_closed',
      message: WINDOW_MSG,
    });
    // Guard falha ANTES de criar a mensagem e ANTES de chamar a Twilio.
    expect(repo.createOutboundMessage).not.toHaveBeenCalled();
    expect(wa.sendChatTextVia).not.toHaveBeenCalled();
  });

  it('sendReply lança chat.twilio_window_closed quando nunca houve inbound', async () => {
    repo.getConversationForSend.mockResolvedValue({ ...openConv, lastInboundAt: null } as never);
    await expect(svc.sendReply('c2', 'u1', { text: 'olá' })).rejects.toMatchObject({
      code: 'chat.twilio_window_closed',
    });
    expect(wa.sendChatTextVia).not.toHaveBeenCalled();
  });

  it('não aplica o guard a canais não-TWILIO (Evolution sem lastInboundAt envia normal)', async () => {
    repo.getConversationForSend.mockResolvedValue({
      ...openConv, lastInboundAt: null,
      instance: { id: 'i1', evolutionInstanceName: 'orgamind', provider: 'EVOLUTION' },
    } as never);
    wa.sendChatText.mockResolvedValue({ providerMessageId: 'WA1', acceptedAt: new Date() } as never);
    await expect(svc.sendReply('c2', 'u1', { text: 'olá' })).resolves.toBeDefined();
    expect(wa.sendChatText).toHaveBeenCalled();
  });

  it('mapeia o erro 63016 da Twilio para a mensagem de janela fechada (fallback)', async () => {
    wa.sendChatTextVia.mockRejectedValue(
      new WhatsappSendError('Mensagem livre fora da janela de 24h — é necessário um template aprovado.', '63016', 'Outside allowed window', true),
    );
    repo.getMessageById.mockResolvedValue({ id: 'm2', status: 'FAILED' } as never);
    const out = await svc.sendReply('c2', 'u1', { text: 'olá' });
    expect(repo.markChatFailed).toHaveBeenCalledWith('m2', WINDOW_MSG, '63016');
    expect(out.status).toBe('FAILED');
  });

  it('markRead reseta não-lidas sem ack no provedor para canal não-Evolution', async () => {
    repo.getUnreadInboundKeys.mockResolvedValue({ keys: [{ remoteJid: 'x', fromMe: false, id: 'A' }], nextCursor: null } as never);
    await svc.markRead('c2');
    expect(wa.markMessageAsRead).not.toHaveBeenCalled();
    expect(repo.resetUnread).toHaveBeenCalledWith('c2');
  });

  it('sendTyping é no-op para canal não-Evolution', async () => {
    await svc.sendTyping('c2', 'composing');
    expect(wa.sendPresence).not.toHaveBeenCalled();
  });
});
