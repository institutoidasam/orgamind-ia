import type {
  BoardDay,
  BoardRow,
  StaffException,
} from '../../schemas/contracts/staff-schedule.schema';
import { hasPermission } from '../../shared/authz/permissions';
import { nameView } from '../../shared/authz/phone-visibility';
import type { TeamActor } from '../team-whatsapp/team-whatsapp.policy';
import {
  assignmentOn,
  type AssignmentLine,
  type AssignmentValues,
} from '../users/assignment-timeline';
import type { CivilDate } from './civil-date';
import {
  exceptionOn,
  resolveDay,
  type RosterPerson,
} from './schedule-resolver';
import type { BoardPersonRow, ScheduleData } from './staff-schedule.repository';
import { canEditPerson } from './staff-schedule.policy';

/**
 * Pessoa do quadro com a escala e as linhas de vínculo do trecho passado do
 * período (vazio quando o período inteiro é hoje ou futuro).
 */
export type BoardPersonInput = BoardPersonRow &
  ScheduleData & { assignments: readonly AssignmentLine[] };

const byName = new Intl.Collator('pt-BR');

/**
 * Setor e turno da pessoa na data (DV9): hoje e futuro pelo espelho do cadastro,
 * passado pela linha que cobre a data. A escala não usa o nível.
 */
function assignmentOfDay(
  person: BoardPersonInput,
  date: CivilDate,
  today: CivilDate,
): AssignmentValues {
  return assignmentOn({
    mirror: {
      sectorId: person.sectorId,
      shiftId: person.shiftId,
      levelId: null,
    },
    lines: person.assignments,
    date,
    today,
  });
}

function boardDays(
  person: BoardPersonInput,
  dates: readonly CivilDate[],
  today: CivilDate,
): BoardDay[] {
  return dates.map((date) => {
    const day = assignmentOfDay(person, date, today);
    const roster: RosterPerson = {
      id: person.id,
      sectorId: day.sectorId,
      profileShiftId: day.shiftId,
      cycle: person.cycle,
      exceptions: person.exceptions,
    };
    return {
      date,
      situation: resolveDay(roster, date),
      exceptionId: exceptionOn(person.exceptions, date)?.id ?? null,
    };
  });
}

function wasInSector(
  person: BoardPersonInput,
  input: { sectorId: string; dates: readonly CivilDate[]; today: CivilDate },
): boolean {
  return input.dates.some(
    (date) =>
      assignmentOfDay(person, date, input.today).sectorId === input.sectorId,
  );
}

/**
 * Quem entra no quadro de `sectorId` (DV10): quem tinha o vínculo no setor em
 * algum dia do período (membro) e, senão, quem veio de fora por exceção
 * "Outro setor" (visitante: a consulta de visitantes, `visitorIds`, ou a
 * exceção já carregada). Quem só chegou depois, ou nunca esteve nem visitou,
 * fica de fora, junto com as exceções dele.
 */
export function selectBoardPeople(input: {
  sectorId: string;
  dates: readonly CivilDate[];
  today: CivilDate;
  people: readonly BoardPersonInput[];
  visitorIds: ReadonlySet<string>;
}): BoardPersonInput[] {
  const visits = (person: BoardPersonInput): boolean =>
    input.visitorIds.has(person.id) ||
    person.exceptions.some(
      (ex) => ex.kind === 'OTHER_SECTOR' && ex.sectorId === input.sectorId,
    );
  return input.people.filter(
    (person) => wasInSector(person, input) || visits(person),
  );
}

/**
 * Linhas do quadro: primeiro o setor principal, depois quem vem de fora
 * (`fromOtherSector`: não teve o vínculo no setor em dia algum do período),
 * cada grupo por nome (pt-BR). Cada dia sai com o setor e o turno do vínculo
 * daquele dia (DV9); `canEdit` e `profileShiftId` seguem o cadastro ATUAL (o
 * setor PRINCIPAL da pessoa), então o gestor do destino não edita o visitante, e
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
  today: CivilDate;
}): BoardRow[] {
  const full = hasPermission(input.actor, 'telefone.ver_completo');
  const rows = input.people.map((person): BoardRow => ({
    userId: person.id,
    name: nameView(person.name ?? person.email ?? '', { full }),
    jobTitle: person.jobTitle,
    fromOtherSector: !wasInSector(person, input),
    canEdit:
      canEditPerson(input.actor, person) &&
      hasPermission(input.actor, 'escala.alterar'),
    profileShiftId: person.shiftId,
    schedule: person.schedule,
    days: boardDays(person, input.dates, input.today),
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
