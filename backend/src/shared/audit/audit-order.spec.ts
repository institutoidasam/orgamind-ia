import { describe, expect, it } from 'vitest';
import { orderChange } from './audit-order';

describe('orderChange', () => {
  it('ordem igual — nenhum campo', () => {
    expect(orderChange(['Manhã', 'Tarde'], ['Manhã', 'Tarde'])).toEqual([]);
  });

  it('ordem diferente — campo order com nomes unidos por >', () => {
    expect(
      orderChange(['Manhã', 'Tarde', 'Noite'], ['Noite', 'Manhã', 'Tarde']),
    ).toEqual([
      {
        field: 'order',
        before: 'Manhã > Tarde > Noite',
        after: 'Noite > Manhã > Tarde',
      },
    ]);
  });
});
