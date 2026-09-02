import { useMemo, useState } from 'react';
import { Input } from '@/components/ui/input';
import { normalizeForCompare, resolveLabel } from '../lib/normalize-label';
import type { FacetEntry } from '../facets-api';

type Props = {
  id: string;
  value: string;
  onChange: (value: string) => void;
  options: FacetEntry[];
  placeholder?: string;
  /** Mensagem quando ainda não há nenhum valor cadastrado para sugerir. */
  emptyHint?: string;
};

/**
 * Combobox de busca+criação para um campo de rótulo livre (cidade, grupo)
 * que já tem valores cadastrados em outros contatos. Sem Popover/Tooltip —
 * o dropdown é um `<ul>` posicionado, mostrado/escondido por foco, seguindo
 * a mesma regra do resto do produto (hover por `title` nativo).
 *
 * Totalmente controlado por `value`/`onChange` (sem estado interno de
 * "rascunho"): cada tecla já atualiza o form. A COMPARAÇÃO com as opções já
 * cadastradas ignora caixa/acento/espaçamento (`normalizeForCompare`), e ao
 * sair do campo (blur), pressionar Enter ou escolher uma sugestão, o valor é
 * "encaixado" no rótulo já existente quando bate por essa comparação
 * (`resolveLabel`) — assim "Manaus" e "manaus" viram o MESMO registro em vez
 * de dois. Fora desses momentos de confirmação, o texto digitado fica como
 * está: nada é reescrito enquanto o operador ainda está digitando.
 */
export function FacetCombobox({
  id,
  value,
  onChange,
  options,
  placeholder,
  emptyHint = 'Nenhum valor cadastrado ainda — digite para criar um novo.',
}: Props) {
  const [open, setOpen] = useState(false);

  const optionValues = useMemo(() => options.map((o) => o.value), [options]);
  const normalizedQuery = normalizeForCompare(value);
  const filtered = useMemo(
    () =>
      options.filter(
        (o) =>
          !normalizedQuery || normalizeForCompare(o.value).includes(normalizedQuery),
      ),
    [options, normalizedQuery],
  );
  const trimmedQuery = value.trim();
  const hasExactMatch = options.some(
    (o) => normalizeForCompare(o.value) === normalizedQuery,
  );

  const resolve = () => onChange(resolveLabel(value, optionValues));

  return (
    <div className="relative">
      <Input
        id={id}
        role="combobox"
        aria-expanded={open}
        autoComplete="off"
        placeholder={placeholder}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => {
          setOpen(false);
          resolve();
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setOpen(false);
          if (e.key === 'Enter') {
            e.preventDefault();
            resolve();
            setOpen(false);
          }
        }}
      />
      {open && (
        <ul
          role="listbox"
          aria-label={placeholder}
          className="absolute z-10 mt-1 max-h-48 w-full overflow-auto rounded-md border bg-popover text-popover-foreground shadow-md"
        >
          {filtered.length === 0 && !trimmedQuery && (
            <li className="px-2 py-1.5 text-xs text-muted-foreground">
              {emptyHint}
            </li>
          )}
          {filtered.map((o) => (
            <li key={o.value}>
              <button
                type="button"
                role="option"
                aria-selected={normalizeForCompare(o.value) === normalizedQuery}
                className="flex w-full items-center justify-between gap-2 px-2 py-1.5 text-left text-sm hover:bg-accent"
                // preventDefault no mousedown mantém o foco no input, então o
                // onBlur do input não dispara antes do onClick — sem isto o
                // clique fecharia a lista e nunca chegaria a selecionar nada.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  onChange(o.value);
                  setOpen(false);
                }}
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
                onClick={() => {
                  resolve();
                  setOpen(false);
                }}
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
