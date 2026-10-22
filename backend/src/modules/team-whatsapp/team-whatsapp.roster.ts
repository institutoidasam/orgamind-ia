import type { z } from 'zod';
import type { ShiftRef } from '../../schemas/contracts/shift.schema';
import {
  rosterSnapshotSchema,
  type TeamRosterMember,
  type TeamRosterPerson,
} from '../../schemas/contracts/team-whatsapp.schema';
import { zonedStart, type CivilDate } from '../staff-schedule/civil-date';
import {
  resolveDay,
  type DaySituation,
} from '../staff-schedule/schedule-resolver';
import type {
  TeamMember,
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

/** Pessoa da escala do setor na data (C6), com a situação resolvida (C3). */
export type DayMember = TeamMember & {
  jobTitle: string | null;
  fromOtherSector: boolean;
  situation: DaySituation;
};

const byName = new Intl.Collator('pt-BR');
const nameOf = (m: { name: string | null; email: string }) => m.name ?? m.email;

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

/**
 * Quem o filtro alcança (D2): com turno, só WORK nesse turno; "Todos os turnos",
 * todo WORK (sem NONE); `includeOff` (só sem turno) acrescenta os OFF do setor.
 */
export function eligibleFor(
  members: readonly DayMember[],
  filter: { shiftId?: string; includeOff: boolean },
): DayMember[] {
  const { shiftId, includeOff } = filter;
  return members.filter(({ situation, fromOtherSector }) => {
    if (situation.kind === 'WORK')
      return shiftId === undefined || situation.shiftId === shiftId;
    const offHere = situation.kind === 'OFF' && !fromOtherSector;
    return offHere && includeOff && shiftId === undefined;
  });
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
 * Foto gravada no envio (C10), sem telefone (GC10): `working` = escalados no
 * filtro de turno, marcados ou não; `off` = de folga/férias do setor principal.
 */
export function rosterSnapshot(
  members: readonly DayMember[],
  filter: { shiftId?: string },
  shiftNames: ReadonlyMap<string, string>,
): RosterSnapshot {
  const person = (
    m: DayMember,
  ): Omit<TeamRosterPerson, 'shiftName' | 'reason'> => ({
    userId: m.id,
    name: nameOf(m),
    jobTitle: m.jobTitle,
  });
  const working = eligibleFor(members, { ...filter, includeOff: false }).map(
    (m) => ({
      ...person(m),
      shiftName: dayShift(m, shiftNames).shiftName,
      reason: null,
    }),
  );
  const off = members.flatMap((m) =>
    m.situation.kind === 'OFF' && !m.fromOtherSector
      ? [{ ...person(m), shiftName: null, reason: m.situation.reason }]
      : [],
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
  };
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
