import { Injectable } from '@nestjs/common';
import type {
  BoardQuery,
  BoardRow,
  StaffException,
  StaffScheduleBoard,
  StaffScheduleOptions,
} from '../../schemas/contracts/staff-schedule.schema';
import type { TeamActor } from '../team-whatsapp/team-whatsapp.policy';
import { buildBoardRows, citedRefs, type BoardPersonInput } from './board';
import { addDays, diffDays, todayIn, type CivilDate } from './civil-date';
import { invalidPeriod, scheduleForbidden } from './staff-schedule.errors';
import { canViewSchedule, viewableSectorIds } from './staff-schedule.policy';
import {
  StaffScheduleRepository,
  type ScheduleData,
} from './staff-schedule.repository';

/** Semana ou mês do quadro, com folga: até 42 datas (6 semanas). */
const MAX_BOARD_DAYS = 42;
/** Pessoas por quadro (setor principal + visitantes); acima disso o quadro vem cortado (D13). */
export const BOARD_PEOPLE_LIMIT = 500;
const NO_SCHEDULE: ScheduleData = {
  cycle: null,
  schedule: null,
  exceptions: [],
};

/** Datas de from..to (inclusivo); 422 se from > to ou mais de 42 dias. */
function periodDates(from: CivilDate, to: CivilDate): CivilDate[] {
  const length = diffDays(to, from) + 1;
  if (length < 1 || length > MAX_BOARD_DAYS) throw invalidPeriod();
  return Array.from({ length }, (_, i) => addDays(from, i));
}

/**
 * Exceções do quadro; a nota só vai para quem edita a pessoa (ADMIN ou gestor
 * do setor principal): o gestor do destino vê o visitante sem a nota.
 */
function visibleExceptions(
  rows: readonly BoardRow[],
  people: readonly BoardPersonInput[],
): StaffException[] {
  const hidden = new Set(rows.filter((r) => !r.canEdit).map((r) => r.userId));
  return people
    .flatMap((person) => person.exceptions)
    .map((ex) => (hidden.has(ex.userId) ? { ...ex, note: null } : ex));
}

/**
 * Leitura da escala (C4) com a política GC8 aplicada no servidor: ator que
 * não é ADMIN nem gestor, ou setor fora do alcance (inclusive inativo), dá 403
 * antes de qualquer leitura de pessoas.
 */
@Injectable()
export class StaffScheduleService {
  constructor(private readonly repo: StaffScheduleRepository) {}

  async options(actorId: string): Promise<StaffScheduleOptions> {
    const actor = await this.viewer(actorId);
    const [sectors, shifts] = await Promise.all([
      this.repo.listSectors(viewableSectorIds(actor)),
      this.repo.listActiveShifts(),
    ]);
    return { today: todayIn(new Date()), sectors, shifts };
  }

  async board(actorId: string, query: BoardQuery): Promise<StaffScheduleBoard> {
    const actor = await this.viewer(actorId);
    await this.assertSectorInReach(actor, query.sectorId);
    const dates = periodDates(query.from, query.to);
    const { people, truncated } = await this.loadPeople(query);
    const rows = buildBoardRows({
      actor,
      sectorId: query.sectorId,
      dates,
      people,
    });
    const exceptions = visibleExceptions(rows, people);
    const refs = citedRefs(rows, exceptions);
    const [sectors, shifts] = await Promise.all([
      this.repo.findSectorsByIds(refs.sectorIds),
      this.repo.findShiftsByIds(refs.shiftIds),
    ]);
    return {
      sectorId: query.sectorId,
      from: query.from,
      to: query.to,
      today: todayIn(new Date()),
      sectors,
      shifts,
      rows,
      exceptions,
      truncated,
    };
  }

  private async viewer(actorId: string): Promise<TeamActor> {
    const actor = await this.repo.findActor(actorId);
    if (!actor || !canViewSchedule(actor)) throw scheduleForbidden();
    return actor;
  }

  /** ADMIN: setor ativo; gestor: setor ativo que gerencia. */
  private async assertSectorInReach(
    actor: TeamActor,
    sectorId: string,
  ): Promise<void> {
    const reach = viewableSectorIds(actor);
    if (reach !== null && !reach.includes(sectorId)) throw scheduleForbidden();
    const [sector] = await this.repo.listSectors([sectorId]);
    if (!sector) throw scheduleForbidden();
  }

  /**
   * Membros ativos do setor principal, depois visitantes do período, com a
   * escala; no máximo `BOARD_PEOPLE_LIMIT` (pede um a mais para saber se cortou).
   */
  private async loadPeople(
    query: BoardQuery,
  ): Promise<{ people: BoardPersonInput[]; truncated: boolean }> {
    const { sectorId, from, to } = query;
    const probe = BOARD_PEOPLE_LIMIT + 1;
    const [members, visitorIds] = await Promise.all([
      this.repo.listSectorPeople(sectorId, probe),
      this.repo.listVisitorIds(sectorId, from, to, probe),
    ]);
    const visitors =
      visitorIds.length > 0 ? await this.repo.listPeopleByIds(visitorIds) : [];
    const everyone = [...members, ...visitors];
    const people = everyone.slice(0, BOARD_PEOPLE_LIMIT);
    const data = await this.repo.loadScheduleData(
      people.map((person) => person.id),
      from,
      to,
    );
    return {
      truncated: everyone.length > BOARD_PEOPLE_LIMIT,
      people: people.map((person) => ({
        ...person,
        ...(data.get(person.id) ?? NO_SCHEDULE),
      })),
    };
  }
}
