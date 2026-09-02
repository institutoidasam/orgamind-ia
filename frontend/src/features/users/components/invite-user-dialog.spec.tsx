// invite-user-dialog.spec.tsx
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { InviteUserDialog } from './invite-user-dialog';

// jsdom lacks the APIs the Radix Select primitive relies on.
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

const mutateAsync = vi.fn().mockResolvedValue({ user: {}, temporaryPassword: 'pw' });
vi.mock('../api', () => ({
  useInviteUser: () => ({ mutateAsync, isPending: false }),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

function wrap(ui: React.ReactElement) {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      {ui}
    </QueryClientProvider>,
  );
}

beforeEach(() => mutateAsync.mockClear());
afterEach(() => cleanup());

function emailInput(): HTMLInputElement {
  const el = document.querySelector('input[type="email"]');
  if (!el) throw new Error('email input not found');
  return el as HTMLInputElement;
}

describe('InviteUserDialog', () => {
  it('clears a typed email after the dialog is closed and reopened', async () => {
    const onOpenChange = vi.fn();
    const { rerender } = wrap(<InviteUserDialog open onOpenChange={onOpenChange} />);

    await userEvent.type(emailInput(), 'typed@x.com');
    expect(emailInput().value).toBe('typed@x.com');

    // Close
    rerender(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <InviteUserDialog open={false} onOpenChange={onOpenChange} />
      </QueryClientProvider>,
    );
    // Reopen
    rerender(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <InviteUserDialog open onOpenChange={onOpenChange} />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(emailInput().value).toBe(''));
  });

  it('submits the role chosen in the Select (controlled, in sync)', async () => {
    wrap(<InviteUserDialog open onOpenChange={() => {}} />);

    await userEvent.type(emailInput(), 'admin@x.com');

    // Open the role select and pick Admin.
    fireEvent.click(screen.getByRole('combobox'));
    fireEvent.click(await screen.findByRole('option', { name: 'Admin' }));

    fireEvent.click(screen.getByRole('button', { name: /^Convidar$/i }));

    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'admin@x.com', role: 'ADMIN' }),
    );
  });

  it('defaults the role to OPERATOR when left unchanged', async () => {
    wrap(<InviteUserDialog open onOpenChange={() => {}} />);
    await userEvent.type(emailInput(), 'op@x.com');
    fireEvent.click(screen.getByRole('button', { name: /^Convidar$/i }));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'op@x.com', role: 'OPERATOR' }),
    );
  });
});
