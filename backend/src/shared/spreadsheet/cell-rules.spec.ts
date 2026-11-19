import { describe, it, expect } from 'vitest';
import {
  FORMULA_TRIGGERS,
  YES_NO_CELL,
  formatDateCell,
  formatPhoneCell,
  guardFormula,
  unguardFormula,
  yesNo,
} from './cell-rules';

describe('guardFormula', () => {
  it('cada gatilho (= + - @ tab CR) ganha apóstrofo; texto que já começa por apóstrofo e gatilho também; texto comum e vazio ficam iguais', () => {
    expect(FORMULA_TRIGGERS).toEqual(['=', '+', '-', '@', '\t', '\r']);
    for (const trigger of FORMULA_TRIGGERS) {
      expect(guardFormula(`${trigger}x`)).toBe(`'${trigger}x`);
    }
    expect(guardFormula("'=x")).toBe("''=x");
    expect(guardFormula("''=x")).toBe("'''=x");
    expect(guardFormula("'abc")).toBe("'abc");
    expect(guardFormula("''abc")).toBe("''abc");
    expect(guardFormula("'")).toBe("'");
    expect(guardFormula("''")).toBe("''");
    expect(guardFormula('')).toBe('');
    expect(guardFormula('Maria Souza')).toBe('Maria Souza');
    expect(guardFormula('a=b')).toBe('a=b');
  });
});

describe('unguardFormula', () => {
  it('desfaz guardFormula e não mexe em apóstrofo antes de outro caractere', () => {
    const originals = [
      ...FORMULA_TRIGGERS.map((trigger) => `${trigger}x`),
      ...FORMULA_TRIGGERS.map((trigger) => `'${trigger}x`),
      ...FORMULA_TRIGGERS.map((trigger) => `''${trigger}x`),
      "'abc",
      "''abc",
      "'",
      "''",
      '',
      'Maria Souza',
    ];
    for (const original of originals) {
      expect(unguardFormula(guardFormula(original))).toBe(original);
    }
    expect(unguardFormula("'abc")).toBe("'abc");
    expect(unguardFormula("''abc")).toBe("''abc");
    expect(unguardFormula("'=x")).toBe('=x');
    expect(unguardFormula("''=x")).toBe("'=x");
    expect(unguardFormula('=x')).toBe('=x');
  });
});

describe('formatPhoneCell', () => {
  it('celular e fixo do Brasil no formato nacional; estrangeiro no internacional', () => {
    expect(formatPhoneCell('+5592991112008')).toBe('(92) 99111-2008');
    expect(formatPhoneCell('+559232211234')).toBe('(92) 3221-1234');
    expect(formatPhoneCell('+14155552671')).toBe('+1 415 555 2671');
    expect(formatPhoneCell('abc')).toBe('abc');
  });
});

describe('formatDateCell', () => {
  it('AAAA-MM-DD vira DD/MM/AAAA', () => {
    expect(formatDateCell('2026-11-19')).toBe('19/11/2026');
  });
});

describe('yesNo', () => {
  it('Sim e Não', () => {
    expect(yesNo(true)).toBe('Sim');
    expect(yesNo(false)).toBe('Não');
    expect(YES_NO_CELL).toEqual({ yes: 'Sim', no: 'Não' });
  });
});
