import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { UsersRepository } from './users.repository';
import { personHasHistory } from './person-history';

// O histórico tem integração própria (users.repository.integration.spec.ts).
vi.mock('./person-history', () => ({
  personHasHistory: vi.fn().mockResolvedValue(false),
}));

function activeAdmin(id: string, isActive = true) {
  return { id, role: 'ADMIN', isActive };
}

describe('UsersRepository vínculo só por writeAssignment (DV15)', () => {
  it('recusa sector/sectorId/workShift/shiftId/level/levelId em data, antes de abrir a transação', async () => {
    const prisma = { $transaction: vi.fn() };
    const repo = new UsersRepository(prisma as never);
    const trail = vi.fn();
    const forbidden = [
      { sector: { connect: { id: 's1' } } },
      { sectorId: 's1' },
      { workShift: { disconnect: true } },
      { shiftId: null },
      { level: { connect: { id: 'l1' } } },
      { levelId: 'l1' },
    ];

    for (const data of forbidden) {
      await expect(
        repo.createWithAudit({ name: 'X', ...data } as never, trail),
      ).rejects.toThrow('vínculo só por writeAssignment');
      await expect(
        repo.updateWithLastAdminGuard('u1', data as never, trail),
      ).rejects.toThrow('vínculo só por writeAssignment');
    }
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(trail).not.toHaveBeenCalled();
  });
});

describe('UsersRepository recusa o histórico de vínculo em data (DV15)', () => {
  it('recusa a relação assignments (create/updateMany/deleteMany) em data, antes de abrir a transação', async () => {
    const prisma = { $transaction: vi.fn() };
    const repo = new UsersRepository(prisma as never);
    const trail = vi.fn();
    const forbidden = [
      { assignments: { create: { sectorId: 's1' } } },
      { assignments: { updateMany: { where: {}, data: { shiftId: null } } } },
      { assignments: { deleteMany: {} } },
    ];

    for (const data of forbidden) {
      await expect(
        repo.createWithAudit({ name: 'X', ...data }, trail),
      ).rejects.toThrow('vínculo só por writeAssignment');
      await expect(
        repo.updateWithLastAdminGuard('u1', data as never, trail),
      ).rejects.toThrow('vínculo só por writeAssignment');
    }
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(trail).not.toHaveBeenCalled();
  });
});

const uniqueOn = (modelName: string, target: string[]) =>
  new Prisma.PrismaClientKnownRequestError('unique', {
    code: 'P2002',
    clientVersion: 'test',
    meta: { modelName, target },
  });

describe('UsersRepository repete a inserção concorrente de linha aberta (DV7)', () => {
  it('repete P2002 do único parcial da linha aberta e não repete P2002 de outro campo', async () => {
    const tx = {
      user: {
        findUnique: vi.fn().mockResolvedValue(activeAdmin('a1')),
        count: vi.fn().mockResolvedValue(1),
      },
    };
    // Forma real do Prisma 6 para o índice parcial (sem o nome do índice).
    const retried = {
      $transaction: vi
        .fn()
        .mockRejectedValueOnce(uniqueOn('UserAssignment', ['userId']))
        .mockImplementationOnce((callback: (value: unknown) => unknown) =>
          Promise.resolve(callback(tx)),
        ),
    };
    await expect(
      new UsersRepository(retried as never).updateWithLastAdminGuard('a1', {
        isActive: false,
      }),
    ).resolves.toEqual({ lastAdmin: true });
    expect(retried.$transaction).toHaveBeenCalledTimes(2);

    const phoneTaken = uniqueOn('User', ['phoneE164']);
    const once = { $transaction: vi.fn().mockRejectedValue(phoneTaken) };
    await expect(
      new UsersRepository(once as never).updateWithLastAdminGuard('a1', {
        name: 'X',
      }),
    ).rejects.toBe(phoneTaken);
    expect(once.$transaction).toHaveBeenCalledTimes(1);
  });
});

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
    const audit = vi.fn().mockResolvedValue(undefined);
    await expect(
      repo.deleteWithLastAdminGuard('inactive', audit),
    ).resolves.toEqual({ deleted: activeAdmin('inactive', false) });
    expect(audit).toHaveBeenCalledWith(tx, activeAdmin('inactive', false));
    // Histórico, delete e trilha no mesmo tx serializable (sem janela).
    expect(personHasHistory).toHaveBeenCalledWith(tx, 'inactive');
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    });
    expect(tx.user.count).not.toHaveBeenCalled();
  });
});

describe('UsersRepository last active admin guard under serialization failure', () => {
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
