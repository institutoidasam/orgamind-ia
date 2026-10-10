import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { UsersRepository } from './users.repository';

function activeAdmin(id: string, isActive = true) {
  return { id, role: 'ADMIN', isActive };
}

describe('UsersRepository last active admin guard', () => {
  it('allows deleting an inactive admin when one active admin remains', async () => {
    const tx = {
      user: {
        findUnique: vi.fn().mockResolvedValue(activeAdmin('inactive', false)),
        count: vi.fn(),
        delete: vi.fn().mockResolvedValue({ id: 'inactive' }),
      },
    };
    const prisma = {
      $transaction: vi.fn((callback: (value: unknown) => unknown) =>
        Promise.resolve(callback(tx)),
      ),
    };
    const repo = new UsersRepository(prisma as never);
    await expect(repo.deleteWithLastAdminGuard('inactive')).resolves.toEqual({
      deleted: { id: 'inactive' },
    });
    expect(tx.user.count).not.toHaveBeenCalled();
  });

  it('retries a serializable transaction and re-evaluates the last admin count', async () => {
    const serialization = new Prisma.PrismaClientKnownRequestError(
      'serialization',
      { code: 'P2034', clientVersion: 'test' },
    );
    const tx = {
      user: {
        findUnique: vi.fn().mockResolvedValue(activeAdmin('a1')),
        count: vi.fn().mockResolvedValue(1),
        update: vi.fn(),
      },
    };
    const prisma = {
      $transaction: vi
        .fn()
        .mockRejectedValueOnce(serialization)
        .mockImplementationOnce((callback: (value: unknown) => unknown) =>
          Promise.resolve(callback(tx)),
        ),
    };
    const repo = new UsersRepository(prisma as never);
    await expect(
      repo.updateWithLastAdminGuard('a1', { isActive: false }),
    ).resolves.toEqual({ lastAdmin: true });
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
  });
});
