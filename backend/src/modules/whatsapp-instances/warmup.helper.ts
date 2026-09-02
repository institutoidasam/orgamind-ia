/**
 * Warm-up ramp (anti-ban business rule).
 *
 * A freshly-paired WhatsApp number that immediately sends bulk gets logged out
 * or banned (observed in prod: a new number 401'd one second after its first
 * campaign send). To avoid that, every number auto-ramps its daily send limit
 * by age: new numbers start low and grow to the configured cap over ~5 days.
 *
 * Age is measured from `warmupStartedAt` — set when the number is PAIRED (not
 * when the instance row was created), because a number can be re-paired onto an
 * existing instance. See WhatsappInstancesService.list() (device-profile
 * reconcile) which stamps it on a phone-number change.
 */

/** Ramp steps: effective cap while `dayIndex <= maxDayIndex`. */
export const WARMUP_RAMP: ReadonlyArray<{ maxDayIndex: number; cap: number }> = [
  { maxDayIndex: 1, cap: 50 }, // day index 0-1 → dia 1-2
  { maxDayIndex: 2, cap: 100 }, // day index 2 → dia 3
  { maxDayIndex: 3, cap: 200 }, // day index 3 → dia 4
  { maxDayIndex: 4, cap: 350 }, // day index 4 → dia 5
];

const DAY_MS = 24 * 60 * 60 * 1000;

/** Full days elapsed since warm-up began, clamped to >= 0 (guards clock skew). */
function warmupDayIndex(warmupStartedAt: Date, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - warmupStartedAt.getTime()) / DAY_MS));
}

/**
 * Effective daily send cap = min(configuredCap, rampValue). A number past the
 * ramp (dayIndex >= 5) or with no warm-up timestamp uses the full configured
 * cap.
 */
export function warmupEffectiveCap(
  warmupStartedAt: Date | null | undefined,
  now: Date,
  configuredCap: number,
): number {
  if (!warmupStartedAt) return configuredCap;
  const d = warmupDayIndex(warmupStartedAt, now);
  const step = WARMUP_RAMP.find((s) => d <= s.maxDayIndex);
  const ramp = step ? step.cap : configuredCap; // d >= 5 → full
  return Math.min(configuredCap, ramp);
}

export type WarmupInfo = {
  /** The cap actually enforced today. */
  effectiveCap: number;
  /** Human 1-based day of warm-up (dia 1 = first day). 0 when not warming. */
  day: number;
  /** True while the ramp is still below the configured cap by age. */
  warming: boolean;
};

/** Display + enforcement info in one shot (single source of truth for UI/API). */
export function warmupInfo(
  warmupStartedAt: Date | null | undefined,
  now: Date,
  configuredCap: number,
): WarmupInfo {
  const effectiveCap = warmupEffectiveCap(warmupStartedAt, now, configuredCap);
  if (!warmupStartedAt) return { effectiveCap, day: 0, warming: false };
  const d = warmupDayIndex(warmupStartedAt, now);
  return { effectiveCap, day: d + 1, warming: d < 5 };
}
