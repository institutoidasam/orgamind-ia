import { Logger } from '@nestjs/common';
import type {
  TeamAudienceBase as DbAudienceBase,
  TeamDispatchPurpose as DbPurpose,
  TeamSchedulePolicy as DbSchedulePolicy,
} from '@prisma/client';
import {
  audienceExcludedSnapshotSchema,
  audienceRuleSnapshotSchema,
  type TeamActivity,
  type TeamAudienceBase,
  type TeamAudienceExcludedPerson,
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
function readSnapshot<T>(
  schema: { safeParse(json: unknown): { success: boolean; data?: T } },
  row: DetailPurposeRow,
  column: 'audienceRule' | 'audienceExcluded',
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
 * `when` = início do turno quando há `scheduledFor`, senão agora.
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
    when: row.scheduledFor ? 'shift_start' : 'now',
    scheduledFor: row.scheduledFor?.toISOString() ?? null,
    schedulePolicy: fromDbPolicy(row.schedulePolicy),
  };
}

/**
 * Excluídos gravados, com o nome pela regra da chave (GF8). Com a chave a ordem
 * fica a gravada; sem ela, pelo nome exibido com desempate pelo id. Ausente ou
 * fora do formato = [] (o parse descarta chave fora do contrato, como telefone).
 */
export function excludedView(
  row: DetailPurposeRow,
  full: boolean,
): TeamAudienceExcludedPerson[] {
  const people =
    readSnapshot(audienceExcludedSnapshotSchema, row, 'audienceExcluded') ?? [];
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
