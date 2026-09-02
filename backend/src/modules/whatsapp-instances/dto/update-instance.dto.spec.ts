import { describe, it, expect } from 'vitest';

import { updateInstanceSchema } from './update-instance.dto';

describe('updateInstanceSchema send window', () => {
  // Regression: without a cross-field refine, an overnight (start > end) or
  // equal (start === end) window passes validation, and the send worker's
  // non-wrapping `outsideWindow` test then defers every message forever —
  // the campaign silently never sends. The frontend already enforces
  // strict start < end; the DTO must mirror that contract.
  it('rejects an overnight window where start > end', () => {
    const result = updateInstanceSchema.safeParse({
      sendWindowStartHour: 22,
      sendWindowEndHour: 6,
    });
    expect(result.success).toBe(false);
  });

  it('rejects an equal-hours window where start === end', () => {
    const result = updateInstanceSchema.safeParse({
      sendWindowStartHour: 8,
      sendWindowEndHour: 8,
    });
    expect(result.success).toBe(false);
  });

  it('accepts a normal window where start < end', () => {
    const result = updateInstanceSchema.safeParse({
      sendWindowStartHour: 8,
      sendWindowEndHour: 20,
    });
    expect(result.success).toBe(true);
  });

  it('accepts a partial update that sets only the start hour', () => {
    const result = updateInstanceSchema.safeParse({ sendWindowStartHour: 8 });
    expect(result.success).toBe(true);
  });

  it('accepts a partial update that sets only the end hour', () => {
    const result = updateInstanceSchema.safeParse({ sendWindowEndHour: 20 });
    expect(result.success).toBe(true);
  });
});
