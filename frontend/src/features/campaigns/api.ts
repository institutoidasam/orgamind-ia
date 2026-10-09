import { useEffect, useRef } from "react";
import {
  useQuery,
  useMutation,
  useQueryClient,
  queryOptions,
} from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import type {
  CampaignSummary,
  CampaignDetail,
  CreateCampaign,
  PreviewResult,
  PreflightResult,
  FilterGroup,
  ScheduleConfig,
  SendAnalysisResult,
  ListMessagesQuery,
  ListMessagesResponse,
  BatchSummary,
  CampaignBatch,
  SendBatchResult,
  RecipientGroup,
  ListRecipientsResponse,
  CampaignFailureReasonCount,
} from "./schemas";

function invalidateCampaignTree(qc: QueryClient, campaignId?: string) {
  qc.invalidateQueries({
    predicate: (q) => {
      if (q.queryKey[0] !== "campaigns") return false;
      if (campaignId == null) return true;
      // matches ['campaigns'], ['campaigns', id], ['campaigns', id, 'messages', ...]
      return q.queryKey[1] == null || q.queryKey[1] === campaignId;
    },
  });
}

const POLLING_MAX_DURATION_MS = 30 * 60 * 1000; // 30 min
const POLLING_INTERVAL_MS = 2_000;

export const campaignsQueries = {
  list: () =>
    queryOptions({
      queryKey: ["campaigns"] as const,
      queryFn: () => api.get("campaigns").json<CampaignSummary[]>(),
    }),
  detail: (id: string) =>
    queryOptions({
      queryKey: ["campaigns", id] as const,
      queryFn: () => api.get(`campaigns/${id}`).json<CampaignDetail>(),
    }),
};

export function useCampaigns() {
  return useQuery(campaignsQueries.list());
}

/**
 * Lightweight indicator for the "ao vivo" pill in the topbar — polls the
 * shared campaigns list query every 15s while the tab is foregrounded and
 * collapses the response to a single boolean. Other consumers of the list
 * query continue to use {@link useCampaigns} without any polling.
 */
export function useLiveCampaignsIndicator() {
  return useQuery({
    ...campaignsQueries.list(),
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
    select: (data) => data.some((c) => c.status === "RUNNING"),
  });
}

export function useCampaign(id: string) {
  const startedAt = useRef<number | undefined>(undefined);
  useEffect(() => {
    startedAt.current = Date.now();
  }, []);
  return useQuery({
    ...campaignsQueries.detail(id),
    refetchInterval: (query) => {
      // Stop polling on errors so we don't hammer a failing endpoint.
      if (query.state.status === "error") return false;
      // Hard cutoff after 30 minutes — protects long-open tabs.
      if (
        startedAt.current !== undefined &&
        Date.now() - startedAt.current > POLLING_MAX_DURATION_MS
      )
        return false;
      const status = query.state.data?.status;
      // No data yet (initial load): poll once at the standard interval.
      if (!status) return POLLING_INTERVAL_MS;
      // Active states: keep polling.
      if (status === "QUEUED" || status === "RUNNING")
        return POLLING_INTERVAL_MS;
      // Terminal states (COMPLETED / FAILED / CANCELLED / DRAFT): stop.
      return false;
    },
    refetchIntervalInBackground: false,
  });
}

/**
 * A prévia. `limit` ("os N primeiros") viaja junto porque a prévia tem de contar
 * e AMOSTRAR exatamente quem vai receber — se o limite ficasse só no create, a
 * tela diria 13.400 e o disparo mandaria para 200.
 *
 * ★ `templateId` é OBRIGATÓRIO (aceita `null` explícito) de propósito. Ele era
 * opcional, e por isso duas das três chamadas simplesmente o esqueceram: o
 * "Próximo" do passo 3 e a prévia de recuperação do passo 4 pediam a audiência
 * BRUTA, e era esse número (500) que a tela de confirmação prometia enquanto o
 * disparo materializava 88. Um campo opcional não avisa quando é esquecido;
 * este agora faz o compilador apontar qualquer chamada futura que o omita.
 */
export function usePreviewCampaign() {
  return useMutation({
    mutationFn: async (args: {
      filters: FilterGroup;
      limit?: number | null;
      /**
       * O template escolhido no passo 1. Com ele o backend aplica a mesma
       * exclusão que o disparo aplicará e devolve `excludedSameTemplate`.
       * `null` = a chamada declara que não há template (a exclusão não se
       * aplica), em vez de deixar a omissão passar em silêncio.
       */
      templateId: string | null;
      /**
       * Pedido do cliente (2026-08-25) — espelha o campo do create
       * (`excludeAnyPreviousCampaign`, `./schemas.ts`). A prévia PRECISA
       * levá-lo: é ela que produz o número da tela de confirmação, e o
       * disparo vai aplicar a MESMA régua (`campaigns.service.ts`,
       * `sameTemplateExclusion`). Sem isto a tela promete um número e o
       * disparo materializa outro — o mesmo defeito que a Fase 0 existiu
       * para consertar, agora sobre este campo.
       */
      excludeAnyPreviousCampaign?: boolean;
    }): Promise<PreviewResult> => {
      // O contrato do backend é `z.string().min(1).optional()`: aceita a string
      // ou a AUSÊNCIA do campo — um `null` no corpo é 400. O chamador declara
      // "não há template" com `null`; a tradução para o fio mora aqui.
      const {
        filters,
        limit = null,
        templateId,
        excludeAnyPreviousCampaign = false,
      } = args;
      const body = templateId
        ? { filters, limit, templateId, excludeAnyPreviousCampaign }
        : { filters, limit, excludeAnyPreviousCampaign };
      return api.post("campaigns/preview", { json: body }).json<PreviewResult>();
    },
  });
}

export function usePreflightByFilters() {
  return useMutation({
    mutationFn: async (filters: FilterGroup): Promise<PreflightResult> =>
      api
        .post("campaigns/preflight", { json: { filters } })
        .json<PreflightResult>(),
  });
}

/**
 * Send-analysis ("Análise de envio") for the campaign wizard's confirm step —
 * computes the anti-ban checks for the current audience filters, connection and
 * schedule. Mirrors the backend `POST /campaigns/preflight-checks`.
 */
export function usePreflightCampaignChecks() {
  return useMutation({
    mutationFn: async (input: {
      filters: FilterGroup;
      defaultInstanceId: string;
      schedule: ScheduleConfig;
      timezone: string;
      /**
       * C1b — com a finalidade, a resposta traz também `consent`: quantos da
       * audiência consentiram para ela e quantos o gate vai pular.
       */
      purposeKey?: string;
    }): Promise<SendAnalysisResult> =>
      api
        .post("campaigns/preflight-checks", { json: input })
        .json<SendAnalysisResult>(),
  });
}

export function useCreateCampaign() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateCampaign): Promise<CampaignSummary> =>
      api.post("campaigns", { json: input }).json<CampaignSummary>(),
    onSuccess: () => invalidateCampaignTree(qc),
  });
}

/**
 * APAGAR a campanha — de vez.
 *
 * `Message.campaignId -> Campaign` é `onDelete: Cascade` no schema, e as Message
 * são as BOLHAS DO INBOX (`Message.conversationId`). Apagar uma campanha que
 * enviou de verdade ARRANCA essas bolhas das conversas. Quem chama isto é
 * responsável por avisar o operador ANTES, com o número — ver o diálogo de
 * confirmação na lista de campanhas.
 *
 * Os CONSENTIMENTOS não são afetados (ConsentEvent não tem FK para Campaign e há
 * trigger no banco proibindo DELETE). Invalida também `['chat']`: as conversas do
 * inbox acabaram de perder mensagens.
 */
export function useDeleteCampaign() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) =>
      api.delete(`campaigns/${id}`).json<{ deleted: true; id: string }>(),
    onSuccess: () => {
      invalidateCampaignTree(qc);
      void qc.invalidateQueries({ queryKey: ["chat"] });
    },
  });
}

/**
 * F1 T9 — Segmentos cujo filtro tem um nó history referenciando esta
 * campanha. Alimenta o aviso na tela de apagar: `Message.campaignId` é
 * `onDelete: Cascade`, então apagar a campanha destrói o registro de quem já
 * recebeu dela e esses Segmentos silenciosamente param de excluí-la.
 *
 * `enabled` por padrão `true`, mas o chamador (o diálogo de confirmação de
 * apagar) o passa `false` até o diálogo abrir — não há por que buscar isso
 * para toda linha da lista de campanhas de graça.
 */
export function useDependentSegments(
  campaignId: string,
  opts: { enabled?: boolean } = {},
) {
  return useQuery({
    queryKey: ["campaigns", campaignId, "dependent-segments"] as const,
    queryFn: () =>
      api
        .get(`campaigns/${campaignId}/dependent-segments`)
        .json<{ id: string; name: string }[]>(),
    enabled: opts.enabled ?? true,
  });
}

export function useRunCampaign() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string): Promise<{ queued: number }> =>
      api.post(`campaigns/${id}/run`).json<{ queued: number }>(),
    onSuccess: (_, id) => invalidateCampaignTree(qc, id),
  });
}

export function useCancelCampaign() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => api.post(`campaigns/${id}/cancel`).json(),
    onSuccess: (_, id) => invalidateCampaignTree(qc, id),
  });
}

export function useCampaignMessages(
  id: string,
  query: ListMessagesQuery,
  opts: { live?: boolean } = {},
) {
  return useQuery({
    queryKey: ["campaigns", id, "messages", query] as const,
    queryFn: () => {
      const params = new URLSearchParams();
      if (query.page) params.set("page", String(query.page));
      if (query.pageSize) params.set("pageSize", String(query.pageSize));
      if (query.status) params.set("status", query.status);
      if (query.search) params.set("search", query.search);
      const qs = params.toString();
      return api
        .get(`campaigns/${id}/messages${qs ? `?${qs}` : ""}`)
        .json<ListMessagesResponse>();
    },
    placeholderData: (prev) => prev,
    // Only poll while the campaign is actively producing events. Terminal
    // campaigns (COMPLETED / FAILED / CANCELLED / DRAFT) never change, so
    // polling them every 5s just burns requests for an open detail tab.
    refetchInterval: opts.live ? 5_000 : false,
    refetchIntervalInBackground: false,
  });
}

export function useRetryMessage(campaignId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (messageId: string) =>
      api
        .post(`campaigns/messages/${messageId}/retry`)
        .json<{ queued: number }>(),
    onSuccess: () => invalidateCampaignTree(qc, campaignId),
  });
}

export function useRedispatchMessage(campaignId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (messageId: string) =>
      api
        .post(`campaigns/messages/${messageId}/redispatch`)
        .json<{ queued: number; messageId: string }>(),
    onSuccess: () => invalidateCampaignTree(qc, campaignId),
  });
}

export function useRetryFailed(campaignId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () =>
      api
        .post(`campaigns/${campaignId}/retry-failed`)
        .json<{ queued: number }>(),
    onSuccess: () => invalidateCampaignTree(qc, campaignId),
  });
}

/**
 * ★ CRÍTICO (achado 1, review final) — o POST ia SEM CORPO, então
 * `RedispatchCampaignDto.resendToAll` caía no default `false` do backend e o
 * service usava o recorte `unreached` (`campaigns.service.ts:1633-1636`) em
 * vez da audiência INTEIRA. Com `pending = 0` (o caso comum de "Disparar de
 * novo para TODOS", que só faz sentido depois de tudo já ter sido enviado) o
 * backend respondia 409 "não há destinatários pendentes" — a única ação que
 * a spec (A.5) autoriza a repetir de propósito não repetia nada.
 *
 * `resendToAll` agora é um parâmetro OBRIGATÓRIO da mutation (não um default
 * escondido): quem chama declara a intenção, e o corpo do POST é o que o
 * diálogo do cabeçalho de progresso já promete na tela ("N pessoas
 * receberiam esta mensagem pela 2ª vez").
 */
export function useRedispatchCampaign(campaignId: string) {
  const qc = useQueryClient();
  return useMutation({
    /**
     * `skippedAlreadyLive` vem do backend junto de `queued` e é o que explica
     * um `queued: 0` (todo mundo já está a caminho). Enquanto o tipo do fio
     * dizia só `{ queued }`, o `.json<...>()` descartava o campo e o operador
     * via "0 mensagens disparadas" sem motivo. Opcional porque uma API mais
     * antiga (rollback do backend) não o devolve.
     */
    mutationFn: async (args: { resendToAll: boolean }) =>
      api
        .post(`campaigns/${campaignId}/redispatch`, { json: args })
        .json<{ queued: number; skippedAlreadyLive?: number }>(),
    onSuccess: () => invalidateCampaignTree(qc, campaignId),
  });
}

// ── ZE — CAMPANHA EM LOTES ───────────────────────────────────────────────────

/**
 * Os três números do painel. `live` liga o polling enquanto o lote escoa —
 * "Pendentes" cai em tempo real conforme as mensagens saem.
 */
export function useBatchSummary(
  campaignId: string,
  opts: { live?: boolean } = {},
) {
  return useQuery({
    queryKey: ["campaigns", campaignId, "batch-summary"] as const,
    queryFn: () =>
      api.get(`campaigns/${campaignId}/batch-summary`).json<BatchSummary>(),
    placeholderData: (prev) => prev,
    refetchInterval: opts.live ? 5_000 : false,
    refetchIntervalInBackground: false,
  });
}

/** Histórico: quando, quantos, resultado. */
export function useCampaignBatches(
  campaignId: string,
  opts: { live?: boolean } = {},
) {
  return useQuery({
    queryKey: ["campaigns", campaignId, "batches"] as const,
    queryFn: () =>
      api.get(`campaigns/${campaignId}/batches`).json<CampaignBatch[]>(),
    placeholderData: (prev) => prev,
    refetchInterval: opts.live ? 5_000 : false,
    refetchIntervalInBackground: false,
  });
}

/** A aba "enviados × não enviados". */
export function useCampaignRecipients(
  campaignId: string,
  query: { group: RecipientGroup; page?: number; pageSize?: number },
) {
  return useQuery({
    queryKey: ["campaigns", campaignId, "recipients", query] as const,
    queryFn: () => {
      const params = new URLSearchParams({ group: query.group });
      if (query.page) params.set("page", String(query.page));
      if (query.pageSize) params.set("pageSize", String(query.pageSize));
      return api
        .get(`campaigns/${campaignId}/recipients?${params.toString()}`)
        .json<ListRecipientsResponse>();
    },
    placeholderData: (prev) => prev,
  });
}

/**
 * F2 — "por que falhou", agregado: as Messages FAILED da campanha agrupadas
 * por motivo, com o rótulo PT-BR já pronto do backend. Alimenta o resumo da
 * aba de falhas, para o operador ler o padrão (12 "canal fora do ar" é um
 * problema do canal; 12 "sem WhatsApp" é um problema da base) sem abrir
 * destinatário por destinatário.
 *
 * `enabled` desligado por padrão do chamador enquanto a aba de falhas está
 * fechada: nenhuma tela precisa deste agregado só para desenhar os KPIs.
 */
export function useCampaignFailureReasons(
  campaignId: string,
  opts: { enabled?: boolean } = {},
) {
  return useQuery({
    queryKey: ["campaigns", campaignId, "failure-reasons"] as const,
    queryFn: () =>
      api
        .get(`campaigns/${campaignId}/failure-reasons`)
        .json<CampaignFailureReasonCount[]>(),
    enabled: opts.enabled ?? true,
  });
}

/**
 * "Enviar agora para N contatos". O backend decide PARA QUEM — os N primeiros
 * pendentes —, então o front só manda o tamanho.
 */
export function useSendBatch(campaignId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (size: number) =>
      api
        .post(`campaigns/${campaignId}/batches`, { json: { size } })
        .json<SendBatchResult>(),
    onSuccess: () => invalidateCampaignTree(qc, campaignId),
  });
}

const WAITING_POLL_INTERVAL_MS = 8_000;

/**
 * "N aguardando o canal reconectar" — a contagem e os NOMES dos canais.
 *
 * A contagem também vem em `BatchSummary.waiting`; o que só existe aqui são os
 * nomes, que é o que transforma o aviso em ação ("reconecte o robo"). Ficava
 * como um `useQuery` solto dentro da rota da campanha; mora aqui porque o
 * cabeçalho de progresso passou a ser quem o mostra.
 *
 * `live` desliga o polling em campanha terminal: uma campanha concluída nunca
 * produz mensagem nova em espera, e a aba aberta ficava consultando para sempre.
 *
 * Fix round (achado 6, review final) — quando este hook nasceu (migrado do
 * `useQuery` inline da página de detalhe), o `refetchInterval` virou um
 * NÚMERO fixo (`opts.live ? 8_000 : false`) e perdeu as duas guardas que a
 * versão antiga tinha: parar em ERRO (não martelar um endpoint que só falha)
 * e o corte de 30 MINUTOS (uma aba aberta o dia inteiro numa campanha RUNNING
 * não pode sondar para sempre). `refetchInterval` volta a ser uma FUNÇÃO, no
 * mesmo padrão de `useCampaign` acima.
 */
export function useCampaignWaiting(
  campaignId: string,
  opts: { live?: boolean } = {},
) {
  const startedAt = useRef<number | undefined>(undefined);
  useEffect(() => {
    startedAt.current = Date.now();
  }, []);
  return useQuery({
    queryKey: ["campaigns", campaignId, "waiting"] as const,
    queryFn: () =>
      api
        .get(`campaigns/${campaignId}/waiting`)
        .json<{ count: number; instanceNames: string[] }>(),
    placeholderData: (prev) => prev,
    refetchInterval: (query) => {
      if (!opts.live) return false;
      // Stop polling on errors so we don't hammer a failing endpoint.
      if (query.state.status === "error") return false;
      // Hard cutoff after 30 minutes — protects long-open tabs.
      if (
        startedAt.current !== undefined &&
        Date.now() - startedAt.current > POLLING_MAX_DURATION_MS
      )
        return false;
      return WAITING_POLL_INTERVAL_MS;
    },
    refetchIntervalInBackground: false,
  });
}

/**
 * O 1º LOTE DO ASSISTENTE — o irmão de `useSendBatch` que recebe o id NA
 * CHAMADA, e não na criação do hook.
 *
 * Não dá para reusar `useSendBatch(campaignId)` no wizard: lá a campanha só
 * ganha id DEPOIS do `POST /campaigns`, e um `setState` com o id novo não vale
 * dentro da mesma função — o hook continuaria apontando para `''` e o lote
 * iria para lugar nenhum, em silêncio. Duas funções são mais honestas do que
 * um hook que finge saber um id que ainda não existe.
 */
export function useSendFirstBatch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      campaignId,
      size,
    }: {
      campaignId: string;
      size: number;
    }) =>
      api
        .post(`campaigns/${campaignId}/batches`, { json: { size } })
        .json<SendBatchResult>(),
    onSuccess: (_r, vars) => invalidateCampaignTree(qc, vars.campaignId),
  });
}
