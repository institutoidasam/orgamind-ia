// create-instance-dialog.spec.tsx
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CreateInstanceDialog, QrPane } from './create-instance-dialog';

// Mutable state so individual tests can override the QR response.
let mockQrData: { state: 'open' | 'connecting' | 'close'; qrBase64?: string; pairingCode?: string } | undefined =
  undefined;
let mockCreatedInstance: { id: string; name: string } = { id: 'new-id', name: 'Test' };
// Records every id `useInstanceQr` is polled with so tests can assert the poll
// is disabled (id === undefined) once the dialog closes.
const qrIdCalls: (string | undefined)[] = [];

vi.mock('../api', () => ({
  useCreateInstance: () => ({
    mutateAsync: vi.fn().mockImplementation(() => Promise.resolve(mockCreatedInstance)),
    isPending: false,
  }),
  useInstanceQr: (id?: string) => {
    qrIdCalls.push(id);
    return { data: mockQrData };
  },
}));

function wrap(ui: React.ReactElement) {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      {ui}
    </QueryClientProvider>,
  );
}

describe('CreateInstanceDialog', () => {
  beforeEach(() => {
    mockQrData = undefined;
    mockCreatedInstance = { id: 'new-id', name: 'Test' };
    qrIdCalls.length = 0;
  });

  it('shows zod validation error when name is too short', async () => {
    wrap(<CreateInstanceDialog open={true} onOpenChange={() => {}} onCreated={() => {}} />);
    await userEvent.type(screen.getByLabelText('Nome de exibição'), 'A');
    fireEvent.click(screen.getByRole('button', { name: /Criar e gerar QR/i }));
    await waitFor(() => expect(screen.getByText(/Nome muito curto/i)).toBeInTheDocument());
  });

  it('renders QR image when qrBase64 is returned', async () => {
    mockQrData = { state: 'close', qrBase64: 'ABCD' };
    mockCreatedInstance = { id: 'i1', name: 'X' };

    wrap(<CreateInstanceDialog open={true} onOpenChange={() => {}} onCreated={() => {}} />);

    // Submit the form to transition to QR pane
    await userEvent.type(screen.getByLabelText('Nome de exibição'), 'My Instance');
    fireEvent.click(screen.getByRole('button', { name: /Criar e gerar QR/i }));

    await waitFor(() => {
      const img = screen.queryByAltText('QR code para parear o WhatsApp');
      expect(img).toBeInTheDocument();
      expect(img).toHaveAttribute('src', 'data:image/png;base64,ABCD');
    });
  });

  it('does not poll the QR endpoint while the dialog is closed', () => {
    // Dialog never opened: the QR poll must stay disabled (id === undefined).
    wrap(<CreateInstanceDialog open={false} onOpenChange={() => {}} onCreated={() => {}} />);
    expect(qrIdCalls.every((id) => id === undefined)).toBe(true);
  });

  it('stops polling the QR endpoint after the dialog is closed on the QR step', async () => {
    mockQrData = { state: 'close', qrBase64: 'ABCD' };
    mockCreatedInstance = { id: 'i1', name: 'X' };

    const onOpenChange = vi.fn();
    const { rerender } = wrap(
      <CreateInstanceDialog open={true} onOpenChange={onOpenChange} onCreated={() => {}} />,
    );

    // Advance to the QR step.
    await userEvent.type(screen.getByLabelText('Nome de exibição'), 'My Instance');
    fireEvent.click(screen.getByRole('button', { name: /Criar e gerar QR/i }));
    await waitFor(() =>
      expect(screen.queryByAltText('QR code para parear o WhatsApp')).toBeInTheDocument(),
    );
    // While open on the QR step the poll is active.
    expect(qrIdCalls).toContain('i1');

    // Close the dialog (simulating the parent toggling `open` to false).
    qrIdCalls.length = 0;
    rerender(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <CreateInstanceDialog open={false} onOpenChange={onOpenChange} onCreated={() => {}} />
      </QueryClientProvider>,
    );

    // Once closed, the QR hook must be polled with `undefined` (poll disabled),
    // never with the created instance id.
    expect(qrIdCalls).not.toContain('i1');
    expect(qrIdCalls.every((id) => id === undefined)).toBe(true);
  });
});

describe('QrPane — disconnect reason callout', () => {
  it('shows the reason message + guidance when disconnected with a reason', () => {
    render(
      <QrPane
        state="close"
        instanceName="Vendas"
        qr={{
          state: 'close',
          disconnectionReason: {
            code: 401,
            message: 'Sessão deslogada — o WhatsApp removeu este dispositivo conectado.',
            guidance: 'Para outreach frio use o Twilio com template aprovado e opt-in.',
          },
        }}
      />,
    );
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText(/Motivo da desconexão/i)).toBeInTheDocument();
    expect(screen.getByText(/removeu este dispositivo/i)).toBeInTheDocument();
    expect(screen.getByText(/Twilio/i)).toBeInTheDocument();
  });

  it('does not show the callout when there is no reason', () => {
    render(<QrPane state="close" instanceName="Vendas" qr={{ state: 'close', qrBase64: 'ABCD' }} />);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText(/Motivo da desconexão/i)).not.toBeInTheDocument();
  });

  it('does not show the callout when connected (open), even with a stale reason present', () => {
    render(
      <QrPane
        state="open"
        instanceName="Vendas"
        qr={{
          state: 'open',
          disconnectionReason: { code: 401, message: 'stale', guidance: 'stale' },
        }}
      />,
    );
    expect(screen.getByText(/Conectado/i)).toBeInTheDocument();
    expect(screen.queryByText(/Motivo da desconexão/i)).not.toBeInTheDocument();
  });
});
