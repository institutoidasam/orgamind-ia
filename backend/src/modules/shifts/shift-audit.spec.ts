import { describe, expect, it } from 'vitest';
import { shiftAuditChanges, type ShiftAuditRow } from './shift-audit';

const DAY: ShiftAuditRow = {
  id: 'shift_day',
  name: 'Manhã',
  startTime: '06:00',
  endTime: '14:00',
  isActive: true,
};

describe('shiftAuditChanges', () => {
  it('criação lista nome, início, fim e ativo', () => {
    expect(shiftAuditChanges(null, DAY)).toEqual([
      { field: 'name', before: null, after: 'Manhã' },
      { field: 'startTime', before: null, after: '06:00' },
      { field: 'endTime', before: null, after: '14:00' },
      { field: 'isActive', before: null, after: true },
    ]);
  });

  it('alteração só dos campos que mudaram', () => {
    const after = { ...DAY, name: 'Manhã 2', endTime: '15:00' };
    expect(shiftAuditChanges(DAY, after)).toEqual([
      { field: 'name', before: 'Manhã', after: 'Manhã 2' },
      { field: 'endTime', before: '14:00', after: '15:00' },
    ]);
  });

  it('nada mudou — vazio', () => {
    expect(shiftAuditChanges(DAY, { ...DAY })).toEqual([]);
  });
});
