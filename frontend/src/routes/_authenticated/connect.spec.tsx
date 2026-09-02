import { render, screen } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ChannelProvider, ProvidersResponse } from '@/features/whatsapp/api';
import type { ProviderScope } from '@/features/whatsapp/provider-scope';

// --- Router mock ----------------------------------------------------------
vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (opts: { component: React.ComponentType }) => ({
    ...opts,
  }),
}));

// --- Providers data (useProviders) ----------------------------------------
const providersState: {
  data: ProvidersResponse | undefined;
  isError: boolean;
  error: unknown;
  refetch: () => void;
} = { data: undefined, isError: false, error: null, refetch: vi.fn() };

vi.mock('@/features/whatsapp/api', () => ({
  useProviders: () => providersState,
  // Sem perda de webhook por default — o banner some e os testes abaixo
  // continuam exercitando a página "normal".
  useWebhookDrops: () => ({ data: { drops: [] } }),
}));

// --- Provider scope (useProviderScope) ------------------------------------
let scopeState: ProviderScope = 'all';
vi.mock('@/features/whatsapp/provider-scope', () => ({
  useProviderScope: () => ({ scope: scopeState, setScope: vi.fn() }),
  ProviderBadge: ({ provider }: { provider: ChannelProvider }) => (
    <span data-testid={`badge-${provider}`}>{provider}</span>
  ),
}));

// --- Auth store mock ------------------------------------------------------
vi.mock('@/stores/auth.store', () => ({
  useAuthStore: (sel: (s: unknown) => unknown) => sel({ user: { role: 'ADMIN' } }),
}));

// --- Section stubs (drive orchestration only) -----------------------------
vi.mock('@/features/whatsapp/components/evolution-section', () => ({
  EvolutionSection: ({ role }: { role: string }) => (
    <div data-testid="evolution-section">evolution:{role}</div>
  ),
}));
vi.mock('@/features/whatsapp/components/gozap-section', () => ({
  GozapSection: ({ role, channels }: { role: string; channels: unknown[] }) => (
    <div data-testid="gozap-section">gozap:{role}:{channels.length}</div>
  ),
}));
vi.mock('@/features/whatsapp/components/cloud-provider-section', () => ({
  CloudProviderSection: ({ provider }: { provider: ChannelProvider }) => (
    <div data-testid={`cloud-section-${provider}`}>cloud:{provider}</div>
  ),
}));

import { Route } from './connect';

const ConnectPage = (Route as unknown as { component: React.ComponentType }).component;

function group(provider: ChannelProvider) {
  return { provider, channels: [] };
}

function wrap(ui: React.ReactElement) {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      {ui}
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  scopeState = 'all';
  providersState.data = undefined;
  providersState.isError = false;
  providersState.error = null;
});

describe('ConnectPage — one section per configured provider (scope "all")', () => {
  it('renders a section for every configured provider', () => {
    providersState.data = {
      providers: [group('EVOLUTION'), group('TWILIO'), group('ZERNIO')],
    };
    wrap(<ConnectPage />);
    expect(screen.getByTestId('evolution-section')).toBeInTheDocument();
    expect(screen.getByTestId('cloud-section-TWILIO')).toBeInTheDocument();
    expect(screen.getByTestId('cloud-section-ZERNIO')).toBeInTheDocument();
  });

  it('labels each section with a provider badge when 2+ are shown', () => {
    providersState.data = { providers: [group('EVOLUTION'), group('TWILIO')] };
    wrap(<ConnectPage />);
    expect(screen.getByTestId('badge-EVOLUTION')).toBeInTheDocument();
    expect(screen.getByTestId('badge-TWILIO')).toBeInTheDocument();
  });

  it('passes the operator role down to the Evolution section', () => {
    providersState.data = { providers: [group('EVOLUTION'), group('TWILIO')] };
    wrap(<ConnectPage />);
    expect(screen.getByTestId('evolution-section')).toHaveTextContent('evolution:ADMIN');
  });
});

describe('ConnectPage — specific provider scope', () => {
  it('shows only the scoped provider section', () => {
    scopeState = 'TWILIO';
    providersState.data = {
      providers: [group('EVOLUTION'), group('TWILIO'), group('ZERNIO')],
    };
    wrap(<ConnectPage />);
    expect(screen.getByTestId('cloud-section-TWILIO')).toBeInTheDocument();
    expect(screen.queryByTestId('evolution-section')).not.toBeInTheDocument();
    expect(screen.queryByTestId('cloud-section-ZERNIO')).not.toBeInTheDocument();
  });

  it('with a single scoped section shows no provider badge header', () => {
    scopeState = 'TWILIO';
    providersState.data = { providers: [group('EVOLUTION'), group('TWILIO')] };
    wrap(<ConnectPage />);
    expect(screen.queryByTestId('badge-TWILIO')).not.toBeInTheDocument();
  });
});

describe('ConnectPage — single configured provider (Evolution only)', () => {
  it('renders exactly the Evolution flow, no empty cloud sections, no headers', () => {
    providersState.data = { providers: [group('EVOLUTION')] };
    wrap(<ConnectPage />);
    expect(screen.getByTestId('evolution-section')).toBeInTheDocument();
    expect(screen.queryByTestId('cloud-section-TWILIO')).not.toBeInTheDocument();
    expect(screen.queryByTestId('cloud-section-ZERNIO')).not.toBeInTheDocument();
    // No section header badge for a lone provider — reads as the old page.
    expect(screen.queryByTestId('badge-EVOLUTION')).not.toBeInTheDocument();
  });
});

describe('ConnectPage — GOZAP routes to GozapSection, not CloudProviderSection', () => {
  it('renders the GoZap section (and not a cloud section) when GOZAP is configured', () => {
    providersState.data = {
      providers: [group('EVOLUTION'), group('GOZAP'), group('TWILIO')],
    };
    wrap(<ConnectPage />);
    expect(screen.getByTestId('gozap-section')).toBeInTheDocument();
    expect(screen.queryByTestId('cloud-section-GOZAP')).not.toBeInTheDocument();
  });

  it('passes role and this provider group\'s channels down to GozapSection', () => {
    providersState.data = {
      providers: [
        {
          provider: 'GOZAP',
          channels: [
            { id: 'c1', name: 'Loja 1', phoneE164: null, isActive: true, isDefault: false, provider: 'GOZAP' },
          ],
        },
      ],
    };
    wrap(<ConnectPage />);
    expect(screen.getByTestId('gozap-section')).toHaveTextContent('gozap:ADMIN:1');
  });

  it('a deploy with only GOZAP renders exactly that section, no headers', () => {
    providersState.data = { providers: [group('GOZAP')] };
    wrap(<ConnectPage />);
    expect(screen.getByTestId('gozap-section')).toBeInTheDocument();
    expect(screen.queryByTestId('badge-GOZAP')).not.toBeInTheDocument();
  });
});

describe('ConnectPage — providers query error', () => {
  it('renders the standardized error fallback with a retry', async () => {
    providersState.isError = true;
    providersState.error = new Error('providers boom');
    wrap(<ConnectPage />);
    // QueryErrorFallback resolves the message via async extractApiError.
    expect(
      await screen.findByRole('button', { name: /Tentar novamente/i }),
    ).toBeInTheDocument();
  });
});

describe('ConnectPage — no providers configured on the server', () => {
  it('shows a PT-BR empty-state message instead of a blank page', () => {
    providersState.data = { providers: [] };
    wrap(<ConnectPage />);
    expect(
      screen.getByText('Nenhum provedor configurado no servidor.'),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('evolution-section')).not.toBeInTheDocument();
  });

  it('does not show the empty-state while the query is still loading (no data yet)', () => {
    // providersState.data stays undefined (beforeEach default) — the loading
    // state must not be mistaken for "zero providers configured".
    wrap(<ConnectPage />);
    expect(
      screen.queryByText('Nenhum provedor configurado no servidor.'),
    ).not.toBeInTheDocument();
  });
});
