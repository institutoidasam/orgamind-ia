import * as ExcelJS from 'exceljs';
import {
  SheetCollector,
  SheetReadError,
  XLSX_MAX_UNCOMPRESSED,
  type SheetData,
} from './sheet-data';
import { zipInflatedTotal, zipUncompressedTotal } from './zip-size';

export type XlsxReadOptions = {
  /** Reescreve um XLSX que o exceljs não abre (EX1: quem chama passa o conserto, `shared` não importa de `modules`). */
  repair?: (buffer: Buffer) => Promise<Buffer>;
  /** Teto do tamanho descompactado (EX3 (1)); padrão `XLSX_MAX_UNCOMPRESSED`. */
  maxUncompressed?: number;
};

/** Data do Excel = data civil à meia-noite UTC: vale pelos campos UTC, sem fuso. */
function dateText(value: Date): string {
  return Number.isNaN(value.getTime()) ? '' : value.toISOString().slice(0, 10);
}

function objectCellText(
  value: Exclude<ExcelJS.CellValue, string | number | boolean | Date | null>,
): string {
  if (value === undefined) return '';
  if ('richText' in value) {
    return value.richText.map((part) => part.text).join('');
  }
  if ('hyperlink' in value) return xlsxCellText(value.text);
  if ('formula' in value || 'sharedFormula' in value) {
    return xlsxCellText(value.result);
  }
  return '';
}

/**
 * Texto de uma célula (EX3), lida crua: fórmula vale pelo `result`, data vira
 * AAAA-MM-DD, número vira texto, booleano Sim/Não, rich text junta os trechos,
 * hyperlink vale pelo `text`; erro e vazio viram ''.
 */
export function xlsxCellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number')
    return Number.isFinite(value) ? String(value) : '';
  if (typeof value === 'boolean') return value ? 'Sim' : 'Não';
  if (value instanceof Date) return dateText(value);
  return objectCellText(value);
}

function assertTotal(total: number | null, limit: number): void {
  if (total === null) throw new SheetReadError('unreadable');
  if (total > limit) throw new SheetReadError('expands_too_much');
}

/**
 * Teto do tamanho descompactado antes de abrir (EX3 (1)): primeiro o declarado no
 * diretório central (barato), depois o real, entrada por entrada, parando no teto.
 * O declarado pode mentir, e o jszip do `xlsx.load` só confere o real depois de
 * descompactar a entrada inteira na memória.
 */
function assertWithinLimit(buffer: Buffer, limit: number): void {
  assertTotal(zipUncompressedTotal(buffer), limit);
  assertTotal(zipInflatedTotal(buffer, limit), limit);
}

async function tryLoad(
  buffer: Buffer,
  limit: number,
): Promise<ExcelJS.Workbook | null> {
  assertWithinLimit(buffer, limit);
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);
    return workbook;
  } catch {
    return null;
  }
}

async function tryRepair(
  buffer: Buffer,
  repair: (buffer: Buffer) => Promise<Buffer>,
): Promise<Buffer | null> {
  try {
    return await repair(buffer);
  } catch {
    return null;
  }
}

async function openWorkbook(
  buffer: Buffer,
  { repair, maxUncompressed = XLSX_MAX_UNCOMPRESSED }: XlsxReadOptions,
): Promise<ExcelJS.Workbook> {
  const direct = await tryLoad(buffer, maxUncompressed);
  if (direct) return direct;
  const repaired = repair ? await tryRepair(buffer, repair) : null;
  const workbook = repaired ? await tryLoad(repaired, maxUncompressed) : null;
  if (!workbook) throw new SheetReadError('unreadable');
  return workbook;
}

function rowTexts(row: ExcelJS.Row): string[] {
  const cells: (string | undefined)[] = [];
  row.eachCell({ includeEmpty: false }, (cell, column) => {
    cells[column - 1] = xlsxCellText(cell.value);
  });
  return Array.from(cells, (text) => text ?? '');
}

/** Só as linhas com valor; o coletor descarta a toda vazia e lança no limite de linhas. */
function collectRows(
  sheet: ExcelJS.Worksheet,
  collector: SheetCollector,
): void {
  let first = true;
  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    // Cabeçalho na linha 1: se ela não tem valor, o arquivo não tem cabeçalho.
    if (first && rowNumber !== 1) throw new SheetReadError('empty');
    first = false;
    collector.add(rowNumber, rowTexts(row));
  });
}

/** Lê a primeira aba (cabeçalho na linha 1) de um XLSX enviado; entrada não confiável (EX3). */
export async function readXlsxSheet(
  buffer: Buffer,
  opts: XlsxReadOptions = {},
): Promise<SheetData> {
  const workbook = await openWorkbook(buffer, opts);
  const sheet = workbook.worksheets.at(0);
  if (!sheet) throw new SheetReadError('empty');
  const collector = new SheetCollector();
  collectRows(sheet, collector);
  return collector.finish();
}
