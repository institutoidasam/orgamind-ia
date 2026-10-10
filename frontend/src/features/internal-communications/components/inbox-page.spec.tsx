import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommunicationDetail } from '../schemas';

vi.mock('@tanstack/react-router', () => ({ Link: ({ children, to, params }: { children: React.ReactNode; to: string; params?: { communicationId?: string } }) => <a data-to={to} data-id={params?.communicationId}>{children}</a> }));
const user = { role: 'OPERATOR', sectorId: 's1' };
vi.mock('@/stores/auth.store', () => ({ useAuthStore: (select: (s: { user: typeof user }) => unknown) => select({ user }) }));
const mutate = vi.fn(); const useInbox = vi.fn(); let items: CommunicationDetail[] = [];
vi.mock('../api', () => ({ useInbox: (filters: unknown) => { useInbox(filters); return { data: { items, page: 1, pageSize: 25, total: 51 }, isLoading: false, isError: false, refetch: vi.fn() }; }, useMarkCommunicationRead: () => ({ mutate, mutateAsync: mutate, isPending: false }) }));
import { InboxPage } from './inbox-page';

const item = (id: string, kind: CommunicationDetail['kind'] = 'DEMAND', ccSectors: CommunicationDetail['ccSectors'] = []): CommunicationDetail => ({ id, reference: `REF-${id}`, kind, subject: id, message: 'texto', originSector: { id: 'o', name: 'Origem', code: 'ORG' }, destinationSector: { id: 'd', name: 'Destino', code: 'DST' }, ccSectors, author: null, assignee: null, status: kind === 'DEMAND' ? 'OPEN' : null, priority: kind === 'DEMAND' ? 'NORMAL' : null, dueDate: null, version: 1, notifyTeam: true, notifyAssignee: false, createdAt: '2026-10-10T10:00:00Z', updatedAt: '2026-10-10T10:00:00Z', completedAt: null, isUnread: false, events: [] });
describe('InboxPage', () => {
  beforeEach(() => { mutate.mockReset(); mutate.mockResolvedValue(undefined); useInbox.mockClear(); });
  it('seleciona inline e abre comunicado pela rota correta', async () => { items = [item('d1'), item('c1', 'ANNOUNCEMENT')]; const u = userEvent.setup(); const view = render(<InboxPage />); await u.click(screen.getAllByRole('button', { name: /c1/i })[0]); expect(screen.getByRole('heading', { name: 'c1' })).toBeInTheDocument(); expect(view.container.querySelector('a[data-to="/comunicados/$communicationId"]')).toHaveAttribute('data-id', 'c1'); });
  it('filtra Meu setor também por ciência e remove seleção oculta', async () => { items = [item('a'), item('cc', 'DEMAND', [{ id: 's1', name: 'Meu' }])]; const u = userEvent.setup(); render(<InboxPage />); await u.click(screen.getAllByRole('button', { name: /^a\s/ })[0]); await u.click(screen.getByRole('button', { name: 'Meu setor' })); expect(screen.queryByRole('button', { name: /^a\s/ })).not.toBeInTheDocument(); expect(screen.getByRole('heading', { name: 'cc' })).toBeInTheDocument(); });
  it('marca a mesma versão não lida uma vez em rerender', () => { items = [{ ...item('u1'), isUnread: true }]; const view = render(<InboxPage />); view.rerender(<InboxPage />); expect(mutate).toHaveBeenCalledTimes(1); });
  it('não repete POST ao retornar a uma versão ainda defasada', async () => {
    items = [{ ...item('u1'), isUnread: true }, { ...item('u2'), isUnread: true }]; const u = userEvent.setup(); render(<InboxPage />);
    await u.click(screen.getByRole('button', { name: /u2/i }));
    await u.click(screen.getByRole('button', { name: /u1/i }));
    expect(mutate).toHaveBeenCalledTimes(2);
  });
  it('mostra falha de leitura da seleção atual e permite retry explícito', async () => {
    items = [{ ...item('u1'), isUnread: true }]; mutate.mockRejectedValueOnce(new Error('500')).mockResolvedValueOnce(undefined); const u = userEvent.setup(); render(<InboxPage />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/confirmar a leitura/i);
    await u.click(screen.getByRole('button', { name: 'Tentar novamente' }));
    await waitFor(() => expect(mutate).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  });
  it('pagina no servidor e volta à primeira página ao mudar filtro ou busca', async () => {
    items = [item('p1')]; const u = userEvent.setup(); render(<InboxPage />);
    expect(screen.getByText('Página 1 de 3 · 51 no total')).toBeInTheDocument();
    await u.click(screen.getByRole('button', { name: 'Próxima' }));
    expect(useInbox).toHaveBeenLastCalledWith(expect.objectContaining({ page: 2 }));
    await u.type(screen.getByPlaceholderText(/Buscar/), 'novo');
    expect(useInbox).toHaveBeenLastCalledWith(expect.objectContaining({ page: 1, q: 'novo' }));
  });
});
