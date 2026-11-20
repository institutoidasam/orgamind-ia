import type { z } from 'zod';
import { nameView, phoneView } from '../../shared/authz/phone-visibility';
import type { ShiftRef } from '../../schemas/contracts/shift.schema';
import {
  rosterSnapshotSchema,
  type TeamRosterMember,
  type TeamRosterPerson,
} from '../../schemas/contracts/team-whatsapp.schema';
import {
  formatDayMonth,
  zonedStart,
  type CivilDate,
} from '../staff-schedule/civil-date';
import {
  resolveDay,
  type DaySituation,
} from '../staff-schedule/schedule-resolver';
import { sortByViewedName } from './team-whatsapp.name-view';
import type {
  TeamMemberRow,
  TeamMemberWithSchedule,
} from './team-whatsapp.repository';

/** Foto da escala gravada no envio (`TeamWhatsappDispatch.roster`, C10). */
export type RosterSnapshot = z.infer<typeof rosterSnapshotSchema>;

/**
 * Lê a coluna Json da foto. Ausente ou fora do formato → null; chaves fora do
 * contrato (ex.: telefone) são descartadas pelo schema (GC10).
 */
export function parseRosterSnapshot(json: unknown): RosterSnapshot | null {
  const parsed = rosterSnapshotSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}

/** Grupos da lista de envios (C8): quem está na foto e não é destinatário. */
export function rosterGroups(
  snapshot: RosterSnapshot | null,
  recipientUserIds: ReadonlySet<string>,
): { unselected: TeamRosterPerson[]; off: TeamRosterPerson[] } {
  if (!snapshot) return { unselected: [], off: [] };
  const notRecipient = (p: TeamRosterPerson) =>
    p.userId === null || !recipientUserIds.has(p.userId);
  return {
    unselected: snapshot.working.filter(notRecipient),
    off: snapshot.off.filter(notRecipient),
  };
}

/** Pessoa da escala do setor na data (C6), com função, nível e a situação resolvida (C3). */
export type DayMember = TeamMemberRow & {
  fromOtherSector: boolean;
  situation: DaySituation;
};

const byName = new Intl.Collator('pt-BR');
const nameOf = (m: { name: string | null; email: string | null }) =>
  m.name ?? m.email ?? '';

/** Do setor: entra se não trabalha em outro setor no dia; de fora: se trabalha aqui. */
function inRoster(sectorId: string, member: DayMember): boolean {
  const { situation } = member;
  const worksHere =
    situation.kind === 'WORK' && situation.sectorId === sectorId;
  if (member.fromOtherSector) return worksHere;
  return situation.kind !== 'WORK' || worksHere;
}

/**
 * Escala do setor na data: ativos do setor principal, menos quem trabalha em
 * outro setor nesse dia, mais os de fora com WORK aqui (`fromOtherSector`).
 * Ordem: setor principal, depois os de fora, cada grupo por nome (pt-BR).
 */
export function dayMembers(input: {
  sectorId: string;
  date: CivilDate;
  people: readonly TeamMemberWithSchedule[];
}): DayMember[] {
  const members = input.people.map(({ cycle, exceptions, ...person }) => ({
    ...person,
    fromOtherSector: person.sectorId !== input.sectorId,
    situation: resolveDay(
      {
        id: person.id,
        sectorId: person.sectorId,
        profileShiftId: person.shiftId,
        cycle,
        exceptions,
      },
      input.date,
    ),
  }));
  return members
    .filter((m) => inRoster(input.sectorId, m))
    .sort(
      (a, b) =>
        Number(a.fromOtherSector) - Number(b.fromOtherSector) ||
        byName.compare(nameOf(a), nameOf(b)),
    );
}

/** Escala de um setor do envio na data (`dayMembers`), com o nome do setor. */
export type SectorDay = {
  sectorId: string;
  sectorName: string;
  members: readonly DayMember[];
};

/**
 * Membro do GET roster: telefone que o envio usaria (contato ligado, senão o do
 * usuário). `fullPhone` (`telefone.ver_completo` do ator) decide se o número
 * completo sai; a máscara e `hasPhone` saem sempre (CB5, `phoneView`).
 */
export function toRosterMember(
  m: DayMember,
  viewer: { fullPhone: boolean },
): TeamRosterMember {
  return {
    id: m.id,
    name: nameView(m.name, { full: viewer.fullPhone }),
    email: m.email,
    ...phoneView(m.contact?.phoneE164 ?? m.phoneE164, {
      full: viewer.fullPhone,
    }),
    isActive: m.isActive,
    jobTitle: m.jobTitle,
    fromOtherSector: m.fromOtherSector,
    situation: m.situation,
    level: m.level,
    contactAuthorization: m.contactAuthorization,
    authorizationUnverified:
      m.contactAuthorization === 'AUTORIZADO' &&
      m.authorizationSource === 'CADASTRO_ANTERIOR',
  };
}

/**
 * Membros do GET roster, na ordem da escala (`dayMembers`: setor principal e
 * depois os de fora, cada grupo por nome). Sem a chave, o nome-telefone sai
 * mascarado e a ordem passa a ser pelo nome exibido (`sortByViewedName`).
 */
export function toRosterMembers(
  members: readonly DayMember[],
  viewer: { fullPhone: boolean },
): TeamRosterMember[] {
  return sortByViewedName(
    members.map((m) => toRosterMember(m, viewer)),
    viewer.fullPhone,
    (m) => ({
      group: Number(m.fromOtherSector),
      name: m.name ?? m.email ?? '',
      id: m.id,
    }),
  );
}

/** Filtro de nível do envio (C5); `null` = todos. */
export type LevelFilter = {
  levelIds: ReadonlySet<string>;
  withoutLevel: boolean;
} | null;

/**
 * C5: sem filtro (ou lista vazia e sem `withoutLevel`) = todos; senão passa quem
 * tem `levelId` na lista, ou não tem nível e `withoutLevel`.
 */
export function passesLevel(
  member: { levelId: string | null },
  filter: LevelFilter,
): boolean {
  if (!filter || (filter.levelIds.size === 0 && !filter.withoutLevel))
    return true;
  if (member.levelId === null) return filter.withoutLevel;
  return filter.levelIds.has(member.levelId);
}

/** Rótulo de quem não tem nível no filtro e no `targetLabel` (GC12). */
export const NO_LEVEL_LABEL = 'Sem nível';

/**
 * Filtro de nível do pedido contra os níveis ativos (C5), já por sortOrder.
 * `null` = algum id inexistente ou inativo (422 no chamador). `names` = nomes
 * para o rótulo, na ordem do sortOrder e `Sem nível` por último (GC12).
 */
export function pickLevels(
  active: readonly { id: string; name: string }[],
  wanted: { levelIds?: readonly string[]; withoutLevel?: boolean },
): { filter: LevelFilter; names: string[] } | null {
  const levelIds = new Set(wanted.levelIds);
  const withoutLevel = wanted.withoutLevel === true;
  if (levelIds.size === 0 && !withoutLevel) return { filter: null, names: [] };
  const picked = active.filter((l) => levelIds.has(l.id));
  if (picked.length !== levelIds.size) return null;
  const names = picked.map((l) => l.name);
  if (withoutLevel) names.push(NO_LEVEL_LABEL);
  return { filter: { levelIds, withoutLevel }, names };
}

/** GC12: até dois nomes por `, `; com mais, os dois primeiros + ` +N`. */
function compactNames(names: readonly string[]): string {
  const head = names.slice(0, 2).join(', ');
  return names.length > 2 ? `${head} +${names.length - 2}` : head;
}

/** D9: rótulo dos turnos do envio, na ordem recebida; nenhum → null ("todos os turnos"). */
export function shiftsLabel(names: readonly string[]): string | null {
  return names.length > 0 ? compactNames(names) : null;
}

/**
 * GC12: `<setores> · <níveis>? · <turnos | todos os turnos> · dd/MM · seleção de N?`.
 * Nomes já ordenados pelo chamador: setores por nome (pt-BR), níveis pelo
 * sortOrder com `Sem nível` no fim; sem filtro de nível a parte some. Um setor
 * sem nível = rótulo de antes: "Produção · Noite · 21/10 · seleção de 2".
 */
export function sectorTargetLabel(input: {
  sectorNames: readonly string[];
  levelNames: readonly string[];
  shiftName: string | null;
  date: string;
  selected: number | null;
}): string {
  const parts = [compactNames(input.sectorNames)];
  if (input.levelNames.length > 0) parts.push(compactNames(input.levelNames));
  parts.push(input.shiftName ?? 'todos os turnos', formatDayMonth(input.date));
  if (input.selected !== null) parts.push(`seleção de ${input.selected}`);
  return parts.join(' · ');
}

/** Início de cada turno na data, como instante ISO (GC5). */
export function shiftStarts(
  shifts: readonly ShiftRef[],
  date: CivilDate,
): { shiftId: string; startsAt: string }[] {
  return shifts.map((s) => ({
    shiftId: s.id,
    startsAt: zonedStart(date, s.startTime).toISOString(),
  }));
}
