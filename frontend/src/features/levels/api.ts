import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import { levelAdminSchema, levelListSchema, type CreateLevelInput, type UpdateLevelInput } from './schemas';

const LEVELS_KEY = ['levels'] as const;

export function useLevels() {
  return useQuery({
    queryKey: LEVELS_KEY,
    queryFn: async () => levelListSchema.parse(await api.get('internal/levels').json()).items,
  });
}

function useLevelMutation<TVars>(request: (vars: TVars) => Promise<unknown>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: request,
    onSuccess: () => qc.invalidateQueries({ queryKey: LEVELS_KEY }),
  });
}

export function useCreateLevel() {
  return useLevelMutation(async (json: CreateLevelInput) =>
    levelAdminSchema.parse(await api.post('internal/levels', { json }).json()),
  );
}

export function useUpdateLevel() {
  return useLevelMutation(async ({ id, ...json }: UpdateLevelInput & { id: string }) =>
    levelAdminSchema.parse(await api.patch(`internal/levels/${id}`, { json }).json()),
  );
}

/** `ids` = todos os níveis, na ordem desejada. */
export function useReorderLevels() {
  return useLevelMutation(async (ids: string[]) =>
    levelListSchema.parse(await api.put('internal/levels/order', { json: { ids } }).json()),
  );
}
