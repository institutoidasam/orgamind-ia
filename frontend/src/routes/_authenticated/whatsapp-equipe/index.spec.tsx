import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HTTPError } from 'ky';
import type { ComponentType } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { useTeamTargets, useTeamDispatches, useTeamRoster, useScheduledDispatches } = vi.hoisted(() => ({
  useTeamTargets: vi.fn(),
  useTeamDispatches: vi.fn(),
  useTeamRoster: vi.fn(),
  useScheduledDispatches: vi.fn(),
}));

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (opts: Record<string, unknown>) => ({ ...opts }),
  Link: ({ children, to, params }: { children: React.ReactNode; to: string; params: Record<string, string> }) => (
    <a href={Object.entries(params).reduce((path, [key, value]) => path.replace('$' + key, value), to)}>{children}</a>
  ),
}));
vi.mock('@/features/team-whatsapp/api', () => ({
  useTeamTargets: () => useTeamTargets(),
  useTeamDispatches: (page: number) => useTeamDispatches(page),
  useTeamRoster: (ids: string[], date: string) => useTeamRoster(ids, date),
  useScheduledDispatches: (page: number) => useScheduledDispatches(page),
  useCancelDispatch: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock('@/features/team-whatsapp/components/send-whatsapp-dialog', () => ({
  SendWhatsappDialog: ({ target }: { target: unknown }) => (
    <div role="dialog">Diálogo {JSON.stringify(target)}</div>
  ),
}));

import type { RosterMember } from '@/features/team-whatsapp/schemas';
import { Route } from './index';

const Page = (Route as unknown as { component: ComponentType }).component;

// Radix Select (shadcn) usa PointerEvents/scrollIntoView, que o jsdom não tem.
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

type User = ReturnType<typeof userEvent.setup>;

const pickShift = (user: User, name: string) => user.click(screen.getByRole('checkbox', { name }));

const toggleBox = (user: User, name: string) => user.click(screen.getByRole('checkbox', { name }));

async function openProducao(turno: string) {
  const user = userEvent.setup();
  render(<Page />);
  await toggleBox(user, 'Produção');
  await pickShift(user, turno);
  return user;
}

const escalados = () => within(screen.getByRole('list', { name: 'Escalados' }));
const checkboxNames = () => escalados().getAllByRole('checkbox').map((c) => c.getAttribute('aria-label'));
const groupItems = (name: string) =>
  within(screen.getByRole('list', { name })).getAllByRole('listitem').map((li) => li.getAttribute('aria-label'));
const dialogTarget = () => JSON.parse((screen.getByRole('dialog').textContent ?? '').replace('Diálogo ', ''));
const NEEDS_CHOICE = 'Escolha o setor, a data e o turno';
const NO_SCHEDULE = '1 pessoa(s) deste setor estão sem escala e sem turno no cadastro — defina em Escala';
const INCLUDE_OFF = 'incluir quem está de folga';

const manha = { id: 'manha', name: 'Manhã', startTime: '06:00', endTime: '14:00' };
const noite = { id: 'noite', name: 'Noite', startTime: '22:00', endTime: '06:00' };
const work = (shiftId: string): RosterMember['situation'] => ({ kind: 'WORK', sectorId: 's1', shiftId, source: 'CYCLE' });
const member = (id: string, name: string, situation: RosterMember['situation'], extra: Partial<RosterMember> = {}): RosterMember => ({
  id, name, email: `${id}@x.test`, phoneE164: '+5592991234567', isActive: true, jobTitle: null,
  fromOtherSector: false, situation, level: null, ...extra,
});
const members = [
  member('ana', 'Ana', work('manha'), { jobTitle: 'Operadora' }),
  member('joao', 'João', work('noite'), { jobTitle: 'Líder' }),
  member('lia', 'Lia', work('noite'), { isActive: false }),
  member('maria', 'Maria', { kind: 'OFF', reason: 'VACATION', source: 'EXCEPTION' }),
  member('pedro', 'Pedro', work('noite'), { phoneE164: null }),
  member('rui', 'Rui', work('noite'), { fromOtherSector: true, phoneE164: '+5592977776666' }),
  member('ze', 'Zé', { kind: 'NONE' }),
];
const sectors = [{ id: 's1', name: 'Produção', code: 'PROD' }, { id: 's2', name: 'Expedição', code: 'EXP' }];
const levels = [{ id: 'l1', name: 'Coordenador' }, { id: 'l2', name: 'Funcionário' }];
const targets = { today: '2026-10-21', inProgress: null, shifts: [manha, noite], sectors, levels };
let membersBySector: Record<string, RosterMember[]> = {};
const rosterOf = (ids: string[], date: string, shiftStarts: unknown[] = []) => ({
  data: {
    date, shiftStarts,
    sectors: ids.map((id) => ({ sectorId: id, name: sectors.find((s) => s.id === id)?.name, channel: null, members: membersBySector[id] ?? [] })),
  },
  isLoading: false, isError: false,
});
const COUNTS = {
  queued: 0, sent: 0, delivered: 0, read: 0, replied: 0, failed: 0, uncertain: 0, skipped: 0, scheduled: 0, cancelled: 0,
};
const meta = (total: number, page = 1) => ({ total, page, pageSize: 20 });
const dispatches = {
  items: [
    {
      id: 'd1', createdAt: '2026-10-16T12:00:00.000Z',
      author: { id: 'a1', name: 'Ada', email: 'ada@x.test' },
      target: { type: 'sector' as const, id: 's1', label: 'Compras', shift: null },
      sectors: [{ id: 's1', name: 'Compras' }],
      channels: [{ name: 'GoZap Principal', phoneE164: '+5592999990000', count: 10 }],
      counts: { ...COUNTS, queued: 1, sent: 2, failed: 3, skipped: 4 },
      rosterDate: null, state: 'DISPATCHED' as const, scheduledFor: null, firedAt: null,
    },
    {
      id: 'd2', createdAt: '2026-10-15T12:00:00.000Z',
      author: null,
      target: { type: 'user' as const, id: 'u1', label: 'Ana', shift: null },
      sectors: [],
      channels: [{ name: null, phoneE164: null, count: 1 }],
      counts: { ...COUNTS, read: 1 },
      rosterDate: null, state: 'DISPATCHED' as const, scheduledFor: null, firedAt: null,
    },
  ],
  ...meta(2),
};
const query = (data: unknown) => ({ data, isLoading: false, isError: false, refetch: vi.fn() });

function httpError(status: number, code?: string) {
  const body = code ? JSON.stringify({ code }) : '{}';
  return new HTTPError(new Response(body, { status }), new Request('https://x'), {} as never);
}

function http403() {
  return new HTTPError(new Response('{}', { status: 403 }), new Request('https://x'), {} as never);
}

beforeEach(() => {
  useTeamTargets.mockReturnValue({ data: targets, isLoading: false, isError: false });
  useTeamDispatches.mockReturnValue(query(dispatches));
  useScheduledDispatches.mockReturnValue(query({ items: [], ...meta(0) }));
  membersBySector = { s1: members, s2: [] };
  useTeamRoster.mockImplementation((ids: string[], date: string) => rosterOf(ids, date));
});

describe('WhatsApp da equipe: acesso', () => {
  it('mostra o estado vazio quando a API recusa com 403', () => {
    useTeamTargets.mockReturnValue({ data: undefined, isLoading: false, isError: true, error: http403() });
    render(<Page />);
    expect(screen.getByText('Só o administrador e o gestor do setor enviam mensagens para a equipe.')).toBeInTheDocument();
    expect(screen.queryByText('Envios recentes')).not.toBeInTheDocument();
  });

  it('mostra esqueleto enquanto carrega', () => {
    useTeamTargets.mockReturnValue({ data: undefined, isLoading: true, isError: false });
    render(<Page />);
    expect(screen.getByText('WhatsApp da equipe')).toBeInTheDocument();
    expect(screen.queryByText(NEEDS_CHOICE)).not.toBeInTheDocument();
  });

  it('sem setor ativo, quem pode enviar vê o aviso no lugar dos seletores', () => {
    useTeamTargets.mockReturnValue({ data: { ...targets, sectors: [] }, isLoading: false, isError: false });
    render(<Page />);
    expect(screen.getByText('Nenhum setor ativo para envio. Cadastre setores em Setores.')).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: 'Produção' })).not.toBeInTheDocument();
    expect(screen.getByText('Envios recentes')).toBeInTheDocument();
  });
});

describe('WhatsApp da equipe: seletores', () => {
  it('Data começa em targets.today e Turnos lista Todos os turnos e os turnos ativos', () => {
    render(<Page />);
    expect(screen.getByLabelText('Data')).toHaveValue('2026-10-21');
    expect(Array.from(screen.getByRole('group', { name: 'Turnos' }).querySelectorAll('label')).map((l) => l.textContent)).toEqual([
      'Todos os turnos', 'Manhã', 'Noite',
    ]);
  });

  it('pede setor e turno até escolher os dois', async () => {
    const user = userEvent.setup();
    render(<Page />);
    expect(screen.getByText(NEEDS_CHOICE)).toBeInTheDocument();
    await pickShift(user, 'Noite');
    expect(screen.getByText(NEEDS_CHOICE)).toBeInTheDocument();
    await toggleBox(user, 'Produção');
    expect(screen.queryByText(NEEDS_CHOICE)).not.toBeInTheDocument();
  });

  it('pré-seleciona o setor quando há um só e pede só o turno', async () => {
    useTeamTargets.mockReturnValue({ data: { ...targets, sectors: [sectors[0]] }, isLoading: false, isError: false });
    const user = userEvent.setup();
    render(<Page />);
    expect(screen.getByRole('checkbox', { name: 'Produção' })).toBeChecked();
    expect(screen.getByText(NEEDS_CHOICE)).toBeInTheDocument();
    await pickShift(user, 'Noite');
    expect(screen.queryByText(NEEDS_CHOICE)).not.toBeInTheDocument();
  });
});

describe('WhatsApp da equipe: quem aparece', () => {
  it('Noite lista só os escalados na Noite com a função; De folga mostra Maria (Férias)', async () => {
    await openProducao('Noite');
    expect(useTeamRoster).toHaveBeenLastCalledWith(['s1'], '2026-10-21');
    expect(checkboxNames()).toEqual(['João', 'Rui']);
    expect(screen.getByRole('listitem', { name: 'João' })).toHaveTextContent('Líder');
    expect(screen.getByRole('listitem', { name: 'Rui' })).toHaveTextContent('de outro setor');
    expect(groupItems('De folga')).toEqual(['Maria']);
    expect(screen.getByRole('listitem', { name: 'Maria' })).toHaveTextContent('Férias');
    expect(groupItems('Sem telefone')).toEqual(['Pedro']);
    expect(screen.getByRole('button', { name: 'Enviar para todos (2)' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Enviar para selecionados (0)' })).toBeDisabled();
  });

  it('conta quem está sem escala e sem turno, que não entra em nenhum turno', async () => {
    await openProducao('Todos os turnos');
    expect(screen.getByText(NO_SCHEDULE)).toBeInTheDocument();
    expect(checkboxNames()).toEqual(['Ana', 'João', 'Rui']);
  });

  it('incluir quem está de folga só aparece em Todos os turnos e põe Maria na lista', async () => {
    const user = await openProducao('Noite');
    expect(screen.queryByRole('checkbox', { name: INCLUDE_OFF })).not.toBeInTheDocument();
    await pickShift(user, 'Todos os turnos');
    await user.click(screen.getByRole('checkbox', { name: INCLUDE_OFF }));
    expect(checkboxNames()).toEqual(['Ana', 'João', 'Maria', 'Rui']);
    expect(screen.queryByRole('list', { name: 'De folga' })).not.toBeInTheDocument();
  });
});

describe('WhatsApp da equipe: vários setores e níveis', () => {
  async function openBoth() {
    const user = userEvent.setup();
    render(<Page />);
    await toggleBox(user, 'Todos os setores');
    await pickShift(user, 'Noite');
    return user;
  }

  it('começa vazio com mais de um setor e pede o roster com todos os setores e a data', async () => {
    render(<Page />);
    expect(screen.queryByRole('checkbox', { name: 'Produção' })).not.toBeChecked();
    expect(screen.getByText(NEEDS_CHOICE)).toBeInTheDocument();
    cleanup();
    await openBoth();
    expect(useTeamRoster).toHaveBeenLastCalledWith(['s1', 's2'], '2026-10-21');
  });

  it('setor sem ninguém mostra o aviso e o link para adicionar pessoas', async () => {
    await openBoth();
    expect(screen.getByRole('heading', { name: 'Expedição' })).toBeInTheDocument();
    expect(screen.getByText('Ninguém neste setor ainda.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Adicionar pessoas' })).toHaveAttribute('href', '/setores/s2');
    expect(within(screen.getByRole('list', { name: 'Escalados · Produção' })).getAllByRole('checkbox')).toHaveLength(2);
  });

  it('filtrar por nível troca a lista (de folga também) e o alvo leva levelIds e a lista conferida', async () => {
    membersBySector.s1 = [
      member('ana', 'Ana', work('noite'), { level: levels[0] }),
      member('joao', 'João', work('noite'), { level: levels[1] }),
      member('zeca', 'Zeca', work('noite')),
      member('maria', 'Maria', { kind: 'OFF', reason: 'VACATION', source: 'EXCEPTION' }, { level: levels[1] }),
    ];
    const user = await openBoth();
    await toggleBox(user, 'Coordenador');
    expect(screen.getByText('Ana · Coordenador')).toBeInTheDocument();
    expect(screen.queryByRole('listitem', { name: 'João' })).not.toBeInTheDocument();
    expect(screen.queryByRole('list', { name: /De folga/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Enviar para todos (1)' }));
    expect(dialogTarget()).toMatchObject({
      sectorIds: ['s1', 's2'], levelIds: ['l1'], withoutLevel: false, userIds: null,
      label: 'Expedição, Produção · Coordenador · Noite · 21/10',
      recipients: [{ id: 'ana', name: 'Ana' }],
    });
  });
});

describe('WhatsApp da equipe: turno em andamento', () => {
  it('aviso A Noite de 21/10 ainda está em andamento; Ver esse turno troca data e turno', async () => {
    const inProgress = { date: '2026-10-21', shift: noite };
    useTeamTargets.mockReturnValue({ data: { ...targets, today: '2026-10-22', inProgress }, isLoading: false, isError: false });
    const user = userEvent.setup();
    render(<Page />);
    expect(screen.getByLabelText('Data')).toHaveValue('2026-10-22');
    expect(screen.getByText('A Noite de 21/10 ainda está em andamento')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Ver esse turno' }));
    expect(screen.getByLabelText('Data')).toHaveValue('2026-10-21');
    expect(screen.getByRole('checkbox', { name: 'Noite' })).toBeChecked();
    expect(screen.queryByText('A Noite de 21/10 ainda está em andamento')).not.toBeInTheDocument();
  });
});

describe('WhatsApp da equipe: seleção e envio', () => {
  it('selecionados: userIds na ordem do back, com data e turno', async () => {
    const user = await openProducao('Noite');
    await user.click(screen.getByRole('checkbox', { name: 'Rui' }));
    await user.click(screen.getByRole('checkbox', { name: 'João' }));
    await user.click(screen.getByRole('button', { name: 'Enviar para selecionados (2)' }));
    expect(dialogTarget()).toEqual({
      type: 'sector', sectorIds: ['s1'], levelIds: [], withoutLevel: false, date: '2026-10-21', shiftIds: ['noite'], includeOff: false, userIds: ['joao', 'rui'],
      label: 'Produção · Noite · 21/10 · seleção de 2',
      recipients: [{ id: 'joao', name: 'João' }, { id: 'rui', name: 'Rui' }],
      leftOut: [{ name: 'Pedro', reason: 'no_phone' }],
    });
  });

  it('todos os turnos com folga: sem shiftIds e sem userIds, e o sem telefone fica de fora', async () => {
    const user = await openProducao('Todos os turnos');
    await user.click(screen.getByRole('checkbox', { name: INCLUDE_OFF }));
    await user.click(screen.getByRole('button', { name: 'Enviar para todos (4)' }));
    expect(dialogTarget()).toEqual({
      type: 'sector', sectorIds: ['s1'], levelIds: [], withoutLevel: false, date: '2026-10-21', shiftIds: [], includeOff: true, userIds: null,
      label: 'Produção · todos os turnos · 21/10',
      recipients: [{ id: 'ana', name: 'Ana' }, { id: 'joao', name: 'João' }, { id: 'maria', name: 'Maria' }, { id: 'rui', name: 'Rui' }],
      leftOut: [{ name: 'Pedro', reason: 'no_phone' }],
    });
  });

  it('Marcar todos marca e desmarca só quem tem telefone', async () => {
    const user = await openProducao('Noite');
    await user.click(screen.getByRole('button', { name: 'Marcar todos' }));
    expect(screen.getByRole('button', { name: 'Enviar para selecionados (2)' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Marcar todos' }));
    expect(screen.getByRole('button', { name: 'Enviar para selecionados (0)' })).toBeDisabled();
  });

  it('trocar a data, o turno ou o setor limpa a seleção', async () => {
    const user = await openProducao('Noite');
    await user.click(screen.getByRole('checkbox', { name: 'João' }));
    fireEvent.change(screen.getByLabelText('Data'), { target: { value: '2026-10-22' } });
    expect(useTeamRoster).toHaveBeenLastCalledWith(['s1'], '2026-10-22');
    expect(screen.getByRole('button', { name: 'Enviar para selecionados (0)' })).toBeDisabled();
    await user.click(screen.getByRole('checkbox', { name: 'João' }));
    await pickShift(user, 'Manhã');
    expect(screen.getByRole('button', { name: 'Enviar para selecionados (0)' })).toBeDisabled();
    await pickShift(user, 'Manhã');
    await user.click(screen.getByRole('checkbox', { name: 'João' }));
    await toggleBox(user, 'Expedição');
    await toggleBox(user, 'Expedição');
    expect(screen.getByRole('button', { name: 'Enviar para selecionados (0)' })).toBeDisabled();
  });
});

describe('WhatsApp da equipe: vários turnos', () => {
  it('Manhã e Noite juntas listam quem trabalha em qualquer uma e o alvo leva shiftIds, sem folga', async () => {
    const user = await openProducao('Manhã');
    await pickShift(user, 'Noite');
    expect(checkboxNames()).toEqual(['Ana', 'João', 'Rui']);
    expect(screen.queryByRole('checkbox', { name: INCLUDE_OFF })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Enviar para todos (3)' }));
    expect(dialogTarget()).toMatchObject({
      shiftIds: ['manha', 'noite'], includeOff: false, label: 'Produção · Manhã, Noite · 21/10',
    });
  });
});

describe('WhatsApp da equipe: erro da escala', () => {
  async function openWithRosterError(error: unknown) {
    const refetch = vi.fn();
    useTeamRoster.mockReturnValue({ isLoading: false, isError: true, error, refetch });
    const user = await openProducao('Todos os turnos');
    return { user, refetch };
  }

  it('mostra o erro com Tentar novamente, que chama refetch', async () => {
    const { user, refetch } = await openWithRosterError(httpError(500));
    await user.click(await screen.findByRole('button', { name: 'Tentar novamente' }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('too_many_people (422) pede para escolher menos setores', async () => {
    await openWithRosterError(httpError(422, 'team_whatsapp.too_many_people'));
    expect(
      await screen.findByText('Os setores escolhidos têm mais de 2000 pessoas. Escolha menos setores.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Tentar novamente' })).toBeInTheDocument();
  });
});

describe('WhatsApp da equipe: página', () => {
  it('não tem mais os cards por setor e explica o fluxo novo', () => {
    render(<Page />);
    expect(screen.queryByRole('button', { name: 'Enviar ao setor' })).not.toBeInTheDocument();
    expect(screen.getByText('Escolha o setor e o turno e envie para todos ou só para quem você marcar.')).toBeInTheDocument();
  });
});

describe('WhatsApp da equipe: envios recentes', () => {
  it('lista destino, autor, número e contagens; número removido e autor removido são tratados', () => {
    render(<Page />);
    const first = screen.getByRole('row', { name: /\+5592999990000/ });
    expect(first).toHaveTextContent('Compras');
    expect(first).toHaveTextContent('Ada');
    expect(first).toHaveTextContent('Na fila 1 · Aceito pelo WhatsApp 2 · Falhou 3 · Pulado 4');
    expect(within(first).getByRole('link', { name: 'Ver resultado' })).toHaveAttribute('href', '/whatsapp-equipe/d1');
    const second = screen.getByRole('row', { name: /Número removido/ });
    expect(second).toHaveTextContent('Ana');
    expect(second).toHaveTextContent('Lido 1');
    expect(screen.queryByText('Ver destinatários')).not.toBeInTheDocument();
  });

  it('mostra o vazio quando não há envios', () => {
    useTeamDispatches.mockReturnValue(query({ items: [], ...meta(0) }));
    render(<Page />);
    expect(screen.getByText('Nenhum envio ainda.')).toBeInTheDocument();
  });

  it('total 45 mostra Página 1 de 3 e Próxima pede a página 2', async () => {
    useTeamDispatches.mockReturnValue(query({ ...dispatches, ...meta(45) }));
    render(<Page />);
    expect(useTeamDispatches).toHaveBeenLastCalledWith(1);
    expect(screen.getByText(/Página 1 de 3/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Próxima' }));
    expect(useTeamDispatches).toHaveBeenLastCalledWith(2);
  });

  it('página que ficou além do fim (a lista encolheu) volta à última', async () => {
    useTeamDispatches.mockReturnValue(query({ ...dispatches, ...meta(45) }));
    const { rerender } = render(<Page />);
    await userEvent.click(screen.getByRole('button', { name: 'Próxima' }));
    expect(useTeamDispatches).toHaveBeenLastCalledWith(2);
    useTeamDispatches.mockReturnValue(query({ items: [], ...meta(20, 2) }));
    rerender(<Page />);
    await waitFor(() => expect(useTeamDispatches).toHaveBeenLastCalledWith(1));
  });
});

describe('WhatsApp da equipe: erro das listas (D14)', () => {
  it('erro no histórico mostra Tentar novamente, que consulta de novo', async () => {
    const refetch = vi.fn();
    useTeamDispatches.mockReturnValue({ data: undefined, isLoading: false, isError: true, error: httpError(500), refetch });
    render(<Page />);
    await userEvent.click(await screen.findByRole('button', { name: 'Tentar novamente' }));
    expect(refetch).toHaveBeenCalled();
    expect(screen.queryByText('Nenhum envio ainda.')).not.toBeInTheDocument();
  });

  const scheduledRow = {
    id: 'g1', scheduledFor: '2026-10-22T02:00:00.000Z', rosterDate: '2026-10-21', shift: noite,
    label: 'Produção · Noite · 21/10', recipientCount: 2, channel: null, author: null,
  };

  it.each([
    ['histórico', () => useTeamDispatches, () => query({ ...dispatches, ...meta(45) })],
    ['agendados', () => useScheduledDispatches, () => query({ items: [scheduledRow], ...meta(45) })],
  ])('erro na página 2 do %s oferece voltar à página 1, que consulta a primeira', async (_name, hook, ok) => {
    const mock = hook();
    const failure = { data: undefined, isLoading: false, isError: true, error: httpError(500), refetch: vi.fn() };
    mock.mockImplementation((page: number) => (page === 1 ? ok() : failure));
    render(<Page />);
    await userEvent.click(screen.getByRole('button', { name: 'Próxima' }));
    expect(mock).toHaveBeenLastCalledWith(2);
    await userEvent.click(await screen.findByRole('button', { name: 'Voltar à primeira página' }));
    expect(mock).toHaveBeenLastCalledWith(1);
    expect(screen.queryByRole('button', { name: 'Voltar à primeira página' })).not.toBeInTheDocument();
  });

  it('erro nos agendados mostra Tentar novamente, que consulta de novo', async () => {
    const refetch = vi.fn();
    useScheduledDispatches.mockReturnValue({ data: undefined, isLoading: false, isError: true, error: httpError(500), refetch });
    render(<Page />);
    await userEvent.click(await screen.findByRole('button', { name: 'Tentar novamente' }));
    expect(refetch).toHaveBeenCalled();
  });
});

describe('WhatsApp da equipe: agendamento', () => {
  const scheduledItem = {
    id: 'g1', scheduledFor: '2026-10-22T02:00:00.000Z', rosterDate: '2026-10-21', shift: noite,
    label: 'Produção · Noite · 21/10', recipientCount: 2, channel: null, author: null,
  };

  it('o alvo de um turno leva o início do turno do servidor e a hora gravada', async () => {
    useTeamRoster.mockImplementation((ids: string[], date: string) =>
      rosterOf(ids, date, [{ shiftId: 'noite', startsAt: '2026-10-22T02:00:00.000Z' }]));
    const user = await openProducao('Noite');
    await user.click(screen.getByRole('button', { name: 'Enviar para todos (2)' }));
    expect(dialogTarget().shiftStart).toEqual({ startsAt: '2026-10-22T02:00:00.000Z', startTime: '22:00' });
  });

  it('lista os agendados acima dos envios recentes e marca o envio agendado como Agendado', () => {
    useScheduledDispatches.mockReturnValue(query({ items: [scheduledItem], ...meta(1) }));
    useTeamDispatches.mockReturnValue(query({
      items: [{ ...dispatches.items[0], state: 'SCHEDULED', counts: { ...COUNTS, scheduled: 2 } }], ...meta(1),
    }));
    render(<Page />);
    expect(screen.getByRole('heading', { name: 'Agendados' })).toBeInTheDocument();
    expect(screen.getByText('21/10 22:00')).toBeInTheDocument();
    expect(screen.getByText(/Agendado 2/)).toBeInTheDocument();
  });
});
