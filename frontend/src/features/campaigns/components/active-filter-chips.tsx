import { X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import type { FacetSelection } from './facet-filters';

type Props = {
  selection: FacetSelection;
  onRemove: (key: keyof FacetSelection, value: string) => void;
  onClearAll: () => void;
};

export function ActiveFilterChips({ selection, onRemove, onClearAll }: Props) {
  const chips: Array<{
    key: keyof FacetSelection;
    label: string;
    value: string;
  }> = [
    ...selection.cities.map((v) => ({ key: 'cities' as const, label: 'cidade', value: v })),
    ...selection.groups.map((v) => ({ key: 'groups' as const, label: 'grupo', value: v })),
    ...selection.tags.map((v) => ({ key: 'tags' as const, label: 'tag', value: v })),
  ];

  if (chips.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg bg-muted/50 px-3 py-2">
      <span className="text-xs font-medium text-muted-foreground">
        Filtros ativos:
      </span>
      {chips.map((chip) => (
        <Badge
          key={`${chip.key}:${chip.value}`}
          variant="secondary"
          className="gap-1 pr-1"
        >
          <span className="text-xs text-muted-foreground">{chip.label}:</span>
          <span>{chip.value}</span>
          <button
            type="button"
            onClick={() => onRemove(chip.key, chip.value)}
            aria-label={`Remover filtro ${chip.label} ${chip.value}`}
            className="ml-0.5 rounded-full p-0.5 hover:bg-background"
          >
            <X className="h-3 w-3" />
          </button>
        </Badge>
      ))}
      <button
        type="button"
        onClick={onClearAll}
        className="ml-auto text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
      >
        Limpar tudo
      </button>
    </div>
  );
}
