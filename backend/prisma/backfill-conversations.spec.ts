import { describe, it, expect, beforeEach } from 'vitest';
import { mockDeep, type DeepMockProxy } from 'vitest-mock-extended';
import type { PrismaClient } from '@prisma/client';
import {
  remoteJidFromPhone,
  backfillConversations,
  refreshConversationSummary,
} from './backfill-conversations';

describe('remoteJidFromPhone', () => {
  it('converts E.164 to a WhatsApp direct JID', () => {
    expect(remoteJidFromPhone('+5592999999999')).toBe('5592999999999@s.whatsapp.net');
  });
  it('strips non-digits', () => {
    expect(remoteJidFromPhone('+55 (92) 99999-9999')).toBe('5592999999999@s.whatsapp.net');
  });
});

/**
 * O sintoma relatado em produção (bolha na thread, mas a linha da conversa sem
 * preview E sem horário) nasce aqui: o backfill ligava a Message à Conversation
 * e nunca escrevia o resumo denormalizado — que é o que a lista lateral lê.
 */
describe('backfillConversations', () => {
  let db: DeepMockProxy<PrismaClient>;

  beforeEach(() => {
    db = mockDeep<PrismaClient>();
  });

  it('avança o resumo da conversa (lastMessageAt/preview/direction) das conversas que tocou', async () => {
    db.message.findMany.mockResolvedValue([
      { id: 'm1', contactId: 'c1', instanceId: 'i1', queuedAt: new Date('2026-07-11T12:02:00Z'), contact: { phoneE164: '+5592995550101' } },
    ] as never);
    db.conversation.findFirst.mockResolvedValue({ id: 'conv-1', contactId: 'c1', lastMessageAt: null } as never);
    db.conversation.findUnique.mockResolvedValue({ lastMessageAt: null } as never);
    db.message.findFirst.mockResolvedValue({
      createdAt: new Date('2026-07-11T12:02:00Z'), content: 'Olá Andre', direction: 'OUTBOUND',
    } as never);

    const res = await backfillConversations(db);

    expect(res).toEqual({ conversations: 1, messages: 1 });
    expect(db.conversation.update).toHaveBeenCalledWith({
      where: { id: 'conv-1' },
      data: {
        lastMessageAt: new Date('2026-07-11T12:02:00Z'),
        lastMessagePreview: 'Olá Andre',
        lastMessageDirection: 'OUTBOUND',
      },
    });
  });

  it('reaproveita a conversa existente do contato em vez de fabricar um JID novo', async () => {
    db.message.findMany.mockResolvedValue([
      { id: 'm1', contactId: 'c1', instanceId: 'i1', queuedAt: new Date(), contact: { phoneE164: '+5592995550101' } },
    ] as never);
    db.conversation.findFirst.mockResolvedValue({ id: 'conv-lid', contactId: 'c1', lastMessageAt: null } as never);
    db.conversation.findUnique.mockResolvedValue({ lastMessageAt: null } as never);
    db.message.findFirst.mockResolvedValue(null as never);

    await backfillConversations(db);

    expect(db.conversation.upsert).not.toHaveBeenCalled();
    expect(db.message.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'm1' }, data: expect.objectContaining({ conversationId: 'conv-lid' }) }),
    );
  });
});

describe('refreshConversationSummary', () => {
  let db: DeepMockProxy<PrismaClient>;
  beforeEach(() => { db = mockDeep<PrismaClient>(); });

  it('não puxa o resumo para trás (monotonicidade)', async () => {
    db.conversation.findUnique.mockResolvedValue({ lastMessageAt: new Date('2026-07-11T18:00:00Z') } as never);
    db.message.findFirst.mockResolvedValue({
      createdAt: new Date('2026-07-11T12:00:00Z'), content: 'antiga', direction: 'OUTBOUND',
    } as never);

    await refreshConversationSummary(db, 'conv-1');

    expect(db.conversation.update).not.toHaveBeenCalled();
  });
});
