import { describe, it, expect, vi } from 'vitest';
import {
  parseConversationsPage,
  parseConversationSummary,
  parseMessagesPage,
  parseChatMessage,
  type ConversationSummary,
  type ChatMessage,
} from './schemas';

const validConversation: ConversationSummary = {
  id: 'c1', instanceId: 'i1', instanceName: 'A', remoteJid: 'j@s', phoneE164: '+55',
  contactId: null, displayName: 'Cliente', waName: null, profilePicUrl: null,
  lastMessageAt: null, lastMessagePreview: null, lastMessageDirection: null, unreadCount: 0,
};

const validMessage: ChatMessage = {
  id: 'm1', conversationId: 'c1', direction: 'INBOUND', kind: 'TEXT', content: 'oi', status: 'RECEIVED',
  providerMessageId: 'p', quotedWaMessageId: null, quotedPreview: null, createdAt: '2026-06-05T00:00:00Z',
  sentAt: null, deliveredAt: null, readAt: null, receivedAt: null, media: null,
};

describe('chat schema boundary validation (Baixo)', () => {
  it('parses a valid conversations page through the schema (real runtime validation)', () => {
    const raw = { items: [validConversation], total: 1, page: 1, pageSize: 30 };
    const parsed = parseConversationsPage(raw);
    expect(parsed.items[0].id).toBe('c1');
    expect(parsed.total).toBe(1);
  });

  it('parses a valid messages page through the schema', () => {
    const raw = { items: [validMessage], nextCursor: null };
    const parsed = parseMessagesPage(raw);
    expect(parsed.items[0].id).toBe('m1');
    expect(parsed.nextCursor).toBeNull();
  });

  it('validates each item — a malformed conversation does not silently pass as a valid one', () => {
    // unreadCount is required to be a number; a string is schema drift.
    const bad = { ...validConversation, unreadCount: 'lots' as unknown as number };
    // Boundary must NOT pretend this matched the schema cleanly. It should warn.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    parseConversationsPage({ items: [bad], total: 1, page: 1, pageSize: 30 });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('is resilient to drift — does not throw on an unexpected shape', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => parseConversationSummary({ id: 'c', nope: true })).not.toThrow();
    expect(() => parseChatMessage({ id: 'm', whoops: 1 })).not.toThrow();
    warn.mockRestore();
  });

  // T7 (twilio-platform): fim da janela de 24h no resumo da conversa.
  it('aceita twilioWindowExpiresAt como ISO string, null ou ausente — sem warning de drift', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const withIso = parseConversationSummary({ ...validConversation, twilioWindowExpiresAt: '2026-07-10T12:00:00.000Z' });
    expect(withIso.twilioWindowExpiresAt).toBe('2026-07-10T12:00:00.000Z');
    const withNull = parseConversationSummary({ ...validConversation, twilioWindowExpiresAt: null });
    expect(withNull.twilioWindowExpiresAt).toBeNull();
    // Ausente (backend antigo / cache): parse limpo, campo undefined.
    const absent = parseConversationSummary(validConversation);
    expect(absent.twilioWindowExpiresAt).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
