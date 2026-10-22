import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type {
  CreateLevelInput,
  LevelAdmin,
  LevelListResponse,
  UpdateLevelInput,
} from '../../schemas/contracts/level.schema';
import {
  invalidLevelOrder,
  levelNameTaken,
  levelNotFound,
} from './levels.errors';
import { AuditService } from '../../shared/audit/audit.service';
import { type LevelUpdateData, LevelsRepository } from './levels.repository';

// Só os campos enviados.
function updateData(input: UpdateLevelInput): LevelUpdateData {
  const data: LevelUpdateData = {};
  if (input.name !== undefined) data.name = input.name.trim();
  if (input.isActive !== undefined) data.isActive = input.isActive;
  return data;
}

// A ordem recebida é uma permutação de todos os níveis: sem repetido, sem faltando, sem estranho.
function isPermutation(
  ids: readonly string[],
  all: readonly string[],
): boolean {
  const known = new Set(all);
  return (
    new Set(ids).size === ids.length &&
    ids.length === known.size &&
    ids.every((id) => known.has(id))
  );
}

// Corrida entre a checagem de nome e a gravação: o @unique do banco responde.
function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}

function mapNameTaken(error: unknown): never {
  throw isUniqueViolation(error) ? levelNameTaken() : error;
}

/**
 * Níveis (só ADMIN). Nível não se apaga e desativar não é bloqueado por uso:
 * a pessoa e o histórico ficam com ele; só some do cadastro novo e do filtro.
 */
@Injectable()
export class LevelsService {
  constructor(
    private readonly repo: LevelsRepository,
    private readonly audit: AuditService,
  ) {}

  async list(): Promise<LevelListResponse> {
    return { items: await this.repo.list() };
  }

  async create(actorId: string, input: CreateLevelInput): Promise<LevelAdmin> {
    const name = input.name.trim();
    await this.assertNameFree(name);
    const sortOrder = (await this.repo.maxSortOrder()) + 1;
    const row = await this.repo.create({ name, sortOrder }).catch(mapNameTaken);
    await this.audit.log('level.create', 'StaffLevel', row.id, {
      actorId,
      levelId: row.id,
    });
    return row;
  }

  async update(
    actorId: string,
    id: string,
    input: UpdateLevelInput,
  ): Promise<LevelAdmin> {
    if (!(await this.repo.findById(id))) throw levelNotFound();
    const data = updateData(input);
    if (data.name !== undefined) await this.assertNameFree(data.name, id);
    const row = await this.repo.update(id, data).catch(mapNameTaken);
    await this.audit.log('level.update', 'StaffLevel', id, {
      actorId,
      levelId: id,
    });
    return row;
  }

  async reorder(
    actorId: string,
    ids: readonly string[],
  ): Promise<LevelListResponse> {
    const allIds = (await this.repo.list()).map((row) => row.id);
    if (!isPermutation(ids, allIds)) throw invalidLevelOrder();
    await this.repo.setOrder(ids);
    await this.audit.log('level.reorder', 'StaffLevel', undefined, {
      actorId,
    });
    return this.list();
  }

  private async assertNameFree(name: string, exceptId?: string): Promise<void> {
    if (await this.repo.findByNameInsensitive(name, exceptId))
      throw levelNameTaken();
  }
}
