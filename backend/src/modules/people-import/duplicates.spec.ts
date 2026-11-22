import { describe, expect, it } from 'vitest';
import type { RawFields } from './cell-values';
import { rowOf } from './classify-row.fixtures';
import { duplicateOf } from './duplicates';

const line = (rowNumber: number, cells: Partial<RawFields>) => ({
  rowNumber,
  fields: rowOf(cells).fields,
});

describe('duplicateOf (EX31)', () => {
  it('mesma matrícula sem caixa ou mesmo telefone nas duas grafias; mascarado não conta; a primeira segue', () => {
    const rows = [
      line(2, { registration: 'MAT-01', phone: '+5592991110001' }),
      line(3, { registration: 'mat-01', name: 'Outra Pessoa' }),
      // A primeira ocorrência conta mesmo inválida (nome longo demais).
      line(4, { name: 'x'.repeat(121), phone: '+5592991110002' }),
      line(5, { name: 'Rafael Lima', phone: '(92) 9111-0002' }),
      line(6, { name: 'Ana Costa', phone: '•••• 0001' }),
      line(7, { name: 'Ana Costa', phone: '•••• 0001' }),
      line(8, { name: 'Bruno Alves', phone: '123' }),
      line(9, { name: 'Bruno Alves', phone: '123' }),
      line(10, { registration: 'MAT-09', phone: '92 99111-0001' }),
    ];

    expect([...duplicateOf(rows)]).toEqual([
      [3, 2],
      [5, 4],
      [10, 2],
    ]);
  });

  it('linhas Ignoradas não entram nas duplicadas', () => {
    const rows = [
      line(2, { registration: 'EXEMPLO', phone: '+5592991110001' }),
      line(3, {}),
      line(4, { registration: 'exemplo', phone: '+5592991110001' }),
      line(5, { name: 'Marina Souza', phone: '+5592991110001' }),
      line(6, {}),
    ];

    expect(duplicateOf(rows).size).toBe(0);
  });
});
