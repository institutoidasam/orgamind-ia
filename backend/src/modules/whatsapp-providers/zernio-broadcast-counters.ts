import type { PrismaService } from '../../shared/prisma/prisma.service';

/**
 * ZW — os contadores de um disparo, derivados das NOSSAS Messages.
 *
 * ## Por que não vêm do Zernio
 *
 * Sondagem ao vivo (13/07, conta de produção): os contadores agregados do
 * `GET /broadcasts` estão QUEBRADOS e CONGELADOS. Um disparo real voltou com
 * `sentCount: 3` e `deliveredCount: 8` — mais entregues do que enviadas, o que é
 * aritmeticamente impossível — e os números não se moviam. O
 * `GET /broadcasts/{id}/recipients` está pior: reporta TODOS os destinatários
 * como `pending` indefinidamente, enquanto os webhooks já confirmam entregas.
 *
 * Quem sabe a verdade, em tempo real, é o WEBHOOK de status — e o webhook
 * escreve na `Message`. Logo a `Message` é a fonte, e o contador é uma PROJEÇÃO
 * dela. Copiar os números do Zernio por cima seria trocar um dado certo por um
 * errado a cada 15 minutos.
 *
 * ## O funil é MONOTÔNICO por construção
 *
 * `sent >= delivered >= read`. Quem leu, recebeu; quem recebeu, saiu. Como os
 * status da `Message` são um estado ÚNICO (e não flags acumuladas), cada nível
 * soma os níveis acima dele — e a incoerência do Zernio deixa de ser possível.
 *
 * `FAILED` fica FORA do funil: não saiu, não foi entregue, não foi lido.
 */
export type BroadcastCounters = {
  sentCount: number;
  deliveredCount: number;
  readCount: number;
  failedCount: number;
};

/** Puro: os status das nossas Messages → o funil. Testável sem banco. */
export function broadcastCountersFromStatuses(
  byStatus: Record<string, number>,
): BroadcastCounters {
  const n = (s: string): number => byStatus[s] ?? 0;
  const readCount = n('READ');
  const deliveredCount = n('DELIVERED') + readCount;
  const sentCount = n('SENT') + deliveredCount;
  return {
    sentCount,
    deliveredCount,
    readCount,
    failedCount: n('FAILED'),
  };
}

/**
 * O caminho INVERSO: funil cumulativo → partição por status atual.
 *
 * Existe para UM momento: o delete da campanha. O schema faz SetNull no
 * `ZernioBroadcast.campaignId`, e é o campaignId que diz à leitura
 * (ZernioMetricsService.toFunnel) qual semântica os contadores carregam. A
 * linha órfã passa a ser lida como linha do PAINEL (partição) — então os
 * contadores têm de ser convertidos no MESMO commit do delete, ou a leitura
 * re-somaria um funil como se fosse partição e a lida contaria duas vezes
 * (o bug da "entrega" de 153%, de volta pela porta dos fundos).
 *
 * Clamp em 0 por defesa: o funil é monotônico por construção, mas uma linha
 * torta não pode virar contador negativo na tela.
 */
export function funnelToPartition(c: BroadcastCounters): BroadcastCounters {
  return {
    sentCount: Math.max(0, c.sentCount - c.deliveredCount),
    deliveredCount: Math.max(0, c.deliveredCount - c.readCount),
    readCount: c.readCount,
    failedCount: c.failedCount,
  };
}

/**
 * Recalcula os contadores do espelho a partir das Messages do disparo.
 *
 * Chamado pelo WEBHOOK (a cada ack de status de uma mensagem de broadcast) e
 * pelo RECONCILIADOR. É idempotente e barato: um `groupBy` indexado por
 * `zernioBroadcastId` (ver `@@index([zernioBroadcastId])` no schema).
 */
export async function recomputeBroadcastCounters(
  prisma: PrismaService,
  localBroadcastId: string,
): Promise<BroadcastCounters> {
  const rows = await prisma.message.groupBy({
    by: ['status'],
    where: { zernioBroadcastId: localBroadcastId },
    _count: { _all: true },
  });

  const byStatus: Record<string, number> = {};
  for (const r of rows) {
    byStatus[r.status] = r._count._all;
  }
  return broadcastCountersFromStatuses(byStatus);
}
