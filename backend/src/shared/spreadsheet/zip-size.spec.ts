import * as ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import {
  XLSX_MAX_ENTRIES,
  zipInflatedTotal,
  zipUncompressedTotal,
} from './zip-size';

const ENTRY_SIGNATURE = Buffer.from([0x50, 0x4b, 0x01, 0x02]);
const END_SIGNATURE = Buffer.from([0x50, 0x4b, 0x05, 0x06]);

async function buildXlsx(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Pessoas');
  sheet.addRow(['Matrícula', 'Nome']);
  sheet.addRow(['A1', 'Ana Exemplo'.repeat(40)]);
  workbook.addWorksheet('Outra').addRow(['x']);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

/** Zip de uma entrada só, `dados.xml`, com o cabeçalho local no início do arquivo. */
async function singleEntryZip(
  compression: 'DEFLATE' | 'STORE' = 'DEFLATE',
): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('dados.xml', 'x'.repeat(200_000));
  return zip.generateAsync({ type: 'nodebuffer', compression });
}

/** Cópia do zip com `change` aplicado; recebe a posição da entrada do diretório central e a do registro de fim. */
function patched(
  zip: Buffer,
  change: (copy: Buffer, entry: number, end: number) => void,
): Buffer {
  const copy = Buffer.from(zip);
  change(
    copy,
    copy.lastIndexOf(ENTRY_SIGNATURE),
    copy.lastIndexOf(END_SIGNATURE),
  );
  return copy;
}

/** Zip com `count` arquivos pequenos, cada um com o seu cabeçalho local. */
async function zipWithFiles(count: number): Promise<Buffer> {
  const zip = new JSZip();
  for (let index = 0; index < count; index++) zip.file(`f${index}.xml`, 'x');
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/** Diretório central com a última entrada repetida até somar `count`, todas apontando para o mesmo cabeçalho local. */
function repeatingLastEntry(zip: Buffer, count: number): Buffer {
  const end = zip.lastIndexOf(END_SIGNATURE);
  const entry = zip.subarray(zip.lastIndexOf(ENTRY_SIGNATURE), end);
  const directory = Buffer.concat(Array.from({ length: count }, () => entry));
  const record = Buffer.from(zip.subarray(end));
  record.writeUInt16LE(count, 8);
  record.writeUInt16LE(count, 10);
  record.writeUInt32LE(directory.length, 12);
  return Buffer.concat([
    zip.subarray(0, zip.readUInt32LE(end + 16)),
    directory,
    record,
  ]);
}

async function sumOfFileSizes(buffer: Buffer): Promise<number> {
  const zip = await JSZip.loadAsync(buffer);
  let total = 0;
  for (const file of Object.values(zip.files)) {
    if (!file.dir) total += (await file.async('nodebuffer')).length;
  }
  return total;
}

/** Cópia do zip com um comentário de `size` bytes depois do registro de fim. */
function withComment(zip: Buffer, size: number): Buffer {
  const copy = Buffer.concat([zip, Buffer.alloc(size, 'x')]);
  copy.writeUInt16LE(size, copy.lastIndexOf(END_SIGNATURE) + 20);
  return copy;
}

describe('zip-size: comentário depois do registro de fim', () => {
  it('zip com comentário, do curto ao máximo de 65.535 bytes, é medido igual ao sem comentário', async () => {
    const xlsx = await buildXlsx();
    const expected = await sumOfFileSizes(xlsx);
    for (const size of [1, 100, 0xffff]) {
      const commented = withComment(xlsx, size);
      expect(zipUncompressedTotal(commented)).toBe(expected);
      expect(zipInflatedTotal(commented, 1_000_000)).toBe(expected);
    }
  });
});

describe('zipUncompressedTotal', () => {
  it('soma o tamanho descompactado das entradas do diretório central de um xlsx do exceljs', async () => {
    const xlsx = await buildXlsx();
    const total = zipUncompressedTotal(xlsx);
    expect(total).toBeGreaterThan(0);
    expect(total).toBe(await sumOfFileSizes(xlsx));
  });

  it('buffer que não é zip, cortado ou com ZIP64 → null', async () => {
    const xlsx = await buildXlsx();
    const zip64 = Buffer.from(xlsx);
    zip64.writeUInt32LE(0xffffffff, zip64.lastIndexOf(ENTRY_SIGNATURE) + 24);
    const wrongSize = Buffer.from(xlsx);
    wrongSize.writeUInt32LE(0, wrongSize.lastIndexOf(END_SIGNATURE) + 12);
    const damaged = Buffer.from(xlsx);
    damaged.writeUInt32LE(0, damaged.lastIndexOf(ENTRY_SIGNATURE));

    expect(zipUncompressedTotal(Buffer.from('isto não é um zip'))).toBeNull();
    expect(zipUncompressedTotal(Buffer.alloc(0))).toBeNull();
    expect(zipUncompressedTotal(xlsx.subarray(0, xlsx.length - 10))).toBeNull();
    expect(zipUncompressedTotal(zip64)).toBeNull();
    expect(zipUncompressedTotal(wrongSize)).toBeNull();
    expect(zipUncompressedTotal(damaged)).toBeNull();
  });
});

describe('zipInflatedTotal', () => {
  it('mede o descompactado real: soma do xlsx, deflate e store; zip que declara pouco para no teto', async () => {
    const xlsx = await buildXlsx();
    const lying = patched(await singleEntryZip(), (copy, entry) =>
      copy.writeUInt32LE(10, entry + 24),
    );

    expect(zipInflatedTotal(xlsx, 1_000_000)).toBe(await sumOfFileSizes(xlsx));
    expect(zipInflatedTotal(await singleEntryZip('STORE'), 1_000_000)).toBe(
      200_000,
    );
    expect(zipUncompressedTotal(lying)).toBe(10);
    expect(zipInflatedTotal(lying, 1_000_000)).toBe(200_000);
    // Para em teto + 1, sem descompactar o resto.
    expect(zipInflatedTotal(lying, 1_000)).toBe(1_001);
  });

  it('método desconhecido, cabeçalho local quebrado, dados fora do arquivo, deflate corrompido ou contagem ZIP64 → null', async () => {
    const zip = await singleEntryZip();
    const dataStart = 30 + zip.readUInt16LE(26) + zip.readUInt16LE(28);
    const broken = [
      patched(zip, (copy, entry) => copy.writeUInt16LE(99, entry + 10)),
      patched(zip, (copy) => copy.writeUInt32LE(0, 0)),
      patched(zip, (copy, entry) =>
        copy.writeUInt32LE(copy.length, entry + 20),
      ),
      patched(zip, (copy) => copy.writeUInt8(0xff, dataStart)),
    ];
    const zip64Count = patched(zip, (copy, _entry, end) =>
      copy.writeUInt16LE(0xffff, end + 10),
    );

    for (const buffer of broken) {
      expect(zipInflatedTotal(buffer, 1_000_000)).toBeNull();
    }
    expect(zipUncompressedTotal(zip64Count)).toBeNull();
    expect(zipInflatedTotal(zip64Count, 1_000_000)).toBeNull();
  });
});

describe('zip-size: número de entradas do diretório central', () => {
  it('mais de XLSX_MAX_ENTRIES entradas → null nas duas conferências; no teto é medido', async () => {
    const atLimit = await zipWithFiles(XLSX_MAX_ENTRIES);
    const overLimit = await zipWithFiles(XLSX_MAX_ENTRIES + 1);

    expect(zipUncompressedTotal(atLimit)).toBe(XLSX_MAX_ENTRIES);
    expect(zipInflatedTotal(atLimit, 1_000_000)).toBe(XLSX_MAX_ENTRIES);
    expect(zipUncompressedTotal(overLimit)).toBeNull();
    expect(zipInflatedTotal(overLimit, 1_000_000)).toBeNull();
  });

  it('milhares de entradas apontando para o mesmo cabeçalho local, ou só duas, → null sem descompactar', async () => {
    const one = await zipWithFiles(1);
    // Sem o teto, cada entrada somaria 1 byte e o resultado seria 5.000, não null.
    expect(
      zipInflatedTotal(repeatingLastEntry(one, 5_000), 1_000_000),
    ).toBeNull();
    expect(zipInflatedTotal(repeatingLastEntry(one, 2), 1_000_000)).toBeNull();
    expect(zipUncompressedTotal(repeatingLastEntry(one, 2))).toBeNull();
  });
});
