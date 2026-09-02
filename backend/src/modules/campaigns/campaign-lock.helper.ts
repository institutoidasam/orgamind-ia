/**
 * Per-campaign mutual-exclusion lock for resend operations (A4).
 *
 * retryMessage / retryFailedMessages / redispatchCampaign each create new
 * BullMQ jobs (and redispatch creates a whole new batch of Message rows). Two
 * concurrent invocations — a double-click, or two operators — would otherwise
 * each create jobs/batches and message the same contacts twice. The A2 claim
 * stops a single message row from being SENT twice, but redispatch creates
 * *new* rows, so the only defence is to serialise these operations per
 * campaign.
 *
 * Same Redis SET NX PX style as pacing.helper, scoped per campaign + action.
 *
 * Redis key layout (volatile — safe to flush):
 *   campaign:lock:{action}:{campaignId}
 */

import { randomUUID } from 'crypto';
import type Redis from 'ioredis';

/**
 * Lock TTL. A self-expiring safety net so a crash mid-operation can never
 * permanently wedge a campaign's resend buttons. The lock is released
 * explicitly in a finally on the normal path; while a long dispatch is paging
 * the audience the holder REFRESHES it (see refreshCampaignLock) so the TTL can
 * never expire mid-run and admit a second, concurrent dispatch.
 */
export const CAMPAIGN_LOCK_TTL_MS = Number(
  process.env.CAMPAIGN_LOCK_TTL_MS ?? 60_000,
);

/**
 * Compare-and-delete: only DEL the key when its stored value still equals OUR
 * acquisition token. Without this ownership check, a holder whose lock expired
 * mid-operation (TTL elapsed, then re-acquired by someone else) would DEL the
 * NEW owner's lock in its finally — silently admitting a third, concurrent
 * caller. Running get+del as one Lua script makes the check atomic.
 */
const RELEASE_IF_OWNER = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end`;

/**
 * Compare-and-extend: bump the key's TTL only while we still own it (value
 * matches our token). The lock holder calls this periodically so a dispatch
 * that outlives CAMPAIGN_LOCK_TTL_MS keeps the mutex instead of losing it
 * mid-run (which would let a concurrent redispatch double-send the audience).
 */
const REFRESH_IF_OWNER = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("pexpire", KEYS[1], ARGV[2])
else
  return 0
end`;

// A single resend action per campaign: retryMessage, retryFailedMessages,
// redispatchCampaign and redispatchMessage all share ONE mutex per campaign.
// Distinct per-action keys let retry and redispatch run concurrently and double
// a contact (retry re-sends a FAILED row while redispatch creates a new row for
// the same contact). One key = strictly one resend operation at a time.
export type CampaignLockAction = 'resend';

function lockKey(action: CampaignLockAction, campaignId: string): string {
  return `campaign:lock:${action}:${campaignId}`;
}

/**
 * Try to acquire the per-campaign resend lock. Returns a per-acquisition random
 * OWNER TOKEN when taken (caller MUST pass it back to releaseCampaignLock /
 * refreshCampaignLock), or null when another invocation already holds it
 * (caller should reject the duplicate operation). The token is stored as the
 * lock's value so release can verify ownership before deleting.
 */
export async function acquireCampaignLock(
  redis: Redis,
  campaignId: string,
  action: CampaignLockAction,
): Promise<string | null> {
  const token = randomUUID();
  const result = await redis.set(
    lockKey(action, campaignId),
    token,
    'PX',
    CAMPAIGN_LOCK_TTL_MS,
    'NX',
  );
  return result === 'OK' ? token : null;
}

/**
 * Release the per-campaign resend lock — but only if we still own it (the
 * stored value matches `token`). Best-effort — never throws.
 */
export async function releaseCampaignLock(
  redis: Redis,
  campaignId: string,
  action: CampaignLockAction,
  token: string,
): Promise<void> {
  await redis
    .eval(RELEASE_IF_OWNER, 1, lockKey(action, campaignId), token)
    .catch(() => undefined);
}

/**
 * Extend the per-campaign resend lock's TTL while we still own it, so a long
 * dispatch can't lose the mutex mid-run. Best-effort — never throws.
 */
export async function refreshCampaignLock(
  redis: Redis,
  campaignId: string,
  action: CampaignLockAction,
  token: string,
): Promise<void> {
  await redis
    .eval(
      REFRESH_IF_OWNER,
      1,
      lockKey(action, campaignId),
      token,
      String(CAMPAIGN_LOCK_TTL_MS),
    )
    .catch(() => undefined);
}
