import { Injectable } from '@nestjs/common';
import { Prisma, Role } from '@prisma/client';
import { PrismaService } from '../../shared/prisma/prisma.service';

export const sectorSummarySelect = {
  id: true,
  name: true,
  code: true,
  description: true,
  isActive: true,
  managerId: true,
  createdAt: true,
  updatedAt: true,
  manager: { select: { id: true, name: true, email: true } },
  _count: { select: { members: true, numbers: true } },
} satisfies Prisma.SectorSelect;
export type SectorSummaryRecord = Prisma.SectorGetPayload<{
  select: typeof sectorSummarySelect;
}>;
@Injectable()
export class InternalSectorsRepository {
  constructor(private readonly prisma: PrismaService) {}
  list(page: number, pageSize: number, activeOnly?: boolean) {
    const where = activeOnly ? { isActive: true } : {};
    return Promise.all([
      this.prisma.sector.findMany({
        where,
        skip: (page - 1) * pageSize,
        take: pageSize,
        orderBy: { name: 'asc' },
        select: sectorSummarySelect,
      }),
      this.prisma.sector.count({ where }),
    ]);
  }
  find(id: string) {
    return this.prisma.sector.findUnique({
      where: { id },
      select: {
        ...sectorSummarySelect,
        members: {
          select: {
            id: true,
            name: true,
            email: true,
            role: true,
            sectorId: true,
            isActive: true,
          },
        },
        numbers: {
          select: {
            id: true,
            name: true,
            phone: true,
            provider: true,
            channelId: true,
            routeToSector: true,
          },
        },
      },
    });
  }
  create(data: Prisma.SectorCreateInput) {
    return this.prisma.sector.create({ data, select: sectorSummarySelect });
  }
  update(id: string, data: Prisma.SectorUpdateInput) {
    return this.prisma.sector.update({
      where: { id },
      data,
      select: sectorSummarySelect,
    });
  }
  findMembers(sectorId: string, eligible?: boolean) {
    return this.prisma.user.findMany({
      where: {
        sectorId,
        isActive: true,
        ...(eligible
          ? { role: { in: [Role.ADMIN, Role.SUPERVISOR, Role.OPERATOR] } }
          : {}),
      },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        sectorId: true,
        isActive: true,
      },
      orderBy: { email: 'asc' },
    });
  }
  findValidManager(id: string) {
    return this.prisma.user.findFirst({
      where: {
        id,
        isActive: true,
        role: { in: [Role.ADMIN, Role.SUPERVISOR, Role.OPERATOR] },
      },
      select: { id: true },
    });
  }
}
