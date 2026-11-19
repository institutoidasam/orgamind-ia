import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { ChannelProvider } from './api';

const STORAGE_KEY = 'picoa.providerScope';

/** `'all'` (no filter) or a single configured provider. */
export type ProviderScope = 'all' | ChannelProvider;

export const PROVIDER_LABEL: Record<ChannelProvider, string> = {
  EVOLUTION: 'Evolution',
  TWILIO: 'Twilio',
  ZERNIO: 'Zernio',
  META: 'Meta',
  GOZAP: 'GoZap',
};

/** One accent color per provider — used by {@link ProviderBadge}. */
const PROVIDER_COLOR: Record<ChannelProvider, string> = {
  EVOLUTION: '#10b981', // emerald
  TWILIO: '#F22F46', // Twilio brand red
  ZERNIO: '#f59e0b', // amber
  META: '#0866FF', // Meta brand blue
  GOZAP: '#7c3aed', // violet
};

/**
 * Sem seletor no topo, um escopo persistido por uma sessão antiga (ex.:
 * `GOZAP`) deixaria o operador preso numa lista vazia e sem como trocar.
 * Qualquer valor diferente de `'all'` vira `'all'` e a chave legada é apagada.
 */
function readPersisted(): ProviderScope {
  if (typeof window === 'undefined') return 'all';
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (raw !== null && raw !== 'all') window.localStorage.removeItem(STORAGE_KEY);
  return 'all';
}

function persist(scope: ProviderScope) {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(STORAGE_KEY, scope);
}

type ProviderScopeContextValue = {
  scope: ProviderScope;
  setScope: (scope: ProviderScope) => void;
};

const ProviderScopeContext = createContext<ProviderScopeContextValue | null>(null);

/**
 * Mounts the global provider-scope context. Rendered once, at the
 * authenticated root layout, so every screen underneath (inbox, campaigns,
 * ...) shares the same scope.
 */
export function ProviderScopeProvider({ children }: { children: ReactNode }) {
  const [scope, setScopeState] = useState<ProviderScope>(() => readPersisted());

  const setScope = useCallback((next: ProviderScope) => {
    setScopeState(next);
    persist(next);
  }, []);

  const value = useMemo<ProviderScopeContextValue>(() => ({ scope, setScope }), [scope, setScope]);

  return <ProviderScopeContext.Provider value={value}>{children}</ProviderScopeContext.Provider>;
}

/**
 * Global WhatsApp provider scope: `'all'` or a single {@link ChannelProvider}.
 * Sem seletor na UI, ele sempre inicia em `'all'` (valor legado em
 * `localStorage` é descartado). Must be called under
 * `<ProviderScopeProvider>` (mounted in the authenticated root layout).
 */
export function useProviderScope(): ProviderScopeContextValue {
  const ctx = useContext(ProviderScopeContext);
  if (!ctx) {
    throw new Error('useProviderScope must be used within <ProviderScopeProvider>');
  }
  return ctx;
}

/**
 * Small reusable pill identifying a provider by a distinct color/label — used
 * on channel lists, campaign/message rows, etc.
 */
export function ProviderBadge({ provider, className }: { provider: ChannelProvider; className?: string }) {
  const color = PROVIDER_COLOR[provider];
  return (
    <Badge
      variant="outline"
      className={cn('border', className)}
      style={{
        background: `color-mix(in oklch, ${color} 12%, transparent)`,
        color: 'var(--foreground)',
        borderColor: `color-mix(in oklch, ${color} 35%, transparent)`,
      }}
    >
      {PROVIDER_LABEL[provider]}
    </Badge>
  );
}
