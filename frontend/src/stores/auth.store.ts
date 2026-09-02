import { create } from 'zustand';
import { persist } from 'zustand/middleware';

type User = { id: string; email: string; name: string | null; role: 'ADMIN' | 'OPERATOR' };

type AuthState = {
  accessToken: string | null;
  user: User | null;
  mustChangePassword: boolean;
  setSession: (s: { accessToken: string; user: User; mustChangePassword: boolean }) => void;
  clearMustChangePassword: () => void;
  logout: () => void;
};

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      accessToken: null,
      user: null,
      mustChangePassword: false,
      setSession: (s) =>
        set({
          accessToken: s.accessToken,
          user: s.user,
          mustChangePassword: s.mustChangePassword,
        }),
      clearMustChangePassword: () => set({ mustChangePassword: false }),
      logout: () => set({ accessToken: null, user: null, mustChangePassword: false }),
    }),
    {
      name: 'picoa-auth',
      // CRITICAL: do not persist accessToken (XSS risk). Only user identity + flag.
      partialize: (state) => ({ user: state.user, mustChangePassword: state.mustChangePassword }),
    },
  ),
);

/**
 * Fire `cb` when an authenticated session is lost OUTSIDE an explicit
 * navigation flow — e.g. the api-client's forceLogout() after a failed
 * /auth/refresh. The route guard (beforeLoad) only runs on navigation, so
 * without an observer the current page stays mounted and every query dies
 * with a raw 401. Returns the unsubscribe function.
 */
export function onSessionExpired(cb: () => void): () => void {
  return useAuthStore.subscribe((state, prev) => {
    if (prev.accessToken && !state.accessToken) cb();
  });
}
