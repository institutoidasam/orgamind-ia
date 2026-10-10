import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canReadInternalUnread, useInternalUnreadCount } from './internal-unread';

const { get } = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock('@/lib/api-client', () => ({ api: { get } }));

function wrapper({ children }: { children: React.ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

afterEach(() => vi.resetAllMocks());

describe('useInternalUnreadCount', () => {
  it.each(['ADMIN', 'SUPERVISOR', 'OPERATOR', 'VIEWER'])('consulta a contagem interna para %s no próprio escopo', async (role) => {
    get.mockReturnValue({ json: () => Promise.resolve({ count: 3 }) });
    const { result } = renderHook(() => useInternalUnreadCount({ role, userKey: 'user-1' }), { wrapper });

    await waitFor(() => expect(result.current.data).toEqual({ count: 3 }));

    expect(get).toHaveBeenCalledWith('internal/unread-count');
  });

  it('não consulta sem usuário autenticado ou para papel desconhecido', () => {
    const missingUser = renderHook(() => useInternalUnreadCount(), { wrapper });
    const unknownRole = renderHook(() => useInternalUnreadCount({ role: 'UNKNOWN', userKey: 'user-1' }), { wrapper });

    expect(canReadInternalUnread()).toBe(false);
    expect(canReadInternalUnread({ role: 'UNKNOWN', userKey: 'user-1' })).toBe(false);
    expect(missingUser.result.current.fetchStatus).toBe('idle');
    expect(unknownRole.result.current.fetchStatus).toBe('idle');
    expect(get).not.toHaveBeenCalled();
  });

  it('expõe erro de leitura sem inventar badge', async () => {
    get.mockReturnValue({ json: () => Promise.reject(new Error('network failed')) });
    const { result } = renderHook(() => useInternalUnreadCount({ role: 'VIEWER', userKey: 'user-1' }), { wrapper });

    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(result.current.data).toBeUndefined();
  });
});
