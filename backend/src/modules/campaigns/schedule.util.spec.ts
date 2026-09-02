import { describe, it, expect } from 'vitest';
import { fromZonedTime, toZonedTime } from 'date-fns-tz';
import { computeNextRun } from './schedule.util';
import type { ScheduleConfig } from '../../schemas/contracts/schedule.schema';

const TZ = 'America/Sao_Paulo';

describe('computeNextRun', () => {
  describe('IMMEDIATE', () => {
    it('always returns null', () => {
      const config: ScheduleConfig = { type: 'IMMEDIATE' };
      expect(computeNextRun(config, new Date(), TZ, null)).toBeNull();
      expect(computeNextRun(config, new Date(), TZ, new Date())).toBeNull();
    });
  });

  describe('ONCE_AT', () => {
    it('returns the target date when in the future and no previous run', () => {
      const target = new Date('2030-01-01T12:00:00Z');
      const config: ScheduleConfig = { type: 'ONCE_AT', runAt: target } as any;
      const result = computeNextRun(config, new Date('2026-01-01T00:00:00Z'), TZ, null);
      expect(result?.toISOString()).toBe(target.toISOString());
    });

    it('returns null when target is in the past AND there is a previousRun', () => {
      const target = new Date('2020-01-01T12:00:00Z');
      const config: ScheduleConfig = { type: 'ONCE_AT', runAt: target } as any;
      const previousRun = new Date('2020-01-01T13:00:00Z');
      const result = computeNextRun(
        config,
        new Date('2026-01-01T00:00:00Z'),
        TZ,
        previousRun,
      );
      expect(result).toBeNull();
    });

    it('returns null when target was already run (previousRun after target)', () => {
      const target = new Date('2026-06-01T12:00:00Z');
      const config: ScheduleConfig = { type: 'ONCE_AT', runAt: target } as any;
      const previousRun = new Date('2026-06-01T12:00:01Z');
      const result = computeNextRun(
        config,
        new Date('2026-06-01T13:00:00Z'),
        TZ,
        previousRun,
      );
      expect(result).toBeNull();
    });

    it('returns null when target is in the past even without previousRun', () => {
      // If runScheduled crashes before markRan persists, previousRun stays
      // null. The helper must still treat a past target as exhausted —
      // otherwise the scheduler re-fires forever on the same nextRunAt.
      const target = new Date('2020-01-01T12:00:00Z');
      const config: ScheduleConfig = { type: 'ONCE_AT', runAt: target } as any;
      const result = computeNextRun(
        config,
        new Date('2026-01-01T00:00:00Z'),
        TZ,
        null,
      );
      expect(result).toBeNull();
    });
  });

  describe('DAILY_AT', () => {
    it('returns today at HH:mm in the target timezone when now is before that time', () => {
      // 2026-05-07 10:00 in São Paulo (UTC-3) is 2026-05-07 13:00 UTC
      const now = fromZonedTime(new Date('2026-05-07T10:00:00'), TZ);
      const config: ScheduleConfig = { type: 'DAILY_AT', time: '14:00' };
      const result = computeNextRun(config, now, TZ, null);
      expect(result).not.toBeNull();
      const local = toZonedTime(result!, TZ);
      expect(local.getFullYear()).toBe(2026);
      expect(local.getMonth()).toBe(4); // May (0-indexed)
      expect(local.getDate()).toBe(7);
      expect(local.getHours()).toBe(14);
      expect(local.getMinutes()).toBe(0);
    });

    it('returns TOMORROW at HH:mm when now is past that time', () => {
      const now = fromZonedTime(new Date('2026-05-07T18:00:00'), TZ);
      const config: ScheduleConfig = { type: 'DAILY_AT', time: '14:00' };
      const result = computeNextRun(config, now, TZ, null);
      const local = toZonedTime(result!, TZ);
      expect(local.getDate()).toBe(8);
      expect(local.getHours()).toBe(14);
    });

    it('skips today if it equals previousRun', () => {
      // Now is 2026-05-07 09:00 local, previousRun is exactly today at 14:00 local.
      // Candidate today=14:00 is after now, but not after previousRun → must skip to tomorrow.
      const now = fromZonedTime(new Date('2026-05-07T09:00:00'), TZ);
      const previousRun = fromZonedTime(new Date('2026-05-07T14:00:00'), TZ);
      const config: ScheduleConfig = { type: 'DAILY_AT', time: '14:00' };
      const result = computeNextRun(config, now, TZ, previousRun);
      const local = toZonedTime(result!, TZ);
      expect(local.getDate()).toBe(8);
      expect(local.getHours()).toBe(14);
    });

    it('preserves local 14:00 across the spring-forward DST day (Sao_Paulo no longer observes DST, so use a TZ that does)', () => {
      // Brazil dropped DST in 2019; for an active-DST tz use America/New_York (EST↔EDT).
      // Spring-forward 2026 in NY: 2026-03-08 02:00 jumps to 03:00.
      const NY = 'America/New_York';
      // On the day of spring-forward, computing from 10:00 local → 14:00 local should still
      // map to "14:00 NY local" (which is now EDT, UTC-4 → 18:00 UTC).
      const now = fromZonedTime(new Date('2026-03-08T10:00:00'), NY);
      const config: ScheduleConfig = { type: 'DAILY_AT', time: '14:00' };
      const result = computeNextRun(config, now, NY, null);
      const local = toZonedTime(result!, NY);
      expect(local.getHours()).toBe(14);
      expect(local.getMinutes()).toBe(0);
      expect(local.getDate()).toBe(8);
    });

    // --- Characterization: pin the EXACT UTC instant (Sao_Paulo fixed -03:00) ---
    it('CHAR: today-branch produces exactly 17:00:00.000Z for 14:00 local (-03:00)', () => {
      const now = fromZonedTime(new Date('2026-05-07T10:00:00'), TZ);
      const config: ScheduleConfig = { type: 'DAILY_AT', time: '14:00' };
      const result = computeNextRun(config, now, TZ, null);
      expect(result?.toISOString()).toBe('2026-05-07T17:00:00.000Z');
    });

    it('CHAR: tomorrow-branch produces exactly next-day 17:00:00.000Z (-03:00)', () => {
      const now = fromZonedTime(new Date('2026-05-07T18:00:00'), TZ);
      const config: ScheduleConfig = { type: 'DAILY_AT', time: '14:00' };
      const result = computeNextRun(config, now, TZ, null);
      expect(result?.toISOString()).toBe('2026-05-08T17:00:00.000Z');
    });

    it('CHAR: candidate exactly equal to now (not strictly after) rolls to tomorrow', () => {
      // now == candidate (14:00 local). isAfter is strict, so !isAfter is true → +1 day.
      const now = fromZonedTime(new Date('2026-05-07T14:00:00'), TZ);
      const config: ScheduleConfig = { type: 'DAILY_AT', time: '14:00' };
      const result = computeNextRun(config, now, TZ, null);
      expect(result?.toISOString()).toBe('2026-05-08T17:00:00.000Z');
    });

    it('CHAR: HH:mm with leading-zero minutes parses correctly (09:05 → 12:05Z)', () => {
      const now = fromZonedTime(new Date('2026-05-07T08:00:00'), TZ);
      const config: ScheduleConfig = { type: 'DAILY_AT', time: '09:05' };
      const result = computeNextRun(config, now, TZ, null);
      expect(result?.toISOString()).toBe('2026-05-07T12:05:00.000Z');
    });
  });

  describe('WEEKLY', () => {
    it('returns the next configured weekday at the given time', () => {
      // 2026-05-04 is a Monday. Schedule for Wednesday (3) at 09:00 → 2026-05-06 09:00 local.
      const now = fromZonedTime(new Date('2026-05-04T08:00:00'), TZ);
      const config: ScheduleConfig = {
        type: 'WEEKLY',
        time: '09:00',
        weekdays: [3],
      };
      const result = computeNextRun(config, now, TZ, null);
      const local = toZonedTime(result!, TZ);
      expect(local.getDay()).toBe(3);
      expect(local.getDate()).toBe(6);
      expect(local.getHours()).toBe(9);
      expect(local.getMinutes()).toBe(0);
    });

    it('rolls over to next week when today is the only configured day but past the time', () => {
      // 2026-05-06 is a Wednesday at 18:00 local; weekdays=[3] (Wed) at 09:00.
      // Today's 09:00 is past, so next match is the following Wednesday (2026-05-13).
      const now = fromZonedTime(new Date('2026-05-06T18:00:00'), TZ);
      const config: ScheduleConfig = {
        type: 'WEEKLY',
        time: '09:00',
        weekdays: [3],
      };
      const result = computeNextRun(config, now, TZ, null);
      const local = toZonedTime(result!, TZ);
      expect(local.getDay()).toBe(3);
      expect(local.getDate()).toBe(13);
    });

    it('picks the soonest of multiple weekdays', () => {
      // Now: Mon 2026-05-04 08:00 local. weekdays=[1,4] (Mon,Thu) at 09:00.
      // Today (Mon) 09:00 is still in the future → match today.
      const now = fromZonedTime(new Date('2026-05-04T08:00:00'), TZ);
      const config: ScheduleConfig = {
        type: 'WEEKLY',
        time: '09:00',
        weekdays: [1, 4],
      };
      const result = computeNextRun(config, now, TZ, null);
      const local = toZonedTime(result!, TZ);
      expect(local.getDay()).toBe(1);
      expect(local.getDate()).toBe(4);
    });

    // --- Characterization: exact instants + previousRun skip + Sunday(0) ---
    it('CHAR: next configured weekday produces exactly 12:00:00.000Z (-03:00)', () => {
      // Mon 2026-05-04 08:00 local, Wednesday(3) at 09:00 → 2026-05-06 09:00 local = 12:00Z
      const now = fromZonedTime(new Date('2026-05-04T08:00:00'), TZ);
      const config: ScheduleConfig = { type: 'WEEKLY', time: '09:00', weekdays: [3] };
      const result = computeNextRun(config, now, TZ, null);
      expect(result?.toISOString()).toBe('2026-05-06T12:00:00.000Z');
    });

    it('CHAR: skips today when today matches but candidate <= previousRun', () => {
      // Now Mon 2026-05-04 08:00 local; weekdays=[1] (Mon) at 09:00; previousRun is today 09:00.
      // Today's candidate is after now but not after previousRun → must roll to next Monday.
      const now = fromZonedTime(new Date('2026-05-04T08:00:00'), TZ);
      const previousRun = fromZonedTime(new Date('2026-05-04T09:00:00'), TZ);
      const config: ScheduleConfig = { type: 'WEEKLY', time: '09:00', weekdays: [1] };
      const result = computeNextRun(config, now, TZ, previousRun);
      const local = toZonedTime(result!, TZ);
      expect(local.getDay()).toBe(1);
      expect(local.getDate()).toBe(11);
      expect(result?.toISOString()).toBe('2026-05-11T12:00:00.000Z');
    });

    it('CHAR: matches Sunday (weekday 0) correctly', () => {
      // Now Sat 2026-05-09 08:00 local; weekdays=[0] (Sunday) at 10:00 → 2026-05-10.
      const now = fromZonedTime(new Date('2026-05-09T08:00:00'), TZ);
      const config: ScheduleConfig = { type: 'WEEKLY', time: '10:00', weekdays: [0] };
      const result = computeNextRun(config, now, TZ, null);
      const local = toZonedTime(result!, TZ);
      expect(local.getDay()).toBe(0);
      expect(local.getDate()).toBe(10);
      expect(result?.toISOString()).toBe('2026-05-10T13:00:00.000Z');
    });

    it('CHAR: offset=0 today match still in future is returned (boundary of loop start)', () => {
      // Now Wed 2026-05-06 08:00 local; weekdays=[3] (Wed) at 09:00 → today.
      const now = fromZonedTime(new Date('2026-05-06T08:00:00'), TZ);
      const config: ScheduleConfig = { type: 'WEEKLY', time: '09:00', weekdays: [3] };
      const result = computeNextRun(config, now, TZ, null);
      expect(result?.toISOString()).toBe('2026-05-06T12:00:00.000Z');
    });
  });

  describe('INTERVAL', () => {
    it('adds everyMinutes to previousRun when supplied', () => {
      const previousRun = new Date('2026-05-07T12:00:00Z');
      const now = new Date('2026-05-07T12:00:30Z');
      const config: ScheduleConfig = {
        type: 'INTERVAL',
        everyMinutes: 30,
      };
      const result = computeNextRun(config, now, TZ, previousRun);
      expect(result?.toISOString()).toBe('2026-05-07T12:30:00.000Z');
    });

    it('falls back to now when no previousRun and result lands in the future', () => {
      const now = new Date('2026-05-07T12:00:00Z');
      const config: ScheduleConfig = {
        type: 'INTERVAL',
        everyMinutes: 15,
      };
      const result = computeNextRun(config, now, TZ, null);
      expect(result?.toISOString()).toBe('2026-05-07T12:15:00.000Z');
    });

    it('catches up to now+everyMinutes after a long downtime', () => {
      // previousRun = year ago, everyMinutes=30, now = today.
      // base+30min would be a year ago → must roll forward to now+30min.
      const previousRun = new Date('2025-05-07T12:00:00Z');
      const now = new Date('2026-05-07T12:00:00Z');
      const config: ScheduleConfig = {
        type: 'INTERVAL',
        everyMinutes: 30,
      };
      const result = computeNextRun(config, now, TZ, previousRun);
      expect(result?.toISOString()).toBe('2026-05-07T12:30:00.000Z');
    });

    // --- Characterization: boundary where base+interval == now exactly ---
    it('CHAR: when previousRun+interval lands exactly on now, rolls to now+interval', () => {
      // previousRun + 30min == now exactly. isAfter is strict, so !isAfter → now+30min.
      const previousRun = new Date('2026-05-07T11:30:00Z');
      const now = new Date('2026-05-07T12:00:00Z');
      const config: ScheduleConfig = { type: 'INTERVAL', everyMinutes: 30 };
      const result = computeNextRun(config, now, TZ, previousRun);
      expect(result?.toISOString()).toBe('2026-05-07T12:30:00.000Z');
    });

    it('CHAR: previousRun+interval strictly after now is returned as-is', () => {
      const previousRun = new Date('2026-05-07T11:45:00Z');
      const now = new Date('2026-05-07T12:00:00Z');
      const config: ScheduleConfig = { type: 'INTERVAL', everyMinutes: 30 };
      const result = computeNextRun(config, now, TZ, previousRun);
      expect(result?.toISOString()).toBe('2026-05-07T12:15:00.000Z');
    });
  });

  describe('ONCE_AT exact instant', () => {
    it('CHAR: returns the exact target instant unchanged', () => {
      const target = new Date('2030-07-15T03:21:09.123Z');
      const config: ScheduleConfig = { type: 'ONCE_AT', runAt: target } as any;
      const result = computeNextRun(config, new Date('2026-01-01T00:00:00Z'), TZ, null);
      expect(result?.toISOString()).toBe('2030-07-15T03:21:09.123Z');
    });

    it('CHAR: now exactly equal to target (not strictly after) still returns target', () => {
      // isAfter(now, target) is strict; now == target → not after → returns target.
      const target = new Date('2030-07-15T12:00:00.000Z');
      const config: ScheduleConfig = { type: 'ONCE_AT', runAt: target } as any;
      const result = computeNextRun(config, new Date('2030-07-15T12:00:00.000Z'), TZ, null);
      expect(result?.toISOString()).toBe('2030-07-15T12:00:00.000Z');
    });
  });
});
