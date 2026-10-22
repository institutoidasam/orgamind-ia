import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HTTPError } from 'ky';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mutateAsync } = vi.hoisted(() => ({ mutateAsync: vi.fn() }));

vi.mock('../api', () => ({
  useCancelDispatch: () => ({ mutateAsync, isPending: false }),
}));

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

function httpError(status: number, code?: string) {
  const response = new Response(JSON.stringify(code ? { code } : {}), { status });
  return new HTTPError(response, new Request('https://x'), {} as never);
}
const conflict = () => httpError(409, 'team_whatsapp.not_cancellable');

async function confirmCancel() {
  const user = userEvent.setup();
  render(<ScheduledDispatches items={[item]} />);
  await user.click(screen.getByRole('button', { name: 'Cancelar' }));
  await user.click(screen.getByRole('button', { name: 'Cancelar envio' }));
}

beforeEach(() => { mutateAsync.mockClear(); });

describe('ScheduledDispatches', () => {
  it('lista data e hora gravadas, rótulo e quantidade de pessoas', () => {
    render(<ScheduledDispatches items={[item]} />);
    expect(screen.getByText('Agendados')).toBeInTheDocument();
    expect(screen.getByText('21/10 22:00')).toBeInTheDocument();
    expect(screen.getByText('Produção · Noite · 21/10')).toBeInTheDocument();
    expect(screen.getByText('3 pessoa(s)')).toBeInTheDocument();
  });

  it('não mostra nada sem agendados', () => {
    render(<ScheduledDispatches items={[]} />);
    expect(screen.queryByText('Agendados')).not.toBeInTheDocument();
  });

  it('Cancelar pede confirmação e chama o POST cancel', async () => {
    mutateAsync.mockResolvedValue({ id: 'd1', state: 'CANCELLED' });
    const user = userEvent.setup();
    render(<ScheduledDispatches items={[item]} />);
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
