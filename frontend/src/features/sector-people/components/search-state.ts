import { useEffect, useState } from 'react';

const SEARCH_DEBOUNCE_MS = 300;

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

/** Texto digitado e o termo (aparado) que vai para a busca, 300 ms depois da última tecla. */
export function useDebouncedSearch() {
  const [text, setText] = useState('');
  const q = useDebouncedValue(text.trim(), SEARCH_DEBOUNCE_MS);
  return { text, setText, q };
}

export function toggleBy<T>(list: readonly T[], item: T, same: (other: T) => boolean, checked: boolean): T[] {
  const rest = list.filter((other) => !same(other));
  return checked ? [...rest, item] : rest;
}
