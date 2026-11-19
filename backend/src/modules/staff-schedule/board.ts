import type {
  BoardDay,
  BoardRow,
  StaffException,
} from '../../schemas/contracts/staff-schedule.schema';
import { hasPermission } from '../../shared/authz/permissions';
import { nameView } from '../../shared/authz/phone-visibility';
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
 * PRINCIPAL da pessoa, então o gestor do destino não edita o visitante, e
 * exige a permissão `escala.alterar` do ator (DB7). Nome que é só telefone
 * (D11) sai mascarado sem `telefone.ver_completo`, e a ordem segue o nome
 * EXIBIDO (desempate por `userId`, nunca pelo nome real): ordenar pelo real
 * deixaria descobrir o número por tentativa.
 */
export function buildBoardRows(input: {
  actor: TeamActor;
  sectorId: string;
  dates: readonly CivilDate[];
  people: readonly BoardPersonInput[];
}): BoardRow[] {
  const full = hasPermission(input.actor, 'telefone.ver_completo');
  const rows = input.people.map((person): BoardRow => ({
    userId: person.id,
    name: nameView(person.name ?? person.email ?? '', { full }),
    jobTitle: person.jobTitle,
    fromOtherSector: person.sectorId !== input.sectorId,
    canEdit:
      canEditPerson(input.actor, person) &&
      hasPermission(input.actor, 'escala.alterar'),
    profileShiftId: person.shiftId,
    schedule: person.schedule,
    days: boardDays(person, input.dates),
  }));
  return rows.sort(
    (a, b) =>
      Number(a.fromOtherSector) - Number(b.fromOtherSector) ||
      byName.compare(a.name, b.name) ||
      byName.compare(a.userId, b.userId),
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
