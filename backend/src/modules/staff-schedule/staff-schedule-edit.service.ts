import { Injectable } from '@nestjs/common';
import type {
  CreateExceptionInput,
  CreateStaffExceptionResponse,
  PutScheduleInput,
  StaffSchedule,
} from '../../schemas/contracts/staff-schedule.schema';
import { AuditService } from '../../shared/audit/audit.service';
import type { TeamActor } from '../team-whatsapp/team-whatsapp.policy';
import {
  scheduleExceptionNotFound,
  scheduleForbidden,
  scheduleInvalidSector,
  scheduleInvalidShift,
  scheduleUserNotFound,
} from './staff-schedule.errors';
import {
  canAssignSector,
  canEditPerson,
  canViewSchedule,
} from './staff-schedule.policy';
import { StaffScheduleRepository } from './staff-schedule.repository';

/**
 * Edição da escala (C5) com a GC8 no servidor. Ordem das checagens em todas as
 * rotas: ator (403) → pessoa (404) → setor principal da pessoa (403) → turnos
 * (422) → destino de "Outro setor" (422 inexistente/inativo, 403 fora do
 * alcance). Nada é gravado antes de todas passarem. Auditoria só com ids e
 * contagem (GC10), nunca nome nem nota.
 */
@Injectable()
export class StaffScheduleEditService {
  constructor(
    private readonly repo: StaffScheduleRepository,
    private readonly audit: AuditService,
  ) {}

  async putSchedule(
    actorId: string,
    userId: string,
    input: PutScheduleInput,
  ): Promise<StaffSchedule> {
    await this.editablePerson(actorId, userId);
    await this.assertShifts(input.days);
    const schedule = await this.repo.replaceSchedule(userId, input, actorId);
    await this.audit.log('staff_schedule.put', 'StaffSchedule', userId, {
      actorId,
      userId,
    });
    return schedule;
  }

  /** Idempotente: a pessoa volta ao turno do cadastro. */
  async deleteSchedule(actorId: string, userId: string): Promise<void> {
    await this.editablePerson(actorId, userId);
    await this.repo.deleteSchedule(userId);
    await this.audit.log('staff_schedule.delete', 'StaffSchedule', userId, {
      actorId,
      userId,
    });
  }

  async createException(
    actorId: string,
    userId: string,
    input: CreateExceptionInput,
  ): Promise<CreateStaffExceptionResponse> {
    const actor = await this.editablePerson(actorId, userId);
    await this.assertShifts([input.shiftId ?? null]);
    if (input.sectorId) await this.assertDestination(actor, input.sectorId);
    const result = await this.repo.createExceptionTrimming(
      userId,
      input,
      actorId,
    );
    await this.audit.log(
      'staff_schedule.exception_create',
      'StaffScheduleException',
      result.exception.id,
      { actorId, userId, adjusted: result.adjusted },
    );
    return result;
  }

  /** Remove a exceção inteira; quem decide é o setor principal da dona. */
  async deleteException(actorId: string, exceptionId: string): Promise<void> {
    const actor = await this.editor(actorId);
    const exception = await this.repo.findException(exceptionId);
    if (!exception) throw scheduleExceptionNotFound();
    const { userId } = exception;
    await this.assertCanEdit(actor, userId);
    await this.repo.deleteException(exceptionId);
    await this.audit.log(
      'staff_schedule.exception_delete',
      'StaffScheduleException',
      exceptionId,
      { actorId, userId, exceptionId },
    );
  }

  private async editor(actorId: string): Promise<TeamActor> {
    const actor = await this.repo.findActor(actorId);
    if (!actor || !canViewSchedule(actor)) throw scheduleForbidden();
    return actor;
  }

  private async editablePerson(
    actorId: string,
    userId: string,
  ): Promise<TeamActor> {
    const actor = await this.editor(actorId);
    await this.assertCanEdit(actor, userId);
    return actor;
  }

  /** 404 se a pessoa não existe; 403 se o ator não gerencia o setor principal dela. */
  private async assertCanEdit(actor: TeamActor, userId: string): Promise<void> {
    const person = await this.repo.findPerson(userId);
    if (!person) throw scheduleUserNotFound();
    if (!canEditPerson(actor, person)) throw scheduleForbidden();
  }

  /** Cada turno citado (sem repetir; null = folga) existe e está ativo. */
  private async assertShifts(ids: readonly (string | null)[]): Promise<void> {
    const wanted = [...new Set(ids)].filter((id): id is string => id !== null);
    if (wanted.length === 0) return;
    const active = await this.repo.findShiftsActive(wanted);
    if (active.length !== wanted.length) throw scheduleInvalidShift();
  }

  private async assertDestination(
    actor: TeamActor,
    sectorId: string,
  ): Promise<void> {
    const sector = await this.repo.findSector(sectorId);
    if (!sector?.isActive) throw scheduleInvalidSector();
    if (!canAssignSector(actor, sector)) throw scheduleForbidden();
  }
}
