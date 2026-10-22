import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const http = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ api: http }));

import { useCreateLevel, useLevels, useReorderLevels, useUpdateLevel } from './api';

const level = { id: 'lvl_1', name: 'Líder', isActive: true, sortOrder: 1, userCount: 3 };

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function respond(fn: typeof http.get, body: unknown) {
  fn.mockReturnValue({ json: () => Promise.resolve(body) });
}

beforeEach(() => vi.clearAllMocks());

describe('levels api', () => {
  it('useLevels lê os itens de internal/levels', async () => {
    respond(http.get, { items: [level] });
    const { result } = renderHook(() => useLevels(), { wrapper });
    await waitFor(() => expect(result.current.data).toEqual([level]));
    expect(http.get).toHaveBeenCalledWith('internal/levels');
  });

  it('useCreateLevel faz POST do nome', async () => {
    respond(http.post, level);
    const { result } = renderHook(() => useCreateLevel(), { wrapper });
    await result.current.mutateAsync({ name: 'Líder' });
    expect(http.post).toHaveBeenCalledWith('internal/levels', { json: { name: 'Líder' } });
  });

  it('useUpdateLevel faz PATCH no id sem mandar o id no corpo', async () => {
    respond(http.patch, level);
    const { result } = renderHook(() => useUpdateLevel(), { wrapper });
    await result.current.mutateAsync({ id: 'lvl_1', isActive: false });
    expect(http.patch).toHaveBeenCalledWith('internal/levels/lvl_1', { json: { isActive: false } });
  });

  it('useReorderLevels faz PUT da ordem em internal/levels/order', async () => {
    respond(http.put, { items: [level] });
    const { result } = renderHook(() => useReorderLevels(), { wrapper });
    await result.current.mutateAsync(['lvl_1']);
    expect(http.put).toHaveBeenCalledWith('internal/levels/order', { json: { ids: ['lvl_1'] } });
  });
});
