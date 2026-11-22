import { describe, expect, it } from 'vitest';
import { areasLabel, numberLabel, sectorMoves } from './sector-moves';

const ch1 = { id: 'c1', name: 'Loja 1', phoneE164: '+5592911111111' };
const ch2 = { id: 'c2', name: 'Loja 2', phoneE164: null };
const sectors = [
  { id: 'log', name: 'Logística', channel: ch1 },
  { id: 'exp', name: 'Expedição', channel: ch2 },
  { id: 'rh', name: 'RH', channel: null },
];

describe('sectorMoves', () => {
  it.each([
    ['área livre', ['rh'], 'c1', []],
    ['área de outro número', ['exp'], 'c1', [{ sectorName: 'Expedição', from: { name: 'Loja 2', phoneE164: null } }]],
    ['área já deste número', ['log'], 'c1', []],
    [
      'criação (sem canal): todas as que têm número',
      ['log', 'exp', 'rh'],
      null,
      [
        { sectorName: 'Logística', from: { name: 'Loja 1', phoneE164: '+5592911111111' } },
        { sectorName: 'Expedição', from: { name: 'Loja 2', phoneE164: null } },
      ],
    ],
    ['área fora da seleção', [], null, []],
  ])('%s', (_label, selected, channelId, expected) => {
    expect(sectorMoves(selected, sectors, channelId)).toEqual(expected);
  });
});

describe('numberLabel', () => {
  it('mostra o telefone e, sem telefone, o nome do número', () => {
    expect(numberLabel(ch1)).toBe('+5592911111111');
    expect(numberLabel(ch2)).toBe('Loja 2');
  });
});

describe('areasLabel', () => {
  it('lista as áreas ou diz que não há nenhuma', () => {
    expect(areasLabel([{ name: 'Logística' }, { name: 'Expedição' }])).toBe('Áreas: Logística, Expedição');
    expect(areasLabel([])).toBe('Nenhuma área');
    expect(areasLabel(undefined)).toBe('Nenhuma área');
  });
});
