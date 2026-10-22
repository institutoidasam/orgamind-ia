import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { ShiftUsage } from '../../schemas/contracts/shift.schema';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { type CivilDate, toDbDate } from '../staff-schedule/civil-date';

const shiftSelect = {
  id: true,
  name: true,
  startTime: true,
  endTime: true,
  isActive: true,
  sortOrder: true,
} satisfies Prisma.ShiftSelect;

export type ShiftRow = Prisma.ShiftGetPayload<{ select: typeof shiftSelect }>;
export type ShiftCreateData = Pick<
  ShiftRow,
  'name' | 'startTime' | 'endTime' | 'sortOrder'
>;
export type ShiftUpdateData = Partial<
  Pick<ShiftRow, 'name' | 'startTime' | 'endTime' | 'isActive'>
>;

// Ordem dos motivos em `inUse` (C1).
const COUNTED_KINDS = [
  'users',
  'schedules',
  'exceptions',
  'scheduled',
] as const;
type CountedKind = (typeof COUNTED_KINDS)[number];

function nameKey(name: string): string {
  return name.trim().toLocaleLowerCase('pt-BR');
}

function countByShift(
  entries: readonly (readonly [string | null, number])[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const [shiftId, count] of entries) {
    if (shiftId) counts.set(shiftId, (counts.get(shiftId) ?? 0) + count);
  }
  return counts;
}

@Injectable()
export class ShiftsRepository {
  constructor(private readonly prisma: PrismaService) {}

  listAll(): Promise<ShiftRow[]> {
    return this.prisma.shift.findMany({
      select: shiftSelect,
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
  }

  findById(id: string): Promise<ShiftRow | null> {
    return this.prisma.shift.findUnique({ where: { id }, select: shiftSelect });
  }

  /**
   * Comparação sem caixa feita aqui, não no banco: `mode: 'insensitive'` vira
   * ILIKE ('_' e '%' seriam curinga) e o `lower()` do Postgres depende do locale
   * para acentos. A tabela de turnos é pequena (a ordem aceita até 100).
   */
  async findByNameInsensitive(
    name: string,
    exceptId?: string,
  ): Promise<ShiftRow | null> {
    const key = nameKey(name);
    const rows = await this.prisma.shift.findMany({
      select: shiftSelect,
      where: exceptId ? { id: { not: exceptId } } : undefined,
    });
    return rows.find((row) => nameKey(row.name) === key) ?? null;
  }

  /** Motivos de "em uso" por turno; só entram os com count > 0. */
  async usage(
    ids: readonly string[],
    today: CivilDate,
  ): Promise<Map<string, ShiftUsage[]>> {
    const where = { shiftId: { in: [...ids] } };
    const [users, days, exceptions, scheduled] = await Promise.all([
      this.prisma.user.groupBy({
        by: ['shiftId'],
        where,
        _count: { _all: true },
      }),
      // Um par (turno, escala) por linha: conta escalas, não dias.
      this.prisma.staffScheduleDay.groupBy({
        by: ['shiftId', 'scheduleId'],
        where,
      }),
      this.prisma.staffScheduleException.groupBy({
        by: ['shiftId'],
        where: { ...where, endDate: { gte: toDbDate(today) } },
        _count: { _all: true },
      }),
      // Só agendado pendente: cancelado ou já disparado não prende o turno.
      this.prisma.teamWhatsappDispatch.groupBy({
        by: ['shiftId'],
        where: { ...where, state: 'SCHEDULED' },
        _count: { _all: true },
      }),
    ]);
    const counts: Record<CountedKind, Map<string, number>> = {
      users: countByShift(users.map((r) => [r.shiftId, r._count._all])),
      schedules: countByShift(days.map((r) => [r.shiftId, 1])),
      exceptions: countByShift(
        exceptions.map((r) => [r.shiftId, r._count._all]),
      ),
      scheduled: countByShift(scheduled.map((r) => [r.shiftId, r._count._all])),
    };
    return new Map(
      ids.map((id) => [
        id,
        COUNTED_KINDS.flatMap((kind): ShiftUsage[] => {
          const count = counts[kind].get(id) ?? 0;
          return count > 0 ? [{ kind, count }] : [];
        }),
      ]),
    );
  }

  async maxSortOrder(): Promise<number> {
    const result = await this.prisma.shift.aggregate({
      _max: { sortOrder: true },
    });
    return result._max.sortOrder ?? 0;
  }

  create(data: ShiftCreateData): Promise<ShiftRow> {
    return this.prisma.shift.create({ data, select: shiftSelect });
  }

  update(id: string, data: ShiftUpdateData): Promise<ShiftRow> {
    return this.prisma.shift.update({
      where: { id },
      data,
      select: shiftSelect,
    });
  }

  /** sortOrder 1..n na ordem recebida, tudo ou nada. */
  async setOrder(ids: readonly string[]): Promise<void> {
    await this.prisma.$transaction(
      ids.map((id, index) =>
        this.prisma.shift.update({
          where: { id },
          data: { sortOrder: index + 1 },
          select: { id: true },
        }),
      ),
    );
  }
}
