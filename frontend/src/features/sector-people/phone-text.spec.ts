import { describe, expect, it } from 'vitest';
import { isMaskedName } from './phone-text';

describe('isMaskedName', () => {
  it('é verdadeiro só para a máscara exata "•••• 1234"', () => {
    expect(isMaskedName('•••• 1234')).toBe(true);
  });

  it.each(['Ana', '•••• 123', '1234', '•••• 1234 x'])('é falso para %s', (name) => {
    expect(isMaskedName(name)).toBe(false);
  });
});
