import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HTTPError } from 'ky';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DisabledChannel } from '../api';
import { DisabledChannelsSection } from './disabled-channels-section';

const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock('sonner', () => ({
  toast: {
    success: (...a: unknown[]) => toastSuccess(...a),
    error: (...a: unknown[]) => toastError(...a),
  },
}));

const mutateAsync = vi.fn();
vi.mock('../api', () => ({
  useRemoveDisabledChannel: () => ({ mutateAsync, isPending: false }),
}));

const COM_AREAS: DisabledChannel = {
  id: 'ch1',
  name: 'GBR',
  provider: 'GOZAP',
  phoneE164: '+5511999990000',
  sectorNames: ['Produção', 'RH'],
};
const SEM_AREAS: DisabledChannel = { ...COM_AREAS, id: 'ch2', name: 'Loja 2', sectorNames: [] };

function httpError(body: unknown, status: number) {
  return new HTTPError(
    new Response(JSON.stringify(body), { status }),
    new Request('https://x'),
    {} as never,
  );
}

async function openConfirmation(name: string) {
  await userEvent.click(screen.getByRole('button', { name: `Remover ${name}` }));
  return screen.getByRole('dialog');
}

beforeEach(() => {
  mutateAsync.mockReset();
  toastSuccess.mockReset();
  toastError.mockReset();
});

describe('DisabledChannelsSection', () => {
  it('lista nome, telefone, Integração: GoZap e Áreas: Produção', () => {
    render(
      <DisabledChannelsSection
        channels={[{ ...COM_AREAS, sectorNames: ['Produção'] }]}
      />,
    );
    expect(screen.getByRole('heading', { name: 'Números desligados' })).toBeInTheDocument();
    expect(screen.getByText('GBR')).toBeInTheDocument();
    expect(screen.getByText('+5511999990000')).toBeInTheDocument();
    expect(screen.getByText('Integração: GoZap')).toBeInTheDocument();
    expect(screen.getByText('Áreas: Produção')).toBeInTheDocument();
  });

  it('sem áreas mostra Nenhuma área', () => {
    render(<DisabledChannelsSection channels={[SEM_AREAS]} />);
    expect(screen.getByText('Nenhuma área')).toBeInTheDocument();
  });
});

describe('DisabledChannelsSection — remoção', () => {
  it('Remover abre a confirmação com o texto exato (com áreas) e Remover chama a mutação com o id', async () => {
    mutateAsync.mockResolvedValue(undefined);
    render(<DisabledChannelsSection channels={[COM_AREAS]} />);

    const dialog = await openConfirmation('GBR');
    expect(dialog.textContent).toContain('Remover GBR?');
    expect(dialog.textContent).toContain(
      'As áreas Produção, RH ficam sem número até serem ligadas a um número Evolution. ' +
        'A conexão no GoZap não é apagada por aqui.',
    );
    expect(screen.getByRole('button', { name: 'Cancelar' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Remover' }));

    await waitFor(() => expect(mutateAsync).toHaveBeenCalledWith('ch1'));
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith('Número removido'));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('confirmação sem áreas omite a frase das áreas', async () => {
    render(<DisabledChannelsSection channels={[SEM_AREAS]} />);

    const dialog = await openConfirmation('Loja 2');
    expect(dialog.textContent).toContain('Remover Loja 2?');
    expect(dialog.textContent).toContain('A conexão no GoZap não é apagada por aqui.');
    expect(dialog.textContent).not.toContain('As áreas');
    expect(dialog.textContent).not.toContain('ficam sem número');
  });

  it('erro do back vira toast com a mensagem de readApiErrorBody', async () => {
    mutateAsync.mockRejectedValue(
      httpError({ code: 'channel.not_removable', title: 'Este número não pode ser removido' }, 409),
    );
    render(<DisabledChannelsSection channels={[COM_AREAS]} />);

    await openConfirmation('GBR');
    fireEvent.click(screen.getByRole('button', { name: 'Remover' }));

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith('Este número não pode ser removido'),
    );
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});
