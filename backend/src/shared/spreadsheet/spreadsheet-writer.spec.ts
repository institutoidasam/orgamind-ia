import { describe, it, expect } from 'vitest';
import { PassThrough, Writable } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import * as ExcelJS from 'exceljs';
import { CSV_BOM, CsvStreamWriter } from './csv-writer';
import { openSpreadsheet, type SpreadsheetFormat } from './spreadsheet-writer';

function collect(sink: PassThrough): Promise<Buffer> {
  const chunks: Buffer[] = [];
  sink.on('data', (chunk: Buffer) => chunks.push(chunk));
  return new Promise((resolve) =>
    sink.on('end', () => resolve(Buffer.concat(chunks))),
  );
}

/** Falha (em vez de esperar sem fim) se a Promise não assentar em `ms`. */
function settlesWithin<T>(promise: Promise<T>, ms = 1000): Promise<T> {
  const hung = sleep(ms, undefined, { ref: false }).then((): never => {
    throw new Error(`pendurado: sem resolver nem rejeitar em ${ms} ms`);
  });
  return Promise.race([promise, hung]);
}

describe('openSpreadsheet csv', () => {
  it('csv: escreve pelo CsvStreamWriter e startSheet lança', async () => {
    const sink = new PassThrough();
    const bytes = collect(sink);
    const writer = openSpreadsheet({
      sink,
      format: 'csv',
      firstSheet: 'Pessoas',
    });
    expect(writer).toBeInstanceOf(CsvStreamWriter);
    expect(() => writer.startSheet('Instruções')).toThrow('CSV tem uma aba só');
    await writer.writeRow(['matricula', '=1+1']);
    await writer.close();
    expect((await bytes).toString('utf8')).toBe(
      `${CSV_BOM}matricula;'=1+1\r\n`,
    );
  });
});

describe('openSpreadsheet xlsx', () => {
  it('xlsx: startSheet abre uma aba nova', async () => {
    const sink = new PassThrough();
    const bytes = collect(sink);
    const writer = openSpreadsheet({
      sink,
      format: 'xlsx',
      firstSheet: 'Pessoas',
    });
    await writer.writeRow(['matricula']);
    writer.startSheet('Instruções');
    await writer.writeRow(['Como preencher']);
    await writer.close();

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load((await bytes) as unknown as ArrayBuffer);
    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual([
      'Pessoas',
      'Instruções',
    ]);
    expect(workbook.getWorksheet('Pessoas')!.getCell('A1').value).toBe(
      'matricula',
    );
  });
});

describe('openSpreadsheet com o cliente desconectado no meio', () => {
  const formats: SpreadsheetFormat[] = ['csv', 'xlsx'];

  it.each(formats)(
    '%s: writeRow rejeita e close resolve, sem pendurar',
    async (format) => {
      const sink = new Writable({ write: (_c, _e, done) => done() });
      const writer = openSpreadsheet({ sink, format, firstSheet: 'Pessoas' });
      await settlesWithin(writer.writeRow(['matricula', 'nome']));
      sink.destroy();
      await expect(
        settlesWithin(writer.writeRow(['1', 'Ana'])),
      ).rejects.toThrow('destino fechado');
      await expect(settlesWithin(writer.close())).resolves.toBeUndefined();
    },
  );
});
