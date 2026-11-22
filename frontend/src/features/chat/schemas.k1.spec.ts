import { describe, it, expect } from 'vitest';
import { conversationSummarySchema, parseChatAssignees, parseConversationHistory } from './schemas';

const legacySummary = {
  id: 'c1', instanceId: 'i1', instanceName: 'A', remoteJid: 'j@s', phoneE164: null,
  contactId: null, displayName: 'Cliente', waName: null, profilePicUrl: null,
  lastMessageAt: null, lastMessagePreview: null, lastMessageDirection: null, unreadCount: 0,
};

const historyItem = {
  id: 'h1', action: 'TRANSFERRED', createdAt: '2026-11-21T14:00:00.000Z',
  actorId: 'u1', actorName: 'Ana', fromUserId: 'u1', fromUserName: 'Ana',
  toUserId: 'u2', toUserName: 'Bia', note: null,
};

describe('contrato K1 do chat', () => {
  it('resumo antigo sem os campos novos continua válido', () => {
    expect(conversationSummarySchema.safeParse(legacySummary).success).toBe(true);
    const novo = conversationSummarySchema.safeParse({
      ...legacySummary, status: 'RESOLVED', resolvedAt: '2026-11-21T10:00:00.000Z',
      lastInboundAt: null, assignedUserActive: null,
    });
    expect(novo.success).toBe(true);
  });

  it('histórico (com e sem hasMore) e destinos', () => {
    expect(parseConversationHistory({ items: [historyItem], hasMore: true }).hasMore).toBe(true);
    const semHasMore = parseConversationHistory({ items: [historyItem] });
    expect(semHasMore.items[0].action).toBe('TRANSFERRED');
    expect(semHasMore.hasMore).toBeUndefined();
    expect(parseChatAssignees({ items: [{ id: 'u2', name: 'Bia' }] }).items).toEqual([{ id: 'u2', name: 'Bia' }]);
  });
});
