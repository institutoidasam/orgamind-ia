import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  acquireCampaignLock,
  releaseCampaignLock,
  refreshCampaignLock,
  CAMPAIGN_LOCK_TTL_MS,
} from './campaign-lock.helper';

type RedisMock = {
  set: ReturnType<typeof vi.fn>;
  del: ReturnType<typeof vi.fn>;
  eval: ReturnType<typeof vi.fn>;
};

function makeRedisMock(): RedisMock {
  return {
    set: vi.fn(),
    del: vi.fn().mockResolvedValue(1),
    eval: vi.fn().mockResolvedValue(1),
  };
}

describe('acquireCampaignLock()', () => {
  let redis: RedisMock;

  beforeEach(() => {
    redis = makeRedisMock();
  });

  it('takes a NX PX lock keyed by campaign + the single resend action and returns a unique owner token', async () => {
    redis.set.mockResolvedValue('OK');

    const token = await acquireCampaignLock(redis as never, 'c1', 'resend');

    // A per-acquisition random token is returned (not a constant / boolean) so
    // release can verify ownership before deleting.
    expect(typeof token).toBe('string');
    expect(token).toBeTruthy();
    // The token IS the value stored under the lock key.
    expect(redis.set).toHaveBeenCalledWith(
      'campaign:lock:resend:c1',
      token,
      'PX',
      CAMPAIGN_LOCK_TTL_MS,
      'NX',
    );
  });

  it('returns null when the lock is already held (SET NX returns null)', async () => {
    redis.set.mockResolvedValue(null);
    const token = await acquireCampaignLock(redis as never, 'c1', 'resend');
    expect(token).toBeNull();
  });

  it('returns a distinct token per acquisition', async () => {
    redis.set.mockResolvedValue('OK');
    const t1 = await acquireCampaignLock(redis as never, 'c1', 'resend');
    const t2 = await acquireCampaignLock(redis as never, 'c1', 'resend');
    expect(t1).not.toBe(t2);
  });
});

describe('releaseCampaignLock()', () => {
  it('compare-and-deletes via Lua keyed by the acquisition token (never an unconditional DEL)', async () => {
    const redis = makeRedisMock();
    await releaseCampaignLock(redis as never, 'c1', 'resend', 'tok-123');

    // Must NOT unconditionally DEL — that can delete a lock a re-acquiring
    // caller now owns after our TTL expired mid-run.
    expect(redis.del).not.toHaveBeenCalled();
    expect(redis.eval).toHaveBeenCalledWith(
      expect.stringContaining('redis.call'),
      1,
      'campaign:lock:resend:c1',
      'tok-123',
    );
  });

  it('does not delete a lock owned by a different token (compare-and-delete no-op)', async () => {
    // Simulate the stored value belonging to another owner: the script sees a
    // mismatch and returns 0 (nothing deleted).
    const redis = makeRedisMock();
    redis.eval.mockResolvedValue(0);
    await expect(
      releaseCampaignLock(redis as never, 'c1', 'resend', 'other-token'),
    ).resolves.toBeUndefined();
    expect(redis.eval).toHaveBeenCalledTimes(1);
  });

  it('swallows eval errors (best-effort release)', async () => {
    const redis = makeRedisMock();
    redis.eval.mockRejectedValue(new Error('redis down'));
    await expect(
      releaseCampaignLock(redis as never, 'c1', 'resend', 'tok-123'),
    ).resolves.toBeUndefined();
  });
});

describe('refreshCampaignLock()', () => {
  it('compare-and-extends the TTL via Lua only while we still own the lock', async () => {
    const redis = makeRedisMock();
    await refreshCampaignLock(redis as never, 'c1', 'resend', 'tok-123');
    expect(redis.eval).toHaveBeenCalledWith(
      expect.stringContaining('pexpire'),
      1,
      'campaign:lock:resend:c1',
      'tok-123',
      String(CAMPAIGN_LOCK_TTL_MS),
    );
  });

  it('swallows eval errors (best-effort refresh)', async () => {
    const redis = makeRedisMock();
    redis.eval.mockRejectedValue(new Error('redis down'));
    await expect(
      refreshCampaignLock(redis as never, 'c1', 'resend', 'tok-123'),
    ).resolves.toBeUndefined();
  });
});
