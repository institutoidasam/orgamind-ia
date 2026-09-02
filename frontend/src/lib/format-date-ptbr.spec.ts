import { describe, it, expect } from 'vitest';
import { formatDatePtBr, formatRelativeToToday } from './format-date-ptbr';

describe('formatDatePtBr', () => {
  it('formata YYYY-MM-DD como DD/MM/YYYY', () => {
    expect(formatDatePtBr('2026-08-23')).toBe('23/08/2026');
  });

  it('preserva zero à esquerda no dia e no mês', () => {
    expect(formatDatePtBr('2026-01-05')).toBe('05/01/2026');
  });
});

describe('formatRelativeToToday', () => {
  it('retorna "hoje" quando a data é o próprio dia de `now`', () => {
    expect(formatRelativeToToday('2026-08-23', new Date('2026-08-23T15:00:00'))).toBe('hoje');
  });

  it('retorna "há 1 dia" um dia depois', () => {
    expect(formatRelativeToToday('2026-08-23', new Date('2026-08-24T09:00:00'))).toBe('há 1 dia');
  });

  it('retorna "há N dias" para N > 1', () => {
    expect(formatRelativeToToday('2026-08-23', new Date('2026-08-30T09:00:00'))).toBe('há 7 dias');
  });

  it('nunca retorna dias negativos: uma data "futura" em relação a `now` também vira "hoje"', () => {
    expect(formatRelativeToToday('2026-08-25', new Date('2026-08-23T09:00:00'))).toBe('hoje');
  });
});
