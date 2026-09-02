import { describe, it, expect, beforeEach } from 'vitest';
import { mockDeep, type MockProxy } from 'vitest-mock-extended';
import { SegmentsRepository } from './segments.repository';
import { PrismaService } from '../../shared/prisma/prisma.service';

describe('SegmentsRepository', () => {
  let repo: SegmentsRepository;
  let prisma: MockProxy<PrismaService>;

  beforeEach(() => {
    prisma = mockDeep<PrismaService>();
    repo = new SegmentsRepository(prisma);
  });

  describe('listSummaries', () => {
    it('selects summary fields ordered by createdAt desc', async () => {
      prisma.segment.findMany.mockResolvedValue([{ id: 's1' }] as any);
      const result = await repo.listSummaries();
      expect(result).toEqual([{ id: 's1' }]);
      expect(prisma.segment.findMany).toHaveBeenCalledWith({
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          name: true,
          description: true,
          lastCount: true,
          lastCountedAt: true,
          createdAt: true,
        },
      });
    });
  });

  describe('findById', () => {
    it('delegates to prisma.segment.findUnique', async () => {
      prisma.segment.findUnique.mockResolvedValue({ id: 's1' } as any);
      const result = await repo.findById('s1');
      expect(result).toEqual({ id: 's1' });
      expect(prisma.segment.findUnique).toHaveBeenCalledWith({
        where: { id: 's1' },
      });
    });
  });

  describe('findByName', () => {
    it('delegates to prisma.segment.findUnique on name', async () => {
      prisma.segment.findUnique.mockResolvedValue(null);
      await repo.findByName('VIP');
      expect(prisma.segment.findUnique).toHaveBeenCalledWith({
        where: { name: 'VIP' },
      });
    });
  });

  describe('create', () => {
    it('persists name/description/filters/createdById', async () => {
      prisma.segment.create.mockResolvedValue({ id: 's1' } as any);
      await repo.create({
        name: 'VIP',
        description: 'desc',
        filters: { combinator: 'and', rules: [] } as any,
        createdById: 'u1',
      });
      expect(prisma.segment.create).toHaveBeenCalledWith({
        data: {
          name: 'VIP',
          description: 'desc',
          filters: { combinator: 'and', rules: [] },
          createdById: 'u1',
        },
      });
    });
  });

  describe('update', () => {
    it('delegates partial updates to prisma.segment.update', async () => {
      prisma.segment.update.mockResolvedValue({ id: 's1' } as any);
      await repo.update('s1', { name: 'New' });
      expect(prisma.segment.update).toHaveBeenCalledWith({
        where: { id: 's1' },
        data: { name: 'New' },
      });
    });
  });

  describe('delete', () => {
    it('delegates to prisma.segment.delete', async () => {
      prisma.segment.delete.mockResolvedValue({ id: 's1' } as any);
      await repo.delete('s1');
      expect(prisma.segment.delete).toHaveBeenCalledWith({ where: { id: 's1' } });
    });
  });

  describe('updateCountCache', () => {
    it('writes lastCount and lastCountedAt', async () => {
      prisma.segment.update.mockResolvedValue({ id: 's1' } as any);
      await repo.updateCountCache('s1', 42);
      const arg = prisma.segment.update.mock.calls[0][0] as any;
      expect(arg.where).toEqual({ id: 's1' });
      expect(arg.data.lastCount).toBe(42);
      expect(arg.data.lastCountedAt).toBeInstanceOf(Date);
    });
  });

  describe('countContactsByWhere', () => {
    it('delegates to prisma.contact.count', async () => {
      prisma.contact.count.mockResolvedValue(7);
      const where = { city: 'Manaus' } as any;
      const result = await repo.countContactsByWhere(where);
      expect(result).toBe(7);
      expect(prisma.contact.count).toHaveBeenCalledWith({ where });
    });
  });

  describe('findContactsByWhere', () => {
    /**
     * A prévia do segmento tem de mostrar as MESMAS pessoas, na MESMA ordem, que
     * o disparo vai alcançar (`campaigns.repository.findContactsPage`, id asc).
     * Ordenar a amostra por `createdAt: 'desc'` mostrava o OUTRO extremo da lista.
     */
    it('ordena por id asc — a MESMA ordem do disparo', async () => {
      const contacts = [{ id: 'k1' }] as any;
      prisma.contact.findMany.mockResolvedValue(contacts);
      const where = { city: 'X' } as any;
      const result = await repo.findContactsByWhere(where, 10);
      expect(result).toBe(contacts);
      expect(prisma.contact.findMany).toHaveBeenCalledWith({
        where,
        take: 10,
        orderBy: { id: 'asc' },
      });
    });

    it('caps an over-large take to MAX_CONTACTS_TAKE to prevent unbounded fetches', async () => {
      prisma.contact.findMany.mockResolvedValue([] as any);
      await repo.findContactsByWhere({} as any, 1_000_000);
      const arg = prisma.contact.findMany.mock.calls[0][0] as any;
      expect(arg.take).toBe(SegmentsRepository.MAX_CONTACTS_TAKE);
    });
  });

  describe('preflightSummary', () => {
    it('buckets contacts by whatsappValid into reachable/invalid/unknown', async () => {
      prisma.$transaction.mockImplementation((arg: any) =>
        Array.isArray(arg) ? Promise.all(arg) : arg(prisma),
      );
      prisma.contact.count
        .mockResolvedValueOnce(100) // total
        .mockResolvedValueOnce(60) // reachable (whatsappValid: true)
        .mockResolvedValueOnce(15); // invalid (whatsappValid: false)
      const where = { city: 'Manaus' } as any;
      const result = await repo.preflightSummary(where);
      expect(result).toEqual({
        total: 100,
        reachable: 60,
        invalid: 15,
        unknown: 25,
      });
    });

    it('runs the three counts in a RepeatableRead transaction', async () => {
      prisma.$transaction.mockImplementation((arg: any) =>
        Array.isArray(arg) ? Promise.all(arg) : arg(prisma),
      );
      prisma.contact.count
        .mockResolvedValueOnce(10)
        .mockResolvedValueOnce(5)
        .mockResolvedValueOnce(3);
      await repo.preflightSummary({ city: 'X' } as any);
      const opts = prisma.$transaction.mock.calls[0][1] as any;
      expect(opts?.isolationLevel).toBe('RepeatableRead');
    });

    it('clamps a negative unknown bucket to 0 under concurrent writes', async () => {
      // total counted first; if more rows are validated mid-transaction (under
      // ReadCommitted), reachable+invalid can exceed total → negative unknown.
      prisma.$transaction.mockImplementation((arg: any) =>
        Array.isArray(arg) ? Promise.all(arg) : arg(prisma),
      );
      prisma.contact.count
        .mockResolvedValueOnce(100) // total
        .mockResolvedValueOnce(70) // reachable
        .mockResolvedValueOnce(40); // invalid → 100-70-40 = -10
      const result = await repo.preflightSummary({ city: 'X' } as any);
      expect(result.unknown).toBe(0);
    });
  });

  // F1 T9 — o aviso de "apagar campanha" precisa do filters CRU de todo
  // segmento para varrer em memória por nós history que citam a campanha
  // (dependent-segments.ts). listSummaries() de propósito não traz filters
  // (é a listagem, que não precisa do JSON pesado) — daqui vem essa coluna.
  describe('findAllWithFilters', () => {
    it('selects id, name and filters for every segment', async () => {
      prisma.segment.findMany.mockResolvedValue([
        { id: 's1', name: 'Seg 1', filters: { combinator: 'and', rules: [] } },
      ] as any);
      const result = await repo.findAllWithFilters();
      expect(result).toEqual([
        { id: 's1', name: 'Seg 1', filters: { combinator: 'and', rules: [] } },
      ]);
      expect(prisma.segment.findMany).toHaveBeenCalledWith({
        select: { id: true, name: true, filters: true },
      });
    });
  });
});
