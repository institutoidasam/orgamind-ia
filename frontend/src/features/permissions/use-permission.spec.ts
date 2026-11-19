import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useAuthStore, type AuthUser } from '@/stores/auth.store';
import { usePermission, usePermissions } from './use-permission';

const OPERATOR: AuthUser = { id: 'u1', email: 'a@b.com', name: 'Ana', role: 'OPERATOR' };

beforeEach(() => {
  useAuthStore.setState({ accessToken: 'tok', user: OPERATOR, mustChangePassword: false });
});

describe('usePermission', () => {
  it('lê da sessão e acompanha a troca de permissões sem novo login', () => {
    const { result } = renderHook(() => ({
      alterar: usePermission('escala.alterar'),
      todas: usePermissions(),
    }));
    expect(result.current.alterar).toBe(true);

    act(() => useAuthStore.getState().setUser({ ...OPERATOR, permissions: ['trilha.consultar'] }));

    expect(result.current.alterar).toBe(false);
    expect(result.current.todas).toEqual(['trilha.consultar']);
    expect(useAuthStore.getState().accessToken).toBe('tok');
  });

  it('sem sessão nega tudo', () => {
    useAuthStore.setState({ user: null });

    const { result } = renderHook(() => usePermission('pessoas.editar'));

    expect(result.current).toBe(false);
  });
});
