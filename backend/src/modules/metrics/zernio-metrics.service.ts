import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../shared/prisma/prisma.service';
import type {
  ZernioBroadcastRow,
  ZernioChannelMetrics,
  ZernioMetrics,
} from '../../schemas/contracts/zernio-metrics.schema';

/** Os contadores brutos de um disparo — o que soma e o que vira taxa. */
type Counters = {
  recipientCount: number;
  sentCount: number;
  deliveredCount: number;
  readCount: number;
  failedCount: number;
  skippedCount: number;
};

const ZERO: Counters = {
  recipientCount: 0,
  sentCount: 0,
  deliveredCount: 0,
  readCount: 0,
  failedCount: 0,
  skippedCount: 0,
};

/**
 * A VISÃO ÚNICA dos disparos: o que saiu do orgamind **e** o que saiu do painel do
 * Zernio, no mesmo lugar.
 *
 * ## A conta que este serviço existe para não errar
 *
 * A tabela `ZernioBroadcast` guarda DUAS semânticas de contadores, por linha:
 *
 * - **Linha do PAINEL** (`campaignId` nulo): números do `GET /broadcasts` do
 *   Zernio — uma PARTIÇÃO dos destinatários pelo status ATUAL. O disparo real
 *   do cliente veio `recipients:120, sent:2, delivered:10, read:71, failed:37`
 *   e a soma dá 120 exatos: quem foi lido SAIU de `deliveredCount`.
 * - **Linha do ORGAMIND** (`campaignId` preenchido): números recontados das
 *   nossas `Message`s pelo webhook (ver zernio-broadcast-counters.ts) — um
 *   FUNIL cumulativo: `sent ⊇ delivered ⊇ read`. A lida está DENTRO da
 *   entregue.
 *
 * A resposta desta API fala UMA língua só: o FUNIL. `toFunnel` converte a
 * partição do painel (delivered' = delivered + read; sent' = sent + delivered
 * + read) e a linha do orgamind passa reta. Aplicar `delivered + read` numa linha
 * que JÁ é funil contava a lida duas vezes — era a "entrega" de 153% na tela.
 * A conversão acontece AQUI, e só aqui, para que exista um único lugar onde
 * possa estar certa — e um único lugar para testá-la.
 *
 * ## Por que o `picoaSent` está junto
 *
 * `volume.sent` é o que o ZERNIO viu sair do número (todas as origens).
 * `picoaSent` é o que a tabela `Message` do orgamind registra ter enviado. A
 * DIFERENÇA entre os dois é, literalmente, o que foi disparado por fora do
 * orgamind — o ponto cego que o cliente pediu para fechar. A tela mostra os dois
 * lado a lado.
 */
@Injectable()
export class ZernioMetricsService {
  constructor(private readonly prisma: PrismaService) {}

  async getMetrics(periodDays: number): Promise<ZernioMetrics> {
    const from = new Date();
    from.setUTCDate(from.getUTCDate() - periodDays);

    const channels = await this.prisma.channel.findMany({
      where: { provider: 'ZERNIO' },
      select: { id: true, name: true, phoneE164: true },
      orderBy: { createdAt: 'asc' },
    });

    // Canal ZERNIO sem disparo nenhum CONTINUA na lista, zerado: sumir com ele
    // esconderia justamente o canal que ninguém está usando (ou cujo sync
    // quebrou), que é a informação mais acionável da tela.
    if (channels.length === 0) {
      return {
        periodDays,
        from: from.toISOString().slice(0, 10),
        totals: emptyTotals(),
        channels: [],
      };
    }

    const channelIds = channels.map((c) => c.id);

    const [broadcasts, snapshots, picoaSends] = await Promise.all([
      this.prisma.zernioBroadcast.findMany({
        where: {
          channelId: { in: channelIds },
          zernioCreatedAt: { gte: from },
        },
        orderBy: { zernioCreatedAt: 'desc' },
      }),
      this.prisma.zernioAnalyticsSnapshot.findMany({
        where: { channelId: { in: channelIds }, day: { gte: from } },
      }),
      // O que o ORGAMIND disparou no período: mensagens de CAMPANHA que saíram
      // (SENT/DELIVERED/READ). QUEUED ainda não saiu; FAILED não saiu.
      this.prisma.message.groupBy({
        by: ['instanceId'],
        where: {
          instanceId: { in: channelIds },
          direction: 'OUTBOUND',
          campaignId: { not: null },
          status: { in: ['SENT', 'DELIVERED', 'READ'] },
          createdAt: { gte: from },
        },
        _count: { _all: true },
      }),
    ]);

    const picoaSentBy = new Map<string, number>();
    for (const g of picoaSends) {
      picoaSentBy.set(g.instanceId, g._count._all);
    }

    const result: ZernioChannelMetrics[] = channels.map((channel) => {
      const rows = broadcasts.filter((b) => b.channelId === channel.id);
      const days = snapshots.filter((s) => s.channelId === channel.id);

      // Cada linha vira FUNIL antes de somar: um total que somasse partição
      // (painel) com funil (orgamind) não teria semântica nenhuma.
      const counters = rows.reduce<Counters>(
        (acc, b) => addCounters(acc, toFunnel(b)),
        { ...ZERO },
      );

      return {
        channelId: channel.id,
        channelName: channel.name,
        phoneE164: channel.phoneE164,
        totals: {
          ...withRates(counters),
          broadcasts: rows.length,
          fromZernioPanel: rows.filter((b) => !b.campaignId).length,
          fromPicoa: rows.filter((b) => b.campaignId).length,
        },
        volume: days.length
          ? days.reduce(
              (acc, d) => ({
                sent: acc.sent + d.sent,
                received: acc.received + d.received,
                read: acc.read + d.read,
                failed: acc.failed + d.failed,
              }),
              { sent: 0, received: 0, read: 0, failed: 0 },
            )
          : null,
        picoaSent: picoaSentBy.get(channel.id) ?? 0,
        broadcasts: rows.map((b) => this.toRow(b)),
      };
    });

    return {
      periodDays,
      from: from.toISOString().slice(0, 10),
      totals: result.reduce(
        (acc, c) => ({
          ...withRates({
            recipientCount: acc.recipientCount + c.totals.recipientCount,
            sentCount: acc.sentCount + c.totals.sentCount,
            deliveredCount: acc.deliveredCount + c.totals.deliveredCount,
            readCount: acc.readCount + c.totals.readCount,
            failedCount: acc.failedCount + c.totals.failedCount,
            skippedCount: acc.skippedCount + c.totals.skippedCount,
          }),
          broadcasts: acc.broadcasts + c.totals.broadcasts,
          fromZernioPanel: acc.fromZernioPanel + c.totals.fromZernioPanel,
          fromPicoa: acc.fromPicoa + c.totals.fromPicoa,
        }),
        emptyTotals(),
      ),
      channels: result,
    };
  }

  private toRow(b: {
    id: string;
    zernioId: string;
    name: string;
    status: string;
    templateName: string | null;
    messagePreview: string | null;
    campaignId: string | null;
    recipientCount: number;
    sentCount: number;
    deliveredCount: number;
    readCount: number;
    failedCount: number;
    skippedCount: number;
    startedAt: Date | null;
    completedAt: Date | null;
    zernioCreatedAt: Date | null;
  }): ZernioBroadcastRow {
    return {
      id: b.id,
      zernioId: b.zernioId,
      name: b.name,
      status: b.status,
      templateName: b.templateName,
      messagePreview: b.messagePreview,
      // A ORIGEM: sem campanha vinculada, o disparo saiu do painel do Zernio.
      origin: b.campaignId ? 'ORGAMIND' : 'ZERNIO_PANEL',
      campaignId: b.campaignId,
      startedAt: b.startedAt?.toISOString() ?? null,
      completedAt: b.completedAt?.toISOString() ?? null,
      createdAt: b.zernioCreatedAt?.toISOString() ?? null,
      ...withRates(toFunnel(b)),
    };
  }
}

/**
 * Normaliza os contadores de UMA linha para o funil cumulativo.
 *
 * A origem decide a conversão (ver a nota da classe): a linha do painel é uma
 * partição por status atual (quem leu saiu de `delivered`), a linha do orgamind
 * já nasce funil no webhook. É o `campaignId` que diz qual é qual — o mesmo
 * critério do campo `origin` da resposta.
 */
function toFunnel(b: Counters & { campaignId: string | null }): Counters {
  const c: Counters = {
    recipientCount: b.recipientCount,
    sentCount: b.sentCount,
    deliveredCount: b.deliveredCount,
    readCount: b.readCount,
    failedCount: b.failedCount,
    skippedCount: b.skippedCount,
  };
  if (b.campaignId) return c; // orgamind: já é funil
  return {
    ...c,
    deliveredCount: c.deliveredCount + c.readCount,
    sentCount: c.sentCount + c.deliveredCount + c.readCount,
  };
}

function addCounters(a: Counters, b: Counters): Counters {
  return {
    recipientCount: a.recipientCount + b.recipientCount,
    sentCount: a.sentCount + b.sentCount,
    deliveredCount: a.deliveredCount + b.deliveredCount,
    readCount: a.readCount + b.readCount,
    failedCount: a.failedCount + b.failedCount,
    skippedCount: a.skippedCount + b.skippedCount,
  };
}

/**
 * Os contadores (JÁ em funil — ver `toFunnel`) + as taxas.
 *
 * `reached = delivered`: no funil a lida está dentro da entregue, então
 * `delivered` já é "quem chegou ao aparelho". O campo continua existindo por
 * compatibilidade do contrato (a tela consome `reachedCount`).
 *
 * Taxa sem destinatário é `null`, e não `0`: "0%" na tela lê como "falhou tudo",
 * quando a verdade é que não existe denominador.
 */
function withRates(c: Counters) {
  const reachedCount = c.deliveredCount;
  const pct = (n: number) =>
    c.recipientCount > 0 ? (n / c.recipientCount) * 100 : null;
  return {
    recipientCount: c.recipientCount,
    sentCount: c.sentCount,
    deliveredCount: c.deliveredCount,
    readCount: c.readCount,
    failedCount: c.failedCount,
    skippedCount: c.skippedCount,
    reachedCount,
    deliveryRate: pct(reachedCount),
    readRate: pct(c.readCount),
  };
}

function emptyTotals() {
  return {
    ...withRates(ZERO),
    broadcasts: 0,
    fromZernioPanel: 0,
    fromPicoa: 0,
  };
}
