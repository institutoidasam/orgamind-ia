import { describe, expect, it } from 'vitest';
import { personAssignmentsSchema } from './person-assignments.schema';

const OPEN = {
  id: 'asg_open',
  sector: { id: 'sector_operation', name: 'Operação' },
  shift: { id: 'shift_day', name: 'Diurno' },
  level: null,
  from: null,
  to: null,
};

describe('personAssignmentsSchema', () => {
  it('aceita from e to nulos e recusa data fora de AAAA-MM-DD', () => {
    const closed = {
      ...OPEN,
      id: 'asg_closed',
      from: '2026-01-05',
      to: '2026-03-31',
    };

    expect(personAssignmentsSchema.parse({ items: [OPEN, closed] })).toEqual({
      items: [OPEN, closed],
    });
    for (const to of ['31/03/2026', '2026-3-31', '2026-02-30']) {
      expect(
        personAssignmentsSchema.safeParse({ items: [{ ...closed, to }] })
          .success,
        to,
      ).toBe(false);
    }
  });
});
