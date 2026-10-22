import { describe, expect, it } from 'vitest';
import {
  addDays,
  diffDays,
  formatDayMonth,
  fromDbDate,
  isCivilDate,
  isoWeekday,
  timeIn,
  toDbDate,
  todayIn,
  zonedStart,
} from './civil-date';
import { civilDateSchema } from '../../schemas/contracts/civil-date.schema';

// Manaus = UTC−4 o ano todo (sem horário de verão).
describe('civil-date — fuso de Manaus', () => {
  it('21:00 de Manaus já é amanhã em UTC', () => {
    expect(todayIn(new Date('2026-10-22T01:00:00Z'))).toBe('2026-10-21');
    expect(todayIn(new Date('2026-10-22T04:00:00Z'))).toBe('2026-10-22');
    expect(timeIn(new Date('2026-10-22T06:00:00Z'))).toBe('02:00');
  });

  it('início do turno em Manaus', () => {
    expect(zonedStart('2026-10-21', '22:00').toISOString()).toBe(
      '2026-10-22T02:00:00.000Z',
    );
    expect(zonedStart('2026-10-21', '06:00').toISOString()).toBe(
      '2026-10-21T10:00:00.000Z',
    );
  });
});

describe('civil-date — calendário', () => {
  it.each<[string, () => unknown, unknown]>([
    ['virada de mês', () => addDays('2026-10-31', 1), '2026-11-01'],
    ['virada de ano', () => addDays('2026-12-31', 1), '2027-01-01'],
    ['volta na virada', () => addDays('2027-01-01', -2), '2026-12-30'],
    ['diff na virada', () => diffDays('2027-01-01', '2026-12-30'), 2],
    ['segunda = 1', () => isoWeekday('2026-10-26'), 1],
    ['domingo = 7', () => isoWeekday('2026-10-25'), 7],
    ['30/02 não existe', () => isCivilDate('2026-02-30'), false],
    ['29/02 bissexto', () => isCivilDate('2028-02-29'), true],
    ['formato errado', () => isCivilDate('2026-1-05'), false],
    ['dia/mês', () => formatDayMonth('2026-10-21'), '21/10'],
    [
      'ida e volta @db.Date',
      () => fromDbDate(toDbDate('2026-10-21')),
      '2026-10-21',
    ],
    [
      '@db.Date à meia-noite UTC',
      () => toDbDate('2026-10-21').toISOString(),
      '2026-10-21T00:00:00.000Z',
    ],
  ])('%s', (_, run, expected) => {
    expect(run()).toBe(expected);
  });

  it('civilDateSchema aceita data real e recusa 2026-02-30', () => {
    expect(civilDateSchema.safeParse('2026-10-21').success).toBe(true);
    expect(civilDateSchema.safeParse('2026-02-30').success).toBe(false);
    expect(civilDateSchema.safeParse('21/10/2026').success).toBe(false);
  });
});
