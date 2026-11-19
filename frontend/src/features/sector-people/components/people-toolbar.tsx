import { useId } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import type { FlagCounts, FlagFilter } from './people-filter';
import { SearchField } from './search-field';

const FLAG_FILTERS: { flag: FlagFilter; label: string }[] = [
  { flag: 'unverified', label: 'Origem não verificada' },
  { flag: 'not_authorized', label: 'Sem autorização' },
];

type InactiveToggleProps = { checked: boolean; onChange: (checked: boolean) => void };

/** Inativos ficam escondidos por padrão (spec A3); marcar recarrega a lista com `includeInactive`. */
export function InactiveToggle({ checked, onChange }: InactiveToggleProps) {
  const id = useId();
  return (
    <div className="flex items-center gap-2">
      <Checkbox id={id} checked={checked} onCheckedChange={(value) => onChange(value === true)} />
      <Label htmlFor={id}>Mostrar inativos</Label>
    </div>
  );
}

type FlagFiltersProps = { counts: FlagCounts; value: FlagFilter | null; onChange: (value: FlagFilter | null) => void };

/** Filtro de regularização com o contador de cada selo; clicar no filtro ativo o limpa. */
function FlagFilters({ counts, value, onChange }: FlagFiltersProps) {
  return (
    <div role="group" aria-label="Regularização do contato" className="flex flex-wrap gap-2">
      {FLAG_FILTERS.map(({ flag, label }) => (
        <Button
          key={flag}
          type="button"
          size="sm"
          variant={value === flag ? 'secondary' : 'outline'}
          aria-pressed={value === flag}
          onClick={() => onChange(value === flag ? null : flag)}
        >
          {`${label} (${counts[flag]})`}
        </Button>
      ))}
    </div>
  );
}

type Props = FlagFiltersProps & {
  query: string;
  onQuery: (query: string) => void;
  includeInactive: boolean;
  onIncludeInactive: (include: boolean) => void;
};

/** Busca, filtro e contador de regularização, e "Mostrar inativos", sobre a lista carregada. */
export function PeopleToolbar({ query, onQuery, counts, value, onChange, includeInactive, onIncludeInactive }: Props) {
  return (
    <div className="space-y-3">
      <SearchField label="Buscar por nome ou matrícula" value={query} onChange={onQuery} />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <FlagFilters counts={counts} value={value} onChange={onChange} />
        <InactiveToggle checked={includeInactive} onChange={onIncludeInactive} />
      </div>
    </div>
  );
}
