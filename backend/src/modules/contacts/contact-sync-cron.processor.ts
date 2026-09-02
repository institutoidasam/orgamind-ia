import { Processor, WorkerHost, InjectQueue } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Queue } from 'bullmq';
import { ContactsRepository } from './contacts.repository';
import { AuditService } from '../../shared/audit/audit.service';
import { QUEUE_NAMES, type ContactSyncJob } from '../queue/queue.constants';
import type { Env } from '../../shared/config/env.schema';

const CHUNK_SIZE = 50;
const PER_RUN_LIMIT = 5000;

/**
 * BullMQ repeatable that runs daily and kicks off ContactSyncProcessor jobs
 * for contacts whose whatsappCheckedAt is older than 30 days. Capped at 5000
 * per run so we don't spike the worker — if more remain, tomorrow's tick
 * picks them up.
 */
@Processor(QUEUE_NAMES.CONTACT_SYNC_CRON, { concurrency: 1 })
export class ContactSyncCronProcessor extends WorkerHost {
  private readonly logger = new Logger(ContactSyncCronProcessor.name);

  constructor(
    private readonly repo: ContactsRepository,
    private readonly audit: AuditService,
    @InjectQueue(QUEUE_NAMES.CONTACT_SYNC)
    private readonly syncQueue: Queue<ContactSyncJob>,
    private readonly config: ConfigService<Env>,
  ) {
    super();
  }

  /**
   * Defesa em profundidade — o boot (`worker.ts:scheduleContactSyncCron`) já
   * tenta desarmar o repetível quando `CONTACT_SYNC_CRON_ENABLED` é falso,
   * mas aquele `removeRepeatable` roda dentro de um try/catch que ENGOLE erro
   * (`worker.ts:~233`, só loga). Se aquela chamada falhar, o repetível
   * `0 6 * * *` que produção já tem ARMADO sobrevive, e o BullMQ dispara este
   * `process()` de qualquer jeito — a varredura em massa (spec B.5: risco de
   * bloqueio, decisão é o operador clicar, não um cron silencioso) rodaria
   * mesmo com a flag desligada. Checar a flag de novo AQUI, na entrada do
   * job, é a segunda trava — independente da primeira ter funcionado ou não.
   */
  async process(): Promise<void> {
    const enabled =
      this.config.get('CONTACT_SYNC_CRON_ENABLED', { infer: true }) === true;
    if (!enabled) {
      this.logger.log('cron de validação desligado — job ignorado');
      return;
    }

    const ids = await this.repo.findIdsForSync('stale', PER_RUN_LIMIT);
    if (ids.length === 0) {
      this.logger.debug('contact-sync cron: nothing stale to refresh');
      await this.audit.log(
        'contact.sync_periodic_kickoff',
        'Contact',
        undefined,
        { selectedCount: 0 },
      );
      return;
    }

    // Track enqueue failures per chunk so the audit captures BOTH the count
    // selected AND the count actually enqueued — a Redis blip mid-loop would
    // otherwise abort silently and leave the audit row missing for the day.
    let enqueued = 0;
    for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
      const chunk = ids.slice(i, i + CHUNK_SIZE);
      try {
        await this.syncQueue.add('sync', {
          contactIds: chunk,
          triggeredBy: 'periodic',
        });
        enqueued += 1;
      } catch (err) {
        this.logger.warn(
          { err, chunkSize: chunk.length },
          'contact-sync cron: failed to enqueue chunk',
        );
      }
    }

    this.logger.log(
      `contact-sync cron: enqueued ${enqueued}/${Math.ceil(ids.length / CHUNK_SIZE)} batches (${ids.length} contacts selected)`,
    );
    await this.audit.log(
      'contact.sync_periodic_kickoff',
      'Contact',
      undefined,
      { selectedCount: ids.length, enqueuedBatches: enqueued },
    );
  }
}
