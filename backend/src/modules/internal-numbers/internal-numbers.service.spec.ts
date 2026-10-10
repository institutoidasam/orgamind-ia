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
    sector: { findFirst: vi.fn().mockResolvedValue({ id: 'sector-1' }) },
    channel: { findFirst: vi.fn().mockResolvedValue({ id: 'channel-1' }) },
    sectorNumber: {
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([number]),
      count: vi.fn().mockResolvedValue(1),
      findUnique: vi.fn().mockResolvedValue(number),
      create: vi.fn().mockResolvedValue(number),
      update: vi.fn().mockResolvedValue(number),
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
        findFirst: vi.fn().mockResolvedValue(null),
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

  it('creates only after checking uniqueness and active references', async () => {
    const { prisma, service } = serviceWith();

    await expect(service.create(input)).resolves.toMatchObject({
      phone: input.phone,
      configurationStatus: 'UNCONFIGURED',
      routingStatus: 'PENDING',
    });
    expect(prisma.sectorNumber.findFirst).toHaveBeenCalledWith({
      where: { phone: input.phone },
      select: { id: true },
    });
    expect(prisma.sectorNumber.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: input }),
    );
  });

  it('rejects an existing phone before creating a duplicate', async () => {
    const { prisma, service } = serviceWith({
      sectorNumber: {
        findFirst: vi.fn().mockResolvedValue({ id: 'number-older' }),
        create: vi.fn(),
      },
    });

    await expect(service.create(input)).rejects.toMatchObject({
      code: 'internal_number.phone_taken',
      status: 409,
    });
    expect(prisma.sectorNumber.create).not.toHaveBeenCalled();
  });

  it('maps a concurrent database phone conflict to the public conflict code', async () => {
    const { service } = serviceWith({
      sectorNumber: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockRejectedValue({
          code: 'P2002',
          meta: { target: ['phone'] },
        }),
      },
    });

    await expect(service.create(input)).rejects.toMatchObject({
      code: 'internal_number.phone_taken',
      status: 409,
    });
  });

  it('rejects an inactive sector or channel link', async () => {
    const inactiveSector = serviceWith({
      sector: { findFirst: vi.fn().mockResolvedValue(null) },
    });
    await expect(inactiveSector.service.create(input)).rejects.toMatchObject({
      code: 'internal_number.sector_inactive',
    });

    const inactiveChannel = serviceWith({
      channel: { findFirst: vi.fn().mockResolvedValue(null) },
    });
    await expect(
      inactiveChannel.service.create({ ...input, channelId: 'channel-1' }),
    ).rejects.toMatchObject({ code: 'internal_number.channel_inactive' });
  });

  it('rejects inactive sector and channel links on PATCH too', async () => {
    const inactiveSector = serviceWith({
      sector: { findFirst: vi.fn().mockResolvedValue(null) },
    });
    await expect(
      inactiveSector.service.update('number-1', { sectorId: 'sector-2' }),
    ).rejects.toMatchObject({ code: 'internal_number.sector_inactive' });

    const inactiveChannel = serviceWith({
      channel: { findFirst: vi.fn().mockResolvedValue(null) },
    });
    await expect(
      inactiveChannel.service.update('number-1', { channelId: 'channel-2' }),
    ).rejects.toMatchObject({ code: 'internal_number.channel_inactive' });
  });

  it('updates the structural record and excludes itself from phone conflict lookup', async () => {
    const { prisma, service } = serviceWith({
      sectorNumber: {
        findFirst: vi.fn().mockResolvedValue(null),
        findUnique: vi.fn().mockResolvedValue(storedNumber()),
        update: vi.fn().mockResolvedValue(storedNumber({ name: 'Novo nome' })),
      },
    });

    await expect(
      service.update('number-1', {
        name: 'Novo nome',
        phone: '+5592999991111',
      }),
    ).resolves.toMatchObject({ name: 'Novo nome', routingStatus: 'PENDING' });
    expect(prisma.sectorNumber.findFirst).toHaveBeenCalledWith({
      where: { phone: '+5592999991111', NOT: { id: 'number-1' } },
      select: { id: true },
    });
    expect(prisma.sectorNumber.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'number-1' },
        data: { name: 'Novo nome', phone: '+5592999991111' },
      }),
    );
  });

  it('maps a concurrent phone conflict raised during PATCH', async () => {
    const { service } = serviceWith({
      sectorNumber: {
        findFirst: vi.fn().mockResolvedValue(null),
        findUnique: vi.fn().mockResolvedValue(storedNumber()),
        update: vi.fn().mockRejectedValue({
          code: 'P2002',
          meta: { target: ['phone'] },
        }),
      },
    });

    await expect(
      service.update('number-1', { phone: '+5592999991111' }),
    ).rejects.toMatchObject({
      code: 'internal_number.phone_taken',
      status: 409,
    });
  });
});
