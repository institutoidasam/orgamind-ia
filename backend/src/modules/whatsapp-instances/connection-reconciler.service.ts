import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { WhatsappInstancesRepository } from './whatsapp-instances.repository';
import { WhatsappProvidersRepository } from '../whatsapp-providers/whatsapp-providers.repository';
import { EvolutionApiAdapter } from '../whatsapp-providers/adapters/evolution-api.adapter';
import { QUEUE_NAMES } from '../queue/queue.constants';

/**
 * E1: intervalo mínimo entre duas conferências do webhook de uma mesma
 * instância (por processo). O primeiro ciclo depois do boot sempre confere,
 * porque o mapa de últimas conferências começa vazio.
 */
export const WEBHOOK_CHECK_INTERVAL_MS = 10 * 60_000;

/**
 * Connection-state reconciler.
 *
 * Evolution's CONNECTION_UPDATE webhooks are unreliable: they arrive
 * out-of-order, can be stale, and a manual logout / forced delete fires no
 * 'close' event at all. The stored lastConnectionState therefore drifts from
 * reality.
 *
 * This processor runs every ~30 s as a BullMQ repeatable job (registered in
 * worker.ts). For every active instance it polls
 * `EvolutionApiAdapter.getLiveConnectionState()` (socket-free HTTP) and
 * writes a corrective WhatsappConnectionEvent when the live state differs
 * from the most-recently stored state.
 *
 * Rules:
 *  - Only 'open' and 'close' are definitive; 'connecting' and null (poll
 *    failure) are skipped — they are transient or unreachable.
 *  - A corrective event is written only when the live state differs from the
 *    last stored state (or there is no stored state for the instance).
 *  - Each instance is processed inside its own try/catch: one failure must
 *    not abort the loop for the remaining instances.
 *  - Depois do reconcile de estado, o webhook da instância é conferido (e
 *    re-armado se divergir) no máximo uma vez a cada WEBHOOK_CHECK_INTERVAL_MS,
 *    com o próprio try/catch: falha só é logada.
 */
@Processor(QUEUE_NAMES.CONNECTION_RECONCILER, { concurrency: 1 })
export class ConnectionReconcilerService extends WorkerHost {
  private readonly logger = new Logger(ConnectionReconcilerService.name);
  // instanceId -> epoch ms da última conferência do webhook (mapa por processo).
  private readonly lastWebhookCheck = new Map<string, number>();

  constructor(
    private readonly instancesRepo: WhatsappInstancesRepository,
    private readonly providersRepo: WhatsappProvidersRepository,
    private readonly evolutionAdapter: EvolutionApiAdapter,
  ) {
    super();
  }

  async process(): Promise<void> {
    const instances = await this.instancesRepo.listActive();

    let reconciled = 0;
    let skipped = 0;
    let failed = 0;

    for (const instance of instances) {
      // Non-Evolution channels (Twilio/Zernio/Meta) have no Evolution
      // connection state to reconcile — skip, not a failure.
      if (!instance.evolutionInstanceName) {
        skipped++;
        continue;
      }
      try {
        const changed = await this.reconcileOne(instance.id, instance.evolutionInstanceName);
        if (changed) {
          reconciled++;
        } else {
          skipped++;
        }
      } catch (err) {
        failed++;
        this.logger.warn(
          {
            instanceId: instance.id,
            evolutionInstanceName: instance.evolutionInstanceName,
            message: err instanceof Error ? err.message : String(err),
          },
          'reconciler: unexpected error processing instance (skipping)',
        );
      }
      await this.checkWebhook(instance.id, instance.evolutionInstanceName);
    }

    // Poda o mapa de conferência: instâncias fora do conjunto ativo deste ciclo saem dele.
    const activeIds = new Set(instances.map((i) => i.id));
    for (const id of this.lastWebhookCheck.keys()) {
      if (!activeIds.has(id)) this.lastWebhookCheck.delete(id);
    }

    if (instances.length > 0) {
      this.logger.log(
        `connection-reconciler: total=${instances.length} reconciled=${reconciled} skipped=${skipped} failed=${failed}`,
      );
    }
  }

  /**
   * E1: confere/re-arma o webhook da instância, no máximo uma vez a cada
   * WEBHOOK_CHECK_INTERVAL_MS. Nunca lança: o log leva só ids e status, sem o
   * erro do axios (carrega a apikey).
   */
  private async checkWebhook(
    instanceId: string,
    evolutionInstanceName: string,
  ): Promise<void> {
    const now = Date.now();
    const last = this.lastWebhookCheck.get(instanceId) ?? -Infinity;
    if (now - last < WEBHOOK_CHECK_INTERVAL_MS) return;
    this.lastWebhookCheck.set(instanceId, now);
    try {
      await this.evolutionAdapter.ensureWebhookArmed(evolutionInstanceName);
    } catch (err) {
      const { response } = err as { response?: { status?: number } };
      this.logger.warn(
        { instanceId, evolutionInstanceName, httpStatus: response?.status },
        'reconciler: falha ao conferir o webhook (seguindo)',
      );
    }
  }

  /**
   * Reconciles a single instance.
   * Returns true when a corrective event was persisted, false otherwise.
   */
  async reconcileOne(instanceId: string, evolutionInstanceName: string): Promise<boolean> {
    const liveState = await this.evolutionAdapter.getLiveConnectionState(evolutionInstanceName);

    // Skip transient or unreachable states — we can only act on definitive ones.
    if (liveState !== 'open' && liveState !== 'close') {
      return false;
    }

    const lastEvent = await this.providersRepo.findLastEvent(instanceId);
    const storedState = lastEvent?.state ?? null;

    if (storedState === liveState) {
      // Already in sync — nothing to do.
      return false;
    }

    this.logger.log(
      { instanceId, evolutionInstanceName, storedState, liveState },
      'connection-reconciler: drift detected — writing corrective event',
    );

    await this.providersRepo.createEvent({
      instanceId,
      state: liveState,
      reasonCode: null,
      occurredAt: new Date(),
    });

    return true;
  }
}
