import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { zernioSendHasPriority } from '../queue/zernio-send-priority.helper';
import { ZernioAnalyticsClient } from './zernio-analytics.client';

/**
 * Quantos dias reler a cada rodada.
 *
 * Não é "os últimos 7 dias de dados" — é a JANELA DE CORREÇÃO. O `read` de uma
 * mensagem chega quando a pessoa abre o WhatsApp, o que pode ser dias depois do
 * envio. Um snapshot gravado ontem está errado hoje. Reler a semana e reescrever
 * (upsert por (canal, dia)) é o que mantém os números certos — e custa 1
 * requisição por canal, não 7.
 */
const DEFAULT_LOOKBACK_DAYS = 7;

export type ZernioAnalyticsSyncResult = {
  /** Linhas de dia gravadas/reescritas. */
  days: number;
  /** Canais ZERNIO ativos considerados. */
  channels: number;
  /** Canais que falharam (429 teimoso, 401) — falha PARCIAL. */
  failed: number;
  reason?: string;
  paused?: boolean;
};

/**
 * A fotografia diária do volume de mensagens NO LADO DO ZERNIO.
 *
 * ## Por que este serviço não usa o `GET /analytics`
 *
 * Porque o `/analytics` do Zernio **não é analytics de WhatsApp**. Sondado ao
 * vivo (12/07, só GET), ele devolve `{overview:{totalPosts:0,…}, posts:[]}` — é
 * analytics de POSTS de rede social, o produto original do Zernio. Para esta
 * conta ele responde 200 com zero posts, e sempre responderá: o orgamind não
 * publica post nenhum. Espelhá-lo seria espelhar vazio.
 *
 * O que serve é `GET /analytics/inbox/volume?accountId=&fromDate=&toDate=`, da
 * família `/analytics/inbox/*` (que o dossiê não tinha mapeado). Ao vivo, na
 * conta do cliente: `summary{sent:121, received:23, read:72, failed:0}` +
 * `timeseries` diário. É por conta e por período — exatamente a métrica agregada
 * que o cliente pediu.
 *
 * ## O que estes números NÃO são
 *
 * **Não são a verdade sobre FALHAS.** O `failed` daqui veio 0 no mesmo período
 * em que um broadcast reportou 37 destinatários com falha: o destinatário
 * rejeitado nunca chega a virar uma "mensagem" no inbox do Zernio. Para falha de
 * disparo, a fonte é o `ZernioBroadcast`. Este modelo é VOLUME (quantas
 * mensagens circularam), e é assim que a tela o rotula.
 */
@Injectable()
export class ZernioAnalyticsSyncService {
  private readonly logger = new Logger(ZernioAnalyticsSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly client: ZernioAnalyticsClient,
  ) {}

  async syncSnapshots(
    opts: { days?: number } = {},
  ): Promise<ZernioAnalyticsSyncResult> {
    const empty = { days: 0, channels: 0, failed: 0 };

    if (!this.client.configured) {
      return { ...empty, reason: 'ZERNIO_API_KEY não configurada' };
    }

    const channels = await this.prisma.channel.findMany({
      where: {
        provider: 'ZERNIO',
        isActive: true,
        zernioAccountId: { not: null },
      },
      select: { id: true, zernioAccountId: true },
    });
    if (channels.length === 0) {
      return {
        ...empty,
        reason: 'nenhum canal ZERNIO ativo com conta resolvida',
      };
    }

    // O envio tem prioridade — a mesma regra do sync do inbox e do de disparos.
    // Este job é diário: adiá-lo por uma campanha não custa absolutamente nada.
    const channelIds = channels.map((c) => c.id);
    if (await zernioSendHasPriority(this.prisma, channelIds)) {
      this.logger.log(
        'campanha ativa — snapshot de volume do Zernio cedeu o balde',
      );
      return { ...empty, channels: channels.length, paused: true };
    }

    const lookback = opts.days ?? DEFAULT_LOOKBACK_DAYS;
    const toDate = new Date();
    const fromDate = new Date(toDate);
    // `lookback - 1` porque a janela é INCLUSIVA nas duas pontas: 7 dias =
    // hoje + os 6 anteriores.
    fromDate.setUTCDate(fromDate.getUTCDate() - (lookback - 1));

    let days = 0;
    let failed = 0;

    for (const channel of channels) {
      if (!channel.zernioAccountId) continue;
      try {
        const vol = await this.client.getInboxVolume(
          channel.id,
          channel.zernioAccountId,
          isoDay(fromDate),
          isoDay(toDate),
        );

        for (const d of vol.timeseries) {
          const day = new Date(`${d.date}T00:00:00.000Z`);
          if (Number.isNaN(day.getTime())) continue;
          const data = {
            sent: d.sent,
            received: d.received,
            read: d.read,
            failed: d.failed,
            syncedAt: new Date(),
          };
          await this.prisma.zernioAnalyticsSnapshot.upsert({
            where: { channelId_day: { channelId: channel.id, day } },
            update: data,
            create: { channelId: channel.id, day, ...data },
          });
          days += 1;
        }
      } catch (err: unknown) {
        // Um canal quebrado (401, 429 teimoso) não pode derrubar os outros — o
        // tick de amanhã tenta de novo, e a janela de 7 dias recupera o que faltou.
        failed += 1;
        this.logger.warn(
          { err, channelId: channel.id },
          'falha lendo o volume do Zernio para o canal — seguindo',
        );
      }
    }

    if (days > 0 || failed > 0) {
      this.logger.log(
        `zernio-analytics-sync: dias=${days} canais=${channels.length} falhas=${failed}`,
      );
    }
    return { days, channels: channels.length, failed };
  }
}

/** `Date` → `YYYY-MM-DD` em UTC (o formato que o Zernio exige). */
function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}
