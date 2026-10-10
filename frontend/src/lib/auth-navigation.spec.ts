import { describe, expect, it } from 'vitest';
import { authenticationDestination } from './auth-navigation';

describe('authenticationDestination', () => {
  it('preserva o destino original quando não há sessão', () => {
    expect(authenticationDestination(null, false, { pathname: '/demandas', searchStr: '?status=open' })).toEqual({
      to: '/login',
      search: { redirect: '/demandas?status=open' },
    });
  });

  it('mantém o reset obrigatório antes do shell autenticado', () => {
    expect(authenticationDestination('session', true, { pathname: '/dashboard', searchStr: '' })).toEqual({ to: '/change-password' });
    expect(authenticationDestination('session', true, { pathname: '/change-password', searchStr: '' })).toBeNull();
  });
});
