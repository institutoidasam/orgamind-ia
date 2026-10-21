import { describe, expect, it } from 'vitest';
import { addDays, daysBetween, formatDayMonth, isoWeekday, mondayOf, monthRange, weekRange } from './civil-date';

describe('civil-date: aritmética de calendário em YYYY-MM-DD', () => {
  it('addDays cruza mês e ano, para frente e para trás', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('isoWeekday: 1 = segunda … 7 = domingo', () => {
    expect(isoWeekday('2026-10-26')).toBe(1);
    expect(isoWeekday('2026-10-25')).toBe(7);
  });

  it('mondayOf devolve a segunda da semana (domingo pertence à semana que termina nele)', () => {
    expect(mondayOf('2026-11-01')).toBe('2026-10-26');
    expect(mondayOf('2026-10-26')).toBe('2026-10-26');
  });

  it('weekRange e monthRange', () => {
    expect(weekRange('2026-10-21')).toEqual({ from: '2026-10-19', to: '2026-10-25' });
    expect(monthRange('2026-10-21')).toEqual({ from: '2026-10-01', to: '2026-10-31' });
    expect(monthRange('2028-02-10')).toEqual({ from: '2028-02-01', to: '2028-02-29' });
  });

  it('daysBetween é inclusivo nas duas pontas', () => {
    expect(daysBetween('2026-10-30', '2026-11-02')).toEqual(['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02']);
  });

  it('formatDayMonth', () => {
    expect(formatDayMonth('2026-10-21')).toBe('21/10');
  });
});
