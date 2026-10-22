import type { StaffExceptionKind } from '@prisma/client';
import { diffDays, type CivilDate } from './civil-date';

/**
 * Resolvedor puro da situação de uma pessoa numa data civil (spec §2–§3):
 * exceção que cobre a data vence; senão o ciclo, se a data é >= início; senão o
 * turno do cadastro todos os dias, no setor principal; senão NONE. Turno que
 * atravessa a meia-noite pertence à data em que começa: a madrugada de 22/10 é
 * da entrada de 21/10, e é a data de 21/10 que se resolve.
 */

/** Ciclo da escala; `days[i]` = id do turno no dia i, null = folga. */
export type ScheduleCycle = {
  startDate: CivilDate;
  cycleLength: number;
  days: readonly (string | null)[];
};

/** Exceção por data; período inclusivo startDate..endDate. */
export type ScheduleExceptionInput = {
  id: string;
  kind: StaffExceptionKind;
  startDate: CivilDate;
  endDate: CivilDate;
  shiftId: string | null;
  sectorId: string | null;
};

export type RosterPerson = {
  id: string;
  /** Setor principal (User.sectorId). */
  sectorId: string | null;
  /** Turno do cadastro (User.shiftId). */
  profileShiftId: string | null;
  cycle: ScheduleCycle | null;
  exceptions: readonly ScheduleExceptionInput[];
};

export type DaySituation =
  | {
      kind: 'WORK';
      sectorId: string | null;
      shiftId: string;
      source: 'PROFILE' | 'CYCLE' | 'EXCEPTION';
    }
  | {
      kind: 'OFF';
      reason: 'DAY_OFF' | 'VACATION';
      source: 'CYCLE' | 'EXCEPTION';
    }
  | { kind: 'NONE' };

const NONE: DaySituation = { kind: 'NONE' };

/** Dia do ciclo em que cai a data; null antes do início. */
export function cycleIndex(
  cycle: ScheduleCycle,
  date: CivilDate,
): number | null {
  const diff = diffDays(date, cycle.startDate);
  if (diff < 0) return null;
  return diff % cycle.cycleLength;
}

/** Exceção cujo período (inclusivo) cobre a data; null se nenhuma cobre. */
export function exceptionOn(
  exceptions: readonly ScheduleExceptionInput[],
  date: CivilDate,
): ScheduleExceptionInput | null {
  // Datas civis 'YYYY-MM-DD' comparam como string na ordem do calendário.
  return (
    exceptions.find((ex) => ex.startDate <= date && date <= ex.endDate) ?? null
  );
}

function fromException(
  person: RosterPerson,
  ex: ScheduleExceptionInput,
): DaySituation {
  if (ex.kind === 'DAY_OFF' || ex.kind === 'VACATION') {
    return { kind: 'OFF', reason: ex.kind, source: 'EXCEPTION' };
  }
  // Troca/outro setor sem turno é dado inválido: não põe a pessoa em turno algum.
  if (!ex.shiftId) return NONE;
  const sectorId = ex.kind === 'OTHER_SECTOR' ? ex.sectorId : person.sectorId;
  return { kind: 'WORK', sectorId, shiftId: ex.shiftId, source: 'EXCEPTION' };
}

function fromCycle(
  person: RosterPerson,
  cycle: ScheduleCycle,
  index: number,
): DaySituation {
  const shiftId = cycle.days[index] ?? null;
  if (shiftId === null)
    return { kind: 'OFF', reason: 'DAY_OFF', source: 'CYCLE' };
  return { kind: 'WORK', sectorId: person.sectorId, shiftId, source: 'CYCLE' };
}

export function resolveDay(
  person: RosterPerson,
  date: CivilDate,
): DaySituation {
  const ex = exceptionOn(person.exceptions, date);
  if (ex) return fromException(person, ex);
  const index = person.cycle ? cycleIndex(person.cycle, date) : null;
  if (person.cycle && index !== null)
    return fromCycle(person, person.cycle, index);
  if (person.profileShiftId) {
    return {
      kind: 'WORK',
      sectorId: person.sectorId,
      shiftId: person.profileShiftId,
      source: 'PROFILE',
    };
  }
  return NONE;
}
