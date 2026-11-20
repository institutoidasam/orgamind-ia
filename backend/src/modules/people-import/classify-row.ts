import { canEditContactAuthorization } from '../../shared/authz/person-actions.policy';
import type { RowClass } from '../../schemas/contracts/people-import.schema';
import { brazilianPhoneVariants } from '../contacts/phone.util';
import type { CivilDate } from '../staff-schedule/civil-date';
import {
  planAuthorization,
  type AuthorizationCells,
  type AuthorizationPlan,
} from './authorization-plan';
import type { ParsedFields } from './cell-values';
import { phoneFullFor, type ImportActor } from './import-actor';
import type {
  CreatePlan,
  ImportPerson,
  RowKeys,
  RowVerdict,
} from './import-person';
import { diffPerson, personFingerprint, type ResolvedRow } from './person-diff';
import { ROW_TEXT } from './row-texts';
import {
  matchStructure,
  type StructureCatalog,
  type StructureKind,
} from './structure-match';

/** Pessoas do lote; `byPhone` chaveado por cada grafia de `brazilianPhoneVariants`. */
export type PeopleLookup = {
  byRegistrationKey: ReadonlyMap<string, ImportPerson>;
  byPhone: ReadonlyMap<string, ImportPerson>;
};

export type ClassifyInput = {
  fields: ParsedFields;
  authorization: AuthorizationCells;
  lookup: PeopleLookup;
  catalog: StructureCatalog;
  actor: ImportActor;
  /** Dia da prévia; as células de autorização já chegam lidas com ele (T8). */
  today: CivilDate;
};

type StructureIds = Pick<ResolvedRow, 'sectorId' | 'shiftId' | 'levelId'>;
type Structure = { ids: StructureIds; reasons: string[] };
type OptionalCreateKey = Exclude<keyof CreatePlan, 'name' | 'phone'>;

const STRUCTURE_FIELDS: readonly [StructureKind, keyof StructureIds][] = [
  ['sector', 'sectorId'],
  ['shift', 'shiftId'],
  ['level', 'levelId'],
];

/** Pessoa nova nasce sem login (a importação nunca dá acesso). */
const NEW_PERSON = { hasAccess: false };

/** Linha que não entra: sem prévia, sem plano e sem pessoa (GX7). */
function rejected(classification: RowClass, reasons: string[]): RowVerdict {
  return {
    classification,
    reasons,
    warnings: [],
    preview: null,
    plan: null,
    personId: null,
  };
}

/** ADMIN e quem tem `telefone.ver_completo` (EX17); o `BatchClassifier` usa a mesma. */
export function seesFullPhone(actor: ImportActor): boolean {
  return actor.isAdmin || phoneFullFor(actor);
}

/**
 * Gêmeos de 8 e 9 dígitos (a mesma conta, duas pessoas cadastradas): as
 * variantes são lidas na ordem de `brazilianPhoneVariants`, com a grafia exata
 * da linha primeiro, e `buildLookup` deixa cada grafia gravada com o seu dono.
 * A linha acha o gêmeo que tem o número escrito como ela o trouxe, e não o da
 * forma canônica (`canonicalBrPhoneForm`, 13 dígitos): é desempate de leitura.
 */
function findByPhone(
  lookup: PeopleLookup,
  phoneE164: string,
): ImportPerson | null {
  for (const variant of brazilianPhoneVariants(phoneE164)) {
    const person = lookup.byPhone.get(variant);
    if (person) return person;
  }
  return null;
}

/**
 * Identifica a pessoa da linha (EX15 passos 5 e 7): pela matrícula; se não
 * achou, pelo telefone, só para o ADMIN e quem tem `telefone.ver_completo`.
 * Quem não tem a chave não lê `lookup.byPhone` e nunca tem Conflito por
 * telefone (EX17.3). `conflict`: a matrícula achou uma pessoa e o telefone
 * outra; ou a achada só pelo telefone tem outra matrícula e a linha traz
 * matrícula. Achada só pelo telefone sem matrícula gravada: sem conflito.
 */
export function identify(input: {
  fields: ParsedFields;
  lookup: PeopleLookup;
  actor: ImportActor;
}): { person: ImportPerson | null; conflict: boolean } {
  const { fields, lookup, actor } = input;
  const key = fields.registration?.key ?? null;
  const byRegistration =
    key === null ? null : (lookup.byRegistrationKey.get(key) ?? null);
  if (!seesFullPhone(actor) || fields.phoneE164 === null) {
    return { person: byRegistration, conflict: false };
  }
  const byPhone = findByPhone(lookup, fields.phoneE164);
  if (byRegistration !== null) {
    const conflict = byPhone !== null && byPhone.id !== byRegistration.id;
    return { person: byRegistration, conflict };
  }
  if (byPhone === null) return { person: null, conflict: false };
  return { person: byPhone, conflict: hasOtherRegistration(byPhone, key) };
}

/** A pessoa já tem matrícula gravada e a linha traz outra (EX15 passo 7). */
function hasOtherRegistration(
  person: ImportPerson,
  key: string | null,
): boolean {
  if (key === null || person.registrationKey === null) return false;
  return person.registrationKey !== key;
}

/** EX15 passos 1, 3 e 4: só o que depende das próprias células, antes de identificar. */
function cellVerdict(fields: ParsedFields): RowVerdict | null {
  if (fields.isBlank) return rejected('IGNORED', [ROW_TEXT.blank]);
  if (fields.isExample) return rejected('IGNORED', [ROW_TEXT.example]);
  if (fields.registration === null && fields.phoneE164 === null) {
    return rejected('INVALID', [ROW_TEXT.noKey]);
  }
  if (fields.errors.length > 0) return rejected('INVALID', [...fields.errors]);
  return null;
}

/** GX6: pessoa existente hoje num setor do alcance e sem login. */
function canTouchPerson(actor: ImportActor, person: ImportPerson): boolean {
  if (actor.isAdmin) return true;
  const inReach =
    person.sectorId !== null && (actor.reach ?? []).includes(person.sectorId);
  return inReach && !person.hasAccess;
}

/** Setor, turno e nível das células preenchidas (CX8); o setor só no alcance. */
function resolveStructure(
  input: ClassifyInput,
  person: ImportPerson | null,
): Structure {
  const { fields, catalog, actor } = input;
  const ids: StructureIds = { sectorId: null, shiftId: null, levelId: null };
  const reasons: string[] = [];
  for (const [kind, idKey] of STRUCTURE_FIELDS) {
    const text = fields[kind];
    if (text === null) continue;
    const currentId = person?.[idKey] ?? null;
    const reach = actor.reach;
    const match = matchStructure({ kind, text, catalog, currentId, reach });
    if (match.ok) ids[idKey] = match.id;
    else reasons.push(match.reason);
  }
  return { ids, reasons };
}

/** Motivos de Inválida comuns às pessoas nova e existente, na ordem das colunas. */
function rowReasons(
  input: ClassifyInput,
  structure: Structure,
  authorization: AuthorizationPlan,
): string[] {
  const sectorMissing = !input.actor.isAdmin && input.fields.sector === null;
  return [
    ...(sectorMissing ? [ROW_TEXT.sectorRequired] : []),
    ...structure.reasons,
    ...authorization.errors,
  ];
}

/**
 * EX17.1: sem a chave, telefone já gravado não é alterado nem comparado, mesmo
 * igual ao da célula; a célula sai da linha com o aviso. Pessoa sem telefone
 * recebe o da célula sem conferir se está livre (EX17.2).
 */
function phoneFor(
  actor: ImportActor,
  person: ImportPerson,
  phoneE164: string | null,
): { phoneE164: string | null; warnings: string[] } {
  const locked = !seesFullPhone(actor) && person.phoneE164 !== null;
  if (phoneE164 !== null && locked) {
    return { phoneE164: null, warnings: [ROW_TEXT.cannotEditPhone] };
  }
  return { phoneE164, warnings: [] };
}

function keysOf(fields: ParsedFields, phoneE164: string | null): RowKeys {
  return { registrationKey: fields.registration?.key ?? null, phoneE164 };
}

/** EX15 passo 8: pessoa existente, já liberada pelas travas de alcance e login. */
function classifyExisting(
  input: ClassifyInput,
  person: ImportPerson,
): RowVerdict {
  const { fields, actor, catalog } = input;
  const structure = resolveStructure(input, person);
  const authorization = planAuthorization({
    cells: input.authorization,
    current: person.authorization,
    canEdit: canEditContactAuthorization(actor.policy, person),
  });
  const reasons = rowReasons(input, structure, authorization);
  if (reasons.length > 0) return rejected('INVALID', reasons);

  const phone = phoneFor(actor, person, fields.phoneE164);
  const row: ResolvedRow = {
    name: fields.name,
    phoneE164: phone.phoneE164,
    jobTitle: fields.jobTitle,
    registration: fields.registration?.value ?? null,
    ...structure.ids,
    authorization: authorization.input,
  };
  const { patch, diff } = diffPerson({ person, row, catalog });
  const warnings = [...phone.warnings, ...authorization.warnings];
  const preview = { personName: person.name, diff };
  const found = { reasons: [], preview, personId: person.id };
  if (diff.length === 0) {
    return { ...found, classification: 'UNCHANGED', warnings, plan: null };
  }
  if (!person.isActive) return rejected('INVALID', [ROW_TEXT.inactivePerson]);
  if (person.hasAccess && patch.sectorId !== undefined) {
    warnings.push(ROW_TEXT.mustLoginAgain);
  }
  const keys = keysOf(fields, phone.phoneE164);
  const fingerprint = personFingerprint(person);
  const plan = {
    kind: 'update' as const,
    keys,
    personId: person.id,
    fingerprint,
    patch,
  };
  return { ...found, classification: 'UPDATE', warnings, plan };
}

/** Nome e telefone da pessoa nova; nome ou telefone mascarado conta como vazio. */
function newPersonReasons(fields: ParsedFields): string[] {
  const reasons: string[] = [];
  if (fields.nameMasked) reasons.push(ROW_TEXT.invalidName);
  else if (fields.name === null) reasons.push(ROW_TEXT.newNeedsName);
  if (fields.phoneE164 === null) reasons.push(ROW_TEXT.newNeedsPhone);
  return reasons;
}

/** Só os campos opcionais com valor: o plano não leva chave vazia. */
function createPlan(
  required: Pick<CreatePlan, 'name' | 'phone'>,
  optional: { [K in OptionalCreateKey]-?: CreatePlan[K] | null },
): CreatePlan {
  const filled = Object.entries(optional).filter(([, value]) => value !== null);
  return { ...required, ...Object.fromEntries(filled) };
}

/**
 * EX15 passo 9: pessoa nova. Quem não tem a chave não consulta o telefone: a
 * linha sai como Criar mesmo que o número já exista (EX17.3); com a chave, o
 * dono do número já foi achado em `identify`.
 */
function classifyNew(input: ClassifyInput): RowVerdict {
  const { fields, actor } = input;
  const structure = resolveStructure(input, null);
  const authorization = planAuthorization({
    cells: input.authorization,
    current: null,
    canEdit: canEditContactAuthorization(actor.policy, NEW_PERSON),
  });
  const reasons = [
    ...newPersonReasons(fields),
    ...rowReasons(input, structure, authorization),
  ];
  if (reasons.length > 0 || fields.name === null || fields.phoneE164 === null) {
    return rejected('INVALID', reasons);
  }
  const create = createPlan(
    { name: fields.name, phone: fields.phoneE164 },
    {
      ...structure.ids,
      jobTitle: fields.jobTitle,
      registration: fields.registration?.value ?? null,
      contactAuthorization: authorization.input,
    },
  );
  const keys = keysOf(fields, fields.phoneE164);
  return {
    classification: 'CREATE',
    reasons: [],
    warnings: authorization.warnings,
    preview: null,
    plan: { kind: 'create', keys, input: create },
    personId: null,
  };
}

/**
 * Classifica uma linha (EX15–EX17, spec E4). A Duplicada (passo 2) é decidida
 * antes, para o lote inteiro (`duplicateOf`). Para quem não é ADMIN, a pessoa
 * fora do alcance ou com login dá sempre a mesma resposta (EX16), e as travas
 * de alcance, login e telefone vêm antes de "Sem alteração". O motivo nunca
 * revela outra pessoa (GX7). `personId` e `preview` só em Atualizar e Sem
 * alteração.
 */
export function classifyRow(input: ClassifyInput): RowVerdict {
  const early = cellVerdict(input.fields);
  if (early) return early;
  const { person, conflict } = identify(input);
  if (person === null) return classifyNew(input);
  if (!canTouchPerson(input.actor, person)) {
    return rejected('INVALID', [ROW_TEXT.cannotEditPerson]);
  }
  if (conflict) return rejected('CONFLICT', [ROW_TEXT.phoneTaken]);
  return classifyExisting(input, person);
}
