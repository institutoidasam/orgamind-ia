import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentType } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { daysBetween } from '@/lib/civil-date';

const mocks = vi.hoisted(() => ({
  useScheduleOptions: vi.fn(),
  useScheduleBoard: vi.fn(),
  create: vi.fn(),
  remove: vi.fn(),
  put: vi.fn(),
  removeSchedule: vi.fn(),
}));

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (opts: Record<string, unknown>) => ({ ...opts }),
}));
vi.mock('@/features/staff-schedule/api', () => ({
  useScheduleOptions: () => mocks.useScheduleOptions(),
  useScheduleBoard: (q: unknown) => mocks.useScheduleBoard(q),
  useCreateException: () => ({ mutateAsync: mocks.create, isPending: false }),
  useDeleteException: () => ({ mutateAsync: mocks.remove, isPending: false }),
  usePutSchedule: () => ({ mutateAsync: mocks.put, isPending: false }),
  useDeleteSchedule: () => ({ mutateAsync: mocks.removeSchedule, isPending: false }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { Route } from './index';

const Page = (Route as unknown as { component: ComponentType }).component;

// Radix Select (shadcn) usa PointerEvents/scrollIntoView, que o jsdom não tem.
if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false;
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};

const noite = { id: 'noite', name: 'Noite', startTime: '22:00', endTime: '06:00' };
const producao = { id: 's1', name: 'Produção' };
const logistica = { id: 's2', name: 'Logística' };

const WORK_NOITE = { kind: 'WORK', sectorId: 's1', shiftId: 'noite', source: 'CYCLE' } as const;
const DAY_OFF = { kind: 'OFF', reason: 'DAY_OFF', source: 'EXCEPTION' } as const;

type Range = { sectorId: string; from: string; to: string };

function row(userId: string, name: string, extra: Record<string, unknown>) {
  return { userId, name, jobTitle: null, fromOtherSector: false, canEdit: true, profileShiftId: null, schedule: null, ...extra };
}

function boardFor({ sectorId, from, to }: Range) {
  const days = (first: unknown) =>
    daysBetween(from, to).map((date, i) => ({ date, situation: i === 0 ? first : WORK_NOITE, exceptionId: null }));
  return {
    sectorId, from, to, today: '2026-10-21', sectors: [producao], shifts: [{ ...noite, isActive: true }], exceptions: [],
    rows: [
      row('u1', 'Ana', { jobTitle: 'Operadora', profileShiftId: 'noite', days: days(WORK_NOITE) }),
      row('u2', 'Bia', { canEdit: false, days: days(DAY_OFF) }),
      row('u3', 'Caio', { fromOtherSector: true, jobTitle: 'Conferente', days: days(WORK_NOITE) }),
    ],
  };
}

function mockData(sectors = [producao]) {
  mocks.useScheduleOptions.mockReturnValue({
    data: { today: '2026-10-21', sectors, shifts: [noite] }, isLoading: false, isError: false,
  });
  mocks.useScheduleBoard.mockImplementation((q: Range | null) =>
    q ? { data: boardFor(q), isLoading: false, isError: false } : { data: undefined, isLoading: false, isError: false },
  );
}

const lastRange = () => mocks.useScheduleBoard.mock.lastCall?.[0];
const rowOf = (name: string) => screen.getByRole('row', { name: new RegExp(name) });

beforeEach(() => {
  vi.clearAllMocks();
  mockData();
});

describe('/escala: setor e quadro', () => {
  it('setor único já vem escolhido, sem seletor', () => {
    render(<Page />);
    expect(screen.queryByRole('combobox', { name: 'Setor' })).not.toBeInTheDocument();
    expect(screen.getByText('Produção')).toBeInTheDocument();
    expect(lastRange()).toMatchObject({ sectorId: 's1' });
  });

  it('com mais de um setor pede a escolha e só então busca o quadro', async () => {
    mockData([producao, logistica]);
    const user = userEvent.setup();
    render(<Page />);
    expect(lastRange()).toBeNull();
    await user.click(screen.getByRole('combobox', { name: 'Setor' }));
    await user.click(screen.getByRole('option', { name: 'Logística' }));
    expect(lastRange()).toMatchObject({ sectorId: 's2' });
  });

  it('uma linha por pessoa com a função; "de outro setor" separado abaixo', () => {
    render(<Page />);
    const names = screen.getAllByRole('row').slice(1).map((r) => r.textContent);
    expect(names).toEqual([
      expect.stringContaining('Ana'), expect.stringContaining('Bia'), expect.stringContaining('Caio'),
    ]);
    expect(within(rowOf('Ana')).getByText('Operadora')).toBeInTheDocument();
    expect(screen.getAllByText('de outro setor')).toHaveLength(1);
    expect(within(rowOf('Caio')).getByText('de outro setor')).toBeInTheDocument();
    expect(within(rowOf('Bia')).getAllByText('Folga')).toHaveLength(1);
  });
});

describe('/escala: período', () => {
  it('Semana pede 2026-10-19 a 2026-10-25 a partir de today e a navegação avança', async () => {
    const user = userEvent.setup();
    render(<Page />);
    expect(lastRange()).toEqual({ sectorId: 's1', from: '2026-10-19', to: '2026-10-25' });
    await user.click(screen.getByRole('button', { name: 'Próximo período' }));
    expect(lastRange()).toEqual({ sectorId: 's1', from: '2026-10-26', to: '2026-11-01' });
    await user.click(screen.getByRole('button', { name: 'Período anterior' }));
    expect(lastRange()).toEqual({ sectorId: 's1', from: '2026-10-19', to: '2026-10-25' });
  });

  it('Mês pede 2026-10-01 a 2026-10-31 e a navegação avança de mês', async () => {
    const user = userEvent.setup();
    render(<Page />);
    await user.click(screen.getByRole('tab', { name: 'Mês' }));
    expect(lastRange()).toEqual({ sectorId: 's1', from: '2026-10-01', to: '2026-10-31' });
    await user.click(screen.getByRole('button', { name: 'Próximo período' }));
    expect(lastRange()).toEqual({ sectorId: 's1', from: '2026-11-01', to: '2026-11-30' });
    await user.click(screen.getByRole('button', { name: 'Período anterior' }));
    await user.click(screen.getByRole('button', { name: 'Período anterior' }));
    expect(lastRange()).toEqual({ sectorId: 's1', from: '2026-09-01', to: '2026-09-30' });
  });
});

describe('/escala: células', () => {
  it('célula de linha editável abre o diálogo da exceção para aquele dia', async () => {
    const user = userEvent.setup();
    render(<Page />);
    await user.click(within(rowOf('Ana')).getAllByRole('button')[0]);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/Ana · 19\/10/)).toBeInTheDocument();
  });

  it('linha sem canEdit não abre o diálogo', async () => {
    const user = userEvent.setup();
    render(<Page />);
    expect(within(rowOf('Bia')).queryAllByRole('button')).toHaveLength(0);
    await user.click(within(rowOf('Bia')).getByText('Folga'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('/escala: editar escala', () => {
  it('Editar escala só aparece em linha com canEdit e abre o editor da pessoa', async () => {
    const user = userEvent.setup();
    render(<Page />);
    expect(within(rowOf('Bia')).queryByRole('button', { name: 'Editar escala' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Editar escala' })).toHaveLength(2);
    await user.click(within(rowOf('Ana')).getByRole('button', { name: 'Editar escala' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'Editar escala' })).toBeInTheDocument();
    expect(within(dialog).getByText('Ana')).toBeInTheDocument();
    // Ana não tem escala e o turno do cadastro (Noite) está ativo: o editor parte dele.
    expect(within(dialog).getByRole('combobox', { name: 'Modelo' })).toHaveTextContent('Semanal');
    expect(within(dialog).getByRole('combobox', { name: 'Turno' })).toHaveTextContent('Noite');
  });
});
