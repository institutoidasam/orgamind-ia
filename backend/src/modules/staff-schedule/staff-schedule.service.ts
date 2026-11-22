import { Injectable } from '@nestjs/common';
import type {
  BoardQuery,
  StaffException,
  StaffScheduleBoard,
  StaffScheduleOptions,
} from '../../schemas/contracts/staff-schedule.schema';
import type { TeamActor } from '../team-whatsapp/team-whatsapp.policy';
import type { AssignmentLine } from '../users/assignment-timeline';
import {
  buildBoardRows,
  citedRefs,
  selectBoardPeople,
  type BoardPersonInput,
} from './board';
import { addDays, diffDays, todayIn, type CivilDate } from './civil-date';
import { invalidPeriod, scheduleForbidden } from './staff-schedule.errors';
import {
  canEditPerson,
  canViewSchedule,
  viewableSectorIds,
} from './staff-schedule.policy';
import {
  StaffScheduleRepository,
  type BoardPersonRow,
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
const NO_LINES: ReadonlyMap<string, AssignmentLine[]> = new Map();

/**
 * Fim do trecho PASSADO do período, `min(to, ontem)`; null quando `from` já é
 * hoje ou futuro (DV9: o quadro lê o cadastro e não consulta as linhas).
 */
function pastEnd(from: CivilDate, to: CivilDate, today: CivilDate) {
  if (from >= today) return null;
  const yesterday = addDays(today, -1);
  return to < yesterday ? to : yesterday;
}

/** Datas de from..to (inclusivo); 422 se from > to ou mais de 42 dias. */
function periodDates(from: CivilDate, to: CivilDate): CivilDate[] {
  const length = diffDays(to, from) + 1;
  if (length < 1 || length > MAX_BOARD_DAYS) throw invalidPeriod();
  return Array.from({ length }, (_, i) => addDays(from, i));
}

/**
 * Exceções do quadro; a nota só vai para quem tem alcance sobre a pessoa (ADMIN
 * ou gestor do setor principal): o gestor do destino vê o visitante sem a nota.
 * A chave `escala.alterar` não entra aqui: sem ela a pessoa perde a edição, não
 * a leitura que já tinha (DB7).
 */
function visibleExceptions(
  actor: TeamActor,
  people: readonly BoardPersonInput[],
): StaffException[] {
  const hidden = new Set(
    people.filter((p) => !canEditPerson(actor, p)).map((p) => p.id),
  );
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
    const today = todayIn(new Date());
    const actor = await this.viewer(actorId);
    await this.assertSectorInReach(actor, query.sectorId);
    const dates = periodDates(query.from, query.to);
    const loaded = await this.loadPeople(query, today);
    const { sectorId } = query;
    const { visitorIds } = loaded;
    const people = selectBoardPeople({
      sectorId,
      dates,
      today,
      people: loaded.people,
      visitorIds,
    });
    const rows = buildBoardRows({ actor, sectorId, dates, people, today });
    const exceptions = visibleExceptions(actor, people);
    const refs = citedRefs(rows, exceptions);
    const [sectors, shifts] = await Promise.all([
      this.repo.findSectorsByIds(refs.sectorIds),
      this.repo.findShiftsByIds(refs.shiftIds),
    ]);
    return {
      sectorId,
      from: query.from,
      to: query.to,
      today,
      sectors,
      shifts,
      rows,
      exceptions,
      truncated: loaded.truncated,
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
   * Candidatos ao quadro, sem repetir, na ordem membros do cadastro, vinculados
   * no passado e visitantes (a consulta de vínculo só roda se `from` < hoje);
   * pede um a mais por consulta para saber se cortou.
   */
  private async listCandidates(
    query: BoardQuery,
    past: CivilDate | null,
  ): Promise<{ everyone: BoardPersonRow[]; visitorIds: string[] }> {
    const { sectorId, from, to } = query;
    const probe = BOARD_PEOPLE_LIMIT + 1;
    const [members, visitorIds, assignedIds] = await Promise.all([
      this.repo.listSectorPeople(sectorId, probe),
      this.repo.listVisitorIds(sectorId, from, to, probe),
      past === null
        ? Promise.resolve<string[]>([])
        : this.repo.listAssignedUserIds(sectorId, from, past, probe),
    ]);
    const known = new Set(members.map((person) => person.id));
    const extraIds = [...new Set([...assignedIds, ...visitorIds])].filter(
      (id) => !known.has(id),
    );
    const extra =
      extraIds.length > 0 ? await this.repo.listPeopleByIds(extraIds) : [];
    return { everyone: [...members, ...extra], visitorIds };
  }

  /**
   * Membros ativos do setor principal, vinculados ao setor no trecho passado e
   * visitantes do período, com a escala e as linhas de vínculo; no máximo
   * `BOARD_PEOPLE_LIMIT` (o corte vale para a união). Quem entra de fato no
   * quadro sai de `selectBoardPeople`.
   */
  private async loadPeople(
    query: BoardQuery,
    today: CivilDate,
  ): Promise<{
    people: BoardPersonInput[];
    visitorIds: ReadonlySet<string>;
    truncated: boolean;
  }> {
    const { from, to } = query;
    const past = pastEnd(from, to, today);
    const { everyone, visitorIds } = await this.listCandidates(query, past);
    const people = everyone.slice(0, BOARD_PEOPLE_LIMIT);
    const ids = people.map((person) => person.id);
    const [data, lines] = await Promise.all([
      this.repo.loadScheduleData(ids, from, to),
      past === null
        ? Promise.resolve(NO_LINES)
        : this.repo.loadAssignmentLines(ids, from, past),
    ]);
    return {
      truncated: everyone.length > BOARD_PEOPLE_LIMIT,
      visitorIds: new Set(visitorIds),
      people: people.map((person) => ({
        ...person,
        ...(data.get(person.id) ?? NO_SCHEDULE),
        assignments: lines.get(person.id) ?? [],
      })),
    };
  }
}
