import { keepPreviousData, useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import {
  cancelDispatchResponseSchema,
  dispatchDetailSchema,
  dispatchListSchema,
  dispatchRecipientPageSchema,
  dispatchResultSchema,
  retryResultSchema,
  scheduledListSchema,
  teamPersonRouteSchema,
  teamRosterSchema,
  teamTargetsSchema,
  type CreateDispatchInput,
  type DispatchCounts,
  type DispatchDetail,
  type DispatchList,
  type RecipientStatus,
  type RetryInput,
  type ScheduledList,
} from './schemas';

export type { SendTarget } from './schemas';

/** Depois disso, um envio ainda `QUEUED` deixa de ser consultado (evita polling infinito). */
export const POLL_WINDOW_MS = 60 * 60_000;
const POLL_INTERVAL_MS = 10_000;

/** Itens por página do histórico e dos agendados (o servidor aceita 1..50). */
export const PAGE_SIZE = 20;

export function useTeamTargets() {
  return useQuery({
    queryKey: ['team-whatsapp', 'targets'],
    queryFn: async () =>
      teamTargetsSchema.parse(await api.get('internal/team-whatsapp/targets').json()),
    retry: false,
  });
}

/** Sem setor ou sem data: não busca. Os ids vão numa lista separada por vírgula. */
export function useTeamRoster(sectorIds: readonly string[], date: string) {
  const ids = sectorIds.join(',');
  return useQuery({
    queryKey: ['team-whatsapp', 'roster', ids, date],
    enabled: ids !== '' && date !== '',
    retry: false,
    queryFn: async () =>
      teamRosterSchema.parse(
        await api.get('internal/team-whatsapp/roster', { searchParams: { sectorIds: ids, date } }).json(),
      ),
  });
}

/** Número da pessoa hoje (alvo pessoa). `userId` vazio não busca. */
export function useTeamPersonRoute(userId: string) {
  return useQuery({
    queryKey: ['team-whatsapp', 'person-route', userId],
    enabled: userId !== '',
    retry: false,
    queryFn: async () =>
      teamPersonRouteSchema.parse(
        await api.get('internal/team-whatsapp/person-route', { searchParams: { userId } }).json(),
      ),
  });
}

type Trackable = { counts: DispatchCounts; createdAt: string; firedAt: string | null };

/**
 * Ainda há alguém `QUEUED` e a janela de consulta está aberta. A janela conta do mais recente entre o
 * disparo (`firedAt`, ou a criação no envio imediato) e o último Repetir bem-sucedido (`retriedAt`).
 */
function isInFlight({ counts, createdAt, firedAt }: Trackable, retriedAt = 0): boolean {
  const start = Math.max(Date.parse(firedAt ?? createdAt), retriedAt);
  return counts.queued > 0 && Date.now() - start < POLL_WINDOW_MS;
}

export function dispatchPollInterval(data: DispatchList | undefined): number | false {
  return data?.items.some((item) => isInFlight(item)) ? POLL_INTERVAL_MS : false;
}

/** Como `dispatchPollInterval`, para o detalhe de um envio; `retriedAt` = instante do último Repetir (ms). */
export function detailPollInterval(data: DispatchDetail | undefined, retriedAt?: number): number | false {
  return data && isInFlight(data, retriedAt) ? POLL_INTERVAL_MS : false;
}

/** Uma página do histórico (a invalidação por `['team-whatsapp', 'dispatches']` pega todas). */
export function useTeamDispatches(page: number) {
  return useQuery({
    queryKey: ['team-whatsapp', 'dispatches', page],
    queryFn: async () =>
      dispatchListSchema.parse(
        await api.get('internal/team-whatsapp/dispatches', { searchParams: { page, pageSize: PAGE_SIZE } }).json(),
      ),
    placeholderData: keepPreviousData,
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

export function useScheduledDispatches(page: number) {
  return useQuery({
    queryKey: ['team-whatsapp', 'scheduled', page],
    queryFn: async () =>
      scheduledListSchema.parse(
        await api.get('internal/team-whatsapp/scheduled', { searchParams: { page, pageSize: PAGE_SIZE } }).json(),
      ),
    placeholderData: keepPreviousData,
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

const dispatchKey = (id: string) => ['team-whatsapp', 'dispatch', id] as const;
/** Instante (ms) do último Repetir bem-sucedido do envio; só serve para reabrir a janela do poll. */
const retriedAtKey = (id: string) => [...dispatchKey(id), 'retriedAt'] as const;

/** Poll do detalhe em cache (e dos destinatários, que o acompanham), com a janela reaberta pelo Repetir. */
function resultPollInterval(qc: QueryClient, id: string, detail: DispatchDetail | undefined): number | false {
  return detailPollInterval(detail, qc.getQueryData<number>(retriedAtKey(id)));
}

/** Destinatários por página na tela de resultado (o servidor aceita 1..100). */
export const RECIPIENT_PAGE_SIZE = 50;

/** Detalhe de um envio (C5): contagens, números e quem ficou de fora. 404 = não existe ou não é seu. */
export function useTeamDispatch(id: string) {
  const qc = useQueryClient();
  return useQuery({
    queryKey: dispatchKey(id),
    retry: false,
    queryFn: async () =>
      dispatchDetailSchema.parse(await api.get(`internal/team-whatsapp/dispatches/${id}`).json()),
    refetchInterval: (q) => resultPollInterval(qc, id, q.state.data),
  });
}

/** Uma página dos destinatários, com filtro de situação opcional; acompanha o poll do detalhe. */
export function useDispatchRecipients(id: string, { status, page }: { status?: RecipientStatus; page: number }) {
  const qc = useQueryClient();
  return useQuery({
    queryKey: [...dispatchKey(id), 'recipients', status, page],
    retry: false,
    queryFn: async () =>
      dispatchRecipientPageSchema.parse(
        await api
          .get(`internal/team-whatsapp/dispatches/${id}/recipients`, {
            searchParams: { page, pageSize: RECIPIENT_PAGE_SIZE, ...(status ? { status } : {}) },
          })
          .json(),
      ),
    placeholderData: keepPreviousData,
    refetchInterval: () => resultPollInterval(qc, id, qc.getQueryData<DispatchDetail>(dispatchKey(id))),
  });
}

/** Repete falhas certas (C6): `recipientIds` ou `all`. Atualiza o detalhe, os destinatários e o histórico. */
export function useRetryRecipients(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (json: RetryInput) =>
      retryResultSchema.parse(await api.post(`internal/team-whatsapp/dispatches/${id}/retry`, { json }).json()),
    onSuccess: () => {
      // Antes de invalidar: o refetch do detalhe já tem de enxergar a janela reaberta. O gcTime longo
      // mantém o instante vivo mesmo sem observador (o padrão de 5 min fecharia o poll antes da hora).
      // setQueryData numa entrada existente não reagenda o gc: remove e recria, para o prazo contar
      // deste Repetir e não do primeiro.
      qc.setQueryDefaults(retriedAtKey(id), { gcTime: POLL_WINDOW_MS });
      qc.removeQueries({ queryKey: retriedAtKey(id), exact: true });
      qc.setQueryData(retriedAtKey(id), Date.now());
      return Promise.all([
        qc.invalidateQueries({ queryKey: dispatchKey(id) }),
        qc.invalidateQueries({ queryKey: ['team-whatsapp', 'dispatches'] }),
      ]);
    },
  });
}
