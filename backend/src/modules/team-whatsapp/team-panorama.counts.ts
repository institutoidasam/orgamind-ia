import type { PanoramaCounts } from '../../schemas/contracts/team-panorama.schema';
import { sendPhoneOf } from './recipient-skip';
import type { DayMember } from './team-whatsapp.roster';

type Tally = Omit<PanoramaCounts, 'byShift'>;

/**
 * Lacuna de contato de quem está em serviço, na ordem da prévia: sem telefone
 * vem antes de sem autorização, então as duas contagens são disjuntas. A
 * supressão não é consultada (o panorama conta pela escala, não por pessoa).
 */
function contactGap(m: DayMember): 'noPhone' | 'notAuthorized' | null {
  if (!sendPhoneOf(m)) return 'noPhone';
  return m.contactAuthorization === 'AUTORIZADO' ? null : 'notAuthorized';
}

function tallyWork(
  m: DayMember,
  shiftId: string,
  byShift: Map<string, number>,
  tally: Tally,
): void {
  const inShift = byShift.get(shiftId);
  if (inShift === undefined) tally.otherShifts += 1;
  else byShift.set(shiftId, inShift + 1);
  const gap = contactGap(m);
  if (gap) tally[gap] += 1;
}

/**
 * Contagem do panorama de um setor (DJ4): em serviço por turno ativo (um item
 * por turno, na ordem recebida, com zeros), em outro turno, folga, férias e
 * sem escala; sem telefone e sem autorização só entre os em serviço.
 */
export function panoramaCounts(
  members: readonly DayMember[],
  activeShiftIds: readonly string[],
): PanoramaCounts {
  const byShift = new Map(activeShiftIds.map((id) => [id, 0]));
  const tally: Tally = {
    otherShifts: 0,
    dayOff: 0,
    vacation: 0,
    noSchedule: 0,
    noPhone: 0,
    notAuthorized: 0,
  };
  for (const m of members) {
    const s = m.situation;
    if (s.kind === 'WORK') tallyWork(m, s.shiftId, byShift, tally);
    else if (s.kind === 'NONE') tally.noSchedule += 1;
    else if (s.reason === 'DAY_OFF') tally.dayOff += 1;
    else tally.vacation += 1;
  }
  return {
    byShift: activeShiftIds.map((shiftId) => ({
      shiftId,
      count: byShift.get(shiftId) ?? 0,
    })),
    ...tally,
  };
}
