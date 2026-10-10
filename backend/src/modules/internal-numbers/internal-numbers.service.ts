import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../shared/prisma/prisma.service';
import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from '../../shared/errors/domain.error';
import type {
  CreateInternalNumber,
  UpdateInternalNumber,
} from '../../schemas/contracts/internal-number.schema';

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

  async create(input: CreateInternalNumber) {
    await this.assertPhoneAvailable(input.phone);
    await this.assertReferences(input.sectorId, input.channelId);
    try {
      const number = await this.prisma.sectorNumber.create({
        data: input,
        include: numberInclude,
      });
      return toResponse(number);
    } catch (error: unknown) {
      this.throwPhoneConflict(error);
      throw error;
    }
  }

  async update(id: string, input: UpdateInternalNumber) {
    const current = await this.findById(id);
    if (input.phone && input.phone !== current.phone) {
      await this.assertPhoneAvailable(input.phone, id);
    }
    if (input.sectorId !== undefined || input.channelId !== undefined) {
      await this.assertReferences(input.sectorId, input.channelId);
    }
    try {
      const number = await this.prisma.sectorNumber.update({
        where: { id },
        data: input,
        include: numberInclude,
      });
      return toResponse(number);
    } catch (error: unknown) {
      this.throwPhoneConflict(error);
      throw error;
    }
  }

  private async assertReferences(
    sectorId?: string | null,
    channelId?: string | null,
  ) {
    if (
      sectorId &&
      !(await this.prisma.sector.findFirst({
        where: { id: sectorId, isActive: true },
      }))
    ) {
      throw new ValidationError(
        'Sector must be active',
        'sectorId',
        'internal_number.sector_inactive',
      );
    }
    if (
      channelId &&
      !(await this.prisma.channel.findFirst({
        where: { id: channelId, isActive: true },
      }))
    ) {
      throw new ValidationError(
        'Channel must be active',
        'channelId',
        'internal_number.channel_inactive',
      );
    }
  }

  private async assertPhoneAvailable(phone: string, excludedId?: string) {
    const existing = await this.prisma.sectorNumber.findFirst({
      where: {
        phone,
        ...(excludedId ? { NOT: { id: excludedId } } : {}),
      },
      select: { id: true },
    });
    if (existing) {
      throw new ConflictError(
        'Phone already registered',
        'internal_number.phone_taken',
      );
    }
  }

  private throwPhoneConflict(error: unknown): void {
    if (isPhoneUniqueViolation(error)) {
      throw new ConflictError(
        'Phone already registered',
        'internal_number.phone_taken',
      );
    }
  }
}

function isPhoneUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('code' in error)) return false;
  const meta = 'meta' in error ? error.meta : undefined;
  return (
    error.code === 'P2002' &&
    !!meta &&
    typeof meta === 'object' &&
    'target' in meta &&
    Array.isArray(meta.target) &&
    meta.target.includes('phone')
  );
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
