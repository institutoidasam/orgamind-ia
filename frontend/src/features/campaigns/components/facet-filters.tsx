import { MapPin, Users, Tag } from 'lucide-react';
import { Checkbox } from '@/components/ui/checkbox';
import { useContactFacets } from '@/features/contacts/facets-api';

export type FacetSelection = {
  cities: string[];
  groups: string[];
  tags: string[];
};

type Props = {
  selection: FacetSelection;
  onChange: (sel: FacetSelection) => void;
};

export function FacetFilters({ selection, onChange }: Props) {
  const { data, isLoading } = useContactFacets();

  if (isLoading) {
    return <div className="text-sm text-muted-foreground">Carregando filtros…</div>;
  }
  if (!data) {
    return <div className="text-sm text-destructive">Erro ao carregar filtros</div>;
  }

  const toggle = (key: keyof FacetSelection, value: string, checked: boolean) => {
    const current = new Set(selection[key]);
    if (checked) current.add(value);
    else current.delete(value);
    onChange({ ...selection, [key]: [...current] });
  };

  return (
    <div className="space-y-5 text-sm">
      {/* Cidade */}
      <FacetSection
        icon={<MapPin className="h-3.5 w-3.5" />}
        label="Cidade"
        items={data.cities}
        selected={selection.cities}
        onToggle={(v, checked) => toggle('cities', v, checked)}
      />

      {/* Grupo */}
      <FacetSection
        icon={<Users className="h-3.5 w-3.5" />}
        label="Grupo"
        items={data.groups}
        selected={selection.groups}
        onToggle={(v, checked) => toggle('groups', v, checked)}
      />

      {/* Tags */}
      <FacetSection
        icon={<Tag className="h-3.5 w-3.5" />}
        label="Tags"
        items={data.tags}
        selected={selection.tags}
        onToggle={(v, checked) => toggle('tags', v, checked)}
      />
    </div>
  );
}

function FacetSection({
  icon,
  label,
  items,
  selected,
  onToggle,
}: {
  icon: React.ReactNode;
  label: string;
  items: { value: string; count: number }[];
  selected: string[];
  onToggle: (value: string, checked: boolean) => void;
}) {
  if (items.length === 0) return null;
  const sel = new Set(selected);
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {icon}
        {label}
      </div>
      <div className="space-y-1">
        {items.map((item) => {
          const id = `facet-${label}-${item.value}`;
          const checked = sel.has(item.value);
          return (
            <label
              key={item.value}
              htmlFor={id}
              className="group flex cursor-pointer items-center justify-between gap-2 rounded px-1.5 py-1 hover:bg-accent"
            >
              <div className="flex items-center gap-2 truncate">
                <Checkbox
                  id={id}
                  checked={checked}
                  onCheckedChange={(v) => onToggle(item.value, v === true)}
                />
                <span className="truncate">{item.value}</span>
              </div>
              <span className="shrink-0 rounded bg-muted px-1.5 text-xs text-muted-foreground tabular-nums">
                {item.count}
              </span>
            </label>
          );
        })}
      </div>
    </div>
  );
}
