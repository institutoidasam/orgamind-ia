import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HTTPError } from 'ky';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mutateAsync, toastSuccess, useTeamTargets, mutationState } = vi.hoisted(() => ({
  mutateAsync: vi.fn(),
  toastSuccess: vi.fn(),
  useTeamTargets: vi.fn(),
  mutationState: { isPending: false },
}));

vi.mock('../api', () => ({
  useTeamTargets: () => useTeamTargets(),
  useCreateTeamDispatch: () => ({ mutateAsync, isPending: mutationState.isPending }),
}));
vi.mock('sonner', () => ({ toast: { success: toastSuccess, error: vi.fn() } }));

import { SendWhatsappDialog } from './send-whatsapp-dialog';
import type { SendTarget } from '../schemas';

const sector: SendTarget = { type: 'sector', sectorId: 's1', label: 'Compras', recipientCount: 3 };
const person: SendTarget = { type: 'user', userId: 'u1', label: 'Rui' };
const channel = { id: 'ch1', name: 'GoZap Principal', phoneE164: '+5592991234567', provider: 'GOZAP' as const };

function setup(
  target: SendTarget = sector,
  channels = [channel],
  query: Record<string, unknown> = { data: { channels, sectors: [] } },
) {
  useTeamTargets.mockReturnValue(query);
  const onOpenChange = vi.fn();
  render(<SendWhatsappDialog open onOpenChange={onOpenChange} target={target} />);
  return { onOpenChange, user: userEvent.setup() };
}

async function submit(user: ReturnType<typeof userEvent.setup>, text = 'Oi equipe') {
  await user.type(screen.getByRole('textbox'), text);
  await user.click(screen.getByRole('button', { name: 'Enviar' }));
}

function http409(code: string) {
  const response = new Response(JSON.stringify({ code }), { status: 409 });
  return new HTTPError(response, new Request('https://x'), {} as never);
}

beforeEach(() => {
  mutateAsync.mockReset();
  toastSuccess.mockReset();
  mutationState.isPending = false;
});

describe('SendWhatsappDialog destino e formulário', () => {
  it('mostra o setor com a quantidade de pessoas e a pessoa pelo nome', () => {
    setup();
    expect(screen.getByText('Setor Compras · 3 pessoa(s)')).toBeInTheDocument();
  });

  it('mostra só o nome quando o destino é uma pessoa', () => {
    setup(person);
    expect(screen.getByText('Rui')).toBeInTheDocument();
  });

  it('pré-seleciona o único canal e só habilita Enviar com texto', async () => {
    const { user } = setup();
    expect(screen.getByText(/GoZap Principal/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Enviar' })).toBeDisabled();
    await user.type(screen.getByRole('textbox'), 'Oi equipe');
    expect(screen.getByRole('button', { name: 'Enviar' })).toBeEnabled();
    expect(screen.getByText('9/2000')).toBeInTheDocument();
  });

  it('sem canais avisa e mantém Enviar desabilitado', async () => {
    const { user } = setup(sector, []);
    await user.type(screen.getByRole('textbox'), 'Oi');
    expect(screen.getByText('Nenhum canal GoZap ou Evolution ativo.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Enviar' })).toBeDisabled();
  });

  it('enquanto os canais carregam mostra "Carregando canais…" e mantém Enviar desabilitado', async () => {
    const { user } = setup(sector, [], { data: undefined, isLoading: true, isError: false });
    await user.type(screen.getByRole('textbox'), 'Oi');
    expect(screen.getByText('Carregando canais…')).toBeInTheDocument();
    expect(screen.queryByText(/Nenhum canal/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Enviar' })).toBeDisabled();
  });

  it('com erro ao carregar os canais mostra mensagem de erro, não "Nenhum canal"', async () => {
    const { user } = setup(sector, [], { data: undefined, isLoading: false, isError: true });
    await user.type(screen.getByRole('textbox'), 'Oi');
    expect(screen.getByRole('alert')).toHaveTextContent('Não foi possível carregar os canais.');
    expect(screen.queryByText(/Nenhum canal/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Enviar' })).toBeDisabled();
  });

  it('desabilita Enviar enquanto o envio está em andamento', async () => {
    mutationState.isPending = true;
    const { user } = setup();
    await user.type(screen.getByRole('textbox'), 'Oi');
    expect(screen.getByRole('button', { name: 'Enviando...' })).toBeDisabled();
  });
});

describe('SendWhatsappDialog envio', () => {
  it('envia o setor e avisa com a demora e os pulados', async () => {
    mutateAsync.mockResolvedValue({
      dispatchId: 'd1', queued: 2,
      skipped: [{ userId: 'u3', name: 'Rui', reason: 'NO_PHONE' }],
    });
    const { user, onOpenChange } = setup();
    await submit(user);
    expect(mutateAsync).toHaveBeenCalledWith({
      channelId: 'ch1', text: 'Oi equipe', target: { type: 'sector', sectorId: 's1' },
    });
    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
    const [title, opts] = toastSuccess.mock.calls[0];
    expect(title).toBe('Mensagem enfileirada para 2 pessoa(s)');
    expect(opts.description).toMatch(/^Os envios saem aos poucos, no ritmo do canal; para um setor grande pode levar alguns minutos\./);
    expect(opts.description).toContain('Rui: sem telefone');
    expect(opts.classNames).toEqual({ description: 'whitespace-pre-line' });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('envia a pessoa pelo userId', async () => {
    mutateAsync.mockResolvedValue({ dispatchId: 'd2', queued: 1, skipped: [] });
    const { user } = setup(person);
    await submit(user);
    expect(mutateAsync).toHaveBeenCalledWith({
      channelId: 'ch1', text: 'Oi equipe', target: { type: 'user', userId: 'u1' },
    });
  });

  it('mostra no diálogo o erro 409 de canal desconectado e não fecha', async () => {
    mutateAsync.mockRejectedValue(http409('team_whatsapp.channel_disconnected'));
    const { user, onOpenChange } = setup();
    await submit(user);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'O canal escolhido está desconectado. Reconecte o número ou escolha outro canal.',
    );
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});
