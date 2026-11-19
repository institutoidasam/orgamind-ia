import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { useLevels } from "@/features/levels/api";
import { api } from "@/lib/api-client";
import { useAuthStore } from "@/stores/auth.store";
import type { CreateUserPayload } from "./invite-payload";
import {
  userListResponseSchema,
  type EditUserInput,
  type UserSummary,
} from "./schemas";
import type { UserRole } from "./role";

function invalidateUserList(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ predicate: (q) => q.queryKey[0] === "users" });
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

export type UsersFilters = {
  hasAccess?: boolean;
  q?: string;
  status?: "active" | "inactive" | "all";
  authorization?: "UNVERIFIED" | "NOT_AUTHORIZED";
};

/** Só o que foi informado vai na query; `hasAccess` segue só como `hasAccess=true`. */
function usersFilterParams(filters?: UsersFilters) {
  const q = filters?.q?.trim();
  return {
    ...(filters?.hasAccess ? { hasAccess: true } : {}),
    ...(q ? { q } : {}),
    ...(filters?.status ? { status: filters.status } : {}),
    ...(filters?.authorization ? { authorization: filters.authorization } : {}),
  };
}

/** `filters` vira parâmetros de busca do servidor; sem filtro, lista todos. */
export function useUsers(page = 1, pageSize = 20, filters?: UsersFilters) {
  const params = { page, pageSize, ...usersFilterParams(filters) };
  return useQuery({
    queryKey: ["users", params],
    queryFn: () =>
      api
        .get("users", { searchParams: params })
        .json()
        .then((d) => userListResponseSchema.parse(d)),
  });
}

/** Níveis ativos (cadastro novo). `GET /internal/levels` é só do ADMIN, como a tela de Usuários. */
export function useActiveLevels() {
  const { data, ...rest } = useLevels();
  const active = useMemo(() => data?.filter((level) => level.isActive), [data]);
  return { ...rest, data: active };
}

/** Administrative selectors must not silently lose users after the first page. */
export function useAllUsers() {
  return useQuery({
    queryKey: ["users", "all"],
    queryFn: async () => {
      const first = userListResponseSchema.parse(
        await api
          .get("users", { searchParams: { page: 1, pageSize: 100 } })
          .json(),
      );
      const pages = Math.ceil(first.total / first.pageSize);
      if (pages <= 1) return first.data;
      const rest = await Promise.all(
        Array.from({ length: pages - 1 }, (_, index) =>
          api
            .get("users", { searchParams: { page: index + 2, pageSize: 100 } })
            .json()
            .then((data) => userListResponseSchema.parse(data)),
        ),
      );
      return [...first.data, ...rest.flatMap((page) => page.data)];
    },
  });
}

export function useInviteUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (
      input: CreateUserPayload,
    ): Promise<{ user: unknown; temporaryPassword: string | null }> =>
      api.post("users", { json: input }).json(),
    onSuccess: () => invalidateUserList(qc),
  });
}

/** Dar acesso a uma pessoa sem acesso: devolve a senha temporária (só existe nesta resposta). */
export function useGrantAccess() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      ...json
    }: {
      id: string;
      email: string;
      role: UserRole;
    }): Promise<{ user: UserSummary; temporaryPassword: string }> =>
      api.post(`users/${id}/access`, { json }).json(),
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

/** Inativar ou reativar pela lista (D6): `PATCH users/:id` com motivo; 204 sem corpo. */
export function useSetUserStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, isActive, reason }: { id: string; isActive: boolean; reason: string }) =>
      api.patch(`users/${id}`, { json: { isActive, reason } }),
    onSuccess: () => invalidateUserList(qc),
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

/** Só sem histórico: com histórico a API responde 409 `user.has_history` (mensagem em error-messages.ts). */
export function useDeleteUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`users/${id}`),
    onSuccess: () => invalidateUserList(qc),
  });
}
