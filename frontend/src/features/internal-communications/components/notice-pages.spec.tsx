import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tanstack/react-router', () => ({ Link: ({ children, to, params }: { children: React.ReactNode; to: string; params?: { communicationId?: string } }) => <a data-to={to} data-id={params?.communicationId}>{children}</a> }));
let role = 'OPERATOR';
vi.mock('@/stores/auth.store', () => ({ useAuthStore: (select: (state: { user: { role: string } }) => unknown) => select({ user: { role } }) }));
const item = { id: 'n1', reference: 'COM-1', kind: 'ANNOUNCEMENT', subject: 'Aviso', message: 'texto', originSector: { id: 'a', name: 'Origem', code: 'ORG' }, destinationSector: { id: 'b', name: 'Destino', code: 'DST' }, ccSectors: [], author: null, assignee: null, priority: null, dueDate: null, status: null, version: 1, notifyTeam: true, notifyAssignee: false, createdAt: '2026-10-10T10:00:00Z', updatedAt: '2026-10-10T10:00:00Z', completedAt: null, isUnread: true, events: [] };
const mutate = vi.fn(); const useCommunications = vi.fn(); let detail = item;
const comment = { mutate: vi.fn(), isPending: false, isError: false };
vi.mock('../api', () => ({
  useCommunications: (filters: unknown) => { useCommunications(filters); return { data: { items: [item], page: 1, pageSize: 25, total: 26 }, isLoading: false, isError: false, refetch: vi.fn() }; },
  useCommunication: () => ({ data: detail, isLoading: false, isError: false, refetch: vi.fn() }),
  useMarkCommunicationRead: () => ({ mutate, mutateAsync: mutate, isPending: false }), useComment: () => comment,
}));
import { NoticeDetailPage, NoticesPage } from './notice-pages';

describe('páginas de comunicados', () => {
  beforeEach(() => { detail = item; role = 'OPERATOR'; mutate.mockReset(); mutate.mockResolvedValue(undefined); });
  it('pagina a lista publicada', async () => {
    const user = userEvent.setup(); render(<NoticesPage />);
    expect(screen.getByText('Página 1 de 2 · 26 no total')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Próxima' }));
    expect(useCommunications).toHaveBeenLastCalledWith({ kind: 'ANNOUNCEMENT', page: 2 });
  });

  it('marca uma versão uma única vez e encaminha kind trocado sem retry inútil', () => {
    detail = { ...item, kind: 'DEMAND' }; const view = render(<NoticeDetailPage communicationId="n1" />); view.rerender(<NoticeDetailPage communicationId="n1" />);
    expect(mutate).toHaveBeenCalledOnce();
    expect(screen.getByText('Abrir demanda')).toHaveAttribute('data-to', '/demandas/$communicationId');
  });

  it('expõe retry manual quando a confirmação de leitura falha', async () => {
    mutate.mockRejectedValueOnce(new Error('500')).mockResolvedValueOnce(undefined); const user = userEvent.setup(); render(<NoticeDetailPage communicationId="n1" />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/confirmar a leitura/i);
    await user.click(screen.getByRole('button', { name: 'Tentar novamente' }));
    await waitFor(() => expect(mutate).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  });

  it('registra a leitura do VIEWER sem liberar escrita do comunicado', async () => {
    role = 'VIEWER'; render(<NoticeDetailPage communicationId="n1" />);
    await waitFor(() => expect(mutate).toHaveBeenCalledOnce());
    expect(screen.getByText(/marcação de leitura/i)).toBeInTheDocument();
  });

  it('inclui composer e histórico no detalhe do comunicado', () => {
    detail = { ...item, events: [{ id: 'e1', kind: 'COMMENTED', message: 'Recebido', author: null, createdAt: '2026-10-10T10:00:00Z' }] };
    render(<NoticeDetailPage communicationId="n1" />);
    expect(screen.getByLabelText('Adicionar comentário')).toBeInTheDocument();
    expect(screen.getByText('Recebido')).toBeInTheDocument();
  });
});
