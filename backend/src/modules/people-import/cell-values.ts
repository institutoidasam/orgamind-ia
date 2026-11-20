import {
  IMPORT_FIELDS,
  type ColumnMapping,
  type ImportField,
} from '../../schemas/contracts/people-import.schema';
import { normalizeToE164 } from '../contacts/phone.util';
import { normalizeJobTitle } from '../users/users.service';
import { normalizeRegistration } from '../users/person-record';
import type { RowCells } from './import-person';
import { ROW_TEXT } from './row-texts';

/** Texto de cada campo da linha, aparado; '' = vazio ou coluna não mapeada. */
export type RawFields = Record<ImportField, string>;

export type ParsedFields = {
  /** Todos os campos mapeados vazios (EX31). */
  isBlank: boolean;
  /** Matrícula `EXEMPLO`, sem diferenciar caixa: a linha do modelo. */
  isExample: boolean;
  registration: { value: string; key: string } | null;
  /** Nome mascarado (`•••• 2008`) conta como vazio: `name` nulo e `nameMasked`. */
  name: string | null;
  nameMasked: boolean;
  /** Telefone mascarado conta como vazio: `phoneE164` nulo e `phoneMasked`. */
  phoneE164: string | null;
  phoneMasked: boolean;
  jobTitle: string | null;
  sector: string | null;
  shift: string | null;
  level: string | null;
  /** Motivos de linha Inválida (`tooLong`, `invalidPhone`), na ordem dos campos. */
  errors: string[];
};

const MAX_NAME = 120;
const MAX_JOB_TITLE = 80;
const MAX_REGISTRATION = 30;
const EXAMPLE_REGISTRATION = 'exemplo';

/** As duas formas de `maskPhone`: `•••• NNNN` e `••••` sozinho. */
const MASKED_PHONE = /^•{4}(?: \d{4})?$/;

/** ['a', 'b'] → { '0': 'a', '1': 'b' }, como gravado em `PeopleImportRow.cells`. */
export function rowCellsOf(cells: readonly string[]): RowCells {
  return Object.fromEntries(cells.map((cell, index) => [String(index), cell]));
}

/** Lê só as colunas mapeadas; coluna ausente na linha vale vazio. */
export function fieldsOf(cells: RowCells, mapping: ColumnMapping): RawFields {
  const fields = {} as RawFields;
  for (const field of IMPORT_FIELDS) {
    const column = mapping[field];
    fields[field] = column === null ? '' : (cells[String(column)] ?? '').trim();
  }
  return fields;
}

/**
 * Texto que `phoneView`/`nameView` produzem para quem não vê o telefone
 * completo: exatamente `•••• NNNN` ou `••••`, nada além.
 */
export function isMaskedPhoneText(text: string): boolean {
  return MASKED_PHONE.test(text);
}

function textOrNull(text: string): string | null {
  return text === '' ? null : text;
}

function tooLongReason(label: string, text: string, max: number): string[] {
  return text.length > max ? [ROW_TEXT.tooLong(label, max)] : [];
}

function parsePhone(text: string): {
  phoneE164: string | null;
  phoneMasked: boolean;
  errors: string[];
} {
  if (text === '') return { phoneE164: null, phoneMasked: false, errors: [] };
  if (isMaskedPhoneText(text))
    return { phoneE164: null, phoneMasked: true, errors: [] };
  const phoneE164 = normalizeToE164(text, 'BR');
  return {
    phoneE164,
    phoneMasked: false,
    errors: phoneE164 ? [] : [ROW_TEXT.invalidPhone],
  };
}

function parseRegistration(text: string): ParsedFields['registration'] {
  const { registration, registrationKey } = normalizeRegistration(text);
  return registration && registrationKey
    ? { value: registration, key: registrationKey }
    : null;
}

/**
 * Valida e normaliza os campos de identidade e cadastro (a autorização é da
 * T8, a estrutura da T7). Mesma normalização do cadastro: telefone E.164 pelo
 * `normalizeToE164`, matrícula e função pelos normalizadores do cadastro.
 * `errors` não vazio = linha Inválida; os valores seguem preenchidos para a
 * prévia e a detecção de repetidas, e quem classifica não grava a linha.
 */
export function parseFields(raw: RawFields): ParsedFields {
  const phone = parsePhone(raw.phone);
  const nameMasked = isMaskedPhoneText(raw.name);
  return {
    isBlank: IMPORT_FIELDS.every((field) => raw[field] === ''),
    isExample: raw.registration.toLowerCase() === EXAMPLE_REGISTRATION,
    registration: parseRegistration(raw.registration),
    name: nameMasked ? null : textOrNull(raw.name),
    nameMasked,
    phoneE164: phone.phoneE164,
    phoneMasked: phone.phoneMasked,
    jobTitle: normalizeJobTitle(raw.jobTitle),
    sector: textOrNull(raw.sector),
    shift: textOrNull(raw.shift),
    level: textOrNull(raw.level),
    errors: [
      ...tooLongReason('Matrícula', raw.registration, MAX_REGISTRATION),
      ...tooLongReason('Nome', raw.name, MAX_NAME),
      ...phone.errors,
      ...tooLongReason('Função', raw.jobTitle, MAX_JOB_TITLE),
    ],
  };
}
