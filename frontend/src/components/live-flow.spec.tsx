import { act, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LiveFlow } from './live-flow';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('LiveFlow', () => {
  it('renders each stage count and keeps its indicator above particles', () => {
    render(<LiveFlow counts={{ queued: 12, sent: 23, delivered: 91, read: 72, failed: 4 }} />);

    expect(within(screen.getByTestId('flow-stage-queued')).getByText('12')).toBeInTheDocument();
    expect(within(screen.getByTestId('flow-stage-sent')).getByText('23')).toBeInTheDocument();
    expect(within(screen.getByTestId('flow-stage-delivered')).getByText('91')).toBeInTheDocument();
    expect(within(screen.getByTestId('flow-stage-read')).getByText('72')).toBeInTheDocument();
    expect(screen.getByTestId('flow-stage-sent')).toHaveClass('z-10');
    expect(screen.getByText('falhas')).toBeInTheDocument();
  });

  it('creates a bounded particle behind the stages while the page is visible', () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation((values) => {
      (values as Uint32Array)[0] = 0;
      return values;
    });

    const { container, unmount } = render(
      <LiveFlow counts={{ queued: 0, sent: 0, delivered: 0, read: 0, failed: 0 }} />,
    );
    const ownerDocument = container.ownerDocument;
    act(() => vi.advanceTimersByTime(280));

    const particle = screen.getByTestId('flow-particle');
    expect(particle).toHaveClass('z-0');
    expect(particle).toHaveStyle({ top: '16px' });
    expect(particle.style.background).toBe('var(--st-queued-bg)');

    Object.defineProperty(ownerDocument, 'visibilityState', { configurable: true, value: 'hidden' });
    act(() => ownerDocument.dispatchEvent(new Event('visibilitychange')));
    act(() => vi.advanceTimersByTime(2300));
    expect(screen.queryByTestId('flow-particle')).not.toBeInTheDocument();

    unmount();
    Object.defineProperty(ownerDocument, 'visibilityState', { configurable: true, value: 'visible' });
  });
});
