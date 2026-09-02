import { describe, it, expect } from 'vitest';
import { normalizeForCompare, cleanLabel, resolveLabel } from './normalize-label';

describe('normalizeForCompare', () => {
  it('ignora caixa (Manaus === manaus === MANAUS)', () => {
    expect(normalizeForCompare('Manaus')).toBe(normalizeForCompare('manaus'));
    expect(normalizeForCompare('Manaus')).toBe(normalizeForCompare('MANAUS'));
  });

  it('ignora acento (São Paulo === Sao Paulo)', () => {
    expect(normalizeForCompare('São Paulo')).toBe(normalizeForCompare('Sao Paulo'));
  });

  it('ignora espaçamento nas bordas e colapsa espaços duplicados no meio', () => {
    expect(normalizeForCompare('  Manaus  ')).toBe(normalizeForCompare('Manaus'));
    expect(normalizeForCompare('São   Paulo')).toBe(normalizeForCompare('São Paulo'));
  });

  it('distingue valores realmente diferentes', () => {
    expect(normalizeForCompare('Manaus')).not.toBe(normalizeForCompare('Belém'));
  });
});

describe('cleanLabel', () => {
  it('apara bordas e colapsa espaços sem mexer em caixa/acento', () => {
    expect(cleanLabel('  São   Paulo  ')).toBe('São Paulo');
  });
});

describe('resolveLabel', () => {
  it('reaproveita o rótulo já cadastrado quando bate por comparação normalizada', () => {
    expect(resolveLabel('manaus', ['Manaus', 'Belém'])).toBe('Manaus');
    expect(resolveLabel('  MANAUS  ', ['Manaus'])).toBe('Manaus');
  });

  it('mantém o texto digitado (limpo) quando não bate com nenhuma opção', () => {
    expect(resolveLabel('  Parintins  ', ['Manaus'])).toBe('Parintins');
  });

  it('devolve string vazia para entrada vazia/só espaços', () => {
    expect(resolveLabel('   ', ['Manaus'])).toBe('');
  });
});
