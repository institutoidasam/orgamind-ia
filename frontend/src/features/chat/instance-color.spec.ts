import { describe, expect, it } from 'vitest';
import { INSTANCE_PALETTE, instanceColor } from './instance-color';

describe('instanceColor', () => {
  it('is deterministic — same key always maps to the same color', () => {
    expect(instanceColor('cmpld58go0001ph3fogfw6r0n')).toBe(
      instanceColor('cmpld58go0001ph3fogfw6r0n'),
    );
  });

  it('always returns a palette member', () => {
    for (const key of ['a', 'b', 'cmpld58go0001ph3fogfw6r0n', '', 'x'.repeat(64)]) {
      expect(INSTANCE_PALETTE).toContain(instanceColor(key));
    }
  });

  it('maps known keys to known palette slots (djb2)', () => {
    // djb2('a') = 5381*33 + 97 = 177670 → 177670 % 8 = 6
    expect(instanceColor('a')).toBe(INSTANCE_PALETTE[6]);
    // djb2('b') = 177671 → % 8 = 7
    expect(instanceColor('b')).toBe(INSTANCE_PALETTE[7]);
  });

  it('has 8 distinct colors', () => {
    expect(new Set(INSTANCE_PALETTE).size).toBe(8);
  });
});
