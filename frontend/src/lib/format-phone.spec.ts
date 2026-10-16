import { describe, expect, it } from 'vitest';
import { formatPhoneBR } from './format-phone';

describe('formatPhoneBR', () => {
  it.each([
    ['+5592991234567', '(92) 99123-4567'],
    ['+559291234567', '(92) 9123-4567'],
    ['+14155550100', '+14155550100'],
    [null, '—'],
    [undefined, '—'],
  ] as const)('%s → %s', (input, out) => expect(formatPhoneBR(input)).toBe(out));
});
