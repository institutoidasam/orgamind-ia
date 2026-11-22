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
import type { AuditChange } from '../../shared/audit/audit-change';
import { orderChange } from '../../shared/audit/audit-order';
import { AuditService } from '../../shared/audit/audit.service';
import { levelAuditChanges, levelEvent } from './level-audit';
import { deactivationGuard } from './level-usage';
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
 * Níveis (só ADMIN). Nível não se apaga. Desativar com pessoa ativa é bloqueado
 * (`levels.in_use` 409, conferido na transação da gravação); só pessoa inativa
 * não bloqueia: ela e o histórico ficam com o nível, que só some do cadastro
 * novo e do filtro.
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
    return this.repo
      .createWithAudit({ name, sortOrder }, (tx, before, after) =>
        this.record(
          tx,
          levelEvent(
            'level.create',
            actorId,
            after.id,
            levelAuditChanges(before, after),
          ),
        ),
      )
      .catch(mapNameTaken);
  }

  async update(
    actorId: string,
    id: string,
    input: UpdateLevelInput,
  ): Promise<LevelAdmin> {
    if (!(await this.repo.findById(id))) throw levelNotFound();
    const data = updateData(input);
    if (data.name !== undefined) await this.assertNameFree(data.name, id);
    return this.repo
      .updateWithAudit(
        id,
        data,
        (tx, before, after) =>
          this.record(
            tx,
            levelEvent(
              'level.update',
              actorId,
              id,
              levelAuditChanges(before, after),
            ),
          ),
        data.isActive === false ? deactivationGuard(id) : undefined,
      )
      .catch(mapNameTaken);
  }

  async reorder(
    actorId: string,
    ids: readonly string[],
  ): Promise<LevelListResponse> {
    const allIds = (await this.repo.list()).map((row) => row.id);
    if (!isPermutation(ids, allIds)) throw invalidLevelOrder();
    await this.repo.reorderWithAudit(ids, (tx, before, after) =>
      this.record(
        tx,
        levelEvent('level.reorder', actorId, null, orderChange(before, after)),
      ),
    );
    return this.list();
  }

  /** Grava o evento no `tx` do nível; `null` (nada mudou) não grava. */
  private async record(
    tx: Prisma.TransactionClient,
    event: AuditChange | null,
  ): Promise<void> {
    if (event) await this.audit.recordChange(tx, event);
  }

  private async assertNameFree(name: string, exceptId?: string): Promise<void> {
    if (await this.repo.findByNameInsensitive(name, exceptId))
      throw levelNameTaken();
  }
}
