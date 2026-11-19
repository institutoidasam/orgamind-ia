import { describe, it, expect } from 'vitest';
import {
  categoryOfAction,
  diffFields,
  maskEmail,
  maskPhone,
  type AuditValue,
} from './audit-change';

describe('diffFields', () => {
  it('lista só os campos alterados e compara AuditRef por id, não por nome', () => {
    const before = {
      jobTitle: 'Analista',
      sector: { id: 's1', name: 'Logística' },
      shift: { id: 't1', name: 'Manhã' },
    };
    const after = {
      jobTitle: 'Líder',
      sector: { id: 's1', name: 'Logística 2' },
      shift: { id: 't2', name: 'Tarde' },
    };
    expect(diffFields(before, after)).toEqual([
      { field: 'jobTitle', before: 'Analista', after: 'Líder' },
      { field: 'shift', before: before.shift, after: after.shift },
    ]);
  });

  it('criação (before null) lista só os campos não nulos com before null', () => {
    const after = { name: 'Ana', registration: null, jobTitle: 'Analista' };
    expect(diffFields(null, after)).toEqual([
      { field: 'name', before: null, after: 'Ana' },
      { field: 'jobTitle', before: null, after: 'Analista' },
    ]);
  });

  it('compara cru e aplica present depois: dois telefones de mesmo final viram uma alteração com os lados mascarados iguais', () => {
    const present = (field: string, value: AuditValue): AuditValue =>
      field === 'phone' ? maskPhone(value as string | null) : value;
    const result = diffFields(
      { phone: '+5592988887777' },
      { phone: '+5511977777777' },
      present,
    );
    expect(result).toEqual([
      { field: 'phone', before: '•••• 7777', after: '•••• 7777' },
    ]);
  });

  it('nunca registra campo de senha, nem cru nem mascarado', () => {
    const result = diffFields(
      { name: 'Ana', password: 'velha', passwordHash: 'h1' },
      { name: 'Ana B', password: 'nova', passwordHash: 'h2' },
    );
    expect(result).toEqual([{ field: 'name', before: 'Ana', after: 'Ana B' }]);
  });
});

describe('maskPhone', () => {
  it.each([
    ['+5592988887777', '•••• 7777'],
    ['(92) 98888-1234', '•••• 1234'],
    ['12', '••••'],
    [null, null],
    [undefined, null],
  ])('%s vira %s', (input, expected) => {
    expect(maskPhone(input)).toBe(expected);
  });
});

describe('maskEmail', () => {
  it.each([
    ['ana@gbr.com.br', 'a•••@gbr.com.br'],
    ['semarroba', '•••'],
    [null, null],
    [undefined, null],
  ])('%s vira %s', (input, expected) => {
    expect(maskEmail(input)).toBe(expected);
  });
});

describe('categoryOfAction', () => {
  it.each([
    ['user.deleted', 'PERSON'],
    ['sector_people.moved', 'ASSIGNMENT'],
    ['assignment.created', 'ASSIGNMENT'],
    ['staff_schedule.put', 'SCHEDULE'],
    ['sector.updated', 'STRUCTURE'],
    ['shift.updated', 'STRUCTURE'],
    ['permission.granted', 'PERMISSIONS'],
    ['campaign.create', null],
    ['auth.login_success', null],
  ])('%s cai em %s', (action, expected) => {
    expect(categoryOfAction(action)).toBe(expected);
  });
});
