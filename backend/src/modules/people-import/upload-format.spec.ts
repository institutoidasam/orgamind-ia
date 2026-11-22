import { describe, expect, it } from 'vitest';
import {
  SheetReadError,
  type SheetReadProblem,
} from '../../shared/spreadsheet/sheet-data';
import {
  formatOf,
  fromSheetReadError,
  uploadedFileName,
} from './upload-format';

const PK = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]);
const TEXT = Buffer.from('nome;telefone\nAna;+5592991110001\n', 'utf8');
const GENERIC =
  'Não foi possível ler a planilha. Confira se o arquivo abre no Excel e envie de novo.';

const READ_ERRORS: [SheetReadProblem, string | null, string, string][] = [
  ['empty', null, 'people_import.empty', 'A planilha está vazia.'],
  [
    'no_data',
    null,
    'people_import.no_data',
    'A planilha não tem linhas de dados abaixo do cabeçalho.',
  ],
  [
    'too_many_rows',
    null,
    'people_import.too_many_rows',
    'A planilha tem linhas demais. Envie até 5.000 por vez.',
  ],
  [
    'duplicate_header',
    'NOME',
    'people_import.duplicate_header',
    "A coluna 'NOME' aparece mais de uma vez no cabeçalho.",
  ],
  ['unreadable', null, 'people_import.unreadable', GENERIC],
  ['unreadable', 'too_many_columns', 'people_import.unreadable', GENERIC],
  [
    'unclosed_quote',
    'linha 7',
    'people_import.unreadable',
    'O CSV tem aspas sem fechamento a partir da linha 7.',
  ],
  [
    'expands_too_much',
    null,
    'people_import.unreadable',
    'A planilha fica grande demais ao abrir. Divida a planilha e envie em partes.',
  ],
];

describe('upload-format: caracteres de formatação no nome (m1)', () => {
  it('tira U+202E e outros invisíveis de formatação que disfarçam o nome', () => {
    // U+202E inverte o que vem depois: na tela, o nome pareceria "relatoriovsc.exe"
    const fromMulter = (name: string) =>
      Buffer.from(name, 'utf8').toString('latin1');
    expect(uploadedFileName(fromMulter('relatorio\u202Eexe.csv'))).toBe(
      'relatorioexe.csv',
    );
    expect(uploadedFileName(fromMulter('\uFEFFa\u200Bb\u2066.csv'))).toBe(
      'ab.csv',
    );
  });
});

describe('upload-format: caracteres de controle no nome (T16 M1)', () => {
  it('tira NUL e quebra de linha do nome, sem juntar o que sobra', () => {
    expect(uploadedFileName('a\u0000b\r\nc.csv')).toBe('abc.csv');
    expect(uploadedFileName('\u0000\u001f\u007f.csv')).toBe('.csv');
  });

  it('o corte em 255 conta depois de tirar os controles', () => {
    const name = uploadedFileName(`${'a\u0000'.repeat(300)}.csv`);
    expect(name).toHaveLength(255);
    expect(name).not.toContain('\u0000');
  });
});

describe('upload-format: tipo e nome do arquivo (EX4)', () => {
  it('xlsx pela extensão e pela assinatura PK; csv sem a assinatura; outro caso nulo', () => {
    expect(formatOf('pessoas.xlsx', PK)).toBe('xlsx');
    expect(formatOf('PESSOAS.XLSX', PK)).toBe('xlsx');
    expect(formatOf('pessoas.csv', TEXT)).toBe('csv');
    expect(formatOf('Pessoas.CSV', TEXT)).toBe('csv');
    expect(formatOf('pessoas.xlsx', TEXT)).toBeNull();
    expect(formatOf('pessoas.csv', PK)).toBeNull();
    expect(formatOf('pessoas.txt', TEXT)).toBeNull();
    expect(formatOf('pessoas.xls', PK)).toBeNull();
    expect(formatOf('pessoas.xlsx', Buffer.alloc(0))).toBeNull();
  });

  it('nome do arquivo: latin1 do multer vira UTF-8, sem caminho, cortado em 255', () => {
    const fromMulter = Buffer.from('Relatório São João.csv', 'utf8').toString(
      'latin1',
    );
    expect(uploadedFileName(fromMulter)).toBe('Relatório São João.csv');
    expect(uploadedFileName('C:\\pasta\\a.csv')).toBe('a.csv');
    expect(uploadedFileName('/home/pasta/b.xlsx')).toBe('b.xlsx');
    expect(uploadedFileName(`${'a'.repeat(296)}.csv`)).toHaveLength(255);
    // 'ã' sozinho em latin1 não é UTF-8 válido: fica como veio.
    expect(uploadedFileName('Planilha de São Paulo.csv')).toBe(
      'Planilha de São Paulo.csv',
    );
  });
});

describe('upload-format: erros da leitura (CX3)', () => {
  it('fromSheetReadError traduz cada problema da leitura', () => {
    for (const [problem, detail, code, text] of READ_ERRORS) {
      const error = fromSheetReadError(new SheetReadError(problem, detail));
      expect({
        code: error.code,
        status: error.status,
        detail: error.detail,
      }).toEqual({ code, status: 422, detail: text });
    }
  });

  it('aspas sem fechamento sem o número da linha: texto genérico', () => {
    const error = fromSheetReadError(new SheetReadError('unclosed_quote'));
    expect(error.detail).toBe(GENERIC);
  });
});
