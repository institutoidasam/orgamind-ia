import { describe, expect, it } from 'vitest';
import {
  assumePendencySchema,
  closePendencySchema,
  OPEN_PENDENCY_SITUATIONS,
  pendencyListQuerySchema,
  pendencyNoteSchema,
  reopenPendencySchema,
  transferPendencySchema,
} from './team-pendency.schema';

const ok =
  (schema: { safeParse: (v: unknown) => { success: boolean } }) =>
  (value: unknown) =>
    schema.safeParse(value).success;

describe('pendencyListQuerySchema (CK2)', () => {
  const parse = (query: Record<string, unknown>) =>
    pendencyListQuerySchema.safeParse(query);

  it('situations ausente vira as três abertas; valor desconhecido falha; repetido falha', () => {
    expect(pendencyListQuerySchema.parse({}).situations).toEqual(
      OPEN_PENDENCY_SITUATIONS,
    );
    expect(
      pendencyListQuerySchema.parse({ situations: 'ACKED,CLOSED' }).situations,
    ).toEqual(['ACKED', 'CLOSED']);
    expect(parse({ situations: 'ACKED,PENDING' }).success).toBe(false);
    expect(parse({ situations: 'ACKED,ACKED' }).success).toBe(false);
    expect(parse({ situations: '' }).success).toBe(false);
  });

  it('days aceita 7 e 30; 14 falha; padrão 7', () => {
    expect(pendencyListQuerySchema.parse({}).days).toBe(7);
    expect(pendencyListQuerySchema.parse({ days: '7' }).days).toBe(7);
    expect(pendencyListQuerySchema.parse({ days: '30' }).days).toBe(30);
    expect(parse({ days: '14' }).success).toBe(false);
  });

  it('pageSize acima de 50 falha', () => {
    expect(pendencyListQuerySchema.parse({}).pageSize).toBe(20);
    expect(parse({ pageSize: '50' }).success).toBe(true);
    expect(parse({ pageSize: '51' }).success).toBe(false);
  });
});

describe('corpos das ações da pendência (CK2)', () => {
  it('assume sem expectedHandlerId falha; com null passa; note só espaços vira vazia', () => {
    expect(ok(assumePendencySchema)({})).toBe(false);
    expect(ok(assumePendencySchema)({ expectedHandlerId: null })).toBe(true);
    expect(
      assumePendencySchema.parse({ expectedHandlerId: 'u1', note: '   ' }).note,
    ).toBe('');
  });

  it('note de contato e motivo: vazios falham; 201 caracteres falham', () => {
    const base = { expectedHandlerId: 'u1' };
    const forms: [string, (v: string) => boolean][] = [
      ['text', (v) => ok(pendencyNoteSchema)({ ...base, text: v })],
      ['reason', (v) => ok(closePendencySchema)({ ...base, reason: v })],
    ];
    for (const [, accepts] of forms) {
      expect(accepts('   ')).toBe(false);
      expect(accepts('')).toBe(false);
      expect(accepts('a'.repeat(200))).toBe(true);
      expect(accepts('a'.repeat(201))).toBe(false);
    }
  });

  it('transfer exige toUserId', () => {
    expect(ok(transferPendencySchema)({ expectedHandlerId: null })).toBe(false);
    expect(
      ok(transferPendencySchema)({ toUserId: '', expectedHandlerId: null }),
    ).toBe(false);
    expect(
      ok(transferPendencySchema)({ toUserId: 'u2', expectedHandlerId: null }),
    ).toBe(true);
    expect(ok(reopenPendencySchema)({})).toBe(false);
  });
});
