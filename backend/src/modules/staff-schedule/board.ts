import type {
  BoardDay,
  BoardRow,
  StaffException,
} from '../../schemas/contracts/staff-schedule.schema';
import type { TeamActor } from '../team-whatsapp/team-whatsapp.policy';
import type { CivilDate } from './civil-date';
import {
  exceptionOn,
  resolveDay,
  type RosterPerson,
} from './schedule-resolver';
import type { BoardPersonRow, ScheduleData } from './staff-schedule.repository';
import { canEditPerson } from './staff-schedule.policy';

/** Pessoa do quadro com a escala já carregada para o período. */
export type BoardPersonInput = BoardPersonRow & ScheduleData;

const byName = new Intl.Collator('pt-BR');

function boardDays(
  person: BoardPersonInput,
  dates: readonly CivilDate[],
): BoardDay[] {
  const roster: RosterPerson = {
    id: person.id,
    sectorId: person.sectorId,
    profileShiftId: person.shiftId,
    cycle: person.cycle,
    exceptions: person.exceptions,
  };
  return dates.map((date) => ({
    date,
    situation: resolveDay(roster, date),
    exceptionId: exceptionOn(person.exceptions, date)?.id ?? null,
  }));
}

/**
 * Linhas do quadro: primeiro o setor principal, depois quem vem de fora
 * (`fromOtherSector`), cada grupo por nome (pt-BR). `canEdit` segue o setor
 * PRINCIPAL da pessoa, então o gestor do destino não edita o visitante.
 */
export function buildBoardRows(input: {
  actor: TeamActor;
  sectorId: string;
  dates: readonly CivilDate[];
  people: readonly BoardPersonInput[];
}): BoardRow[] {
  const rows = input.people.map((person): BoardRow => ({
    userId: person.id,
    name: person.name ?? person.email,
    jobTitle: person.jobTitle,
    fromOtherSector: person.sectorId !== input.sectorId,
    canEdit: canEditPerson(input.actor, person),
    profileShiftId: person.shiftId,
    schedule: person.schedule,
    days: boardDays(person, input.dates),
  }));
  return rows.sort(
    (a, b) =>
      Number(a.fromOtherSector) - Number(b.fromOtherSector) ||
      byName.compare(a.name, b.name),
  );
}

/** Setores e turnos citados nas linhas e nas exceções (para os nomes no front). */
export function citedRefs(
  rows: readonly BoardRow[],
  exceptions: readonly StaffException[],
): { sectorIds: string[]; shiftIds: string[] } {
  const sectorIds = new Set<string>();
  const shiftIds = new Set<string>();
  const add = (set: Set<string>, id: string | null): void => {
    if (id) set.add(id);
  };
  for (const row of rows) {
    add(shiftIds, row.profileShiftId);
    row.schedule?.days.forEach((id) => add(shiftIds, id));
    for (const { situation } of row.days) {
      if (situation.kind !== 'WORK') continue;
      add(sectorIds, situation.sectorId);
      add(shiftIds, situation.shiftId);
    }
  }
  for (const ex of exceptions) {
    add(sectorIds, ex.sectorId);
    add(shiftIds, ex.shiftId);
  }
  return { sectorIds: [...sectorIds], shiftIds: [...shiftIds] };
}
