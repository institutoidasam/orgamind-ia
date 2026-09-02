import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import { QUEUE_NAMES } from '../queue/queue.constants';
import { ZernioBroadcastSyncService } from './zernio-broadcast-sync.service';
import { ZernioAnalyticsSyncService } from './zernio-analytics-sync.service';

/**
 * `{}` => o tick de 15 min / o botão do ADMIN.
 * `{startSkip}` => a retomada de um sync que cedeu o balde para uma campanha.
 */
export type ZernioBroadcastSyncJob = {
  startSkip?: number;
};

/** O job DIÁRIO de snapshot de volume — mesma fila, nome diferente. */
export const ZERNIO_ANALYTICS_JOB = 'sync-analytics';

/**
 * Quanto esperar antes de retomar um sync que cedeu o balde. Uma campanha típica
 * dura minutos; voltar a cada minuto é barato (uma query) e devolve o sync ao
 * trabalho logo depois do último disparo.
 */
const RESUME_AFTER_CAMPAIGN_MS = 60_000;

/**
 * O worker do ZD. Dois jobs, UMA fila:
 *
 * 1. **`sync-broadcasts`** (tick de 15 min, retomada e botão do ADMIN) — o
 *    espelho dos disparos.
 * 2. **`sync-analytics`** (tick diário) — a fotografia do volume de mensagens.
 *
 * Por que a MESMA fila para dois jobs de períodos diferentes: os dois bebem do
 * MESMO balde de 60 req/min do Zernio, que é o mesmo do ENVIO. Com
 * `concurrency: 1`, uma fila só garante que eles nunca rodem em paralelo
 * dobrando o consumo — o que, em duas filas, aconteceria toda vez que os ticks
 * coincidissem. Foi exatamente esse tipo de concorrência que causou o incidente
 * de produção do inbox-sync (429 → HTTP 500 → zero conversas importadas).
 */
@Processor(QUEUE_NAMES.ZERNIO_BROADCAST_SYNC, { concurrency: 1 })
export class ZernioBroadcastSyncProcessor extends WorkerHost {
  private readonly logger = new Logger(ZernioBroadcastSyncProcessor.name);

  constructor(
    private readonly sync: ZernioBroadcastSyncService,
    private readonly analytics: ZernioAnalyticsSyncService,
    @InjectQueue(QUEUE_NAMES.ZERNIO_BROADCAST_SYNC)
    private readonly queue: Queue,
  ) {
    super();
  }

  async process(job: Job<ZernioBroadcastSyncJob>): Promise<void> {
    if (job.name === ZERNIO_ANALYTICS_JOB) {
      await this.processSnapshots();
      return;
    }
    await this.processBroadcasts(job);
  }

  /** O tick diário: o volume de mensagens dos últimos 7 dias, por canal. */
  private async processSnapshots(): Promise<void> {
    const res = await this.analytics.syncSnapshots();
    if (res.reason) {
      this.logger.debug(`zernio-analytics-sync: pulado (${res.reason})`);
      return;
    }
    if (res.paused) {
      // Diário e sem retomada por offset: o próximo tick relê a janela inteira
      // de 7 dias e recupera sozinho o que este deixou de gravar.
      this.logger.log('zernio-analytics-sync adiado (campanha ativa)');
      return;
    }
    if (res.days > 0 || res.failed > 0) {
      this.logger.log(
        `zernio-analytics-sync: dias=${res.days} canais=${res.channels} falhas=${res.failed}`,
      );
    }
  }

  private async processBroadcasts(
    job: Job<ZernioBroadcastSyncJob>,
  ): Promise<void> {
    const startSkip = job.data?.startSkip;
    const res = await this.sync.syncBroadcasts({ startSkip });

    if (res.reason) {
      this.logger.debug(`zernio-broadcast-sync: pulado (${res.reason})`);
      return;
    }

    // Cedeu o balde para uma campanha: NÃO acabou. Reagenda a si mesmo a partir
    // do offset onde parou, em vez de recomeçar do zero no próximo tick.
    if (res.paused) {
      await this.queue.add(
        'sync-broadcasts-resume',
        { startSkip: res.resumeSkip },
        { delay: RESUME_AFTER_CAMPAIGN_MS },
      );
      this.logger.log(
        `zernio-broadcast-sync PAUSADO (campanha ativa) em skip=${res.resumeSkip} — ` +
          `retoma em ${RESUME_AFTER_CAMPAIGN_MS}ms`,
      );
      return;
    }

    // Silencioso quando não há novidade: um log a cada 15 min com "0 disparos"
    // só afogaria o que importa.
    if (res.broadcasts > 0 || res.failed > 0 || res.skipped > 0) {
      this.logger.log(
        `zernio-broadcast-sync: disparos=${res.broadcasts} pulados=${res.skipped} ` +
          `falhas=${res.failed} canais=${res.channels}`,
      );
    }
  }
}
