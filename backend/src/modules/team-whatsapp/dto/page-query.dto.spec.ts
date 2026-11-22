import { describe, expect, it } from 'vitest';
import { pageQuerySchema } from './page-query.dto';

describe('pageQuerySchema (C5)', () => {
  it.each<[string, Record<string, unknown>, unknown]>([
    ['vazio usa os padrões', {}, { page: 1, pageSize: 20 }],
    [
      'strings da query viram número',
      { page: '3', pageSize: '50' },
      { page: 3, pageSize: 50 },
    ],
    ['page no teto 10000', { page: '10000' }, { page: 10000, pageSize: 20 }],
  ])('%s', (_caso, query, esperado) => {
    expect(pageQuerySchema.parse(query)).toEqual(esperado);
  });

  it.each<[string, Record<string, unknown>]>([
    ['pageSize 51', { pageSize: '51' }],
    ['pageSize 0', { pageSize: '0' }],
    ['page 0', { page: '0' }],
    ['page fracionário', { page: '1.5' }],
    ['page 10001 (acima do teto)', { page: '10001' }],
  ])('%s → falha (400)', (_caso, query) => {
    expect(pageQuerySchema.safeParse(query).success).toBe(false);
  });
});
