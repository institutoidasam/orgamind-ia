import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { NotFoundError } from '../../shared/errors/domain.error';

const numberInclude = {
  sector: { select: { id: true, name: true, code: true, isActive: true } },
  channel: {
    select: {
      id: true,
      name: true,
      provider: true,
      isActive: true,
      ownerUserId: true,
    },
  },
} as const;

@Injectable()
export class InternalNumbersService {
  constructor(private readonly prisma: PrismaService) {}

  async list(page: number, pageSize: number) {
    const [items, total] = await this.prisma.$transaction([
      this.prisma.sectorNumber.findMany({
        skip: (page - 1) * pageSize,
        take: pageSize,
        orderBy: { createdAt: 'desc' },
        include: numberInclude,
      }),
      this.prisma.sectorNumber.count(),
    ]);
    return { items: items.map(toResponse), total, page, pageSize };
  }

  async findById(id: string) {
    const number = await this.prisma.sectorNumber.findUnique({
      where: { id },
      include: numberInclude,
    });
    if (!number) throw new NotFoundError('InternalNumber', id);
    return toResponse(number);
  }
}

function toResponse(number: {
  id: string;
  name: string;
  phone: string;
  provider: string;
  sectorId: string | null;
  routeToSector: boolean;
  channelId: string | null;
  createdAt: Date;
  updatedAt: Date;
  sector: { id: string; name: string; code: string; isActive: boolean } | null;
  channel: {
    id: string;
    name: string;
    provider: string;
    isActive: boolean;
    ownerUserId: string | null;
  } | null;
}) {
  return {
    ...number,
    configurationStatus: number.channel?.isActive
      ? 'CONFIGURED'
      : 'UNCONFIGURED',
    routingStatus: 'PENDING' as const,
  };
}
