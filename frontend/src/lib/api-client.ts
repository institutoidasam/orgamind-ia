import ky from 'ky';
import { useAuthStore } from '@/stores/auth.store';
import { queryClient } from '@/lib/query-client';

const baseURL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';

/**
 * Hard logout used whenever the auth flow detects we can no longer authenticate
 * the user (failed refresh, missing access token after refresh, etc.). Clears
 * the persisted Zustand state AND any cached query data — without the cache
 * clear, an operator who logs in as a different account momentarily sees the
 * previous account's data while TanStack Query refetches.
 */
function forceLogout() {
  useAuthStore.getState().logout();
  queryClient.clear();
}

// Single in-flight refresh — concurrent 401s coalesce on the same promise so
// we never send more than one /auth/refresh per rotation.
let refreshPromise: Promise<boolean> | null = null;

async function tryRefresh(): Promise<boolean> {
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    try {
      const res = await fetch(`${baseURL}/auth/refresh`, {
        method: 'POST',
        credentials: 'include',
      });
      if (!res.ok) return false;
      const { accessToken } = (await res.json()) as { accessToken: string };
      const store = useAuthStore.getState();
      if (!store.user) return false;
      store.setSession({ accessToken, user: store.user, mustChangePassword: store.mustChangePassword });
      return true;
    } catch {
      return false;
    } finally {
      refreshPromise = null;
    }
  })();
  return refreshPromise;
}

export const api = ky.create({
  prefix: baseURL,
  timeout: 15_000,
  // needed so the browser sends/receives the refresh cookie on /auth/* calls
  credentials: 'include',
  hooks: {
    beforeRequest: [
      ({ request }) => {
        const token = useAuthStore.getState().accessToken;
        if (token) request.headers.set('Authorization', `Bearer ${token}`);
      },
    ],
    afterResponse: [
      async ({ request, options, response }) => {
        if (response.status !== 401) return response;
        // Don't recurse into refresh/login endpoints.
        const url = new URL(request.url);
        if (url.pathname.startsWith('/auth/')) return response;
        // Only attempt refresh if we had an access token to begin with.
        if (!useAuthStore.getState().accessToken) return response;

        const ok = await tryRefresh();
        if (!ok) {
          forceLogout();
          return response;
        }
        const newToken = useAuthStore.getState().accessToken;
        if (!newToken) {
          forceLogout();
          return response;
        }
        // Retry the original request once with the new access token.
        const retried = request.clone();
        retried.headers.set('Authorization', `Bearer ${newToken}`);
        return ky(retried, options);
      },
    ],
  },
});

/** Best-effort silent restore on app load (uses refresh cookie if present). */
export async function restoreSession(): Promise<void> {
  const store = useAuthStore.getState();
  if (store.accessToken || !store.user) return;
  const ok = await tryRefresh();
  // Persisted `user` without a working refresh cookie left the UI in a
  // confusing "logged in but every navigation kicks me back to /login"
  // limbo. Clear the stale state immediately so the login screen is the
  // one consistent next step.
  if (!ok) forceLogout();
}

/** Revoke the refresh family on the server and clear local state. */
export async function logoutRemote(): Promise<void> {
  try {
    await fetch(`${baseURL}/auth/logout`, {
      method: 'POST',
      credentials: 'include',
    });
  } catch {
    // ignore — local logout still proceeds
  }
  forceLogout();
}
