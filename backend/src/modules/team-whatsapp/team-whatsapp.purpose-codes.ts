import type {
  TeamAudienceBase as DbAudienceBase,
  TeamDispatchPurpose as DbPurpose,
  TeamSchedulePolicy as DbSchedulePolicy,
} from '@prisma/client';
import type {
  TeamAudienceBase,
  TeamPurpose,
  TeamSchedulePolicy,
} from '../../schemas/contracts/team-whatsapp.schema';

/**
 * Conversão API ↔ banco (CF8): a API usa minúsculas, o banco os enums do Prisma.
 * Coluna nula (envio de antes da finalidade) volta nula, sem valor assumido (GF13).
 */
const PURPOSE_TO_DB = {
  shift_notice: 'SHIFT_NOTICE',
  meeting: 'MEETING',
  alignment: 'ALIGNMENT',
  lecture: 'LECTURE',
  overtime: 'OVERTIME',
  urgency: 'URGENCY',
} as const satisfies Record<TeamPurpose, DbPurpose>;

const BASE_TO_DB = {
  on_duty: 'ON_DUTY',
  assigned: 'ASSIGNED',
} as const satisfies Record<TeamAudienceBase, DbAudienceBase>;

const POLICY_FROM_DB = {
  IMMEDIATE: 'immediate',
  FROZEN_RECHECK: 'frozen_recheck',
} as const satisfies Record<DbSchedulePolicy, TeamSchedulePolicy>;

function invert<K extends string, V extends string>(
  map: Record<K, V>,
): Record<V, K> {
  return Object.fromEntries(
    Object.entries<V>(map).map(([api, db]) => [db, api]),
  ) as Record<V, K>;
}

const PURPOSE_FROM_DB = invert<TeamPurpose, DbPurpose>(PURPOSE_TO_DB);
const BASE_FROM_DB = invert<TeamAudienceBase, DbAudienceBase>(BASE_TO_DB);

/**
 * Valor do banco sem entrada no mapa (enum novo sem conversão, dado corrompido):
 * erro explícito com o valor recebido, nunca `undefined` com tipo não nulo.
 */
function fromMap<V extends string>(
  map: Record<string, V>,
  db: string,
  kind: string,
): V {
  if (!Object.hasOwn(map, db)) {
    throw new Error(`${kind} do banco sem conversão para a API: ${db}`);
  }
  return map[db];
}

export const toDbPurpose = (purpose: TeamPurpose): DbPurpose =>
  PURPOSE_TO_DB[purpose];

export function fromDbPurpose(db: DbPurpose): TeamPurpose;
export function fromDbPurpose(db: DbPurpose | null): TeamPurpose | null;
export function fromDbPurpose(db: DbPurpose | null): TeamPurpose | null {
  return db === null ? null : fromMap(PURPOSE_FROM_DB, db, 'finalidade');
}

export const toDbBase = (base: TeamAudienceBase): DbAudienceBase =>
  BASE_TO_DB[base];

export function fromDbBase(db: DbAudienceBase): TeamAudienceBase;
export function fromDbBase(db: DbAudienceBase | null): TeamAudienceBase | null;
export function fromDbBase(db: DbAudienceBase | null): TeamAudienceBase | null {
  return db === null ? null : fromMap(BASE_FROM_DB, db, 'base');
}

/** Só leitura: o F não escreve `schedulePolicy` (GF13); a ida chega no Lote G. */
export function fromDbPolicy(db: DbSchedulePolicy): TeamSchedulePolicy;
export function fromDbPolicy(
  db: DbSchedulePolicy | null,
): TeamSchedulePolicy | null;
export function fromDbPolicy(
  db: DbSchedulePolicy | null,
): TeamSchedulePolicy | null {
  return db === null ? null : fromMap(POLICY_FROM_DB, db, 'política');
}
