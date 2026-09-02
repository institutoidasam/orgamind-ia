import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { QuotaPanel } from './quota-panel';
import type { Instance } from '../schemas';

function makeInstance(overrides: Partial<Instance> = {}): Instance {
  return {
    id: 'i1',
    name: 'Test',
    evolutionInstanceName: 'evo1',
    phoneE164: '+5511999999999',
    profileName: null,
    profilePictureUrl: null,
    ownerUserId: null,
    isDefault: false,
    isActive: true,
    dailySendLimit: 500,
    sentToday: 0,
    sentTodayResetAt: '2026-06-11T00:00:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
    sendWindowStartHour: 8,
    sendWindowEndHour: 20,
    sendWindowEnabled: true,
    lastConnectionState: 'open',
    ...overrides,
  };
}

describe('QuotaPanel', () => {
  it('renders usage as "sent / limit"', () => {
    render(<QuotaPanel instance={makeInstance({ sentToday: 120, dailySendLimit: 500 })} />);
    expect(screen.getByTestId('quota-usage').textContent).toContain('120 / 500');
  });

  it('does NOT show warning badge below threshold', () => {
    render(<QuotaPanel instance={makeInstance({ sentToday: 100, dailySendLimit: 500 })} />);
    expect(screen.queryByTestId('quota-warning-badge')).not.toBeInTheDocument();
  });

  it('shows AVISO warning badge at exactly 80% usage', () => {
    render(<QuotaPanel instance={makeInstance({ sentToday: 400, dailySendLimit: 500 })} />);
    expect(screen.getByTestId('quota-warning-badge')).toHaveTextContent('AVISO');
  });

  it('shows LIMITE badge when usage equals or exceeds the limit', () => {
    render(<QuotaPanel instance={makeInstance({ sentToday: 500, dailySendLimit: 500 })} />);
    expect(screen.getByTestId('quota-warning-badge')).toHaveTextContent('LIMITE');
  });

  it('renders send window label', () => {
    render(
      <QuotaPanel
        instance={makeInstance({ sendWindowStartHour: 8, sendWindowEndHour: 20, sendWindowEnabled: true })}
      />,
    );
    expect(screen.getByTestId('quota-window').textContent).toBe('08:00 – 20:00');
  });

  it('shows "Janela desativada" when send window is disabled', () => {
    render(
      <QuotaPanel instance={makeInstance({ sendWindowEnabled: false })} />,
    );
    expect(screen.getByTestId('quota-window').textContent).toBe('Janela desativada');
  });

  it('renders progress bar with correct aria attributes', () => {
    render(<QuotaPanel instance={makeInstance({ sentToday: 250, dailySendLimit: 500 })} />);
    const bar = screen.getByRole('progressbar');
    expect(bar).toHaveAttribute('aria-valuenow', '250');
    expect(bar).toHaveAttribute('aria-valuemax', '500');
  });

  it('renders next reset time based on sentTodayResetAt', () => {
    render(
      <QuotaPanel
        instance={makeInstance({ sentTodayResetAt: '2026-06-11T10:00:00.000Z' })}
      />,
    );
    // Should render some non-empty reset label derived from the timestamp
    const resetEl = screen.getByTestId('quota-reset');
    expect(resetEl.textContent).not.toBe('—');
    expect(resetEl.textContent).toBeTruthy();
  });

  it('renders "—" for reset time when sentTodayResetAt is absent', () => {
    render(<QuotaPanel instance={makeInstance({ sentTodayResetAt: undefined })} />);
    expect(screen.getByTestId('quota-reset').textContent).toBe('—');
  });
});
