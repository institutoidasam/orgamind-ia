import type { FilterGroup, HistoryRule } from './schemas';

export type HistoryExclusionSelection = {
  campaignIds: string[];
  templateIds: string[];
};

/**
 * F1 T7 — "Excluir quem já recebeu". Combines `base` (whatever the operator
 * built via facets or the advanced FilterBuilder) with a single
 * `{kind:'history', event:'received', negate:true, ...}` node that excludes
 * contacts who already received a message from the chosen campaigns/templates.
 *
 * `base` is wrapped under a FRESH top-level AND group together with the
 * history node, instead of pushing the node into `base.rules` directly:
 * `base`'s own combinator can be 'or' (both facets-with-multiple-values and
 * the advanced builder allow it), and the exclusion must always apply on top
 * of the rest regardless of how those rules combine internally.
 *
 * Returns `base` UNCHANGED (same reference) when neither campaignIds nor
 * templateIds has anything selected — never an empty history node. The
 * backend/front schema (`historyRuleSchema`, F1 T6) REJECTS a history rule
 * with no target (it would otherwise silently match "any send", i.e. nothing
 * or everything) — so "nothing selected" must mean "no node", not "a node
 * with an empty target".
 */
export function materializeHistoryExclusion(
  base: FilterGroup,
  campaignIds: string[],
  templateIds: string[],
): FilterGroup {
  if (campaignIds.length === 0 && templateIds.length === 0) return base;

  const historyRule: HistoryRule = {
    kind: 'history',
    event: 'received',
    negate: true,
    ...(campaignIds.length > 0 ? { campaignIds } : {}),
    ...(templateIds.length > 0 ? { templateIds } : {}),
  };

  return {
    combinator: 'and',
    rules: [base, historyRule],
  };
}
