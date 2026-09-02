import { describe, it, expect, vi } from 'vitest';
import type Redis from 'ioredis';
import { RedisModule } from './redis.module';

describe('RedisModule shutdown hook', () => {
  it('implements OnApplicationShutdown as an INSTANCE method (not static)', () => {
    // The framework only calls lifecycle hooks on the module/provider
    // *instance*. A static hook with a hand-rolled signature is never invoked,
    // so the singleton Redis client leaks on shutdown.
    const proto = RedisModule.prototype as Record<string, unknown>;
    expect(typeof proto.onApplicationShutdown).toBe('function');
  });

  it('quits the injected Redis client on application shutdown', async () => {
    const client = { quit: vi.fn().mockResolvedValue('OK') } as unknown as Redis;
    const mod = new RedisModule(client);

    await mod.onApplicationShutdown('SIGTERM');

    expect(client.quit).toHaveBeenCalledTimes(1);
  });

  it('swallows errors from quit() so shutdown never throws', async () => {
    const client = {
      quit: vi.fn().mockRejectedValue(new Error('already closed')),
    } as unknown as Redis;
    const mod = new RedisModule(client);

    await expect(mod.onApplicationShutdown('SIGINT')).resolves.toBeUndefined();
    expect(client.quit).toHaveBeenCalledTimes(1);
  });
});
