import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  type AuditTrailEntry,
  type AuditTrailPage,
  type AuditTrailQuery,
  fieldChangeSchema,
  type PersonHistoryQuery,
} from '../../schemas/contracts/audit-trail.schema';
import {
  canQueryAuditTrail,
  canViewPersonHistory,
  personHistoryCategories,
} from '../../shared/authz/person-actions.policy';
import { addDays, zonedStart } from '../staff-schedule/civil-date';
import { viewableSectorIds } from '../staff-schedule/staff-schedule.policy';
import type { TeamActor } from '../team-whatsapp/team-whatsapp.policy';
import {
  auditTrailForbidden,
  auditTrailPersonNotFound,
} from './audit-trail.errors';
import {
  type AuditTrailPerson,
  AuditTrailRepository,
  type AuditTrailRow,
} from './audit-trail.repository';

/** Teto de pessoas que `q` pode casar: `subjectUserId in (...)` não cresce sem limite. */
const MAX_SUBJECT_MATCHES = 500;

const changesSchema = fieldChangeSchema.array();

/**
 * Consulta da trilha (C7). Toda decisão de acesso vem de `person-actions.policy`
 * (GC5); aqui só se monta o filtro. Ator que não existe mais não vê nada.
 */
@Injectable()
export class AuditTrailService {
  constructor(private readonly repo: AuditTrailRepository) {}

  /** Consulta geral: só quem `canQueryAuditTrail`; só eventos categorizados (D8). */
  async list(actorId: string, query: AuditTrailQuery): Promise<AuditTrailPage> {
    const actor = await this.repo.findActor(actorId);
    if (!actor || !canQueryAuditTrail(actor)) throw auditTrailForbidden();
    const where: Prisma.AuditEventWhereInput = {
      category: query.category ?? { not: null },
    };
    const period = periodFilter(query.from, query.to);
    if (period) where.createdAt = period;
    if (query.q) {
      where.subjectUserId = {
        in: await this.repo.findSubjectIdsByQuery(query.q, MAX_SUBJECT_MATCHES),
      };
    }
    return this.page(where, query.page, query.pageSize);
  }

  /**
   * Histórico de uma pessoa (D18: só eventos categorizados). Fora do alcance e
   * inexistente dão o mesmo 403; só quem vê qualquer pessoa recebe 404.
   */
  async personHistory(
    actorId: string,
    userId: string,
    query: PersonHistoryQuery,
  ): Promise<AuditTrailPage> {
    const [actor, person] = await Promise.all([
      this.repo.findActor(actorId),
      this.repo.findPerson(userId),
    ]);
    if (!actor) throw auditTrailForbidden();
    if (!person) {
      throw canViewPersonHistory(actor, false)
        ? auditTrailPersonNotFound()
        : auditTrailForbidden();
    }
    if (!canViewPersonHistory(actor, inReach(actor, person.sectorId))) {
      throw auditTrailForbidden();
    }
    const categories = personHistoryCategories(actor);
    return this.page(
      {
        subjectUserId: person.id,
        category: categories ? { in: categories } : { not: null },
      },
      query.page,
      query.pageSize,
    );
  }

  private async page(
    where: Prisma.AuditEventWhereInput,
    page: number,
    pageSize: number,
  ): Promise<AuditTrailPage> {
    const { rows, total } = await this.repo.findPage(where, page, pageSize);
    const people = await this.repo.findPeopleByIds(personIds(rows));
    const byId = new Map(people.map((person) => [person.id, person]));
    return {
      items: rows.map((row) => toEntry(row, byId)),
      total,
      page,
      pageSize,
    };
  }
}

/** Alcance por setor (`null` = todos). Sem setor, só quem alcança todos vê. */
function inReach(actor: TeamActor, sectorId: string | null): boolean {
  const sectors = viewableSectorIds(actor);
  if (sectors === null) return true;
  return sectorId !== null && sectors.includes(sectorId);
}

/** Datas civis de Manaus, inclusivas nos dois extremos (fim exclusivo no dia seguinte). */
function periodFilter(
  from: string | undefined,
  to: string | undefined,
): Prisma.DateTimeFilter | null {
  if (!from && !to) return null;
  return {
    ...(from && { gte: zonedStart(from, '00:00') }),
    ...(to && { lt: zonedStart(addDays(to, 1), '00:00') }),
  };
}

function personIds(rows: readonly AuditTrailRow[]): string[] {
  const ids = new Set<string>();
  for (const row of rows) {
    if (row.actorId) ids.add(row.actorId);
    if (row.subjectUserId) ids.add(row.subjectUserId);
  }
  return [...ids];
}

type People = ReadonlyMap<string, AuditTrailPerson>;

function toActor(id: string | null, people: People): AuditTrailEntry['actor'] {
  return id ? { id, name: people.get(id)?.name ?? null } : null;
}

/** Pessoa apagada mantém o id, com nome e matrícula nulos. */
function toSubject(
  id: string | null,
  people: People,
): AuditTrailEntry['subject'] {
  if (!id) return null;
  const person = people.get(id);
  return {
    id,
    name: person?.name ?? null,
    registration: person?.registration ?? null,
  };
}

/** Registro antigo (sem `changes`) ou fora do formato sai com `null`. */
function toChanges(
  value: AuditTrailRow['changes'],
): AuditTrailEntry['changes'] {
  const parsed = changesSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function toEntry(row: AuditTrailRow, people: People): AuditTrailEntry {
  return {
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    action: row.action,
    category: row.category,
    actor: toActor(row.actorId, people),
    subject: toSubject(row.subjectUserId, people),
    reason: row.reason,
    changes: toChanges(row.changes),
  };
}
