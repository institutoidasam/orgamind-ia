import { describe, it, expect } from 'vitest';
import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { Test } from '@nestjs/testing';
import type { Queue } from 'bullmq';
import { ChatModule } from './chat.module';
import { QUEUE_NAMES } from '../queue/queue.constants';

/**
 * Regression guard for the "bare registerQueue" finding (Médio › Chat/Inbox):
 * ChatModule must NOT re-register its BullMQ queues with bare options, because
 * a bare `registerQueue` shadows the global `defaultJobOptions` configured in
 * QueueModule (attempts: 3 for media-download). When shadowed, jobs get
 * attempts=1 and the media-download retry guard
 * (`attemptsMade + 1 < opts.attempts`) is permanently false — media goes FAILED
 * on the first transient error and never retries.
 *
 * This reads ChatModule's own `imports` metadata (the queue registrations under
 * test) and mounts them next to a real BullMQ root + the global queue config,
 * reproducing the exact production wiring, then asserts the resulting queue's
 * effective defaultJobOptions still carries the global retry policy.
 */
const REDIS_HOST = process.env.REDIS_HOST ?? 'redis';
const REDIS_PORT = Number(process.env.REDIS_PORT ?? 6379);

// ChatModule's import list contains the BullMQ DynamicModules it registers.
// Pull just the BullMQ-produced ones so we exercise ChatModule's real wiring.
const chatBullImports = (
  Reflect.getMetadata('imports', ChatModule) as unknown[]
).filter(
  (m): m is { module: unknown } =>
    typeof m === 'object' && m !== null && (m as { module?: unknown }).module === BullModule,
);

describe('ChatModule BullMQ queue registration', () => {
  it('does not shadow the global defaultJobOptions for the media-download queue (attempts must stay 3)', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        BullModule.forRoot({ connection: { host: REDIS_HOST, port: REDIS_PORT } }),
        // The global QueueModule config: attempts: 3 with exponential backoff.
        BullModule.registerQueue({
          name: QUEUE_NAMES.CHAT_MEDIA_DOWNLOAD,
          defaultJobOptions: {
            attempts: 3,
            backoff: { type: 'exponential', delay: 5_000 },
            removeOnComplete: { age: 3600, count: 500 },
            removeOnFail: { age: 7 * 86400 },
          },
        }),
        // ChatModule's own queue registrations — the thing under test.
        ...(chatBullImports as never[]),
      ],
    }).compile();

    const queue = moduleRef.get<Queue>(getQueueToken(QUEUE_NAMES.CHAT_MEDIA_DOWNLOAD));
    try {
      expect(queue.defaultJobOptions?.attempts).toBe(3);
    } finally {
      await queue.close();
      await moduleRef.close();
    }
  });
});
