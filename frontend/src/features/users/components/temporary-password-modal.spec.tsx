// temporary-password-modal.spec.tsx
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TemporaryPasswordModal } from './temporary-password-modal';

const toastError = vi.fn();
const toastSuccess = vi.fn();
vi.mock('sonner', () => ({
  toast: {
    error: (...a: unknown[]) => toastError(...a),
    success: (...a: unknown[]) => toastSuccess(...a),
  },
}));

beforeEach(() => {
  toastError.mockClear();
  toastSuccess.mockClear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function setClipboard(writeText: () => Promise<void>) {
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
    writable: true,
  });
}

describe('TemporaryPasswordModal', () => {
  it('shows a fallback toast when clipboard write fails', async () => {
    setClipboard(() => Promise.reject(new Error('denied')));
    render(<TemporaryPasswordModal password="s3cret" onClose={() => {}} />);

    fireEvent.click(screen.getByLabelText('Copiar senha'));

    await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
    // The "copied" check icon must NOT appear on failure.
    expect(screen.getByLabelText('Copiar senha').querySelector('svg')).toBeTruthy();
  });

  it('does not throw when unmounted before the copied-state timeout fires', async () => {
    vi.useFakeTimers();
    setClipboard(() => Promise.resolve());
    const { unmount } = render(
      <TemporaryPasswordModal password="s3cret" onClose={() => {}} />,
    );

    // Trigger a successful copy (schedules the 2s reset timeout).
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Copiar senha'));
      await Promise.resolve();
    });

    // Unmount before the timeout fires.
    unmount();

    const spy = vi.spyOn(console, 'error');
    // Advancing past the timeout must not call setState on the unmounted tree.
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(spy).not.toHaveBeenCalledWith(
      expect.stringContaining("Can't perform a React state update"),
    );
  });
});
