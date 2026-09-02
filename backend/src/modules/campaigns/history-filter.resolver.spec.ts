import { describe, it, expect, beforeEach } from 'vitest';
import { mockDeep, type MockProxy } from 'vitest-mock-extended';
import { resolveHistoryTargets } from './history-filter.resolver';
import { PrismaService } from '../../shared/prisma/prisma.service';
import type { FilterGroup } from '../../schemas/contracts/filter.schema';

describe('resolveHistoryTargets', () => {
  let prisma: MockProxy<PrismaService>;

  beforeEach(() => {
    prisma = mockDeep<PrismaService>();
  });

  it('expande templateIds em campaignIds numa única query', async () => {
    prisma.campaign.findMany.mockResolvedValue([
      { id: 'c1', templateId: 'tplA' },
      { id: 'c2', templateId: 'tplA' },
    ] as never);

    const filter: FilterGroup = {
      combinator: 'and',
      rules: [
        {
          kind: 'history',
          event: 'received',
          negate: false,
          templateIds: ['tplA'],
        },
      ],
    };

    const result = await resolveHistoryTargets(filter, prisma);

    expect(result).toEqual({
      combinator: 'and',
      rules: [
        {
          kind: 'history',
          event: 'received',
          negate: false,
          campaignIds: ['c1', 'c2'],
        },
      ],
    });
    expect(prisma.campaign.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.campaign.findMany).toHaveBeenCalledWith({
      where: { templateId: { in: ['tplA'] } },
      select: { id: true, templateId: true },
    });
  });

  it('une campaignIds diretos com os expandidos do template, sem duplicar', async () => {
    prisma.campaign.findMany.mockResolvedValue([
      { id: 'c1', templateId: 'tplA' },
      { id: 'c9', templateId: 'tplA' }, // já presente em campaignIds diretos
    ] as never);

    const filter: FilterGroup = {
      combinator: 'and',
      rules: [
        {
          kind: 'history',
          event: 'received',
          negate: false,
          campaignIds: ['c9'],
          templateIds: ['tplA'],
        },
      ],
    };

    const result = await resolveHistoryTargets(filter, prisma);

    expect(result).toEqual({
      combinator: 'and',
      rules: [
        {
          kind: 'history',
          event: 'received',
          negate: false,
          campaignIds: ['c9', 'c1'],
        },
      ],
    });
    expect(prisma.campaign.findMany).toHaveBeenCalledTimes(1);
  });

  it('coleta templateIds de nós history aninhados dentro de grupos numa única query', async () => {
    prisma.campaign.findMany.mockResolvedValue([
      { id: 'c1', templateId: 'tplA' },
      { id: 'c2', templateId: 'tplB' },
    ] as never);

    const filter: FilterGroup = {
      combinator: 'or',
      rules: [
        {
          kind: 'history',
          event: 'received',
          negate: false,
          templateIds: ['tplA'],
        },
        {
          combinator: 'and',
          rules: [
            { field: 'city', op: 'eq', value: 'Manaus' },
            {
              kind: 'history',
              event: 'received',
              negate: true,
              templateIds: ['tplB'],
            },
          ],
        },
      ],
    };

    const result = await resolveHistoryTargets(filter, prisma);

    expect(prisma.campaign.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.campaign.findMany).toHaveBeenCalledWith({
      where: { templateId: { in: ['tplA', 'tplB'] } },
      select: { id: true, templateId: true },
    });
    expect(result).toEqual({
      combinator: 'or',
      rules: [
        {
          kind: 'history',
          event: 'received',
          negate: false,
          campaignIds: ['c1'],
        },
        {
          combinator: 'and',
          rules: [
            { field: 'city', op: 'eq', value: 'Manaus' },
            {
              kind: 'history',
              event: 'received',
              negate: true,
              campaignIds: ['c2'],
            },
          ],
        },
      ],
    });
  });

  it('não faz nenhuma query quando não há templateIds na árvore', async () => {
    const filter: FilterGroup = {
      combinator: 'and',
      rules: [
        { field: 'city', op: 'eq', value: 'Manaus' },
        {
          kind: 'history',
          event: 'received',
          negate: false,
          campaignIds: ['c1'],
        },
      ],
    };

    const result = await resolveHistoryTargets(filter, prisma);

    expect(prisma.campaign.findMany).not.toHaveBeenCalled();
    expect(result).toEqual(filter);
  });

  it('não muta a árvore de entrada', async () => {
    prisma.campaign.findMany.mockResolvedValue([
      { id: 'c1', templateId: 'tplA' },
    ] as never);

    const filter: FilterGroup = {
      combinator: 'and',
      rules: [
        {
          kind: 'history',
          event: 'received',
          negate: false,
          templateIds: ['tplA'],
        },
      ],
    };
    const snapshot = JSON.parse(JSON.stringify(filter));

    await resolveHistoryTargets(filter, prisma);

    expect(filter).toEqual(snapshot);
  });
});
