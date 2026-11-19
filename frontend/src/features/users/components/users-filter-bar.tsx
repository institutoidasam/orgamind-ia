import { useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { SearchField } from '@/features/sector-people/components/search-field';
import type { AuthorizationFilter, UsersFilterState } from './use-users-filter-state';

export type AuthorizationCounts = { unverified: number; notAuthorized: number };

const AUTHORIZATION_CHIPS: ReadonlyArray<{ value: AuthorizationFilter; label: string; count: keyof AuthorizationCounts }> = [
  { value: 'UNVERIFIED', label: 'Origem não verificada', count: 'unverified' },
  { value: 'NOT_AUTHORIZED', label: 'Sem autorização', count: 'notAuthorized' },
];

/** Mantém os últimos contadores enquanto uma nova busca carrega, para os botões não piscarem. */
function useLastCounts(counts?: AuthorizationCounts): AuthorizationCounts | undefined {
  const [last, setLast] = useState(counts);
  if (counts && counts !== last) setLast(counts);
  return counts ?? last;
}

function AuthorizationChips({ filters, counts }: { filters: UsersFilterState; counts?: AuthorizationCounts }) {
  return (
    <div role="group" aria-label="Autorização de contato" className="flex items-center gap-2">
      {AUTHORIZATION_CHIPS.map((chip) => {
        const pressed = filters.authorization === chip.value;
        return (
          <Button
            key={chip.value}
            type="button"
            size="sm"
            variant={pressed ? 'default' : 'outline'}
            aria-pressed={pressed}
            onClick={() => filters.setAuthorization(pressed ? undefined : chip.value)}
          >
            {counts ? `${chip.label} (${counts[chip.count]})` : chip.label}
          </Button>
        );
      })}
    </div>
  );
}

/** Busca por nome ou matrícula, filtro de autorização com contadores (spec A1, A2) e "Mostrar inativos" (A3). */
export function UsersFilterBar({ filters, counts }: { filters: UsersFilterState; counts?: AuthorizationCounts }) {
  const inactiveId = useId();
  const shownCounts = useLastCounts(counts);
  return (
    <div className="flex flex-wrap items-end gap-4">
      <div className="w-72">
        <SearchField label="Buscar por nome ou matrícula" value={filters.search.text} onChange={filters.search.setText} />
      </div>
      <AuthorizationChips filters={filters} counts={shownCounts} />
      <div className="flex items-center gap-2 pb-2">
        <Checkbox id={inactiveId} checked={filters.showInactive} onCheckedChange={(value) => filters.setShowInactive(value === true)} />
        <Label htmlFor={inactiveId}>Mostrar inativos</Label>
      </div>
    </div>
  );
}
