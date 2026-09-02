import { describe, it, expect, beforeEach } from 'vitest';
import { mockDeep, type MockProxy } from 'vitest-mock-extended';
import { ChatRepository } from './chat.repository';
import { PrismaService } from '../../shared/prisma/prisma.service';

describe('ChatRepository.resetDifyConversationIdsForInstance', () => {
  it('clears difyConversationId for the instance conversations', async () => {
    const prisma = mockDeep<PrismaService>();
    prisma.conversation.updateMany.mockResolvedValue({ count: 2 } as any);
    const repo = new ChatRepository(prisma as unknown as PrismaService);
    await repo.resetDifyConversationIdsForInstance('inst1');
    const arg = prisma.conversation.updateMany.mock.calls[0][0] as any;
    expect(arg.where).toEqual({ instanceId: 'inst1', difyConversationId: { not: null } });
    expect(arg.data).toEqual({ difyConversationId: null });
  });
});

describe('ChatRepository', () => {
  let prisma: MockProxy<PrismaService>;
  let repo: ChatRepository;
  beforeEach(() => { prisma = mockDeep<PrismaService>(); repo = new ChatRepository(prisma); });

  it('lists conversations ordered by lastMessageAt desc, non-archived, with unread filter', async () => {
    prisma.conversation.findMany.mockResolvedValue([] as never);
    prisma.conversation.count.mockResolvedValue(0 as never);
    await repo.listConversations({ filter: 'unread', page: 1, pageSize: 30 });
    expect(prisma.conversation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ archivedAt: null, unreadCount: { gt: 0 } }),
        orderBy: { lastMessageAt: { sort: 'desc', nulls: 'last' } },
        skip: 0, take: 30,
      }),
    );
  });

  it('lists messages older than cursor, newest-first then reversed to chronological', async () => {
    prisma.message.findMany.mockResolvedValue([
      { id: 'b', createdAt: new Date(2), media: null },
      { id: 'a', createdAt: new Date(1), media: null },
    ] as never);
    const page = await repo.listMessages('conv1', { cursor: 'z', limit: 30 });
    expect(prisma.message.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { conversationId: 'conv1' }, orderBy: { createdAt: 'desc' }, take: 30, cursor: { id: 'z' }, skip: 1 }),
    );
    expect(page.items.map((m) => m.id)).toEqual(['a', 'b']); // chronological
  });

  // A1 — transcript field in mapped output
  it('includes transcript from the DB row in the mapped ChatMessage', async () => {
    prisma.message.findMany.mockResolvedValue([
      { id: 'v1', createdAt: new Date(1), media: null, transcript: 'oi tudo bem?' },
    ] as never);
    const page = await repo.listMessages('conv1', { limit: 30 });
    expect(page.items[0].transcript).toBe('oi tudo bem?');
  });

  it('maps transcript as null when absent on the DB row', async () => {
    prisma.message.findMany.mockResolvedValue([
      { id: 'v2', createdAt: new Date(1), media: null },
    ] as never);
    const page = await repo.listMessages('conv1', { limit: 30 });
    expect(page.items[0].transcript).toBeNull();
  });

  // Diagnóstico da falha de envio pelo inbox: o errorCode cru do provedor (que
  // markChatFailed agora persiste) precisa chegar ao operador/suporte pela
  // mesma leitura que já devolve a mensagem — sem exigir acesso ao log.
  it('includes errorCode from the DB row in the mapped ChatMessage', async () => {
    prisma.message.findMany.mockResolvedValue([
      { id: 'v3', createdAt: new Date(1), media: null, errorCode: 'gozap.timeout' },
    ] as never);
    const page = await repo.listMessages('conv1', { limit: 30 });
    expect(page.items[0].errorCode).toBe('gozap.timeout');
  });

  it('maps errorCode as null when absent on the DB row (SENT/QUEUED messages, or a FAILED one with no code)', async () => {
    prisma.message.findMany.mockResolvedValue([
      { id: 'v4', createdAt: new Date(1), media: null },
    ] as never);
    const page = await repo.listMessages('conv1', { limit: 30 });
    expect(page.items[0].errorCode).toBeNull();
  });

  it('findConversation includes the assignedUser relation', () => {
    prisma.conversation.findUnique.mockResolvedValue(null as never);
    void repo.findConversation('conv1');
    expect(prisma.conversation.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'conv1' },
        include: expect.objectContaining({ assignedUser: { select: { name: true } } }),
      }),
    );
  });

  it('assignConversation sets assignedUserId and assignedAt when assigning', async () => {
    prisma.conversation.update.mockResolvedValue({} as never);
    await repo.assignConversation('conv1', 'user-3');
    const arg = prisma.conversation.update.mock.calls[0][0] as any;
    expect(arg.where).toEqual({ id: 'conv1' });
    expect(arg.data.assignedUserId).toBe('user-3');
    expect(arg.data.assignedAt).toBeInstanceOf(Date);
  });

  it('assignConversation clears assignedUserId and assignedAt when unassigning', async () => {
    prisma.conversation.update.mockResolvedValue({} as never);
    await repo.assignConversation('conv1', null);
    const arg = prisma.conversation.update.mock.calls[0][0] as any;
    expect(arg.data.assignedUserId).toBeNull();
    expect(arg.data.assignedAt).toBeNull();
  });

  // markRead pagination (Baixo › Chat/Inbox): getUnreadInboundKeys must honor a
  // caller-supplied page size + cursor so the service can ack ALL unread inbound
  // (not just the newest 50) before zeroing unreadCount.
  it('getUnreadInboundKeys uses the given page size and returns a nextCursor when the page is full', async () => {
    prisma.message.findMany.mockResolvedValue([
      { id: 'r1', providerMessageId: 'A' },
      { id: 'r2', providerMessageId: 'B' },
    ] as never);
    const res = await repo.getUnreadInboundKeys('conv1', 'jid', 2);
    expect(prisma.message.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { conversationId: 'conv1', direction: 'INBOUND', providerMessageId: { not: null } }, take: 2 }),
    );
    expect(res.keys).toEqual([{ remoteJid: 'jid', fromMe: false, id: 'A' }, { remoteJid: 'jid', fromMe: false, id: 'B' }]);
    expect(res.nextCursor).toBe('r2'); // full page => more may exist
  });

  it('getUnreadInboundKeys returns a null cursor on a short final page', async () => {
    prisma.message.findMany.mockResolvedValue([{ id: 'r1', providerMessageId: 'A' }] as never);
    const res = await repo.getUnreadInboundKeys('conv1', 'jid', 2);
    expect(res.nextCursor).toBeNull();
    expect(res.keys).toHaveLength(1);
  });

  it('getUnreadInboundKeys applies the cursor to page past the first batch', async () => {
    prisma.message.findMany.mockResolvedValue([] as never);
    await repo.getUnreadInboundKeys('conv1', 'jid', 2, 'r2');
    expect(prisma.message.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ cursor: { id: 'r2' }, skip: 1 }),
    );
  });

  // listMessages existence guard (Baixo › Chat/Inbox): the guard must use a
  // cheap id-only lookup, NOT the 3-table-join findConversation.
  it('conversationExists selects only the id (no joins)', async () => {
    prisma.conversation.findUnique.mockResolvedValue({ id: 'conv1' } as never);
    const exists = await repo.conversationExists('conv1');
    expect(prisma.conversation.findUnique).toHaveBeenCalledWith({ where: { id: 'conv1' }, select: { id: true } });
    expect(exists).toBe(true);
  });

  it('conversationExists returns false when the conversation is missing', async () => {
    prisma.conversation.findUnique.mockResolvedValue(null as never);
    expect(await repo.conversationExists('nope')).toBe(false);
  });

  // Conversa sem resumo (lastMessageAt NULL) NÃO pode grudar no topo: no
  // Postgres, `desc` é NULLS FIRST por padrão, então toda conversa sem resumo
  // ficaria permanentemente acima das conversas reais.
  it('ordena por lastMessageAt desc com NULLS LAST', async () => {
    prisma.conversation.findMany.mockResolvedValue([] as never);
    prisma.conversation.count.mockResolvedValue(0 as never);
    await repo.listConversations({ filter: 'all', page: 1, pageSize: 30 });
    expect(prisma.conversation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { lastMessageAt: { sort: 'desc', nulls: 'last' } } }),
    );
  });
});

/**
 * BOLHA VAZIA + LINHA SEM PREVIEW — o envio de campanha gravava a Message solta:
 * sem conversationId (logo, fora da thread, que filtra por conversationId) e sem
 * tocar o resumo denormalizado da Conversation (lastMessageAt/lastMessagePreview),
 * que é o que a lista lateral realmente lê. Este é o único ponto de escrita que
 * liga o envio de campanha à visão única de conversa.
 */
describe('ChatRepository.linkOutboundCampaignMessage', () => {
  let prisma: MockProxy<PrismaService>;
  let repo: ChatRepository;
  const sentAt = new Date('2026-07-11T15:02:00Z');

  beforeEach(() => {
    prisma = mockDeep<PrismaService>();
    repo = new ChatRepository(prisma);
    // Por padrão o contato ainda não tem conversa nenhuma neste canal.
    prisma.conversation.findFirst.mockResolvedValue(null as never);
    prisma.conversation.upsert.mockResolvedValue({ id: 'conv-1', contactId: 'c1', lastMessageAt: null } as never);
  });

  function args(over: Record<string, unknown> = {}) {
    return {
      messageId: 'm1',
      instanceId: 'inst-1',
      contactId: 'c1',
      phoneE164: '+5511999999999',
      content: 'Olá Andre, tudo bem?',
      sentAt,
      ...over,
    } as any;
  }

  it('cria a conversa canônica (upsert por instanceId_remoteJid) só quando não existe nenhuma, e liga a mensagem', async () => {
    const conversationId = await repo.linkOutboundCampaignMessage(args());

    expect(conversationId).toBe('conv-1');
    const up = prisma.conversation.upsert.mock.calls[0][0] as any;
    expect(up.where).toEqual({
      instanceId_remoteJid: { instanceId: 'inst-1', remoteJid: '5511999999999@s.whatsapp.net' },
    });
    expect(prisma.message.update).toHaveBeenCalledWith({
      where: { id: 'm1' },
      data: { conversationId: 'conv-1' },
    });
  });

  /**
   * LINHA DUPLICADA NA INBOX — o remoteJid é do PROVEDOR (a Meta reporta muitos
   * celulares BR na forma legada de 8 dígitos), nunca do nosso cadastro.
   * Fabricar o JID a partir do phoneE164 e dar upsert criaria uma SEGUNDA
   * conversa: a bolha do disparo cairia na fantasma e a resposta do eleitor na
   * real. O envio tem de RESOLVER a conversa que o ingest já criou.
   */
  it('reaproveita a conversa REAL do ingest (JID legado de 8 dígitos) em vez de criar uma segunda', async () => {
    prisma.conversation.findFirst.mockResolvedValue({
      id: 'conv-real', contactId: 'c1', lastMessageAt: null,
    } as never);

    const conversationId = await repo.linkOutboundCampaignMessage(
      args({ phoneE164: '+5592995550101' }),
    );

    expect(conversationId).toBe('conv-real');
    expect(prisma.conversation.upsert).not.toHaveBeenCalled();
    expect(prisma.message.update).toHaveBeenCalledWith({
      where: { id: 'm1' }, data: { conversationId: 'conv-real' },
    });
  });

  it('avança o resumo da conversa (é isto que a lista lateral lê)', async () => {
    await repo.linkOutboundCampaignMessage(args());
    const upd = prisma.conversation.update.mock.calls[0][0] as any;
    expect(upd.where).toEqual({ id: 'conv-1' });
    expect(upd.data.lastMessageAt).toBe(sentAt);
    expect(upd.data.lastMessagePreview).toBe('Olá Andre, tudo bem?');
    expect(upd.data.lastMessageDirection).toBe('OUTBOUND');
  });

  it('não puxa o resumo para trás quando sentAt é anterior ao resumo atual (monotonicidade)', async () => {
    prisma.conversation.findFirst.mockResolvedValue({
      id: 'conv-1',
      contactId: 'c1',
      lastMessageAt: new Date('2026-07-11T18:00:00Z'), // mais recente que sentAt
    } as never);
    await repo.linkOutboundCampaignMessage(args());
    const upd = prisma.conversation.update.mock.calls[0][0] as any;
    expect(upd.data.lastMessageAt).toBeUndefined();
    expect(upd.data.lastMessagePreview).toBeUndefined();
    // a mensagem continua ligada à conversa — o que não avança é só o resumo
    expect(prisma.message.update).toHaveBeenCalled();
  });

  // Compliance: um OUTBOUND não abre a janela de 24h nem cria "não lida" para o
  // operador. Rebalancear qualquer um dos dois aqui seria regressão, não cosmética.
  it('NUNCA toca lastInboundAt (janela de 24h) nem unreadCount', async () => {
    await repo.linkOutboundCampaignMessage(args());
    const upd = prisma.conversation.update.mock.calls[0][0] as any;
    expect(upd.data.lastInboundAt).toBeUndefined();
    expect(upd.data.unreadCount).toBeUndefined();
    const up = prisma.conversation.upsert.mock.calls[0][0] as any;
    expect(up.create.lastInboundAt).toBeUndefined();
  });

  it('trunca o preview em 120 caracteres (mesma regra do resto do chat)', async () => {
    await repo.linkOutboundCampaignMessage(args({ content: 'x'.repeat(200) }));
    const upd = prisma.conversation.update.mock.calls[0][0] as any;
    expect(upd.data.lastMessagePreview).toHaveLength(120);
  });
});
