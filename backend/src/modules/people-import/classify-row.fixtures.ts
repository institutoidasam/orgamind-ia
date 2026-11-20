import { IMPORT_FIELDS } from '../../schemas/contracts/people-import.schema';
import { brazilianPhoneVariants } from '../contacts/phone.util';
import type { CivilDate } from '../staff-schedule/civil-date';
import {
  parseAuthorizationCells,
  type AuthorizationCells,
} from './authorization-plan';
import { parseFields, type ParsedFields, type RawFields } from './cell-values';
import { classifyRow, type PeopleLookup } from './classify-row';
import type { ImportActor } from './import-actor';
import type { ImportPerson, RowVerdict } from './import-person';
import {
  structureName,
  type StructureCatalog,
  type StructureOption,
} from './structure-match';

/**
 * Fábricas só dos specs de classificação (T10). Ator nenhum: os specs montam o
 * ator com `toImportActor(actorWith(...))` (revisão 1, M9).
 */
export const TODAY: CivilDate = '2026-11-19';

function option(id: string, name: string, isActive = true): StructureOption {
  return { id, name, code: null, isActive };
}

export const CATALOG: StructureCatalog = {
  sector: [
    option('s-prod', 'Produção'),
    option('s-log', 'Logística'),
    option('s-old', 'Galpão Antigo', false),
  ],
  shift: [option('sh-man', 'Manhã'), option('sh-not', 'Noite')],
  level: [option('lv-op', 'Operacional')],
};

/** Marina, no setor Produção, sem login, com telefone e matrícula. */
export function personWith(
  overrides: Partial<ImportPerson> = {},
): ImportPerson {
  return {
    id: 'p-marina',
    name: 'Marina Souza',
    phoneE164: '+5592991110001',
    registration: 'MAT-01',
    registrationKey: 'mat-01',
    jobTitle: 'Analista',
    sectorId: 's-prod',
    shiftId: 'sh-man',
    levelId: 'lv-op',
    authorization: {
      status: 'NAO_AUTORIZADO',
      source: null,
      note: null,
      date: null,
    },
    isActive: true,
    hasAccess: false,
    ...overrides,
  };
}

/** As células que repetem o cadastro da pessoa (setor, turno e nível pelo nome). */
export function cellsOf(person: ImportPerson): Partial<RawFields> {
  return {
    registration: person.registration ?? '',
    name: person.name ?? '',
    phone: person.phoneE164 ?? '',
    jobTitle: person.jobTitle ?? '',
    sector: structureName(CATALOG, 'sector', person.sectorId) ?? '',
    shift: structureName(CATALOG, 'shift', person.shiftId) ?? '',
    level: structureName(CATALOG, 'level', person.levelId) ?? '',
  };
}

/** A linha lida como a T15 a lê: campos (T6) e autorização (T8). */
export function rowOf(cells: Partial<RawFields>): {
  fields: ParsedFields;
  authorization: AuthorizationCells;
} {
  const raw = Object.fromEntries(
    IMPORT_FIELDS.map((field) => [field, cells[field] ?? '']),
  ) as RawFields;
  return {
    fields: parseFields(raw),
    authorization: parseAuthorizationCells(raw, TODAY),
  };
}

/** Mapa que anota toda leitura (`get`, `has`, `size`, iteração). */
function readTracked<V>(
  map: Map<string, V>,
  reads: string[],
): ReadonlyMap<string, V> {
  return new Proxy(map, {
    get(target, property) {
      reads.push(String(property));
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== 'function') return value;
      const method = value as (this: unknown, ...args: unknown[]) => unknown;
      return (...args: unknown[]): unknown => method.apply(target, args);
    },
  });
}

/** Lookup como o `buildLookup` (T15): `byPhone` por cada grafia, com as leituras anotadas. */
export function lookupOf(people: readonly ImportPerson[]): {
  lookup: PeopleLookup;
  phoneReads: string[];
} {
  const byRegistrationKey = new Map<string, ImportPerson>();
  const byPhone = new Map<string, ImportPerson>();
  for (const person of people) {
    if (person.registrationKey) {
      byRegistrationKey.set(person.registrationKey, person);
    }
    const phones = person.phoneE164
      ? brazilianPhoneVariants(person.phoneE164)
      : [];
    for (const phone of phones) byPhone.set(phone, person);
  }
  const phoneReads: string[] = [];
  return {
    lookup: { byRegistrationKey, byPhone: readTracked(byPhone, phoneReads) },
    phoneReads,
  };
}

/** `classifyRow` com o catálogo e o dia das fábricas. */
export function classifyWith(input: {
  actor: ImportActor;
  cells: Partial<RawFields>;
  people?: readonly ImportPerson[];
  lookup?: PeopleLookup;
}): RowVerdict {
  const lookup = input.lookup ?? lookupOf(input.people ?? []).lookup;
  return classifyRow({
    ...rowOf(input.cells),
    lookup,
    catalog: CATALOG,
    actor: input.actor,
    today: TODAY,
  });
}
