import { formatDayMonth } from '@/lib/civil-date';
import type { RecipientPreview, RosterMember, SendTarget, TeamLevel } from './schemas';

/** Id do turno escolhido, ou 'ALL' para "Todos os turnos". */
export type ShiftChoice = string | 'ALL';

export const ALL_SHIFTS: ShiftChoice = 'ALL';

export const memberName = (m: RosterMember): string => m.name ?? m.email ?? 'Sem nome';

export const canReceive = (m: RosterMember): boolean => !!m.phoneE164;

/** Filtro de nível do envio: vazio e sem `withoutLevel` = todos (C5). */
export type LevelFilter = { levelIds: readonly string[]; withoutLevel: boolean };

/** Quem passa no filtro de nível: tem um dos níveis, ou não tem nível e `withoutLevel`. */
export function filterByLevel(members: readonly RosterMember[], { levelIds, withoutLevel }: LevelFilter): RosterMember[] {
  if (levelIds.length === 0 && !withoutLevel) return [...members];
  return members.filter((m) => (m.level ? levelIds.includes(m.level.id) : withoutLevel));
}

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

const SEM_NIVEL = 'Sem nível';

/** Até dois nomes por ", "; com mais, os dois primeiros e " +N" ("RH, TI +2"). */
function namesLabel(names: readonly string[]): string {
  const shown = names.slice(0, 2).join(', ');
  return names.length > 2 ? `${shown} +${names.length - 2}` : shown;
}

/** Nomes dos níveis do filtro pela ordem de `levels` (sortOrder), "Sem nível" por último. */
function levelNames(levels: readonly TeamLevel[], { levelIds, withoutLevel }: LevelFilter): string[] {
  const chosen = levels.filter((l) => levelIds.includes(l.id)).map((l) => l.name);
  return withoutLevel ? [...chosen, SEM_NIVEL] : chosen;
}

type LabelInput = {
  sectorNames: readonly string[];
  levelNames: readonly string[];
  shiftName: string | null;
  date: string;
  selectedCount: number | null;
};

/** Mesmo rótulo que o back grava em `targetLabel` (GC12). */
function sectorLabel(input: LabelInput): string {
  const sectors = [...input.sectorNames].sort((a, b) => a.localeCompare(b, 'pt-BR'));
  return [
    namesLabel(sectors),
    ...(input.levelNames.length > 0 ? [namesLabel(input.levelNames)] : []),
    input.shiftName ?? 'todos os turnos',
    formatDayMonth(input.date),
    ...(input.selectedCount === null ? [] : [`seleção de ${input.selectedCount}`]),
  ].join(' · ');
}

type SectorTargetInput = {
  /** Setores da lista conferida, com todos os membros (o filtro de nível é aplicado aqui). */
  sectors: readonly { id: string; name: string; members: readonly RosterMember[] }[];
  /** Níveis ativos (para os nomes do rótulo). */
  levels: readonly TeamLevel[];
  levelFilter: LevelFilter;
  /** Nome do turno escolhido; null em "Todos os turnos". */
  shiftName: string | null;
  date: string;
  choice: ShiftChoice;
  includeOff: boolean;
  /** null = "Enviar para todos"; senão, os marcados. */
  selectedIds: readonly string[] | null;
};

export function buildSectorTarget(input: SectorTargetInput): SendTarget {
  const { choice, date, selectedIds, levelFilter } = input;
  const all = choice === ALL_SHIFTS;
  const includeOff = all && input.includeOff;
  const visible = input.sectors.flatMap((s) => eligibleMembers(filterByLevel(s.members, levelFilter), choice, includeOff));
  const chosen = selectedIds ? visible.filter((m) => selectedIds.includes(m.id)) : null;
  return {
    type: 'sector',
    sectorIds: input.sectors.map((s) => s.id),
    levelIds: [...levelFilter.levelIds],
    withoutLevel: levelFilter.withoutLevel,
    label: sectorLabel({
      sectorNames: input.sectors.map((s) => s.name),
      levelNames: levelNames(input.levels, levelFilter),
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
