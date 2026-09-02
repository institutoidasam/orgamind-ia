import { Body, Controller, Post } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { Roles } from '../auth/decorators/roles.decorator';
import { QUEUE_NAMES, type ChatHistorySyncJob } from '../queue/queue.constants';

const syncSchema = z.object({ instanceId: z.string().min(1) });
class SyncDto extends createZodDto(syncSchema) {}

@Controller('chat/sync')
export class ChatSyncController {
  constructor(@InjectQueue(QUEUE_NAMES.CHAT_HISTORY_SYNC) private readonly queue: Queue<ChatHistorySyncJob>) {}

  @Roles('ADMIN')
  @Post()
  async sync(@Body() body: SyncDto): Promise<{ enqueued: boolean }> {
    await this.queue.add('sync', { instanceId: body.instanceId });
    return { enqueued: true };
  }
}
