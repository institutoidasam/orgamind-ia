import type { Writable } from 'node:stream';
import { CsvStreamWriter } from './csv-writer';
import { XlsxStreamWriter } from './xlsx-writer';

export type SpreadsheetFormat = 'csv' | 'xlsx';

/** Escritor único por formato: quem exporta não sabe se grava CSV ou XLSX. */
export interface SpreadsheetWriter {
  writeRow(cells: readonly string[]): Promise<void>;
  /** CSV tem uma aba só: lança `Error('CSV tem uma aba só')`. */
  startSheet(name: string): void;
  close(): Promise<void>;
}

class CsvSpreadsheetWriter
  extends CsvStreamWriter
  implements SpreadsheetWriter
{
  startSheet(): void {
    throw new Error('CSV tem uma aba só');
  }
}

export function openSpreadsheet(input: {
  sink: Writable;
  format: SpreadsheetFormat;
  firstSheet: string;
}): SpreadsheetWriter {
  if (input.format === 'csv') return new CsvSpreadsheetWriter(input.sink);
  const writer = new XlsxStreamWriter(input.sink);
  writer.startSheet(input.firstSheet);
  return writer;
}
