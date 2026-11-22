import { Injectable } from '@nestjs/common';
import { Prisma, type Role } from '@prisma/client';
import { ConflictError, NotFoundError } from '../../shared/errors/domain.error';
import { AuditService } from '../../shared/audit/audit.service';
import type {
  CreateSector,
  UpdateSector,
} from '../../schemas/contracts/sector.schema';
import type { PolicyActor } from '../../shared/authz/person-actions.policy';
import { hasPermission } from '../../shared/authz/permissions';
import { todayIn } from '../staff-schedule/civil-date';
import { nameView } from '../../shared/authz/phone-visibility';
import { InternalSectorsRepository } from './internal-sectors.repository';
import type { SectorSummaryRecord } from './internal-sectors.repository';
import { sectorAuditChanges, type SectorAuditRow } from './sector-audit';
import { toSectorChannel } from './sector-channel-view';
import { inactivationGuard } from './sector-usage';
import {
  assertManagerChangeAllowed,
  canSetSectorManager,
} from './sector-manager.policy';

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
    channel: toSectorChannel(sector.channel),
    createdAt: sector.createdAt,
    updatedAt: sector.updatedAt,
  };
}

/** DB8/CB2: o nome da pessoa sem login pode ser o próprio telefone (D11); sem a chave, sai mascarado. */
function withNameView<T extends { name: string | null }>(
  items: T[],
  full: boolean,
) {
  return items.map((item) => ({
    ...item,
    name: nameView(item.name, { full }),
  }));
}

type SectorTrail = {
  action: 'sector.created' | 'sector.updated';
  actorId: string;
  before: SectorAuditRow | null;
  after: SectorAuditRow;
};

@Injectable()
export class InternalSectorsService {
  constructor(
    private readonly repo: InternalSectorsRepository,
    private readonly audit: AuditService,
  ) {}
  async list(page: number, pageSize: number, activeOnly?: boolean) {
    const [items, total] = await this.repo.list(page, pageSize, activeOnly);
    return { items: items.map(toSectorSummary), total, page, pageSize };
  }
  async get(id: string, role: Role) {
    const sector = await this.detail(id);
    const full = await this.canSeeFullPhone(role);
    return {
      ...toSectorSummary(sector),
      members: withNameView(sector.members, full),
      usage: await this.repo.usage(id, todayIn(new Date())),
    };
  }
  async create(input: CreateSector, actorId: string, actorRole: Role) {
    const actor = { id: actorId, role: actorRole };
    assertManagerChangeAllowed(actor, input.managerId, null);
    const data = this.managerOnlyForAdmin(actor, input);
    await this.validateManager(data.managerId);
    return this.write(() =>
      this.repo.createWithAudit(this.createData(data), (tx, row) =>
        this.trail(tx, {
          action: 'sector.created',
          actorId,
          before: null,
          after: row,
        }),
      ),
    ).then(toSectorSummary);
  }
  async update(
    id: string,
    input: UpdateSector,
    actorId: string,
    actorRole: Role,
  ) {
    const actor = { id: actorId, role: actorRole };
    const current = await this.detail(id);
    assertManagerChangeAllowed(actor, input.managerId, current.managerId);
    const data = this.managerOnlyForAdmin(actor, input);
    await this.validateManager(data.managerId);
    return this.write(() =>
      this.repo.updateWithAudit(
        id,
        this.updateData(data),
        (tx, before, after) =>
          this.trail(tx, {
            action: 'sector.updated',
            actorId,
            before,
            after,
          }),
        input.isActive === false
          ? inactivationGuard(id, todayIn(new Date()))
          : undefined,
      ),
    ).then(toSectorSummary);
  }
  /** Só a saída muda (nome mascarado sem a chave); a consulta e a ordem seguem iguais. */
  async members(sectorId: string, eligible: boolean | undefined, role: Role) {
    await this.detail(sectorId);
    const [items, full] = await Promise.all([
      this.repo.findMembers(sectorId, eligible),
      this.canSeeFullPhone(role),
    ]);
    return { items: withNameView(items, full) };
  }
  /** Setor com membros como estão no banco (nome real); só `get` e `members` aplicam a máscara. */
  private async detail(id: string) {
    const sector = await this.repo.find(id);
    if (!sector) throw new NotFoundError('Sector', id);
    return sector;
  }
  /** Chave `telefone.ver_completo` do papel, lida do banco agora (GB3). */
  private async canSeeFullPhone(role: Role) {
    const permissions = await this.repo.effectivePermissions(role);
    return hasPermission({ permissions }, 'telefone.ver_completo');
  }
  /**
   * DB20: quem não é ADMIN nunca grava o gestor. `assertManagerChangeAllowed` só
   * decide entre seguir e 403; aqui o campo sai do que vai ao repositório, seja
   * qual for o valor lido (reenviar o gestor atual segue, sem gravar `manager`).
   */
  private managerOnlyForAdmin<T extends { managerId?: string | null }>(
    actor: PolicyActor,
    input: T,
  ): T {
    return canSetSectorManager(actor)
      ? input
      : { ...input, managerId: undefined };
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
  /** Trilha dentro da transação do setor (GC1); sem campo auditado alterado, não grava evento vazio. */
  private async trail(
    tx: Prisma.TransactionClient,
    { action, actorId, before, after }: SectorTrail,
  ) {
    const changes = sectorAuditChanges(before, after);
    if (changes.length === 0) return;
    await this.audit.recordChange(tx, {
      action,
      entity: 'Sector',
      entityId: after.id,
      category: 'STRUCTURE',
      changes,
      actorId,
    });
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
