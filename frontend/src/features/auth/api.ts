import { useMutation } from '@tanstack/react-query';
import { api, logoutRemote } from '@/lib/api-client';
import { useAuthStore } from '@/stores/auth.store';
import { loginResponseSchema, type LoginInput, type LoginResponse } from './schemas';

export function useLogin() {
  const setSession = useAuthStore((s) => s.setSession);
  return useMutation({
    mutationFn: async (input: LoginInput): Promise<LoginResponse> => {
      // Validate the auth response at the trust boundary instead of blindly
      // casting it: a malformed body should fail loudly here, never seed the
      // session with a bad token/role.
      const raw = await api.post('auth/login', { json: input }).json();
      return loginResponseSchema.parse(raw);
    },
    onSuccess: (data) =>
      setSession({
        accessToken: data.accessToken,
        user: data.user,
        mustChangePassword: data.mustChangePassword,
      }),
  });
}

export function useChangePassword() {
  return useMutation({
    mutationFn: async (input: { currentPassword: string; newPassword: string }) => {
      await api.post('auth/change-password', { json: input });
    },
    onSuccess: () => logoutRemote(),
  });
}
