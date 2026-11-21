import { describe, expect, it } from 'vitest';
import {
  PENDENCY_HANDOVER_MAX,
  pendencyListQuerySchema,
} from '../../schemas/contracts/team-pendency.schema';
import { PendencyHandoverDto } from './dto/pendency-handover.dto';
import { PendencyHandoverTargetsQueryDto } from './dto/pendency-handover-targets-query.dto';

const ids = (n: number) => Array.from({ length: n }, (_, i) => `p${i + 1}`);
const parse = (over: Record<string, unknown> = {}) =>
  PendencyHandoverDto.schema.safeParse({
    toUserId: 'bia',
    note: 'Fim do plantão',
    pendencyIds: ids(2),
    ...over,
  });

describe('pendencyHandoverSchema — passagem de pendências (K3-4, DT5)', () => {
  it('observação só espaços falha; 201 falha; aparada', () => {
    expect(parse({ note: '   ' }).success).toBe(false);
    expect(parse({ note: 'x'.repeat(201) }).success).toBe(false);
    expect(parse({ note: 'x'.repeat(200) }).success).toBe(true);
    const parsed = parse({ note: '  Ligar de volta  ' });
    expect(parsed.success && parsed.data.note).toBe('Ligar de volta');
  });

  it('lista vazia, repetida ou com 51 pendências falha', () => {
    expect(parse({ pendencyIds: [] }).success).toBe(false);
    expect(parse({ pendencyIds: ['p1', 'p1'] }).success).toBe(false);
    expect(parse({ pendencyIds: ids(PENDENCY_HANDOVER_MAX + 1) }).success).toBe(
      false,
    );
    expect(parse({ pendencyIds: ids(PENDENCY_HANDOVER_MAX) }).success).toBe(
      true,
    );
  });

  it('fromUserId opcional, na passagem e na lista de destinos', () => {
    expect(parse().success).toBe(true);
    expect(parse({ fromUserId: 'ana' }).success).toBe(true);
    const targets = PendencyHandoverTargetsQueryDto.schema;
    expect(targets.parse({})).toEqual({});
    expect(targets.parse({ fromUserId: 'ana' })).toEqual({ fromUserId: 'ana' });
    expect(targets.safeParse({ fromUserId: '' }).success).toBe(false);
  });
});

describe('pendencyListQuerySchema — filtro handlerId (K3-4, CT2)', () => {
  it('handlerId opcional', () => {
    expect(pendencyListQuerySchema.parse({}).handlerId).toBeUndefined();
    expect(pendencyListQuerySchema.parse({ handlerId: 'ana' }).handlerId).toBe(
      'ana',
    );
    expect(pendencyListQuerySchema.safeParse({ handlerId: '' }).success).toBe(
      false,
    );
  });
});
