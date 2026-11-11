import { describe, expect, it, vi } from 'vitest';
import { InternalNumbersService } from './internal-numbers.service';

const input = {
  name: 'GBR Engenharia',
  phone: '+5592999990000',
  provider: 'META' as const,
  sectorId: 'sector-1',
  routeToSector: true,
};

function storedNumber(overrides: Record<string, unknown> = {}) {
  return {
    id: 'number-1',
    ...input,
    channelId: null,
    sector: {
      id: 'sector-1',
      name: 'Engenharia',
      code: 'ENG',
      isActive: true,
    },
    channel: null,
    createdAt: new Date('2026-10-10T12:00:00.000Z'),
    updatedAt: new Date('2026-10-10T12:00:00.000Z'),
    ...overrides,
  };
}

function serviceWith(overrides: Record<string, unknown> = {}) {
  const number = storedNumber();
  const prisma = {
    $transaction: vi.fn().mockResolvedValue([[number], 1]),
    sectorNumber: {
      findMany: vi.fn().mockResolvedValue([number]),
      count: vi.fn().mockResolvedValue(1),
      findUnique: vi.fn().mockResolvedValue(number),
    },
    ...overrides,
  };
  return { prisma, service: new InternalNumbersService(prisma as never) };
}

describe('InternalNumbersService', () => {
  it('lists paginated structural registrations with a pending route', async () => {
    const { prisma, service } = serviceWith();

    await expect(service.list(2, 10)).resolves.toMatchObject({
      total: 1,
      page: 2,
      pageSize: 10,
      items: [
        { configurationStatus: 'UNCONFIGURED', routingStatus: 'PENDING' },
      ],
    });
    expect(prisma.sectorNumber.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 10, take: 10 }),
    );
  });

  it('finds a configured channel but keeps routing pending', async () => {
    const { service } = serviceWith({
      sectorNumber: {
        findUnique: vi.fn().mockResolvedValue(
          storedNumber({
            channelId: 'channel-1',
            channel: {
              id: 'channel-1',
              name: 'Canal Meta',
              provider: 'META',
              isActive: true,
              ownerUserId: 'user-1',
            },
          }),
        ),
      },
    });

    await expect(service.findById('number-1')).resolves.toMatchObject({
      configurationStatus: 'CONFIGURED',
      routingStatus: 'PENDING',
      channel: { id: 'channel-1', ownerUserId: 'user-1' },
    });
  });

  it('returns not found for an unknown registration', async () => {
    const { service } = serviceWith({
      sectorNumber: { findUnique: vi.fn().mockResolvedValue(null) },
    });

    await expect(service.findById('missing')).rejects.toMatchObject({
      code: 'internalnumber.not_found',
      status: 404,
    });
  });
});
