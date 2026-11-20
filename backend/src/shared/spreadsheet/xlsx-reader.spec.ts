import * as ExcelJS from 'exceljs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IMPORT_MAX_ROWS, SheetReadError } from './sheet-data';
import { readXlsxSheet, xlsxCellText } from './xlsx-reader';

type FillWorkbook = (workbook: ExcelJS.Workbook) => void;

async function xlsxWith(fill: FillWorkbook): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  fill(workbook);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

async function problemOf(run: Promise<unknown>): Promise<string> {
  try {
    await run;
  } catch (error) {
    if (error instanceof SheetReadError) return error.problem;
    throw error;
  }
  throw new Error('não lançou SheetReadError');
}

/** Zip real e pequeno com a última entrada do diretório central declarando 61 MB descompactados. */
async function hugeZip(): Promise<Buffer> {
  const zip = await xlsxWith((workbook) => {
    workbook.addWorksheet('Pessoas').addRow(['Nome']);
  });
  const entry = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  zip.writeUInt32LE(61 * 1024 * 1024, entry + 24);
  return zip;
}

const END_SIGNATURE = Buffer.from([0x50, 0x4b, 0x05, 0x06]);

/** Cópia do zip com cada entrada do diretório central declarando 1 byte descompactado. */
function declaringTinySizes(zip: Buffer): Buffer {
  const forged = Buffer.from(zip);
  const end = forged.lastIndexOf(END_SIGNATURE);
  let at = forged.readUInt32LE(end + 16);
  while (at < end) {
    forged.writeUInt32LE(1, at + 24);
    at +=
      46 +
      forged.readUInt16LE(at + 28) +
      forged.readUInt16LE(at + 30) +
      forged.readUInt16LE(at + 32);
  }
  return forged;
}

/** Cópia do zip com um comentário depois do registro de fim. */
function withZipComment(zip: Buffer, comment: string): Buffer {
  const text = Buffer.from(comment);
  const copy = Buffer.concat([zip, text]);
  copy.writeUInt16LE(text.length, copy.lastIndexOf(END_SIGNATURE) + 20);
  return copy;
}

function spyOnLoad() {
  const proto = Object.getPrototypeOf(new ExcelJS.Workbook().xlsx) as {
    load: (buffer: Buffer) => Promise<ExcelJS.Workbook>;
  };
  return vi.spyOn(proto, 'load');
}

afterEach(() => vi.restoreAllMocks());

describe('readXlsxSheet: tamanho real descompactado', () => {
  it('zip que declara pouco e expande acima do teto → expands_too_much sem chamar xlsx.load, no original e no reparado', async () => {
    const real = await xlsxWith((workbook) => {
      workbook.addWorksheet('Pessoas').addRow(['x'.repeat(200_000)]);
    });
    const forged = declaringTinySizes(real);
    const load = spyOnLoad();
    const maxUncompressed = 100_000;

    expect(await problemOf(readXlsxSheet(forged, { maxUncompressed }))).toBe(
      'expands_too_much',
    );
    expect(load).not.toHaveBeenCalled();

    const legit = await xlsxWith((workbook) => {
      workbook.addWorksheet('Pessoas').addRow(['Nome']);
    });
    load.mockRejectedValueOnce(new Error('xml inesperado'));
    const repair = () => Promise.resolve(forged);
    expect(
      await problemOf(readXlsxSheet(legit, { repair, maxUncompressed })),
    ).toBe('expands_too_much');
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('xlsx legítimo com comentário depois do registro de fim é lido', async () => {
    const buffer = await xlsxWith((workbook) => {
      const sheet = workbook.addWorksheet('Pessoas');
      sheet.addRow(['Nome']);
      sheet.addRow(['Ana Exemplo']);
    });
    const sheet = await readXlsxSheet(withZipComment(buffer, 'gerado à mão'));
    expect(sheet.rows).toEqual([{ rowNumber: 2, cells: ['Ana Exemplo'] }]);
  });
});

describe('readXlsxSheet: abas e linhas', () => {
  it('lê a primeira aba com o cabeçalho na linha 1', async () => {
    const buffer = await xlsxWith((workbook) => {
      const people = workbook.addWorksheet('Pessoas');
      people.addRow(['Matrícula', 'Nome']);
      people.addRow(['A1', 'Ana Exemplo']);
      people.addRow(['B2', 'Bia Exemplo']);
      workbook.addWorksheet('Outra').addRow(['Cabeçalho', 'de outra aba']);
    });
    expect(await readXlsxSheet(buffer)).toEqual({
      headers: ['Matrícula', 'Nome'],
      rows: [
        { rowNumber: 2, cells: ['A1', 'Ana Exemplo'] },
        { rowNumber: 3, cells: ['B2', 'Bia Exemplo'] },
      ],
    });
  });

  it('sem aba, ou com a linha 1 sem valor → empty', async () => {
    const noSheet = await xlsxWith(() => undefined);
    const noHeader = await xlsxWith((workbook) => {
      workbook.addWorksheet('Pessoas').getRow(2).values = ['Ana Exemplo'];
    });
    expect(await problemOf(readXlsxSheet(noSheet))).toBe('empty');
    expect(await problemOf(readXlsxSheet(noHeader))).toBe('empty');
  });
});

describe('readXlsxSheet: limite de linhas', () => {
  it('mais de 5.000 linhas → too_many_rows', async () => {
    const buffer = await xlsxWith((workbook) => {
      const sheet = workbook.addWorksheet('Pessoas');
      sheet.addRow(['Nome']);
      for (let n = 0; n <= IMPORT_MAX_ROWS; n++) sheet.addRow([`Pessoa ${n}`]);
    });
    expect(await problemOf(readXlsxSheet(buffer))).toBe('too_many_rows');
  });

  it('linhas sem valor no meio e no fim não são lidas nem contadas', async () => {
    const buffer = await xlsxWith((workbook) => {
      const sheet = workbook.addWorksheet('Pessoas');
      sheet.addRow(['Nome']);
      for (let n = 1; n <= IMPORT_MAX_ROWS; n++) {
        sheet.addRow([`Pessoa ${n}`]);
        if (n % 1000 === 0) sheet.addRow(['   ']);
      }
      sheet.addRow([]);
      sheet.getRow(IMPORT_MAX_ROWS + 20).values = ['  '];
    });
    const sheet = await readXlsxSheet(buffer);
    expect(sheet.rows).toHaveLength(IMPORT_MAX_ROWS);
    expect(sheet.rows[1000].rowNumber).toBe(1003);
  });
});

describe('readXlsxSheet: tipos de célula', () => {
  it('fórmula vale pelo resultado; data vira AAAA-MM-DD sem fuso; número vira texto', async () => {
    const buffer = await xlsxWith((workbook) => {
      const sheet = workbook.addWorksheet('Pessoas');
      sheet.addRow(['telefone', 'data', 'soma', 'rico', 'sim', 'link', 'erro']);
      sheet.addRow([
        92991110001,
        new Date(Date.UTC(2026, 10, 1)),
        { formula: '1+1', result: 2 },
        { richText: [{ text: 'Ana ' }, { text: 'Exemplo' }] },
        true,
        { text: 'site', hyperlink: 'https://exemplo.test' },
        { error: '#N/A' },
      ]);
    });
    const { rows } = await readXlsxSheet(buffer);
    expect(rows[0].cells).toEqual([
      '92991110001',
      '2026-11-01',
      '2',
      'Ana Exemplo',
      'Sim',
      'site',
      '',
    ]);
  });

  it('xlsxCellText: vazio, não-finito, formula sem resultado e data inválida viram texto vazio', () => {
    expect(xlsxCellText(null)).toBe('');
    expect(xlsxCellText(undefined)).toBe('');
    expect(xlsxCellText(Number.NaN)).toBe('');
    expect(xlsxCellText(false)).toBe('Não');
    expect(xlsxCellText(new Date(Number.NaN))).toBe('');
    expect(xlsxCellText({ formula: 'A1' })).toBe('');
    expect(xlsxCellText({ formula: 'A1', result: { error: '#REF!' } })).toBe(
      '',
    );
    expect(xlsxCellText({ sharedFormula: 'A1', result: 'ok' })).toBe('ok');
  });

  it('célula de XLSX é lida crua: apóstrofo não sai', async () => {
    const buffer = await xlsxWith((workbook) => {
      const sheet = workbook.addWorksheet('Pessoas');
      sheet.addRow(['Nome', 'Matrícula']);
      sheet.addRow(["'=1+1", "'+55"]);
    });
    const { rows } = await readXlsxSheet(buffer);
    expect(rows[0].cells).toEqual(["'=1+1", "'+55"]);
  });
});

describe('readXlsxSheet: arquivo ilegível', () => {
  it('arquivo ilegível tenta repair e, se ainda falhar, unreadable', async () => {
    const buffer = await xlsxWith((workbook) => {
      workbook.addWorksheet('Pessoas').addRow(['Nome']);
    });
    const repair = vi.fn().mockResolvedValue(buffer);
    const load = spyOnLoad().mockRejectedValue(new Error('xml inesperado'));

    expect(await problemOf(readXlsxSheet(buffer, { repair }))).toBe(
      'unreadable',
    );
    expect(repair).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledTimes(2);
    expect(await problemOf(readXlsxSheet(buffer))).toBe('unreadable');
    expect(
      await problemOf(
        readXlsxSheet(buffer, { repair: () => Promise.reject(new Error('x')) }),
      ),
    ).toBe('unreadable');
  });

  it('o arquivo reparado é lido; reparado acima do teto não é aberto', async () => {
    const buffer = await xlsxWith((workbook) => {
      const sheet = workbook.addWorksheet('Pessoas');
      sheet.addRow(['Nome']);
      sheet.addRow(['Ana Exemplo']);
    });
    const load = spyOnLoad().mockRejectedValueOnce(new Error('xml inesperado'));
    const repaired = await readXlsxSheet(buffer, {
      repair: () => Promise.resolve(buffer),
    });
    expect(repaired.rows[0].cells).toEqual(['Ana Exemplo']);

    const huge = await hugeZip();
    load.mockClear();
    load.mockRejectedValueOnce(new Error('xml inesperado'));
    const repair = () => Promise.resolve(huge);
    expect(await problemOf(readXlsxSheet(buffer, { repair }))).toBe(
      'expands_too_much',
    );
    expect(load).toHaveBeenCalledTimes(1);
  });
});

describe('readXlsxSheet: arquivo grande demais', () => {
  it('zip ilegível → unreadable; descompactado acima do teto → expands_too_much sem chamar xlsx.load', async () => {
    const load = spyOnLoad();
    const huge = await hugeZip();

    expect(await problemOf(readXlsxSheet(huge))).toBe('expands_too_much');
    expect(await problemOf(readXlsxSheet(Buffer.from('não é zip')))).toBe(
      'unreadable',
    );
    expect(load).not.toHaveBeenCalled();
  });
});
