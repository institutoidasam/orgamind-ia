import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockDeep, type MockProxy } from 'vitest-mock-extended';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { ChatRepository } from './chat.repository';

function buildQuery(over: Record<string, unknown> = {}) {
  return { filter: 'all', search: undefined, page: 1, pageSize: 30, ...over } as never;
}

describe('ChatRepository.listConversations — instanceId filter', () => {
  let prisma: MockProxy<PrismaService>;
  let repo: ChatRepository;

  beforeEach(() => {
    prisma = mockDeep<PrismaService>();
    (prisma.conversation.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (prisma.conversation.count as ReturnType<typeof vi.fn>).mockResolvedValue(0);
    repo = new ChatRepository(prisma);
  });

  it('adds where.instanceId when instanceId is provided', async () => {
    await repo.listConversations(buildQuery({ instanceId: 'inst-1' }));
    const arg = (prisma.conversation.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(arg.where).toMatchObject({ archivedAt: null, instanceId: 'inst-1' });
  });

  it('omits instanceId from where when not provided', async () => {
    await repo.listConversations(buildQuery());
    const arg = (prisma.conversation.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(arg.where).not.toHaveProperty('instanceId');
  });

  it('filters by assignedUserId: null when assignee is "unassigned"', async () => {
    await repo.listConversations(buildQuery({ assignee: 'unassigned' }));
    const arg = (prisma.conversation.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(arg.where).toMatchObject({ archivedAt: null, assignedUserId: null });
  });

  it('filters by assignedUserId equal to a concrete userId', async () => {
    await repo.listConversations(buildQuery({ assignee: 'user-7' }));
    const arg = (prisma.conversation.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(arg.where).toMatchObject({ archivedAt: null, assignedUserId: 'user-7' });
  });

  it('omits the assignedUserId filter when assignee is not provided', async () => {
    await repo.listConversations(buildQuery());
    const arg = (prisma.conversation.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(arg.where).not.toHaveProperty('assignedUserId');
  });

  it('includes the assignedUser relation and maps assignedUserId + assignedUserName', async () => {
    (prisma.conversation.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 'c1', instanceId: 'i1', remoteJid: 'r', phoneE164: null, contactId: null, waName: null, profilePicUrl: null, lastMessageAt: null, lastMessagePreview: null, lastMessageDirection: null, unreadCount: 0, assignedUserId: 'u9', assignedUser: { name: 'Ana' } },
    ]);
    (prisma.conversation.count as ReturnType<typeof vi.fn>).mockResolvedValue(1);
    const page = await repo.listConversations(buildQuery());
    const arg = (prisma.conversation.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(arg.include).toMatchObject({ assignedUser: { select: { name: true } } });
    expect(page.items[0]).toMatchObject({ assignedUserId: 'u9', assignedUserName: 'Ana' });
  });

  it('maps assignedUserId and assignedUserName as null when unassigned', async () => {
    (prisma.conversation.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 'c2', instanceId: 'i1', remoteJid: 'r', phoneE164: null, contactId: null, waName: null, profilePicUrl: null, lastMessageAt: null, lastMessagePreview: null, lastMessageDirection: null, unreadCount: 0, assignedUserId: null, assignedUser: null },
    ]);
    (prisma.conversation.count as ReturnType<typeof vi.fn>).mockResolvedValue(1);
    const page = await repo.listConversations(buildQuery());
    expect(page.items[0]).toMatchObject({ assignedUserId: null, assignedUserName: null });
  });

  // F4 — inbox provider badge/filter: the channel's provider rides along on
  // the existing instance join (a plain scalar select), no extra query.
  it('selects instance.provider (minimal select, no extra query) and maps it onto the summary', async () => {
    (prisma.conversation.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 'c3', instanceId: 'i1', instance: { name: 'Vendas', botId: null, provider: 'TWILIO', bot: null }, remoteJid: 'r', phoneE164: null, contactId: null, waName: null, profilePicUrl: null, lastMessageAt: null, lastMessagePreview: null, lastMessageDirection: null, unreadCount: 0, assignedUserId: null, assignedUser: null },
    ]);
    (prisma.conversation.count as ReturnType<typeof vi.fn>).mockResolvedValue(1);
    const page = await repo.listConversations(buildQuery());
    const arg = (prisma.conversation.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(arg.include.instance.select).toMatchObject({ provider: true });
    expect(page.items[0]).toMatchObject({ provider: 'TWILIO' });
  });

  // F4b — the inbox provider filter must apply server-side (before the page
  // cut), the same way instanceId/unread/search/assignee already do. See
  // chat.repository.ts for the where.instance.provider relation filter.
  describe('provider filter (F4b)', () => {
    it('adds where.instance.provider when provider is given', async () => {
      await repo.listConversations(buildQuery({ provider: 'TWILIO' }));
      const arg = (prisma.conversation.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(arg.where).toMatchObject({ archivedAt: null, instance: { provider: 'TWILIO' } });
    });

    it('omits the instance.provider filter when provider is not given', async () => {
      await repo.listConversations(buildQuery());
      const arg = (prisma.conversation.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(arg.where).not.toHaveProperty('instance');
    });

    it('combines with instanceId, unread and search filters', async () => {
      await repo.listConversations(
        buildQuery({ provider: 'EVOLUTION', instanceId: 'inst-1', filter: 'unread', search: 'ana' }),
      );
      const arg = (prisma.conversation.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(arg.where).toMatchObject({
        archivedAt: null,
        instanceId: 'inst-1',
        unreadCount: { gt: 0 },
        instance: { provider: 'EVOLUTION' },
      });
      expect(arg.where.OR).toEqual([
        { phoneE164: { contains: 'ana' } },
        { waName: { contains: 'ana', mode: 'insensitive' } },
        { contact: { name: { contains: 'ana', mode: 'insensitive' } } },
      ]);
    });

    it('combines with the assignee filter', async () => {
      await repo.listConversations(buildQuery({ provider: 'TWILIO', assignee: 'unassigned' }));
      const arg = (prisma.conversation.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(arg.where).toMatchObject({
        archivedAt: null,
        assignedUserId: null,
        instance: { provider: 'TWILIO' },
      });
    });
  });

  // "Aguardando resposta" (inbox) — o CONTATO falou por último e ninguém
  // respondeu ainda: lastMessageDirection === 'INBOUND'. Distinto de
  // 'unread' (unreadCount > 0), que zera quando o operador só ABRE a
  // conversa, mesmo sem responder.
  describe('awaiting filter (aguardando resposta)', () => {
    it('adds where.lastMessageDirection: INBOUND when filter is "awaiting"', async () => {
      await repo.listConversations(buildQuery({ filter: 'awaiting' }));
      const arg = (prisma.conversation.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(arg.where).toMatchObject({ archivedAt: null, lastMessageDirection: 'INBOUND' });
    });

    it('filter "unread" keeps the existing unreadCount behaviour (no lastMessageDirection)', async () => {
      await repo.listConversations(buildQuery({ filter: 'unread' }));
      const arg = (prisma.conversation.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(arg.where).toMatchObject({ archivedAt: null, unreadCount: { gt: 0 } });
      expect(arg.where).not.toHaveProperty('lastMessageDirection');
    });

    it('filter "all" omits both unreadCount and lastMessageDirection', async () => {
      await repo.listConversations(buildQuery({ filter: 'all' }));
      const arg = (prisma.conversation.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(arg.where).not.toHaveProperty('unreadCount');
      expect(arg.where).not.toHaveProperty('lastMessageDirection');
    });
  });
});
