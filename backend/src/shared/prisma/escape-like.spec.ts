import { describe, expect, it } from 'vitest';
import { escapeLike } from './escape-like';

describe('escapeLike', () => {
  it('escapa a barra invertida, o "%" e o "_" com uma barra à frente', () => {
    expect(escapeLike('\\')).toBe('\\\\');
    expect(escapeLike('%')).toBe('\\%');
    expect(escapeLike('_')).toBe('\\_');
    expect(escapeLike('a_b%c\\d')).toBe('a\\_b\\%c\\\\d');
  });

  it('deixa intacto o texto sem coringa', () => {
    expect(escapeLike('Ana Lima-12')).toBe('Ana Lima-12');
    expect(escapeLike('')).toBe('');
  });
});
