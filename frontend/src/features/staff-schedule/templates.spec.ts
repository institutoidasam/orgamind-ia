import { describe, expect, it } from 'vitest';
import { applyPreset, custom, resizeCycle, twelve36, weekly, weeklyRotation } from './templates';

describe('modelos de escala', () => {
  it('Semanal alinha à segunda e põe seg a sex no turno', () => {
    expect(weekly('noite', '2026-10-29')).toStrictEqual({
      template: 'WEEKLY',
      startDate: '2026-10-26',
      cycleLength: 7,
      days: ['noite', 'noite', 'noite', 'noite', 'noite', null, null],
    });
  });

  it('Rodízio semanal: semana A, semana B, fins de semana de folga', () => {
    const result = weeklyRotation({ shiftA: 'manha', shiftB: 'noite', anyDate: '2026-10-29' });
    expect(result.template).toBe('WEEKLY_ROTATION');
    expect(result.startDate).toBe('2026-10-26');
    expect(result.cycleLength).toBe(14);
    expect(result.days).toStrictEqual([
      'manha', 'manha', 'manha', 'manha', 'manha', null, null,
      'noite', 'noite', 'noite', 'noite', 'noite', null, null,
    ]);
  });

  it('12x36 mantém o início e alterna trabalho e folga', () => {
    expect(twelve36('noite', '2026-10-21')).toStrictEqual({
      template: 'TWELVE_36', startDate: '2026-10-21', cycleLength: 2, days: ['noite', null],
    });
  });

  it('Personalizado nasce todo de folga', () => {
    expect(custom(5, '2026-10-21')).toStrictEqual({
      template: 'CUSTOM', startDate: '2026-10-21', cycleLength: 5, days: [null, null, null, null, null],
    });
  });

  it.each([
    ['encurta mantendo o prefixo', weekly('noite', '2026-10-21'), 3, ['noite', 'noite', 'noite']],
    ['alonga completando com folga', twelve36('noite', '2026-10-21'), 4, ['noite', null, null, null]],
  ])('resizeCycle %s', (_name, schedule, size, days) => {
    expect(resizeCycle(schedule, size)).toStrictEqual({ ...schedule, cycleLength: size, days });
  });

  it('applyPreset delega ao modelo escolhido', () => {
    const input = { shiftA: 'manha', shiftB: 'noite', startDate: '2026-10-21' };
    expect(applyPreset('WEEKLY', input)).toStrictEqual(weekly('manha', '2026-10-21'));
    expect(applyPreset('TWELVE_36', input)).toStrictEqual(twelve36('manha', '2026-10-21'));
    expect(applyPreset('WEEKLY_ROTATION', input)).toStrictEqual(
      weeklyRotation({ shiftA: 'manha', shiftB: 'noite', anyDate: '2026-10-21' }),
    );
  });
});
