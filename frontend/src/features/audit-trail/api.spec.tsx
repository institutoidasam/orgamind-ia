import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { usePersonHistory } from './api';

const { get } = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ api: { get } }));

function Probe() {
  const history = usePersonHistory('user-2', 3);
  if (history.isError) return <p>erro</p>;
  return <p>{history.data ? `${history.data.items.length} de ${history.data.total}` : 'carregando'}</p>;
}

beforeEach(() => {
  vi.clearAllMocks();
  get.mockReturnValue({
    json: () => Promise.resolve({ items: [], total: 41, page: 3, pageSize: 20 }),
  });
});

describe('API da trilha: histórico da pessoa', () => {
  it('pede a página da pessoa em audit-trail/people/:id e valida a resposta', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><Probe /></QueryClientProvider>);
    expect(await screen.findByText('0 de 41')).toBeInTheDocument();
    expect(get).toHaveBeenCalledWith('audit-trail/people/user-2', { searchParams: { page: 3, pageSize: 20 } });
  });
});
