import type { z } from 'zod';
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

/** Filtro do alvo setor (C5): turno (ausente = todos), folga e nível. */
export type DispatchFilter = {
  shiftId?: string;
  includeOff: boolean;
  level?: LevelFilter;
};

/**
 * Quem o filtro alcança (D2): com turno, só WORK nesse turno; "Todos os turnos",
 * todo WORK (sem NONE); `includeOff` (só sem turno) acrescenta os OFF do setor;
 * por fim o nível (C5, `passesLevel`; sem filtro = todos).
 */
export function eligibleFor(
  members: readonly DayMember[],
  filter: DispatchFilter,
): DayMember[] {
  const { shiftId, includeOff, level = null } = filter;
  return members.filter((m) => {
    if (!passesLevel(m, level)) return false;
    const { situation, fromOtherSector } = m;
    if (situation.kind === 'WORK')
      return shiftId === undefined || situation.shiftId === shiftId;
    const offHere = situation.kind === 'OFF' && !fromOtherSector;
    return offHere && includeOff && shiftId === undefined;
  });
}

/** Escala de um setor do envio na data (`dayMembers`), com o nome do setor. */
export type SectorDay = {
  sectorId: string;
  sectorName: string;
  members: readonly DayMember[];
};

/** Pessoa da lista conferida com o setor do envio em que entrou (C6). */
export type SectorMember = DayMember & {
  inSector: { sectorId: string; sectorName: string };
};

/**
 * Lista conferida de vários setores (GC7/D7): os elegíveis de cada setor, na
 * ordem recebida (o chamador ordena por nome), uma vez por pessoa, no primeiro
 * setor em que aparece.
 */
export function eligibleAcross(
  days: readonly SectorDay[],
  filter: DispatchFilter,
): SectorMember[] {
  const seen = new Set<string>();
  return days.flatMap(({ sectorId, sectorName, members }) =>
    eligibleFor(members, filter).flatMap((m) => {
      if (seen.has(m.id)) return [];
      seen.add(m.id);
      return [{ ...m, inSector: { sectorId, sectorName } }];
    }),
  );
}

/** Turno da pessoa no dia, para o destinatário gravado; fora de WORK → null. */
export function dayShift(
  member: DayMember,
  shiftNames: ReadonlyMap<string, string>,
): { shiftId: string | null; shiftName: string | null } {
  const { situation } = member;
  if (situation.kind !== 'WORK') return { shiftId: null, shiftName: null };
  return {
    shiftId: situation.shiftId,
    shiftName: shiftNames.get(situation.shiftId) ?? null,
  };
}

/**
 * Foto gravada no envio (C10), sem telefone (GC10), de todos os setores do
 * envio: `working` = a lista conferida sem os de folga (marcados ou não);
 * `off` = de folga/férias do setor principal; os dois no filtro de nível. Cada
 * pessoa leva o setor em que entrou e o nome do nível na hora (C6).
 */
export function rosterSnapshot(
  days: readonly SectorDay[],
  filter: Omit<DispatchFilter, 'includeOff'>,
  shiftNames: ReadonlyMap<string, string>,
): RosterSnapshot {
  const person = (m: DayMember, sectorName: string) => ({
    userId: m.id,
    name: nameOf(m),
    jobTitle: m.jobTitle,
    sectorName,
    levelName: m.level?.name ?? null,
  });
  const working = eligibleAcross(days, { ...filter, includeOff: false }).map(
    (m) => ({
      ...person(m, m.inSector.sectorName),
      shiftName: dayShift(m, shiftNames).shiftName,
      reason: null,
    }),
  );
  const level = filter.level ?? null;
  const off = days.flatMap(({ sectorName, members }) =>
    members.flatMap((m) =>
      m.situation.kind === 'OFF' && !m.fromOtherSector && passesLevel(m, level)
        ? [
            {
              ...person(m, sectorName),
              shiftName: null,
              reason: m.situation.reason,
            },
          ]
        : [],
    ),
  );
  return { working, off };
}

/** Membro do GET roster: telefone que o envio usaria (contato ligado, senão o do usuário). */
export function toRosterMember(m: DayMember): TeamRosterMember {
  return {
    id: m.id,
    name: m.name,
    email: m.email,
    phoneE164: m.contact?.phoneE164 ?? m.phoneE164,
    isActive: m.isActive,
    jobTitle: m.jobTitle,
    fromOtherSector: m.fromOtherSector,
    situation: m.situation,
    level: m.level,
  };
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

/**
 * GC12: `<setores> · <níveis>? · <turno | todos os turnos> · dd/MM · seleção de N?`.
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
