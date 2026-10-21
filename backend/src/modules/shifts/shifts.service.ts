import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type {
  CreateShiftInput,
  ReorderShiftsInput,
  ShiftAdmin,
  ShiftListResponse,
  ShiftUsage,
  UpdateShiftInput,
} from '../../schemas/contracts/shift.schema';
import { AuditService } from '../../shared/audit/audit.service';
import { todayIn } from '../staff-schedule/civil-date';
import {
  invalidShiftOrder,
  shiftInUse,
  shiftNameTaken,
  shiftNotFound,
} from './shifts.errors';
import {
  type ShiftRow,
  type ShiftUpdateData,
  ShiftsRepository,
} from './shifts.repository';

function toShiftAdmin(row: ShiftRow, usage: readonly ShiftUsage[]): ShiftAdmin {
  return {
    id: row.id,
    name: row.name,
    startTime: row.startTime,
    endTime: row.endTime,
    isActive: row.isActive,
    sortOrder: row.sortOrder,
    crossesMidnight: row.endTime <= row.startTime,
    inUse: usage.filter((u) => u.count > 0),
  };
}

// Só os campos enviados; mudar o horário não mexe em envio já agendado (spec §1).
function updateData(input: UpdateShiftInput): ShiftUpdateData {
  const data: ShiftUpdateData = {};
  if (input.name !== undefined) data.name = input.name.trim();
  if (input.startTime !== undefined) data.startTime = input.startTime;
  if (input.endTime !== undefined) data.endTime = input.endTime;
  if (input.isActive !== undefined) data.isActive = input.isActive;
  return data;
}

function isSameSet(ids: readonly string[], all: readonly string[]): boolean {
  const received = new Set(ids);
  return (
    received.size === ids.length &&
    received.size === all.length &&
    all.every((id) => received.has(id))
  );
}

// Corrida entre a checagem de nome e a gravação: o @unique do banco responde.
function rethrowNameTaken(error: unknown): never {
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  )
    throw shiftNameTaken();
  throw error;
}

/** Turnos (só ADMIN). Turno não se apaga: desativa, e só se não estiver em uso. */
@Injectable()
export class ShiftsService {
  constructor(
    private readonly repo: ShiftsRepository,
    private readonly audit: AuditService,
  ) {}

  async list(): Promise<ShiftListResponse> {
    const rows = await this.repo.listAll();
    const usage = await this.repo.usage(
      rows.map((row) => row.id),
      todayIn(new Date()),
    );
    return {
      items: rows.map((row) => toShiftAdmin(row, usage.get(row.id) ?? [])),
    };
  }

  async create(actorId: string, input: CreateShiftInput): Promise<ShiftAdmin> {
    const name = input.name.trim();
    await this.assertNameFree(name);
    const sortOrder = (await this.repo.maxSortOrder()) + 1;
    const row = await this.repo
      .create({
        name,
        startTime: input.startTime,
        endTime: input.endTime,
        sortOrder,
      })
      .catch(rethrowNameTaken);
    await this.audit.log('shift.create', 'Shift', row.id, {
      actorId,
      shiftId: row.id,
    });
    return toShiftAdmin(row, []);
  }

  async update(
    actorId: string,
    id: string,
    input: UpdateShiftInput,
  ): Promise<ShiftAdmin> {
    const current = await this.repo.findById(id);
    if (!current) throw shiftNotFound();
    const data = updateData(input);
    if (data.name !== undefined) await this.assertNameFree(data.name, id);
    const inUse = await this.usageOf(id);
    if (data.isActive === false && current.isActive && inUse.length > 0)
      throw shiftInUse(inUse.map((u) => u.kind));
    const row = await this.repo.update(id, data).catch(rethrowNameTaken);
    await this.audit.log('shift.update', 'Shift', id, { actorId, shiftId: id });
    return toShiftAdmin(row, inUse);
  }

  async reorder(
    actorId: string,
    input: ReorderShiftsInput,
  ): Promise<ShiftListResponse> {
    const allIds = (await this.repo.listAll()).map((row) => row.id);
    if (!isSameSet(input.ids, allIds)) throw invalidShiftOrder();
    await this.repo.setOrder(input.ids);
    await this.audit.log('shift.reorder', 'Shift', undefined, {
      actorId,
      shiftIds: input.ids,
    });
    return this.list();
  }

  private async assertNameFree(name: string, exceptId?: string): Promise<void> {
    if (await this.repo.findByNameInsensitive(name, exceptId))
      throw shiftNameTaken();
  }

  private async usageOf(id: string): Promise<ShiftUsage[]> {
    const usage = await this.repo.usage([id], todayIn(new Date()));
    return (usage.get(id) ?? []).filter((u) => u.count > 0);
  }
}
