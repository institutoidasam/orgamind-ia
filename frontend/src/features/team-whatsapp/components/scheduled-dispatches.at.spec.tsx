import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api', () => ({
  useCancelDispatch: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

import { useAuthStore, type AuthUser } from '@/stores/auth.store';
import { scheduledListSchema, type ScheduledDispatch } from '../schemas';
import { ScheduledDispatches } from './scheduled-dispatches';

const HOUR_MS = 60 * 60 * 1000;
const OPERATOR: AuthUser = { id: 'u1', email: 'o@x.test', name: 'Olga', role: 'OPERATOR' };

/** Item como o servidor o manda, passando pelo esquema do front (nada de mock que já traga turno). */
function fromServer(extra: Record<string, unknown>): ScheduledDispatch {
  const payload = {
    items: [{
      id: 'd1',
      scheduledFor: '2026-10-27T02:00:00.000Z',
      rosterDate: '2026-10-26',
      shift: null,
      label: 'Produção, Operação · 26/10',
      recipientCount: 5,
      channel: null,
      author: { id: 'a1', name: 'Ada', email: 'ada@x.test' },
      ...extra,
    }],
    total: 1,
    page: 1,
    pageSize: 20,
  };
  return scheduledListSchema.parse(payload).items[0];
}

const renderList = (item: ScheduledDispatch) =>
  render(<ScheduledDispatches items={[item]} paging={{ page: 1, pageSize: 20, total: 1, onPageChange: vi.fn() }} />);
const ago = (hours: number) => new Date(Date.now() - hours * HOUR_MS).toISOString();
const LAPSED = 'Não enviado: passou da hora';

beforeEach(() => useAuthStore.setState({ user: OPERATOR }));
afterEach(cleanup);

describe('ScheduledDispatches: agendado em data e hora', () => {
  it('agendado em data e hora na lista de agendados', () => {
    renderList(fromServer({}));
    const cells = within(screen.getAllByRole('row')[1]).getAllByRole('cell');
    // shift null: dia/mês e hora de scheduledFor em Manaus (02:00 UTC = 22:00 da véspera), sem turno.
    expect(cells[0]).toHaveTextContent('26/10 22:00');
    expect(screen.getByRole('button', { name: 'Cancelar' })).toBeInTheDocument();
  });
});

describe('ScheduledDispatches: vencido com o worker parado (DG16)', () => {
  it('DG16: agendado vencido há mais de 2 h mostra passou da hora nos agendados; dentro das 2 h, não', () => {
    const { unmount } = renderList(fromServer({ scheduledFor: ago(3) }));
    expect(screen.getByText(LAPSED)).toBeInTheDocument();
    // Só o rótulo: as ações de hoje não mudam.
    expect(screen.getByRole('button', { name: 'Cancelar' })).toBeInTheDocument();
    unmount();
    renderList(fromServer({ scheduledFor: ago(1) }));
    expect(screen.queryByText(LAPSED)).not.toBeInTheDocument();
  });
});
