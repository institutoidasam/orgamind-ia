import { Injectable } from '@nestjs/common';
import type { AuditCategory, Prisma } from '@prisma/client';
import { escapeLike } from '../../shared/prisma/escape-like';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { findTeamActor } from '../team-whatsapp/team-actor.query';
import type { TeamActor } from '../team-whatsapp/team-whatsapp.policy';

/**
 * Linha da trilha como a consulta a lê. Sem `metadata`, ip e user-agent: o
 * `select` nunca os traz, então nada deles chega à resposta.
 */
export type AuditTrailRow = {
  id: string;
  createdAt: Date;
  action: string;
  category: AuditCategory | null;
  actorId: string | null;
  subjectUserId: string | null;
  reason: string | null;
  changes: Prisma.JsonValue | null;
};

export type AuditTrailPerson = {
  id: string;
  name: string | null;
  registration: string | null;
};

const ROW_SELECT = {
  id: true,
  createdAt: true,
  action: true,
  category: true,
  actorId: true,
  subjectUserId: true,
  reason: true,
  changes: true,
} satisfies Prisma.AuditEventSelect;

/** Leitura da trilha (só leitura, C7). */
@Injectable()
export class AuditTrailRepository {
  constructor(private readonly prisma: PrismaService) {}

  findActor(id: string): Promise<TeamActor | null> {
    return findTeamActor(this.prisma, id);
  }

  findPerson(
    id: string,
  ): Promise<{ id: string; sectorId: string | null } | null> {
    return this.prisma.user.findUnique({
      where: { id },
      select: { id: true, sectorId: true },
    });
  }

  /** Mais recentes primeiro; `id` desempata para a paginação não repetir linha. */
  async findPage(
    where: Prisma.AuditEventWhereInput,
    page: number,
    pageSize: number,
  ): Promise<{ rows: AuditTrailRow[]; total: number }> {
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.auditEvent.findMany({
        where,
        select: ROW_SELECT,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.auditEvent.count({ where }),
    ]);
    return { rows, total };
  }

  async findPeopleByIds(ids: readonly string[]): Promise<AuditTrailPerson[]> {
    if (ids.length === 0) return [];
    return this.prisma.user.findMany({
      where: { id: { in: [...ids] } },
      select: { id: true, name: true, registration: true },
    });
  }

  /** Nome (sem caixa) ou matrícula (`registrationKey` é minúscula, D1). */
  async findSubjectIdsByQuery(q: string, take: number): Promise<string[]> {
    const text = escapeLike(q);
    const users = await this.prisma.user.findMany({
      where: {
        OR: [
          { name: { contains: text, mode: 'insensitive' } },
          { registrationKey: { contains: text.toLowerCase() } },
        ],
      },
      select: { id: true },
      orderBy: { id: 'asc' },
      take,
    });
    return users.map((user) => user.id);
  }
}
