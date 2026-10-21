import { SHIFT_LABEL, type WorkShift } from '@/lib/work-shift';
import type { RecipientPreview, SendTarget, TeamMember, TeamSector } from './schemas';

export type ShiftChoice = WorkShift | 'ALL';

export const memberName = (m: TeamMember): string => m.name ?? m.email;

export const canReceive = (m: TeamMember): boolean => !!m.phoneE164;

/** Ativos do turno escolhido ("ALL" inclui quem está sem turno), na ordem do back. */
export function visibleMembers(sector: TeamSector, choice: ShiftChoice): TeamMember[] {
  return sector.members.filter((m) => m.isActive && (choice === 'ALL' || m.shift === choice));
}

export function unassignedCount(sector: TeamSector): number {
  return sector.members.filter((m) => m.isActive && m.shift === null).length;
}

/** Ids marcados que seguem visíveis, na ordem do back (não na do clique). */
export function selectedIdsIn(visible: TeamMember[], selected: ReadonlySet<string>): string[] {
  return visible.filter((m) => selected.has(m.id)).map((m) => m.id);
}

/** Marca todos os habilitados; se já estavam todos marcados, desmarca. */
export function toggleAllEnabled(visible: TeamMember[], selected: ReadonlySet<string>): Set<string> {
  const enabled = visible.filter(canReceive).map((m) => m.id);
  const allOn = enabled.length > 0 && enabled.every((id) => selected.has(id));
  const next = new Set(selected);
  for (const id of enabled) {
    if (allOn) next.delete(id);
    else next.add(id);
  }
  return next;
}

const preview = (m: TeamMember): RecipientPreview => ({ id: m.id, name: memberName(m) });

/** Mesmo rótulo que o back grava em `targetLabel` (GC4). */
function sectorLabel(sector: TeamSector, choice: ShiftChoice, selectedIds: string[] | null): string {
  return [
    sector.name,
    choice === 'ALL' ? 'todos os turnos' : SHIFT_LABEL[choice],
    ...(selectedIds ? [`seleção de ${selectedIds.length}`] : []),
  ].join(' · ');
}

export function buildSectorTarget(
  sector: TeamSector,
  choice: ShiftChoice,
  visible: TeamMember[],
  selectedIds: string[] | null,
): SendTarget {
  const chosen = selectedIds ? visible.filter((m) => selectedIds.includes(m.id)) : null;
  return {
    type: 'sector',
    sectorId: sector.id,
    label: sectorLabel(sector, choice, selectedIds),
    shift: choice === 'ALL' ? null : choice,
    userIds: selectedIds,
    recipients: (chosen ?? visible.filter(canReceive)).map(preview),
    leftOut: chosen ? [] : visible.filter((m) => !canReceive(m)).map(preview),
  };
}
