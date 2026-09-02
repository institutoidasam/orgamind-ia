import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  acquirePacingLock,
  releasePacingLock,
  checkAndPauseBurst,
  PACING_JITTER_MIN_MS,
  PACING_JITTER_MAX_MS,
  PACING_BURST_SIZE,
  PACING_BURST_PAUSE_MS,
} from './pacing.helper';

// Minimal Redis mock shape used by the helpers
type RedisMock = {
  set: ReturnType<typeof vi.fn>;
  del: ReturnType<typeof vi.fn>;
  incr: ReturnType<typeof vi.fn>;
  expire: ReturnType<typeof vi.fn>;
};

function makeRedisMock(): RedisMock {
  return {
    set: vi.fn(),
    del: vi.fn().mockResolvedValue(1),
    incr: vi.fn().mockResolvedValue(1),
    expire: vi.fn().mockResolvedValue(1),
  };
}

/** A sleep stub that records calls without actually waiting. */
function makeSleepSpy() {
  const calls: number[] = [];
  const fn = (ms: number) => {
    calls.push(ms);
    return Promise.resolve();
  };
  return { fn, calls };
}

describe('acquirePacingLock()', () => {
  let redis: RedisMock;

  beforeEach(() => {
    redis = makeRedisMock();
  });

  it('returns acquired=true when Redis SET NX succeeds (returns "OK")', async () => {
    redis.set.mockResolvedValue('OK');

    const result = await acquirePacingLock(redis as never, 'inst-1');

    expect(result.acquired).toBe(true);
    expect(redis.set).toHaveBeenCalledWith(
      'pacing:send:lock:inst-1',
      '1',
      'PX',
      expect.any(Number), // TTL
      'NX',
    );
  });

  it('returns acquired=false with retryDelayMs when lock is already held (SET returns null)', async () => {
    redis.set.mockResolvedValue(null);

    const result = await acquirePacingLock(redis as never, 'inst-2');

    expect(result.acquired).toBe(false);
    if (!result.acquired) {
      expect(result.retryDelayMs).toBeGreaterThan(0);
    }
  });

  it('uses different Redis keys for different instance IDs', async () => {
    redis.set.mockResolvedValue('OK');

    await acquirePacingLock(redis as never, 'inst-a');
    await acquirePacingLock(redis as never, 'inst-b');

    const keys = redis.set.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(keys[0]).toContain('inst-a');
    expect(keys[1]).toContain('inst-b');
    expect(keys[0]).not.toBe(keys[1]);
  });
});

describe('releasePacingLock()', () => {
  let redis: RedisMock;

  beforeEach(() => {
    redis = makeRedisMock();
  });

  it('sleeps a value within [JITTER_MIN, JITTER_MAX] before deleting the key', async () => {
    const sleep = makeSleepSpy();

    await releasePacingLock(redis as never, 'inst-x', undefined, sleep.fn);

    expect(sleep.calls).toHaveLength(1);
    const slept = sleep.calls[0];
    expect(slept).toBeGreaterThanOrEqual(PACING_JITTER_MIN_MS);
    expect(slept).toBeLessThanOrEqual(PACING_JITTER_MAX_MS);

    expect(redis.del).toHaveBeenCalledWith('pacing:send:lock:inst-x');
  });

  it('deletes the key AFTER the sleep (not before)', async () => {
    const order: string[] = [];
    const sleep = {
      fn: async (ms: number) => {
        void ms;
        order.push('sleep');
      },
    };
    redis.del.mockImplementation(async () => {
      order.push('del');
      return 1;
    });

    await releasePacingLock(redis as never, 'inst-y', undefined, sleep.fn);

    expect(order).toEqual(['sleep', 'del']);
  });
});

describe('checkAndPauseBurst()', () => {
  let redis: RedisMock;

  beforeEach(() => {
    redis = makeRedisMock();
  });

  it('increments the burst counter and returns the new count', async () => {
    redis.incr.mockResolvedValue(42);
    const sleep = makeSleepSpy();

    const count = await checkAndPauseBurst(redis as never, 'inst-1', undefined, sleep.fn);

    expect(count).toBe(42);
    expect(redis.incr).toHaveBeenCalledWith('pacing:send:burst:inst-1');
    expect(sleep.calls).toHaveLength(0); // no pause yet
  });

  it('sets a TTL on the first increment (count === 1)', async () => {
    redis.incr.mockResolvedValue(1);
    const sleep = makeSleepSpy();

    await checkAndPauseBurst(redis as never, 'inst-ttl', undefined, sleep.fn);

    expect(redis.expire).toHaveBeenCalledWith('pacing:send:burst:inst-ttl', expect.any(Number));
  });

  it('does NOT set TTL when count > 1', async () => {
    redis.incr.mockResolvedValue(5);
    const sleep = makeSleepSpy();

    await checkAndPauseBurst(redis as never, 'inst-no-ttl', undefined, sleep.fn);

    expect(redis.expire).not.toHaveBeenCalled();
  });

  it('sleeps PACING_BURST_PAUSE_MS and resets counter when count hits PACING_BURST_SIZE', async () => {
    redis.incr.mockResolvedValue(PACING_BURST_SIZE);
    const sleep = makeSleepSpy();

    const count = await checkAndPauseBurst(redis as never, 'inst-burst', undefined, sleep.fn);

    expect(sleep.calls).toHaveLength(1);
    expect(sleep.calls[0]).toBe(PACING_BURST_PAUSE_MS);
    // Counter reset after burst pause
    expect(redis.del).toHaveBeenCalledWith('pacing:send:burst:inst-burst');
    // Returns 0 after reset
    expect(count).toBe(0);
  });

  it('sleeps on any multiple of PACING_BURST_SIZE', async () => {
    redis.incr.mockResolvedValue(PACING_BURST_SIZE * 2);
    const sleep = makeSleepSpy();

    await checkAndPauseBurst(redis as never, 'inst-2x', undefined, sleep.fn);

    expect(sleep.calls).toHaveLength(1);
  });

  it('does NOT sleep when count is just below PACING_BURST_SIZE', async () => {
    redis.incr.mockResolvedValue(PACING_BURST_SIZE - 1);
    const sleep = makeSleepSpy();

    await checkAndPauseBurst(redis as never, 'inst-below', undefined, sleep.fn);

    expect(sleep.calls).toHaveLength(0);
    expect(redis.del).not.toHaveBeenCalled();
  });
});

describe('pacing constants (env defaults)', () => {
  it('PACING_JITTER_MIN_MS is less than PACING_JITTER_MAX_MS', () => {
    expect(PACING_JITTER_MIN_MS).toBeLessThan(PACING_JITTER_MAX_MS);
  });

  it('PACING_JITTER_MIN_MS >= 0', () => {
    expect(PACING_JITTER_MIN_MS).toBeGreaterThanOrEqual(0);
  });

  it('PACING_BURST_SIZE > 0', () => {
    expect(PACING_BURST_SIZE).toBeGreaterThan(0);
  });

  it('PACING_BURST_PAUSE_MS > 0', () => {
    expect(PACING_BURST_PAUSE_MS).toBeGreaterThan(0);
  });
});
