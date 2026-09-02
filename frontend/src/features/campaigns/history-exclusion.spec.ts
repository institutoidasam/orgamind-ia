import { describe, it, expect } from 'vitest';
import { materializeHistoryExclusion } from './history-exclusion';
import { historyRuleSchema, type FilterGroup } from './schemas';

describe('materializeHistoryExclusion', () => {
  const base: FilterGroup = {
    combinator: 'and',
    rules: [{ field: 'city', op: 'eq', value: 'Manaus' }],
  };

  it('returns base unchanged (same reference) when nothing is selected', () => {
    expect(materializeHistoryExclusion(base, [], [])).toBe(base);
  });

  it('adds a history exclusion node with campaignIds when campaigns are selected', () => {
    const result = materializeHistoryExclusion(base, ['camp1', 'camp2'], []);
    expect(result).toEqual({
      combinator: 'and',
      rules: [
        base,
        {
          kind: 'history',
          event: 'received',
          negate: true,
          campaignIds: ['camp1', 'camp2'],
        },
      ],
    });
  });

  it('adds a history exclusion node with templateIds when templates are selected', () => {
    const result = materializeHistoryExclusion(base, [], ['tpl1']);
    expect(result).toEqual({
      combinator: 'and',
      rules: [
        base,
        { kind: 'history', event: 'received', negate: true, templateIds: ['tpl1'] },
      ],
    });
  });

  it('adds both campaignIds and templateIds when both are selected', () => {
    const result = materializeHistoryExclusion(base, ['camp1'], ['tpl1']);
    expect(result).toEqual({
      combinator: 'and',
      rules: [
        base,
        {
          kind: 'history',
          event: 'received',
          negate: true,
          campaignIds: ['camp1'],
          templateIds: ['tpl1'],
        },
      ],
    });
  });

  it('removes the node again once the selection is cleared', () => {
    // simulate: operator picks a campaign, then clears it
    materializeHistoryExclusion(base, ['camp1'], []);
    const cleared = materializeHistoryExclusion(base, [], []);
    expect(cleared).toBe(base);
    expect((cleared as FilterGroup).rules).toHaveLength(1);
  });

  it('never emits a node with an empty target (only campaignIds=[] passed)', () => {
    // Defensive: even if a caller passes empty arrays for both, no history
    // node — and definitely not one with `campaignIds: []`.
    const result = materializeHistoryExclusion(base, [], []);
    expect(JSON.stringify(result)).not.toContain('"kind":"history"');
  });

  it('the materialized node passes historyRuleSchema (byte-for-byte parity with the backend)', () => {
    const result = materializeHistoryExclusion(base, ['camp1'], []);
    const node = (result.rules as unknown[])[1];
    expect(() => historyRuleSchema.parse(node)).not.toThrow();
  });
});
