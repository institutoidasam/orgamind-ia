import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { CHANNEL_PROVIDERS, useProviders, type ChannelProvider } from './api';

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

const CHANNEL_PROVIDER_SET: ReadonlySet<string> = new Set(CHANNEL_PROVIDERS);

function isProviderScope(value: string | null): value is ProviderScope {
  return value === 'all' || CHANNEL_PROVIDER_SET.has(value ?? '');
}

function readPersisted(): ProviderScope {
  if (typeof window === 'undefined') return 'all';
  const raw = window.localStorage.getItem(STORAGE_KEY);
  return isProviderScope(raw) ? raw : 'all';
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
 * authenticated root layout, so every screen underneath (topbar selector,
 * inbox, campaigns, ...) shares the same scope and its localStorage
 * persistence.
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
 * Persisted in `localStorage` (`picoa.providerScope`, default `'all'`) so the
 * operator's choice survives reloads. Must be called under
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

const CONNECTION_STATE_LABEL = {
  open: 'Conectado',
  connecting: 'Conectando…',
  close: 'Desconectado',
} as const;

const CONNECTION_STATE_COLOR = {
  open: '#10b981', // emerald — mesmo verde do dot da EvolutionSection
  connecting: '#f59e0b', // amber
  close: '#ef4444', // vermelho — mesmo do dot da EvolutionSection
} as const;

/**
 * Ponto + rótulo PT-BR do estado de conexão de UM canal (`ChannelSummary.
 * connectionState`, GET /whatsapp/providers) — o que faltava na tela Canais
 * para o operador saber se um número está pareado agora ou não.
 *
 * `state` ausente/`null` não vira nada: é o caso de um canal sem sessão
 * (TWILIO/ZERNIO/META — sempre "no ar" enquanto ativo, sem pareamento por QR)
 * ou de um canal sessionBased que nunca completou um ciclo de conexão.
 * Mostrar "desconectado" nesse caso seria inventar um dado que não existe.
 */
export function ConnectionStateBadge({
  state,
}: {
  state: 'open' | 'connecting' | 'close' | null | undefined;
}) {
  if (!state) return null;
  const color = CONNECTION_STATE_COLOR[state];
  return (
    <span className="inline-flex items-center gap-1.5 text-xs" style={{ color: 'var(--foreground)' }}>
      <span className="size-2 shrink-0 rounded-full" style={{ background: color }} aria-hidden />
      {CONNECTION_STATE_LABEL[state]}
    </span>
  );
}

/**
 * Topbar control that scopes the whole app to a single WhatsApp provider (or
 * back to "Todos os canais"). Renders nothing when fewer than 2 providers are
 * configured — with a single provider there's nothing to disambiguate.
 */
export function ProviderScopeSelector() {
  const { data } = useProviders();
  const { scope, setScope } = useProviderScope();

  const providers = data?.providers ?? [];
  if (providers.length < 2) return null;

  const activeLabel = scope === 'all' ? 'Todos os canais' : PROVIDER_LABEL[scope];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Filtrar por provedor"
          className="inline-flex items-center gap-1.5 rounded-md border px-2 py-1.5 text-sm"
          style={{
            background: 'var(--surface)',
            borderColor: 'var(--border)',
            color: 'var(--foreground-muted)',
          }}
        >
          <span className="hidden sm:inline">{activeLabel}</span>
          <ChevronDown className="size-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuLabel>Escopo de canais</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={scope} onValueChange={(v) => setScope(v as ProviderScope)}>
          <DropdownMenuRadioItem value="all">Todos os canais</DropdownMenuRadioItem>
          <DropdownMenuSeparator />
          {providers.map(({ provider }) => (
            <DropdownMenuRadioItem key={provider} value={provider}>
              {PROVIDER_LABEL[provider]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
