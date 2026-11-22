import { describe, expect, it } from 'vitest';
import {
  HANDOVER_MAX_CONVERSATIONS,
  listConversationsQuerySchema,
} from '../../schemas/contracts/chat.schema';
import { ShiftHandoverDto } from './dto/shift-handover.dto';

const ids = (n: number) => Array.from({ length: n }, (_, i) => `c${i + 1}`);
const parse = (over: Record<string, unknown> = {}) =>
  ShiftHandoverDto.schema.safeParse({
    toUserId: 'bia',
    note: 'Turno da noite',
    conversationIds: ids(2),
    ...over,
  });

describe('shiftHandoverSchema — passagem de conversas (K3-1, DT5)', () => {
  it('observação só espaços falha; 201 falha; aparada', () => {
    expect(parse({ note: '   ' }).success).toBe(false);
    expect(parse({ note: 'x'.repeat(201) }).success).toBe(false);
    expect(parse({ note: 'x'.repeat(200) }).success).toBe(true);
    const parsed = parse({ note: '  Atenção ao caso do João  ' });
    expect(parsed.success && parsed.data.note).toBe('Atenção ao caso do João');
  });

  it('lista vazia, repetida ou com 101 conversas falha', () => {
    expect(parse({ conversationIds: [] }).success).toBe(false);
    expect(parse({ conversationIds: ['c1', 'c2', 'c1'] }).success).toBe(false);
    expect(
      parse({ conversationIds: ids(HANDOVER_MAX_CONVERSATIONS + 1) }).success,
    ).toBe(false);
    expect(
      parse({ conversationIds: ids(HANDOVER_MAX_CONVERSATIONS) }).success,
    ).toBe(true);
  });

  it('fromUserId opcional', () => {
    expect(parse().success).toBe(true);
    expect(parse({ fromUserId: 'ana' }).success).toBe(true);
    expect(parse({ fromUserId: '' }).success).toBe(false);
  });
});

describe('listConversationsQuerySchema — filtro handover (K3-3, DT3)', () => {
  it('handover só true/false; ausente segue ausente', () => {
    expect(listConversationsQuerySchema.parse({}).handover).toBeUndefined();
    expect(
      listConversationsQuerySchema.parse({ handover: 'true' }).handover,
    ).toBe('true');
    expect(
      listConversationsQuerySchema.safeParse({ handover: 'sim' }).success,
    ).toBe(false);
  });
});
