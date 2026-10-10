import { describe, expect, it } from 'vitest';
import {
  createInternalNumberSchema,
  listInternalNumbersQuerySchema,
  updateInternalNumberSchema,
} from './internal-number.schema';

describe('internal number contract', () => {
  const valid = {
    name: 'GBR Engenharia',
    phone: '+5592999990000',
    provider: 'META',
    sectorId: 'sector-1',
    routeToSector: true,
  };

  it('requires E.164 and never accepts provider credentials', () => {
    expect(createInternalNumberSchema.parse(valid)).toMatchObject(valid);
    expect(() =>
      createInternalNumberSchema.parse({ ...valid, phone: '92999990000' }),
    ).toThrow();
    expect(() =>
      createInternalNumberSchema.parse({ ...valid, accessToken: 'secret' }),
    ).toThrow();
  });

  it('normalizes supported E.164 presentation characters before persistence', () => {
    expect(
      createInternalNumberSchema.parse({
        ...valid,
        phone: '+55 (92) 99999-0000',
      }).phone,
    ).toBe('+5592999990000');
    expect(() =>
      createInternalNumberSchema.parse({ ...valid, phone: '+55abc999990000' }),
    ).toThrow();
  });

  it('allows a partial update but requires at least one allowed field', () => {
    expect(
      updateInternalNumberSchema.parse({ phone: '+55 92 99999-0000' }),
    ).toEqual({ phone: '+5592999990000' });
    expect(() => updateInternalNumberSchema.parse({})).toThrow();
    expect(() =>
      updateInternalNumberSchema.parse({ accessToken: 'secret' }),
    ).toThrow();
  });

  it('bounds listing pagination', () => {
    expect(
      listInternalNumbersQuerySchema.parse({ page: '2', pageSize: '100' }),
    ).toEqual({ page: 2, pageSize: 100 });
    expect(() =>
      listInternalNumbersQuerySchema.parse({ pageSize: '101' }),
    ).toThrow();
  });
});
