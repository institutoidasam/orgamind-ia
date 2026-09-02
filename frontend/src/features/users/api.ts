import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import { useAuthStore } from '@/stores/auth.store';
import { userListResponseSchema, type InviteUserOutput, type EditUserInput } from './schemas';

function invalidateUserList(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ predicate: (q) => q.queryKey[0] === 'users' });
}

/**
 * When an admin edits their OWN profile (only `name` is self-editable — the
 * backend forbids self role changes), the auth store still holds the stale
 * name until a full reload. Patch the cached identity so the topbar/menu update
 * immediately. The access token and the rest of the session are preserved.
 */
export function syncAuthStoreOnSelfEdit(id: string, data: EditUserInput) {
  const state = useAuthStore.getState();
  const current = state.user;
  if (!current || current.id !== id) return;
  if (data.name === undefined) return;
  if (!state.accessToken) return;
  state.setSession({
    accessToken: state.accessToken,
    user: { ...current, name: data.name },
    mustChangePassword: state.mustChangePassword,
  });
}

export function useUsers(page = 1, pageSize = 20) {
  return useQuery({
    queryKey: ['users', { page, pageSize }],
    queryFn: () =>
      api.get('users', { searchParams: { page, pageSize } }).json().then((d) =>
        userListResponseSchema.parse(d),
      ),
  });
}

export function useInviteUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: InviteUserOutput): Promise<{ user: unknown; temporaryPassword: string }> =>
      api.post('users', { json: input }).json(),
    onSuccess: () => invalidateUserList(qc),
  });
}

export function useUpdateUser() {
  const qc = useQueryClient();
  return useMutation({
    // The PATCH endpoint responds 204 No Content, so do NOT call .json():
    // JSON.parse('') on the empty body throws "Unexpected end of JSON input".
    // Same no-body pattern as useDeleteUser; onSuccess still refreshes the list.
    mutationFn: ({ id, data }: { id: string; data: EditUserInput }) =>
      api.patch(`users/${id}`, { json: data }),
    onSuccess: (_result, { id, data }) => {
      invalidateUserList(qc);
      syncAuthStoreOnSelfEdit(id, data);
    },
  });
}

export function useResetUserPassword() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string): Promise<{ temporaryPassword: string }> =>
      api.post(`users/${id}/reset-password`).json(),
    onSuccess: () => invalidateUserList(qc),
  });
}

export function useDeleteUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`users/${id}`),
    onSuccess: () => invalidateUserList(qc),
  });
}
