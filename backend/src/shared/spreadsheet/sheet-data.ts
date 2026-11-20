/** Limites e formato comum da leitura de planilhas enviadas (CSV e XLSX). */
export const IMPORT_MAX_BYTES = 5 * 1024 * 1024;
export const IMPORT_MAX_ROWS = 5_000;
/** Teto de colunas com valor: o preenchimento até a largura multiplica linhas por colunas. */
export const IMPORT_MAX_COLUMNS = 500;
export const XLSX_MAX_UNCOMPRESSED = 60 * 1024 * 1024;

/** Cabeçalho = primeira linha com valor (linha 1 no XLSX); só entram as linhas com valor. */
export type SheetRow = { rowNumber: number; cells: string[] };
export type SheetData = { headers: string[]; rows: SheetRow[] };

export type SheetReadProblem =
  | 'empty'
  | 'no_data'
  | 'too_many_rows'
  | 'duplicate_header'
  | 'unreadable'
  | 'unclosed_quote'
  | 'expands_too_much';

export class SheetReadError extends Error {
  constructor(
    readonly problem: SheetReadProblem,
    readonly detail: string | null = null,
  ) {
    super(detail === null ? problem : `${problem}: ${detail}`);
    this.name = 'SheetReadError';
  }
}

/** Tira as células vazias (depois do trim) do fim do registro. */
function withoutTrailingBlanks(cells: readonly string[]): string[] {
  let end = cells.length;
  while (end > 0 && cells[end - 1].trim() === '') end--;
  return cells.slice(0, end);
}

/**
 * Recebe os registros na ordem do arquivo: o primeiro com valor é o cabeçalho;
 * registro sem valor não é guardado nem contado e o de número `IMPORT_MAX_ROWS + 1`
 * lança na hora, para a leitura parar ali.
 */
export class SheetCollector {
  private header: string[] | null = null;
  private readonly rows: SheetRow[] = [];
  private width = 0;

  /** O cabeçalho (primeiro registro com valor) já chegou; o seguinte é dado. */
  get hasHeader(): boolean {
    return this.header !== null;
  }

  add(rowNumber: number, cells: readonly string[]): void {
    const kept = withoutTrailingBlanks(cells);
    if (kept.length > IMPORT_MAX_COLUMNS) {
      throw new SheetReadError('unreadable', 'too_many_columns');
    }
    // Registro sem valor nunca é guardado nem contado, nem antes do cabeçalho.
    if (kept.length === 0) return;
    if (this.header === null) {
      this.header = kept.map((cell) => cell.trim());
    } else {
      if (this.rows.length >= IMPORT_MAX_ROWS) {
        throw new SheetReadError('too_many_rows');
      }
      this.rows.push({ rowNumber, cells: kept });
    }
    this.width = Math.max(this.width, kept.length);
  }

  finish(): SheetData {
    const header = this.header ?? [];
    if (header.length === 0) throw new SheetReadError('empty');
    const headers = Array.from(
      { length: this.width },
      (_, index) => header[index] || `Coluna ${index + 1}`,
    );
    this.assertNoDuplicate(headers);
    if (this.rows.length === 0) throw new SheetReadError('no_data');
    const rows = this.rows.map(({ rowNumber, cells }) => ({
      rowNumber,
      cells: Array.from(
        { length: this.width },
        (_, index) => cells[index] ?? '',
      ),
    }));
    return { headers, rows };
  }

  private assertNoDuplicate(headers: readonly string[]): void {
    const seen = new Set<string>();
    for (const name of headers) {
      const key = name.toLowerCase();
      if (seen.has(key)) throw new SheetReadError('duplicate_header', name);
      seen.add(key);
    }
  }
}
