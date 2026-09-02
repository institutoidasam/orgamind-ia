import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { ChatHistorySyncService } from './chat-history-sync.service';
import { QUEUE_NAMES, type ChatHistorySyncJob } from '../queue/queue.constants';

@Processor(QUEUE_NAMES.CHAT_HISTORY_SYNC, { concurrency: 1 })
export class ChatHistorySyncProcessor extends WorkerHost {
  private readonly logger = new Logger(ChatHistorySyncProcessor.name);
  constructor(private readonly sync: ChatHistorySyncService) { super(); }
  async process(job: Job<ChatHistorySyncJob>): Promise<void> {
    const { instanceId, maxPagesPerChat } = job.data;
    const r = await this.sync.syncInstance(instanceId, maxPagesPerChat);
    this.logger.log({ instanceId, ...r }, 'history sync job complete');
  }
}
