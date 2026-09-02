import {
  Global,
  Inject,
  Module,
  type OnApplicationShutdown,
  type Provider,
} from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import type { Env } from '../config/env.schema';

export const REDIS_CLIENT = Symbol.for('REDIS_CLIENT');

const redisProvider: Provider = {
  provide: REDIS_CLIENT,
  inject: [ConfigService],
  useFactory: (config: ConfigService<Env>) => {
    // One shared client for the API/worker process. Previously each service
    // (webhooks, refresh, metrics) instantiated its own ioredis connection,
    // which on connection-capped Redis tiers (free Redis Cloud = 30 conns)
    // ate budget that BullMQ also needs.
    return new Redis({
      host: config.get('REDIS_HOST', { infer: true }),
      port: config.get('REDIS_PORT', { infer: true }),
      maxRetriesPerRequest: null,
      lazyConnect: true,
    });
  },
};

@Global()
@Module({
  imports: [ConfigModule],
  providers: [redisProvider],
  exports: [REDIS_CLIENT],
})
export class RedisModule implements OnApplicationShutdown {
  // Nest only invokes lifecycle hooks on the *instance* of a module/provider,
  // with the signature `onApplicationShutdown(signal?: string)`. The previous
  // `static onApplicationShutdown(client)` was never called, so the singleton
  // Redis connection was never closed gracefully (leaked on every SIGTERM).
  constructor(
    @Inject(REDIS_CLIENT) private readonly client: Redis | undefined,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.quit();
    } catch {
      // ignore — client may already be closed
    }
  }
}
