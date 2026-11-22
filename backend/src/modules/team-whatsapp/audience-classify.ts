import type { TeamAudienceBase } from '../../schemas/contracts/team-whatsapp.schema';
import type { CivilDate } from '../staff-schedule/civil-date';
import {
  resolveDay,
  type DaySituation,
} from '../staff-schedule/schedule-resolver';
import { passesLevel, type LevelFilter } from './team-whatsapp.roster';
import type {
  TeamMemberRow,
  TeamMemberWithSchedule,
} from './team-whatsapp.repository';

/** Base do público (CF2): quem a escala da data põe em serviço, ou quem tem o vínculo da data. */
export type AudienceBase = TeamAudienceBase;

export type AudienceRuleReason =
  'not_selected' | 'day_off' | 'vacation' | 'other_sector' | 'other_shift';

/**
 * Uma pessoa na classificação de um setor: `reason` nulo = entra; senão fica
 * excluída com o motivo. `not_selected` não sai daqui (é da seleção nominal).
 */
export type AudienceEntry = {
  member: TeamMemberRow;
  sectorId: string;
  sectorName: string;
  shiftId: string | null;
  shiftName: string | null;
  levelName: string | null;
  reason: AudienceRuleReason | null;
};

/**
 * Filtro do público do setor (CF6): turnos escolhidos (`null` = todos), folga,
 * nível (C5) e os nomes dos turnos para mostrar o da escala.
 */
export type AudienceFilter = {
  shiftIds: ReadonlySet<string> | null;
  includeOff: boolean;
  level: LevelFilter | null;
  shiftNames: ReadonlyMap<string, string>;
};

type Ctx = { sector: { id: string; name: string }; filter: AudienceFilter };
type DayPerson = { member: TeamMemberRow; situation: DaySituation };
type Shift = Pick<AudienceEntry, 'shiftId' | 'shiftName'>;
type Work = Extract<DaySituation, { kind: 'WORK' }>;
type Idle = Exclude<DaySituation, Work>;

/** A pessoa sem a escala, com a situação da data (o vínculo da data já vem aplicado). */
function toDayPerson(
  person: TeamMemberWithSchedule,
  date: CivilDate,
): DayPerson {
  const { cycle, exceptions, ...member } = person;
  const situation = resolveDay(
    {
      id: member.id,
      sectorId: member.sectorId,
      profileShiftId: member.shiftId,
      cycle,
      exceptions,
    },
    date,
  );
  return { member, situation };
}

/** `null` = todos os turnos (inclui sem turno); senão o turno tem de ser um dos escolhidos. */
function inShifts(
  shiftId: string | null,
  shiftIds: AudienceFilter['shiftIds'],
): boolean {
  return shiftIds === null || (shiftId !== null && shiftIds.has(shiftId));
}

const linkedShift = (member: TeamMemberRow): Shift => ({
  shiftId: member.shiftId,
  shiftName: member.workShift?.name ?? null,
});

const scaleShift = (work: Work, ctx: Ctx): Shift => ({
  shiftId: work.shiftId,
  shiftName: ctx.filter.shiftNames.get(work.shiftId) ?? null,
});

function entryOf(
  { member }: DayPerson,
  ctx: Ctx,
  shift: Shift,
  reason: AudienceRuleReason | null,
): AudienceEntry {
  return {
    member,
    sectorId: ctx.sector.id,
    sectorName: ctx.sector.name,
    ...shift,
    levelName: member.level?.name ?? null,
    reason,
  };
}

/** De fora do setor: só entra quem a escala põe aqui num turno escolhido. */
function visitorOnDuty(person: DayPerson, ctx: Ctx): AudienceEntry | null {
  const { situation } = person;
  if (situation.kind !== 'WORK' || situation.sectorId !== ctx.sector.id)
    return null;
  if (!inShifts(situation.shiftId, ctx.filter.shiftIds)) return null;
  return entryOf(person, ctx, scaleShift(situation, ctx), null);
}

/**
 * Do setor e com WORK: `other_sector` se a escala o põe noutro setor; `other_shift`
 * se o põe aqui noutro turno. Sem relação com os turnos escolhidos (vínculo fora
 * deles e escala fora deles) não aparece (DF6).
 */
function ownWorking(
  person: DayPerson,
  work: Work,
  ctx: Ctx,
): AudienceEntry | null {
  const { shiftIds } = ctx.filter;
  const shift = scaleShift(work, ctx);
  const placed = inShifts(work.shiftId, shiftIds);
  const related = placed || inShifts(person.member.shiftId, shiftIds);
  if (work.sectorId !== ctx.sector.id)
    return related ? entryOf(person, ctx, shift, 'other_sector') : null;
  if (placed) return entryOf(person, ctx, shift, null);
  return related ? entryOf(person, ctx, shift, 'other_shift') : null;
}

/** Do setor e sem WORK: folga, férias ou sem turno; precisa de vínculo num turno escolhido (DF6). */
function ownIdle(
  person: DayPerson,
  idle: Idle,
  ctx: Ctx,
): AudienceEntry | null {
  const { member } = person;
  if (!inShifts(member.shiftId, ctx.filter.shiftIds)) return null;
  const shift = linkedShift(member);
  if (idle.kind === 'NONE') return entryOf(person, ctx, shift, 'other_shift');
  const reason = idle.reason === 'VACATION' ? 'vacation' : 'day_off';
  return entryOf(person, ctx, shift, reason);
}

/** Base em serviço (GF5): a escala da data decide; o turno mostrado é o da escala quando há WORK. */
function classifyOnDuty(person: DayPerson, ctx: Ctx): AudienceEntry | null {
  if (person.member.sectorId !== ctx.sector.id)
    return visitorOnDuty(person, ctx);
  const { situation } = person;
  return situation.kind === 'WORK'
    ? ownWorking(person, situation, ctx)
    : ownIdle(person, situation, ctx);
}

/** Folga entra com `includeOff`; férias nunca (GF3); trabalhe onde trabalhar, ou sem escala, entra. */
function assignedReason(
  situation: DaySituation,
  includeOff: boolean,
): AudienceRuleReason | null {
  if (situation.kind !== 'OFF') return null;
  if (situation.reason === 'VACATION') return 'vacation';
  return includeOff ? null : 'day_off';
}

/** Base vinculada (GF5): setor e turno do vínculo da data; só gente do setor; turno do vínculo. */
function classifyAssigned(person: DayPerson, ctx: Ctx): AudienceEntry | null {
  const { member, situation } = person;
  if (member.sectorId !== ctx.sector.id) return null;
  if (!inShifts(member.shiftId, ctx.filter.shiftIds)) return null;
  const reason = assignedReason(situation, ctx.filter.includeOff);
  return entryOf(person, ctx, linkedShift(member), reason);
}

/**
 * Classifica as pessoas de um setor na data pela base (GF5): quem entra
 * (`reason` nulo) e quem fica de fora com o motivo (GF6). `people` é o que
 * `loadDayPeopleMany` devolve para o setor, com o vínculo da data aplicado. O
 * nível filtra as duas bases pelo nível do vínculo; quem não passa, pessoa
 * inativa e quem não tem relação com o setor e os turnos não aparecem. Mantém a
 * ordem de `people`; a pessoa de vários setores é deduplicada por quem junta.
 */
export function classifySector(input: {
  base: AudienceBase;
  sector: { id: string; name: string };
  date: CivilDate;
  people: readonly TeamMemberWithSchedule[];
  filter: AudienceFilter;
}): AudienceEntry[] {
  const { base, sector, date, people, filter } = input;
  const ctx: Ctx = { sector, filter };
  const classify = base === 'on_duty' ? classifyOnDuty : classifyAssigned;
  return people.flatMap((raw) => {
    if (!raw.isActive || !passesLevel(raw, filter.level)) return [];
    const entry = classify(toDayPerson(raw, date), ctx);
    return entry ? [entry] : [];
  });
}
