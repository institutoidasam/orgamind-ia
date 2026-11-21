import { Injectable } from '@nestjs/common';
import { Prisma, Role } from '@prisma/client';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { findEffectivePermissions } from '../permissions/permissions.query';
import { SECTOR_CHANNEL_SELECT } from '../team-whatsapp/sector-channel';
import { sectorAuditSelect, type SectorAuditRow } from './sector-audit';
import { sectorUsage, type SectorUpdateGuard } from './sector-usage';
import type { CivilDate } from '../staff-schedule/civil-date';

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
  channel: { select: SECTOR_CHANNEL_SELECT },
  _count: { select: { members: true } },
} satisfies Prisma.SectorSelect;
export type SectorSummaryRecord = Prisma.SectorGetPayload<{
  select: typeof sectorSummarySelect;
}>;
type SectorCreateTrail = (
  tx: Prisma.TransactionClient,
  row: SectorAuditRow,
) => Promise<void>;
type SectorUpdateTrail = (
  tx: Prisma.TransactionClient,
  before: SectorAuditRow,
  after: SectorAuditRow,
) => Promise<void>;

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
      },
    });
  }
  /** Cria o setor e grava a trilha na mesma transação (GC1): falha de uma desfaz a outra. */
  createWithAudit(data: Prisma.SectorCreateInput, audit: SectorCreateTrail) {
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.sector.create({ data, select: sectorSummarySelect });
      await audit(tx, row);
      return row;
    });
  }
  /**
   * Edita o setor e grava a trilha (antes lido no tx) na mesma transação (GC1).
   * A linha é travada antes de ler o "antes": sem o lock, duas edições
   * concorrentes leem o mesmo "antes" e a trilha da segunda registraria, em
   * nome dela, a troca que a primeira fez. O `guard` (E2) roda no mesmo tx,
   * com a linha travada e depois do "antes": a conferência de uso decide a
   * gravação sob a trava; lançar desfaz tudo, sem trilha.
   */
  updateWithAudit(
    id: string,
    data: Prisma.SectorUpdateInput,
    audit: SectorUpdateTrail,
    guard?: SectorUpdateGuard,
  ) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Sector" WHERE id = ${id} FOR NO KEY UPDATE`;
      const before = await tx.sector.findUniqueOrThrow({
        where: { id },
        select: sectorAuditSelect,
      });
      await guard?.(tx, before);
      const row = await tx.sector.update({
        where: { id },
        data,
        select: sectorSummarySelect,
      });
      await audit(tx, before, row);
      return row;
    });
  }
  /** Uso do setor para a tela (E4), fora de transação; a gravação reconfere no tx. */
  usage(id: string, today: CivilDate) {
    return sectorUsage(this.prisma, id, today);
  }
  findMembers(sectorId: string, eligible?: boolean) {
    return this.prisma.user.findMany({
      where: {
        sectorId,
        isActive: true,
        // Elegível = quem age (GC5): sem `eligible`, a página do setor lista
        // todos os ativos, inclusive a pessoa sem acesso.
        ...(eligible
          ? {
              hasAccess: true,
              role: { in: [Role.ADMIN, Role.SUPERVISOR, Role.OPERATOR] },
            }
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
  /** Permissões efetivas do papel lidas agora, sem cache (GB3); fonte única em `findEffectivePermissions`. */
  effectivePermissions(role: Role) {
    return findEffectivePermissions(this.prisma, role);
  }
  findValidManager(id: string) {
    return this.prisma.user.findFirst({
      where: {
        id,
        isActive: true,
        hasAccess: true,
        role: { in: [Role.ADMIN, Role.SUPERVISOR, Role.OPERATOR] },
      },
      select: { id: true },
    });
  }
}
