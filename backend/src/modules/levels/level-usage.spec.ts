import type { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import type { LevelAuditRow } from './level-audit';
import { deactivationGuard } from './level-usage';

function fakeTx(activePeople: number) {
  const count = vi.fn().mockResolvedValue(activePeople);
  return {
    tx: { user: { count } } as unknown as Prisma.TransactionClient,
    count,
  };
}

const row = (isActive: boolean): LevelAuditRow => ({
  id: 'l1',
  name: 'Líder',
  isActive,
});

describe('deactivationGuard', () => {
  it('antes inativo ou pedido sem isActive false — não consulta', async () => {
    const { tx, count } = fakeTx(9);
    const guard = deactivationGuard('l1');

    await expect(
      guard(tx, row(false), { isActive: false }),
    ).resolves.toBeUndefined();
    await expect(
      guard(tx, row(true), { name: 'Novo' }),
    ).resolves.toBeUndefined();
    await expect(
      guard(tx, row(true), { isActive: true }),
    ).resolves.toBeUndefined();

    expect(count).not.toHaveBeenCalled();
  });

  it('aceite 14: com pessoa ativa — levels.in_use 409, detail people=2', async () => {
    const { tx, count } = fakeTx(2);

    await expect(
      deactivationGuard('l1')(tx, row(true), { isActive: false }),
    ).rejects.toMatchObject({
      code: 'levels.in_use',
      status: 409,
      detail: 'people=2',
    });

    expect(count).toHaveBeenCalledWith({
      where: { levelId: 'l1', isActive: true },
    });
  });

  it('só pessoa inativa — não bloqueia', async () => {
    const { tx } = fakeTx(0);

    await expect(
      deactivationGuard('l1')(tx, row(true), { isActive: false }),
    ).resolves.toBeUndefined();
  });
});
