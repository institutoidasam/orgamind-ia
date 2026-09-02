import { describe, it, expect } from 'vitest';
import { filterGroupSchema, historyRuleSchema, ruleSchema } from './filter.schema';

/**
 * Médio — filter.schema must restrict op/value pairs so a malformed rule can
 * never produce an invalid Prisma `where` that crashes (500) the scheduled
 * dispatch path. Examples the old schema let through:
 *   { field:'name', op:'in', value:'x' }  → { name: { in: 'x' } }  ← Prisma 500
 */
describe('ruleSchema — op/value pairing', () => {
  describe('in / notIn require a string array', () => {
    it.each(['in', 'notIn'] as const)(
      'rejects %s with a scalar string value',
      (op) => {
        const parsed = ruleSchema.safeParse({ field: 'city', op, value: 'x' });
        expect(parsed.success).toBe(false);
      },
    );

    it.each(['in', 'notIn'] as const)('accepts %s with a string array', (op) => {
      const parsed = ruleSchema.safeParse({
        field: 'city',
        op,
        value: ['a', 'b'],
      });
      expect(parsed.success).toBe(true);
    });

    it.each(['in', 'notIn'] as const)('rejects %s with a missing value', (op) => {
      const parsed = ruleSchema.safeParse({ field: 'city', op });
      expect(parsed.success).toBe(false);
    });

    it.each(['in', 'notIn'] as const)('rejects %s with a number value', (op) => {
      const parsed = ruleSchema.safeParse({ field: 'city', op, value: 3 });
      expect(parsed.success).toBe(false);
    });
  });

  describe('whatsappValid only allows eq/ne with a boolean', () => {
    it('accepts whatsappValid eq boolean', () => {
      const parsed = ruleSchema.safeParse({
        field: 'whatsappValid',
        op: 'eq',
        value: true,
      });
      expect(parsed.success).toBe(true);
    });

    it('accepts whatsappValid ne boolean', () => {
      const parsed = ruleSchema.safeParse({
        field: 'whatsappValid',
        op: 'ne',
        value: false,
      });
      expect(parsed.success).toBe(true);
    });

    it('rejects whatsappValid eq with a non-boolean', () => {
      const parsed = ruleSchema.safeParse({
        field: 'whatsappValid',
        op: 'eq',
        value: 'true',
      });
      expect(parsed.success).toBe(false);
    });

    it.each(['contains', 'startsWith', 'endsWith', 'in', 'notIn'] as const)(
      'rejects whatsappValid with op %s',
      (op) => {
        const parsed = ruleSchema.safeParse({
          field: 'whatsappValid',
          op,
          value: op === 'in' || op === 'notIn' ? ['x'] : 'x',
        });
        expect(parsed.success).toBe(false);
      },
    );
  });

  describe('contains / startsWith / endsWith require a string value', () => {
    it.each(['contains', 'startsWith', 'endsWith'] as const)(
      'accepts %s with a string on a text field',
      (op) => {
        const parsed = ruleSchema.safeParse({ field: 'name', op, value: 'x' });
        expect(parsed.success).toBe(true);
      },
    );

    it.each(['startsWith', 'endsWith'] as const)(
      'rejects %s with an array value',
      (op) => {
        const parsed = ruleSchema.safeParse({
          field: 'name',
          op,
          value: ['x'],
        });
        expect(parsed.success).toBe(false);
      },
    );

    it.each(['contains', 'startsWith', 'endsWith'] as const)(
      'rejects %s with a missing value',
      (op) => {
        const parsed = ruleSchema.safeParse({ field: 'name', op });
        expect(parsed.success).toBe(false);
      },
    );

    it('accepts contains on tags (array-membership) with a string', () => {
      const parsed = ruleSchema.safeParse({
        field: 'tags',
        op: 'contains',
        value: 'vip',
      });
      expect(parsed.success).toBe(true);
    });
  });

  describe('eq / ne require a value', () => {
    it('accepts eq with a string', () => {
      const parsed = ruleSchema.safeParse({
        field: 'city',
        op: 'eq',
        value: 'Manaus',
      });
      expect(parsed.success).toBe(true);
    });

    it('rejects eq with a missing value', () => {
      const parsed = ruleSchema.safeParse({ field: 'city', op: 'eq' });
      expect(parsed.success).toBe(false);
    });

    it.each(['eq', 'ne'] as const)(
      'rejects %s with an array value (scalar equality only)',
      (op) => {
        const parsed = ruleSchema.safeParse({
          field: 'name',
          op,
          value: ['x', 'y'],
        });
        expect(parsed.success).toBe(false);
      },
    );
  });

  describe('isNull / notNull must NOT carry a value', () => {
    it.each(['isNull', 'notNull'] as const)('accepts %s with no value', (op) => {
      const parsed = ruleSchema.safeParse({ field: 'city', op });
      expect(parsed.success).toBe(true);
    });

    it.each(['isNull', 'notNull'] as const)(
      'rejects %s when a value is supplied',
      (op) => {
        const parsed = ruleSchema.safeParse({ field: 'city', op, value: 'x' });
        expect(parsed.success).toBe(false);
      },
    );
  });
});

describe('filterGroupSchema — nested rules are validated', () => {
  it('rejects a nested group containing an invalid in-rule', () => {
    const parsed = filterGroupSchema.safeParse({
      combinator: 'and',
      rules: [
        { field: 'city', op: 'eq', value: 'Manaus' },
        {
          combinator: 'or',
          rules: [{ field: 'group', op: 'in', value: 'alunos' }],
        },
      ],
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts a valid nested group', () => {
    const parsed = filterGroupSchema.safeParse({
      combinator: 'and',
      rules: [
        { field: 'city', op: 'eq', value: 'Manaus' },
        {
          combinator: 'or',
          rules: [{ field: 'group', op: 'in', value: ['alunos', 'pais'] }],
        },
      ],
    });
    expect(parsed.success).toBe(true);
  });
});

/**
 * historyRuleSchema — foundation node for F1 (excluir quem já recebeu).
 * F2 lights up `event:'failed'` and swaps `failureReason` for a
 * z.nativeEnum(FailureReason) (the only reopening of this contract by F2 —
 * pure type tightening, no new event/field). F3 lights up `event:'replied'`.
 */
describe('historyRuleSchema', () => {
  it('accepts a received node with non-empty campaignIds', () => {
    const parsed = historyRuleSchema.safeParse({
      kind: 'history',
      event: 'received',
      negate: false,
      campaignIds: ['camp-1'],
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts a node with only templateIds (no campaignIds)', () => {
    const parsed = historyRuleSchema.safeParse({
      kind: 'history',
      event: 'received',
      negate: true,
      templateIds: ['tpl-1'],
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects an empty target — both campaignIds and templateIds absent', () => {
    const parsed = historyRuleSchema.safeParse({
      kind: 'history',
      event: 'received',
      negate: false,
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects an empty target — both campaignIds and templateIds are []', () => {
    const parsed = historyRuleSchema.safeParse({
      kind: 'history',
      event: 'received',
      negate: false,
      campaignIds: [],
      templateIds: [],
    });
    expect(parsed.success).toBe(false);
  });

  // Médio (review F1 T2): o issue de alvo-vazio não pode ficar preso só em
  // `campaignIds` — senão o front não tem como saber marcar `templateIds`
  // quando foi ESSE o campo que o operador tentou (e falhou) preencher.
  it('flags an empty target on BOTH campaignIds and templateIds paths, not just campaignIds', () => {
    const parsed = historyRuleSchema.safeParse({
      kind: 'history',
      event: 'received',
      negate: false,
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) throw new Error('unreachable');
    const paths = parsed.error.issues.map((i) => i.path.join('.'));
    expect(paths).toContain('campaignIds');
    expect(paths).toContain('templateIds');
  });

  it('rejects failureReason when event is not "failed"', () => {
    const parsed = historyRuleSchema.safeParse({
      kind: 'history',
      event: 'received',
      negate: false,
      campaignIds: ['camp-1'],
      failureReason: 'SEM_WHATSAPP',
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts failureReason when event is "failed"', () => {
    const parsed = historyRuleSchema.safeParse({
      kind: 'history',
      event: 'failed',
      negate: false,
      campaignIds: ['camp-1'],
      failureReason: 'SEM_WHATSAPP',
    });
    expect(parsed.success).toBe(true);
  });

  // F2 T5: failureReason apertou de z.string().min(1) para
  // z.nativeEnum(FailureReason) — um valor fora dos 11 do enum (mesmo sendo
  // uma string não-vazia) tem que ser rejeitado.
  it('rejects a failureReason outside the FailureReason enum', () => {
    const parsed = historyRuleSchema.safeParse({
      kind: 'history',
      event: 'failed',
      negate: false,
      campaignIds: ['camp-1'],
      failureReason: 'not-a-real-reason',
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects an empty-string failureReason', () => {
    const parsed = historyRuleSchema.safeParse({
      kind: 'history',
      event: 'failed',
      negate: false,
      campaignIds: ['camp-1'],
      failureReason: '',
    });
    expect(parsed.success).toBe(false);
  });

  it('validates a history node nested inside a filterGroupSchema group', () => {
    const parsed = filterGroupSchema.safeParse({
      combinator: 'and',
      rules: [
        { field: 'city', op: 'eq', value: 'Manaus' },
        {
          kind: 'history',
          event: 'received',
          negate: false,
          campaignIds: ['camp-1'],
        },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects a nested group containing an invalid (empty-target) history node', () => {
    const parsed = filterGroupSchema.safeParse({
      combinator: 'and',
      rules: [
        {
          combinator: 'or',
          rules: [{ kind: 'history', event: 'received', negate: false }],
        },
      ],
    });
    expect(parsed.success).toBe(false);
  });
});

describe('ruleSchema — lastFailureReason (B.4)', () => {
  it('aceita notIn com motivos reais do enum', () => {
    const r = ruleSchema.safeParse({
      field: 'lastFailureReason',
      op: 'notIn',
      value: ['SEM_WHATSAPP', 'TELEFONE_INVALIDO'],
    });
    expect(r.success).toBe(true);
  });

  it('aceita isNull sem valor', () => {
    const r = ruleSchema.safeParse({ field: 'lastFailureReason', op: 'isNull' });
    expect(r.success).toBe(true);
  });

  // Um valor fora do enum não identifica motivo nenhum — mesma razão do
  // historyRuleSchema.failureReason (F2 T5).
  it('recusa valor fora do enum FailureReason', () => {
    const r = ruleSchema.safeParse({
      field: 'lastFailureReason',
      op: 'notIn',
      value: ['NAO_EXISTE'],
    });
    expect(r.success).toBe(false);
  });

  it('recusa operadores de texto (contains) — é uma coluna de enum', () => {
    const r = ruleSchema.safeParse({
      field: 'lastFailureReason',
      op: 'contains',
      value: 'SEM',
    });
    expect(r.success).toBe(false);
  });

  it('recusa notIn com array vazio (filtro que não filtra nada)', () => {
    const r = ruleSchema.safeParse({
      field: 'lastFailureReason',
      op: 'notIn',
      value: [],
    });
    expect(r.success).toBe(false);
  });
});
