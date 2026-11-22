import { describe, expect, it } from 'vitest';
import {
  IMPORT_FIELDS,
  confirmBodySchema,
  mappingBodySchema,
  rowsQuerySchema,
  type ColumnMapping,
} from './people-import.schema';

function mappingWith(overrides: Partial<ColumnMapping> = {}): ColumnMapping {
  const none = Object.fromEntries(IMPORT_FIELDS.map((f) => [f, null]));
  return { ...none, ...overrides } as ColumnMapping;
}

describe('confirmBodySchema: o mapeamento que a tela mostrou (EX7, EX8)', () => {
  it('confirmBodySchema exige o mapeamento completo da prévia', () => {
    const body = { createNew: true, updateExisting: false };
    const mapping = mappingWith({ name: 0, phone: 1 });
    expect(confirmBodySchema.safeParse(body).success).toBe(false);
    expect(confirmBodySchema.parse({ ...body, mapping }).mapping).toEqual(
      mapping,
    );
    const partial: Partial<ColumnMapping> = { ...mapping };
    delete partial.phone;
    expect(
      confirmBodySchema.safeParse({ ...body, mapping: partial }).success,
    ).toBe(false);
  });
});

describe('mappingBodySchema', () => {
  it('mappingBodySchema exige as onze chaves e recusa a mesma coluna em dois campos e índice negativo', () => {
    const ok = mappingWith({ name: 0, phone: 1, registration: 2 });
    expect(mappingBodySchema.safeParse({ mapping: ok }).success).toBe(true);
    // "Não usar" (null) em vários campos não é repetição.
    expect(
      mappingBodySchema.safeParse({ mapping: mappingWith() }).success,
    ).toBe(true);

    const missingKey: Partial<ColumnMapping> = { ...ok };
    delete missingKey.name;
    expect(mappingBodySchema.safeParse({ mapping: missingKey }).success).toBe(
      false,
    );
    expect(
      mappingBodySchema.safeParse({ mapping: { ...ok, extra: 3 } }).success,
    ).toBe(false);
    expect(
      mappingBodySchema.safeParse({ mapping: mappingWith({ name: -1 }) })
        .success,
    ).toBe(false);

    const repeated = mappingBodySchema.safeParse({
      mapping: mappingWith({ name: 0, phone: 0 }),
    });
    expect(repeated.success).toBe(false);
    expect(repeated.error?.issues[0]?.message).toBe(
      'Cada coluna serve a um campo só.',
    );
  });
});

describe('confirmBodySchema', () => {
  it('confirmBodySchema exige os dois marcadores e limita excludedRows a 5.000', () => {
    const base = {
      createNew: true,
      updateExisting: false,
      mapping: mappingWith({ name: 0 }),
    };
    expect(confirmBodySchema.parse(base).excludedRows).toEqual([]);
    expect(confirmBodySchema.safeParse({ createNew: true }).success).toBe(
      false,
    );
    expect(confirmBodySchema.safeParse({ updateExisting: true }).success).toBe(
      false,
    );

    const rows = (n: number) => Array.from({ length: n }, (_, i) => i + 2);
    expect(
      confirmBodySchema.safeParse({ ...base, excludedRows: rows(5000) })
        .success,
    ).toBe(true);
    expect(
      confirmBodySchema.safeParse({ ...base, excludedRows: rows(5001) })
        .success,
    ).toBe(false);
    // Linha 1 é o cabeçalho.
    expect(
      confirmBodySchema.safeParse({ ...base, excludedRows: [1] }).success,
    ).toBe(false);
  });
});

describe('rowsQuerySchema', () => {
  it('rowsQuerySchema aceita página e classificação; página padrão 1', () => {
    expect(rowsQuerySchema.parse({})).toEqual({ page: 1 });
    expect(
      rowsQuerySchema.parse({ page: '3', classification: 'INVALID' }),
    ).toEqual({
      page: 3,
      classification: 'INVALID',
    });
    expect(rowsQuerySchema.safeParse({ page: '0' }).success).toBe(false);
    expect(rowsQuerySchema.safeParse({ classification: 'OTHER' }).success).toBe(
      false,
    );
  });
});
