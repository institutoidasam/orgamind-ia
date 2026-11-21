import type { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import type { SectorAuditRow } from './sector-audit';
import { inactivationGuard } from './sector-usage';

const TODAY = '2026-11-21';

function fakeTx(counts: {
  people: number;
  inactive: number;
  exceptions: number;
  scheduled: number;
}) {
  const userCount = vi.fn(({ where }: { where: { isActive: boolean } }) =>
    Promise.resolve(where.isActive ? counts.people : counts.inactive),
  );
  const tx = {
    user: { count: userCount },
    staffScheduleException: {
      count: vi.fn().mockResolvedValue(counts.exceptions),
    },
    teamWhatsappDispatch: {
      count: vi.fn().mockResolvedValue(counts.scheduled),
    },
  };
  return { tx: tx as unknown as Prisma.TransactionClient, userCount };
}

const row = (isActive: boolean): SectorAuditRow => ({
  id: 's1',
  name: 'Compras',
  isActive,
  manager: null,
});

describe('inactivationGuard', () => {
  it('antes inativo — não consulta', async () => {
    const { tx, userCount } = fakeTx({
      people: 9,
      inactive: 0,
      exceptions: 9,
      scheduled: 9,
    });

    await expect(
      inactivationGuard('s1', TODAY)(tx, row(false)),
    ).resolves.toBeUndefined();

    expect(userCount).not.toHaveBeenCalled();
  });

  it('em uso — sector.in_use 409 com detail people=3, exceptions=1, scheduled=2', async () => {
    const { tx } = fakeTx({
      people: 3,
      inactive: 4,
      exceptions: 1,
      scheduled: 2,
    });

    await expect(
      inactivationGuard('s1', TODAY)(tx, row(true)),
    ).rejects.toMatchObject({
      code: 'sector.in_use',
      status: 409,
      detail: 'people=3, exceptions=1, scheduled=2',
    });
  });

  it('só inactivePeople — não bloqueia', async () => {
    const { tx } = fakeTx({
      people: 0,
      inactive: 5,
      exceptions: 0,
      scheduled: 0,
    });

    await expect(
      inactivationGuard('s1', TODAY)(tx, row(true)),
    ).resolves.toBeUndefined();
  });
});
