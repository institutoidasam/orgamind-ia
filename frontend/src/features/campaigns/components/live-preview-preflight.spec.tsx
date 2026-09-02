/**
 * Focused unit tests for the preflight summary display inside LivePreview.
 * The component uses useMutation hooks that hit the network, so we test the
 * derived display logic in isolation using a lightweight helper that mirrors
 * the component's condition.
 */
import { describe, it, expect } from 'vitest';
import type { PreflightResult } from '../schemas';

/** Mirrors the manyUnreachable condition in LivePreview */
function isManyUnreachable(pf: PreflightResult | null): boolean {
  if (!pf || pf.total === 0) return false;
  return (pf.invalid + pf.unknown) / pf.total > 0.3;
}

/** Mirrors the reachability label text */
function reachabilityLabel(pf: PreflightResult): string {
  return `${pf.reachable} de ${pf.total} alcançáveis no WhatsApp`;
}

describe('LivePreview preflight display logic', () => {
  it('does not warn when reachable ratio is above 70%', () => {
    const pf: PreflightResult = { total: 100, reachable: 80, invalid: 10, unknown: 10 };
    expect(isManyUnreachable(pf)).toBe(false);
  });

  it('warns when more than 30% are invalid+unknown', () => {
    const pf: PreflightResult = { total: 100, reachable: 60, invalid: 25, unknown: 15 };
    expect(isManyUnreachable(pf)).toBe(true);
  });

  it('warns when exactly at the 30% threshold (>30, not >=)', () => {
    // 30 / 100 = 0.30 which is NOT > 0.30, so no warning
    const pf: PreflightResult = { total: 100, reachable: 70, invalid: 30, unknown: 0 };
    expect(isManyUnreachable(pf)).toBe(false);
  });

  it('warns when just over 30%', () => {
    const pf: PreflightResult = { total: 100, reachable: 69, invalid: 31, unknown: 0 };
    expect(isManyUnreachable(pf)).toBe(true);
  });

  it('does not warn when pf is null', () => {
    expect(isManyUnreachable(null)).toBe(false);
  });

  it('does not warn when total is 0', () => {
    const pf: PreflightResult = { total: 0, reachable: 0, invalid: 0, unknown: 0 };
    expect(isManyUnreachable(pf)).toBe(false);
  });

  it('renders correct label text', () => {
    const pf: PreflightResult = { total: 200, reachable: 150, invalid: 20, unknown: 30 };
    expect(reachabilityLabel(pf)).toBe('150 de 200 alcançáveis no WhatsApp');
  });

  it('warns when ALL contacts are invalid', () => {
    const pf: PreflightResult = { total: 50, reachable: 0, invalid: 50, unknown: 0 };
    expect(isManyUnreachable(pf)).toBe(true);
  });
});
