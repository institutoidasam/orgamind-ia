import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import {
  createExceptionResponseSchema,
  scheduleBoardSchema,
  scheduleOptionsSchema,
  staffScheduleSchema,
  type BoardQuery,
  type CreateExceptionInput,
  type PutScheduleInput,
} from './schemas';

const BOARD_KEY = ['staff-schedule', 'board'] as const;

export function useScheduleOptions() {
  return useQuery({
    queryKey: ['staff-schedule', 'options'],
    queryFn: async () => scheduleOptionsSchema.parse(await api.get('internal/staff-schedule/options').json()),
    retry: false,
  });
}

/** `null` = ainda sem setor escolhido: não busca. */
export function useScheduleBoard(q: BoardQuery | null) {
  return useQuery({
    queryKey: [...BOARD_KEY, q],
    enabled: q !== null,
    retry: false,
    queryFn: async () =>
      scheduleBoardSchema.parse(await api.get('internal/staff-schedule/board', { searchParams: { ...q } }).json()),
  });
}

export function useCreateException() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ userId, body }: { userId: string; body: CreateExceptionInput }) =>
      createExceptionResponseSchema.parse(
        await api.post(`internal/staff-schedule/users/${userId}/exceptions`, { json: body }).json(),
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: BOARD_KEY }),
  });
}

export function useDeleteException() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (exceptionId: string) => {
      await api.delete(`internal/staff-schedule/exceptions/${exceptionId}`);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: BOARD_KEY }),
  });
}

export function usePutSchedule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ userId, body }: { userId: string; body: PutScheduleInput }) =>
      staffScheduleSchema.parse(await api.put(`internal/staff-schedule/users/${userId}/schedule`, { json: body }).json()),
    onSuccess: () => qc.invalidateQueries({ queryKey: BOARD_KEY }),
  });
}

export function useDeleteSchedule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (userId: string) => {
      await api.delete(`internal/staff-schedule/users/${userId}/schedule`);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: BOARD_KEY }),
  });
}
