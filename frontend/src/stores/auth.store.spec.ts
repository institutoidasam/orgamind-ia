import { describe, it, expect, beforeEach } from 'vitest';
import { onSessionExpired, useAuthStore } from './auth.store';

describe('useAuthStore', () => {
  beforeEach(() => {
    useAuthStore.setState({ accessToken: null, user: null, mustChangePassword: false });
  });

  it('setSession stores mustChangePassword', () => {
    useAuthStore.getState().setSession({
      accessToken: 'tok',
      user: { id: 'u1', email: 'a@b.com', name: 'Alice', role: 'ADMIN' },
      mustChangePassword: true,
    });
    expect(useAuthStore.getState().mustChangePassword).toBe(true);
    expect(useAuthStore.getState().user?.name).toBe('Alice');
  });

  it('clearMustChangePassword zeroes the flag', () => {
    useAuthStore.setState({ mustChangePassword: true });
    useAuthStore.getState().clearMustChangePassword();
    expect(useAuthStore.getState().mustChangePassword).toBe(false);
  });

  it('logout clears mustChangePassword', () => {
    useAuthStore.setState({ mustChangePassword: true });
    useAuthStore.getState().logout();
    expect(useAuthStore.getState().mustChangePassword).toBe(false);
  });

  // Regressão: refresh falho chama forceLogout() fora de um fluxo de navegação;
  // sem um observador, a página autenticada fica montada exibindo "Falha HTTP 401"
  // em loop (visto na página Conectar em 2026-06-11).
  describe('onSessionExpired', () => {
    const session = {
      accessToken: 'tok',
      user: { id: 'u1', email: 'a@b.com', name: 'Alice', role: 'ADMIN' as const },
      mustChangePassword: false,
    };

    it('dispara o callback quando o accessToken some (logout forçado)', () => {
      useAuthStore.getState().setSession(session);
      let fired = 0;
      const unsub = onSessionExpired(() => {
        fired += 1;
      });
      useAuthStore.getState().logout();
      expect(fired).toBe(1);
      unsub();
    });

    it('não dispara em login, mudanças não relacionadas, ou após unsubscribe', () => {
      let fired = 0;
      const unsub = onSessionExpired(() => {
        fired += 1;
      });
      useAuthStore.getState().setSession(session); // ganhar sessão não dispara
      useAuthStore.getState().clearMustChangePassword(); // token permanece
      expect(fired).toBe(0);
      unsub();
      useAuthStore.getState().logout(); // após unsubscribe
      expect(fired).toBe(0);
    });
  });
});
