import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import type { MatrixDraft } from './matrix-diff';
import { permissionMatrixSchema, type PermissionMatrix } from './schemas';
import { ME_QUERY_KEY } from './use-session-sync';

const MATRIX_KEY = ['permissions', 'matrix'] as const;

/** ADMIN: a matriz de permissões por papel (`GET /permissions`). */
export function usePermissionMatrix() {
  return useQuery({
    queryKey: MATRIX_KEY,
    queryFn: async () => {
      const parsed = permissionMatrixSchema.safeParse(await api.get('permissions').json());
      if (!parsed.success) throw new Error('Não foi possível ler as permissões. Atualize a página.');
      return parsed.data;
    },
  });
}

/**
 * Depois de gravar, a matriz nova entra no cache e a sessão relê `/auth/me`
 * (DB14), para a lista de permissões da sessão seguir o que a API acabou de gravar.
 */
function useAfterMatrixSaved() {
  const queryClient = useQueryClient();
  return (matrix: PermissionMatrix) => {
    queryClient.setQueryData(MATRIX_KEY, matrix);
    void queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY });
  };
}

/** `PUT /permissions`: só SUPERVISOR e OPERATOR vão no corpo; ADMIN e VIEWER são fixos. */
export function useSavePermissionMatrix() {
  const afterSaved = useAfterMatrixSaved();
  return useMutation({
    mutationFn: async (draft: MatrixDraft) =>
      permissionMatrixSchema.parse(
        await api.put('permissions', { json: { roles: { SUPERVISOR: draft.SUPERVISOR, OPERATOR: draft.OPERATOR } } }).json(),
      ),
    onSuccess: afterSaved,
  });
}

/** `POST /permissions/restore-defaults`: volta SUPERVISOR e OPERATOR ao padrão. */
export function useRestorePermissionDefaults() {
  const afterSaved = useAfterMatrixSaved();
  return useMutation({
    mutationFn: async () =>
      permissionMatrixSchema.parse(await api.post('permissions/restore-defaults').json()),
    onSuccess: afterSaved,
  });
}
