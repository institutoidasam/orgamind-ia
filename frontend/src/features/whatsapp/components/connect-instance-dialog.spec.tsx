// connect-instance-dialog.spec.tsx
import { render, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ConnectInstanceDialog } from './connect-instance-dialog';

type QrResult = {
  data?: { state: 'open' | 'connecting' | 'close'; qrBase64?: string };
  dataUpdatedAt: number;
};

// Mutable QR result so individual tests control what `useInstanceQr` returns,
// including the React Query `dataUpdatedAt` timestamp used to distinguish a
// freshly-fetched result from a stale cached one.
let mockQr: QrResult = { data: undefined, dataUpdatedAt: 0 };
const qrIdCalls: (string | undefined)[] = [];

vi.mock('../api', () => ({
  useInstanceQr: (id?: string) => {
    qrIdCalls.push(id);
    return mockQr;
  },
}));

function wrap(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

describe('ConnectInstanceDialog', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockQr = { data: undefined, dataUpdatedAt: 0 };
    qrIdCalls.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does NOT report a stale cached "open" as connected on reopen', () => {
    // Simulates React Query serving a still-fresh cached { state: 'open' } from a
    // previous connect: the timestamp predates this dialog session, so no new
    // fetch has confirmed the number is actually online.
    mockQr = { data: { state: 'open' }, dataUpdatedAt: 1000 };

    const onConnected = vi.fn();
    const onOpenChange = vi.fn();
    wrap(
      <ConnectInstanceDialog
        instanceId="A"
        instanceName="A"
        open={true}
        onOpenChange={onOpenChange}
        onConnected={onConnected}
      />,
    );

    act(() => {
      vi.advanceTimersByTime(2000);
    });

    expect(onConnected).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it('reports connected once a fresh QR fetch returns state "open"', () => {
    // Dialog opens with nothing fetched yet.
    mockQr = { data: undefined, dataUpdatedAt: 0 };

    const onConnected = vi.fn();
    const onOpenChange = vi.fn();
    const { rerender } = wrap(
      <ConnectInstanceDialog
        instanceId="A"
        instanceName="A"
        open={true}
        onOpenChange={onOpenChange}
        onConnected={onConnected}
      />,
    );

    // A live poll resolves with an online state (timestamp advances past open).
    mockQr = { data: { state: 'open' }, dataUpdatedAt: 5000 };
    rerender(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ConnectInstanceDialog
          instanceId="A"
          instanceName="A"
          open={true}
          onOpenChange={onOpenChange}
          onConnected={onConnected}
        />
      </QueryClientProvider>,
    );

    act(() => {
      vi.advanceTimersByTime(800);
    });

    expect(onConnected).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('does not auto-close when a fresh fetch confirms the number is still offline', () => {
    // Stale cached "open" at open time, then a live poll returns "close".
    mockQr = { data: { state: 'open' }, dataUpdatedAt: 1000 };

    const onConnected = vi.fn();
    const onOpenChange = vi.fn();
    const { rerender } = wrap(
      <ConnectInstanceDialog
        instanceId="A"
        instanceName="A"
        open={true}
        onOpenChange={onOpenChange}
        onConnected={onConnected}
      />,
    );

    mockQr = { data: { state: 'close' }, dataUpdatedAt: 4000 };
    rerender(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ConnectInstanceDialog
          instanceId="A"
          instanceName="A"
          open={true}
          onOpenChange={onOpenChange}
          onConnected={onConnected}
        />
      </QueryClientProvider>,
    );

    act(() => {
      vi.advanceTimersByTime(2000);
    });

    expect(onConnected).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});
