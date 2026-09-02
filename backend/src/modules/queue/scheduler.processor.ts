import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { randomUUID } from 'crypto';
import { CampaignsService } from '../campaigns/campaigns.service';
import { QUEUE_NAMES } from './queue.constants';
import { AUDIT_CLS_KEY, type AuditContext } from '../../shared/audit/audit.service';

/**
 * Scheduler tick. Runs once per minute (scheduled by worker.ts as a
 * repeatable job). Looks for campaigns whose `nextRunAt` <= now and
 * dispatches them.
 */
@Processor(QUEUE_NAMES.CAMPAIGN_SCHEDULER, { concurrency: 1 })
export class SchedulerProcessor extends WorkerHost {
  private readonly logger = new Logger(SchedulerProcessor.name);

  constructor(
    private readonly campaigns: CampaignsService,
    private readonly cls: ClsService,
  ) {
    super();
  }

  async process(): Promise<void> {
    // Bind a fresh correlationId per tick and run the entire dispatch loop
    // inside CLS so audit events emitted from CampaignsService.runScheduled
    // (and the Message rows it creates) carry a coherent identifier.
    return this.cls.run(async () => {
      this.cls.set<AuditContext>(AUDIT_CLS_KEY, {
        correlationId: `sched-${randomUUID()}`,
      });

      const now = new Date();
      const due = await this.campaigns.findDueScheduledCampaigns(now);
      if (due.length === 0) return;

      this.logger.log(`Scheduler tick: ${due.length} campaign(s) due`);
      for (const c of due) {
        try {
          const r = await this.campaigns.runScheduled(c.id);
          this.logger.log(
            `Dispatched scheduled campaign ${c.id} (${c.name}): queued=${r.queued}`,
          );
        } catch (err) {
          this.logger.error({ err, campaignId: c.id }, 'Scheduled run failed');
        }
      }
    });
  }
}
