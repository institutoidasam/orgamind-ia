import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import type { ConversationSummary } from '../schemas';

type ListParams = { filter: string; search: string; status: string; instanceId?: string; assignee?: string };
const listCalls: ListParams[] = [];
let listItems: ConversationSummary[] = [];
vi.mock('../api', () => ({
  useConversationList: (params: ListParams) => {
    listCalls.push(params);
    return {
      data: { items: listItems, total: listItems.length },
      isLoading: false, isError: false, error: null, refetch: vi.fn(),
      fetchNextPage: vi.fn(), hasNextPage: false, isFetchingNextPage: false,
    };
  },
}));
vi.mock('@/features/whatsapp/api', () => ({
  useInstances: () => ({ data: [] }),
  CHANNEL_PROVIDERS: ['EVOLUTION', 'TWILIO', 'ZERNIO', 'META', 'GOZAP'],
}));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }));
vi.mock('@/stores/auth.store', () => ({ useAuthStore: (sel: (s: unknown) => unknown) => sel({ user: { id: 'u1' } }) }));

import { ConversationsList } from './conversations-list';

function mk(id: string, extra: Partial<ConversationSummary> = {}): ConversationSummary {
  return {
    id, instanceId: 'i1', instanceName: 'Número A', remoteJid: `${id}@s.whatsapp.net`,
    phoneE164: null, contactId: null, displayName: id, waName: null, profilePicUrl: null,
    lastMessageAt: null, lastMessagePreview: null, lastMessageDirection: null, unreadCount: 0,
    ...extra,
  };
}
const lastCall = () => listCalls[listCalls.length - 1];

beforeEach(() => {
  listCalls.length = 0;
  listItems = [];
  localStorage.clear();
});

describe('ConversationsList K1: Abertas / Resolvidas', () => {
  it('aceite 1: consulta com status open por padrão', () => {
    render(<ConversationsList />);
    expect(screen.getByRole('button', { name: 'Abertas' })).toHaveAttribute('aria-pressed', 'true');
    expect(lastCall()).toMatchObject({ filter: 'all', search: '', status: 'open' });
    expect(screen.getByRole('button', { name: 'Minhas' })).toBeInTheDocument();
  });

  it('aceite 1: Resolvidas — consulta com status resolved, sem assignee, abas de atendente somem', () => {
    render(<ConversationsList />);
    fireEvent.click(screen.getByRole('button', { name: 'Minhas' }));
    expect(lastCall().assignee).toBe('me');
    fireEvent.click(screen.getByRole('button', { name: 'Resolvidas' }));
    expect(lastCall().status).toBe('resolved');
    expect(lastCall().assignee).toBeUndefined();
    expect(screen.queryByRole('button', { name: 'Minhas' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Não atribuídas' })).toBeNull();
  });

  it('voltar a Abertas — abas voltam com a escolha salva', () => {
    render(<ConversationsList />);
    fireEvent.click(screen.getByRole('button', { name: 'Não atribuídas' }));
    fireEvent.click(screen.getByRole('button', { name: 'Resolvidas' }));
    fireEvent.click(screen.getByRole('button', { name: 'Abertas' }));
    expect(screen.getByRole('button', { name: 'Não atribuídas' })).toBeInTheDocument();
    expect(lastCall()).toMatchObject({ status: 'open', assignee: 'unassigned' });
  });
});

describe('ConversationsList K1: filtros combinam e situação na linha', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('Não lidas e busca combinam com Resolvidas', () => {
    render(<ConversationsList />);
    fireEvent.click(screen.getByRole('button', { name: 'Resolvidas' }));
    fireEvent.click(screen.getByRole('button', { name: 'Não lidas' }));
    fireEvent.change(screen.getByPlaceholderText('Buscar conversa…'), { target: { value: 'ana' } });
    act(() => { vi.advanceTimersByTime(350); });
    expect(lastCall()).toMatchObject({ filter: 'unread', search: 'ana', status: 'resolved' });
  });

  it('aceite 1: cada linha mostra a situação', () => {
    listItems = [
      mk('c1', { status: 'PENDING' }),
      mk('c2', { status: 'IN_PROGRESS', assignedUserId: 'u2', assignedUserName: 'Atendente A' }),
      mk('c3', { status: 'RESOLVED', resolvedAt: '2026-11-20T12:00:00.000Z' }),
    ];
    render(<ConversationsList />);
    const badges = screen.getAllByTestId('situation-badge').map((b) => b.textContent);
    expect(badges).toEqual(['Pendente', 'Em atendimento', 'Resolvida']);
  });
});
