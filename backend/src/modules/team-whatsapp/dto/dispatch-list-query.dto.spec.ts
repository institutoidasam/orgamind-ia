import { describe, expect, it } from 'vitest';
import { dispatchListQuerySchema } from './dispatch-list-query.dto';

const parse = (query: Record<string, unknown>) =>
  dispatchListQuerySchema.safeParse(query);
const failingPaths = (query: Record<string, unknown>) => {
  const r = parse(query);
  return r.success ? [] : r.error.issues.map((i) => i.path.join('.'));
};

describe('dispatchListQuerySchema (DG14)', () => {
  it('lista aceita from, to, purpose e state, inclusive EXPIRED; from depois de to é 400', () => {
    const filters = {
      from: '2026-11-01',
      to: '2026-11-20',
      purpose: 'meeting',
      state: 'EXPIRED',
    };
    expect(parse({ ...filters, page: '2' })).toMatchObject({
      success: true,
      data: { ...filters, page: 2, pageSize: 20 },
    });
    expect(parse({})).toMatchObject({ data: { page: 1, pageSize: 20 } });
    const sameDay = { from: '2026-11-20', to: '2026-11-20' };
    expect(parse(sameDay).success).toBe(true);
    expect(failingPaths({ from: '2026-11-21', to: '2026-11-20' })).toEqual([
      'from',
    ]);
  });

  it.each<[string, Record<string, unknown>]>([
    ['state desconhecido', { state: 'ENVIADO' }],
    ['state em minúsculas', { state: 'expired' }],
    ['purpose fora das 6', { purpose: 'party' }],
    ['from fora do calendário', { from: '2026-02-30' }],
  ])('%s é 400', (_caso, query) => {
    expect(parse(query).success).toBe(false);
  });
});
