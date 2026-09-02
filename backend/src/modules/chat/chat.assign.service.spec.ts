import { describe, it, expect, beforeEach } from 'vitest';
import { mockDeep, type MockProxy } from 'vitest-mock-extended';
import { ChatService } from './chat.service';
import { ChatRepository } from './chat.repository';
import { ChatEventsService } from './chat-events.service';
import { WhatsappProvidersService } from '../whatsapp-providers/whatsapp-providers.service';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { AuditService } from '../../shared/audit/audit.service';
import { NotFoundError } from '../../shared/errors/domain.error';

describe('ChatService assign/list governance', () => {
  let repo: MockProxy<ChatRepository>;
  let events: MockProxy<ChatEventsService>;
  let wa: MockProxy<WhatsappProvidersService>;
  let prisma: MockProxy<PrismaService>;
  let audit: MockProxy<AuditService>;
  let svc: ChatService;

  beforeEach(() => {
    repo = mockDeep<ChatRepository>();
    events = mockDeep<ChatEventsService>();
    wa = mockDeep<WhatsappProvidersService>();
    prisma = mockDeep<PrismaService>();
    audit = mockDeep<AuditService>();
    svc = new ChatService(repo, events, wa, prisma, audit);
  });

  describe('listConversations', () => {
    it("resolves assignee 'me' to the current user id before delegating to the repo", async () => {
      repo.listConversations.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 30 } as never);
      await svc.listConversations({ filter: 'all', assignee: 'me', page: 1, pageSize: 30 } as never, 'user-42');
      expect(repo.listConversations).toHaveBeenCalledWith(expect.objectContaining({ assignee: 'user-42' }));
    });

    it("passes 'unassigned' through to the repo unchanged", async () => {
      repo.listConversations.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 30 } as never);
      await svc.listConversations({ filter: 'all', assignee: 'unassigned', page: 1, pageSize: 30 } as never, 'user-42');
      expect(repo.listConversations).toHaveBeenCalledWith(expect.objectContaining({ assignee: 'unassigned' }));
    });

    it('passes a concrete userId through unchanged', async () => {
      repo.listConversations.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 30 } as never);
      await svc.listConversations({ filter: 'all', assignee: 'user-7', page: 1, pageSize: 30 } as never, 'user-42');
      expect(repo.listConversations).toHaveBeenCalledWith(expect.objectContaining({ assignee: 'user-7' }));
    });
  });

  describe('assignConversation', () => {
    beforeEach(() => {
      repo.findConversation.mockResolvedValue({ id: 'c1', instanceId: 'i1' } as never);
      repo.assignConversation.mockResolvedValue(undefined as never);
    });

    it('validates the target user exists, updates, audits, and publishes', async () => {
      (prisma.user.findUnique as ReturnType<typeof mockDeep>).mockResolvedValue({ id: 'u9' } as never);
      await svc.assignConversation('c1', 'u9', 'actor-1');
      expect(prisma.user.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'u9' } }));
      expect(repo.assignConversation).toHaveBeenCalledWith('c1', 'u9');
      expect(audit.log).toHaveBeenCalledWith('conversation.assign', 'Conversation', 'c1', expect.objectContaining({ assignedUserId: 'u9' }));
      expect(events.publish).toHaveBeenCalledWith(expect.objectContaining({ type: 'conversation.updated', conversationId: 'c1', instanceId: 'i1' }));
    });

    it('rejects when the target user does not exist', async () => {
      (prisma.user.findUnique as ReturnType<typeof mockDeep>).mockResolvedValue(null as never);
      await expect(svc.assignConversation('c1', 'ghost', 'actor-1')).rejects.toBeInstanceOf(NotFoundError);
      expect(repo.assignConversation).not.toHaveBeenCalled();
    });

    it('rejects when the conversation does not exist', async () => {
      repo.findConversation.mockResolvedValue(null as never);
      await expect(svc.assignConversation('missing', 'u9', 'actor-1')).rejects.toBeInstanceOf(NotFoundError);
    });

    it('unassigns (userId null) without validating any user, audits and publishes', async () => {
      await svc.assignConversation('c1', null, 'actor-1');
      expect(prisma.user.findUnique).not.toHaveBeenCalled();
      expect(repo.assignConversation).toHaveBeenCalledWith('c1', null);
      expect(audit.log).toHaveBeenCalledWith('conversation.assign', 'Conversation', 'c1', expect.objectContaining({ assignedUserId: null }));
      expect(events.publish).toHaveBeenCalledWith(expect.objectContaining({ type: 'conversation.updated', conversationId: 'c1' }));
    });

    it('reassigns from one user to another', async () => {
      (prisma.user.findUnique as ReturnType<typeof mockDeep>).mockResolvedValue({ id: 'u2' } as never);
      await svc.assignConversation('c1', 'u2', 'actor-1');
      expect(repo.assignConversation).toHaveBeenCalledWith('c1', 'u2');
    });
  });
});
