import { describe, it, expect } from 'vitest';
import {
  createSegmentSchema,
  updateSegmentSchema,
} from '../../schemas/contracts/segment.schema';

describe('createSegmentSchema', () => {
  it('accepts a valid segment with a FilterGroup', () => {
    const parsed = createSegmentSchema.safeParse({
      name: 'VIP de Manaus',
      description: 'opcional',
      filters: {
        combinator: 'and',
        rules: [{ field: 'city', op: 'eq', value: 'Manaus' }],
      },
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects an empty name', () => {
    const parsed = createSegmentSchema.safeParse({
      name: '',
      filters: { combinator: 'and', rules: [] },
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects an invalid FilterGroup (bad combinator)', () => {
    const parsed = createSegmentSchema.safeParse({
      name: 'X',
      filters: { combinator: 'xor', rules: [] },
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects an invalid rule field (optedOut is intentionally not filterable)', () => {
    const parsed = createSegmentSchema.safeParse({
      name: 'X',
      filters: {
        combinator: 'and',
        rules: [{ field: 'optedOut', op: 'eq', value: true }],
      },
    });
    expect(parsed.success).toBe(false);
  });

  it('requires filters', () => {
    const parsed = createSegmentSchema.safeParse({ name: 'X' });
    expect(parsed.success).toBe(false);
  });
});

describe('updateSegmentSchema', () => {
  it('accepts a partial patch (description only)', () => {
    const parsed = updateSegmentSchema.safeParse({ description: 'novo' });
    expect(parsed.success).toBe(true);
  });

  it('still rejects an invalid FilterGroup in a patch', () => {
    const parsed = updateSegmentSchema.safeParse({
      filters: { combinator: 'and', rules: [{ field: 'nope', op: 'eq' }] },
    });
    expect(parsed.success).toBe(false);
  });
});
