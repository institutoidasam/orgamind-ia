import { describe, it, expect } from 'vitest';
import {
  decodeCsv,
  detectSeparator,
  parseCsvRecords,
  readCsvSheet,
} from './csv-reader';
import { csvRow } from './csv-writer';
import { SheetReadError } from './sheet-data';

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

function records(text: string, separator: ';' | ','): string[][] {
  const found: string[][] = [];
  parseCsvRecords(text, separator, (_row, cells) => found.push(cells));
  return found;
}

function problemOf(run: () => unknown): [string, string | null] {
  try {
    run();
  } catch (error) {
    if (error instanceof SheetReadError) return [error.problem, error.detail];
    throw error;
  }
  throw new Error('não lançou SheetReadError');
}

describe('readCsvSheet: linhas em branco antes do cabeçalho', () => {
  it('linha vazia, só com espaços ou só com separadores é pulada, inclusive na escolha do separador; a numeração é a do arquivo', () => {
    const csv = '\r\n  \r\n,,\r\n ,\r\nNome,Setor\r\nAna,TI\r\n';
    expect(readCsvSheet(Buffer.from(csv, 'utf8'))).toEqual({
      headers: ['Nome', 'Setor'],
      rows: [{ rowNumber: 6, cells: ['Ana', 'TI'] }],
    });
  });

  it('o cabeçalho que vem depois das linhas em branco não perde o apóstrofo; só linhas em branco → empty', () => {
    const csv = Buffer.from('\n\n\'=H;B\nAna;"\'=x"\n', 'utf8');
    const sheet = readCsvSheet(csv);
    expect(sheet.headers).toEqual(["'=H", 'B']);
    expect(sheet.rows).toEqual([{ rowNumber: 4, cells: ['Ana', '=x'] }]);
    const blank = Buffer.from('\r\n  \r\n;;\r\n', 'utf8');
    expect(problemOf(() => readCsvSheet(blank))).toEqual(['empty', null]);
  });
});

describe('readCsvSheet e decodeCsv: bordas de fim de linha e de codificação', () => {
  it('CRLF e CR dentro de aspas ficam no valor e o registro conta uma linha só', () => {
    const csv = 'Nome;Obs\r\n"a\r\nb";1\r\n"c\rd";2\r\nx;3';
    const sheet = readCsvSheet(Buffer.from(csv, 'utf8'));
    expect(sheet.rows).toEqual([
      { rowNumber: 2, cells: ['a\r\nb', '1'] },
      { rowNumber: 3, cells: ['c\rd', '2'] },
      { rowNumber: 4, cells: ['x', '3'] },
    ]);
  });

  it('Windows-1252 com BOM de UTF-8 na frente e bytes que não são UTF-8 válido: o BOM sai e os acentos vêm do 1252', () => {
    const body = Buffer.from('Nome;Fun\xe7\xe3o\r\nJos\xe9;\x96\r\n', 'latin1');
    const buffer = Buffer.concat([UTF8_BOM, body]);
    expect(decodeCsv(buffer)).toBe('Nome;Função\r\nJosé;–\r\n');
    expect(readCsvSheet(buffer)).toEqual({
      headers: ['Nome', 'Função'],
      rows: [{ rowNumber: 2, cells: ['José', '–'] }],
    });
  });
});

describe('decodeCsv e readCsvSheet: codificação', () => {
  it('aceite 19: CSV em Windows-1252 é lido com acentos e aspas tipográficas', () => {
    const buffer = Buffer.from(
      'Nome;Fun\xe7\xe3o\r\nJo\xe3o;\x93x\x94\r\n',
      'latin1',
    );
    expect(decodeCsv(buffer)).toBe('Nome;Função\r\nJoão;“x”\r\n');
    expect(readCsvSheet(buffer)).toEqual({
      headers: ['Nome', 'Função'],
      rows: [{ rowNumber: 2, cells: ['João', '“x”'] }],
    });
  });

  it('UTF-8 com BOM e sem BOM dão o mesmo resultado', () => {
    const body = Buffer.from('Nome;Função\nAna;Café\n', 'utf8');
    const withBom = readCsvSheet(Buffer.concat([UTF8_BOM, body]));
    expect(withBom).toEqual(readCsvSheet(body));
    expect(withBom.headers).toEqual(['Nome', 'Função']);
    expect(withBom.rows[0].cells).toEqual(['Ana', 'Café']);
  });

  it('arquivo com byte nulo não é texto: unreadable', () => {
    const binary = Buffer.from('Nome;Setor\nAna;T\0I\n', 'utf8');
    expect(problemOf(() => readCsvSheet(binary))).toEqual(['unreadable', null]);
  });
});

describe('detectSeparator', () => {
  it('separador detectado pela linha de cabeçalho: ; ou ,', () => {
    expect(detectSeparator('Nome;Função;Setor')).toBe(';');
    expect(detectSeparator('Nome,Função,Setor')).toBe(',');
    expect(detectSeparator('Nome,"Função;Extra",Setor')).toBe(',');
    expect(detectSeparator('"Nome, completo";Setor\na,b,c,d')).toBe(';');
    expect(detectSeparator('')).toBe(';');
  });
});

describe('parseCsvRecords: aspas e fim de linha', () => {
  it('aspas: campo com separador, aspas dobradas e quebra de linha dentro de aspas', () => {
    const text = 'a;"b;c";"d""e";"f\ng"\r\nx;y;z;w\rp;q';
    expect(records(text, ';')).toEqual([
      ['a', 'b;c', 'd"e', 'f\ng'],
      ['x', 'y', 'z', 'w'],
      ['p', 'q'],
    ]);
  });

  it('aspa no meio de campo sem aspas é texto', () => {
    expect(records('ab"c;d\n5" tela;x', ';')).toEqual([
      ['ab"c', 'd'],
      ['5" tela', 'x'],
    ]);
  });

  it('aspas sem fechamento: unclosed_quote com a linha', () => {
    const text = 'a;b\nc;"d;e\nf;g';
    expect(problemOf(() => records(text, ';'))).toEqual([
      'unclosed_quote',
      'linha 2',
    ]);
  });
});

describe('readCsvSheet: apóstrofo e numeração', () => {
  it('apóstrofo de proteção sai na leitura do CSV; texto comum fica igual', () => {
    const csv = "Nome;'=H;B;C\r\nAna;\"'=SOMA(1;2)\";''=x;'abc\r\n";
    const sheet = readCsvSheet(Buffer.from(csv, 'utf8'));
    expect(sheet.headers).toEqual(['Nome', "'=H", 'B', 'C']);
    expect(sheet.rows[0].cells).toEqual(['Ana', '=SOMA(1;2)', "'=x", "'abc"]);
  });

  it('número da linha: cabeçalho é 1; registro com quebra dentro de aspas conta como uma linha', () => {
    const csv = 'Nome;Obs\r\n"a\nb";1\r\n\r\nc;2\r\n';
    const sheet = readCsvSheet(Buffer.from(csv, 'utf8'));
    expect(sheet.rows).toEqual([
      { rowNumber: 2, cells: ['a\nb', '1'] },
      { rowNumber: 4, cells: ['c', '2'] },
    ]);
  });

  it('aceite 10: o que o escritor de CSV grava volta igual', () => {
    const header = ['Nome', 'Obs', 'Fórmula', 'Outra'];
    const cells = ['Ana "Bia"', 'linha 1\nlinha 2; fim', '=1+1', "'=x"];
    const csv = csvRow(header) + csvRow(cells);
    const sheet = readCsvSheet(Buffer.from(csv, 'utf8'));
    expect(sheet.headers).toEqual(header);
    expect(sheet.rows).toEqual([{ rowNumber: 2, cells }]);
  });
});
