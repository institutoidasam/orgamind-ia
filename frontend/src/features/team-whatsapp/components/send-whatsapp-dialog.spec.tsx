import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HTTPError } from 'ky';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mutateAsync, toastSuccess, useTeamRoster, useTeamPersonRoute, mutationState, auth } = vi.hoisted(() => ({
  mutateAsync: vi.fn(),
  toastSuccess: vi.fn(),
  useTeamRoster: vi.fn(),
  useTeamPersonRoute: vi.fn(),
  mutationState: { isPending: false },
  auth: { role: 'OPERATOR' },
}));

vi.mock('../api', () => ({
  useTeamRoster: (...args: unknown[]) => useTeamRoster(...args),
  useTeamPersonRoute: (...args: unknown[]) => useTeamPersonRoute(...args),
  useCreateTeamDispatch: () => ({ mutateAsync, isPending: mutationState.isPending }),
}));
vi.mock('sonner', () => ({ toast: { success: toastSuccess, error: vi.fn() } }));
vi.mock('@/stores/auth.store', () => ({
  useAuthStore: (sel: (s: unknown) => unknown) => sel({ user: { role: auth.role } }),
}));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => <a href={to}>{children}</a>,
}));

import { SendWhatsappDialog } from './send-whatsapp-dialog';
import type { LeftOutPerson, SendTarget, TeamSectorChannel } from '../schemas';

const sector: SendTarget = {
  type: 'sector', sectorIds: ['s1'], levelIds: [], withoutLevel: false,
  label: 'Compras · todos os turnos · 21/10', date: '2026-10-21',
  shiftIds: [], includeOff: false, userIds: null,
  recipients: [{ id: 'a', name: 'Ana' }, { id: 'b', name: 'Bia' }, { id: 'c', name: 'Caio' }], leftOut: [],
};
const person: SendTarget = { type: 'user', userId: 'u1', label: 'Rui' };

const NUMBER = '+5592991234567';
const channel = (state: TeamSectorChannel['live']['state'] = 'open'): TeamSectorChannel => ({
  id: 'ch1', name: 'GoZap Principal', phoneE164: NUMBER, provider: 'GOZAP',
  live: { state, checkedAt: new Date(2026, 10, 10, 14, 5).toISOString() },
});

const refetch = vi.fn();
type Query = { data?: unknown; isLoading?: boolean; isError?: boolean; isFetching?: boolean };
const answer = (query: Query) => ({ isLoading: false, isError: false, isFetching: false, refetch, ...query });

/** A escala traz cada pessoa em um só setor: a primeira área fica com quem recebe (como no servidor). */
function rosterOf(target: SendTarget, ch: TeamSectorChannel | null = channel()) {
  const ids = target.type === 'sector' ? target.sectorIds : [];
  const recipients = target.type === 'sector' ? target.recipients : [];
  return {
    date: '2026-10-21', shiftStarts: [],
    sectors: ids.map((id, i) => ({ sectorId: id, name: id === 's1' ? 'Compras' : id, channel: ch, members: i === 0 ? recipients : [] })),
  };
}

type Route = { roster?: Query; person?: Query };

function setup(target: SendTarget = sector, route: Route = {}) {
  useTeamRoster.mockReturnValue(answer(route.roster ?? { data: rosterOf(target) }));
  useTeamPersonRoute.mockReturnValue(answer(route.person ?? {
    data: { userId: 'u1', sector: { id: 's1', name: 'Compras' }, channel: channel() },
  }));
  const onOpenChange = vi.fn();
  const qc = new QueryClient();
  const invalidate = vi.spyOn(qc, 'invalidateQueries');
  const view = render(
    <QueryClientProvider client={qc}>
      <SendWhatsappDialog open onOpenChange={onOpenChange} target={target} />
    </QueryClientProvider>,
  );
  return { onOpenChange, user: userEvent.setup(), view, invalidate };
}

async function submit(user: ReturnType<typeof userEvent.setup>, text = 'Oi equipe') {
  await user.type(screen.getByRole('textbox'), text);
  await user.click(screen.getByRole('button', { name: 'Enviar agora' }));
}

function httpError(status: number, code: string) {
  const response = new Response(JSON.stringify({ code }), { status });
  return new HTTPError(response, new Request('https://x'), {} as never);
}

beforeEach(() => {
  mutateAsync.mockReset();
  toastSuccess.mockReset();
  refetch.mockReset();
  mutationState.isPending = false;
  auth.role = 'OPERATOR';
});

describe('SendWhatsappDialog destino e formulário', () => {
  it('mostra o destino do setor com o turno e a pessoa pelo nome', () => {
    setup();
    expect(screen.getByText('Compras · todos os turnos · 21/10')).toBeInTheDocument();
  });

  it('mostra só o nome quando o destino é uma pessoa', () => {
    setup(person);
    expect(screen.getByText('Rui')).toBeInTheDocument();
  });

  it('só habilita Enviar com texto', async () => {
    const { user } = setup();
    expect(screen.getByRole('button', { name: 'Enviar agora' })).toBeDisabled();
    await user.type(screen.getByRole('textbox'), 'Oi');
    expect(screen.getByRole('button', { name: 'Enviar agora' })).toBeEnabled();
  });

  it('desabilita Enviar enquanto o envio está em andamento', async () => {
    mutationState.isPending = true;
    const { user } = setup();
    await user.type(screen.getByRole('textbox'), 'Oi');
    expect(screen.getByRole('button', { name: 'Enviando...' })).toBeDisabled();
  });
});

describe('SendWhatsappDialog número por área (sem seletor de canal)', () => {
  it('não tem campo Canal e mostra a divisão por número com a hora conferida', () => {
    setup();
    expect(screen.queryByLabelText('Canal')).not.toBeInTheDocument();
    expect(screen.queryByText('Canal')).not.toBeInTheDocument();
    expect(screen.getByText(`Compras, 3 pessoas, pelo ${NUMBER}`)).toBeInTheDocument();
    expect(screen.getByText('conferido às 14:05')).toBeInTheDocument();
  });

  it('a consulta da escala usa os setores e a data do envio', () => {
    setup();
    expect(useTeamRoster).toHaveBeenCalledWith(['s1'], '2026-10-21');
  });
});

describe('SendWhatsappDialog número por área (sem seletor de canal)', () => {
  describe('com turno único e início futuro (dá para agendar)', () => {
    const scheduled: SendTarget = {
      ...(sector as Extract<SendTarget, { type: 'sector' }>),
      shiftIds: ['noite'], shiftStart: { startsAt: '2099-10-22T02:00:00.000Z', startTime: '22:00' },
    };

    it('área sem número: Enviar agora e No início do turno ficam desabilitados', async () => {
      const { user } = setup(scheduled, { roster: { data: rosterOf(scheduled, null) } });
      await user.type(screen.getByRole('textbox'), 'Oi');
      expect(screen.getByText('Áreas sem número: Compras')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Enviar agora' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'No início do turno' })).toBeDisabled();
    });

    it('número fora do ar (close): só Enviar agora fica desabilitado', async () => {
      const { user } = setup(scheduled, { roster: { data: rosterOf(scheduled, channel('close')) } });
      await user.type(screen.getByRole('textbox'), 'Oi');
      expect(screen.getByText(`O número ${NUMBER} está desconectado. Áreas: Compras.`)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Enviar agora' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'No início do turno' })).toBeEnabled();
    });
  });

  it.each([
    ['ADMIN', true],
    ['OPERATOR', false],
  ])('área sem número: o link Conexões aparece só para o ADMIN (%s)', (role, hasLink) => {
    auth.role = role;
    setup(sector, { roster: { data: rosterOf(sector, null) } });
    expect(screen.queryByRole('link', { name: 'Conexões' }) !== null).toBe(hasLink);
  });

  it('número sem resposta (unknown): trava o envio e Conferir de novo refaz a consulta da escala', async () => {
    const { user } = setup(sector, { roster: { data: rosterOf(sector, channel('unknown')) } });
    await user.type(screen.getByRole('textbox'), 'Oi');
    expect(screen.getByRole('button', { name: 'Enviar agora' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Conferir de novo' }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });
});

describe('SendWhatsappDialog número por área (sem seletor de canal)', () => {
  it.each([
    ['carregando', { isLoading: true }],
    ['conferindo de novo', { data: rosterOf(sector), isFetching: true }],
    ['com erro', { isError: true }],
  ])('escala %s: não deixa enviar', async (_name, query) => {
    const { user } = setup(sector, { roster: query });
    await user.type(screen.getByRole('textbox'), 'Oi');
    expect(screen.getByRole('button', { name: 'Enviar agora' })).toBeDisabled();
  });

  it('escala com erro mostra que não deu para conferir, com Conferir de novo', async () => {
    const { user } = setup(sector, { roster: { isError: true } });
    expect(screen.getByText('Não foi possível conferir o número. Tente de novo')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Conferir de novo' }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });
});

describe('SendWhatsappDialog número por área (sem seletor de canal)', () => {
  it('alvo pessoa: mostra o número da área dela e consulta só a rota da pessoa', () => {
    setup(person);
    expect(useTeamPersonRoute).toHaveBeenCalledWith('u1');
    expect(useTeamRoster).toHaveBeenCalledWith([], '');
    expect(screen.getByText(`Compras, 1 pessoa, pelo ${NUMBER}`)).toBeInTheDocument();
  });

  it('alvo pessoa sem área: diz que não tem área e não deixa enviar', async () => {
    const { user } = setup(person, {
      person: { data: { userId: 'u1', sector: null, channel: null } },
    });
    await user.type(screen.getByRole('textbox'), 'Oi');
    expect(screen.getByText('Esta pessoa não tem área.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Enviar agora' })).toBeDisabled();
  });

  it.each([
    ['sector_without_number', 422, 'Há área sem número neste envio. Associe um número a ela em Conexões.'],
    ['channel_unverified', 409, 'Não foi possível conferir o número. Tente de novo'],
  ])('recusa %s do servidor: mostra a mensagem, não fecha e refaz a prévia', async (code, status, message) => {
    mutateAsync.mockRejectedValue(httpError(status, `team_whatsapp.${code}`));
    const { user, onOpenChange, invalidate } = setup();
    await submit(user);
    expect(await screen.findByRole('alert')).toHaveTextContent(message);
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['team-whatsapp', 'roster'] });
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
    // Sem `channelId`: o servidor escolhe o número pela área de cada pessoa.
    expect(mutateAsync.mock.calls[0][0]).toStrictEqual({
      text: 'Oi equipe', target: { type: 'sector', sectorIds: ['s1'], date: '2026-10-21' },
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
    expect(mutateAsync.mock.calls[0][0]).toStrictEqual({
      text: 'Oi equipe', target: { type: 'user', userId: 'u1' },
    });
  });

  it('mostra no diálogo o erro 409 de número desconectado e não fecha', async () => {
    mutateAsync.mockRejectedValue(httpError(409, 'team_whatsapp.channel_disconnected'));
    const { user, onOpenChange } = setup();
    await submit(user);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Um número deste envio está desconectado. Veja na prévia qual é.',
    );
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});

const shiftTarget = (userIds: string[] | null, leftOut: LeftOutPerson[]): SendTarget => ({
  type: 'sector', sectorIds: ['s1'], levelIds: [], withoutLevel: false,
  label: 'Produção · Noite · 21/10', date: '2026-10-21', shiftIds: ['noite'],
  includeOff: false, userIds, leftOut, recipients: [{ id: 'joao', name: 'João' }, { id: 'maria', name: 'Maria' }],
});
const withOff: SendTarget = { ...shiftTarget(null, []), shiftIds: [], includeOff: true };

describe('SendWhatsappDialog: nomes', () => {
  it.each([
    ['todos do turno', shiftTarget(null, [{ name: 'Pedro', reason: 'no_phone' }]), { shiftIds: ['noite'] }, true],
    ['selecionados', shiftTarget(['joao', 'maria'], []), { shiftIds: ['noite'], userIds: ['joao', 'maria'] }, false],
    ['todos os turnos com folga', withOff, { includeOff: true }, false],
  ])('%s: lista quem recebe e quem fica de fora, e manda date/shiftIds/includeOff, sem shift', async (_name, target, extra, hasLeftOut) => {
    mutateAsync.mockResolvedValue({ dispatchId: 'd1', queued: 2, skipped: [] });
    const { user } = setup(target);
    expect(screen.getByText('Produção · Noite · 21/10')).toBeInTheDocument();
    expect(within(screen.getByRole('list', { name: 'Vão receber (2)' })).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['João', 'Maria']);
    expect(screen.queryByText('Ficam de fora (1)') !== null).toBe(hasLeftOut);
    if (hasLeftOut) {
      expect(within(screen.getByRole('list', { name: 'Ficam de fora (1)' })).getByText('Pedro · sem telefone')).toBeInTheDocument();
    }
    await submit(user);
    expect(mutateAsync).toHaveBeenCalledWith({
      text: 'Oi equipe', target: { type: 'sector', sectorIds: ['s1'], date: '2026-10-21', ...extra },
    });
    expect(mutateAsync.mock.calls[0][0].target).not.toHaveProperty('shift');
  });
});

describe('SendWhatsappDialog: vários turnos e quem fica de fora', () => {
  it('Dia e Noite marcados: o corpo leva shiftIds [dia, noite], sem includeOff', async () => {
    mutateAsync.mockResolvedValue({ dispatchId: 'd1', queued: 2, skipped: [] });
    const { user } = setup({ ...shiftTarget(null, []), shiftIds: ['dia', 'noite'], label: 'Produção · Dia, Noite · 21/10' });
    await submit(user);
    expect(mutateAsync.mock.calls[0][0].target).toStrictEqual({
      type: 'sector', sectorIds: ['s1'], date: '2026-10-21', shiftIds: ['dia', 'noite'],
    });
  });

  it('seleção parcial lista Ficam de fora (2) com o motivo de cada um', () => {
    const left: LeftOutPerson[] = [{ name: 'Ana', reason: 'unselected' }, { name: 'Bruno', reason: 'no_phone' }];
    setup(shiftTarget(['joao'], left));
    const list = within(screen.getByRole('list', { name: 'Ficam de fora (2)' }));
    expect(list.getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'Ana · não selecionado', 'Bruno · sem telefone',
    ]);
  });
});

describe('SendWhatsappDialog: nomes', () => {
  it('TI + Operação + Coordenador envia sectorIds [ti, op] e levelIds [level_coordinator]', async () => {
    mutateAsync.mockResolvedValue({ dispatchId: 'd1', queued: 2, skipped: [] });
    const { user } = setup({
      ...shiftTarget(null, []), sectorIds: ['ti', 'op'], levelIds: ['level_coordinator'],
      label: 'Operação, TI · Coordenador · Noite · 21/10',
    });
    await submit(user);
    expect(mutateAsync.mock.calls[0][0].target).toEqual({
      type: 'sector', sectorIds: ['ti', 'op'], levelIds: ['level_coordinator'], date: '2026-10-21', shiftIds: ['noite'],
    });
  });

  it('só Sem nível envia withoutLevel true, sem levelIds', async () => {
    mutateAsync.mockResolvedValue({ dispatchId: 'd1', queued: 2, skipped: [] });
    const { user } = setup({ ...shiftTarget(null, []), withoutLevel: true });
    await submit(user);
    const body = mutateAsync.mock.calls[0][0].target;
    expect(body).toMatchObject({ withoutLevel: true });
    expect(body).not.toHaveProperty('levelIds');
  });

  it('um setor sem nível envia sectorIds [id] sem levelIds nem withoutLevel', async () => {
    mutateAsync.mockResolvedValue({ dispatchId: 'd1', queued: 2, skipped: [] });
    const { user } = setup(shiftTarget(null, []));
    await submit(user);
    const body = mutateAsync.mock.calls[0][0].target;
    expect(body.sectorIds).toEqual(['s1']);
    expect(body).not.toHaveProperty('levelIds');
    expect(body).not.toHaveProperty('withoutLevel');
  });

  it('nível inválido (422) mostra a mensagem e não fecha', async () => {
    mutateAsync.mockRejectedValue(httpError(422, 'team_whatsapp.invalid_level'));
    const { user, onOpenChange } = setup({ ...shiftTarget(null, []), levelIds: ['x'] });
    await submit(user);
    expect(await screen.findByRole('alert')).toHaveTextContent('Nível inválido. Atualize a página e tente de novo.');
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it('seleção inválida (422) mostra que a lista mudou e não fecha', async () => {
    mutateAsync.mockRejectedValue(httpError(422, 'team_whatsapp.invalid_selection'));
    const { user, onOpenChange } = setup(shiftTarget(['joao'], []));
    await submit(user);
    expect(await screen.findByRole('alert')).toHaveTextContent('A lista de pessoas mudou. Atualize a página e confira de novo.');
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});

describe('SendWhatsappDialog: agendar no início do turno', () => {
  const STARTS_AT = '2026-10-22T02:00:00.000Z';
  const scheduledTarget: SendTarget = {
    ...(sector as Extract<SendTarget, { type: 'sector' }>),
    label: 'Produção · Noite · 21/10', shiftIds: ['noite'], shiftStart: { startsAt: STARTS_AT, startTime: '22:00' },
  };

  afterEach(() => vi.useRealTimers());

  function setNow(iso: string) {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(iso));
  }

  it('No início do turno não aparece em Todos os turnos', () => {
    setup({ ...scheduledTarget, shiftIds: [] });
    expect(screen.queryByRole('button', { name: 'No início do turno' })).not.toBeInTheDocument();
  });

  it('com dois turnos No início do turno fica desabilitado, mesmo com texto e início conhecido', async () => {
    setNow('2026-10-21T15:00:00Z');
    const { user } = setup({ ...scheduledTarget, shiftIds: ['dia', 'noite'] });
    await user.type(screen.getByRole('textbox'), 'Oi');
    expect(screen.getByRole('button', { name: 'No início do turno' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Enviar agora' })).toBeEnabled();
  });

  it('fica desabilitado com o motivo quando o início do turno já passou', async () => {
    setNow(STARTS_AT);
    const { user } = setup(scheduledTarget);
    await user.type(screen.getByRole('textbox'), 'Oi');
    expect(screen.getByRole('button', { name: 'No início do turno' })).toBeDisabled();
    expect(screen.getByText('O início deste turno já passou')).toBeInTheDocument();
  });

  it('agenda com when shift_start e avisa a data e a hora gravadas', async () => {
    setNow('2026-10-21T15:00:00Z');
    mutateAsync.mockResolvedValue({ dispatchId: 'd1', queued: 0, scheduled: 2, scheduledFor: STARTS_AT, skipped: [] });
    const { user, onOpenChange } = setup(scheduledTarget);
    await user.type(screen.getByRole('textbox'), 'Oi equipe');
    await user.click(screen.getByRole('button', { name: 'No início do turno' }));
    expect(mutateAsync.mock.calls[0][0]).toMatchObject({ when: 'shift_start', target: { shiftIds: ['noite'] } });
    expect(toastSuccess.mock.calls[0][0]).toBe('Agendado para 21/10 às 22:00');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
