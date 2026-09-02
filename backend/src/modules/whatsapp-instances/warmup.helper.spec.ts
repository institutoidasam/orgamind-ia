import { describe, expect, it } from 'vitest';
import { warmupEffectiveCap, warmupInfo, WARMUP_RAMP } from './warmup.helper';

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-07-08T12:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY);

describe('warmupEffectiveCap', () => {
  it('ramps by day index (configured cap 500)', () => {
    expect(warmupEffectiveCap(daysAgo(0), NOW, 500)).toBe(50); // dia 1
    expect(warmupEffectiveCap(daysAgo(1), NOW, 500)).toBe(50); // dia 2
    expect(warmupEffectiveCap(daysAgo(2), NOW, 500)).toBe(100); // dia 3
    expect(warmupEffectiveCap(daysAgo(3), NOW, 500)).toBe(200); // dia 4
    expect(warmupEffectiveCap(daysAgo(4), NOW, 500)).toBe(350); // dia 5
    expect(warmupEffectiveCap(daysAgo(5), NOW, 500)).toBe(500); // dia 6 → full
    expect(warmupEffectiveCap(daysAgo(100), NOW, 500)).toBe(500);
  });

  it('never exceeds the configured cap (cap below ramp value)', () => {
    expect(warmupEffectiveCap(daysAgo(0), NOW, 30)).toBe(30); // min(30, 50)
    expect(warmupEffectiveCap(daysAgo(4), NOW, 200)).toBe(200); // min(200, 350)
  });

  it('returns the configured cap when there is no warm-up timestamp', () => {
    expect(warmupEffectiveCap(null, NOW, 500)).toBe(500);
    expect(warmupEffectiveCap(undefined, NOW, 500)).toBe(500);
  });

  it('clamps clock skew (future warmupStartedAt) to day 1 instead of going negative', () => {
    const future = new Date(NOW.getTime() + 3 * DAY);
    expect(warmupEffectiveCap(future, NOW, 500)).toBe(50);
  });
});

describe('warmupInfo', () => {
  it('reports 1-based day and warming flag', () => {
    expect(warmupInfo(daysAgo(0), NOW, 500)).toEqual({ effectiveCap: 50, day: 1, warming: true });
    expect(warmupInfo(daysAgo(2), NOW, 500)).toEqual({ effectiveCap: 100, day: 3, warming: true });
    expect(warmupInfo(daysAgo(4), NOW, 500)).toEqual({ effectiveCap: 350, day: 5, warming: true });
    expect(warmupInfo(daysAgo(5), NOW, 500)).toEqual({ effectiveCap: 500, day: 6, warming: false });
  });

  it('is not warming without a timestamp', () => {
    expect(warmupInfo(null, NOW, 500)).toEqual({ effectiveCap: 500, day: 0, warming: false });
  });
});

describe('WARMUP_RAMP', () => {
  it('is monotonic and bounded', () => {
    const caps = WARMUP_RAMP.map((s) => s.cap);
    expect(caps).toEqual([50, 100, 200, 350]);
  });
});
