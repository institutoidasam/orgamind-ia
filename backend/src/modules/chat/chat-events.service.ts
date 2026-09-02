import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type Redis from 'ioredis';
import { Subject } from 'rxjs';
import { REDIS_CLIENT } from '../../shared/redis/redis.module';

const CHANNEL = 'chat:events';

export type ChatEvent =
  | { type: 'message.created'; conversationId: string; instanceId: string; messageId?: string }
  | { type: 'message.status'; conversationId: string; instanceId: string; messageId: string; status: string }
  | { type: 'conversation.updated'; conversationId: string; instanceId: string }
  | { type: 'media.ready'; conversationId: string; instanceId: string; messageId: string };

@Injectable()
export class ChatEventsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ChatEventsService.name);
  private subscriber?: Redis;
  /** Hot stream of cross-process chat events for the SSE endpoint. */
  readonly stream$ = new Subject<ChatEvent>();

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async onModuleInit(): Promise<void> {
    // A subscriber connection can't issue normal commands, so duplicate the
    // shared client into a dedicated one just for SUBSCRIBE.
    this.subscriber = this.redis.duplicate();
    await this.subscriber.subscribe(CHANNEL);
    this.subscriber.on('message', (_channel: string, raw: string) => {
      try {
        this.stream$.next(JSON.parse(raw) as ChatEvent);
      } catch (err) {
        this.logger.warn({ err }, 'failed to parse chat event');
      }
    });
  }

  async onModuleDestroy(): Promise<void> {
    this.stream$.complete();
    try { await this.subscriber?.quit(); } catch { /* already closed */ }
  }

  async publish(event: ChatEvent): Promise<void> {
    await this.redis.publish(CHANNEL, JSON.stringify(event));
  }
}
