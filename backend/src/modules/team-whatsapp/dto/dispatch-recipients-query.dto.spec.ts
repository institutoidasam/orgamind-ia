import { describe, expect, it } from 'vitest';
import { dispatchRecipientsQuerySchema } from './dispatch-recipients-query.dto';

describe('dispatchRecipientsQuerySchema (C5)', () => {
  it.each<[string, Record<string, unknown>, unknown]>([
    [
      'vazio usa os padrões (pageSize 50, sem status)',
      {},
      { page: 1, pageSize: 50 },
    ],
    [
      'status e página vêm da query como string',
      { status: 'UNCERTAIN', page: '2', pageSize: '100' },
      { status: 'UNCERTAIN', page: 2, pageSize: 100 },
    ],
    [
      'page 10000 (limite) é aceita',
      { page: '10000' },
      { page: 10000, pageSize: 50 },
    ],
  ])('%s', (_caso, query, esperado) => {
    expect(dispatchRecipientsQuerySchema.parse(query)).toEqual(esperado);
  });

  it.each<[string, Record<string, unknown>]>([
    ['pageSize 101', { pageSize: '101' }],
    ['pageSize 0', { pageSize: '0' }],
    ['page 10001', { page: '10001' }],
    ['status fora do enum', { status: 'ENVIADO' }],
    ['status em minúsculas', { status: 'failed' }],
  ])('%s → falha (400)', (_caso, query) => {
    expect(dispatchRecipientsQuerySchema.safeParse(query).success).toBe(false);
  });
});
