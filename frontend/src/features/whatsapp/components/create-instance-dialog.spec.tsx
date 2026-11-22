// create-instance-dialog.spec.tsx
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HTTPError } from 'ky';
import { CreateInstanceDialog, QrPane } from './create-instance-dialog';

// Mutable state so individual tests can override the QR response.
let mockQrData: { state: 'open' | 'connecting' | 'close'; qrBase64?: string; pairingCode?: string } | undefined =
  undefined;
let mockCreatedInstance: { id: string; name: string } = { id: 'new-id', name: 'Test' };
// Records every id `useInstanceQr` is polled with so tests can assert the poll
// is disabled (id === undefined) once the dialog closes.
const qrIdCalls: (string | undefined)[] = [];

const createMock = vi.fn();
const sectorList = vi.hoisted(() => ({ items: [] as unknown[] }));
vi.mock('@/features/internal-admin/api', () => ({
  useSectors: () => ({ data: { items: sectorList.items }, isLoading: false }),
}));

vi.mock('../api', () => ({
  useCreateInstance: () => ({ mutateAsync: createMock, isPending: false }),
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

beforeEach(() => {
  createMock.mockReset();
  createMock.mockImplementation(() => Promise.resolve(mockCreatedInstance));
  sectorList.items = [
    { id: 'log', name: 'Logística', channel: null },
    { id: 'exp', name: 'Expedição', channel: null },
  ];
});

// A recusa como o ky 2 entrega: o corpo já parseado em `HTTPError.data`.
function problem(status: number, code: string, title: string) {
  const body = { title, code, status };
  const error = new HTTPError(new Response(JSON.stringify(body), { status }), new Request('https://x'), {} as never);
  error.data = body;
  return error;
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
});

describe('CreateInstanceDialog', () => {
  beforeEach(() => {
    mockQrData = undefined;
    mockCreatedInstance = { id: 'new-id', name: 'Test' };
    qrIdCalls.length = 0;
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

async function fillName() {
  await userEvent.type(screen.getByLabelText('Nome de exibição'), 'Loja 1');
}

describe('CreateInstanceDialog — áreas do número', () => {
  afterEach(() => vi.useRealTimers());

  it('marcar Logística e Expedição envia sectorIds no input', async () => {
    wrap(<CreateInstanceDialog open={true} onOpenChange={() => {}} onCreated={() => {}} />);
    await fillName();
    await userEvent.click(screen.getByRole('checkbox', { name: 'Logística' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Expedição' }));
    fireEvent.click(screen.getByRole('button', { name: /Criar e gerar QR/i }));

    await waitFor(() =>
      expect(createMock).toHaveBeenCalledWith(expect.objectContaining({ name: 'Loja 1', sectorIds: ['log', 'exp'] })),
    );
  });

  it('área em outro número pede confirmação: Cancelar não cria e Mover cria', async () => {
    sectorList.items = [{ id: 'log', name: 'Logística', channel: { id: 'c9', name: 'Loja 9', phoneE164: '+5592911111111' } }];
    wrap(<CreateInstanceDialog open={true} onOpenChange={() => {}} onCreated={() => {}} />);
    await fillName();
    await userEvent.click(screen.getByRole('checkbox', { name: 'Logística' }));
    fireEvent.click(screen.getByRole('button', { name: /Criar e gerar QR/i }));

    expect(await screen.findByText('Logística sai do número +5592911111111 e passa para este.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(createMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /Criar e gerar QR/i }));
    await userEvent.click(await screen.findByRole('button', { name: 'Mover' }));
    await waitFor(() =>
      expect(createMock).toHaveBeenCalledWith(expect.objectContaining({ sectorIds: ['log'] })),
    );
  });
});

describe('CreateInstanceDialog — áreas do número', () => {
  afterEach(() => vi.useRealTimers());

  it('fechar sozinho depois do QR conectado limpa as áreas: ao reabrir não há confirmação de mover', async () => {
    sectorList.items = [{ id: 'log', name: 'Logística', channel: { id: 'c9', name: 'Loja 9', phoneE164: '+5592911111111' } }];
    mockQrData = { state: 'close', qrBase64: 'ABCD' };
    mockCreatedInstance = { id: 'i1', name: 'Loja 1' };
    const onOpenChange = vi.fn();
    const onCreated = vi.fn();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const dialog = (open: boolean) => (
      <QueryClientProvider client={client}>
        <CreateInstanceDialog open={open} onOpenChange={onOpenChange} onCreated={onCreated} />
      </QueryClientProvider>
    );
    const { rerender } = render(dialog(true));
    await fillName();
    await userEvent.click(screen.getByRole('checkbox', { name: 'Logística' }));
    fireEvent.click(screen.getByRole('button', { name: /Criar e gerar QR/i }));
    await userEvent.click(await screen.findByRole('button', { name: 'Mover' }));
    await screen.findByAltText('QR code para parear o WhatsApp');

    vi.useFakeTimers();
    mockQrData = { state: 'open' };
    rerender(dialog(true));
    act(() => { vi.advanceTimersByTime(800); });
    vi.useRealTimers();
    expect(onOpenChange).toHaveBeenCalledWith(false);

    rerender(dialog(false));
    rerender(dialog(true));
    expect(screen.queryByRole('button', { name: 'Mover' })).not.toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Logística' })).not.toBeChecked();
  });

  it('recusa do back (channel.sectors_not_team) aparece no alerta do formulário', async () => {
    const title = 'Este número não serve para o WhatsApp da equipe.';
    createMock.mockRejectedValue(problem(422, 'channel.sectors_not_team', title));
    wrap(<CreateInstanceDialog open={true} onOpenChange={() => {}} onCreated={() => {}} />);
    await fillName();
    fireEvent.click(screen.getByRole('button', { name: /Criar e gerar QR/i }));

    expect(await screen.findByText(title)).toBeInTheDocument();
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
