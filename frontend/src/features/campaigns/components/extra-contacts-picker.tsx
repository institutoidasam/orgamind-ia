import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { useContacts } from '@/features/contacts/api';

export type ExtraContact = { id: string; name: string | null; phoneE164: string };

type Props = {
  selected: ExtraContact[];
  onChange: (next: ExtraContact[]) => void;
};

const MIN_SEARCH_LEN = 2;
const DEBOUNCE_MS = 250;

/**
 * "Adicionar contato específico" (pedido do cliente, 2026-08-25) — busca por
 * nome/telefone (reusa `useContacts` com `search`, o mesmo endpoint da tela
 * de contatos) e deixa o operador somar contatos avulsos ao público, além do
 * que os filtros (cidade/grupo/tags ou o construtor avançado) já
 * selecionaram. `FilterStep` (routes/_authenticated/campaigns/new.tsx) é
 * quem materializa a seleção num nó OU (`materializeExtraContacts`,
 * extra-contacts.ts) por cima do filtro final.
 *
 * Sem Popover/Tooltip (regra do pedido): os resultados aparecem numa lista
 * simples abaixo do campo, no mesmo estilo de lista com checkbox já usado em
 * `FacetFilters`/`HistoryExclusionBlock` — aqui como botões, já que a ação é
 * "adicionar" e não "marcar".
 */
export function ExtraContactsPicker({ selected, onChange }: Props) {
  const [term, setTerm] = useState('');
  const [debounced, setDebounced] = useState('');

  useEffect(() => {
    const t = setTimeout(() => setDebounced(term.trim()), DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [term]);

  const searchActive = debounced.length >= MIN_SEARCH_LEN;
  const { data, isFetching } = useContacts(
    { page: 1, pageSize: 8, search: debounced },
    { enabled: searchActive },
  );

  const selectedIds = new Set(selected.map((c) => c.id));
  const results = (data?.items ?? []).filter((c) => !selectedIds.has(c.id));

  const add = (c: ExtraContact) => {
    onChange([...selected, c]);
    setTerm('');
  };
  const remove = (id: string) => onChange(selected.filter((c) => c.id !== id));

  return (
    <div className="space-y-2 rounded-lg border p-3">
      <div>
        <h3 className="text-sm font-semibold">Adicionar contato específico</h3>
        <p className="text-xs text-muted-foreground">
          Busque por nome ou telefone. Contatos adicionados aqui somam ao
          público definido pelos filtros abaixo, mesmo que não batam com eles.
        </p>
      </div>

      <Input
        placeholder="Buscar por nome ou telefone…"
        value={term}
        onChange={(e) => setTerm(e.target.value)}
        aria-label="Buscar contato para adicionar"
      />

      {searchActive && (
        <div className="max-h-40 space-y-1 overflow-y-auto rounded border p-1">
          {isFetching ? (
            <p className="px-1.5 py-1 text-xs text-muted-foreground">
              Buscando…
            </p>
          ) : results.length === 0 ? (
            <p className="px-1.5 py-1 text-xs text-muted-foreground">
              Nenhum contato encontrado.
            </p>
          ) : (
            results.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => add({ id: c.id, name: c.name, phoneE164: c.phoneE164 })}
                className="flex w-full items-center justify-between gap-2 rounded px-1.5 py-1 text-left text-sm hover:bg-accent"
              >
                <span className="truncate">{c.name ?? '—'}</span>
                <span className="shrink-0 font-mono text-xs text-muted-foreground">
                  {c.phoneE164}
                </span>
              </button>
            ))
          )}
        </div>
      )}

      {selected.length > 0 && (
        <ul className="space-y-1" data-testid="extra-contacts-selected">
          {selected.map((c) => (
            <li
              key={c.id}
              className="flex items-center justify-between gap-2 rounded bg-muted/40 px-2 py-1 text-sm"
            >
              <span className="truncate">
                {c.name ?? '—'}{' '}
                <span className="font-mono text-xs text-muted-foreground">
                  {c.phoneE164}
                </span>
              </span>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={`Remover ${c.name ?? c.phoneE164}`}
                onClick={() => remove(c.id)}
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
