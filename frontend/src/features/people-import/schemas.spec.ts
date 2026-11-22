import { describe, expect, it } from 'vitest';
import { batchListSchema, batchSummarySchema, columnMappingSchema, ROW_CLASSES, rowsPageSchema } from './schemas';

const person = { id: 'u1', name: 'Marina' };
const counts = Object.fromEntries(ROW_CLASSES.map((rowClass, i) => [rowClass, i]));
const progress = {
  toWrite: 10,
  pending: 4,
  writing: 1,
  created: 3,
  updated: 1,
  unchanged: 0,
  failed: 1,
  phoneTaken: 1,
  notWritten: 0,
};
const listItem = {
  id: 'b1',
  fileName: 'pessoas.xlsx',
  fileSize: 2048,
  format: 'xlsx',
  situation: 'WRITING',
  createdAt: '2026-11-19T12:00:00.000Z',
  createdBy: person,
  confirmedAt: '2026-11-19T12:05:00.000Z',
  confirmedBy: person,
  finishedAt: null,
  counts,
  progress,
  canConfirm: false,
  canContinue: true,
  canClose: true,
  canDiscard: false,
  hasErrorReport: true,
};
const mapping = Object.fromEntries(
  [
    'registration',
    'name',
    'phone',
    'jobTitle',
    'sector',
    'shift',
    'level',
    'authorization',
    'authorizationSource',
    'authorizationNote',
    'authorizationDate',
  ].map((field, i) => [field, i % 2 ? null : i]),
);
const row = {
  rowNumber: 2,
  classification: 'UPDATE',
  name: null,
  registration: '1001',
  sector: 'Logística',
  reasons: [],
  warnings: ['Telefone sem DDD'],
  diff: [{ field: 'jobTitle', label: 'Função', before: null, after: 'Operador' }],
  selectable: true,
};

describe('mapeamento de colunas', () => {
  it('recusa mapeamento incompleto (campo sem índice nem null)', () => {
    const incomplete = Object.fromEntries(Object.entries(mapping).filter(([field]) => field !== 'phone'));

    expect(columnMappingSchema.safeParse(mapping).success).toBe(true);
    expect(columnMappingSchema.safeParse(incomplete).success).toBe(false);
  });

  it('recusa índice de coluna negativo ou fracionário', () => {
    expect(columnMappingSchema.safeParse({ ...mapping, name: -1 }).success).toBe(false);
    expect(columnMappingSchema.safeParse({ ...mapping, name: 1.5 }).success).toBe(false);
  });
});

describe('esquemas da importação', () => {
  it('aceita o resumo, a lista e a página de linhas da API', () => {
    const summary = {
      ...listItem,
      headers: ['Matrícula', 'Nome'],
      mapping,
      mappingProblem: null,
      phoneCheckDeferred: true,
    };

    const parsed = batchSummarySchema.parse(summary);
    expect(parsed.phoneCheckDeferred).toBe(true);
    expect(parsed.progress?.phoneTaken).toBe(1);
    expect(parsed.counts?.CONFLICT).toBe(5);
    expect(batchSummarySchema.parse({ ...summary, counts: null, progress: null }).progress).toBeNull();

    const list = { items: [listItem], total: 21, page: 2, pageSize: 20 };
    expect(batchListSchema.parse(list).items[0].fileName).toBe('pessoas.xlsx');

    const rows = { items: [row], total: 1, page: 1, pageSize: 50 };
    expect(rowsPageSchema.parse(rows).items[0].diff[0].after).toBe('Operador');
  });

  it('recusa classificação desconhecida', () => {
    const rows = {
      items: [{ ...row, classification: 'MERGE' }],
      total: 1,
      page: 1,
      pageSize: 50,
    };
    expect(() => rowsPageSchema.parse(rows)).toThrow();

    const unknownCount = { ...listItem, counts: { ...counts, MERGE: 1 } };
    expect(() =>
      batchListSchema.parse({
        items: [unknownCount],
        total: 1,
        page: 1,
        pageSize: 20,
      }),
    ).toThrow();
  });
});
