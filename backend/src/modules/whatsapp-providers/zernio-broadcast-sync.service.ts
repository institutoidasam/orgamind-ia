import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { zernioSendHasPriority } from '../queue/zernio-send-priority.helper';
import {
  ZernioAnalyticsClient,
  type ZernioBroadcastItem,
} from './zernio-analytics.client';

/** O `limit` que o cliente usa — o passo do offset tem de ser o mesmo. */
const PAGE_SIZE = 100;
/**
 * Teto de páginas. Não é performance: é a garantia de que um `hasMore` eterno
 * não vira um laço infinito segurando o worker (e o balde do Zernio).
 */
const MAX_PAGES = 50; // 50 × 100 = 5.000 disparos

export type ZernioBroadcastSyncResult = {
  /** Disparos espelhados (upsert) nesta execução. */
  broadcasts: number;
  /** Disparos de uma conta Zernio que NÃO tem canal no orgamind. */
  skipped: number;
  /** Disparos cujo upsert falhou — falha PARCIAL, o resto entrou. */
  failed: number;
  /** Canais ZERNIO ativos considerados. */
  channels: number;
  /** Preenchido quando o sync não rodou — e por quê. */
  reason?: string;
  /** true => cedeu o balde para uma campanha; NÃO terminou. */
  paused?: boolean;
  /** O `skip` de onde retomar quando o envio liberar o balde. */
  resumeSkip?: number;
};

export type ZernioBroadcastSyncOptions = {
  /** Retomada: o offset onde a execução anterior parou. */
  startSkip?: number;
};

/**
 * Espelha no orgamind TODOS os disparos que existem no Zernio — inclusive (e
 * principalmente) os que **saíram do painel do Zernio**, sem passar por aqui.
 *
 * É o pedido literal do cliente: hoje ele dispara pelo painel e o orgamind não sabe
 * quantas mensagens foram enviadas, entregues, lidas ou falharam. Depois deste
 * sync, o orgamind é a VISÃO ÚNICA.
 *
 * ## Três coisas que este serviço faz e não são óbvias
 *
 * **1. A listagem é GLOBAL, não por conta.** `GET /broadcasts` não aceita
 * `accountId` (só `profileId`/`status`/`platform`). Então o sync lista TUDO uma
 * vez e distribui por `accountId` → `Channel.zernioAccountId`. Não dá para
 * "sincronizar um canal": a requisição é a mesma para todos.
 *
 * **2. Paginação por OFFSET.** `?limit=&skip=`, com `pagination.hasMore` — e não
 * por cursor como o `/inbox/conversations`. Um paginador genérico ingênuo lê a
 * primeira página para sempre.
 *
 * **3. Cede o balde ao envio.** Ver `zernioSendHasPriority`: enquanto houver
 * campanha QUEUED/RUNNING em QUALQUER canal ZERNIO, o sync para e guarda o
 * `skip`. Ele é um espelho — atrasar 15 minutos não custa nada; roubar 1 req/s
 * de uma campanha custa.
 *
 * Idempotente por construção: o upsert é por `zernioId`. Rodar dez vezes
 * reescreve os contadores e mais nada — que é exatamente o que faz um disparo
 * `sending` virar `completed` na tela sem duplicar linha.
 */
@Injectable()
export class ZernioBroadcastSyncService {
  private readonly logger = new Logger(ZernioBroadcastSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly client: ZernioAnalyticsClient,
  ) {}

  async syncBroadcasts(
    opts: ZernioBroadcastSyncOptions = {},
  ): Promise<ZernioBroadcastSyncResult> {
    const empty = { broadcasts: 0, skipped: 0, failed: 0, channels: 0 };

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

    /** accountId do Zernio → canal do orgamind. É o casamento inteiro. */
    const byAccount = new Map<string, string>();
    for (const ch of channels) {
      if (ch.zernioAccountId) byAccount.set(ch.zernioAccountId, ch.id);
    }
    const channelIds = channels.map((c) => c.id);

    let broadcasts = 0;
    let skipped = 0;
    let failed = 0;
    let skip = opts.startSkip ?? 0;

    for (let page = 0; page < MAX_PAGES; page++) {
      // PRIORIDADE DO ENVIO: antes de gastar mais um slot do balde, checa se há
      // campanha disparando. Se há, o sync PARA e devolve o offset — ele é um
      // espelho e pode esperar; a campanha, não.
      if (await zernioSendHasPriority(this.prisma, channelIds)) {
        this.logger.log(
          { skip, broadcasts },
          'campanha ativa — sync de disparos do Zernio cedeu o balde',
        );
        return {
          broadcasts,
          skipped,
          failed,
          channels: channels.length,
          paused: true,
          resumeSkip: skip,
        };
      }

      const res = await this.client.listBroadcasts(channelIds, skip);

      for (const item of res.items) {
        // A conta Zernio pode ter Instagram/Telegram no mesmo painel; o canal do
        // orgamind é WhatsApp.
        if (item.platform !== 'whatsapp') continue;

        const channelId = byAccount.get(item.accountId);
        // Disparo de uma conta Zernio que não tem canal aqui. Não é erro (o
        // cliente pode ter uma conta que o orgamind não gerencia) — é um número.
        if (!channelId) {
          skipped += 1;
          continue;
        }

        try {
          await this.upsert(item, channelId);
          broadcasts += 1;
        } catch (err: unknown) {
          // Um upsert que falha é UM disparo perdido, não a página inteira. O
          // próximo tick (15 min) o pega de novo.
          failed += 1;
          this.logger.warn(
            { err, zernioId: item.id },
            'falha espelhando o disparo do Zernio — pulando',
          );
        }
      }

      if (!res.hasMore) break;
      skip += PAGE_SIZE;

      if (page === MAX_PAGES - 1) {
        this.logger.warn(
          { pages: MAX_PAGES },
          'sync de disparos do Zernio truncado no teto de páginas',
        );
      }
    }

    if (broadcasts > 0 || failed > 0) {
      this.logger.log(
        `zernio-broadcast-sync: disparos=${broadcasts} pulados=${skipped} falhas=${failed}`,
      );
    }
    return { broadcasts, skipped, failed, channels: channels.length };
  }

  /**
   * Upsert por `zernioId` — a chave da idempotência.
   *
   * `campaignId` está DE FORA do `update` de propósito: o vínculo com a Campaign
   * do orgamind pertence a quem CRIOU o disparo, e o sync (que só lê o Zernio) não
   * tem como saber dele. Escrevê-lo aqui apagaria o vínculo a cada tick.
   *
   * ## ★ ZW — OS CONTADORES DE UM DISPARO DO ORGAMIND NÃO VÊM DAQUI
   *
   * Os agregados do `GET /broadcasts` estão QUEBRADOS. Medido ao vivo (13/07):
   * um disparo voltou com `sentCount: 3` e `deliveredCount: 8` — mais entregues
   * do que enviadas, aritmeticamente impossível — e congelados.
   *
   * Para um disparo que o ORGAMIND criou, quem sabe a verdade são as nossas
   * `Message`s, que o WEBHOOK de status mantém em dia em tempo real. Se este sync
   * (que roda de 15 em 15 min) reescrevesse os contadores com os números do
   * Zernio, ele APAGARIA o que o webhook apurou — a cada tick, para sempre.
   *
   * Para um disparo feito PELO PAINEL, o orgamind não tem Message nenhuma: aí os
   * números do Zernio são a única fonte que existe, tortos e tudo. Número torto é
   * melhor que nenhum número.
   */
  private async upsert(
    item: ZernioBroadcastItem,
    channelId: string,
  ): Promise<void> {
    // Metadados do Zernio: o ciclo de vida do disparo LÁ. Isto ele sabe, e é a
    // única fonte que existe (o orgamind não tem esses campos).
    const meta = {
      name: item.name,
      status: item.status,
      messagePreview: item.messagePreview,
      templateName: item.templateName,
      scheduledAt: date(item.scheduledAt),
      startedAt: date(item.startedAt),
      completedAt: date(item.completedAt),
      recipientCount: item.recipientCount,
      skippedCount: item.skippedCount,
      zernioCreatedAt: date(item.createdAt),
      syncedAt: new Date(),
    };
    const counters = {
      sentCount: item.sentCount,
      deliveredCount: item.deliveredCount,
      readCount: item.readCount,
      failedCount: item.failedCount,
    };

    // É NOSSO? Só o disparo com `campaignId` tem Messages no orgamind — e só nele o
    // webhook tem o que apurar.
    const existing = await this.prisma.zernioBroadcast.findUnique({
      where: { zernioId: item.id },
      select: { campaignId: true },
    });
    const isOurs = Boolean(existing?.campaignId);

    await this.prisma.zernioBroadcast.upsert({
      where: { zernioId: item.id },
      // Disparo do orgamind: NÃO toca os contadores (o webhook manda neles).
      update: isOurs ? meta : { ...meta, ...counters },
      // No CREATE os contadores entram sempre: a linha está nascendo, não há o
      // que preservar. (Um disparo do orgamind nasce pelo send service, não aqui.)
      create: { zernioId: item.id, channelId, ...meta, ...counters },
    });
  }
}

/** ISO do Zernio → Date. Data inválida vira null em vez de `Invalid Date`. */
function date(iso: string | null): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}
