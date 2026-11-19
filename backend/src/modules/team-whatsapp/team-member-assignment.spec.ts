import { describe, expect, it } from 'vitest';
import {
  withAssignmentOn,
  type AssignmentOnRow,
} from './team-member-assignment';
import { dayPerson } from './team-whatsapp.test-fixtures';

// Espelho de hoje: setor s1 (ativo), 1º turno, nível Coordenador.
const today = () =>
  dayPerson({
    sectorId: 's1',
    sector: { isActive: true },
    shiftId: 'shift_first',
    workShift: { name: '1º turno' },
    levelId: 'lv-coord',
    level: { id: 'lv-coord', name: 'Coordenador' },
  });

describe('withAssignmentOn — linha da pessoa pelo vínculo da data (DV9, DV11)', () => {
  it('sem linha devolve a linha da pessoa intacta', () => {
    const row = today();

    expect(withAssignmentOn(row, undefined)).toBe(row);
  });

  it('com linha troca setor, isActive do setor, turno e nível pelos da data', () => {
    const row = today();
    const line: AssignmentOnRow = {
      sectorId: 's-old',
      sector: { isActive: false },
      shiftId: 'shift_second',
      shift: { name: '2º turno' },
      levelId: 'lv-aux',
      level: { id: 'lv-aux', name: 'Auxiliar' },
    };

    expect(withAssignmentOn(row, line)).toEqual({
      ...today(),
      sectorId: 's-old',
      sector: { isActive: false },
      shiftId: 'shift_second',
      workShift: { name: '2º turno' },
      levelId: 'lv-aux',
      level: { id: 'lv-aux', name: 'Auxiliar' },
    });
    // Contato, autorização, ciclo e exceções ficam; a linha original não muda.
    expect(row).toEqual(today());
  });
});
