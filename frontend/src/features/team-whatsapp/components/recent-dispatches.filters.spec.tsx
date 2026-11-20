import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { useTeamDispatches } = vi.hoisted(() => ({ useTeamDispatches: vi.fn() }));

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a href="/detalhe">{children}</a>,
}));
vi.mock('../api', () => ({
  useTeamDispatches: (page: number, filters?: unknown) => useTeamDispatches(page, filters),
}));

import type { DispatchList } from '../schemas';
import { RecentDispatches, RecentHistory } from './recent-dispatches';

// Radix Select (shadcn) usa PointerEvents/scrollIntoView, que o jsdom não tem.
if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false;
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};

type Item = DispatchList['items'][number];

const counts = {
  queued: 0, sent: 0, delivered: 0, read: 0, replied: 0, failed: 0, uncertain: 0, skipped: 0, scheduled: 0, cancelled: 0,
};
const HOUR_MS = 60 * 60 * 1000;
const LAPSED = 'Não enviado: passou da hora';

const item: Item = {
  id: 'd1',
  createdAt: '2026-10-22T12:00:00.000Z',
  author: { id: 'a1', name: 'Ada', email: 'ada@x.test' },
  target: { type: 'sector', id: 's-ti', label: 'TI · Noite · 22/10', shift: null },
  sectors: [{ id: 's-ti', name: 'TI' }],
  channels: [{ name: 'Principal', phoneE164: '+5592999990000', count: 2 }],
  counts: { ...counts, sent: 2 },
  rosterDate: '2026-10-22',
  state: 'DISPATCHED',
  scheduledFor: null,
  firedAt: null,
  purpose: 'meeting',
  base: 'assigned',
  activity: null,
  urgencyReason: null,
};

const paging = { page: 1, pageSize: 20, total: 1, onPageChange: vi.fn() };
const renderItem = (extra: Partial<Item> = {}) =>
  render(<RecentDispatches items={[{ ...item, ...extra }]} paging={paging} />);
const cells = () => within(screen.getAllByRole('row')[1]).getAllByRole('cell');
const answer = (items: Item[], total = items.length) => ({
  data: { items, total, page: 1, pageSize: 20 }, isError: false,
});

async function pick(trigger: string, option: string) {
  await userEvent.click(screen.getByRole('combobox', { name: trigger }));
  await userEvent.click(screen.getByRole('option', { name: option }));
}
const type = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

beforeEach(() => {
  useTeamDispatches.mockReset();
  useTeamDispatches.mockReturnValue(answer([item], 45));
});
afterEach(cleanup);

describe('RecentHistory: filtros', () => {
  it('aceite 31: filtrar por finalidade, período e situação chama o hook com os filtros e volta à página 1', async () => {
    render(<RecentHistory />);
    expect(useTeamDispatches).toHaveBeenLastCalledWith(1, {});
    await pick('Filtrar por finalidade', 'Reunião');
    type('De', '2026-11-01');
    type('Até', '2026-11-30');
    await userEvent.click(screen.getByRole('button', { name: 'Próxima' }));
    expect(useTeamDispatches).toHaveBeenLastCalledWith(2, { purpose: 'meeting', from: '2026-11-01', to: '2026-11-30' });
    await pick('Filtrar por situação', 'Não enviado: passou da hora');
    expect(useTeamDispatches).toHaveBeenLastCalledWith(1, {
      purpose: 'meeting', from: '2026-11-01', to: '2026-11-30', state: 'EXPIRED',
    });
  });

  it('Limpar filtros', async () => {
    render(<RecentHistory />);
    await pick('Filtrar por situação', 'Cancelado');
    type('De', '2026-11-01');
    await userEvent.click(screen.getByRole('button', { name: 'Próxima' }));
    await userEvent.click(screen.getByRole('button', { name: 'Limpar filtros' }));
    expect(useTeamDispatches).toHaveBeenLastCalledWith(1, {});
    expect(screen.getByRole('combobox', { name: 'Filtrar por situação' })).toHaveTextContent('Todas');
    expect(screen.getByLabelText('De')).toHaveValue('');
  });

  it('sem resultado com filtro ativo mostra o vazio dos filtros e mantém os controles', async () => {
    useTeamDispatches.mockReturnValue(answer([]));
    render(<RecentHistory />);
    expect(screen.getByText('Nenhum envio ainda.')).toBeInTheDocument();
    await pick('Filtrar por finalidade', 'Palestra');
    expect(screen.getByText('Nenhum envio encontrado com esses filtros.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Limpar filtros' })).toBeInTheDocument();
  });
});

describe('RecentHistory: período invertido', () => {
  const INVERTED = 'A data inicial é depois da data final.';

  it('De depois de Até: não chama a API com o período invertido, avisa e mantém a lista até corrigir', () => {
    render(<RecentHistory />);
    type('De', '2026-11-10');
    type('Até', '2026-11-30');
    useTeamDispatches.mockClear();
    type('De', '2026-12-05');
    expect(screen.getByText(INVERTED)).toBeInTheDocument();
    expect(useTeamDispatches).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ from: '2026-12-05' }));
    expect(useTeamDispatches).toHaveBeenLastCalledWith(1, { from: '2026-11-10', to: '2026-11-30' });
    expect(screen.getByText('TI · Noite · 22/10')).toBeInTheDocument();
    expect(screen.getByLabelText('De')).toHaveValue('2026-12-05');
    type('De', '2026-11-05');
    expect(screen.queryByText(INVERTED)).not.toBeInTheDocument();
    expect(useTeamDispatches).toHaveBeenLastCalledWith(1, { from: '2026-11-05', to: '2026-11-30' });
  });
});

describe('RecentDispatches: situação e data de referência', () => {
  it('coluna Data de referência', () => {
    const { unmount } = renderItem();
    expect(screen.getByRole('columnheader', { name: 'Data de referência' })).toBeInTheDocument();
    expect(cells()[6]).toHaveTextContent('22/10/2026');
    unmount();
    renderItem({ rosterDate: null });
    expect(cells()[6]).toHaveTextContent('—');
  });

  it('aceite 24: envio sem ninguém recebendo mostra Ninguém recebeu', () => {
    renderItem({ counts: { ...counts, failed: 2, skipped: 1 } });
    expect(cells()[5]).toHaveTextContent('Ninguém recebeu');
    expect(cells()[5]).toHaveTextContent('Falhou 2 · Pulado 1');
    expect(cells()[5]).not.toHaveTextContent('Enviado');
  });

  it('aceite 26: vencido mostra Não enviado: passou da hora', () => {
    renderItem({ state: 'EXPIRED', counts: { ...counts, scheduled: 0 }, scheduledFor: '2026-10-22T10:00:00.000Z' });
    expect(cells()[5]).toHaveTextContent(LAPSED);
    expect(cells()[5]).not.toHaveTextContent('Enviado');
  });

  it('DG16: agendado vencido há mais de 2 h com o worker parado mostra passou da hora no histórico', () => {
    const at = (hours: number) => new Date(Date.now() - hours * HOUR_MS).toISOString();
    const { unmount } = renderItem({ state: 'SCHEDULED', counts: { ...counts, scheduled: 2 }, scheduledFor: at(3) });
    expect(cells()[5]).toHaveTextContent(LAPSED);
    unmount();
    renderItem({ state: 'SCHEDULED', counts: { ...counts, scheduled: 2 }, scheduledFor: at(1) });
    expect(cells()[5]).toHaveTextContent('Agendado');
    expect(cells()[5]).not.toHaveTextContent(LAPSED);
  });
});
