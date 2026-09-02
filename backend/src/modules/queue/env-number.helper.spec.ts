import { describe, it, expect, vi, afterEach } from 'vitest';
import { parseEnvNumber } from './env-number.helper';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('parseEnvNumber', () => {
  it('parses a valid numeric string', () => {
    expect(parseEnvNumber('30000', 10, 'X')).toBe(30000);
  });

  it('returns the fallback when the env var is undefined', () => {
    expect(parseEnvNumber(undefined, 42, 'X')).toBe(42);
  });

  it('returns the fallback (and warns) for a non-numeric string', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(parseEnvNumber('abc', 99, 'PACING_JITTER_MIN_MS')).toBe(99);
    expect(warn).toHaveBeenCalled();
  });

  it('returns the fallback (and warns) for an empty string', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(parseEnvNumber('', 7, 'X')).toBe(7);
    expect(warn).toHaveBeenCalled();
  });

  it('returns the fallback for a value that parses to NaN', () => {
    expect(parseEnvNumber('not-a-number', 5, 'X')).toBe(5);
  });

  it('returns the fallback for Infinity', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(parseEnvNumber('Infinity', 11, 'X')).toBe(11);
    expect(warn).toHaveBeenCalled();
  });

  it('accepts 0 as a valid finite value (does NOT treat it as falsy)', () => {
    expect(parseEnvNumber('0', 50, 'X')).toBe(0);
  });

  it('accepts negative numbers (finite)', () => {
    expect(parseEnvNumber('-1', 50, 'X')).toBe(-1);
  });

  it('the warning message names the variable so misconfig is diagnosable', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    parseEnvNumber('garbage', 1, 'PACING_BURST_SIZE');
    const logged = warn.mock.calls.map((c) => String(c[0])).join(' ');
    expect(logged).toContain('PACING_BURST_SIZE');
  });
});
