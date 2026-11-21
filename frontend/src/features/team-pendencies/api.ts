import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { HTTPError } from "ky";
import { toast } from "sonner";
import { api } from "@/lib/api-client";
import { readApiErrorBody } from "@/lib/api-error";
import { pendencyErrorText } from "./pendency-errors";
import {
  OPEN_PENDENCY_SITUATIONS,
  pendencyHandlersSchema,
  teamPendencyCountSchema,
  teamPendencyListSchema,
  type PendencySituation,
} from "./schemas";

/** Prefixo da chave de tudo da tela de pendências (lista, contador, destinos, ação); quem invalida tudo usa este. */
export const PENDENCIES_KEY = ["team-pendencies"] as const;

const BASE = "internal/team-whatsapp";

/** Código do 403 de quem não é remetente (o mesmo do panorama e do roster). */
const NOT_SENDER_CODE = "team_whatsapp.forbidden";

export type PendencyFilters = {
  situations: PendencySituation[];
  sectorId: string | null;
  mine: boolean;
  days: 7 | 30;
  page: number;
};

/** As três abertas, sem setor, todas as pessoas, 7 dias (só vale com "Ciente"/"Encerrada"), primeira página. */
export const DEFAULT_PENDENCY_FILTERS: PendencyFilters = {
  situations: [...OPEN_PENDENCY_SITUATIONS],
  sectorId: null,
  mine: false,
  days: 7,
  page: 1,
};

/** Query string da lista; lista de situações vazia não é enviada (o servidor assume as três abertas). */
function listSearchParams(filters: PendencyFilters) {
  const params: Record<string, string | number> = {
    days: filters.days,
    page: filters.page,
  };
  if (filters.situations.length > 0)
    params.situations = filters.situations.join(",");
  if (filters.sectorId) params.sectorId = filters.sectorId;
  if (filters.mine) params.mine = "true";
  return params;
}

/**
 * `null` = quem consulta não é remetente (403 `team_whatsapp.forbidden`): a consulta resolve com sucesso e a tela
 * (ou o item de menu) trata. `readApiErrorBody` é assíncrona, então a decisão fica no `queryFn`, nunca na
 * renderização. Qualquer outro erro é relançado.
 */
async function nullWhenNotSender<T>(load: () => Promise<T>): Promise<T | null> {
  try {
    return await load();
  } catch (error) {
    const isForbidden =
      error instanceof HTTPError && error.response.status === 403;
    if (
      isForbidden &&
      (await readApiErrorBody(error))?.code === NOT_SENDER_CODE
    )
      return null;
    throw error;
  }
}

/**
 * Lista de pendências. Recarrega ao abrir a tela e ao trocar filtro ou página (sem polling, sem refetch por foco nem
 * por reconexão; sem tempo real, K2-5). `enabled` falso (VIEWER) não consulta. `null` = não é remetente.
 */
export function usePendencyList(filters: PendencyFilters, enabled: boolean) {
  return useQuery({
    queryKey: [...PENDENCIES_KEY, "list", filters],
    enabled,
    retry: false,
    staleTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    placeholderData: keepPreviousData,
    queryFn: () =>
      nullWhenNotSender(async () =>
        teamPendencyListSchema.parse(
          await api
            .get(`${BASE}/pendencies`, {
              searchParams: listSearchParams(filters),
            })
            .json(),
        ),
      ),
  });
}

/**
 * Contador do menu (K2-6, DK21): calculado ao abrir o sistema e ao abrir a tela (a tela invalida a chave), sem
 * tempo real: `staleTime` infinito, sem refetch por foco, reconexão nem intervalo. `null` = não é remetente.
 */
export function usePendencyCount(enabled: boolean) {
  return useQuery({
    queryKey: [...PENDENCIES_KEY, "count"],
    enabled,
    retry: false,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchInterval: false,
    queryFn: async () => {
      const count = await nullWhenNotSender(async () =>
        teamPendencyCountSchema.parse(
          await api.get(`${BASE}/pendency-count`).json(),
        ),
      );
      return count === null ? null : count.unassignedOverdue;
    },
  });
}

/** Quem pode receber a pendência (menu de "Transferir"), buscado só com o menu aberto (`enabled`). */
export function usePendencyHandlers(id: string, enabled: boolean) {
  return useQuery({
    queryKey: [...PENDENCIES_KEY, "handlers", id],
    enabled: enabled && id !== "",
    retry: false,
    staleTime: 0,
    refetchOnWindowFocus: false,
    queryFn: async () =>
      pendencyHandlersSchema.parse(
        await api.get(`${BASE}/pendencies/${id}/handlers`).json(),
      ),
  });
}

/** O que cada ação leva: `expectedHandlerId` é o responsável que a tela mostrava (DK11–DK14). */
export type PendencyActionInput =
  | { kind: "assume"; expectedHandlerId: string | null; note?: string }
  | { kind: "transfer"; toUserId: string; expectedHandlerId: string | null }
  | { kind: "note"; expectedHandlerId: string | null; text: string }
  | { kind: "close"; expectedHandlerId: string | null; reason: string }
  | { kind: "reopen"; expectedHandlerId: string | null };

type ActionKind = PendencyActionInput["kind"];

const ACTION_PATH: Record<ActionKind, string> = {
  assume: "assume",
  transfer: "transfer",
  note: "notes",
  close: "close",
  reopen: "reopen",
};

const ACTION_SUCCESS_TEXT: Record<ActionKind, string> = {
  assume: "Pendência assumida",
  transfer: "Pendência transferida",
  note: "Contato registrado",
  close: "Pendência encerrada",
  reopen: "Tratativa reaberta",
};

/** 403, 404, 409 e 422: o que a tela mostrava ficou velho; recarrega a lista e o contador. */
const RELOAD_STATUSES = new Set([403, 404, 409, 422]);

/** Relê tudo da tela (lista, contador e destinos); resolve quando as consultas ativas terminam. */
export function invalidatePendencies(qc: QueryClient): Promise<void> {
  return qc.invalidateQueries({ queryKey: PENDENCIES_KEY });
}

/**
 * Ação sobre uma pendência (assumir, transferir, registrar contato, encerrar, reabrir). Não lê o corpo da resposta
 * (204): a tela recarrega pela invalidação, e a mutação só termina depois dela, para o botão não reenviar com o
 * `expectedHandlerId` velho. Erro: toast pelo `code` (lido por `readApiErrorBody`, ky 2) e recarga em 403/404/409/422.
 */
export function usePendencyAction(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: [...PENDENCIES_KEY, "action", id],
    mutationFn: ({ kind, ...json }: PendencyActionInput) =>
      api.post(`${BASE}/pendencies/${id}/${ACTION_PATH[kind]}`, { json }),
    onSuccess: async (_data, input) => {
      toast.success(ACTION_SUCCESS_TEXT[input.kind]);
      await invalidatePendencies(qc);
    },
    onError: async (error) => {
      const body = await readApiErrorBody(error);
      toast.error(pendencyErrorText(body?.code, body?.detail));
      if (
        error instanceof HTTPError &&
        RELOAD_STATUSES.has(error.response.status)
      )
        await invalidatePendencies(qc);
    },
  });
}
