import { describe, it, expect, vi } from 'vitest';
import { parseCsvRecords } from './csv-reader';
import {
  IMPORT_MAX_COLUMNS,
  IMPORT_MAX_ROWS,
  SheetCollector,
  SheetReadError,
  type SheetReadProblem,
} from './sheet-data';

type Failure = { problem: SheetReadProblem; detail: string | null };

function failureOf(run: () => unknown): Failure {
  try {
    run();
  } catch (error) {
    if (error instanceof SheetReadError) {
      return { problem: error.problem, detail: error.detail };
    }
    throw error;
  }
  throw new Error('não lançou SheetReadError');
}

/** O primeiro registro é o cabeçalho; as linhas seguem a ordem dada, a partir da 1. */
function collectorWith(...records: string[][]): SheetCollector {
  const collector = new SheetCollector();
  records.forEach((cells, index) => collector.add(index + 1, cells));
  return collector;
}

describe('SheetCollector: registros em branco antes do cabeçalho', () => {
  it('o primeiro registro com valor é o cabeçalho, e os números de linha seguem o arquivo', () => {
    const sheet = collectorWith([], ['', ' '], ['Nome', 'Setor'], ['Ana']);
    expect(sheet.finish()).toEqual({
      headers: ['Nome', 'Setor'],
      rows: [{ rowNumber: 4, cells: ['Ana', ''] }],
    });
  });
});

describe('SheetCollector: problemas do arquivo', () => {
  it('arquivo vazio → empty; só cabeçalho → no_data; cabeçalho repetido → duplicate_header com o nome', () => {
    const empty = { problem: 'empty', detail: null };
    expect(failureOf(() => new SheetCollector().finish())).toEqual(empty);
    expect(failureOf(() => collectorWith(['', ' ']).finish())).toEqual(empty);
    expect(
      failureOf(() => collectorWith(['Nome', 'Setor'], ['', '  ']).finish()),
    ).toEqual({ problem: 'no_data', detail: null });
    expect(
      failureOf(() =>
        collectorWith(['Nome', 'Setor', ' nome '], ['a', 'b', 'c']).finish(),
      ),
    ).toEqual({ problem: 'duplicate_header', detail: 'nome' });
  });

  it('5.001 linhas de dados → too_many_rows; linhas em branco em qualquer lugar não contam', () => {
    const collector = collectorWith(['Nome'], ['']);
    for (let n = 1; n <= IMPORT_MAX_ROWS; n++) {
      collector.add(n * 2 + 1, [`P${n}`]);
      collector.add(n * 2 + 2, ['  ']);
    }
    expect(collector.finish().rows).toHaveLength(IMPORT_MAX_ROWS);
    expect(failureOf(() => collector.add(99_999, ['P5001']))).toEqual({
      problem: 'too_many_rows',
      detail: null,
    });
  });
});

describe('SheetCollector: parada no limite', () => {
  it('o registro com valor de número 5.001 lança na hora: nada depois dele é lido', () => {
    const lines = ['Nome'];
    for (let n = 1; n <= IMPORT_MAX_ROWS + 1_000; n++) lines.push(`P${n}`);
    const collector = new SheetCollector();
    const onRecord = vi.fn((rowNumber: number, cells: string[]) =>
      collector.add(rowNumber, cells),
    );

    const failure = failureOf(() =>
      parseCsvRecords(lines.join('\n'), ';', onRecord),
    );

    expect(failure).toEqual({ problem: 'too_many_rows', detail: null });
    expect(onRecord).toHaveBeenCalledTimes(IMPORT_MAX_ROWS + 2);
  });
});

describe('SheetCollector: linhas e colunas', () => {
  it('linha em branco no meio não é guardada e não muda a numeração das outras', () => {
    const collector = collectorWith(
      ['Nome', 'Setor'],
      ['Ana', 'TI'],
      ['', ' '],
      ['Bia', 'RH'],
    );
    expect(collector.finish().rows).toEqual([
      { rowNumber: 2, cells: ['Ana', 'TI'] },
      { rowNumber: 4, cells: ['Bia', 'RH'] },
    ]);
  });

  it('cabeçalho vazio vira Coluna N e células completam a largura', () => {
    const sheet = collectorWith(
      ['Nome', ' ', ' Setor '],
      ['Ana'],
      ['Bia', 'x', 'y', 'z'],
    ).finish();
    expect(sheet.headers).toEqual(['Nome', 'Coluna 2', 'Setor', 'Coluna 4']);
    expect(sheet.rows.map((row) => row.cells)).toEqual([
      ['Ana', '', '', ''],
      ['Bia', 'x', 'y', 'z'],
    ]);
  });

  it('colunas vazias no fim não contam; acima do teto de colunas com valor → unreadable', () => {
    const sheet = collectorWith(['A', 'B', '', ''], ['1', '2', '', '', '']);
    expect(sheet.finish().headers).toEqual(['A', 'B']);
    const wide = Array.from({ length: IMPORT_MAX_COLUMNS + 1 }, () => 'x');
    expect(failureOf(() => new SheetCollector().add(1, wide))).toEqual({
      problem: 'unreadable',
      detail: 'too_many_columns',
    });
  });
});
