import { describe, expect, it } from 'vitest';
import {
  assignConversationSchema,
  listConversationsQuerySchema,
  reopenConversationSchema,
  resolveConversationSchema,
} from '../../schemas/contracts/chat.schema';

describe('assignConversationSchema (K1)', () => {
  it('aceite 8: assign sem expectedAssigneeId falha; com null passa', () => {
    expect(assignConversationSchema.safeParse({ userId: 'u1' }).success).toBe(
      false,
    );
    const ok = assignConversationSchema.safeParse({
      userId: 'u1',
      expectedAssigneeId: null,
    });
    expect(ok.success).toBe(true);
    expect(
      assignConversationSchema.safeParse({
        userId: null,
        expectedAssigneeId: 'u2',
      }).success,
    ).toBe(true);
  });
});

describe('resolveConversationSchema e reopenConversationSchema (K1)', () => {
  it('resolve sem expectedLastInboundAt falha; com null passa; data inválida falha', () => {
    expect(
      resolveConversationSchema.safeParse({ expectedAssigneeId: 'u1' }).success,
    ).toBe(false);
    expect(
      resolveConversationSchema.safeParse({ expectedLastInboundAt: null })
        .success,
    ).toBe(false);
    expect(
      resolveConversationSchema.safeParse({
        expectedAssigneeId: null,
        expectedLastInboundAt: null,
      }).success,
    ).toBe(true);
    expect(
      resolveConversationSchema.safeParse({
        expectedAssigneeId: 'u1',
        expectedLastInboundAt: '2026-11-21T12:00:00.000Z',
      }).success,
    ).toBe(true);
    expect(
      resolveConversationSchema.safeParse({
        expectedAssigneeId: 'u1',
        expectedLastInboundAt: 'ontem',
      }).success,
    ).toBe(false);
  });

  it('note com 201 caracteres falha; só espaços vira vazia', () => {
    const base = { expectedAssigneeId: null, expectedLastInboundAt: null };
    expect(
      resolveConversationSchema.safeParse({ ...base, note: 'x'.repeat(201) })
        .success,
    ).toBe(false);
    expect(
      reopenConversationSchema.safeParse({ note: 'x'.repeat(200) }).success,
    ).toBe(true);
    expect(reopenConversationSchema.parse({ note: '   ' })).toEqual({
      note: '',
    });
    expect(reopenConversationSchema.parse({})).toEqual({});
  });
});

describe('listConversationsQuerySchema status (K1)', () => {
  it('lista: status padrão open; aceita resolved; recusa outro valor', () => {
    expect(listConversationsQuerySchema.parse({}).status).toBe('open');
    expect(
      listConversationsQuerySchema.parse({ status: 'resolved' }).status,
    ).toBe('resolved');
    expect(
      listConversationsQuerySchema.safeParse({ status: 'archived' }).success,
    ).toBe(false);
  });
});
