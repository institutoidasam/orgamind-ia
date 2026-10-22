import type { ShiftRef } from '../../schemas/contracts/shift.schema';
import {
  addDays,
  timeIn,
  todayIn,
  type CivilDate,
} from '../staff-schedule/civil-date';

/**
 * Turno que começou na véspera e ainda está em andamento agora (Manaus): o
 * primeiro (na ordem recebida, sortOrder) que atravessa a meia-noite
 * (`endTime <= startTime`) e cujo fim ainda não chegou. A tela oferece o atalho
 * "Ver esse turno" para a data de ontem; a data padrão continua sendo hoje.
 */
export function overnightInProgress(
  shifts: readonly ShiftRef[],
  now: Date,
): { date: CivilDate; shift: ShiftRef } | null {
  const clock = timeIn(now);
  // 'HH:mm' compara como string na ordem do relógio.
  const shift = shifts.find(
    (s) => s.endTime <= s.startTime && clock < s.endTime,
  );
  return shift ? { date: addDays(todayIn(now), -1), shift } : null;
}

/**
 * Filtro da seleção manual sobre a lista elegível da escala da data. `null` =
 * seleção inválida (algum id fora da lista). Ids repetidos contam uma vez.
 */
export function selectMembers<M extends { id: string }>(
  eligible: readonly M[],
  userIds: readonly string[] | undefined,
): M[] | null {
  if (!userIds) return [...eligible];
  const wanted = new Set(userIds);
  const picked = eligible.filter((m) => wanted.has(m.id));
  return picked.length === wanted.size ? picked : null;
}
