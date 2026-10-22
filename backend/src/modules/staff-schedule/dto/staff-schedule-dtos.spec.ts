import { describe, expect, it } from 'vitest';
import { addDays } from '../civil-date';
import { CreateExceptionDto } from './create-exception.dto';
import { PutScheduleDto } from './put-schedule.dto';

const WEEKLY = {
  template: 'WEEKLY',
  startDate: '2026-10-19',
  cycleLength: 7,
  days: ['shift_first', 'shift_first', 'shift_first', null, null, null, null],
};
const SWAP = {
  kind: 'SHIFT_SWAP',
  startDate: '2026-10-21',
  endDate: '2026-10-23',
  shiftId: 'shift_second',
};

describe('PutScheduleDto (C4/C5)', () => {
  it('aceita ciclo com um item por dia', () => {
    expect(PutScheduleDto.schema.parse(WEEKLY)).toEqual(WEEKLY);
  });

  it.each<[string, Record<string, unknown>]>([
    ['days.length !== cycleLength', { days: WEEKLY.days.slice(1) }],
    ['cycleLength 0', { cycleLength: 0, days: [] }],
    ['cycleLength 29', { cycleLength: 29, days: Array(29).fill(null) }],
  ])('%s → falha', (_label, over) => {
    expect(
      PutScheduleDto.schema.safeParse({ ...WEEKLY, ...over }).success,
    ).toBe(false);
  });
});

describe('CreateExceptionDto (C5)', () => {
  it.each<[string, Record<string, unknown>]>([
    ['SHIFT_SWAP com turno', SWAP],
    [
      'OTHER_SECTOR com turno e setor',
      { ...SWAP, kind: 'OTHER_SECTOR', sectorId: 'sector-log' },
    ],
    ['VACATION de 366 dias', vacationOf(366)],
  ])('aceita %s', (_label, body) => {
    expect(CreateExceptionDto.schema.safeParse(body).success).toBe(true);
  });

  it.each<[string, Record<string, unknown>]>([
    ['endDate < startDate', { ...SWAP, endDate: '2026-10-20' }],
    ['367 dias', vacationOf(367)],
    ['SHIFT_SWAP sem shiftId', { ...SWAP, shiftId: undefined }],
    ['OTHER_SECTOR sem sectorId', { ...SWAP, kind: 'OTHER_SECTOR' }],
    ['DAY_OFF com shiftId', { ...SWAP, kind: 'DAY_OFF' }],
    ['note com 201 caracteres', { ...SWAP, note: 'x'.repeat(201) }],
  ])('%s → falha', (_label, body) => {
    expect(CreateExceptionDto.schema.safeParse(body).success).toBe(false);
  });

  it('apara a nota', () => {
    const parsed = CreateExceptionDto.schema.parse({ ...SWAP, note: ' ok ' });

    expect(parsed.note).toBe('ok');
  });
});

/** Férias a partir de 01/01/2026 com `days` dias (inclusivo). */
function vacationOf(days: number) {
  const startDate = '2026-01-01';
  return { kind: 'VACATION', startDate, endDate: addDays(startDate, days - 1) };
}
