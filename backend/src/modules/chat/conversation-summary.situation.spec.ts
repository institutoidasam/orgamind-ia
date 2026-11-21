import { describe, expect, it } from 'vitest';
import { toConversationSummary } from './conversation-summary.mapper';

const baseRow = {
  id: 'c1',
  instanceId: 'i1',
  remoteJid: '5592991110001@s.whatsapp.net',
  phoneE164: '+5592991110001',
  contactId: null,
  waName: 'Cliente',
  profilePicUrl: null,
  lastMessageAt: null,
  lastMessagePreview: null,
  lastMessageDirection: null,
  unreadCount: 0,
  assignedUserId: null,
  assignedAt: null,
  resolvedAt: null,
  lastInboundAt: null,
  botPausedAt: null,
  contact: null,
  instance: { name: 'Canal', botId: null, provider: 'EVOLUTION', bot: null },
  assignedUser: null,
};

function summarize(over: Record<string, unknown> = {}) {
  return toConversationSummary({ ...baseRow, ...over } as never);
}

const atendente = (over: Record<string, unknown> = {}) => ({
  assignedUserId: 'u1',
  assignedUser: {
    name: 'Atendente A',
    isActive: true,
    hasAccess: true,
    ...over,
  },
});

describe('toConversationSummary situação (K1)', () => {
  it('aceite 1: sem resolvedAt e sem atendente — PENDING', () => {
    const s = summarize();
    expect(s.status).toBe('PENDING');
    expect(s.resolvedAt).toBeNull();
  });

  it('aceite 1: com atendente — IN_PROGRESS', () => {
    expect(summarize(atendente()).status).toBe('IN_PROGRESS');
  });

  it('aceite 1: com resolvedAt — RESOLVED (mesmo com atendente)', () => {
    const resolvedAt = new Date('2026-11-21T15:00:00.000Z');
    expect(summarize({ resolvedAt }).status).toBe('RESOLVED');
    expect(summarize({ ...atendente(), resolvedAt }).status).toBe('RESOLVED');
  });

  it('aceite 10: atendente inativo ou sem acesso — assignedUserActive false; sem atendente — null', () => {
    expect(summarize(atendente()).assignedUserActive).toBe(true);
    expect(summarize(atendente({ isActive: false })).assignedUserActive).toBe(
      false,
    );
    expect(summarize(atendente({ hasAccess: false })).assignedUserActive).toBe(
      false,
    );
    expect(summarize().assignedUserActive).toBeNull();
  });

  it('lastInboundAt e resolvedAt em ISO', () => {
    const s = summarize({
      resolvedAt: new Date('2026-11-21T15:00:00.000Z'),
      lastInboundAt: new Date('2026-11-21T14:30:00.000Z'),
    });
    expect(s.resolvedAt).toBe('2026-11-21T15:00:00.000Z');
    expect(s.lastInboundAt).toBe('2026-11-21T14:30:00.000Z');
    expect(summarize().lastInboundAt).toBeNull();
  });
});
