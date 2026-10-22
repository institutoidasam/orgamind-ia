import { formatDayMonth } from '@/lib/civil-date';
import type { RecipientPreview, RosterMember, SendTarget } from './schemas';

/** Id do turno escolhido, ou 'ALL' para "Todos os turnos". */
export type ShiftChoice = string | 'ALL';

export const ALL_SHIFTS: ShiftChoice = 'ALL';

export const memberName = (m: RosterMember): string => m.name ?? m.email;

export const canReceive = (m: RosterMember): boolean => !!m.phoneE164;

/**
 * Lista da tela, na ordem do back: ativos escalados (WORK) no turno escolhido; em
 * "Todos os turnos", todo WORK, mais quem está de folga se `includeOff`. Quem não tem
 * escala (NONE) nunca entra (D2). `includeOff` é ignorado com turno específico.
 */
export function eligibleMembers(
  members: readonly RosterMember[],
  choice: ShiftChoice,
  includeOff: boolean,
): RosterMember[] {
  const all = choice === ALL_SHIFTS;
  return members.filter(({ isActive, situation }) => {
    if (!isActive) return false;
    if (situation.kind === 'OFF') return all && includeOff;
    return situation.kind === 'WORK' && (all || situation.shiftId === choice);
  });
}

/** Grupo "De folga": folga ou férias entre as pessoas do setor (visitante não conta). */
export function offMembers(members: readonly RosterMember[]): RosterMember[] {
  return members.filter((m) => m.isActive && m.situation.kind === 'OFF' && !m.fromOtherSector);
}

/** Sem escala e sem turno no cadastro: não entram em nenhum turno. */
export function noScheduleCount(members: readonly RosterMember[]): number {
  return members.filter((m) => m.isActive && m.situation.kind === 'NONE').length;
}

/** Ids marcados que seguem na lista, na ordem do back (não na do clique). */
export function selectedIdsIn(visible: readonly RosterMember[], selected: ReadonlySet<string>): string[] {
  return visible.filter((m) => selected.has(m.id)).map((m) => m.id);
}

/** Marca todos os habilitados; se já estavam todos marcados, desmarca. */
export function toggleAllEnabled(visible: readonly RosterMember[], selected: ReadonlySet<string>): Set<string> {
  const enabled = visible.filter(canReceive).map((m) => m.id);
  const allOn = enabled.length > 0 && enabled.every((id) => selected.has(id));
  const next = new Set(selected);
  for (const id of enabled) {
    if (allOn) next.delete(id);
    else next.add(id);
  }
  return next;
}

const preview = (m: RosterMember): RecipientPreview => ({ id: m.id, name: memberName(m) });

type LabelInput = { sectorName: string; shiftName: string | null; date: string; selectedCount: number | null };

/** Mesmo rótulo que o back grava em `targetLabel` (GC12). */
function sectorLabel({ sectorName, shiftName, date, selectedCount }: LabelInput): string {
  return [
    sectorName,
    shiftName ?? 'todos os turnos',
    formatDayMonth(date),
    ...(selectedCount === null ? [] : [`seleção de ${selectedCount}`]),
  ].join(' · ');
}

type SectorTargetInput = {
  sectorId: string;
  sectorName: string;
  /** Nome do turno escolhido; null em "Todos os turnos". */
  shiftName: string | null;
  date: string;
  choice: ShiftChoice;
  includeOff: boolean;
  /** null = "Enviar para todos"; senão, os marcados. */
  selectedIds: readonly string[] | null;
  members: readonly RosterMember[];
};

export function buildSectorTarget(input: SectorTargetInput): SendTarget {
  const { choice, date, selectedIds } = input;
  const all = choice === ALL_SHIFTS;
  const includeOff = all && input.includeOff;
  const visible = eligibleMembers(input.members, choice, includeOff);
  const chosen = selectedIds ? visible.filter((m) => selectedIds.includes(m.id)) : null;
  return {
    type: 'sector',
    sectorId: input.sectorId,
    label: sectorLabel({
      sectorName: input.sectorName,
      shiftName: all ? null : input.shiftName,
      date,
      selectedCount: selectedIds ? selectedIds.length : null,
    }),
    date,
    shiftId: all ? null : choice,
    includeOff,
    userIds: selectedIds ? [...selectedIds] : null,
    recipients: (chosen ?? visible.filter(canReceive)).map(preview),
    leftOut: chosen ? [] : visible.filter((m) => !canReceive(m)).map(preview),
  };
}
