import { z } from 'zod';

/**
 * De onde o disparo saiu. É a coluna que o cliente pediu para ver: hoje ele
 * dispara pelo PAINEL do Zernio e o orgamind não sabia de nada.
 *
 * `ZERNIO_PANEL` = `ZernioBroadcast.campaignId` nulo. `ORGAMIND` = vinculado a uma
 * Campaign daqui. Ver a nota de ORIGEM no model `ZernioBroadcast`.
 */
export const zernioBroadcastOriginSchema = z.enum(['ZERNIO_PANEL', 'ORGAMIND']);
export type ZernioBroadcastOrigin = z.infer<typeof zernioBroadcastOriginSchema>;

/**
 * Os contadores de um disparo, com as taxas JÁ CALCULADAS pelo servidor.
 *
 * A resposta fala UMA semântica só: o FUNIL cumulativo — `sent ⊇ delivered ⊇
 * read`, com `failed` fora dele. O banco guarda duas semânticas (partição do
 * painel do Zernio vs. funil do webhook do orgamind) e o ZernioMetricsService
 * converte tudo para funil ANTES de somar. Quem recalculasse `delivered +
 * read` na tela contaria a lida duas vezes numa linha do orgamind — foi o bug da
 * "entrega" de 153%. Com a conta num lugar só, ela é testada num lugar só.
 */
const countersSchema = z.object({
  recipientCount: z.number(),
  /** Funil: tudo que saiu do número (inclui entregues e lidas). */
  sentCount: z.number(),
  /** Funil: chegou ao aparelho (inclui lidas). */
  deliveredCount: z.number(),
  readCount: z.number(),
  failedCount: z.number(),
  skippedCount: z.number(),
  /** == deliveredCount no funil; mantido por compatibilidade do contrato. */
  reachedCount: z.number(),
  /** reached / recipients, em 0-100. null quando não há destinatários. */
  deliveryRate: z.number().nullable(),
  /** read / recipients, em 0-100. */
  readRate: z.number().nullable(),
});

export const zernioBroadcastRowSchema = countersSchema.extend({
  id: z.string(),
  zernioId: z.string(),
  name: z.string(),
  /** draft | scheduled | sending | completed | failed | cancelled (cru). */
  status: z.string(),
  templateName: z.string().nullable(),
  messagePreview: z.string().nullable(),
  origin: zernioBroadcastOriginSchema,
  /** A campanha do orgamind, quando o disparo saiu daqui. */
  campaignId: z.string().nullable(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  createdAt: z.string().nullable(),
});
export type ZernioBroadcastRow = z.infer<typeof zernioBroadcastRowSchema>;

const channelTotalsSchema = countersSchema.extend({
  broadcasts: z.number(),
  /** Disparados pelo PAINEL do Zernio — o ponto cego que o orgamind fechou. */
  fromZernioPanel: z.number(),
  /** Disparados pelo orgamind (campanha vinculada). */
  fromPicoa: z.number(),
});

/**
 * O volume do lado do ZERNIO no período (`GET /analytics/inbox/volume`).
 * `null` quando o snapshot diário ainda não rodou para o canal.
 *
 * Atenção ao `failed`: ele conta MENSAGENS que falharam, não destinatários
 * rejeitados — pode vir 0 num período em que um disparo teve 37 falhas. A
 * verdade sobre falha de disparo é a dos broadcasts.
 */
const channelVolumeSchema = z.object({
  sent: z.number(),
  received: z.number(),
  read: z.number(),
  failed: z.number(),
});

export const zernioChannelMetricsSchema = z.object({
  channelId: z.string(),
  channelName: z.string(),
  phoneE164: z.string().nullable(),
  totals: channelTotalsSchema,
  volume: channelVolumeSchema.nullable(),
  /**
   * Mensagens de campanha que o ORGAMIND enviou por este canal no período
   * (tabela `Message`). Contra o `volume.sent` (o total que saiu do número,
   * medido pelo Zernio), a diferença é o que saiu POR FORA do orgamind.
   */
  picoaSent: z.number(),
  broadcasts: z.array(zernioBroadcastRowSchema),
});
export type ZernioChannelMetrics = z.infer<typeof zernioChannelMetricsSchema>;

export const zernioMetricsSchema = z.object({
  periodDays: z.number(),
  /** Início da janela (YYYY-MM-DD). */
  from: z.string(),
  /** Agregado de TODOS os canais ZERNIO — os números do período. */
  totals: channelTotalsSchema,
  channels: z.array(zernioChannelMetricsSchema),
});
export type ZernioMetrics = z.infer<typeof zernioMetricsSchema>;
