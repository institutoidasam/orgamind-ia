import { describe, expect, it } from 'vitest';
import {
  isPhoneLikeName,
  nameSearchAllowed,
  nameView,
  phoneView,
} from './phone-visibility';

const PHONE = '+5592988887777';

// m1: nome vindo do WhatsApp traz marcas de direção, NBSP e zero-width; ponto também separa.
describe('isPhoneLikeName — invisíveis, NBSP e ponto (m1)', () => {
  it.each([
    ['embedding U+202A…U+202C', '‪+55 92 98888-7777‬', '•••• 7777'],
    ['isolado U+2066/U+2069 e NBSP', '⁦(92) 98888-7777⁩', '•••• 7777'],
    ['LRM e zero-width', '‎+5592​98888‍7777﻿', '•••• 7777'],
    ['RLM e override U+202E', '‏‮92 98888 7777‬', '•••• 7777'],
    ['ponto como separador', '92.98888.7777', '•••• 7777'],
    ['8 dígitos com ponto (limite aceito)', '9999.8888', '•••• 8888'],
  ])('%s mascara', (_label, name, masked) => {
    expect(isPhoneLikeName(name)).toBe(true);
    expect(nameView(name, { full: false })).toBe(masked);
    expect(nameView(name, { full: true })).toBe(name);
  });

  it.each([
    ['João 2'],
    ['‪1234‬'],
    ['Turma 2024-1'],
    ['Ana​ 98888-7777'],
    ['‪‬'],
  ])('%j não mascara', (name) => {
    expect(isPhoneLikeName(name)).toBe(false);
    expect(nameView(name, { full: false })).toBe(name);
  });
});

describe('isPhoneLikeName (D11)', () => {
  it.each([
    [PHONE, true],
    ['(92) 98888-7777', true],
    ['+55 92 9888-7777', true],
    ['Ana Souza', false],
    ['João 2', false],
    ['1234', false],
    ['', false],
  ])('%j → %s', (name, expected) => {
    expect(isPhoneLikeName(name)).toBe(expected);
  });
});

describe('nameView (D11)', () => {
  it('sem ver o telefone completo, nome que é telefone sai com a máscara de phoneView', () => {
    expect(nameView(PHONE, { full: false })).toBe('•••• 7777');
    expect(nameView('(92) 98888-1234', { full: false })).toBe('•••• 1234');
  });

  it('nome comum sai igual, com ou sem o telefone completo', () => {
    expect(nameView('João 2', { full: false })).toBe('João 2');
    expect(nameView('Ana', { full: true })).toBe('Ana');
  });

  it('com o telefone completo o nome-telefone sai como gravado; nulo segue nulo', () => {
    expect(nameView(PHONE, { full: true })).toBe(PHONE);
    expect(nameView(null, { full: false })).toBeNull();
    expect(nameView(null, { full: true })).toBeNull();
  });
});

describe('nameSearchAllowed (D11)', () => {
  it('sem a chave, termo sem letra não busca por nome; com letra (inclusive acentuada), busca', () => {
    expect(nameSearchAllowed('98888', { full: false })).toBe(false);
    expect(nameSearchAllowed('+55 (92) 9-', { full: false })).toBe(false);
    expect(nameSearchAllowed('ção', { full: false })).toBe(true);
    expect(nameSearchAllowed('a1', { full: false })).toBe(true);
  });

  it('com a chave, qualquer termo busca por nome', () => {
    expect(nameSearchAllowed('98888', { full: true })).toBe(true);
  });
});

describe('phoneView', () => {
  it('sem telefone → sem número, hasPhone falso e sem máscara, mesmo com a chave', () => {
    const empty = { phoneE164: null, hasPhone: false, phoneMasked: null };

    expect(phoneView(null, { full: true })).toEqual(empty);
    expect(phoneView(undefined, { full: false })).toEqual(empty);
    expect(phoneView('', { full: true, hidden: true })).toEqual(empty);
  });

  it('hidden (regra do setor) vence full: número e máscara saem nulos, hasPhone verdadeiro', () => {
    expect(phoneView(PHONE, { full: true, hidden: true })).toEqual({
      phoneE164: null,
      hasPhone: true,
      phoneMasked: null,
    });
  });

  it('com a chave (full) devolve o número e a máscara', () => {
    expect(phoneView(PHONE, { full: true })).toEqual({
      phoneE164: PHONE,
      hasPhone: true,
      phoneMasked: '•••• 7777',
    });
  });

  it('sem a chave devolve só a máscara', () => {
    expect(phoneView(PHONE, { full: false })).toEqual({
      phoneE164: null,
      hasPhone: true,
      phoneMasked: '•••• 7777',
    });
  });
});
