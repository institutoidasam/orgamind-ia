import { describe, it, expect } from 'vitest';
import { PassThrough, Writable } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import * as ExcelJS from 'exceljs';
import { XlsxStreamWriter } from './xlsx-writer';

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

async function readBack(bytes: Promise<Buffer>): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load((await bytes) as unknown as ArrayBuffer);
  return workbook;
}

describe('XlsxStreamWriter', () => {
  it('grava duas abas na ordem, com as linhas como texto', async () => {
    const sink = new PassThrough();
    const bytes = collect(sink);
    const writer = new XlsxStreamWriter(sink);
    writer.startSheet('Pessoas');
    await writer.writeRow(['matricula', 'nome']);
    await writer.writeRow(['1', 'Ana']);
    writer.startSheet('Instruções');
    await writer.writeRow(['Como preencher']);
    await writer.close();

    const workbook = await readBack(bytes);
    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual([
      'Pessoas',
      'Instruções',
    ]);
    const pessoas = workbook.getWorksheet('Pessoas')!;
    expect(pessoas.getRow(2).getCell(1).value).toBe('1');
    expect(pessoas.getRow(2).getCell(1).type).toBe(ExcelJS.ValueType.String);
    expect(pessoas.getRow(2).getCell(2).value).toBe('Ana');
    expect(workbook.getWorksheet('Instruções')!.getCell('A1').value).toBe(
      'Como preencher',
    );
  });

  it('texto que começa por = fica string, sem fórmula e sem apóstrofo', async () => {
    const sink = new PassThrough();
    const bytes = collect(sink);
    const writer = new XlsxStreamWriter(sink);
    const written = ['=1+1', '-5', '0012', '19/11/2026'];
    writer.startSheet('Pessoas');
    await writer.writeRow(written);
    await writer.close();

    const row = (await readBack(bytes)).getWorksheet('Pessoas')!.getRow(1);
    written.forEach((text, index) => {
      const cell = row.getCell(index + 1);
      expect(cell.type).toBe(ExcelJS.ValueType.String);
      expect(cell.value).toBe(text);
      expect(cell.formula).toBeUndefined();
    });
  });

  it('writeRow antes de startSheet rejeita', async () => {
    const writer = new XlsxStreamWriter(new PassThrough());
    await expect(writer.writeRow(['a'])).rejects.toThrow('startSheet');
  });
});

describe('XlsxStreamWriter destino fechado no meio', () => {
  const stalled = (): Writable =>
    new Writable({ highWaterMark: 1, write() {} });

  it('destruído entre as linhas: writeRow rejeita e close resolve, sem pendurar', async () => {
    const sink = stalled();
    const writer = new XlsxStreamWriter(sink);
    writer.startSheet('Pessoas');
    await writer.writeRow(['matricula', 'nome']);
    sink.destroy();
    await expect(settlesWithin(writer.writeRow(['1', 'Ana']))).rejects.toThrow(
      'destino fechado',
    );
    await expect(settlesWithin(writer.close())).resolves.toBeUndefined();
  });

  it('destruído durante o fechamento: close rejeita, sem pendurar', async () => {
    const sink = stalled();
    const writer = new XlsxStreamWriter(sink);
    writer.startSheet('Pessoas');
    await writer.writeRow(['matricula', 'nome']);
    const closing = writer.close();
    sink.destroy();
    await expect(settlesWithin(closing)).rejects.toThrow('destino fechado');
  });

  it('erro do destino durante o fechamento: close rejeita com ele', async () => {
    const sink = stalled();
    const writer = new XlsxStreamWriter(sink);
    writer.startSheet('Pessoas');
    const closing = writer.close();
    sink.destroy(new Error('disco cheio'));
    await expect(settlesWithin(closing)).rejects.toThrow('disco cheio');
  });
});
