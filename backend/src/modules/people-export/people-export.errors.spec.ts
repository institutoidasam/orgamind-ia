import { describe, expect, it } from 'vitest';
import {
  exportSectorNotFound,
  exportShiftNotFound,
  noManagedSector,
  peopleTooLarge,
  scheduleTooLarge,
  sectorOutOfReach,
} from './people-export.errors';

describe('erros da exportação', () => {
  it('código, status e texto para a tela de cada recusa', () => {
    const table = [
      [peopleTooLarge(), 'export.too_large', 422, 'Exportação grande demais'],
      [scheduleTooLarge(), 'export.too_large', 422, 'Exportação grande demais'],
      [sectorOutOfReach(), 'export.out_of_reach', 403, 'Ação não permitida'],
      [noManagedSector(), 'export.out_of_reach', 403, 'Ação não permitida'],
      [
        exportSectorNotFound(),
        'export.sector_not_found',
        404,
        'Setor não encontrado',
      ],
      [
        exportShiftNotFound(),
        'export.shift_not_found',
        404,
        'Turno não encontrado',
      ],
    ] as const;

    for (const [error, code, status, message] of table) {
      expect(error).toMatchObject({ code, status, message });
    }
    expect(peopleTooLarge().detail).toBe(
      'Há pessoas demais para um arquivo só. Filtre por setor ou turno.',
    );
    expect(scheduleTooLarge().detail).toBe(
      'Há pessoas demais neste setor para um arquivo só.',
    );
    expect(sectorOutOfReach().detail).toBe(
      'Você só pode exportar pessoas dos setores que gerencia.',
    );
    expect(noManagedSector().detail).toBe('Você não gerencia nenhum setor.');
    expect(exportSectorNotFound().detail).toBe('Setor não encontrado.');
    expect(exportShiftNotFound().detail).toBe('Turno não encontrado.');
  });
});
