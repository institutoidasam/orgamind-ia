import { describe, it, expect } from 'vitest';
import { facetsToFilterGroup } from './facets-to-filters';
import type { FacetSelection } from './components/facet-filters';

/**
 * Pedido do cliente (2026-08-25): ao selecionar cidade + grupo + tags, os
 * filtros devem SOMAR (agregador) — várias seleções do MESMO campo (ex.:
 * duas cidades) usam OU entre si; campos DIFERENTES (cidade × grupo × tags)
 * usam E entre si. `facetsToFilterGroup` já implementava exatamente essa
 * regra (nenhuma mudança de comportamento foi necessária); este arquivo só
 * fecha a lacuna de cobertura — não havia spec nenhum para esta função.
 */
const EMPTY: FacetSelection = { cities: [], groups: [], tags: [] };

describe('facetsToFilterGroup', () => {
  it('sem nenhuma seleção, devolve um grupo AND vazio (casa todo mundo ativo)', () => {
    expect(facetsToFilterGroup(EMPTY)).toEqual({ combinator: 'and', rules: [] });
  });

  it('uma única cidade vira uma regra simples (sem sub-grupo OR)', () => {
    const result = facetsToFilterGroup({ ...EMPTY, cities: ['Manaus'] });
    expect(result).toEqual({
      combinator: 'and',
      rules: [{ field: 'city', op: 'eq', value: 'Manaus' }],
    });
  });

  it('MESMO campo com múltiplas seleções: OU entre elas', () => {
    const result = facetsToFilterGroup({
      ...EMPTY,
      cities: ['Manaus', 'São Paulo'],
    });
    expect(result).toEqual({
      combinator: 'and',
      rules: [
        {
          combinator: 'or',
          rules: [
            { field: 'city', op: 'eq', value: 'Manaus' },
            { field: 'city', op: 'eq', value: 'São Paulo' },
          ],
        },
      ],
    });
  });

  it('CAMPOS diferentes (cidade + grupo + tags): E entre eles no topo', () => {
    const result = facetsToFilterGroup({
      cities: ['Manaus'],
      groups: ['Voluntários'],
      tags: ['prioritario'],
    });
    expect(result).toEqual({
      combinator: 'and',
      rules: [
        { field: 'city', op: 'eq', value: 'Manaus' },
        { field: 'group', op: 'eq', value: 'Voluntários' },
        { field: 'tags', op: 'contains', value: 'prioritario' },
      ],
    });
  });

  it('combinação completa: OU dentro de cada campo, E entre os campos (cidade OU cidade) E (grupo OU grupo) E tag', () => {
    const result = facetsToFilterGroup({
      cities: ['Manaus', 'Manacapuru'],
      groups: ['A', 'B'],
      tags: ['prioritario'],
    });
    expect(result).toEqual({
      combinator: 'and',
      rules: [
        {
          combinator: 'or',
          rules: [
            { field: 'city', op: 'eq', value: 'Manaus' },
            { field: 'city', op: 'eq', value: 'Manacapuru' },
          ],
        },
        {
          combinator: 'or',
          rules: [
            { field: 'group', op: 'eq', value: 'A' },
            { field: 'group', op: 'eq', value: 'B' },
          ],
        },
        { field: 'tags', op: 'contains', value: 'prioritario' },
      ],
    });
  });
});
