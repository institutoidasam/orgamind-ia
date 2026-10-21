import { render, screen, waitFor, within } from '@testing-library/react';
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
import type { SendTarget, TeamChannel } from '../schemas';

const sector: SendTarget = {
  type: 'sector', sectorId: 's1', label: 'Compras · todos os turnos', shift: null, userIds: null,
  recipients: [{ id: 'a', name: 'Ana' }, { id: 'b', name: 'Bia' }, { id: 'c', name: 'Caio' }], leftOut: [],
};
const person: SendTarget = { type: 'user', userId: 'u1', label: 'Rui' };
const channel: TeamChannel = {
  id: 'ch1', name: 'GoZap Principal', phoneE164: '+5592991234567', provider: 'GOZAP', connectionState: 'open',
};
const closed: TeamChannel = {
  id: 'ch2', name: 'Atendimento', phoneE164: '+5592988887777', provider: 'EVOLUTION', connectionState: 'close',
};
const pending: TeamChannel = {
  id: 'ch3', name: 'ROBO', phoneE164: null, provider: 'EVOLUTION', connectionState: 'connecting',
};
const second: TeamChannel = { ...channel, id: 'ch4', name: 'GoZap Reserva', phoneE164: '+5592977776666' };

function setup(
  target: SendTarget = sector,
  channels = [channel],
  query: Record<string, unknown> = { data: { channels, sectors: [] } },
) {
  useTeamTargets.mockReturnValue(query);
  const onOpenChange = vi.fn();
  const view = render(<SendWhatsappDialog open onOpenChange={onOpenChange} target={target} />);
  return { onOpenChange, user: userEvent.setup(), view };
}

async function submit(user: ReturnType<typeof userEvent.setup>, text = 'Oi equipe') {
  await user.type(screen.getByRole('textbox'), text);
  await user.click(screen.getByRole('button', { name: 'Enviar' }));
}

function httpError(status: number, code: string) {
  const response = new Response(JSON.stringify({ code }), { status });
  return new HTTPError(response, new Request('https://x'), {} as never);
}

// Radix Select (shadcn) usa PointerEvents/scrollIntoView, que o jsdom não tem.
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

beforeEach(() => {
  mutateAsync.mockReset();
  toastSuccess.mockReset();
  mutationState.isPending = false;
});

describe('SendWhatsappDialog destino e formulário', () => {
  it('mostra o destino do setor com o turno e a pessoa pelo nome', () => {
    setup();
    expect(screen.getByText('Compras · todos os turnos')).toBeInTheDocument();
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

  it('desabilita Enviar enquanto o envio está em andamento', async () => {
    mutationState.isPending = true;
    const { user } = setup();
    await user.type(screen.getByRole('textbox'), 'Oi');
    expect(screen.getByRole('button', { name: 'Enviando...' })).toBeDisabled();
  });
});

describe('SendWhatsappDialog situação dos canais', () => {
  it('sem canais avisa e mantém Enviar desabilitado', async () => {
    const { user } = setup(sector, []);
    await user.type(screen.getByRole('textbox'), 'Oi');
    expect(screen.getByText('Nenhum canal GoZap ou Evolution ativo.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Enviar' })).toBeDisabled();
  });

  it('mostra canais inutilizáveis desabilitados com a situação, depois dos utilizáveis', async () => {
    const { user } = setup(sector, [pending, closed, channel]);
    await user.click(screen.getByRole('combobox', { name: 'Canal' }));
    const options = screen.getAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual([
      'GoZap Principal · (92) 99123-4567',
      'ROBO · — · Aguardando conexão',
      'Atendimento · (92) 98888-7777 · Desconectado',
    ]);
    expect(options[0]).not.toHaveAttribute('data-disabled');
    expect(options[1]).toHaveAttribute('data-disabled');
    expect(options[2]).toHaveAttribute('data-disabled');
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
});

describe('SendWhatsappDialog auto-seleção, sem canal utilizável e refetch', () => {
  it('escolhe sozinho o único canal utilizável entre vários', async () => {
    const { user } = setup(sector, [pending, closed, channel]);
    await user.type(screen.getByRole('textbox'), 'Oi');
    expect(screen.getByRole('combobox', { name: 'Canal' })).toHaveTextContent('GoZap Principal');
    expect(screen.getByRole('button', { name: 'Enviar' })).toBeEnabled();
  });

  it('com dois utilizáveis nada vem escolhido', async () => {
    const { user } = setup(sector, [channel, second]);
    await user.type(screen.getByRole('textbox'), 'Oi');
    expect(screen.getByRole('combobox', { name: 'Canal' })).toHaveTextContent('Escolha o canal');
    expect(screen.getByRole('button', { name: 'Enviar' })).toBeDisabled();
  });

  it('com canais mas nenhum utilizável avisa para reconectar e mantém Enviar desabilitado', async () => {
    const { user } = setup(sector, [pending, closed]);
    await user.type(screen.getByRole('textbox'), 'Oi');
    expect(screen.getByText('Nenhum canal conectado — reconecte em Números e canais.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Enviar' })).toBeDisabled();
  });

  it('desabilita Enviar quando o canal escolhido fica inutilizável num refetch', async () => {
    const { user, view } = setup(sector, [channel, second]);
    await user.click(screen.getByRole('combobox', { name: 'Canal' }));
    await user.click(screen.getByRole('option', { name: /GoZap Reserva/ }));
    await user.type(screen.getByRole('textbox'), 'Oi');
    expect(screen.getByRole('button', { name: 'Enviar' })).toBeEnabled();
    useTeamTargets.mockReturnValue({
      data: { channels: [channel, { ...second, connectionState: 'close' as const }], sectors: [] },
    });
    view.rerender(<SendWhatsappDialog open onOpenChange={vi.fn()} target={sector} />);
    expect(screen.getByRole('button', { name: 'Enviar' })).toBeDisabled();
    expect(screen.getByRole('combobox', { name: 'Canal' })).toHaveTextContent('Escolha o canal');
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
    mutateAsync.mockRejectedValue(httpError(409, 'team_whatsapp.channel_disconnected'));
    const { user, onOpenChange } = setup();
    await submit(user);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'O canal escolhido está desconectado. Reconecte o número ou escolha outro canal.',
    );
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});

describe('SendWhatsappDialog: nomes', () => {
  const shiftTarget = (userIds: string[] | null, leftOut: { id: string; name: string }[]): SendTarget => ({
    type: 'sector', sectorId: 's1', label: 'Produção · 2º turno', shift: 'SECOND', userIds, leftOut,
    recipients: [{ id: 'joao', name: 'João' }, { id: 'maria', name: 'Maria' }],
  });

  it.each([
    ['todos do turno', shiftTarget(null, [{ id: 'pedro', name: 'Pedro' }]), { shift: 'SECOND' }, true],
    ['selecionados', shiftTarget(['joao', 'maria'], []), { shift: 'SECOND', userIds: ['joao', 'maria'] }, false],
  ])('%s: lista quem recebe e quem fica de fora, e manda só shift/userIds', async (_name, target, extra, hasLeftOut) => {
    mutateAsync.mockResolvedValue({ dispatchId: 'd1', queued: 2, skipped: [] });
    const { user } = setup(target);
    expect(screen.getByText('Produção · 2º turno')).toBeInTheDocument();
    expect(within(screen.getByRole('list', { name: 'Vão receber (2)' })).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['João', 'Maria']);
    expect(screen.queryByText('Ficam de fora (sem telefone)') !== null).toBe(hasLeftOut);
    if (hasLeftOut) {
      expect(within(screen.getByRole('list', { name: 'Ficam de fora (sem telefone)' })).getByText('Pedro')).toBeInTheDocument();
    }
    await submit(user);
    expect(mutateAsync).toHaveBeenCalledWith({ channelId: 'ch1', text: 'Oi equipe', target: { type: 'sector', sectorId: 's1', ...extra } });
  });

  it('seleção inválida (422) mostra que a lista mudou e não fecha', async () => {
    mutateAsync.mockRejectedValue(httpError(422, 'team_whatsapp.invalid_selection'));
    const { user, onOpenChange } = setup(shiftTarget(['joao'], []));
    await submit(user);
    expect(await screen.findByRole('alert')).toHaveTextContent('A lista de pessoas mudou. Atualize a página e confira de novo.');
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});
