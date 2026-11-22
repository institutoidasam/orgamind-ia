import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HTTPError } from 'ky';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EditChannelSectorsDialog } from './edit-channel-sectors-dialog';

const mocks = vi.hoisted(() => ({
  mutateAsync: vi.fn(),
  toastSuccess: vi.fn(),
  sectors: [] as unknown[],
}));
vi.mock('../api', () => ({
  useUpdateChannelSectors: () => ({ mutateAsync: mocks.mutateAsync, isPending: false }),
}));
vi.mock('@/features/internal-admin/api', () => ({
  useSectors: () => ({ data: { items: mocks.sectors }, isLoading: false }),
}));
vi.mock('sonner', () => ({ toast: { success: mocks.toastSuccess, error: vi.fn() } }));

const channel = { id: 'c1', name: 'Loja 1', sectors: [{ id: 'log', name: 'Logística' }] };

function renderDialog(onOpenChange = vi.fn()) {
  render(<EditChannelSectorsDialog channel={channel} open onOpenChange={onOpenChange} />);
  return onOpenChange;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.mutateAsync.mockResolvedValue({ channelId: 'c1', sectors: [], moved: [] });
  mocks.sectors = [
    { id: 'log', name: 'Logística', channel: { id: 'c1', name: 'Loja 1', phoneE164: null } },
    { id: 'exp', name: 'Expedição', channel: null },
  ];
});

describe('EditChannelSectorsDialog', () => {
  it('abre com as áreas do número marcadas; salvar envia a lista final', async () => {
    const onOpenChange = renderDialog();
    expect(screen.getByRole('checkbox', { name: 'Logística' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Expedição' })).not.toBeChecked();

    await userEvent.click(screen.getByRole('checkbox', { name: 'Expedição' }));
    await userEvent.click(screen.getByRole('button', { name: 'Salvar' }));

    await waitFor(() => expect(mocks.mutateAsync).toHaveBeenCalledWith({ channelId: 'c1', sectorIds: ['log', 'exp'] }));
    expect(mocks.toastSuccess).toHaveBeenCalledWith('Áreas atualizadas');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('área em outro número pede confirmação: Cancelar não envia e Mover envia', async () => {
    mocks.sectors = [
      { id: 'log', name: 'Logística', channel: { id: 'c1', name: 'Loja 1', phoneE164: null } },
      { id: 'exp', name: 'Expedição', channel: { id: 'c9', name: 'Loja 9', phoneE164: '+5592922222222' } },
    ];
    renderDialog();
    await userEvent.click(screen.getByRole('checkbox', { name: 'Expedição' }));
    await userEvent.click(screen.getByRole('button', { name: 'Salvar' }));

    expect(screen.getByText('Expedição sai do número +5592922222222 e passa para este.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(mocks.mutateAsync).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    await userEvent.click(screen.getByRole('button', { name: 'Mover' }));
    await waitFor(() => expect(mocks.mutateAsync).toHaveBeenCalledWith({ channelId: 'c1', sectorIds: ['log', 'exp'] }));
  });

  it('recusa do back aparece no alerta com a frase do servidor', async () => {
    const title = 'Este número não serve para o WhatsApp da equipe.';
    const body = JSON.stringify({ title, code: 'channel.sectors_not_team', status: 422 });
    const error = new HTTPError(new Response(body, { status: 422 }), new Request('https://x'), {} as never);
    error.data = JSON.parse(body);
    mocks.mutateAsync.mockRejectedValue(error);
    renderDialog();

    await userEvent.click(screen.getByRole('button', { name: 'Salvar' }));

    expect(await screen.findByText(title)).toBeInTheDocument();
  });
});
