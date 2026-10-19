// temporary-password-modal.spec.tsx
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TemporaryPasswordModal } from './temporary-password-modal';

const toastError = vi.fn();
const toastSuccess = vi.fn();
const toastInfo = vi.fn();
vi.mock('sonner', () => ({
  toast: {
    error: (...a: unknown[]) => toastError(...a),
    success: (...a: unknown[]) => toastSuccess(...a),
    info: (...a: unknown[]) => toastInfo(...a),
  },
}));

beforeEach(() => {
  toastError.mockClear();
  toastSuccess.mockClear();
  toastInfo.mockClear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  Reflect.deleteProperty(document, 'execCommand');
});

function setClipboard(writeText?: () => Promise<void>) {
  Object.defineProperty(navigator, 'clipboard', {
    value: writeText ? { writeText } : undefined,
    configurable: true,
    writable: true,
  });
}

// jsdom does not implement document.execCommand, so each test installs its own.
function setExecCommand(impl: () => boolean) {
  const execCommand = vi.fn(impl);
  Object.defineProperty(document, 'execCommand', {
    value: execCommand,
    configurable: true,
    writable: true,
  });
  return execCommand;
}

const passwordInput = () => screen.getByLabelText('Senha temporária') as HTMLInputElement;
const copyButton = () => screen.getByLabelText('Copiar senha');
const showsCopiedIcon = () => copyButton().querySelector('.lucide-check') !== null;

// Registra, no momento do execCommand, se o campo estava focado e com a senha inteira selecionada.
function setExecCommandRecordingSelection() {
  const atCopy = { focused: false, fullySelected: false };
  const execCommand = setExecCommand(() => {
    atCopy.focused = document.activeElement === passwordInput();
    atCopy.fullySelected =
      passwordInput().selectionStart === 0 && passwordInput().selectionEnd === 's3cret'.length;
    return true;
  });
  return { execCommand, atCopy };
}

describe('TemporaryPasswordModal: campo e cópia pelo clipboard', () => {
  it('shows the password in a read-only field inside the modal', () => {
    setClipboard(() => Promise.resolve());
    render(<TemporaryPasswordModal password="s3cret" onClose={() => {}} />);

    expect(passwordInput()).toHaveValue('s3cret');
    expect(passwordInput()).toHaveAttribute('readonly');
  });

  it('copies through the clipboard API and shows the success icon', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    const execCommand = setExecCommand(() => true);
    setClipboard(writeText);
    render(<TemporaryPasswordModal password="s3cret" onClose={() => {}} />);

    fireEvent.click(copyButton());

    await waitFor(() => expect(showsCopiedIcon()).toBe(true));
    expect(writeText).toHaveBeenCalledWith('s3cret');
    expect(execCommand).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
    expect(toastInfo).not.toHaveBeenCalled();
  });
});

describe('TemporaryPasswordModal: fallback para execCommand', () => {
  it('falls back to execCommand when the clipboard write is rejected', async () => {
    const { execCommand, atCopy } = setExecCommandRecordingSelection();
    setClipboard(() => Promise.reject(new Error('denied')));
    render(<TemporaryPasswordModal password="s3cret" onClose={() => {}} />);

    fireEvent.click(copyButton());

    await waitFor(() => expect(showsCopiedIcon()).toBe(true));
    expect(execCommand).toHaveBeenCalledWith('copy');
    expect(atCopy).toEqual({ focused: true, fullySelected: true });
    expect(toastError).not.toHaveBeenCalled();
    expect(toastInfo).not.toHaveBeenCalled();
  });

  it('falls back to execCommand when navigator.clipboard is unavailable', async () => {
    const { atCopy } = setExecCommandRecordingSelection();
    setClipboard(undefined);
    render(<TemporaryPasswordModal password="s3cret" onClose={() => {}} />);

    fireEvent.click(copyButton());

    await waitFor(() => expect(showsCopiedIcon()).toBe(true));
    expect(atCopy).toEqual({ focused: true, fullySelected: true });
    expect(toastError).not.toHaveBeenCalled();
    expect(toastInfo).not.toHaveBeenCalled();
  });
});

describe('TemporaryPasswordModal: seleção manual e erro', () => {
  it('selects the password for manual copy when both automatic copies fail', async () => {
    setExecCommand(() => false);
    setClipboard(() => Promise.reject(new Error('denied')));
    render(<TemporaryPasswordModal password="s3cret" onClose={() => {}} />);
    passwordInput().blur();

    fireEvent.click(copyButton());

    await waitFor(() => expect(toastInfo).toHaveBeenCalledWith('Senha selecionada', {
      description: 'Pressione Ctrl+C para copiar.',
    }));
    expect(document.activeElement).toBe(passwordInput());
    expect(passwordInput().selectionStart).toBe(0);
    expect(passwordInput().selectionEnd).toBe('s3cret'.length);
    expect(showsCopiedIcon()).toBe(false);
    expect(toastError).not.toHaveBeenCalled();
  });

  it('shows the error toast only when the manual selection step throws', async () => {
    setExecCommand(() => false);
    setClipboard(undefined);
    toastInfo.mockImplementationOnce(() => {
      throw new Error('toast failed');
    });
    render(<TemporaryPasswordModal password="s3cret" onClose={() => {}} />);

    fireEvent.click(copyButton());

    await waitFor(() => expect(toastError).toHaveBeenCalledWith('Não foi possível copiar', {
      description: 'Copie a senha manualmente.',
    }));
    expect(showsCopiedIcon()).toBe(false);
  });
});

describe('TemporaryPasswordModal: desmontagem', () => {
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
