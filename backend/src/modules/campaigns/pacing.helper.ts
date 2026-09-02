/**
 * Anti-ban pacing helpers for the campaign send pipeline.
 *
 * Evolution API has no native rate limiting and banning the production number
 * takes down real users. This module provides:
 *
 *  1. Per-instance Redis lock so only one campaign send runs at a time per
 *     instance (serialises concurrent BullMQ workers on the same instance).
 *  2. Jittered inter-message delay: sleep PACING_JITTER_MIN_MS … PACING_JITTER_MAX_MS
 *     before each send (randomised to avoid burst patterns WhatsApp detects).
 *  3. Burst pause: after roughly PACING_BURST_SIZE sends on an instance,
 *     sleep PACING_BURST_PAUSE_MS to mimic human-like behaviour.
 *
 * All tunables are read from process.env with safe production defaults.
 * Restart the worker container to pick up changes.
 *
 * Redis key layout (all volatile — safe to flush):
 *   pacing:send:lock:{instanceId}   — NX lock, TTL = LOCK_TTL_MS
 *   pacing:send:burst:{instanceId}  — INCR counter for burst detection
 */

import type Redis from 'ioredis';
import { Logger } from '@nestjs/common';
import { parseEnvNumber } from '../queue/env-number.helper';

// ─────────────────────────────────────────────────────────────────────────────
// Tunables — all env-overridable, worker restart required
//
// Parsed via parseEnvNumber (Number.isFinite-guarded): a bare
// `Number(process.env.X ?? default)` silently becomes NaN for a typo'd env
// value, which turns `setTimeout(resolve, NaN)` into ~0ms — i.e. the anti-ban
// pacing is silently DISABLED. The guard falls back to the default + warns.
// ─────────────────────────────────────────────────────────────────────────────

/** Minimum sleep between consecutive sends on the same instance (ms). */
export const PACING_JITTER_MIN_MS = parseEnvNumber(
  process.env.PACING_JITTER_MIN_MS,
  10_000,
  'PACING_JITTER_MIN_MS',
);

/** Maximum sleep between consecutive sends on the same instance (ms). */
export const PACING_JITTER_MAX_MS = parseEnvNumber(
  process.env.PACING_JITTER_MAX_MS,
  45_000,
  'PACING_JITTER_MAX_MS',
);

/** Number of sends per instance before a longer pause is injected. */
export const PACING_BURST_SIZE = parseEnvNumber(
  process.env.PACING_BURST_SIZE,
  100,
  'PACING_BURST_SIZE',
);

/** How long to pause (ms) after PACING_BURST_SIZE sends on one instance. */
export const PACING_BURST_PAUSE_MS = parseEnvNumber(
  process.env.PACING_BURST_PAUSE_MS,
  5 * 60 * 1000, // 5 minutes
  'PACING_BURST_PAUSE_MS',
);

/**
 * Redis lock TTL — must be at least as long as the longest possible hold
 * (jitter + burst pause + some headroom for slow sends).
 */
const LOCK_TTL_MS = PACING_JITTER_MAX_MS + PACING_BURST_PAUSE_MS + 30_000;

/**
 * When a lock is already held, the job will be delayed by this many ms before
 * BullMQ re-promotes it. Short enough that send order stays roughly intact.
 */
const LOCK_RETRY_DELAY_MS = 5_000;

// ─────────────────────────────────────────────────────────────────────────────
// Key helpers
// ─────────────────────────────────────────────────────────────────────────────

function lockKey(instanceId: string): string {
  return `pacing:send:lock:${instanceId}`;
}

function burstKey(instanceId: string): string {
  return `pacing:send:burst:${instanceId}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

export type AcquireResult =
  | { acquired: true; retryDelayMs?: never }
  | { acquired: false; retryDelayMs: number };

/**
 * Try to acquire the per-instance send lock.
 *
 * Returns `{ acquired: true }` when the lock was taken; the caller MUST call
 * `releasePacingLock` after the send (even on error) so the next job can run.
 *
 * Returns `{ acquired: false, retryDelayMs }` when another worker already
 * holds the lock; the job should be moved to delayed for retryDelayMs.
 */
export async function acquirePacingLock(
  redis: Redis,
  instanceId: string,
): Promise<AcquireResult> {
  const result = await redis.set(
    lockKey(instanceId),
    '1',
    'PX',
    LOCK_TTL_MS,
    'NX',
  );
  if (result === 'OK') {
    return { acquired: true };
  }
  return { acquired: false, retryDelayMs: LOCK_RETRY_DELAY_MS };
}

/**
 * Release the per-instance send lock and sleep a jittered delay so the
 * next worker won't pick up immediately.  The sleep happens while the lock
 * is still held, preventing another worker from running during the sleep.
 * The lock is always deleted at the end even if the sleep is skipped.
 *
 * @param redis     - shared ioredis client
 * @param instanceId
 * @param logger    - optional logger for debug output
 * @param sleepFn   - injectable sleep function (for testing)
 */
export async function releasePacingLock(
  redis: Redis,
  instanceId: string,
  logger?: Logger,
  sleepFn: (ms: number) => Promise<void> = defaultSleep,
): Promise<void> {
  const jitter =
    PACING_JITTER_MIN_MS +
    Math.floor(Math.random() * (PACING_JITTER_MAX_MS - PACING_JITTER_MIN_MS + 1));

  logger?.debug(
    `[pacing] instance=${instanceId} sleeping ${jitter}ms before unlocking`,
  );

  await sleepFn(jitter);
  await redis.del(lockKey(instanceId));
}

/**
 * Increment the burst counter for an instance and, if we have reached the
 * burst threshold, sleep PACING_BURST_PAUSE_MS and reset the counter.
 *
 * This is called AFTER a successful send, while the pacing lock is still held.
 *
 * @returns the new burst count (post-increment)
 */
export async function checkAndPauseBurst(
  redis: Redis,
  instanceId: string,
  logger?: Logger,
  sleepFn: (ms: number) => Promise<void> = defaultSleep,
): Promise<number> {
  const count = await redis.incr(burstKey(instanceId));

  // Set a generous TTL on first increment so the key self-cleans if the
  // worker dies and nobody ever resets it.  Subsequent INCRs don't reset the
  // TTL intentionally — the key should persist across the burst window.
  if (count === 1) {
    // 48h is well beyond any real campaign run; prevents orphaned keys.
    await redis.expire(burstKey(instanceId), 48 * 60 * 60);
  }

  if (count % PACING_BURST_SIZE === 0) {
    logger?.log(
      `[pacing] instance=${instanceId} reached burst threshold at ${count} sends — pausing ${PACING_BURST_PAUSE_MS}ms`,
    );
    await sleepFn(PACING_BURST_PAUSE_MS);
    // Reset the counter so the next PACING_BURST_SIZE sends get a fresh window.
    await redis.del(burstKey(instanceId));
    return 0;
  }

  return count;
}

// ─────────────────────────────────────────────────────────────────────────────
// Private helpers
// ─────────────────────────────────────────────────────────────────────────────

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
