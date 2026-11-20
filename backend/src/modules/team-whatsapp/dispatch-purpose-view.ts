import { Logger } from '@nestjs/common';
import type {
  TeamAudienceBase as DbAudienceBase,
  TeamDispatchPurpose as DbPurpose,
  TeamSchedulePolicy as DbSchedulePolicy,
} from '@prisma/client';
import {
  audienceExcludedSnapshotSchema,
  audienceLateJoinedSnapshotSchema,
  audienceRuleSnapshotSchema,
  type TeamActivity,
  type TeamAudienceBase,
  type TeamAudienceExcludedPerson,
  type TeamAudiencePerson,
  type TeamAudienceRuleView,
  type TeamPurpose,
} from '../../schemas/contracts/team-whatsapp.schema';
import { nameView } from '../../shared/authz/phone-visibility';
import { fromDbDate } from '../staff-schedule/civil-date';
import { sortByViewedName } from './team-whatsapp.name-view';
import {
  fromDbBase,
  fromDbPolicy,
  fromDbPurpose,
} from './team-whatsapp.purpose-codes';

/** Colunas de finalidade que a lista e o detalhe leem (CF3). */
export type PurposeRow = {
  purpose: DbPurpose | null;
  audienceBase: DbAudienceBase | null;
  activityDate: Date | null;
  activityTime: string | null;
  activityPlace: string | null;
  urgencyReason: string | null;
};

/** O que o detalhe grava além das colunas simples: a regra e os excluídos (Json, DF2). */
export type DetailPurposeRow = PurposeRow & {
  id: string;
  includeOff: boolean;
  rosterDate: Date | null;
  audienceRule: unknown;
  audienceExcluded: unknown;
  scheduledFor: Date | null;
  schedulePolicy: DbSchedulePolicy | null;
};

export type DispatchPurposeView = {
  purpose: TeamPurpose | null;
  base: TeamAudienceBase | null;
  activity: TeamActivity | null;
  urgencyReason: string | null;
};

export type DispatchPurposeDetail = {
  purpose: TeamPurpose | null;
  base: TeamAudienceBase | null;
  rule: TeamAudienceRuleView | null;
  excluded: TeamAudienceExcludedPerson[];
};

type SectorRef = { id: string; name: string };

/** Colunas Json do envio que o histórico lê pelo schema do contrato. */
type SnapshotColumn =
  'audienceRule' | 'audienceExcluded' | 'audienceLateJoined';

const logger = new Logger('DispatchPurposeView');

/** Atividade gravada; as três colunas nulas = sem atividade. */
function activityOf(row: PurposeRow): TeamActivity | null {
  const { activityDate, activityTime, activityPlace } = row;
  if (!activityDate && activityTime === null && activityPlace === null) {
    return null;
  }
  return {
    date: activityDate ? fromDbDate(activityDate) : null,
    time: activityTime,
    place: activityPlace,
  };
}

/**
 * Finalidade, base e atividade como saem na lista e no detalhe. Envio sem
 * finalidade (regra antiga, GF13): as quatro chaves presentes e nulas.
 */
export function purposeView(row: PurposeRow): DispatchPurposeView {
  return {
    purpose: fromDbPurpose(row.purpose),
    base: fromDbBase(row.audienceBase),
    activity: activityOf(row),
    urgencyReason: row.urgencyReason,
  };
}

/**
 * Json gravado lido pelo schema do contrato. Ausente = null; fora do formato
 * também, com registro só do envio e da coluna (nunca o conteúdo, que tem nomes).
 */
function readSnapshot<T, C extends SnapshotColumn>(
  schema: { safeParse(json: unknown): { success: boolean; data?: T } },
  row: { id: string } & Record<C, unknown>,
  column: C,
): T | null {
  const json = row[column];
  if (json === null || json === undefined) return null;
  const parsed = schema.safeParse(json);
  if (parsed.success && parsed.data !== undefined) return parsed.data;
  logger.warn(`Envio ${row.id}: ${column} gravado fora do formato; ignorado.`);
  return null;
}

/**
 * Painel da regra (F3) lido do que foi gravado, nunca recalculado. Null no envio
 * sem finalidade e quando a regra gravada falta ou está fora do formato.
 * `when` = o gravado (DG8); envio anterior ao Lote G não o grava e fica
 * inferido: início do turno quando há `scheduledFor`, senão agora.
 */
export function ruleView(
  row: DetailPurposeRow,
  sectors: readonly SectorRef[],
): TeamAudienceRuleView | null {
  const view = purposeView(row);
  if (!view.purpose || !view.base || !row.rosterDate) return null;
  const rule = readSnapshot(audienceRuleSnapshotSchema, row, 'audienceRule');
  if (!rule) return null;
  return {
    purpose: view.purpose,
    base: view.base,
    includeOff: row.includeOff,
    rosterDate: fromDbDate(row.rosterDate),
    sectors: [...sectors],
    shifts: rule.shifts,
    levels: rule.levels,
    withoutLevel: rule.withoutLevel,
    selectedCount: rule.selectedUserIds?.length ?? null,
    activity: view.activity,
    urgencyReason: view.urgencyReason,
    when: rule.when ?? inferredWhen(row),
    scheduledFor: row.scheduledFor?.toISOString() ?? null,
    schedulePolicy: fromDbPolicy(row.schedulePolicy),
  };
}

const inferredWhen = (row: { scheduledFor: Date | null }) =>
  row.scheduledFor ? 'shift_start' : 'now';

/**
 * Pessoas gravadas (excluídos, entraram depois), com o nome pela regra da chave
 * (GF8). Gravadas na ordem do nome real: com a chave a ordem fica; sem ela,
 * pelo nome exibido com desempate pelo id.
 */
function viewedPeople<P extends { userId: string; name: string }>(
  people: readonly P[],
  full: boolean,
): P[] {
  const viewed = people.map((p) => ({
    ...p,
    name: nameView(p.name, { full }),
  }));
  return sortByViewedName(viewed, full, (p) => ({
    group: 0,
    name: p.name,
    id: p.userId,
  }));
}

/**
 * Excluídos gravados (GF8). Ausente ou fora do formato = [] (o parse descarta
 * chave fora do contrato, como telefone).
 */
export function excludedView(
  row: DetailPurposeRow,
  full: boolean,
): TeamAudienceExcludedPerson[] {
  return viewedPeople(
    readSnapshot(audienceExcludedSnapshotSchema, row, 'audienceExcluded') ?? [],
    full,
  );
}

/**
 * "Entraram depois do agendamento" gravados na reconferência (CG3, G3), sem
 * telefone (o parse do contrato o descarta). Ausente ou fora do formato = [].
 */
export function lateJoinedView(
  row: { id: string; audienceLateJoined: unknown },
  full: boolean,
): TeamAudiencePerson[] {
  return viewedPeople(
    readSnapshot(audienceLateJoinedSnapshotSchema, row, 'audienceLateJoined') ??
      [],
    full,
  );
}

/** Campos de finalidade do detalhe (CF3): sempre presentes, nulos/[] no envio antigo. */
export function purposeDetail(
  row: DetailPurposeRow,
  sectors: readonly SectorRef[],
  full: boolean,
): DispatchPurposeDetail {
  const { purpose, base } = purposeView(row);
  return {
    purpose,
    base,
    rule: ruleView(row, sectors),
    excluded: excludedView(row, full),
  };
}
