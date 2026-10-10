import { describe, expect, it, vi } from 'vitest';
import { InternalSectorsService } from './internal-sectors.service';

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
  _count: { members: 2, numbers: 1 },
};

describe('InternalSectorsService', () => {
  it('returns only active non-viewer members for eligible sector recipients', async () => {
    const repo = {
      find: vi.fn().mockResolvedValue({ ...sector, members: [], numbers: [] }),
      findMembers: vi
        .fn()
        .mockResolvedValue([{ id: 'u1', role: 'OPERATOR', isActive: true }]),
    };
    const service = new InternalSectorsService(repo as never);
    await expect(service.members('s1', true)).resolves.toEqual({
      items: [{ id: 'u1', role: 'OPERATOR', isActive: true }],
    });
    expect(repo.findMembers).toHaveBeenCalledWith('s1', true);
  });

  it('maps create results to the public summary shape', async () => {
    const repo = {
      findValidManager: vi.fn(),
      create: vi.fn().mockResolvedValue(sector),
    };
    const service = new InternalSectorsService(repo as never);
    await expect(
      service.create({ name: 'Compras', code: 'COM' }),
    ).resolves.toMatchObject({ id: 's1', memberCount: 2, numberCount: 1 });
  });

  it('disconnects the manager on an explicit null update', async () => {
    const repo = {
      find: vi.fn().mockResolvedValue({ ...sector, members: [], numbers: [] }),
      findValidManager: vi.fn(),
      update: vi.fn().mockResolvedValue(sector),
    };
    const service = new InternalSectorsService(repo as never);

    await service.update('s1', { managerId: null });

    expect(repo.findValidManager).not.toHaveBeenCalled();
    expect(repo.update).toHaveBeenCalledWith('s1', {
      manager: { disconnect: true },
    });
  });

  it('does not hide an unexpected persistence failure as a sector conflict', async () => {
    const failure = new Error('database offline');
    const repo = {
      findValidManager: vi.fn(),
      create: vi.fn().mockRejectedValue(failure),
    };
    const service = new InternalSectorsService(repo as never);

    await expect(service.create({ name: 'Compras', code: 'COM' })).rejects.toBe(
      failure,
    );
  });
});
