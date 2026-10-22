import { fireEvent, render, screen, within } from '@testing-library/react';
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
}));
vi.mock('@/features/team-whatsapp/api', () => ({
  useTeamTargets: () => useTeamTargets(),
  useTeamDispatches: () => useTeamDispatches(),
  useTeamRoster: (q: unknown) => useTeamRoster(q),
  useScheduledDispatches: () => useScheduledDispatches(),
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

async function pick(user: User, trigger: 'Setor' | 'Turno', option: string) {
  await user.click(screen.getByRole('combobox', { name: trigger }));
  await user.click(screen.getByRole('option', { name: option }));
}

async function openProducao(turno: string) {
  const user = userEvent.setup();
  render(<Page />);
  await pick(user, 'Setor', 'Produção');
  await pick(user, 'Turno', turno);
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
  fromOtherSector: false, situation, ...extra,
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
const targets = { today: '2026-10-21', inProgress: null, shifts: [manha, noite], channels: [], sectors };
const dispatches = {
  items: [
    {
      id: 'd1', createdAt: '2026-10-16T12:00:00.000Z',
      author: { id: 'a1', name: 'Ada', email: 'ada@x.test' },
      target: { type: 'sector' as const, id: 's1', label: 'Compras', shift: null },
      channel: { id: 'ch1', name: 'GoZap Principal' },
      counts: { queued: 1, sent: 2, failed: 3, skipped: 4 },
      recipients: [], rosterDate: null, unselected: [], off: [],
    },
    {
      id: 'd2', createdAt: '2026-10-15T12:00:00.000Z',
      author: null,
      target: { type: 'user' as const, id: 'u1', label: 'Ana', shift: null },
      channel: null,
      counts: { queued: 0, sent: 1, failed: 0, skipped: 0 },
      recipients: [], rosterDate: null, unselected: [], off: [],
    },
  ],
};

function http403() {
  return new HTTPError(new Response('{}', { status: 403 }), new Request('https://x'), {} as never);
}

beforeEach(() => {
  useTeamTargets.mockReturnValue({ data: targets, isLoading: false, isError: false });
  useTeamDispatches.mockReturnValue({ data: dispatches, isLoading: false, isError: false });
  useScheduledDispatches.mockReturnValue({ data: { items: [] }, isLoading: false, isError: false });
  useTeamRoster.mockImplementation((q: { sectorId: string; date: string } | null) => ({
    data: q ? { ...q, shiftStarts: [], members } : undefined, isLoading: false, isError: false,
  }));
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
    expect(screen.queryByRole('combobox', { name: 'Setor' })).not.toBeInTheDocument();
    expect(screen.getByText('Envios recentes')).toBeInTheDocument();
  });
});

describe('WhatsApp da equipe: seletores', () => {
  it('Data começa em targets.today e o Turno lista os turnos ativos e Todos os turnos', async () => {
    const user = userEvent.setup();
    render(<Page />);
    expect(screen.getByLabelText('Data')).toHaveValue('2026-10-21');
    await user.click(screen.getByRole('combobox', { name: 'Turno' }));
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['Manhã', 'Noite', 'Todos os turnos']);
  });

  it('pede setor e turno até escolher os dois', async () => {
    const user = userEvent.setup();
    render(<Page />);
    expect(screen.getByText(NEEDS_CHOICE)).toBeInTheDocument();
    await pick(user, 'Turno', 'Noite');
    expect(screen.getByText(NEEDS_CHOICE)).toBeInTheDocument();
    await pick(user, 'Setor', 'Produção');
    expect(screen.queryByText(NEEDS_CHOICE)).not.toBeInTheDocument();
  });

  it('pré-seleciona o setor quando há um só e pede só o turno', async () => {
    useTeamTargets.mockReturnValue({ data: { ...targets, sectors: [sectors[0]] }, isLoading: false, isError: false });
    const user = userEvent.setup();
    render(<Page />);
    expect(screen.getByRole('combobox', { name: 'Setor' })).toHaveTextContent('Produção');
    expect(screen.getByText(NEEDS_CHOICE)).toBeInTheDocument();
    await pick(user, 'Turno', 'Noite');
    expect(screen.queryByText(NEEDS_CHOICE)).not.toBeInTheDocument();
  });
});

describe('WhatsApp da equipe: quem aparece', () => {
  it('Noite lista só os escalados na Noite com a função; De folga mostra Maria (Férias)', async () => {
    await openProducao('Noite');
    expect(useTeamRoster).toHaveBeenLastCalledWith({ sectorId: 's1', date: '2026-10-21' });
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
    await pick(user, 'Turno', 'Todos os turnos');
    await user.click(screen.getByRole('checkbox', { name: INCLUDE_OFF }));
    expect(checkboxNames()).toEqual(['Ana', 'João', 'Maria', 'Rui']);
    expect(screen.queryByRole('list', { name: 'De folga' })).not.toBeInTheDocument();
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
    expect(screen.getByRole('combobox', { name: 'Turno' })).toHaveTextContent('Noite');
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
      type: 'sector', sectorId: 's1', date: '2026-10-21', shiftId: 'noite', includeOff: false, userIds: ['joao', 'rui'],
      label: 'Produção · Noite · 21/10 · seleção de 2',
      recipients: [{ id: 'joao', name: 'João' }, { id: 'rui', name: 'Rui' }],
      leftOut: [],
    });
  });

  it('todos os turnos com folga: sem shiftId e sem userIds, e o sem telefone fica de fora', async () => {
    const user = await openProducao('Todos os turnos');
    await user.click(screen.getByRole('checkbox', { name: INCLUDE_OFF }));
    await user.click(screen.getByRole('button', { name: 'Enviar para todos (4)' }));
    expect(dialogTarget()).toEqual({
      type: 'sector', sectorId: 's1', date: '2026-10-21', shiftId: null, includeOff: true, userIds: null,
      label: 'Produção · todos os turnos · 21/10',
      recipients: [{ id: 'ana', name: 'Ana' }, { id: 'joao', name: 'João' }, { id: 'maria', name: 'Maria' }, { id: 'rui', name: 'Rui' }],
      leftOut: [{ id: 'pedro', name: 'Pedro' }],
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
    expect(useTeamRoster).toHaveBeenLastCalledWith({ sectorId: 's1', date: '2026-10-22' });
    expect(screen.getByRole('button', { name: 'Enviar para selecionados (0)' })).toBeDisabled();
    await user.click(screen.getByRole('checkbox', { name: 'João' }));
    await pick(user, 'Turno', 'Manhã');
    expect(screen.getByRole('button', { name: 'Enviar para selecionados (0)' })).toBeDisabled();
    await pick(user, 'Turno', 'Noite');
    await user.click(screen.getByRole('checkbox', { name: 'João' }));
    await pick(user, 'Setor', 'Expedição');
    await pick(user, 'Setor', 'Produção');
    expect(screen.getByRole('button', { name: 'Enviar para selecionados (0)' })).toBeDisabled();
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
  it('lista destino, autor, canal e contagens; canal e autor removidos são tratados', () => {
    render(<Page />);
    const first = screen.getByRole('row', { name: /GoZap Principal/ });
    expect(first).toHaveTextContent('Compras');
    expect(first).toHaveTextContent('Ada');
    expect(first).toHaveTextContent('Enfileirados 1 · Enviados 2 · Falhas 3 · Pulados 4');
    const second = screen.getByRole('row', { name: /canal removido/ });
    expect(second).toHaveTextContent('Ana');
    expect(second).toHaveTextContent('—');
  });

  it('mostra o vazio quando não há envios', () => {
    useTeamDispatches.mockReturnValue({ data: { items: [] }, isLoading: false, isError: false });
    render(<Page />);
    expect(screen.getByText('Nenhum envio ainda.')).toBeInTheDocument();
  });
});

describe('WhatsApp da equipe: Ver destinatários', () => {
  const recipient = (name: string, shiftName: string | null, status: string, reason: string | null) => ({
    userId: `id-${name}`, name, shiftName, status, reason,
  });
  const person = (name: string, extra: Record<string, unknown> = {}) => ({
    userId: `id-${name}`, name, jobTitle: null, shiftName: null, reason: null, ...extra,
  });
  const withGroups = {
    ...dispatches.items[0],
    target: { type: 'sector' as const, id: 's1', label: 'Produção · Noite · 21/10', shift: { ...noite } },
    recipients: [
      recipient('Ana', 'Noite', 'SENT', null),
      recipient('Bia', 'Noite', 'FAILED', 'evolution.session_closed'),
      recipient('Caio', null, 'SKIPPED', 'NO_PHONE'),
    ],
    rosterDate: '2026-10-21',
    unselected: [person('Davi', { jobTitle: 'Líder', shiftName: 'Noite' })],
    off: [person('Eva', { reason: 'VACATION' })],
  };
  const texts = (row: HTMLElement, name: string) =>
    within(within(row).getByRole('list', { name })).getAllByRole('listitem').map((li) => li.textContent);

  it('mostra Destinatários com resultado, Escalados não marcados e De folga, sem telefone', async () => {
    useTeamDispatches.mockReturnValue({ data: { items: [withGroups, dispatches.items[1]] }, isLoading: false, isError: false });
    render(<Page />);
    const rows = screen.getAllByRole('row');
    expect(within(rows[2]).queryByText('Ver destinatários')).not.toBeInTheDocument();
    await userEvent.click(within(rows[1]).getByText('Ver destinatários'));
    expect(texts(rows[1], 'Destinatários')).toEqual([
      'Ana · Noite — Enviado',
      'Bia · Noite — Falhou: Canal desconectado — reconecte em Números e canais',
      'Caio — Pulado: sem telefone',
    ]);
    expect(texts(rows[1], 'Escalados não marcados')).toEqual(['Davi · Líder · Noite']);
    expect(texts(rows[1], 'De folga')).toEqual(['Eva · Férias']);
    expect(screen.getByRole('table')).not.toHaveTextContent('+55');
  });
});

describe('WhatsApp da equipe: agendamento', () => {
  const scheduledItem = {
    id: 'g1', scheduledFor: '2026-10-22T02:00:00.000Z', rosterDate: '2026-10-21', shift: noite,
    label: 'Produção · Noite · 21/10', recipientCount: 2, channel: null, author: null,
  };

  it('o alvo de um turno leva o início do turno do servidor e a hora gravada', async () => {
    useTeamRoster.mockImplementation((q: { sectorId: string; date: string } | null) => ({
      data: q ? { ...q, shiftStarts: [{ shiftId: 'noite', startsAt: '2026-10-22T02:00:00.000Z' }], members } : undefined,
      isLoading: false, isError: false,
    }));
    const user = await openProducao('Noite');
    await user.click(screen.getByRole('button', { name: 'Enviar para todos (2)' }));
    expect(dialogTarget().shiftStart).toEqual({ startsAt: '2026-10-22T02:00:00.000Z', startTime: '22:00' });
  });

  it('lista os agendados acima dos envios recentes e marca o envio agendado como Agendado', () => {
    useScheduledDispatches.mockReturnValue({ data: { items: [scheduledItem] }, isLoading: false, isError: false });
    useTeamDispatches.mockReturnValue({
      data: { items: [{ ...dispatches.items[0], state: 'SCHEDULED', counts: { ...dispatches.items[0].counts, scheduled: 2 } }] },
      isLoading: false, isError: false,
    });
    render(<Page />);
    expect(screen.getByRole('heading', { name: 'Agendados' })).toBeInTheDocument();
    expect(screen.getByText('21/10 22:00')).toBeInTheDocument();
    expect(screen.getByText(/Agendados 2/)).toBeInTheDocument();
  });
});
