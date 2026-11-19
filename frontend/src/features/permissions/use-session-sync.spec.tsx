import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, focusManager } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore, type AuthUser } from '@/stores/auth.store';
import { ME_QUERY_KEY, useSessionSync } from './use-session-sync';

const { getJson, listeners } = vi.hoisted(() => ({
  getJson: vi.fn(),
  listeners: new Set<() => void>(),
}));
vi.mock('@/lib/api-client', () => ({
  api: { get: (path: string) => ({ json: () => getJson(path) }) },
  onPermissionDenied: (cb: () => void) => {
    listeners.add(cb);
    return () => listeners.delete(cb);
  },
}));

const STORED: AuthUser = { id: 'u1', email: 'a@b.com', name: 'Ana', role: 'OPERATOR' };

function meResponse(permissions: string[], id = 'u1') {
  return { user: { ...STORED, id, permissions }, mustChangePassword: false };
}

function wrapper({ children }: { children: React.ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  getJson.mockReset();
  listeners.clear();
  useAuthStore.setState({ accessToken: 'tok', user: STORED, mustChangePassword: false });
});
afterEach(() => {
  vi.useRealTimers();
  focusManager.setFocused(undefined);
});

describe('useSessionSync releitura que falha', () => {
  it('consulta em erro (ex.: 401 sem refresh) não grava na store nem quebra a tela', async () => {
    getJson.mockRejectedValue(new Error('401'));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    renderHook(() => useSessionSync(), {
      wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
    });

    await waitFor(() => expect(client.getQueryState(ME_QUERY_KEY)?.status).toBe('error'));
    expect(useAuthStore.getState()).toMatchObject({ accessToken: 'tok', user: STORED });
  });
});

describe('useSessionSync', () => {
  it('ao montar lê auth/me e grava o usuário com permissions, mantendo o token', async () => {
    getJson.mockResolvedValue(meResponse(['pessoas.editar', 'chave.nova']));

    renderHook(() => useSessionSync(), { wrapper });

    await waitFor(() => expect(useAuthStore.getState().user?.permissions).toEqual(['pessoas.editar']));
    expect(getJson).toHaveBeenCalledWith('auth/me');
    expect(useAuthStore.getState().accessToken).toBe('tok');
  });

  it('403 auth.permission_denied refaz a leitura e aplica a lista nova', async () => {
    getJson.mockResolvedValueOnce(meResponse(['pessoas.editar']));
    renderHook(() => useSessionSync(), { wrapper });
    await waitFor(() => expect(getJson).toHaveBeenCalledTimes(1));
    getJson.mockResolvedValueOnce(meResponse(['trilha.consultar']));

    act(() => listeners.forEach((listener) => listener()));

    await waitFor(() => expect(useAuthStore.getState().user?.permissions).toEqual(['trilha.consultar']));
    expect(getJson).toHaveBeenCalledTimes(2);
  });

});

describe('useSessionSync releitura periódica', () => {
  it('ao voltar o foco à janela relê auth/me', async () => {
    getJson.mockResolvedValue(meResponse(['pessoas.editar']));
    renderHook(() => useSessionSync(), { wrapper });
    await waitFor(() => expect(getJson).toHaveBeenCalledTimes(1));

    act(() => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });

    await waitFor(() => expect(getJson).toHaveBeenCalledTimes(2));
  });

  it('relê auth/me a cada 5 minutos', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    getJson.mockResolvedValue(meResponse(['pessoas.editar']));
    renderHook(() => useSessionSync(), { wrapper });
    await waitFor(() => expect(getJson).toHaveBeenCalledTimes(1));

    await act(() => vi.advanceTimersByTimeAsync(5 * 60_000));

    expect(getJson).toHaveBeenCalledTimes(2);
  });

});

describe('useSessionSync sessão trocada', () => {
  it('não grava a leitura quando a sessão é de outro usuário ou já acabou', async () => {
    getJson.mockResolvedValue(meResponse(['pessoas.editar'], 'u1'));
    useAuthStore.setState({ user: { ...STORED, id: 'u2' } });

    renderHook(() => useSessionSync(), { wrapper });
    await waitFor(() => expect(getJson).toHaveBeenCalledTimes(1));
    await act(async () => undefined);

    expect(useAuthStore.getState().user).toEqual({ ...STORED, id: 'u2' });
  });
});
