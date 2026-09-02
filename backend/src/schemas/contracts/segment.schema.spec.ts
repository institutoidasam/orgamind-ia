import { describe, it, expect } from 'vitest';

import { updateSegmentSchema, createSegmentSchema } from './segment.schema';

describe('updateSegmentSchema.description', () => {
  it('accepts null to clear the description', () => {
    // The UI sends description:null to clear it; z.string().optional() rejected
    // null, so clearing never persisted end-to-end.
    const parsed = updateSegmentSchema.parse({ description: null });
    expect(parsed.description).toBeNull();
  });

  it('still accepts a string and omission', () => {
    expect(updateSegmentSchema.parse({ description: 'x' }).description).toBe('x');
    expect(updateSegmentSchema.parse({}).description).toBeUndefined();
  });
});

describe('createSegmentSchema.description', () => {
  it('does not accept null on create (use omission)', () => {
    expect(
      createSegmentSchema.safeParse({
        name: 'S',
        description: null,
        filters: { combinator: 'and', rules: [] },
      }).success,
    ).toBe(false);
  });
});
