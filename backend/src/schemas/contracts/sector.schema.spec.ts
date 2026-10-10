import { describe, expect, it } from 'vitest';
import {
  createSectorSchema,
  listSectorsQuerySchema,
  membersQuerySchema,
  updateSectorSchema,
} from './sector.schema';

describe('sector query contracts', () => {
  it('parses only literal true as activeOnly', () => {
    expect(
      listSectorsQuerySchema.parse({ activeOnly: 'true' }).activeOnly,
    ).toBe(true);
    expect(
      listSectorsQuerySchema.parse({ activeOnly: 'false' }).activeOnly,
    ).toBe(false);
    expect(() =>
      listSectorsQuerySchema.parse({ activeOnly: 'anything' }),
    ).toThrow();
  });

  it('keeps false eligible members from being coerced to true', () => {
    expect(membersQuerySchema.parse({ eligible: 'false' }).eligible).toBe(
      false,
    );
  });

  it('normalizes sigla and rejects invalid web payloads before the controller', () => {
    expect(
      createSectorSchema.parse({ name: ' Compras ', code: ' com ' }),
    ).toMatchObject({ name: 'Compras', code: 'COM' });
    expect(() => createSectorSchema.parse({ name: '', code: 'COM' })).toThrow();
    expect(() =>
      createSectorSchema.parse({ name: 'Compras', code: 'C!' }),
    ).toThrow();
    expect(() => updateSectorSchema.parse({})).toThrow();
    expect(() => listSectorsQuerySchema.parse({ activeOnly: '1' })).toThrow();
    expect(() => membersQuerySchema.parse({ eligible: 'yes' })).toThrow();
  });
});
