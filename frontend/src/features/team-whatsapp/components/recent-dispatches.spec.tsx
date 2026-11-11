import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, params }: { children: React.ReactNode; to: string; params: Record<string, string> }) => (
    <a data-to={to} href={to.replace('$dispatchId', params.dispatchId)}>{children}</a>
  ),
}));

import type { DispatchList } from '../schemas';
import { RecentDispatches } from './recent-dispatches';

type Item = DispatchList['items'][number];

const counts = {
  queued: 0, sent: 0, delivered: 0, read: 0, replied: 0, failed: 0, uncertain: 0, skipped: 0, scheduled: 0, cancelled: 0,
};

const base: Item = {
  id: 'd1',
  createdAt: '2026-10-22T12:00:00.000Z',
  author: { id: 'a1', name: 'Ada', email: 'ada@x.test' },
  target: { type: 'sector', id: 's-ti', label: 'TI, Operação · Noite · 22/10', shift: null },
  sectors: [{ id: 's-ti', name: 'TI' }, { id: 's-op', name: 'Operação' }],
  channels: [{ name: 'GoZap Principal', phoneE164: '+5592999990000', count: 4 }],
  counts,
  rosterDate: '2026-10-22',
  state: 'DISPATCHED',
  scheduledFor: null,
  firedAt: null,
};

const paging = { page: 1, pageSize: 20, total: 1, onPageChange: vi.fn() };
const renderItem = (extra: Partial<Item> = {}) =>
  render(<RecentDispatches items={[{ ...base, ...extra }]} paging={paging} />);
const cells = () => within(screen.getAllByRole('row')[1]).getAllByRole('cell');

describe('RecentDispatches: contagens por situação', () => {
  it.each([
    [{ sent: 3, read: 1 }, 'Aceito pelo WhatsApp 3 · Lido 1'],
    [
      { queued: 1, sent: 3, delivered: 2, read: 1, replied: 1, failed: 2, uncertain: 1, skipped: 1 },
      'Na fila 1 · Aceito pelo WhatsApp 3 · Entregue 2 · Lido 1 · Respondeu 1 · Falhou 2 · Situação incerta 1 · Pulado 1',
    ],
  ])('%j mostra só as partes não zero, na ordem do ciclo', (parts, text) => {
    renderItem({ counts: { ...counts, ...parts } });
    expect(cells()[4]).toHaveTextContent(text);
    expect(cells()[4]).not.toHaveTextContent('Enviado');
    expect(cells()[4]).not.toHaveTextContent('Enfileirados');
  });

  it('envio agendado mostra o selo e a contagem de agendados', () => {
    renderItem({ state: 'SCHEDULED', counts: { ...counts, scheduled: 2 } });
    expect(cells()[4]).toHaveTextContent('AgendadoAgendado 2');
  });
});

describe('RecentDispatches: resultado e números', () => {
  it('o link Ver resultado leva ao resultado do envio', () => {
    renderItem();
    const link = screen.getByRole('link', { name: 'Ver resultado' });
    expect(link).toHaveAttribute('data-to', '/whatsapp-equipe/$dispatchId');
    expect(link).toHaveAttribute('href', '/whatsapp-equipe/d1');
    expect(screen.queryByText('Ver destinatários')).not.toBeInTheDocument();
  });

  it('envio com dois números mostra os dois, com quantas pessoas cada um', () => {
    renderItem({
      channels: [
        { name: 'GoZap Principal', phoneE164: '+5592999990000', count: 4 },
        { name: 'Comercial', phoneE164: null, count: 2 },
      ],
    });
    expect(cells()[3]).toHaveTextContent('+5592999990000 (4)');
    expect(cells()[3]).toHaveTextContent('Comercial (2)');
  });

  it('número removido depois do envio e envio sem números são tratados', () => {
    const { unmount } = renderItem({ channels: [{ name: null, phoneE164: null, count: 3 }] });
    expect(cells()[3]).toHaveTextContent('Número removido');
    unmount();
    renderItem({ channels: [] });
    expect(cells()[3]).toHaveTextContent('—');
  });
});

describe('RecentDispatches: lista', () => {
  it('autor sem nome e sem e-mail (pessoa sem acesso) mostra o traço', () => {
    renderItem({ author: { id: 'a1', name: null, email: null } });
    expect(cells()[1]).toHaveTextContent('—');
  });

  it('sem envios mostra o vazio', () => {
    render(<RecentDispatches items={[]} paging={{ ...paging, total: 0 }} />);
    expect(screen.getByText('Nenhum envio ainda.')).toBeInTheDocument();
  });

  it('com mais de uma página mostra a paginação e a próxima página é pedida', async () => {
    const onPageChange = vi.fn();
    render(<RecentDispatches items={[base]} paging={{ page: 1, pageSize: 20, total: 45, onPageChange }} />);
    expect(screen.getByText(/Página 1 de 3/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Próxima' }));
    expect(onPageChange).toHaveBeenCalledWith(2);
  });
});
