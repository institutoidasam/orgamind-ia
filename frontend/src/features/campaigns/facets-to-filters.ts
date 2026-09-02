import type { FacetSelection } from './components/facet-filters';
import type { FilterGroup, Rule } from './schemas';

/**
 * Convert facet checkbox selections to a FilterGroup tree compatible with
 * the backend. Selecting multiple cities means OR within cities; selecting
 * cities + groups means AND across categories.
 *
 * Examples:
 *  cities = []                    → empty AND group (matches all active)
 *  cities = [Manaus]              → AND[city=Manaus]
 *  cities = [Manaus, SP]          → AND[OR[city=Manaus, city=SP]]
 *  cities=[Manaus], groups=[a,b]  → AND[ city=Manaus, OR[group=a, group=b] ]
 */
export function facetsToFilterGroup(sel: FacetSelection): FilterGroup {
  const groups: Array<Rule | FilterGroup> = [];

  if (sel.cities.length === 1) {
    groups.push({ field: 'city', op: 'eq', value: sel.cities[0] });
  } else if (sel.cities.length > 1) {
    groups.push({
      combinator: 'or',
      rules: sel.cities.map(
        (v) => ({ field: 'city', op: 'eq', value: v }) as Rule,
      ),
    });
  }

  if (sel.groups.length === 1) {
    groups.push({ field: 'group', op: 'eq', value: sel.groups[0] });
  } else if (sel.groups.length > 1) {
    groups.push({
      combinator: 'or',
      rules: sel.groups.map(
        (v) => ({ field: 'group', op: 'eq', value: v }) as Rule,
      ),
    });
  }

  // Tags use 'contains' (string array contains the value)
  if (sel.tags.length === 1) {
    groups.push({ field: 'tags', op: 'contains', value: sel.tags[0] });
  } else if (sel.tags.length > 1) {
    groups.push({
      combinator: 'or',
      rules: sel.tags.map(
        (v) => ({ field: 'tags', op: 'contains', value: v }) as Rule,
      ),
    });
  }

  return { combinator: 'and', rules: groups };
}
