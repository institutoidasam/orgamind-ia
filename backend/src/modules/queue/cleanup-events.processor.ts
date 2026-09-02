import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { subDays } from 'date-fns';
import { WhatsappProvidersRepository } from '../whatsapp-providers/whatsapp-providers.repository';
import { QUEUE_NAMES } from './queue.constants';

/**
 * Daily maintenance job that deletes WhatsappConnectionEvent rows older than
 * 7 days. Keeps the table small — at ~50 webhook events/day per instance, we
 * accumulate ~350 rows before this runs, well within Postgres index efficiency.
 *
 * Registered as a BullMQ repeatable (every 24h) in queue.module.ts.
 */
@Processor(QUEUE_NAMES.CLEANUP_EVENTS, { concurrency: 1 })
export class CleanupEventsProcessor extends WorkerHost {
  private readonly logger = new Logger(CleanupEventsProcessor.name);

  constructor(private readonly connectionRepo: WhatsappProvidersRepository) {
    super();
  }

  async process(): Promise<void> {
    const cutoff = subDays(new Date(), 7);
    try {
      const deleted = await this.connectionRepo.deleteOldEvents(cutoff);
      this.logger.log(`cleanup-events: deleted ${deleted} events older than ${cutoff.toISOString()}`);
    } catch (err) {
      // Log and swallow — a failed cleanup is non-fatal. BullMQ will retry
      // on the next daily tick.
      this.logger.error({ err }, 'cleanup-events: deleteOldEvents failed');
    }
  }
}
