import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HTTPError } from 'ky';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mutateAsync, onPageChange } = vi.hoisted(() => ({ mutateAsync: vi.fn(), onPageChange: vi.fn() }));

vi.mock('../api', () => ({
  useCancelDispatch: () => ({ mutateAsync, isPending: false }),
}));

import { useAuthStore, type AuthUser } from '@/stores/auth.store';
import { ScheduledDispatches } from './scheduled-dispatches';
import type { ScheduledDispatch } from '../schemas';

const item: ScheduledDispatch = {
  id: 'd1',
  scheduledFor: '2026-10-22T02:00:00.000Z',
  rosterDate: '2026-10-21',
  shift: { id: 'noite', name: 'Noite', startTime: '22:00', endTime: '06:00' },
  label: 'Produção · Noite · 21/10',
  recipientCount: 3,
  channel: { id: 'ch1', name: 'GoZap Principal' },
  author: { id: 'a1', name: 'Ada', email: 'ada@x.test' },
};

const paging = { page: 1, pageSize: 20, total: 1, onPageChange };
const renderList = (items: ScheduledDispatch[], extra: Partial<typeof paging> = {}) =>
  render(<ScheduledDispatches items={items} paging={{ ...paging, ...extra }} />);

function httpError(status: number, code?: string) {
  const response = new Response(JSON.stringify(code ? { code } : {}), { status });
  return new HTTPError(response, new Request('https://x'), {} as never);
}
const conflict = () => httpError(409, 'team_whatsapp.not_cancellable');

async function confirmCancel() {
  const user = userEvent.setup();
  renderList([item]);
  await user.click(screen.getByRole('button', { name: 'Cancelar' }));
  await user.click(screen.getByRole('button', { name: 'Cancelar envio' }));
}

const OPERATOR: AuthUser = { id: 'u1', email: 'o@x.test', name: 'Olga', role: 'OPERATOR' };

beforeEach(() => {
  mutateAsync.mockClear();
  onPageChange.mockClear();
  useAuthStore.setState({ user: OPERATOR });
});

describe('ScheduledDispatches: permissão (DB6, DB10)', () => {
  it('sem equipe.enviar some o Cancelar e o agendado continua na lista', () => {
    useAuthStore.setState({ user: { ...OPERATOR, permissions: ['trilha.consultar'] } });
    renderList([item]);
    expect(screen.getByText('Produção · Noite · 21/10')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancelar' })).not.toBeInTheDocument();
  });

  it('403 auth.permission_denied mostra o detail do servidor', async () => {
    const body = JSON.stringify({ code: 'auth.permission_denied', detail: 'Texto do servidor.' });
    mutateAsync.mockRejectedValue(new HTTPError(new Response(body, { status: 403 }), new Request('https://x'), {} as never));
    await confirmCancel();
    expect(await screen.findByRole('alert')).toHaveTextContent('Texto do servidor.');
  });
});

describe('ScheduledDispatches', () => {
  it('lista data e hora gravadas, rótulo e quantidade de pessoas', () => {
    renderList([item]);
    expect(screen.getByText('Agendados')).toBeInTheDocument();
    expect(screen.getByText('21/10 22:00')).toBeInTheDocument();
    expect(screen.getByText('Produção · Noite · 21/10')).toBeInTheDocument();
    expect(screen.getByText('3 pessoa(s)')).toBeInTheDocument();
    expect(screen.getByText('GoZap Principal')).toBeInTheDocument();
  });

  it('envio sem um número único (várias áreas) mostra o traço, não "canal removido"', () => {
    renderList([{ ...item, channel: null }]);
    expect(screen.queryByText('canal removido')).not.toBeInTheDocument();
    expect(within(screen.getAllByRole('row')[1]).getAllByRole('cell')[3]).toHaveTextContent('—');
  });

  it('não mostra nada sem agendados', () => {
    renderList([], { total: 0 });
    expect(screen.queryByText('Agendados')).not.toBeInTheDocument();
  });

  it('com mais de uma página mostra a paginação e a próxima página é pedida; com uma só, não', async () => {
    const { unmount } = renderList([item], { total: 45 });
    expect(screen.getByText(/Página 1 de 3/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Próxima' }));
    expect(onPageChange).toHaveBeenCalledWith(2);
    unmount();
    renderList([item]);
    expect(screen.queryByText(/Página 1 de/)).not.toBeInTheDocument();
  });

  it('Cancelar pede confirmação e chama o POST cancel', async () => {
    mutateAsync.mockResolvedValue({ id: 'd1', state: 'CANCELLED' });
    const user = userEvent.setup();
    renderList([item]);
    await user.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(mutateAsync).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Cancelar envio' }));
    expect(mutateAsync).toHaveBeenCalledWith('d1');
  });

});

describe('ScheduledDispatches — erro ao cancelar', () => {
  it('409 mostra que o envio já saiu ou foi cancelado', async () => {
    mutateAsync.mockImplementation(() => Promise.reject(conflict()));
    await confirmCancel();
    expect(await screen.findByRole('alert')).toHaveTextContent('Este envio já saiu ou foi cancelado.');
  });

  it('erro não mapeado fala do cancelamento, não do envio', async () => {
    mutateAsync.mockImplementation(() => Promise.reject(httpError(500)));
    await confirmCancel();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Não foi possível cancelar o envio. Tente de novo.',
    );
  });
});
