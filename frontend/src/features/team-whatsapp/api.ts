import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import {
  dispatchListSchema,
  dispatchResultSchema,
  teamTargetsSchema,
  type CreateDispatchInput,
  type DispatchList,
} from './schemas';

export type { SendTarget } from './schemas';

/** Depois disso, um envio ainda `QUEUED` deixa de ser consultado (evita polling infinito). */
export const POLL_WINDOW_MS = 60 * 60_000;
const POLL_INTERVAL_MS = 10_000;

export function useTeamTargets() {
  return useQuery({
    queryKey: ['team-whatsapp', 'targets'],
    queryFn: async () =>
      teamTargetsSchema.parse(await api.get('internal/team-whatsapp/targets').json()),
    retry: false,
  });
}

export function dispatchPollInterval(data: DispatchList | undefined): number | false {
  const pending = data?.items.some(
    (i) => i.counts.queued > 0 && Date.now() - Date.parse(i.createdAt) < POLL_WINDOW_MS,
  );
  return pending ? POLL_INTERVAL_MS : false;
}

export function useTeamDispatches() {
  return useQuery({
    queryKey: ['team-whatsapp', 'dispatches'],
    queryFn: async () =>
      dispatchListSchema.parse(await api.get('internal/team-whatsapp/dispatches').json()),
    refetchInterval: (q) => dispatchPollInterval(q.state.data),
  });
}

export function useCreateTeamDispatch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (json: CreateDispatchInput) =>
      dispatchResultSchema.parse(
        await api.post('internal/team-whatsapp/dispatches', { json }).json(),
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['team-whatsapp', 'dispatches'] }),
  });
}
