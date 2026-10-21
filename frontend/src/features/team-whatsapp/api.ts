import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import {
  cancelDispatchResponseSchema,
  dispatchListSchema,
  dispatchResultSchema,
  scheduledListSchema,
  teamRosterSchema,
  teamTargetsSchema,
  type CreateDispatchInput,
  type DispatchList,
  type RosterQuery,
  type ScheduledList,
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

/** `null` = ainda sem setor, data e turno escolhidos: não busca. */
export function useTeamRoster(q: RosterQuery | null) {
  return useQuery({
    queryKey: ['team-whatsapp', 'roster', q?.sectorId, q?.date],
    enabled: q !== null,
    retry: false,
    queryFn: async () =>
      teamRosterSchema.parse(await api.get('internal/team-whatsapp/roster', { searchParams: { ...q } }).json()),
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
    onSuccess: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: ['team-whatsapp', 'dispatches'] }),
        qc.invalidateQueries({ queryKey: ['team-whatsapp', 'scheduled'] }),
      ]),
  });
}

const SCHEDULED_POLL_MS = 60_000;

/** Enquanto houver agendado, reconsulta a cada 60 s (o disparo tira a linha da lista). */
export function scheduledPollInterval(data: ScheduledList | undefined): number | false {
  return data && data.items.length > 0 ? SCHEDULED_POLL_MS : false;
}

export function useScheduledDispatches() {
  return useQuery({
    queryKey: ['team-whatsapp', 'scheduled'],
    queryFn: async () =>
      scheduledListSchema.parse(await api.get('internal/team-whatsapp/scheduled').json()),
    refetchInterval: (q) => scheduledPollInterval(q.state.data),
  });
}

export function useCancelDispatch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) =>
      cancelDispatchResponseSchema.parse(
        await api.post(`internal/team-whatsapp/dispatches/${id}/cancel`).json(),
      ),
    // Também no erro: no 409 not_cancellable a linha já saiu/foi cancelada e deve sumir sem esperar o poll.
    onSettled: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: ['team-whatsapp', 'scheduled'] }),
        qc.invalidateQueries({ queryKey: ['team-whatsapp', 'dispatches'] }),
      ]),
  });
}
