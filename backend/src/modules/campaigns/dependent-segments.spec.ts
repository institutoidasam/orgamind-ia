import { describe, it, expect } from 'vitest';
import { findSegmentsReferencingCampaign } from './dependent-segments';
import type { FilterGroup } from '../../schemas/contracts/filter.schema';

describe('findSegmentsReferencingCampaign', () => {
  it('inclui um Segment cujo filters tem um nó history com o campaignId', () => {
    const filters: FilterGroup = {
      combinator: 'and',
      rules: [
        { field: 'city', op: 'eq', value: 'Manaus' },
        {
          kind: 'history',
          event: 'received',
          negate: true,
          campaignIds: ['camp-1'],
        },
      ],
    };

    const result = findSegmentsReferencingCampaign(
      [{ id: 's1', name: 'Já receberam a campanha X', filters }],
      'camp-1',
    );

    expect(result).toEqual([{ id: 's1', name: 'Já receberam a campanha X' }]);
  });

  it('não inclui um Segment cujo history aponta para outro campaignId', () => {
    const filters: FilterGroup = {
      combinator: 'and',
      rules: [
        {
          kind: 'history',
          event: 'received',
          negate: true,
          campaignIds: ['camp-outra'],
        },
      ],
    };

    const result = findSegmentsReferencingCampaign(
      [{ id: 's1', name: 'Segmento sem relação', filters }],
      'camp-1',
    );

    expect(result).toEqual([]);
  });

  it('acha o nó history mesmo aninhado dentro de um grupo filho', () => {
    const filters: FilterGroup = {
      combinator: 'or',
      rules: [
        { field: 'city', op: 'eq', value: 'Manaus' },
        {
          combinator: 'and',
          rules: [
            { field: 'group', op: 'eq', value: 'lideranças' },
            {
              kind: 'history',
              event: 'received',
              negate: true,
              campaignIds: ['camp-1'],
            },
          ],
        },
      ],
    };

    const result = findSegmentsReferencingCampaign(
      [{ id: 's1', name: 'Aninhado', filters }],
      'camp-1',
    );

    expect(result).toEqual([{ id: 's1', name: 'Aninhado' }]);
  });

  it('um Segment sem nenhum nó history não aparece', () => {
    const filters: FilterGroup = {
      combinator: 'and',
      rules: [{ field: 'city', op: 'eq', value: 'Manaus' }],
    };

    const result = findSegmentsReferencingCampaign(
      [{ id: 's1', name: 'Sem history', filters }],
      'camp-1',
    );

    expect(result).toEqual([]);
  });

  it('filtra dentre vários segmentos, devolvendo só {id, name} dos que casam', () => {
    const comCampanha: FilterGroup = {
      combinator: 'and',
      rules: [
        {
          kind: 'history',
          event: 'received',
          negate: true,
          campaignIds: ['camp-1'],
        },
      ],
    };
    const semCampanha: FilterGroup = {
      combinator: 'and',
      rules: [{ field: 'city', op: 'eq', value: 'Manaus' }],
    };

    const result = findSegmentsReferencingCampaign(
      [
        { id: 's1', name: 'Um', filters: comCampanha },
        { id: 's2', name: 'Dois', filters: semCampanha },
      ],
      'camp-1',
    );

    expect(result).toEqual([{ id: 's1', name: 'Um' }]);
  });
});
