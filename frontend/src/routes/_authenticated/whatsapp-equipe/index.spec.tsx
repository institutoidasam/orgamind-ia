import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HTTPError } from 'ky';
import type { ComponentType } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { useTeamTargets, useTeamDispatches, useTeamRoster, useScheduledDispatches, useAudiencePreview } = vi.hoisted(() => ({
  useTeamTargets: vi.fn(),
  useTeamDispatches: vi.fn(),
  useTeamRoster: vi.fn(),
  useScheduledDispatches: vi.fn(),
  useAudiencePreview: vi.fn(),
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
  useAudiencePreview: (body: unknown) => useAudiencePreview(body),
  useScheduledDispatches: (page: number) => useScheduledDispatches(page),
  useCancelDispatch: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock('@/features/team-whatsapp/components/send-whatsapp-dialog', () => ({
  SendWhatsappDialog: ({ target, audience, onOpenChange }: {
    target: unknown; audience: { preview: { audienceKey: string }; isFresh: boolean }; onOpenChange: (open: boolean) => void;
  }) => (
    <>
      <div role="dialog" data-audience-key={audience.preview.audienceKey} data-fresh={String(audience.isFresh)}>
        Diálogo {JSON.stringify(target)}
      </div>
      <button onClick={() => onOpenChange(false)}>Fechar diálogo</button>
    </>
  ),
}));

import { RULE_VIEW } from '@/features/team-whatsapp/audience-preview.test-fixtures';
import type { TeamAudiencePreview, TeamAudienceRequest } from '@/features/team-whatsapp/schemas';
import { useAuthStore, type AuthUser } from '@/stores/auth.store';
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

async function pickPurpose(user: User, name: string) {
  await user.click(screen.getByRole('combobox', { name: 'Finalidade' }));
  await user.click(screen.getByRole('option', { name }));
}

async function openProducao(turno: string, purpose?: string) {
  const user = userEvent.setup();
  render(<Page />);
  if (purpose) await pickPurpose(user, purpose);
  await toggleBox(user, 'Produção');
  await pickShift(user, turno);
  return user;
}

const list = (name: string) => within(screen.getByRole('list', { name }));
const checkboxNames = () => list('Vão receber').getAllByRole('checkbox').map((c) => c.getAttribute('aria-label'));
const dialogTarget = () => JSON.parse((screen.getByRole('dialog').textContent ?? '').replace('Diálogo ', ''));
const NEEDS_CHOICE = 'Escolha o setor, a data e o turno';

const manha = { id: 'manha', name: 'Manhã', startTime: '06:00', endTime: '14:00' };
const noite = { id: 'noite', name: 'Noite', startTime: '22:00', endTime: '06:00' };
const sectors = [{ id: 's1', name: 'Produção', code: 'PROD' }, { id: 's2', name: 'Expedição', code: 'EXP' }];
const levels = [{ id: 'l1', name: 'Coordenador' }, { id: 'l2', name: 'Funcionário' }];
const targets = { today: '2026-10-21', inProgress: null, shifts: [manha, noite], sectors, levels };

// Servidor falso da prévia: a lista de pessoas vem só dele; o GET roster não traz ninguém.
type Included = TeamAudiencePreview['included'][number];
const person = (userId: string, name: string, extra: Partial<Included> = {}): Included => ({
  userId, name, sectorId: 's1', sectorName: 'Produção', shiftName: 'Noite', levelName: null, phone: '•••• 4567', ...extra,
});
const out = (p: Included, reason: TeamAudiencePreview['excluded'][number]['reason']) => ({
  userId: p.userId, name: p.name, sectorId: p.sectorId, sectorName: p.sectorName,
  shiftName: p.shiftName, levelName: p.levelName, reason,
});
const CANDIDATES = [
  person('ana', 'Ana', { phone: '•••• 0001' }),
  person('joao', 'João'),
  person('rui', 'Rui', { phone: '+5592977776666' }),
  person('bia', 'Bia', { sectorId: 's2', sectorName: 'Expedição' }),
];
const LEFT_OUT = [out(person('maria', 'Maria'), 'vacation'), out(person('pedro', 'Pedro'), 'no_phone')];

function previewOf(body: TeamAudienceRequest): TeamAudiencePreview {
  const { sectorIds, shiftIds, userIds, levelIds, date } = body.target;
  const inScope = CANDIDATES.filter((p) => sectorIds.includes(p.sectorId));
  const picked = userIds ? inScope.filter((p) => userIds.includes(p.userId)) : inScope;
  const rest = inScope.filter((p) => !picked.includes(p));
  return {
    audienceKey: 'a'.repeat(64),
    rule: {
      ...RULE_VIEW,
      rosterDate: date,
      sectors: sectors.filter((s) => sectorIds.includes(s.id)).map(({ id, name }) => ({ id, name })),
      shifts: shiftIds ? targets.shifts.filter((s) => shiftIds.includes(s.id)).map(({ id, name }) => ({ id, name })) : null,
      levels: levels.filter((l) => levelIds?.includes(l.id)),
      withoutLevel: body.target.withoutLevel ?? false,
      includeOff: body.target.includeOff ?? false,
    },
    included: picked,
    excluded: [...LEFT_OUT, ...rest.map((p) => out(p, 'not_selected'))],
    blocks: [],
  };
}
const PREVIEW_OK = { isPlaceholderData: false, isFetching: false, error: null, refetch: vi.fn() };
const answer = (body: TeamAudienceRequest | null) =>
  body ? { ...PREVIEW_OK, data: previewOf(body) } : { ...PREVIEW_OK, data: undefined };
const lastBody = () => useAudiencePreview.mock.lastCall?.[0] as TeamAudienceRequest;
const rosterOf = (ids: string[], date: string, shiftStarts: unknown[] = [], members: unknown[] = []) => ({
  data: {
    date, shiftStarts,
    sectors: ids.map((id) => ({ sectorId: id, name: sectors.find((s) => s.id === id)?.name, channel: null, members })),
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

const OPERATOR: AuthUser = { id: 'u1', email: 'o@x.test', name: 'Olga', role: 'OPERATOR' };

function http403() {
  return new HTTPError(new Response('{}', { status: 403 }), new Request('https://x'), {} as never);
}

beforeEach(() => {
  useTeamTargets.mockReturnValue({ data: targets, isLoading: false, isError: false });
  useTeamDispatches.mockReturnValue(query(dispatches));
  useScheduledDispatches.mockReturnValue(query({ items: [], ...meta(0) }));
  useTeamRoster.mockImplementation((ids: string[], date: string) => rosterOf(ids, date));
  useAudiencePreview.mockReset();
  useAudiencePreview.mockImplementation(answer);
  useAuthStore.setState({ user: OPERATOR });
});

describe('WhatsApp da equipe: início do turno no diálogo', () => {
  const starts = [{ shiftId: 'noite', startsAt: '2026-10-22T02:00:00.000Z' }];
  const SHIFT_START = { startsAt: '2026-10-22T02:00:00.000Z', startTime: '22:00' };
  const withStarts = (ids: string[], date: string) => rosterOf(ids, date, starts);
  const rosterLoading = () => ({ data: undefined, isLoading: true, isError: false });

  async function openNoiteDialog() {
    const user = userEvent.setup();
    const { rerender } = render(<Page />);
    await toggleBox(user, 'Produção');
    await pickShift(user, 'Noite');
    await user.click(await screen.findByRole('button', { name: 'Enviar para todos (3)' }));
    return rerender;
  }

  it('diálogo aberto antes do roster → botão aparece quando o roster chega', async () => {
    useTeamRoster.mockImplementation(rosterLoading);
    const rerender = await openNoiteDialog();
    expect(dialogTarget().shiftStart).toBeUndefined();
    useTeamRoster.mockImplementation(withStarts);
    rerender(<Page />);
    expect(dialogTarget().shiftStart).toEqual(SHIFT_START);
    expect(dialogTarget()).toMatchObject({ shiftIds: ['noite'], userIds: null, date: '2026-10-21' });
  });

  it('controle: com o roster já carregado no clique, o início do turno vai no alvo', async () => {
    useTeamRoster.mockImplementation(withStarts);
    await openNoiteDialog();
    expect(dialogTarget().shiftStart).toEqual(SHIFT_START);
  });
});

describe('WhatsApp da equipe: finalidade', () => {
  const emAndamento = { date: '2026-10-21', shift: noite };
  const NOTICE = 'A Noite de 21/10 ainda está em andamento';

  it('finalidade é o primeiro campo e começa em Aviso de turno', () => {
    render(<Page />);
    const purpose = screen.getByRole('combobox', { name: 'Finalidade' });
    expect(purpose).toHaveTextContent('Aviso de turno');
    const first = (other: HTMLElement) => purpose.compareDocumentPosition(other) & Node.DOCUMENT_POSITION_FOLLOWING;
    expect(first(screen.getByRole('group', { name: 'Setores' }))).toBeTruthy();
    expect(first(screen.getByLabelText('Data'))).toBeTruthy();
    expect(first(screen.getByRole('group', { name: 'Turnos' }))).toBeTruthy();
  });

  it('aceite 18: atalho do turno noturno põe a véspera na Urgência', async () => {
    useTeamTargets.mockReturnValue({
      data: { ...targets, today: '2026-10-22', inProgress: emAndamento }, isLoading: false, isError: false,
    });
    const user = userEvent.setup();
    render(<Page />);
    await pickPurpose(user, 'Reunião');
    expect(screen.queryByText(NOTICE)).not.toBeInTheDocument();
    await pickPurpose(user, 'Urgência');
    await user.click(screen.getByRole('button', { name: 'Ver esse turno' }));
    await toggleBox(user, 'Produção');
    expect(screen.getByLabelText('Data')).toHaveValue('2026-10-21');
    expect(useTeamRoster).toHaveBeenLastCalledWith(['s1'], '2026-10-21');
    expect(screen.getByRole('combobox', { name: 'Finalidade' })).toHaveTextContent('Urgência');
  });
});

describe('WhatsApp da equipe: data de referência', () => {
  it('Reunião usa a data da atividade: pede essa data antes e a prévia vai com ela', async () => {
    const user = await openProducao('Noite', 'Reunião');
    expect(screen.getByText('Escolha o setor e o turno e informe a data da atividade')).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Vão receber' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Data')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Data da atividade'), { target: { value: '2026-10-25' } });
    expect(useTeamRoster).toHaveBeenLastCalledWith(['s1'], '2026-10-25');
    expect(lastBody()).toMatchObject({ purpose: 'meeting', base: 'assigned', target: { date: '2026-10-25', includeOff: true } });
    expect(checkboxNames()).toEqual(['Ana', 'João', 'Rui']);
    await pickPurpose(user, 'Alinhamento');
    expect(screen.queryByLabelText('Data')).not.toBeInTheDocument();
    expect(useTeamRoster).toHaveBeenLastCalledWith(['s1'], '2026-10-25');
    fireEvent.change(screen.getByLabelText('Data da atividade'), { target: { value: '' } });
    expect(screen.getByLabelText('Data')).toHaveValue('2026-10-21');
    expect(useTeamRoster).toHaveBeenLastCalledWith(['s1'], '2026-10-21');
  });
});

describe('WhatsApp da equipe: permissões por ação', () => {
  const withPermissions = (permissions: AuthUser['permissions']) => useAuthStore.setState({ user: { ...OPERATOR, permissions } });
  const agendado = {
    id: 'g1', scheduledFor: '2026-10-22T02:00:00.000Z', rosterDate: '2026-10-21', shift: noite,
    label: 'Produção · Noite · 21/10', recipientCount: 2, channel: null, author: null,
  };

  it('sem equipe.enviar some o envio (seletores e Enviar) e o Cancelar, e o histórico continua', () => {
    useScheduledDispatches.mockReturnValue(query({ items: [agendado], ...meta(1) }));
    withPermissions(['trilha.consultar']);
    render(<Page />);
    expect(screen.getByText('Você não tem permissão para enviar WhatsApp à equipe.')).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: 'Produção' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Enviar para/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancelar' })).not.toBeInTheDocument();
    expect(screen.getByText('Agendados')).toBeInTheDocument();
    expect(screen.getByText('Envios recentes')).toBeInTheDocument();
  });

  it('sem equipe.disparo_amplo o atalho Todos os setores continua visível', () => {
    withPermissions(['equipe.enviar']);
    render(<Page />);
    expect(screen.getByRole('checkbox', { name: 'Todos os setores' })).toBeInTheDocument();
  });
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

describe('WhatsApp da equipe: quem aparece (prévia do servidor)', () => {
  it('mostra Vão receber e Ficam de fora vindos do servidor, agrupados por motivo', async () => {
    await openProducao('Noite');
    expect(screen.getByRole('heading', { name: 'Vão receber (3)' })).toBeInTheDocument();
    expect(checkboxNames()).toEqual(['Ana', 'João', 'Rui']);
    expect(screen.getByRole('listitem', { name: 'Rui' })).toHaveTextContent('+5592977776666');
    expect(screen.getByRole('heading', { name: 'Ficam de fora (2)' })).toBeInTheDocument();
    expect(list('Férias (1)').getByText(/Maria/)).toBeInTheDocument();
    expect(list('Sem telefone (1)').queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Enviar para todos (3)' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Enviar para selecionados (0)' })).toBeDisabled();
  });

  it('GET roster só alimenta número da área, estado do número e shiftStarts', async () => {
    const starts = [{ shiftId: 'noite', startsAt: '2026-10-22T02:00:00.000Z' }];
    useTeamRoster.mockImplementation((ids: string[], date: string) =>
      rosterOf(ids, date, starts, [{ id: 'zeca', name: 'Zeca' }]));
    const user = await openProducao('Noite');
    expect(useTeamRoster).toHaveBeenLastCalledWith(['s1'], '2026-10-21');
    expect(screen.queryByText('Zeca')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Enviar para todos (3)' }));
    expect(dialogTarget().shiftStart).toEqual({ startsAt: '2026-10-22T02:00:00.000Z', startTime: '22:00' });
  });

  it('a prévia leva finalidade, base, setor, turno e a data de referência', async () => {
    await openProducao('Noite');
    expect(lastBody()).toMatchObject({
      purpose: 'shift_notice', base: 'on_duty', text: '',
      target: { type: 'sector', sectorIds: ['s1'], shiftIds: ['noite'], date: '2026-10-21' },
    });
  });

  it('mudar um filtro pede nova prévia depois de 300 ms', async () => {
    const user = await openProducao('Noite');
    await pickShift(user, 'Manhã');
    expect(lastBody().target.shiftIds).toEqual(['noite']);
    expect(screen.getByRole('button', { name: 'Enviar para todos (3)' })).toBeDisabled();
    await waitFor(() => expect(lastBody().target.shiftIds).toEqual(['manha', 'noite']));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Enviar para todos (3)' })).toBeEnabled());
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

  it('começa vazio com mais de um setor e pede a prévia e o roster com todos os setores', async () => {
    render(<Page />);
    expect(screen.queryByRole('checkbox', { name: 'Produção' })).not.toBeChecked();
    expect(screen.getByText(NEEDS_CHOICE)).toBeInTheDocument();
    cleanup();
    await openBoth();
    expect(useTeamRoster).toHaveBeenLastCalledWith(['s1', 's2'], '2026-10-21');
    expect(lastBody().target.sectorIds).toEqual(['s1', 's2']);
  });

  it('agrupa por área pelo sectorId da prévia; remanejado aparece uma vez', async () => {
    await openBoth();
    expect(screen.getByRole('heading', { name: 'Expedição' })).toBeInTheDocument();
    expect(list('Vão receber · Produção').getAllByRole('checkbox')).toHaveLength(3);
    expect(list('Vão receber · Expedição').getAllByRole('checkbox')).toHaveLength(1);
    expect(screen.getByRole('heading', { name: 'Vão receber (4)' })).toBeInTheDocument();
    expect(screen.getAllByText('Bia')).toHaveLength(1);
  });

  it('o filtro de nível vai na prévia e o alvo do diálogo leva o que o servidor aplicou', async () => {
    const user = await openBoth();
    await toggleBox(user, 'Coordenador');
    await waitFor(() => expect(lastBody().target.levelIds).toEqual(['l1']));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Enviar para todos (4)' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Enviar para todos (4)' }));
    expect(dialogTarget()).toMatchObject({
      sectorIds: ['s1', 's2'], levelIds: ['l1'], withoutLevel: false, userIds: null,
      label: 'Expedição, Produção · Coordenador · Noite · 21/10',
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
  const sendSelected = (count: number) => screen.findByRole('button', { name: `Enviar para selecionados (${count})` });

  it('selecionados: a prévia leva os userIds e o alvo, a lista conferida', async () => {
    const user = await openProducao('Noite');
    await user.click(screen.getByRole('checkbox', { name: 'Rui' }));
    await user.click(screen.getByRole('checkbox', { name: 'João' }));
    await waitFor(() => expect(lastBody().target.userIds).toEqual(['joao', 'rui']));
    const send = await sendSelected(2);
    await waitFor(() => expect(send).toBeEnabled());
    await user.click(send);
    expect(dialogTarget()).toEqual({
      type: 'sector', sectorIds: ['s1'], levelIds: [], withoutLevel: false, date: '2026-10-21', shiftIds: ['noite'],
      includeOff: false, userIds: ['joao', 'rui'], label: 'Produção · Noite · 21/10 · seleção de 2',
      recipients: [{ id: 'joao', name: 'João' }, { id: 'rui', name: 'Rui' }],
      leftOut: [{ name: 'Pedro', reason: 'no_phone' }, { name: 'Ana', reason: 'unselected' }],
    });
  });

  it('com marcados aparece Não selecionado; Enviar para todos sem userIds leva a lista toda', async () => {
    const user = await openProducao('Todos os turnos');
    await user.click(screen.getByRole('button', { name: 'Enviar para todos (3)' }));
    expect(dialogTarget()).toMatchObject({ shiftIds: [], userIds: null, leftOut: [{ name: 'Pedro', reason: 'no_phone' }] });
    await user.click(screen.getByRole('checkbox', { name: 'João' }));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Não selecionado (2)' })).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Enviar para todos' })).toBeDisabled();
  });

  it('Marcar todos marca e desmarca', async () => {
    const user = await openProducao('Noite');
    await user.click(screen.getByRole('button', { name: 'Marcar todos' }));
    expect(screen.getByRole('checkbox', { name: 'Ana' })).toBeChecked();
    await waitFor(() => expect(lastBody().target.userIds).toEqual(['ana', 'joao', 'rui']));
    await user.click(screen.getByRole('button', { name: 'Marcar todos' }));
    expect(screen.getByRole('checkbox', { name: 'Ana' })).not.toBeChecked();
  });
});

describe('WhatsApp da equipe: diálogo com a prévia vista', () => {
  it('o diálogo recebe a prévia da tela com isFresh; fechar volta para a lista', async () => {
    const user = await openProducao('Noite');
    const sendAll = await screen.findByRole('button', { name: 'Enviar para todos (3)' });
    await waitFor(() => expect(sendAll).toBeEnabled());
    await user.click(sendAll);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('data-audience-key', 'a'.repeat(64));
    expect(dialog).toHaveAttribute('data-fresh', 'true');
    await user.click(screen.getByRole('button', { name: 'Fechar diálogo' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('WhatsApp da equipe: seleção limpa com o público', () => {
  it('trocar a data, o turno ou o setor limpa a seleção', async () => {
    const user = await openProducao('Noite');
    await user.click(screen.getByRole('checkbox', { name: 'João' }));
    fireEvent.change(screen.getByLabelText('Data'), { target: { value: '2026-10-22' } });
    expect(useTeamRoster).toHaveBeenLastCalledWith(['s1'], '2026-10-22');
    expect(screen.getByRole('checkbox', { name: 'João' })).not.toBeChecked();
    await user.click(screen.getByRole('checkbox', { name: 'João' }));
    await pickShift(user, 'Manhã');
    expect(screen.getByRole('checkbox', { name: 'João' })).not.toBeChecked();
    await user.click(screen.getByRole('checkbox', { name: 'João' }));
    await toggleBox(user, 'Expedição');
    expect(screen.getByRole('checkbox', { name: 'João' })).not.toBeChecked();
  });
});

describe('WhatsApp da equipe: 422 invalid_selection', () => {
  it('limpa a seleção, avisa e pede a prévia de novo', async () => {
    const invalid = { ...PREVIEW_OK, data: undefined, error: httpError(422, 'team_whatsapp.invalid_selection') };
    useAudiencePreview.mockImplementation((body: TeamAudienceRequest | null) => (body?.target.userIds ? invalid : answer(body)));
    const user = await openProducao('Noite');
    await user.click(screen.getByRole('checkbox', { name: 'João' }));
    expect(await screen.findByText('A lista mudou. Marque as pessoas de novo.')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'João' })).not.toBeChecked());
    await waitFor(() => expect(lastBody().target).not.toHaveProperty('userIds'));
    expect(screen.queryByRole('button', { name: 'Tentar novamente' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: 'Rui' }));
    expect(screen.queryByText('A lista mudou. Marque as pessoas de novo.')).not.toBeInTheDocument();
  });
});

describe('WhatsApp da equipe: erro da prévia', () => {
  async function openWithPreviewError(error: unknown) {
    const refetch = vi.fn();
    useAudiencePreview.mockReturnValue({ ...PREVIEW_OK, data: undefined, error, refetch });
    const user = await openProducao('Todos os turnos');
    return { user, refetch };
  }

  it('mostra o erro com Tentar novamente, que consulta a prévia de novo', async () => {
    const { user, refetch } = await openWithPreviewError(httpError(500));
    await user.click(await screen.findByRole('button', { name: 'Tentar novamente' }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('too_many_people (422) pede para escolher menos setores', async () => {
    await openWithPreviewError(httpError(422, 'team_whatsapp.too_many_people'));
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
