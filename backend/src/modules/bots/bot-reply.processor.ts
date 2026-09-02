import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { ClsService } from 'nestjs-cls';
import { BotReplyService } from './bot-reply.service';
import { QUEUE_NAMES, type BotReplyJob } from '../queue/queue.constants';
import { AUDIT_CLS_KEY, type AuditContext } from '../../shared/audit/audit.service';

@Processor(QUEUE_NAMES.BOT_REPLY, { concurrency: 5 })
export class BotReplyProcessor extends WorkerHost {
  private readonly logger = new Logger(BotReplyProcessor.name);

  constructor(
    private readonly svc: BotReplyService,
    private readonly cls: ClsService,
  ) {
    super();
  }

  async process(job: Job<BotReplyJob>): Promise<void> {
    return this.cls.run(() => {
      this.cls.set<AuditContext>(AUDIT_CLS_KEY, { correlationId: job.data.correlationId });
      return this.svc.handle(job.data.conversationId, job.data.messageId);
    });
  }
}
