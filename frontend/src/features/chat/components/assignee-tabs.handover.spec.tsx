import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const get = vi.fn();
vi.mock('@/lib/api-client', () => ({ api: { get: (...a: unknown[]) => get(...a) } }));
vi.mock('@/features/whatsapp/api', () => ({
  useInstances: () => ({ data: [] }),
  CHANNEL_PROVIDERS: ['EVOLUTION'],
}));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }));
vi.mock('@/stores/auth.store', () => ({
  useAuthStore: (sel: (s: unknown) => unknown) => sel({ user: { id: 'u1' } }),
}));

import { ConversationsList } from './conversations-list';

const STORAGE_KEY = 'picoa-inbox-assignee:u1';
const TAB = 'Recebidas na passagem de turno';
const emptyPage = { items: [], total: 0, page: 1, pageSize: 30 };

function renderList() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ConversationsList />
    </QueryClientProvider>,
  );
}

function lastQuery(): URLSearchParams {
  const url = get.mock.calls[get.mock.calls.length - 1][0] as string;
  return new URLSearchParams(url.split('?')[1]);
}

beforeEach(() => {
  get.mockReset();
  get.mockReturnValue({ json: () => Promise.resolve(emptyPage) });
  localStorage.clear();
});

describe('aba Recebidas na passagem de turno (K3-3)', () => {
  it('aceite 27: a aba existe em Abertas e some em Resolvidas', async () => {
    renderList();
    expect(screen.getByRole('button', { name: TAB })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Resolvidas' }));
    expect(screen.queryByRole('button', { name: TAB })).toBeNull();
    await waitFor(() => expect(lastQuery().get('status')).toBe('resolved'));
    expect(lastQuery().has('handover')).toBe(false);
    expect(lastQuery().has('assignee')).toBe(false);
  });

  it('escolher a aba consulta com handover=true; o valor salvo volta ao recarregar', async () => {
    const first = renderList();
    fireEvent.click(screen.getByRole('button', { name: TAB }));
    await waitFor(() => expect(lastQuery().get('handover')).toBe('true'));
    expect(lastQuery().get('assignee')).toBe('me');
    expect(localStorage.getItem(STORAGE_KEY)).toBe('handover');
    first.unmount();
    get.mockClear();

    renderList();
    await waitFor(() => expect(get).toHaveBeenCalled());
    expect(lastQuery().get('handover')).toBe('true');
    expect(lastQuery().get('assignee')).toBe('me');
  });

  it('valor salvo inválido cai em Todas, sem assignee nem handover', async () => {
    localStorage.setItem(STORAGE_KEY, 'tudo-menos-valido');
    renderList();
    await waitFor(() => expect(get).toHaveBeenCalled());
    expect(lastQuery().has('assignee')).toBe(false);
    expect(lastQuery().has('handover')).toBe(false);
    expect(localStorage.getItem(STORAGE_KEY)).toBe('');
  });
});
