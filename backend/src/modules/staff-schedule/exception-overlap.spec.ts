import { describe, expect, it } from 'vitest';
import { planOverlap, type OverlapPlan } from './exception-overlap';

/** Dias de outubro de 2026 ('21' → '2026-10-21'). */
const d = (day: number) => `2026-10-${String(day).padStart(2, '0')}`;
const range = (id: string, from: number, to: number) => ({
  id,
  startDate: d(from),
  endDate: d(to),
});
const EMPTY: OverlapPlan = { deleteIds: [], updates: [], splits: [] };

describe('planOverlap — recorte de exceções (existente 21..25)', () => {
  it.each<[string, [number, number], Partial<OverlapPlan>]>([
    ['cruza o fim', [23, 27], { updates: [range('a', 21, 22)] }],
    ['cruza o início', [19, 22], { updates: [range('a', 23, 25)] }],
    ['cobre inteira', [20, 26], { deleteIds: ['a'] }],
    [
      'no meio divide em duas',
      [23, 23],
      {
        updates: [range('a', 21, 22)],
        splits: [{ fromId: 'a', startDate: d(24), endDate: d(25) }],
      },
    ],
    ['sem dia em comum', [26, 28], {}],
  ])('nova %s (%j)', (_label, [from, to], expected) => {
    const incoming = { startDate: d(from), endDate: d(to) };

    const plan = planOverlap([range('a', 21, 25)], incoming);

    expect(plan).toEqual({ ...EMPTY, ...expected });
  });

  it('duas existentes 21..22 e 24..25 com nova 22..24 → update das duas', () => {
    const existing = [range('a', 21, 22), range('b', 24, 25)];

    const plan = planOverlap(existing, { startDate: d(22), endDate: d(24) });

    expect(plan).toEqual({
      ...EMPTY,
      updates: [range('a', 21, 21), range('b', 25, 25)],
    });
  });
});
