import { describe, expect, it } from 'vitest';
import type { ShiftRef } from '../../schemas/contracts/shift.schema';
import { overnightInProgress, selectMembers } from './team-whatsapp.selection';

const NOITE: ShiftRef = {
  id: 'shift_night',
  name: 'Noite',
  startTime: '22:00',
  endTime: '06:00',
};
const MANHA: ShiftRef = {
  id: 'shift_morning',
  name: 'Manhã',
  startTime: '06:00',
  endTime: '14:00',
};

describe('overnightInProgress (Manaus, UTC-4)', () => {
  it.each([
    [
      '02:00 de 22/10',
      '2026-10-22T06:00:00Z',
      { date: '2026-10-21', shift: NOITE },
    ],
    ['06:00 de 22/10 (fim da Noite)', '2026-10-22T10:00:00Z', null],
    ['21:00 de 21/10 (antes da Noite)', '2026-10-22T01:00:00Z', null],
  ])('%s', (_caso, iso, expected) => {
    expect(overnightInProgress([MANHA, NOITE], new Date(iso))).toEqual(
      expected,
    );
  });
});

describe('selectMembers (GC9)', () => {
  const eligible = [{ id: 'joao' }, { id: 'caio' }];
  it.each<[string, string[] | undefined, string[] | null]>([
    ['sem seleção = todos os elegíveis', undefined, ['joao', 'caio']],
    ['ids repetidos contam uma vez', ['caio', 'caio'], ['caio']],
    ['id fora da lista → null', ['joao', 'ana'], null],
  ])('%s', (_caso, userIds, expected) => {
    const picked = selectMembers(eligible, userIds);
    expect(picked && picked.map((m) => m.id)).toEqual(expected);
  });
});
