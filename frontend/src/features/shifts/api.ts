import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import { shiftAdminSchema, shiftListSchema, type CreateShiftInput, type UpdateShiftInput } from './schemas';

const SHIFTS_KEY = ['shifts'] as const;

export function useShifts() {
  return useQuery({
    queryKey: SHIFTS_KEY,
    queryFn: async () => shiftListSchema.parse(await api.get('internal/shifts').json()).items,
  });
}

function useShiftMutation<TVars>(request: (vars: TVars) => Promise<unknown>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: request,
    onSuccess: () => qc.invalidateQueries({ queryKey: SHIFTS_KEY }),
  });
}

export function useCreateShift() {
  return useShiftMutation(async (json: CreateShiftInput) =>
    shiftAdminSchema.parse(await api.post('internal/shifts', { json }).json()),
  );
}

export function useUpdateShift() {
  return useShiftMutation(async ({ id, ...json }: UpdateShiftInput & { id: string }) =>
    shiftAdminSchema.parse(await api.patch(`internal/shifts/${id}`, { json }).json()),
  );
}

/** `ids` = todos os turnos, na ordem desejada. */
export function useReorderShifts() {
  return useShiftMutation(async (ids: string[]) =>
    shiftListSchema.parse(await api.put('internal/shifts/order', { json: { ids } }).json()),
  );
}
