// backend/src/modules/whatsapp-providers/whatsapp-providers.repository.spec.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { WhatsappProvidersRepository } from './whatsapp-providers.repository';
import type { PrismaService } from '../../shared/prisma/prisma.service';

function makePrisma() {
  return {
    whatsappConnectionEvent: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      deleteMany: vi.fn(),
    },
  } as unknown as PrismaService;
}

describe('WhatsappProvidersRepository', () => {
  let prisma: ReturnType<typeof makePrisma>;
  let repo: WhatsappProvidersRepository;

  beforeEach(() => {
    prisma = makePrisma();
    expect(WhatsappProvidersRepository, 'WhatsappProvidersRepository must be exported from whatsapp-providers.repository.ts').toBeDefined();
    repo = new (WhatsappProvidersRepository as any)(prisma);
  });

  describe('findLastEvent', () => {
    it('returns the most-recent event for an instance', async () => {
      const event = { id: 'e1', instanceId: 'inst-id', state: 'open', reasonCode: null, occurredAt: new Date() };
      (prisma.whatsappConnectionEvent.findFirst as ReturnType<typeof vi.fn>).mockResolvedValueOnce(event);

      const result = await repo.findLastEvent('inst-id');
      expect(result).toEqual(event);
      expect(prisma.whatsappConnectionEvent.findFirst).toHaveBeenCalledWith({
        where: { instanceId: 'inst-id' },
        orderBy: { occurredAt: 'desc' },
      });
    });

    it('returns null when no events exist', async () => {
      (prisma.whatsappConnectionEvent.findFirst as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
      const result = await repo.findLastEvent('inst-id');
      expect(result).toBeNull();
    });
  });

  describe('createEvent', () => {
    it('inserts a new event row', async () => {
      const now = new Date();
      const created = { id: 'e2', instanceId: 'inst-id', state: 'close', reasonCode: 408, occurredAt: now };
      (prisma.whatsappConnectionEvent.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce(created);

      const result = await repo.createEvent({ instanceId: 'inst-id', state: 'close', reasonCode: 408, occurredAt: now });
      expect(result).toEqual(created);
      expect(prisma.whatsappConnectionEvent.create).toHaveBeenCalledWith({
        data: { instanceId: 'inst-id', state: 'close', reasonCode: 408, occurredAt: now },
      });
    });
  });

  describe('lastStateByInstanceIds', () => {
    it('returns a Map of instanceId -> most-recent state, one query, distinct per instance', async () => {
      (prisma.whatsappConnectionEvent.findMany as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
        { instanceId: 'g1', state: 'open' },
        { instanceId: 'g2', state: 'connecting' },
      ]);

      const result = await repo.lastStateByInstanceIds(['g1', 'g2']);

      expect(prisma.whatsappConnectionEvent.findMany).toHaveBeenCalledWith({
        where: { instanceId: { in: ['g1', 'g2'] } },
        orderBy: { occurredAt: 'desc' },
        distinct: ['instanceId'],
        select: { instanceId: true, state: true },
      });
      expect(result.get('g1')).toBe('open');
      expect(result.get('g2')).toBe('connecting');
    });

    it('returns an empty Map without querying when given no ids', async () => {
      const result = await repo.lastStateByInstanceIds([]);
      expect(result.size).toBe(0);
      expect(prisma.whatsappConnectionEvent.findMany).not.toHaveBeenCalled();
    });

    it('an instance with no event at all is simply absent from the Map — never fabricated as "close"', async () => {
      (prisma.whatsappConnectionEvent.findMany as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
        { instanceId: 'g1', state: 'open' },
      ]);

      const result = await repo.lastStateByInstanceIds(['g1', 'g2']);

      expect(result.has('g2')).toBe(false);
    });
  });

  describe('deleteOldEvents', () => {
    it('deletes events older than the given cutoff date', async () => {
      (prisma.whatsappConnectionEvent.deleteMany as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ count: 5 });
      const cutoff = new Date('2026-05-13T00:00:00Z');
      const count = await repo.deleteOldEvents(cutoff);
      expect(count).toBe(5);
      expect(prisma.whatsappConnectionEvent.deleteMany).toHaveBeenCalledWith({
        where: { occurredAt: { lt: cutoff } },
      });
    });
  });
});
