import { createHash } from 'node:crypto';
import type { ContactAuthorizationInput } from '../../schemas/contracts/contact-authorization.schema';
import { formatDateCell } from '../../shared/spreadsheet/cell-rules';
import { AUTHORIZATION_SOURCE_CELL } from '../../shared/spreadsheet/people-columns';
import { brazilianPhoneVariants } from '../contacts/phone.util';
import { normalizeRegistration } from '../users/person-record';
import { normalizeJobTitle } from '../users/users.service';
import { authorizationSatisfied } from './authorization-plan';
import type {
  AuthorizationNow,
  DiffField,
  FieldDiff,
  ImportPatch,
  ImportPerson,
} from './import-person';
import { structureName, type StructureCatalog } from './structure-match';

/**
 * A linha já resolvida (T10): `null` = célula vazia (ou fora do alcance por
 * EX17, como o telefone de quem não o vê): não altera o campo.
 */
export type ResolvedRow = {
  name: string | null;
  phoneE164: string | null;
  jobTitle: string | null;
  registration: string | null;
  sectorId: string | null;
  shiftId: string | null;
  levelId: string | null;
  authorization: ContactAuthorizationInput | null;
};

type PatchKey = keyof ImportPatch;
type Display = {
  field: DiffField;
  before: (person: ImportPerson, catalog: StructureCatalog) => string | null;
  after: (patch: ImportPatch, catalog: StructureCatalog) => string | null;
};

const SAVE_DATE_TEXT = 'data da gravação';
const NO_DATE_TEXT = 'sem data registrada';
const NOT_AUTHORIZED_TEXT = 'Não';
const SEPARATOR = ' — ';

/** Telefone: as duas grafias do nono dígito são o mesmo número (EX33). */
export function samePhone(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  return brazilianPhoneVariants(a).includes(b);
}

/** A origem "Outro" é a única que guarda detalhe (como `authorizationSatisfied`). */
function shownNote(value: AuthorizationNow | ContactAuthorizationInput) {
  if (value.status !== 'AUTORIZADO' || value.source !== 'OUTRO') return null;
  return value.note?.trim() || null;
}

/**
 * `null` = estado gravado sem data (ex.: backfill de Cadastro anterior);
 * ausente = entrada sem data, que a gravação completa com hoje.
 */
function dateText(date: AuthorizationNow['date'] | undefined): string {
  if (date === null) return NO_DATE_TEXT;
  return date ? formatDateCell(date) : SAVE_DATE_TEXT;
}

/**
 * `Não` ou `Sim — <origem>[ — <detalhe>] — DD/MM/AAAA`; sem data: "sem data
 * registrada" no estado gravado, "data da gravação" na entrada.
 */
export function authorizationLabel(
  value: AuthorizationNow | ContactAuthorizationInput,
): string {
  if (value.status === 'NAO_AUTORIZADO') return NOT_AUTHORIZED_TEXT;
  const source = value.source ? AUTHORIZATION_SOURCE_CELL[value.source] : null;
  return ['Sim', source, shownNote(value), dateText(value.date)]
    .filter((part) => part !== null)
    .join(SEPARATOR);
}

/**
 * Cada campo do patch já é o atual? Campo ausente do patch conta como já
 * atual: o que o patch não traz nunca é comparado (EX17.1, E4).
 */
const SATISFIED: Record<
  PatchKey,
  (person: ImportPerson, patch: ImportPatch) => boolean
> = {
  name: (p, x) =>
    x.name === undefined || (p.name ?? '').trim() === x.name.trim(),
  phone: (p, x) => x.phone === undefined || samePhone(p.phoneE164, x.phone),
  registration: (p, x) =>
    x.registration === undefined ||
    p.registrationKey === normalizeRegistration(x.registration).registrationKey,
  jobTitle: (p, x) =>
    x.jobTitle === undefined ||
    normalizeJobTitle(p.jobTitle) === normalizeJobTitle(x.jobTitle),
  sectorId: (p, x) => x.sectorId === undefined || p.sectorId === x.sectorId,
  shiftId: (p, x) => x.shiftId === undefined || p.shiftId === x.shiftId,
  levelId: (p, x) => x.levelId === undefined || p.levelId === x.levelId,
  contactAuthorization: (p, x) =>
    x.contactAuthorization === undefined ||
    authorizationSatisfied(p.authorization, x.contactAuthorization),
};

/** Na ordem de `DiffField`: é a ordem do diff. */
const PATCH_KEYS = Object.keys(SATISFIED) as PatchKey[];

const DISPLAY: Record<PatchKey, Display> = {
  name: { field: 'name', before: (p) => p.name, after: (x) => x.name ?? null },
  phone: {
    field: 'phone',
    before: (p) => p.phoneE164,
    after: (x) => x.phone ?? null,
  },
  registration: {
    field: 'registration',
    before: (p) => p.registration,
    after: (x) => x.registration ?? null,
  },
  jobTitle: {
    field: 'jobTitle',
    before: (p) => p.jobTitle,
    after: (x) => x.jobTitle ?? null,
  },
  sectorId: {
    field: 'sector',
    before: (p, c) => structureName(c, 'sector', p.sectorId),
    after: (x, c) => structureName(c, 'sector', x.sectorId ?? null),
  },
  shiftId: {
    field: 'shift',
    before: (p, c) => structureName(c, 'shift', p.shiftId),
    after: (x, c) => structureName(c, 'shift', x.shiftId ?? null),
  },
  levelId: {
    field: 'level',
    before: (p, c) => structureName(c, 'level', p.levelId),
    after: (x, c) => structureName(c, 'level', x.levelId ?? null),
  },
  contactAuthorization: {
    field: 'authorization',
    before: (p) => authorizationLabel(p.authorization),
    after: (x) =>
      x.contactAuthorization
        ? authorizationLabel(x.contactAuthorization)
        : null,
  },
};

/** Texto aparado; vazio vira `undefined` (não altera). */
function filled(value: string | null): string | undefined {
  return value?.trim() || undefined;
}

/** O que a linha propõe, já normalizado como o cadastro: só o que traz valor. */
function proposalOf(row: ResolvedRow): ImportPatch {
  return {
    name: filled(row.name),
    phone: row.phoneE164 ?? undefined,
    registration:
      normalizeRegistration(row.registration).registration ?? undefined,
    jobTitle: normalizeJobTitle(row.jobTitle) ?? undefined,
    sectorId: row.sectorId ?? undefined,
    shiftId: row.shiftId ?? undefined,
    levelId: row.levelId ?? undefined,
    contactAuthorization: row.authorization ?? undefined,
  };
}

/**
 * O patch e o antes → depois da linha para a pessoa. Campo entra só se a linha
 * traz valor e ele difere do atual (EX33): matrícula pela chave, telefone pelas
 * duas grafias, nome e função depois do `trim`, setor, turno e nível pelo id,
 * autorização por `authorizationSatisfied`. O diff guarda nome e telefone crus
 * (GX8): quem mascara é a leitura.
 */
export function diffPerson(input: {
  person: ImportPerson;
  row: ResolvedRow;
  catalog: StructureCatalog;
}): { patch: ImportPatch; diff: FieldDiff[] } {
  const { person, row, catalog } = input;
  const proposal = proposalOf(row);
  const patch: ImportPatch = {};
  const diff: FieldDiff[] = [];
  for (const key of PATCH_KEYS) {
    if (SATISFIED[key](person, proposal)) continue;
    Object.assign(patch, { [key]: proposal[key] });
    const shown = DISPLAY[key];
    diff.push({
      field: shown.field,
      before: shown.before(person, catalog),
      after: shown.after(proposal, catalog),
    });
  }
  return { patch, diff };
}

/** Cada campo do patch já é o atual (spec E6: "Sem alteração" na gravação). */
export function patchSatisfied(
  person: ImportPerson,
  patch: ImportPatch,
): boolean {
  return PATCH_KEYS.every((key) => SATISFIED[key](person, patch));
}

/**
 * Versão da pessoa (EX12): SHA-256 do JSON canônico, sem o `id` e sem a chave
 * da matrícula (derivada da matrícula). Ordem fixa dos campos; a gravação
 * compara com o da prévia.
 */
export function personFingerprint(person: ImportPerson): string {
  const { authorization: auth } = person;
  const canonical = {
    name: person.name,
    phoneE164: person.phoneE164,
    registration: person.registration,
    jobTitle: person.jobTitle,
    sectorId: person.sectorId,
    shiftId: person.shiftId,
    levelId: person.levelId,
    authorization: {
      status: auth.status,
      source: auth.source,
      note: auth.note,
      date: auth.date,
    },
    isActive: person.isActive,
    hasAccess: person.hasAccess,
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}
