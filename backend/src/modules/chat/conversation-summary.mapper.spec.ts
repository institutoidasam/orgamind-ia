import { describe, it, expect } from 'vitest';
import { toConversationSummary } from './conversation-summary.mapper';

const row = {
  id: 'c1', instanceId: 'i1', remoteJid: '5592@s.whatsapp.net',
  phoneE164: '+5592', contactId: null, waName: 'Zé', profilePicUrl: null,
  lastMessageAt: null, lastMessagePreview: null, lastMessageDirection: null,
  unreadCount: 0, assignedUserId: null, assignedAt: null,
  difyConversationId: null, botPausedAt: null, createdAt: new Date(), updatedAt: new Date(),
  contact: null,
  instance: { name: 'Vendas', botId: 'b1', provider: 'TWILIO', bot: { id: 'b1', name: 'Atendente' } },
  assignedUser: null,
} as never;

describe('toConversationSummary bot fields', () => {
  it('exposes botId/botName and botPaused=false when active', () => {
    const s = toConversationSummary(row);
    expect(s.botId).toBe('b1');
    expect(s.botName).toBe('Atendente');
    expect(s.botPaused).toBe(false);
  });
  it('botPaused=true when botPausedAt is set', () => {
    const s = toConversationSummary({ ...(row as object), botPausedAt: new Date() } as never);
    expect(s.botPaused).toBe(true);
  });
  it('botId/botName null when instance has no bot', () => {
    const s = toConversationSummary({ ...(row as object), instance: { name: 'Vendas', botId: null, provider: 'EVOLUTION', bot: null } } as never);
    expect(s.botId).toBeNull();
    expect(s.botName).toBeNull();
  });
});

describe('toConversationSummary provider field', () => {
  it('maps provider from the joined instance', () => {
    const s = toConversationSummary(row);
    expect(s.provider).toBe('TWILIO');
  });
  it('falls back to EVOLUTION when the instance is missing', () => {
    const s = toConversationSummary({ ...(row as object), instance: null } as never);
    expect(s.provider).toBe('EVOLUTION');
  });
});
