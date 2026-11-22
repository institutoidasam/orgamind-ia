import { render, screen } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ChannelProvider, DisabledChannel, ProvidersResponse } from '@/features/whatsapp/api';

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
}));

// --- Auth store mock ------------------------------------------------------
let currentRole = 'ADMIN';
vi.mock('@/stores/auth.store', () => ({
  useAuthStore: (sel: (s: unknown) => unknown) => sel({ user: { role: currentRole } }),
}));

// --- Setores (aviso de áreas sem número) ----------------------------------
const sectorsState: { items: { id: string; name: string; channel: unknown }[] } = { items: [] };
vi.mock('@/features/internal-admin/api', () => ({
  useSectors: () => ({ data: { items: sectorsState.items }, isError: false }),
}));

// --- Section stubs (drive orchestration only) -----------------------------
vi.mock('@/features/whatsapp/components/evolution-section', () => ({
  EvolutionSection: ({ role }: { role: string }) => (
    <div data-testid="evolution-section">evolution:{role}</div>
  ),
}));
vi.mock('@/features/whatsapp/components/disabled-channels-section', () => ({
  DisabledChannelsSection: ({ channels }: { channels: DisabledChannel[] }) => (
    <div data-testid="disabled-channels">Números desligados:{channels.length}</div>
  ),
}));

import { Route } from './connect';

const ConnectPage = (Route as unknown as { component: React.ComponentType }).component;

function group(provider: ChannelProvider) {
  return { provider, traits: { official: false, sessionBased: true, sessionWindow: false }, capabilities: [], channels: [] };
}

const DISABLED: DisabledChannel = {
  id: 'g1',
  name: 'GBR',
  provider: 'GOZAP',
  phoneE164: '+5511999990000',
  sectorNames: ['Produção'],
};

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
  currentRole = 'ADMIN';
  providersState.data = undefined;
  providersState.isError = false;
  providersState.error = null;
  sectorsState.items = [];
});

describe('ConnectPage — só a seção Evolution', () => {
  it('não há seção GoZap, cloud nem cabeçalho de provedor', () => {
    providersState.data = { providers: [group('EVOLUTION')], disabledChannels: [] };
    wrap(<ConnectPage />);
    expect(screen.getByTestId('evolution-section')).toHaveTextContent('evolution:ADMIN');
    expect(screen.queryByTestId('gozap-section')).not.toBeInTheDocument();
    expect(screen.queryByTestId('cloud-section-TWILIO')).not.toBeInTheDocument();
    expect(screen.queryByTestId('badge-EVOLUTION')).not.toBeInTheDocument();
    expect(screen.queryByTestId('disabled-channels')).not.toBeInTheDocument();
  });

  it('passa o papel não-ADMIN para a seção Evolution', () => {
    currentRole = 'OPERATOR';
    providersState.data = { providers: [group('EVOLUTION')], disabledChannels: [] };
    wrap(<ConnectPage />);
    expect(screen.getByTestId('evolution-section')).toHaveTextContent('evolution:OPERATOR');
  });
});

describe('ConnectPage — Números desligados', () => {
  it('ADMIN com disabledChannels vê Números desligados', () => {
    providersState.data = { providers: [group('EVOLUTION')], disabledChannels: [DISABLED] };
    wrap(<ConnectPage />);
    expect(screen.getByTestId('disabled-channels')).toHaveTextContent('Números desligados:1');
  });

  it.each(['SUPERVISOR', 'OPERATOR'])('%s não vê o bloco', (role) => {
    currentRole = role;
    providersState.data = { providers: [group('EVOLUTION')], disabledChannels: [DISABLED] };
    wrap(<ConnectPage />);
    expect(screen.getByTestId('evolution-section')).toBeInTheDocument();
    expect(screen.queryByTestId('disabled-channels')).not.toBeInTheDocument();
  });
});

describe('ConnectPage — áreas sem número no topo', () => {
  it('mostra o aviso uma vez e não traz mais a tela "Números e canais"', () => {
    providersState.data = { providers: [group('EVOLUTION')], disabledChannels: [] };
    sectorsState.items = [{ id: 'rh', name: 'RH', channel: null }];
    wrap(<ConnectPage />);
    expect(screen.getAllByText('Áreas sem número: RH')).toHaveLength(1);
    expect(screen.queryByText('Números e canais')).not.toBeInTheDocument();
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

describe('ConnectPage — sem Evolution no servidor', () => {
  it('mostra a mensagem em PT-BR, sem banner nem blocos', () => {
    providersState.data = { providers: [], disabledChannels: [DISABLED] };
    wrap(<ConnectPage />);
    expect(
      screen.getByText('Nenhum provedor configurado no servidor.'),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('evolution-section')).not.toBeInTheDocument();
    expect(screen.queryByTestId('disabled-channels')).not.toBeInTheDocument();
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
