import { describe, expect, it } from 'vitest';
import { listInternalNumbersQuerySchema } from './internal-number.schema';

describe('internal number contract', () => {
  it('bounds listing pagination', () => {
    expect(
      listInternalNumbersQuerySchema.parse({ page: '2', pageSize: '100' }),
    ).toEqual({ page: 2, pageSize: 100 });
    expect(() =>
      listInternalNumbersQuerySchema.parse({ pageSize: '101' }),
    ).toThrow();
  });
});
