import type { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { InternalSectorsService } from './internal-sectors.service';

const ACTOR = 'admin-1';
const TX = { marker: 'tx' } as unknown as Prisma.TransactionClient;
const ANA = { id: 'u-ana', name: 'Ana Souza' };
const BRUNO = { id: 'u-bruno', name: 'Bruno Lima' };

const sector = {
  id: 's1',
  name: 'Compras',
  code: 'COM',
  description: null,
  isActive: true,
  managerId: null,
  manager: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  channel: null,
  _count: { members: 2 },
};

const channelRow = {
  id: 'ch1',
  name: 'Compras Zap',
  phoneE164: '+5592999990001',
  provider: 'EVOLUTION',
  isActive: true,
};

function trailHarness(before: object, after: object) {
  const audit = { recordChange: vi.fn().mockResolvedValue(undefined) };
  const repo = {
    find: vi.fn().mockResolvedValue({ ...sector, members: [] }),
    findValidManager: vi.fn().mockResolvedValue({ id: ANA.id }),
    createWithAudit: vi.fn(
      async (_data: unknown, trail: (...args: unknown[]) => Promise<void>) => {
        await trail(TX, after);
        return after;
      },
    ),
    updateWithAudit: vi.fn(
      async (
        _id: string,
        _data: unknown,
        trail: (...args: unknown[]) => Promise<void>,
      ) => {
        await trail(TX, before, after);
        return after;
      },
    ),
  };
  const service = new InternalSectorsService(repo as never, audit as never);
  return { audit, repo, service };
}
const withManager = (manager: object | null) => ({ ...sector, manager });

describe('InternalSectorsService — trilha de setor na criação e na edição (A5, GC1)', () => {
  it('create grava sector.created no tx, STRUCTURE, com o ator e o gestor só { id, name }', async () => {
    const created = withManager({ ...ANA, email: 'ana@gbr.com.br' });
    const h = trailHarness(sector, created);

    await h.service.create(
      { name: 'Compras', code: 'COM', managerId: ANA.id },
      ACTOR,
    );

    expect(h.audit.recordChange).toHaveBeenCalledWith(TX, {
      action: 'sector.created',
      entity: 'Sector',
      entityId: 's1',
      category: 'STRUCTURE',
      actorId: ACTOR,
      changes: [
        { field: 'name', before: null, after: 'Compras' },
        { field: 'manager', before: null, after: ANA },
        { field: 'isActive', before: null, after: true },
      ],
    });
    expect(JSON.stringify(h.audit.recordChange.mock.calls)).not.toContain(
      'ana@gbr',
    );
  });

  it('update grava sector.updated no tx só com o campo alterado e o ator explícito', async () => {
    const h = trailHarness(withManager(ANA), withManager(BRUNO));

    await h.service.update('s1', { managerId: BRUNO.id }, ACTOR);

    expect(h.audit.recordChange).toHaveBeenCalledWith(TX, {
      action: 'sector.updated',
      entity: 'Sector',
      entityId: 's1',
      category: 'STRUCTURE',
      actorId: ACTOR,
      changes: [{ field: 'manager', before: ANA, after: BRUNO }],
    });
  });
});

describe('InternalSectorsService — trilha de setor sem alteração e com falha (A5, GC1)', () => {
  it('update sem nenhum campo auditado alterado não grava evento vazio', async () => {
    const h = trailHarness(sector, { ...sector, description: 'Nova' });

    await h.service.update('s1', { description: 'Nova' }, ACTOR);

    expect(h.audit.recordChange).not.toHaveBeenCalled();
  });

  it('falha da trilha propaga e não vira conflito de setor', async () => {
    const failure = new Error('audit offline');
    const h = trailHarness({ ...sector, isActive: false }, sector);
    h.audit.recordChange.mockRejectedValue(failure);

    await expect(
      h.service.create({ name: 'Compras', code: 'COM' }, ACTOR),
    ).rejects.toBe(failure);
    await expect(
      h.service.update('s1', { isActive: true }, ACTOR),
    ).rejects.toBe(failure);
  });
});

describe('InternalSectorsService — membros e criação', () => {
  it('returns only active non-viewer members for eligible sector recipients', async () => {
    const repo = {
      find: vi.fn().mockResolvedValue({ ...sector, members: [] }),
      findMembers: vi
        .fn()
        .mockResolvedValue([{ id: 'u1', role: 'OPERATOR', isActive: true }]),
    };
    const service = new InternalSectorsService(repo as never, {} as never);
    await expect(service.members('s1', true)).resolves.toEqual({
      items: [{ id: 'u1', role: 'OPERATOR', isActive: true }],
    });
    expect(repo.findMembers).toHaveBeenCalledWith('s1', true);
  });

  it('maps create results to the public summary shape', async () => {
    const repo = {
      findValidManager: vi.fn(),
      createWithAudit: vi.fn().mockResolvedValue(sector),
    };
    const service = new InternalSectorsService(repo as never, {} as never);
    await expect(
      service.create({ name: 'Compras', code: 'COM' }, ACTOR),
    ).resolves.toMatchObject({ id: 's1', memberCount: 2, channel: null });
  });
});

describe('InternalSectorsService — edição e falha de persistência', () => {
  it('disconnects the manager on an explicit null update', async () => {
    const repo = {
      find: vi.fn().mockResolvedValue({ ...sector, members: [] }),
      findValidManager: vi.fn(),
      updateWithAudit: vi.fn().mockResolvedValue(sector),
    };
    const service = new InternalSectorsService(repo as never, {} as never);

    await service.update('s1', { managerId: null }, ACTOR);

    expect(repo.findValidManager).not.toHaveBeenCalled();
    expect(repo.updateWithAudit).toHaveBeenCalledWith(
      's1',
      { manager: { disconnect: true } },
      expect.any(Function),
    );
  });

  it('does not hide an unexpected persistence failure as a sector conflict', async () => {
    const failure = new Error('database offline');
    const repo = {
      findValidManager: vi.fn(),
      createWithAudit: vi.fn().mockRejectedValue(failure),
    };
    const service = new InternalSectorsService(repo as never, {} as never);

    await expect(
      service.create({ name: 'Compras', code: 'COM' }, ACTOR),
    ).rejects.toBe(failure);
  });
});

describe('InternalSectorsService — número efetivo do setor (C1)', () => {
  it.each([
    [
      'canal EVOLUTION ativo',
      channelRow,
      { id: 'ch1', name: 'Compras Zap', phoneE164: '+5592999990001' },
    ],
    ['canal inativo', { ...channelRow, isActive: false }, null],
    [
      'canal GOZAP ativo (provedor desligado)',
      { ...channelRow, provider: 'GOZAP' },
      null,
    ],
    ['canal TWILIO', { ...channelRow, provider: 'TWILIO' }, null],
    ['sem canal', null, null],
  ])(
    'setor com %s responde channel efetivo, sem numbers/numberCount',
    async (_label, channel, expected) => {
      const repo = {
        list: vi.fn().mockResolvedValue([[{ ...sector, channel }], 1]),
        find: vi.fn().mockResolvedValue({ ...sector, channel, members: [] }),
      };
      const service = new InternalSectorsService(repo as never, {} as never);

      const listed = await service.list(1, 25);
      const detail = await service.get('s1');

      expect(listed.items[0].channel).toEqual(expected);
      expect(detail.channel).toEqual(expected);
      for (const response of [listed.items[0], detail]) {
        expect(response).not.toHaveProperty('numberCount');
        expect(response).not.toHaveProperty('numbers');
      }
    },
  );
});
