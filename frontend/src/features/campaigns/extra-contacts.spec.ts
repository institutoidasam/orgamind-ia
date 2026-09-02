import { describe, it, expect } from 'vitest';
import { materializeExtraContacts } from './extra-contacts';
import type { FilterGroup } from './schemas';

const BASE: FilterGroup = {
  combinator: 'and',
  rules: [{ field: 'city', op: 'eq', value: 'Manaus' }],
};

describe('materializeExtraContacts', () => {
  it('sem telefones, devolve a MESMA referência do filtro base (no-op)', () => {
    expect(materializeExtraContacts(BASE, [])).toBe(BASE);
  });

  it('com telefones, envolve o base num OU com uma regra phoneE164 in [...]', () => {
    const result = materializeExtraContacts(BASE, ['+5592999990001', '+5592999990002']);
    expect(result).toEqual({
      combinator: 'or',
      rules: [
        BASE,
        {
          field: 'phoneE164',
          op: 'in',
          value: ['+5592999990001', '+5592999990002'],
        },
      ],
    });
  });

  it('o contato extra entra independente do filtro base (é um OU, não um E)', () => {
    const result = materializeExtraContacts(BASE, ['+5592999990001']);
    expect(result.combinator).toBe('or');
    // O nó do filtro original permanece intacto (não foi mesclado/perdido).
    expect(result.rules).toContainEqual(BASE);
  });
});
