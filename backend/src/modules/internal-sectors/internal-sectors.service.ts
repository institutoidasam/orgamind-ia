import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ConflictError, NotFoundError } from '../../shared/errors/domain.error';
import type {
  CreateSector,
  UpdateSector,
} from '../../schemas/contracts/sector.schema';
import { InternalSectorsRepository } from './internal-sectors.repository';
import type { SectorSummaryRecord } from './internal-sectors.repository';

function toSectorSummary(sector: SectorSummaryRecord) {
  return {
    id: sector.id,
    name: sector.name,
    code: sector.code,
    description: sector.description,
    isActive: sector.isActive,
    managerId: sector.managerId,
    manager: sector.manager,
    memberCount: sector._count.members,
    numberCount: sector._count.numbers,
    createdAt: sector.createdAt,
    updatedAt: sector.updatedAt,
  };
}

@Injectable()
export class InternalSectorsService {
  constructor(private readonly repo: InternalSectorsRepository) {}
  async list(page: number, pageSize: number, activeOnly?: boolean) {
    const [items, total] = await this.repo.list(page, pageSize, activeOnly);
    return { items: items.map(toSectorSummary), total, page, pageSize };
  }
  async get(id: string) {
    const sector = await this.repo.find(id);
    if (!sector) throw new NotFoundError('Sector', id);
    return {
      ...toSectorSummary(sector),
      members: sector.members,
      numbers: sector.numbers,
    };
  }
  async create(input: CreateSector) {
    await this.validateManager(input.managerId);
    return this.write(() => this.repo.create(this.createData(input))).then(
      toSectorSummary,
    );
  }
  async update(id: string, input: UpdateSector) {
    await this.get(id);
    await this.validateManager(input.managerId);
    return this.write(() => this.repo.update(id, this.updateData(input))).then(
      toSectorSummary,
    );
  }
  async members(sectorId: string, eligible?: boolean) {
    await this.get(sectorId);
    return this.repo
      .findMembers(sectorId, eligible)
      .then((items) => ({ items }));
  }
  private createData(input: CreateSector): Prisma.SectorCreateInput {
    return {
      name: input.name.trim(),
      code: input.code,
      description: input.description,
      isActive: input.isActive,
      ...(input.managerId
        ? { manager: { connect: { id: input.managerId } } }
        : {}),
    };
  }
  private updateData(input: UpdateSector): Prisma.SectorUpdateInput {
    return {
      ...(input.name !== undefined ? { name: input.name.trim() } : {}),
      ...(input.code !== undefined ? { code: input.code } : {}),
      ...(input.description !== undefined
        ? { description: input.description }
        : {}),
      ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      ...(input.managerId !== undefined
        ? {
            manager: input.managerId
              ? { connect: { id: input.managerId } }
              : { disconnect: true },
          }
        : {}),
    };
  }
  private async validateManager(managerId: string | null | undefined) {
    if (managerId && !(await this.repo.findValidManager(managerId)))
      throw new ConflictError(
        'Manager is inactive or invalid',
        'sector.manager_invalid',
      );
  }
  private async write<T>(fn: () => Promise<T>) {
    try {
      return await fn();
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      )
        throw new ConflictError(
          'Sector name or code already exists',
          'sector.conflict',
        );
      throw error;
    }
  }
}
