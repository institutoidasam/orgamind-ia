import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';

/**
 * De onde o disparo saiu. `ZERNIO_PANEL` = feito no painel do Zernio, POR FORA
 * do orgamind — é o ponto cego que esta tela existe para fechar.
 */
export type ZernioBroadcastOrigin = 'ZERNIO_PANEL' | 'ORGAMIND';

/**
 * Contadores + taxas. As taxas vêm PRONTAS do backend de propósito: o banco
 * mistura duas semânticas (partição do painel do Zernio vs. funil do webhook
 * do orgamind) e é o ZernioMetricsService que normaliza tudo para o FUNIL
 * cumulativo (`sent ⊇ delivered ⊇ read`; `failed` fora) antes de responder.
 * Refazer qualquer conta aqui seria a segunda chance de errá-la — somar
 * `delivered + read` numa linha do orgamind foi o bug da "entrega" de 153%.
 */
export type ZernioCounters = {
  recipientCount: number;
  /** Funil: tudo que saiu do número (inclui entregues e lidas). */
  sentCount: number;
  /** Funil: chegou ao aparelho (inclui lidas). */
  deliveredCount: number;
  readCount: number;
  failedCount: number;
  skippedCount: number;
  /** == deliveredCount no funil; mantido por compatibilidade do contrato. */
  reachedCount: number;
  /** 0-100, ou null quando o disparo não tem destinatário. */
  deliveryRate: number | null;
  readRate: number | null;
};

export type ZernioBroadcastRow = ZernioCounters & {
  id: string;
  zernioId: string;
  name: string;
  status: string;
  templateName: string | null;
  messagePreview: string | null;
  origin: ZernioBroadcastOrigin;
  campaignId: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string | null;
};

export type ZernioChannelMetrics = {
  channelId: string;
  channelName: string;
  phoneE164: string | null;
  totals: ZernioCounters & {
    broadcasts: number;
    fromZernioPanel: number;
    fromPicoa: number;
  };
  /** Volume medido pelo Zernio no período. null = snapshot ainda não rodou. */
  volume: { sent: number; received: number; read: number; failed: number } | null;
  /** O que o ORGAMIND enviou (tabela Message). A diferença para `volume.sent` é o
   *  que saiu por fora daqui. */
  picoaSent: number;
  broadcasts: ZernioBroadcastRow[];
};

export type ZernioMetrics = {
  periodDays: number;
  from: string;
  totals: ZernioChannelMetrics['totals'];
  channels: ZernioChannelMetrics[];
};

export function useZernioMetrics(days: number) {
  return useQuery({
    queryKey: ['metrics', 'zernio', days] as const,
    queryFn: () =>
      api.get('metrics/zernio', { searchParams: { days } }).json<ZernioMetrics>(),
    // O espelho é atualizado por um job de 15 min; um refetch agressivo aqui só
    // castigaria o banco sem trazer número novo.
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
  });
}

/**
 * Força o espelho AGORA (ADMIN). 202: o trabalho foi aceito, não concluído — o
 * job pode até ceder o balde para uma campanha em curso e retomar depois. Por
 * isso a tela não promete "pronto", e sim "sincronização solicitada".
 */
export function useSyncZernioBroadcasts() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post('whatsapp/zernio/sync-broadcasts').json<unknown>(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['metrics', 'zernio'] }),
  });
}
