import { useCallback, useSyncExternalStore } from 'react';

const KEY = 'picoa-theme';
type Theme = 'light' | 'dark';

function read(): Theme {
  if (typeof window === 'undefined') return 'light';
  const v = window.localStorage.getItem(KEY);
  return v === 'dark' ? 'dark' : 'light';
}

function apply(theme: Theme) {
  const root = document.documentElement;
  if (theme === 'dark') root.classList.add('dark');
  else root.classList.remove('dark');
}

/**
 * Apply the persisted theme as early as possible (before React hydrates) so
 * the initial paint isn't a "flash of light" for dark-mode users. Also syncs
 * the in-memory store to the persisted value and notifies subscribers.
 */
export function restoreTheme() {
  const persisted = read();
  apply(persisted);
  if (persisted !== current) {
    current = persisted;
    listeners.forEach((l) => l());
  }
}

// ---------------------------------------------------------------------------
// Shared external store
// ---------------------------------------------------------------------------
//
// A single source of truth so *every* consumer — the topbar toggle, the command
// palette, AND the toast Toaster — reflects the same live theme. Previously each
// `useTheme` call owned its own `useState`, so the Toaster (which read the never-
// mounted `next-themes`) was decoupled from the app's real theme. With one store
// the toast follows the user's actual light/dark choice in real time.

let current: Theme = read();
const listeners = new Set<() => void>();

function setTheme(next: Theme) {
  if (next === current) return;
  current = next;
  apply(current);
  if (typeof window !== 'undefined') window.localStorage.setItem(KEY, current);
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): Theme {
  return current;
}

function getServerSnapshot(): Theme {
  return 'light';
}

function useThemeValue(): Theme {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

export function useTheme(): { theme: Theme; toggle: () => void; set: (t: Theme) => void } {
  const theme = useThemeValue();

  // Stable references so consumers (e.g. the command palette) can list
  // `toggle`/`set` in their own `useMemo` deps without rebuilding on every
  // parent render.
  const toggle = useCallback(
    () => setTheme(current === 'dark' ? 'light' : 'dark'),
    [],
  );
  const set = useCallback((t: Theme) => setTheme(t), []);

  return { theme, set, toggle };
}

/**
 * The resolved app theme for the sonner `<Toaster theme>` prop. Returns a
 * concrete `'light' | 'dark'` (never next-themes' default `'system'`), so the
 * toast styling tracks the app's real theme. Wire this into the Toaster
 * instead of `next-themes`' `useTheme`.
 */
export function useToasterTheme(): Theme {
  return useThemeValue();
}
