import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { WhatsappInstancesRepository } from './whatsapp-instances.repository';
import { WhatsappProvidersRepository } from '../whatsapp-providers/whatsapp-providers.repository';
import { EvolutionApiAdapter } from '../whatsapp-providers/adapters/evolution-api.adapter';
import { QUEUE_NAMES } from '../queue/queue.constants';

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
 */
@Processor(QUEUE_NAMES.CONNECTION_RECONCILER, { concurrency: 1 })
export class ConnectionReconcilerService extends WorkerHost {
  private readonly logger = new Logger(ConnectionReconcilerService.name);

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
          { err, instanceId: instance.id, evolutionInstanceName: instance.evolutionInstanceName },
          'reconciler: unexpected error processing instance (skipping)',
        );
      }
    }

    if (instances.length > 0) {
      this.logger.log(
        `connection-reconciler: total=${instances.length} reconciled=${reconciled} skipped=${skipped} failed=${failed}`,
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
