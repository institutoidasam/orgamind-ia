import { useQuery, queryOptions } from '@tanstack/react-query';
import { api } from '@/lib/api-client';

export type FacetEntry = { value: string; count: number };

export type ContactFacets = {
  totalActive: number;
  totalOptedOut: number;
  cities: FacetEntry[];
  groups: FacetEntry[];
  tags: FacetEntry[];
};

// Use a sibling key (not a child of `['contacts']`) so the staleTime below
// isn't blown away by every contact mutation. `useCreateContact` and friends
// invalidate `['contacts']`, which prefix-matches `['contacts', 'facets']`
// and forced a refetch on every CRUD operation despite the 30s cache.
export const contactFacetsQuery = queryOptions({
  queryKey: ['contact-facets'],
  queryFn: () => api.get('contacts/facets').json<ContactFacets>(),
  staleTime: 30_000,
});

export function useContactFacets() {
  return useQuery(contactFacetsQuery);
}
