import { useMemo, useState } from 'react';
import { X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { normalizeForCompare, resolveLabel } from '../lib/normalize-label';
import type { FacetEntry } from '../facets-api';

type Props = {
  id: string;
  value: string[];
  onChange: (tags: string[]) => void;
  options: FacetEntry[];
  placeholder?: string;
};

/**
 * Combobox de múltipla escolha para tags: sugere as tags já cadastradas em
 * outros contatos (busca por texto, ignorando caixa/acento — mesma regra de
 * `FacetCombobox`) e permite criar uma nova. Cada tag escolhida vira um chip
 * removível; Enter ou vírgula confirmam o texto digitado como tag nova.
 */
export function TagsCombobox({ id, value, onChange, options, placeholder }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');

  const optionValues = useMemo(() => options.map((o) => o.value), [options]);
  const normalizedQuery = normalizeForCompare(query);
  const selectedNormalized = useMemo(
    () => new Set(value.map((v) => normalizeForCompare(v))),
    [value],
  );
  const filtered = useMemo(
    () =>
      options.filter((o) => {
        const n = normalizeForCompare(o.value);
        if (selectedNormalized.has(n)) return false;
        return !normalizedQuery || n.includes(normalizedQuery);
      }),
    [options, normalizedQuery, selectedNormalized],
  );
  const trimmedQuery = query.trim();
  const hasExactMatch =
    !!trimmedQuery &&
    (selectedNormalized.has(normalizedQuery) ||
      options.some((o) => normalizeForCompare(o.value) === normalizedQuery));

  const addTag = (raw: string) => {
    const resolved = resolveLabel(raw, optionValues);
    if (!resolved) return;
    if (selectedNormalized.has(normalizeForCompare(resolved))) {
      setQuery('');
      return;
    }
    onChange([...value, resolved]);
    setQuery('');
  };

  const removeTag = (tag: string) => {
    onChange(value.filter((t) => t !== tag));
  };

  return (
    <div className="relative">
      <div className="flex min-h-8 flex-wrap items-center gap-1 rounded-lg border border-input px-1.5 py-1 focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50">
        {value.map((tag) => (
          <Badge key={tag} variant="secondary" className="gap-1">
            {tag}
            <button
              type="button"
              aria-label={`Remover tag ${tag}`}
              title={`Remover tag ${tag}`}
              onClick={() => removeTag(tag)}
              className="rounded-full hover:text-destructive"
            >
              <X className="size-3" />
            </button>
          </Badge>
        ))}
        <input
          id={id}
          role="combobox"
          aria-expanded={open}
          autoComplete="off"
          placeholder={value.length === 0 ? placeholder : undefined}
          value={query}
          className="h-6 min-w-24 flex-1 border-0 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          onChange={(e) => {
            const v = e.target.value;
            // Vírgula confirma a tag digitada até aqui, sem exigir Enter —
            // idioma familiar de quem já usava o campo de texto livre
            // "separado por vírgula".
            if (v.endsWith(',')) {
              addTag(v.slice(0, -1));
              return;
            }
            setQuery(v);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => {
            setOpen(false);
            // Sair do campo sem apertar Enter/vírgula não pode perder o que
            // já foi digitado — mesmo idioma de "confirmar ao sair" do
            // FacetCombobox.
            if (query.trim()) addTag(query);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setOpen(false);
            if (e.key === 'Enter') {
              e.preventDefault();
              addTag(query);
            }
            if (e.key === 'Backspace' && query === '' && value.length > 0) {
              removeTag(value[value.length - 1]);
            }
          }}
        />
      </div>
      {open && (filtered.length > 0 || (trimmedQuery && !hasExactMatch)) && (
        <ul
          role="listbox"
          aria-label={placeholder}
          className="absolute z-10 mt-1 max-h-48 w-full overflow-auto rounded-md border bg-popover text-popover-foreground shadow-md"
        >
          {filtered.map((o) => (
            <li key={o.value}>
              <button
                type="button"
                role="option"
                aria-selected={false}
                className="flex w-full items-center justify-between gap-2 px-2 py-1.5 text-left text-sm hover:bg-accent"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => addTag(o.value)}
              >
                <span className="truncate">{o.value}</span>
                <span className="shrink-0 rounded bg-muted px-1.5 text-xs text-muted-foreground tabular-nums">
                  {o.count}
                </span>
              </button>
            </li>
          ))}
          {trimmedQuery && !hasExactMatch && (
            <li>
              <button
                type="button"
                className="flex w-full items-center gap-1 px-2 py-1.5 text-left text-sm text-primary hover:bg-accent"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => addTag(query)}
              >
                Criar “{trimmedQuery}”
              </button>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
