import { fromZonedTime, toZonedTime } from 'date-fns-tz';
import {
  addDays,
  addMinutes,
  isAfter,
  setHours,
  setMilliseconds,
  setMinutes,
  setSeconds,
} from 'date-fns';
import type { ScheduleConfig } from '../../schemas/contracts/schedule.schema';

/**
 * Narrowed config per schedule type — lets each helper receive exactly the
 * variant it handles without re-discriminating on `type`.
 */
type ConfigOf<T extends ScheduleConfig['type']> = Extract<
  ScheduleConfig,
  { type: T }
>;

/** A per-type computation: given the narrowed config + context, return the next run (or null). */
type RunComputer<T extends ScheduleConfig['type']> = (
  config: ConfigOf<T>,
  now: Date,
  timezone: string,
  previousRun: Date | null,
) => Date | null;

/** Set a zoned "wall clock" date to HH:mm:00.000 (helper shared by DAILY_AT/WEEKLY). */
function atHourMinute(local: Date, hh: number, mm: number): Date {
  return setSeconds(setMilliseconds(setMinutes(setHours(local, hh), mm), 0), 0);
}

// IMMEDIATE — manual dispatch only, never auto-scheduled.
function computeImmediate(): Date | null {
  return null;
}

function computeOnceAt(
  config: ConfigOf<'ONCE_AT'>,
  now: Date,
  _timezone: string,
  previousRun: Date | null,
): Date | null {
  const target = new Date(config.runAt);
  // create() validates `target` is in the future at creation time. Once
  // `now` passes `target` we're done — regardless of whether `markRan`
  // landed. Previously this branch required `previousRun` to be set, so a
  // crash between enqueue and `markRan` left `previousRun = null` and the
  // scheduler re-fired the past `nextRunAt` on every tick.
  if (previousRun && isAfter(previousRun, target)) return null;
  if (isAfter(now, target)) return null;
  return target;
}

function computeDailyAt(
  config: ConfigOf<'DAILY_AT'>,
  now: Date,
  timezone: string,
  previousRun: Date | null,
): Date | null {
  const [hh, mm] = config.time.split(':').map(Number);
  // Build "today at HH:mm" in target timezone
  const local = toZonedTime(now, timezone);
  let candidate = atHourMinute(local, hh, mm);
  // Convert back to UTC for comparison
  let utcCandidate = fromZonedTime(candidate, timezone);
  // Skip past times
  if (!isAfter(utcCandidate, now) || (previousRun && !isAfter(utcCandidate, previousRun))) {
    candidate = addDays(candidate, 1);
    utcCandidate = fromZonedTime(candidate, timezone);
  }
  return utcCandidate;
}

function computeWeekly(
  config: ConfigOf<'WEEKLY'>,
  now: Date,
  timezone: string,
  previousRun: Date | null,
): Date | null {
  const [hh, mm] = config.time.split(':').map(Number);
  const local = toZonedTime(now, timezone);
  // Try today through next 7 days, find the closest weekday match in config
  const days = new Set(config.weekdays);
  for (let offset = 0; offset < 8; offset++) {
    const day = addDays(local, offset);
    if (!days.has(day.getDay() as 0)) continue;
    const candidate = atHourMinute(day, hh, mm);
    const utcCandidate = fromZonedTime(candidate, timezone);
    if (
      isAfter(utcCandidate, now) &&
      (!previousRun || isAfter(utcCandidate, previousRun))
    ) {
      return utcCandidate;
    }
  }
  // Should not happen if weekdays.length >= 1, but fallback:
  return null;
}

function computeInterval(
  config: ConfigOf<'INTERVAL'>,
  now: Date,
  _timezone: string,
  previousRun: Date | null,
): Date | null {
  const base = previousRun ?? now;
  let next = addMinutes(base, config.everyMinutes);
  // Make sure we don't return a past timestamp on first run after a long downtime
  if (!isAfter(next, now)) next = addMinutes(now, config.everyMinutes);
  return next;
}

/** Dispatch table: one pure computer per schedule type. */
const RUN_COMPUTERS: {
  [T in ScheduleConfig['type']]: RunComputer<T>;
} = {
  IMMEDIATE: computeImmediate,
  ONCE_AT: computeOnceAt,
  DAILY_AT: computeDailyAt,
  WEEKLY: computeWeekly,
  INTERVAL: computeInterval,
};

/**
 * Compute the next moment a campaign should run, given its schedule and the
 * "current" time. Returns null when the schedule is exhausted (ONCE_AT past)
 * or for IMMEDIATE (manual dispatch only).
 *
 * `previousRun` should be the last actual run, if any. For first-time
 * computation pass `null`.
 */
export function computeNextRun(
  config: ScheduleConfig,
  now: Date,
  timezone: string,
  previousRun: Date | null,
): Date | null {
  // Indexed dispatch; the per-type computer receives the narrowed config.
  const computer = RUN_COMPUTERS[config.type] as RunComputer<typeof config.type>;
  return computer(config, now, timezone, previousRun);
}
