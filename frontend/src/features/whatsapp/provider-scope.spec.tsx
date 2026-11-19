// provider-scope.spec.tsx
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChannelProvider } from './api';

import {
  ProviderScopeProvider,
  useProviderScope,
  ProviderBadge,
  PROVIDER_LABEL,
} from './provider-scope';

const STORAGE_KEY = 'picoa.providerScope';

afterEach(() => {
  cleanup();
  window.localStorage.clear();
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

function renderConsumer() {
  return render(
    <ProviderScopeProvider>
      <ScopeConsumer />
    </ProviderScopeProvider>,
  );
}

describe('useProviderScope', () => {
  it('defaults to "all" when nothing is persisted', () => {
    renderConsumer();
    expect(screen.getByTestId('scope').textContent).toBe('all');
  });

  it("valor persistido 'GOZAP' vira 'all' e a chave legada é apagada", () => {
    window.localStorage.setItem(STORAGE_KEY, 'GOZAP');
    renderConsumer();
    expect(screen.getByTestId('scope').textContent).toBe('all');
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('falls back to "all" for a garbage persisted value', () => {
    window.localStorage.setItem(STORAGE_KEY, 'not-a-real-provider');
    renderConsumer();
    expect(screen.getByTestId('scope').textContent).toBe('all');
  });

  it('setScope updates state and persists under the exact "picoa.providerScope" key', async () => {
    const user = userEvent.setup();
    renderConsumer();
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

  it('keeps provider identity in the tint while using the foreground token for the label', () => {
    render(<ProviderBadge provider="EVOLUTION" />);
    const badge = screen.getByText('Evolution');

    expect(badge).toHaveStyle({ color: 'var(--foreground)' });
    expect(badge.style.background).toMatch(/color-mix\(in oklch, .* 12%, transparent\)/);
    expect(badge.style.borderColor).toMatch(/color-mix\(in oklch, .* 35%, transparent\)/);
  });
});
