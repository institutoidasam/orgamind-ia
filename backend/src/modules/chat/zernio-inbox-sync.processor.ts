import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import { ZernioInboxSyncService } from './zernio-inbox-sync.service';
import { ZernioSyncRunsService } from './zernio-sync-runs.service';
import { QUEUE_NAMES } from '../queue/queue.constants';

/** `{}` => tick repetível. Com `runId` => o clique do operador. */
type ZernioInboxSyncJob = {
  runId?: string;
  channelId?: string;
};

/**
 * Quanto esperar antes de tentar retomar um sync que cedeu o balde para uma
 * campanha. Uma campanha típica dura minutos; voltar a cada minuto é barato (uma
 * query) e devolve o sync ao trabalho logo depois do último disparo.
 */
const RESUME_AFTER_CAMPAIGN_MS = 60_000;

/**
 * O worker do sync do inbox do Zernio. Dois modos, uma fila:
 *
 * 1. **Tick repetível** (a cada ~10 min, registrado no worker.ts) — a REDE DE
 *    SEGURANÇA: pega o que foi enviado pelo painel do Zernio antes do webhook
 *    existir, e o que o webhook porventura perdeu (queda, deploy, assinatura
 *    recusada). Idempotente por construção (dedupe por wamid).
 * 2. **Run manual** (`{runId, channelId}`) — o botão "Sincronizar inbox". Antes
 *    isso rodava DENTRO da request do operador e terminava em HTTP 500 no 429 do
 *    Zernio. Agora roda aqui, com progresso persistido e retomada.
 *
 * `concurrency: 1` não é enfeite: cada requisição ao Zernio bebe do balde de
 * 60 req/min COMPARTILHADO com o envio. Dois jobs em paralelo dobrariam o
 * consumo — que é exatamente o que causou o incidente.
 */
@Processor(QUEUE_NAMES.ZERNIO_INBOX_SYNC, { concurrency: 1 })
export class ZernioInboxSyncProcessor extends WorkerHost {
  private readonly logger = new Logger(ZernioInboxSyncProcessor.name);

  constructor(
    private readonly sync: ZernioInboxSyncService,
    private readonly runs: ZernioSyncRunsService,
    @InjectQueue(QUEUE_NAMES.ZERNIO_INBOX_SYNC) private readonly queue: Queue,
  ) {
    super();
  }

  async process(job: Job<ZernioInboxSyncJob>): Promise<void> {
    const { runId, channelId } = job.data ?? {};
    if (runId && channelId) {
      await this.processRun(runId, channelId);
      return;
    }
    await this.processTick();
  }

  /** O clique do operador: um canal, com progresso e retomada. */
  private async processRun(runId: string, channelId: string): Promise<void> {
    const run = await this.runs.get(runId);
    // Run sumiu (canal apagado)? Nada a fazer — não é erro.
    if (!run) return;

    await this.runs.markRunning(runId);
    try {
      const result = await this.sync.syncChannel(channelId, {
        // Retomada: se a execução anterior morreu no meio, continua da página
        // onde parou em vez de refazer as ~100 conversas desde o começo.
        startCursor: run.cursor ?? undefined,
        onProgress: async (p) => {
          await this.runs.saveProgress(runId, {
            totalConversations: p.total,
            processedConversations: p.processed,
            importedMessages: p.imported,
            failedConversations: p.failed,
            cursor: p.nextCursor ?? null,
          });
        },
      });
      // Cedeu o balde para uma campanha: NÃO acabou (SUCCEEDED seria mentira) e
      // NÃO falhou. Fica PAUSED com o cursor guardado e volta sozinho quando o
      // envio liberar o balde. Ver `ZernioInboxSyncService.sendHasPriority`.
      if (result.paused) {
        await this.runs.markPaused(runId);
        await this.queue.add(
          'sync-inbox-manual',
          { runId, channelId },
          { delay: RESUME_AFTER_CAMPAIGN_MS },
        );
        this.logger.log(
          `zernio-inbox-sync run=${runId} canal=${channelId} PAUSADO ` +
            `(campanha ativa) em ${result.conversations} conversas — retoma em ${RESUME_AFTER_CAMPAIGN_MS}ms`,
        );
        return;
      }

      await this.runs.finish(runId, result);
      this.logger.log(
        `zernio-inbox-sync run=${runId} canal=${channelId} ` +
          `conversas=${result.conversations} mensagens=${result.messages} falhas=${result.failed}`,
      );
    } catch (err) {
      // AQUI morre o 500. A exceção (429 teimoso, 401, Zernio fora) não sobe
      // para lugar nenhum: vira um run FAILED com o motivo, que a TELA mostra.
      // O progresso já gravado permanece — a próxima execução retoma do cursor.
      await this.runs.fail(runId, err);
      this.logger.warn(
        { err, runId, channelId },
        'sync manual do inbox do Zernio falhou — run marcado como FAILED',
      );
    }
  }

  /** O tick repetível: todos os canais ZERNIO ativos. */
  private async processTick(): Promise<void> {
    const r = await this.sync.syncAllChannels();
    if (r.skipped) {
      this.logger.debug(`zernio-inbox-sync: pulado (${r.skipped})`);
      return;
    }
    // Silencioso quando não há novidade: um log por tick a cada 10 min com
    // "0 mensagens" só serviria para afogar o que importa.
    if (r.messages > 0 || r.failed > 0) {
      this.logger.log(
        `zernio-inbox-sync: canais=${r.channels} conversas=${r.conversations} mensagens=${r.messages} falhas=${r.failed}`,
      );
    }
  }
}
