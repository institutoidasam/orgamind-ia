import { describe, it, expect, beforeEach } from 'vitest';
import { mockDeep, type MockProxy } from 'vitest-mock-extended';
import { Prisma } from '@prisma/client';
import { SegmentsService } from './segments.service';
import { SegmentsRepository } from './segments.repository';
import {
  SegmentNotFoundError,
  SegmentNameConflictError,
} from './errors/segments.errors';
import { AuditService } from '../../shared/audit/audit.service';
import { PrismaService } from '../../shared/prisma/prisma.service';
import type { FilterGroup } from '../../schemas/contracts/filter.schema';
import type {
  CreateSegment,
  UpdateSegment,
} from '../../schemas/contracts/segment.schema';

describe('SegmentsService', () => {
  let service: SegmentsService;
  let repo: MockProxy<SegmentsRepository>;
  let audit: MockProxy<AuditService>;
  let prisma: MockProxy<PrismaService>;

  beforeEach(() => {
    repo = mockDeep<SegmentsRepository>();
    audit = mockDeep<AuditService>();
    prisma = mockDeep<PrismaService>();
    // F1 T4 — resolveHistoryTargets só bate no banco quando há nó history com
    // templateIds; a maioria dos testes usa filtros escalares.
    prisma.campaign.findMany.mockResolvedValue([]);
    service = new SegmentsService(repo, audit, prisma);
  });

  describe('list', () => {
    it('delegates to repo.listSummaries', async () => {
      repo.listSummaries.mockResolvedValue([{ id: 's1' }] as any);
      const result = await service.list();
      expect(result).toEqual([{ id: 's1' }]);
    });
  });

  describe('getById', () => {
    it('returns segment when found', async () => {
      repo.findById.mockResolvedValue({ id: 's1' } as any);
      const result = await service.getById('s1');
      expect(result).toEqual({ id: 's1' });
    });

    it('throws SegmentNotFoundError when missing', async () => {
      repo.findById.mockResolvedValue(null);
      await expect(service.getById('missing')).rejects.toThrow(
        SegmentNotFoundError,
      );
    });
  });

  describe('create', () => {
    const input: CreateSegment = {
      name: 'VIP',
      description: 'desc',
      filters: { combinator: 'and', rules: [] },
    };

    it('throws SegmentNameConflictError when name already taken', async () => {
      repo.findByName.mockResolvedValue({ id: 'existing' } as any);
      await expect(service.create(input, 'u1')).rejects.toThrow(
        SegmentNameConflictError,
      );
      expect(repo.create).not.toHaveBeenCalled();
    });

    it('maps a Prisma P2002 unique violation to SegmentNameConflictError (TOCTOU race)', async () => {
      repo.findByName.mockResolvedValue(null);
      const p2002 = new Prisma.PrismaClientKnownRequestError(
        'Unique constraint failed on the fields: (`name`)',
        { code: 'P2002', clientVersion: 'test', meta: { target: ['name'] } },
      );
      repo.create.mockRejectedValue(p2002);
      await expect(service.create(input, 'u1')).rejects.toThrow(
        SegmentNameConflictError,
      );
    });

    it('rethrows non-P2002 repo errors unchanged', async () => {
      repo.findByName.mockResolvedValue(null);
      const boom = new Error('db down');
      repo.create.mockRejectedValue(boom);
      await expect(service.create(input, 'u1')).rejects.toBe(boom);
    });

    it('persists createdById and audit-logs segment.create', async () => {
      repo.findByName.mockResolvedValue(null);
      repo.create.mockResolvedValue({ id: 's1', name: 'VIP' } as any);
      const result = await service.create(input, 'u1');
      expect(result).toEqual({ id: 's1', name: 'VIP' });
      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'VIP',
          description: 'desc',
          filters: { combinator: 'and', rules: [] },
          createdById: 'u1',
        }),
      );
      expect(audit.log).toHaveBeenCalledWith(
        'segment.create',
        'Segment',
        's1',
        expect.objectContaining({ name: 'VIP' }),
      );
    });
  });

  describe('update', () => {
    it('throws SegmentNotFoundError when missing', async () => {
      repo.findById.mockResolvedValue(null);
      await expect(
        service.update('missing', { name: 'X' }),
      ).rejects.toThrow(SegmentNotFoundError);
    });

    it('throws SegmentNameConflictError when renaming to a taken name', async () => {
      repo.findById.mockResolvedValue({ id: 's1', name: 'Old' } as any);
      repo.findByName.mockResolvedValue({ id: 'other' } as any);
      await expect(
        service.update('s1', { name: 'Taken' }),
      ).rejects.toThrow(SegmentNameConflictError);
      expect(repo.update).not.toHaveBeenCalled();
    });

    it('allows keeping the same name (conflict is itself)', async () => {
      repo.findById.mockResolvedValue({ id: 's1', name: 'Same' } as any);
      repo.findByName.mockResolvedValue({ id: 's1' } as any);
      repo.update.mockResolvedValue({ id: 's1' } as any);
      const patch: UpdateSegment = { name: 'Same', description: 'new' };
      await service.update('s1', patch);
      expect(repo.update).toHaveBeenCalledWith('s1', patch);
    });

    it('updates and audit-logs segment.update', async () => {
      repo.findById.mockResolvedValue({ id: 's1', name: 'Old' } as any);
      repo.update.mockResolvedValue({ id: 's1' } as any);
      await service.update('s1', { description: 'just desc' });
      expect(repo.update).toHaveBeenCalledWith('s1', { description: 'just desc' });
      expect(audit.log).toHaveBeenCalledWith(
        'segment.update',
        'Segment',
        's1',
        expect.any(Object),
      );
    });

    it('invalidates cached lastCount/lastCountedAt when filters change', async () => {
      repo.findById.mockResolvedValue({ id: 's1', name: 'Old' } as any);
      repo.update.mockResolvedValue({ id: 's1' } as any);
      const patch: UpdateSegment = {
        filters: { combinator: 'and', rules: [{ field: 'city', op: 'eq', value: 'Manaus' }] },
      };
      await service.update('s1', patch);
      expect(repo.update).toHaveBeenCalledWith('s1', {
        filters: patch.filters,
        lastCount: null,
        lastCountedAt: null,
      });
    });

    it('does NOT invalidate the count cache when filters are untouched', async () => {
      repo.findById.mockResolvedValue({ id: 's1', name: 'Old' } as any);
      repo.update.mockResolvedValue({ id: 's1' } as any);
      await service.update('s1', { description: 'just desc' });
      const data = repo.update.mock.calls[0][1] as any;
      expect(data).not.toHaveProperty('lastCount');
      expect(data).not.toHaveProperty('lastCountedAt');
    });
  });

  describe('remove', () => {
    it('throws SegmentNotFoundError when missing', async () => {
      repo.findById.mockResolvedValue(null);
      await expect(service.remove('missing')).rejects.toThrow(
        SegmentNotFoundError,
      );
    });

    it('deletes and audit-logs segment.delete', async () => {
      repo.findById.mockResolvedValue({ id: 's1', name: 'X' } as any);
      repo.delete.mockResolvedValue({ id: 's1' } as any);
      await service.remove('s1');
      expect(repo.delete).toHaveBeenCalledWith('s1');
      expect(audit.log).toHaveBeenCalledWith(
        'segment.delete',
        'Segment',
        's1',
        expect.any(Object),
      );
    });
  });

  describe('preview', () => {
    it('throws SegmentNotFoundError when missing', async () => {
      repo.findById.mockResolvedValue(null);
      await expect(service.preview('missing')).rejects.toThrow(
        SegmentNotFoundError,
      );
    });

    it('returns { count, sample } and caches lastCount', async () => {
      const filters: FilterGroup = {
        combinator: 'and',
        rules: [{ field: 'city', op: 'eq', value: 'Manaus' }],
      };
      repo.findById.mockResolvedValue({ id: 's1', filters } as any);
      repo.countContactsByWhere.mockResolvedValue(7);
      repo.findContactsByWhere.mockResolvedValue([{ id: 'c1' }] as any);

      const result = await service.preview('s1');

      expect(result).toEqual({ count: 7, sample: [{ id: 'c1' }] });
      // sample uses take: 10
      expect(repo.findContactsByWhere).toHaveBeenCalledWith(
        expect.any(Object),
        10,
      );
      // the where is the AND-wrapped rule list built by toPrismaWhere (no
      // optedOut guard since 2026-08-25 — decisão do cliente, ver filter.converter.ts)
      expect(repo.countContactsByWhere).toHaveBeenCalledWith(
        expect.objectContaining({ AND: expect.any(Array) }),
      );
      // lastCount cache is written
      expect(repo.updateCountCache).toHaveBeenCalledWith('s1', 7);
    });

    /**
     * F1 T4 — mesmo choke point das campanhas: um filtro de segmento com nó
     * history+templateIds precisa passar por resolveHistoryTargets ANTES do
     * toPrismaWhere.
     */
    it('resolve history+templateIds para campaignIds antes de montar o where (F1 T4)', async () => {
      const filters: FilterGroup = {
        combinator: 'and',
        rules: [
          {
            kind: 'history',
            event: 'received',
            negate: false,
            templateIds: ['tpl1'],
          },
        ],
      };
      repo.findById.mockResolvedValue({ id: 's1', filters } as any);
      prisma.campaign.findMany.mockResolvedValue([
        { id: 'campA', templateId: 'tpl1' },
      ] as never);
      repo.countContactsByWhere.mockResolvedValue(1);
      repo.findContactsByWhere.mockResolvedValue([]);

      await service.preview('s1');

      expect(prisma.campaign.findMany).toHaveBeenCalledWith({
        where: { templateId: { in: ['tpl1'] } },
        select: { id: true, templateId: true },
      });
      // 2026-08-25 — decisão do cliente: toPrismaWhere não embute mais
      // `{ optedOut: false }` no público (ver filter.converter.ts). O where
      // é só o AND de um grupo com uma regra de histórico.
      expect(repo.countContactsByWhere).toHaveBeenCalledWith({
        AND: [
          {
            messages: {
              some: {
                campaignId: { in: ['campA'] },
                direction: 'OUTBOUND',
                status: { in: ['SENT', 'DELIVERED', 'READ'] },
              },
            },
          },
        ],
      });
    });
  });

  describe('preflight', () => {
    it('throws SegmentNotFoundError when missing', async () => {
      repo.findById.mockResolvedValue(null);
      await expect(service.preflight('missing')).rejects.toThrow(
        SegmentNotFoundError,
      );
    });

    it('returns reachability buckets from repo.preflightSummary, forwarding the resolved where', async () => {
      repo.findById.mockResolvedValue({
        id: 's1',
        filters: { combinator: 'and', rules: [] },
      } as any);
      repo.preflightSummary.mockResolvedValue({
        total: 100,
        reachable: 60,
        invalid: 15,
        unknown: 25,
      });

      const result = await service.preflight('s1');

      expect(result).toEqual({
        total: 100,
        reachable: 60,
        invalid: 15,
        unknown: 25,
      });
      // Sem regras, toPrismaWhere devolve `{}` — 2026-08-25: já não embute
      // `{ optedOut: false }` (decisão do cliente, ver filter.converter.ts).
      expect(repo.preflightSummary).toHaveBeenCalledWith({});
    });
  });
});
