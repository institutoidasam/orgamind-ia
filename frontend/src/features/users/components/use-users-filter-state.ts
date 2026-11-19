import { useState } from 'react';
import { useDebouncedSearch } from '@/features/sector-people/components/search-state';
import type { UsersFilters } from '../api';

export type AuthorizationFilter = NonNullable<UsersFilters['authorization']>;

/** Filtros da lista (D9): só ativos até marcar "Mostrar inativos"; a busca sai 300 ms depois da última tecla. */
export function useUsersFilterState() {
  const search = useDebouncedSearch();
  const [showInactive, setShowInactive] = useState(false);
  const [authorization, setAuthorization] = useState<AuthorizationFilter>();
  const filters: UsersFilters = { q: search.q, status: showInactive ? 'all' : 'active', authorization };
  return { search, showInactive, setShowInactive, authorization, setAuthorization, filters };
}

export type UsersFilterState = ReturnType<typeof useUsersFilterState>;
