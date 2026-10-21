import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../shared/prisma/prisma.service';
import type { ShiftRef } from '../../schemas/contracts/shift.schema';
import type {
  CreateExceptionInput,
  PutScheduleInput,
  StaffException,
  StaffSchedule,
  StaffSectorRef,
} from '../../schemas/contracts/staff-schedule.schema';
import { findTeamActor } from '../team-whatsapp/team-actor.query';
import type { TeamActor } from '../team-whatsapp/team-whatsapp.policy';
import { fromDbDate, toDbDate, type CivilDate } from './civil-date';
import { planOverlap, type OverlapPlan } from './exception-overlap';
import type { ScheduleCycle } from './schedule-resolver';

/** Pessoa do quadro; sem telefone (GC10). */
const boardPersonSelect = {
  id: true,
  name: true,
  email: true,
  jobTitle: true,
  sectorId: true,
  shiftId: true,
} satisfies Prisma.UserSelect;
export type BoardPersonRow = Prisma.UserGetPayload<{
  select: typeof boardPersonSelect;
}>;

const shiftRefSelect = {
  id: true,
  name: true,
  startTime: true,
  endTime: true,
} satisfies Prisma.ShiftSelect;

const exceptionSelect = {
  id: true,
  userId: true,
  kind: true,
  startDate: true,
  endDate: true,
  shiftId: true,
  sectorId: true,
  note: true,
} satisfies Prisma.StaffScheduleExceptionSelect;
type ExceptionRow = Prisma.StaffScheduleExceptionGetPayload<{
  select: typeof exceptionSelect;
}>;

const scheduleSelect = {
  userId: true,
  template: true,
  startDate: true,
  cycleLength: true,
  days: {
    orderBy: { dayIndex: 'asc' },
    select: { shiftId: true },
  },
} satisfies Prisma.StaffScheduleSelect;
type ScheduleRow = Prisma.StaffScheduleGetPayload<{
  select: typeof scheduleSelect;
}>;

/**
 * Escala carregada de uma pessoa. `cycle` é o mesmo ciclo de `schedule` no
 * formato do resolvedor; `exceptions` (StaffException ⊇ ScheduleExceptionInput)
 * são as que cruzam o período pedido, por startDate.
 */
export type ScheduleData = {
  cycle: ScheduleCycle | null;
  schedule: StaffSchedule | null;
  exceptions: StaffException[];
};

/** Cruza o período inclusivo from..to (datas civis como @db.Date). */
function overlaps(from: CivilDate, to: CivilDate) {
  return { startDate: { lte: toDbDate(to) }, endDate: { gte: toDbDate(from) } };
}

function toSchedule(row: ScheduleRow): StaffSchedule {
  return {
    template: row.template,
    startDate: fromDbDate(row.startDate),
    cycleLength: row.cycleLength,
    days: row.days.map((d) => d.shiftId),
  };
}

function toException(row: ExceptionRow): StaffException {
  return {
    ...row,
    startDate: fromDbDate(row.startDate),
    endDate: fromDbDate(row.endDate),
  };
}

type Tx = Prisma.TransactionClient;

/** Serializa as edições da escala da mesma pessoa (D4). */
async function lockUser(tx: Tx, userId: string): Promise<void> {
  await tx.$queryRaw(
    Prisma.sql`SELECT "id" FROM "User" WHERE "id" = ${userId} FOR UPDATE`,
  );
}

/** Exceção anterior lida na transação, com o que a cauda de um split copia. */
type TrimmedRow = ExceptionRow & { createdById: string | null };

/** Encurta, apaga e divide as anteriores; a cauda copia tipo, turno, setor e nota. */
async function applyOverlap(
  tx: Tx,
  plan: OverlapPlan,
  rows: readonly TrimmedRow[],
): Promise<void> {
  if (plan.deleteIds.length > 0) {
    await tx.staffScheduleException.deleteMany({
      where: { id: { in: plan.deleteIds } },
    });
  }
  for (const { id, startDate, endDate } of plan.updates) {
    await tx.staffScheduleException.update({
      where: { id },
      data: { startDate: toDbDate(startDate), endDate: toDbDate(endDate) },
    });
  }
  for (const split of plan.splits) {
    const from = rows.find((row) => row.id === split.fromId);
    if (!from) continue;
    const { userId, kind, shiftId, sectorId, note, createdById } = from;
    await tx.staffScheduleException.create({
      data: {
        userId,
        kind,
        shiftId,
        sectorId,
        note,
        createdById,
        startDate: toDbDate(split.startDate),
        endDate: toDbDate(split.endDate),
      },
    });
  }
}

@Injectable()
export class StaffScheduleRepository {
  constructor(private readonly prisma: PrismaService) {}

  findActor(id: string): Promise<TeamActor | null> {
    return findTeamActor(this.prisma, id);
  }

  /** Setores ativos; `onlyIds` null = todos (ADMIN). */
  listSectors(onlyIds: readonly string[] | null): Promise<StaffSectorRef[]> {
    return this.prisma.sector.findMany({
      where: {
        isActive: true,
        ...(onlyIds ? { id: { in: [...onlyIds] } } : {}),
      },
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
    });
  }

  /** Nomes de setores citados no quadro, ativos ou não. */
  findSectorsByIds(ids: readonly string[]): Promise<StaffSectorRef[]> {
    return this.prisma.sector.findMany({
      where: { id: { in: [...ids] } },
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
    });
  }

  listActiveShifts(): Promise<ShiftRef[]> {
    return this.prisma.shift.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      select: shiftRefSelect,
    });
  }

  /** Turnos citados no quadro, ativos ou não (o front marca o inativo). */
  findShiftsByIds(
    ids: readonly string[],
  ): Promise<(ShiftRef & { isActive: boolean })[]> {
    return this.prisma.shift.findMany({
      where: { id: { in: [...ids] } },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      select: { ...shiftRefSelect, isActive: true },
    });
  }

  /** Ativos cujo setor principal é `sectorId`. */
  listSectorPeople(sectorId: string): Promise<BoardPersonRow[]> {
    return this.prisma.user.findMany({
      where: { sectorId, isActive: true },
      select: boardPersonSelect,
    });
  }

  /** Ativos entre `ids` (os visitantes de listVisitorIds). */
  listPeopleByIds(ids: readonly string[]): Promise<BoardPersonRow[]> {
    return this.prisma.user.findMany({
      where: { id: { in: [...ids] }, isActive: true },
      select: boardPersonSelect,
    });
  }

  /** Ativos de fora do setor (ou sem setor) com OTHER_SECTOR para ele no período. */
  async listVisitorIds(
    sectorId: string,
    from: CivilDate,
    to: CivilDate,
  ): Promise<string[]> {
    const users = await this.prisma.user.findMany({
      where: {
        isActive: true,
        OR: [{ sectorId: null }, { sectorId: { not: sectorId } }],
        staffExceptions: {
          some: { kind: 'OTHER_SECTOR', sectorId, ...overlaps(from, to) },
        },
      },
      select: { id: true },
    });
    return users.map((u) => u.id);
  }

  /** Toda id pedida tem entrada; sem escala nem exceção = vazia. */
  async loadScheduleData(
    userIds: readonly string[],
    from: CivilDate,
    to: CivilDate,
  ): Promise<Map<string, ScheduleData>> {
    const ids = [...userIds];
    const [schedules, exceptions] = await Promise.all([
      this.prisma.staffSchedule.findMany({
        where: { userId: { in: ids } },
        select: scheduleSelect,
      }),
      this.prisma.staffScheduleException.findMany({
        where: { userId: { in: ids }, ...overlaps(from, to) },
        orderBy: [{ startDate: 'asc' }, { id: 'asc' }],
        select: exceptionSelect,
      }),
    ]);
    const data = new Map<string, ScheduleData>(
      ids.map((id) => [id, { cycle: null, schedule: null, exceptions: [] }]),
    );
    for (const row of schedules) {
      const entry = data.get(row.userId);
      if (!entry) continue;
      const schedule = toSchedule(row);
      const { startDate, cycleLength, days } = schedule;
      entry.schedule = schedule;
      entry.cycle = { startDate, cycleLength, days };
    }
    for (const row of exceptions) {
      data.get(row.userId)?.exceptions.push(toException(row));
    }
    return data;
  }

  findPerson(
    userId: string,
  ): Promise<{ id: string; sectorId: string | null } | null> {
    return this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, sectorId: true },
    });
  }

  /** Ids ativos entre `ids` (os ausentes são inexistentes ou inativos). */
  async findShiftsActive(ids: readonly string[]): Promise<string[]> {
    const rows = await this.prisma.shift.findMany({
      where: { id: { in: [...ids] }, isActive: true },
      select: { id: true },
    });
    return rows.map((row) => row.id);
  }

  findSector(id: string): Promise<{ id: string; isActive: boolean } | null> {
    return this.prisma.sector.findUnique({
      where: { id },
      select: { id: true, isActive: true },
    });
  }

  /** Grava o ciclo como recebido (D5): upsert e recria todos os dias, numa transação. */
  replaceSchedule(
    userId: string,
    data: PutScheduleInput,
    actorId: string,
  ): Promise<StaffSchedule> {
    const fields = {
      template: data.template,
      startDate: toDbDate(data.startDate),
      cycleLength: data.cycleLength,
      updatedById: actorId,
    };
    return this.prisma.$transaction(async (tx) => {
      await lockUser(tx, userId);
      const { id } = await tx.staffSchedule.upsert({
        where: { userId },
        create: { userId, ...fields },
        update: fields,
        select: { id: true },
      });
      await tx.staffScheduleDay.deleteMany({ where: { scheduleId: id } });
      await tx.staffScheduleDay.createMany({
        data: data.days.map((shiftId, dayIndex) => ({
          scheduleId: id,
          dayIndex,
          shiftId,
        })),
      });
      const row = await tx.staffSchedule.findUniqueOrThrow({
        where: { id },
        select: scheduleSelect,
      });
      return toSchedule(row);
    });
  }

  /** Idempotente; os dias saem em cascata. */
  async deleteSchedule(userId: string): Promise<void> {
    await this.prisma.staffSchedule.deleteMany({ where: { userId } });
  }

  /**
   * Cria a exceção sem sobreposição (D4), numa transação: trava o User, lê as
   * anteriores que cruzam o período, recorta/apaga/divide e cria a nova.
   * `adjusted` = anteriores recortadas ou substituídas.
   */
  createExceptionTrimming(
    userId: string,
    data: CreateExceptionInput,
    actorId: string,
  ): Promise<{ exception: StaffException; adjusted: number }> {
    return this.prisma.$transaction(async (tx) => {
      await lockUser(tx, userId);
      const rows = await tx.staffScheduleException.findMany({
        where: { userId, ...overlaps(data.startDate, data.endDate) },
        select: { ...exceptionSelect, createdById: true },
      });
      const plan = planOverlap(rows.map(toException), data);
      await applyOverlap(tx, plan, rows);
      const created = await tx.staffScheduleException.create({
        data: {
          userId,
          kind: data.kind,
          startDate: toDbDate(data.startDate),
          endDate: toDbDate(data.endDate),
          shiftId: data.shiftId ?? null,
          sectorId: data.sectorId ?? null,
          note: data.note || null,
          createdById: actorId,
        },
        select: exceptionSelect,
      });
      const adjusted = plan.deleteIds.length + plan.updates.length;
      return { exception: toException(created), adjusted };
    });
  }

  findException(
    id: string,
  ): Promise<{ id: string; userId: string; sectorId: string | null } | null> {
    return this.prisma.staffScheduleException.findUnique({
      where: { id },
      select: { id: true, userId: true, sectorId: true },
    });
  }

  /** Remove a exceção inteira; trava a dona como na criação. Idempotente. */
  async deleteException(id: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const row = await tx.staffScheduleException.findUnique({
        where: { id },
        select: { userId: true },
      });
      if (!row) return;
      await lockUser(tx, row.userId);
      await tx.staffScheduleException.deleteMany({ where: { id } });
    });
  }
}
