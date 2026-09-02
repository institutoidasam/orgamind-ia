// provider-scope.spec.tsx
import { render, screen, cleanup, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChannelProvider, ProvidersResponse } from './api';

// jsdom lacks ResizeObserver / pointer-capture used by the Radix dropdown menu.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = globalThis.ResizeObserver ?? (ResizeObserverStub as never);
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

let providersResult: { data: ProvidersResponse | undefined } = { data: undefined };
vi.mock('./api', () => ({
  CHANNEL_PROVIDERS: ['EVOLUTION', 'TWILIO', 'ZERNIO', 'META'],
  useProviders: () => providersResult,
}));

import {
  ProviderScopeProvider,
  useProviderScope,
  ProviderBadge,
  ProviderScopeSelector,
  PROVIDER_LABEL,
  ConnectionStateBadge,
} from './provider-scope';

const STORAGE_KEY = 'picoa.providerScope';

function group(provider: ChannelProvider) {
  return { provider, channels: [] };
}

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  providersResult = { data: undefined };
});

beforeEach(() => {
  window.localStorage.clear();
});

// --- useProviderScope --------------------------------------------------------

function ScopeConsumer() {
  const { scope, setScope } = useProviderScope();
  return (
    <div>
      <span data-testid="scope">{scope}</span>
      <button type="button" onClick={() => setScope('TWILIO')}>
        set twilio
      </button>
      <button type="button" onClick={() => setScope('all')}>
        set all
      </button>
    </div>
  );
}

describe('useProviderScope', () => {
  it('defaults to "all" when nothing is persisted', () => {
    render(
      <ProviderScopeProvider>
        <ScopeConsumer />
      </ProviderScopeProvider>,
    );
    expect(screen.getByTestId('scope').textContent).toBe('all');
  });

  it('reads the persisted scope from localStorage on mount', () => {
    window.localStorage.setItem(STORAGE_KEY, 'EVOLUTION');
    render(
      <ProviderScopeProvider>
        <ScopeConsumer />
      </ProviderScopeProvider>,
    );
    expect(screen.getByTestId('scope').textContent).toBe('EVOLUTION');
  });

  it('falls back to "all" for a garbage persisted value', () => {
    window.localStorage.setItem(STORAGE_KEY, 'not-a-real-provider');
    render(
      <ProviderScopeProvider>
        <ScopeConsumer />
      </ProviderScopeProvider>,
    );
    expect(screen.getByTestId('scope').textContent).toBe('all');
  });

  it('setScope updates state and persists under the exact "picoa.providerScope" key', async () => {
    const user = userEvent.setup();
    render(
      <ProviderScopeProvider>
        <ScopeConsumer />
      </ProviderScopeProvider>,
    );
    await user.click(screen.getByText('set twilio'));
    expect(screen.getByTestId('scope').textContent).toBe('TWILIO');
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('TWILIO');

    await user.click(screen.getByText('set all'));
    expect(screen.getByTestId('scope').textContent).toBe('all');
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('all');
  });

  it('throws when used outside <ProviderScopeProvider>', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<ScopeConsumer />)).toThrow(/ProviderScopeProvider/);
    spy.mockRestore();
  });
});

// --- ProviderBadge ------------------------------------------------------------

describe('ProviderBadge', () => {
  it('renders the PT-BR label for every provider', () => {
    for (const provider of Object.keys(PROVIDER_LABEL) as ChannelProvider[]) {
      const { unmount } = render(<ProviderBadge provider={provider} />);
      expect(screen.getByText(PROVIDER_LABEL[provider])).toBeInTheDocument();
      unmount();
    }
  });
});

// --- ConnectionStateBadge -------------------------------------------------------

// Isolado: hoje o único lugar que exercita a badge de verdade mockava-a para
// `() => null` (cloud-provider-section.spec.tsx), e nenhum teste do repo
// cobria o estado 'connecting' ("Conectando…").
describe('ConnectionStateBadge', () => {
  it.each([
    ['open', 'Conectado'],
    ['connecting', 'Conectando…'],
    ['close', 'Desconectado'],
  ] as const)('renderiza o rótulo PT-BR do estado "%s"', (state, label) => {
    render(<ConnectionStateBadge state={state} />);
    expect(screen.getByText(label)).toBeInTheDocument();
  });

  it('não renderiza nada quando o estado é null (canal sem sessão — não é "desconectado")', () => {
    const { container } = render(<ConnectionStateBadge state={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('não renderiza nada quando o estado é undefined', () => {
    const { container } = render(<ConnectionStateBadge state={undefined} />);
    expect(container).toBeEmptyDOMElement();
  });
});

// --- ProviderScopeSelector ------------------------------------------------------

function wrap(ui: React.ReactElement) {
  return render(<ProviderScopeProvider>{ui}</ProviderScopeProvider>);
}

describe('ProviderScopeSelector', () => {
  it('renders nothing with 0 configured providers', () => {
    providersResult = { data: { providers: [] } };
    wrap(<ProviderScopeSelector />);
    expect(screen.queryByLabelText('Filtrar por provedor')).not.toBeInTheDocument();
  });

  it('renders nothing with exactly 1 configured provider', () => {
    providersResult = { data: { providers: [group('EVOLUTION')] } };
    wrap(<ProviderScopeSelector />);
    expect(screen.queryByLabelText('Filtrar por provedor')).not.toBeInTheDocument();
  });

  it('renders the selector with 2+ configured providers, defaulting to "Todos os canais"', () => {
    providersResult = { data: { providers: [group('EVOLUTION'), group('TWILIO')] } };
    wrap(<ProviderScopeSelector />);
    const trigger = screen.getByLabelText('Filtrar por provedor');
    expect(trigger).toBeInTheDocument();
    expect(trigger).toHaveTextContent('Todos os canais');
  });

  it('lists "Todos os canais" plus one item per configured provider, and updates the scope on selection', async () => {
    providersResult = { data: { providers: [group('EVOLUTION'), group('TWILIO'), group('ZERNIO')] } };
    const user = userEvent.setup();
    wrap(<ProviderScopeSelector />);

    await user.click(screen.getByLabelText('Filtrar por provedor'));
    expect(screen.getByRole('menuitemradio', { name: 'Todos os canais' })).toBeInTheDocument();
    expect(screen.getByRole('menuitemradio', { name: 'Evolution' })).toBeInTheDocument();
    expect(screen.getByRole('menuitemradio', { name: 'Twilio' })).toBeInTheDocument();
    expect(screen.getByRole('menuitemradio', { name: 'Zernio' })).toBeInTheDocument();
    // Meta isn't configured in this deploy, so it shouldn't be offered.
    expect(screen.queryByRole('menuitemradio', { name: 'Meta' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('menuitemradio', { name: 'Twilio' }));
    await act(async () => {});
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('TWILIO');
    expect(screen.getByLabelText('Filtrar por provedor')).toHaveTextContent('Twilio');
  });
});
