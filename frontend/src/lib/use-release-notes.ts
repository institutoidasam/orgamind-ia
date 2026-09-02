import { useSyncExternalStore } from 'react';
import { latestRelease, type ReleaseNote } from '@/release-notes';

const KEY = 'picoa.lastSeenRelease';

// Fallback em memória, usado só quando o localStorage lança (modo privado,
// cota estourada, storage desabilitado) — mantém "marcar como visto" válido
// nesta sessão mesmo sem persistir. Leitura e escrita sempre em try/catch.
let memoryFallback: string | null = null;

function readSeenVersion(): string | null {
  // A memória da sessão tem precedência sobre o localStorage: se já marcamos
  // "visto" nesta sessão (persistSeenVersion sempre grava aqui primeiro),
  // isso vale mesmo que o `setItem` seguinte tenha lançado (quota, modo
  // privado do Safari...) — sem isso, esta função voltaria a consultar um
  // localStorage que nunca foi de fato escrito, `hasUnseen` ficaria `true`
  // para sempre, e o diálogo reabriria sozinho a cada render (achado #1 da
  // revisão final de Fase C).
  if (memoryFallback !== null) return memoryFallback;
  try {
    return window.localStorage.getItem(KEY);
  } catch {
    return memoryFallback;
  }
}

function persistSeenVersion(version: string) {
  memoryFallback = version;
  try {
    window.localStorage.setItem(KEY, version);
  } catch {
    /* armazenamento indisponível — memoryFallback acima cobre a sessão atual */
  }
}

const listeners = new Set<() => void>();

function markSeenVersion(version: string) {
  persistSeenVersion(version);
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): string | null {
  return readSeenVersion();
}

function getServerSnapshot(): string | null {
  return null;
}

/**
 * Só para teste: `memoryFallback` é estado de módulo (singleton), então
 * sobrevive entre `it()` de um mesmo arquivo de spec e pode deixar um teste
 * "pré-satisfeito" por um `markSeen()` de um teste anterior. Chamar no
 * `beforeEach` de qualquer spec que force o fallback (mock de `setItem`
 * lançando, por exemplo).
 */
export function __resetReleaseNotesStoreForTests() {
  memoryFallback = null;
}

export type UseReleaseNotesResult = {
  latest: ReleaseNote;
  hasUnseen: boolean;
  markSeen: () => void;
};

/**
 * Estado compartilhado de "Novidades visto/não visto" — mesmo padrão de
 * `useTheme` (`lib/theme.ts`): um `useSyncExternalStore` sobre uma única
 * fonte de verdade (`localStorage['picoa.lastSeenRelease']`), para que o
 * badge "Novo" e o diálogo concordem sempre, em qualquer componente que
 * chame este hook.
 */
export function useReleaseNotes(): UseReleaseNotesResult {
  const lastSeen = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const latest = latestRelease();
  return {
    latest,
    hasUnseen: lastSeen !== latest.version,
    markSeen: () => markSeenVersion(latest.version),
  };
}
