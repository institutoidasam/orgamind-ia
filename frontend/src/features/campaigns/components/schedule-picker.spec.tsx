import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { previewNextRuns } from './schedule-picker';
import type { ScheduleConfig } from '../schemas';

const SAO_PAULO_TZ = 'America/Sao_Paulo';

function saoPauloWallClock(d: Date): string {
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone: SAO_PAULO_TZ,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(d);
}

describe('previewNextRuns — São Paulo (-03:00) wall clock', () => {
  beforeEach(() => {
    // Fix "now" to a known instant. The container runs in UTC, which is the
    // exact condition that revealed the bug: setHours used the host (UTC) zone,
    // so a "09:00" daily run rendered as 06:00 once formatted in São Paulo.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-15T00:00:00-03:00'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('DAILY_AT 09:00 produces runs that read 09:00 in São Paulo', () => {
    const cfg: ScheduleConfig = { type: 'DAILY_AT', time: '09:00' };
    const runs = previewNextRuns(cfg, 3);
    expect(runs.length).toBe(3);
    for (const r of runs) {
      expect(saoPauloWallClock(r)).toBe('09:00');
    }
  });

  it('WEEKLY 14:30 produces runs that read 14:30 in São Paulo', () => {
    const cfg: ScheduleConfig = {
      type: 'WEEKLY',
      time: '14:30',
      weekdays: [1, 3, 5],
    };
    const runs = previewNextRuns(cfg, 3);
    expect(runs.length).toBe(3);
    for (const r of runs) {
      expect(saoPauloWallClock(r)).toBe('14:30');
    }
  });

  it('DAILY runs are strictly in the future and ascending', () => {
    const runs = previewNextRuns({ type: 'DAILY_AT', time: '09:00' }, 3);
    const now = Date.now();
    expect(runs[0].getTime()).toBeGreaterThan(now);
    expect(runs[1].getTime()).toBeGreaterThan(runs[0].getTime());
    expect(runs[2].getTime()).toBeGreaterThan(runs[1].getTime());
  });

  it('IMMEDIATE has no preview runs', () => {
    expect(previewNextRuns({ type: 'IMMEDIATE' }, 3)).toEqual([]);
  });

  it('INTERVAL keeps producing future runs spaced by everyMinutes', () => {
    const runs = previewNextRuns({ type: 'INTERVAL', everyMinutes: 60 }, 2);
    expect(runs.length).toBe(2);
    expect(runs[1].getTime() - runs[0].getTime()).toBe(60 * 60_000);
  });
});
