import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const get = vi.fn();
const post = vi.fn();
vi.mock('@/lib/api-client', () => ({ api: { get: (...a: unknown[]) => get(...a), post: (...a: unknown[]) => post(...a) } }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/features/whatsapp/api', () => ({
  useInstances: () => ({ data: [] }),
  CHANNEL_PROVIDERS: ['EVOLUTION', 'TWILIO', 'ZERNIO', 'META', 'GOZAP'],
}));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }));

import { useAuthStore, type AuthUser } from '@/stores/auth.store';
import { ConversationActions } from './conversation-actions';
import { ConversationsList } from './conversations-list';
import type { ConversationSummary } from '../schemas';
import { HANDOVER_CONVS, handoverConv, json, routeGet } from './shift-handover.test-fixtures';

// Radix Select (shadcn) usa PointerEvents/scrollIntoView, que o jsdom não tem.
if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false;
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};

const PASS_OF_A = 'Passar as conversas de Atendente A';

function loginAs(id: string, role: AuthUser['role']) {
  useAuthStore.setState({ user: { id, email: 'a@x.com', name: 'Eu', role } });
}

function renderWithQuery(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

const passButton = () => screen.queryByRole('button', { name: /^Passar as conversas de/ });

beforeEach(() => {
  get.mockReset().mockImplementation(routeGet(HANDOVER_CONVS));
  post.mockReset().mockReturnValue(json({ transferred: [{ id: 'c1' }, { id: 'c2' }], skipped: [] }));
  localStorage.clear();
});

describe('ConversationActions — Passar as conversas de {nome}', () => {
  it('aceite 26: ADMIN vê Passar as conversas de {nome} em conversa de outro; OPERATOR não', () => {
    loginAs('a1', 'ADMIN');
    const other = renderWithQuery(<ConversationActions conv={handoverConv('c9', 'Cliente')} />);
    expect(passButton()).toHaveTextContent(PASS_OF_A);
    other.unmount();

    const mine = renderWithQuery(<ConversationActions conv={handoverConv('c9', 'Cliente', { assignedUserId: 'a1' })} />);
    expect(passButton()).toBeNull();
    mine.unmount();

    const free = renderWithQuery(<ConversationActions conv={handoverConv('c9', 'Cliente', { assignedUserId: null, status: 'PENDING' })} />);
    expect(passButton()).toBeNull();
    free.unmount();

    loginAs('u2', 'OPERATOR');
    renderWithQuery(<ConversationActions conv={handoverConv('c9', 'Cliente')} />);
    expect(passButton()).toBeNull();
  });

  it('aceite 26: ADMIN passa as conversas do atendente — lista dele, destinos sem ele, fromUserId no corpo', async () => {
    loginAs('a1', 'ADMIN');
    const user = userEvent.setup();
    const conv: ConversationSummary = handoverConv('c9', 'Cliente');
    renderWithQuery(<ConversationActions conv={conv} />);
    await user.click(screen.getByRole('button', { name: PASS_OF_A }));
    expect(await screen.findByRole('dialog', { name: PASS_OF_A })).toBeInTheDocument();
    await screen.findByRole('checkbox', { name: 'Maria' });
    expect(get).toHaveBeenCalledWith('chat/conversations?status=open&assignee=u1&pageSize=100');
    await user.click(screen.getByRole('combobox', { name: 'Passar para' }));
    const options = await screen.findAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual(['Pessoa B', 'Pessoa C']);
    await user.click(options[0]);
    fireEvent.change(screen.getByLabelText('Observação'), { target: { value: 'atendente de folga' } });
    await user.click(screen.getByRole('button', { name: 'Confirmar' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('chat/handover', {
      json: { toUserId: 'u2', note: 'atendente de folga', conversationIds: ['c1', 'c2'], fromUserId: 'u1' },
    }));
  });
});

describe('ConversationsList — Passar meu turno', () => {
  it('Passar meu turno no topo da lista', async () => {
    loginAs('u1', 'OPERATOR');
    const user = userEvent.setup();
    renderWithQuery(<ConversationsList />);
    const button = await screen.findByRole('button', { name: 'Passar meu turno' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(get).not.toHaveBeenCalledWith(expect.stringContaining('assignee=u1&pageSize=100'));
    await user.click(button);
    expect(await screen.findByRole('dialog', { name: 'Passar meu turno' })).toBeInTheDocument();
    await waitFor(() => expect(get).toHaveBeenCalledWith('chat/conversations?status=open&assignee=u1&pageSize=100'));
    await user.click(screen.getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});
