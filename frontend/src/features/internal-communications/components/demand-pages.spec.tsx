import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tanstack/react-router', () => ({ Link: ({ children, to }: { children: React.ReactNode; to: string }) => <a data-to={to}>{children}</a> }));
vi.mock('@/stores/auth.store', () => ({ useAuthStore: (select: (state: { user: { role: string } }) => unknown) => select({ user: { role: 'OPERATOR' } }) }));
const useCommunications = vi.fn();
const markRead = vi.fn();
vi.mock('../api', () => ({
  useCommunications: (filters: unknown) => { useCommunications(filters); return { data: { items: [item], page: 1, pageSize: 25, total: 26 }, isLoading: false, isError: false, refetch: vi.fn() }; },
  useCommunication: () => ({ data: detail, isLoading: false, isError: false, refetch: vi.fn() }),
  useEligibleMembers: () => ({ data: [] }), useMarkCommunicationRead: () => ({ mutate: markRead, mutateAsync: markRead, isPending: false }), useUpdateDemand: () => update, useComment: () => comment,
}));
import { DemandDetailPage, DemandsPage } from './demand-pages';

const item = { id: 'd1', reference: 'DEM-1', kind: 'DEMAND', subject: 'Validar lote', message: 'texto', originSector: { id: 'a', name: 'Origem', code: 'ORG' }, destinationSector: { id: 'b', name: 'Destino', code: 'DST' }, ccSectors: [], author: null, assignee: null, priority: 'NORMAL', dueDate: '2026-10-11', status: 'OPEN', version: 1, notifyTeam: true, notifyAssignee: true, createdAt: '2026-10-10T10:00:00Z', updatedAt: '2026-10-10T10:00:00Z', completedAt: null, isUnread: false, events: [] };
let detail = item;
const update = { mutate: vi.fn(), isPending: false, isError: false, error: undefined };
const comment = { mutate: vi.fn(), isPending: false, isError: false };

describe('DemandsPage', () => {
  beforeEach(() => { detail = item; markRead.mockReset(); markRead.mockResolvedValue(undefined); });
  it('mostra as colunas operacionais e reseta a página ao filtrar', async () => {
    const user = userEvent.setup(); render(<DemandsPage />);
    expect(screen.getByRole('columnheader', { name: 'Demanda' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Situação' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Responsável' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Prazo' })).toBeInTheDocument();
    expect(screen.getByRole('row', { name: /Validar lote.*Sem responsável/ })).toBeInTheDocument();
    expect(screen.getByText('11/10/2026')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Próxima' }));
    await user.selectOptions(screen.getByLabelText('Filtrar demandas por estado'), 'OPEN');
    expect(useCommunications).toHaveBeenLastCalledWith(expect.objectContaining({ page: 1, status: 'OPEN' }));
  });

  it('encaminha comunicado aberto pela rota de demanda para seu detalhe correto', () => {
    detail = { ...item, kind: 'ANNOUNCEMENT', status: null, priority: null };
    render(<DemandDetailPage communicationId="d1" />);
    expect(screen.getByText('Abrir comunicado')).toHaveAttribute('data-to', '/comunicados/$communicationId');
  });

  it('apresenta histórico em português e explica o conflito 409 sem repetir a mutation', () => {
    detail = { ...item, events: [{ id: 'e1', kind: 'STATUS_CHANGED', author: { id: 'u1', name: 'Bia', email: null }, createdAt: '2026-10-10T04:30:00.000Z' }] };
    update.isError = true; update.error = { response: { status: 409 } };
    render(<DemandDetailPage communicationId="d1" />);
    expect(screen.getByText('alterou a situação')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(/Atualize os dados/i);
    expect(screen.getByLabelText('Adicionar comentário')).toBeInTheDocument();
    expect(screen.getByText('Histórico')).toBeInTheDocument();
    expect(update.mutate).not.toHaveBeenCalled();
    update.isError = false; update.error = undefined;
  });

  it('permite tentar novamente a confirmação de leitura da demanda', async () => {
    detail = { ...item, isUnread: true }; markRead.mockRejectedValueOnce(new Error('500')).mockResolvedValueOnce(undefined); const user = userEvent.setup(); render(<DemandDetailPage communicationId="d1" />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/confirmar a leitura/i);
    await user.click(screen.getByRole('button', { name: 'Tentar novamente' }));
    await waitFor(() => expect(markRead).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  });
});
