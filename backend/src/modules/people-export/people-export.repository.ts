import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../shared/prisma/prisma.service';
import {
  fromDbDate,
  toDbDate,
  type CivilDate,
} from '../staff-schedule/civil-date';
import type { AssignmentLine } from '../users/assignment-timeline';
import type {
  ExportNameMaps,
  PeopleCandidateRow,
  PeopleDetailRow,
} from './people-rows';

/**
 * Recorte do índice de pessoas (DX5). `createdBefore` é um instante EXCLUSIVO
 * (`createdAt < createdBefore`): quem chama passa o início do dia seguinte à data
 * de referência em America/Manaus, `zonedStart(addDays(date, 1), '00:00')`, o que
 * deixa dentro tudo o que foi cadastrado até o fim do dia da data. É a ÚNICA
 * barreira contra quem foi cadastrado depois dela (as funções puras não conhecem
 * `createdAt`). `mirror` nulo = data passada, sem filtro de vínculo no SQL (a
 * função pura filtra sobre o vínculo da data); com valor, setor/turno/alcance
 * saem pelo espelho atual. `sectorIds` nulo = todos, inclusive quem não tem
 * setor; lista vazia = ninguém.
 */
export type CandidateFilter = {
  status: 'active' | 'inactive' | 'all';
  createdBefore: Date;
  mirror: {
    sectorIds: readonly string[] | null;
    shiftId: string | null;
  } | null;
};

const CANDIDATE_SELECT = {
  id: true,
  name: true,
  hasAccess: true,
  sectorId: true,
  shiftId: true,
  levelId: true,
} satisfies Prisma.UserSelect;

// Sem e-mail: a exportação não o leva (a ficha da planilha não tem a coluna).
const DETAIL_SELECT = {
  id: true,
  registration: true,
  name: true,
  phoneE164: true,
  jobTitle: true,
  contactAuthorization: true,
  authorizationSource: true,
  authorizationNote: true,
  authorizationDate: true,
  isActive: true,
  hasAccess: true,
} satisfies Prisma.UserSelect;

type DetailRecord = Prisma.UserGetPayload<{ select: typeof DETAIL_SELECT }>;

function statusWhere(status: CandidateFilter['status']): Prisma.UserWhereInput {
  if (status === 'all') return {};
  return { isActive: status === 'active' };
}

function mirrorWhere(mirror: CandidateFilter['mirror']): Prisma.UserWhereInput {
  if (mirror === null) return {};
  const { sectorIds, shiftId } = mirror;
  return {
    ...(sectorIds === null ? {} : { sectorId: { in: [...sectorIds] } }),
    ...(shiftId === null ? {} : { shiftId }),
  };
}

// `authorizationDate` é `@db.Date`: o banco guarda só o dia, gravado por `toDbDate`
// (meia-noite UTC). A data civil volta por `fromDbDate`; converter para Manaus aqui
// deslocaria toda autorização para o dia anterior.
function toDetail(row: DetailRecord): PeopleDetailRow {
  return {
    ...row,
    authorizationDate: row.authorizationDate
      ? fromDbDate(row.authorizationDate)
      : null,
  };
}

function namesById(
  rows: readonly { id: string; name: string }[],
): ReadonlyMap<string, string> {
  return new Map(rows.map((row) => [row.id, row.name]));
}

/** Leitura da exportação de pessoas: nada aqui grava pessoa nem vínculo (GX9). */
@Injectable()
export class PeopleExportRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Página de candidatos por cursor de `id` (ordem crescente); `afterId` é exclusivo. */
  async pageCandidates(
    filter: CandidateFilter,
    take: number,
    afterId?: string,
  ): Promise<PeopleCandidateRow[]> {
    // Lista vazia de setores é "nenhum setor", nunca "sem filtro".
    if (filter.mirror?.sectorIds?.length === 0) return [];
    return this.prisma.user.findMany({
      where: {
        ...statusWhere(filter.status),
        ...mirrorWhere(filter.mirror),
        createdAt: { lt: filter.createdBefore },
        ...(afterId === undefined ? {} : { id: { gt: afterId } }),
      },
      select: CANDIDATE_SELECT,
      orderBy: { id: 'asc' },
      take,
    });
  }

  /**
   * Linhas de vínculo que cobrem `date` (início nulo ou ≤ data, fim nulo ou ≥ data,
   * fim inclusivo), por pessoa. Quem não tem linha cobrindo a data não aparece.
   */
  async linesOn(
    userIds: readonly string[],
    date: CivilDate,
  ): Promise<Map<string, AssignmentLine[]>> {
    const lines = new Map<string, AssignmentLine[]>();
    if (userIds.length === 0) return lines;
    const day = toDbDate(date);
    const rows = await this.prisma.userAssignment.findMany({
      where: {
        userId: { in: [...userIds] },
        AND: [
          { OR: [{ validFrom: null }, { validFrom: { lte: day } }] },
          { OR: [{ validTo: null }, { validTo: { gte: day } }] },
        ],
      },
      select: {
        userId: true,
        sectorId: true,
        shiftId: true,
        levelId: true,
        validFrom: true,
        validTo: true,
      },
      orderBy: { id: 'asc' },
    });
    for (const row of rows) {
      const line: AssignmentLine = {
        sectorId: row.sectorId,
        shiftId: row.shiftId,
        levelId: row.levelId,
        from: row.validFrom ? fromDbDate(row.validFrom) : null,
        to: row.validTo ? fromDbDate(row.validTo) : null,
      };
      lines.set(row.userId, [...(lines.get(row.userId) ?? []), line]);
    }
    return lines;
  }

  /** Campos das células dos ids pedidos, em ordem livre; id que não existe não volta. */
  async detailsByIds(ids: readonly string[]): Promise<PeopleDetailRow[]> {
    if (ids.length === 0) return [];
    const rows = await this.prisma.user.findMany({
      where: { id: { in: [...ids] } },
      select: DETAIL_SELECT,
    });
    return rows.map(toDetail);
  }

  /** Nome de cada setor, turno e nível, inclusive os inativos (vínculo antigo). */
  async nameMaps(): Promise<ExportNameMaps> {
    const select = { id: true, name: true } as const;
    const [sectors, shifts, levels] = await Promise.all([
      this.prisma.sector.findMany({ select }),
      this.prisma.shift.findMany({ select }),
      this.prisma.staffLevel.findMany({ select }),
    ]);
    return {
      sectors: namesById(sectors),
      shifts: namesById(shifts),
      levels: namesById(levels),
    };
  }
}
