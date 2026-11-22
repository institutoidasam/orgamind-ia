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
  channel: null,
  _count: { members: 2 },
};

const channelRow = {
  id: 'ch1',
  name: 'Compras Zap',
  phoneE164: '+5592999990001',
  provider: 'GOZAP',
  isActive: true,
};

describe('InternalSectorsService', () => {
  it('returns only active non-viewer members for eligible sector recipients', async () => {
    const repo = {
      find: vi.fn().mockResolvedValue({ ...sector, members: [] }),
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
    ).resolves.toMatchObject({ id: 's1', memberCount: 2, channel: null });
  });

  it('disconnects the manager on an explicit null update', async () => {
    const repo = {
      find: vi.fn().mockResolvedValue({ ...sector, members: [] }),
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

describe('InternalSectorsService — número efetivo do setor (C1)', () => {
  it.each([
    [
      'canal GOZAP ativo',
      channelRow,
      { id: 'ch1', name: 'Compras Zap', phoneE164: '+5592999990001' },
    ],
    ['canal inativo', { ...channelRow, isActive: false }, null],
    ['canal TWILIO', { ...channelRow, provider: 'TWILIO' }, null],
    ['sem canal', null, null],
  ])(
    'setor com %s responde channel efetivo, sem numbers/numberCount',
    async (_label, channel, expected) => {
      const repo = {
        list: vi.fn().mockResolvedValue([[{ ...sector, channel }], 1]),
        find: vi.fn().mockResolvedValue({ ...sector, channel, members: [] }),
      };
      const service = new InternalSectorsService(repo as never);

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
