import type { ContactAuthorizationInput } from '../../schemas/contracts/contact-authorization.schema';
import type { ImportField } from '../../schemas/contracts/people-import.schema';
import {
  AUTHORIZATION_SOURCE_CELL,
  type AuthorizationSourceCode,
} from '../../shared/spreadsheet/people-columns';
import { isCivilDate, type CivilDate } from '../staff-schedule/civil-date';
import type { AuthorizationNow } from './import-person';
import { ROW_TEXT } from './row-texts';

/** As quatro colunas de autorização de `RawFields` (T6); o resto não entra aqui. */
export type AuthorizationRaw = Pick<
  Record<ImportField, string>,
  | 'authorization'
  | 'authorizationSource'
  | 'authorizationNote'
  | 'authorizationDate'
>;

export type AuthorizationCells = {
  answer: 'yes' | 'no' | null;
  source: AuthorizationSourceCode | null;
  sourceGiven: boolean;
  note: string | null;
  date: CivilDate | null;
  errors: string[];
};

/**
 * `input` nulo = a planilha não mexe na autorização da pessoa. `errors` = o
 * que invalida a linha (só erro de célula de quem pode alterar a autorização).
 */
export type AuthorizationPlan = {
  input: ContactAuthorizationInput | null;
  warnings: string[];
  errors: string[];
};

type Authorized = Extract<ContactAuthorizationInput, { status: 'AUTORIZADO' }>;
type Parsed<T> = { value: T; error: string | null };

const YES_ANSWERS = new Set(['sim', 's', 'x', '1']);
const NO_ANSWERS = new Set(['nao', 'n', '0']);
const NOTE_LABEL = 'Detalhe da origem';
const NOTE_MAX_LENGTH = 120;
const DAY_MONTH_YEAR = /^(\d{2})\/(\d{2})\/(\d{4})$/;

/** Não mexe na autorização nem invalida a linha; só os avisos. */
function ignored(warnings: string[] = []): AuthorizationPlan {
  return { input: null, warnings, errors: [] };
}

/** Sem caixa, sem acento e com espaços colapsados. */
function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

const SOURCE_BY_LABEL: ReadonlyMap<string, AuthorizationSourceCode> = new Map(
  (
    Object.entries(AUTHORIZATION_SOURCE_CELL) as [
      AuthorizationSourceCode,
      string,
    ][]
  ).map(([code, label]) => [fold(label), code]),
);

function parseAnswer(text: string): Parsed<'yes' | 'no' | null> {
  const key = fold(text);
  if (key === '') return { value: null, error: null };
  if (YES_ANSWERS.has(key)) return { value: 'yes', error: null };
  if (NO_ANSWERS.has(key)) return { value: 'no', error: null };
  return { value: null, error: ROW_TEXT.invalidYesNo };
}

function parseNote(text: string): Parsed<string | null> {
  const note = text.trim();
  if (note === '') return { value: null, error: null };
  if (note.length > NOTE_MAX_LENGTH) {
    return {
      value: null,
      error: ROW_TEXT.tooLong(NOTE_LABEL, NOTE_MAX_LENGTH),
    };
  }
  return { value: note, error: null };
}

/** `DD/MM/AAAA` ou `AAAA-MM-DD`, data real do calendário; senão `null`. */
function toCivilDate(text: string): CivilDate | null {
  const dayMonthYear = DAY_MONTH_YEAR.exec(text);
  const iso = dayMonthYear
    ? `${dayMonthYear[3]}-${dayMonthYear[2]}-${dayMonthYear[1]}`
    : text;
  return isCivilDate(iso) ? iso : null;
}

function parseDate(text: string, today: CivilDate): Parsed<CivilDate | null> {
  const trimmed = text.trim();
  if (trimmed === '') return { value: null, error: null };
  const date = toCivilDate(trimmed);
  if (date === null) return { value: null, error: ROW_TEXT.invalidDate };
  if (date > today) return { value: null, error: ROW_TEXT.futureDate };
  return { value: date, error: null };
}

/**
 * Lê as quatro colunas de autorização de uma linha (CX7). Origem pelo rótulo
 * de `AUTHORIZATION_SOURCE_CELL`; texto sem par fica sem origem (`sourceGiven`).
 */
export function parseAuthorizationCells(
  raw: AuthorizationRaw,
  today: CivilDate,
): AuthorizationCells {
  const answer = parseAnswer(raw.authorization);
  const note = parseNote(raw.authorizationNote);
  const date = parseDate(raw.authorizationDate, today);
  const sourceText = fold(raw.authorizationSource);
  return {
    answer: answer.value,
    source: SOURCE_BY_LABEL.get(sourceText) ?? null,
    sourceGiven: sourceText !== '',
    note: note.value,
    date: date.value,
    errors: [answer.error, note.error, date.error].filter(
      (error): error is string => error !== null,
    ),
  };
}

/** Só a origem "Outro" guarda texto; nas demais o serviço descarta a nota. */
function effectiveNote(input: Authorized): string {
  return input.source === 'OUTRO' ? (input.note ?? '') : '';
}

/**
 * `input` já é o que a pessoa tem? Autorizado: mesma origem e detalhe, e data
 * ausente (= mantém) ou igual. Não autorizado: basta o mesmo status.
 */
export function authorizationSatisfied(
  current: AuthorizationNow,
  input: ContactAuthorizationInput,
): boolean {
  if (input.status === 'NAO_AUTORIZADO') {
    return current.status === 'NAO_AUTORIZADO';
  }
  return (
    current.status === 'AUTORIZADO' &&
    current.source === input.source &&
    (current.note ?? '') === effectiveNote(input) &&
    (input.date === undefined || input.date === current.date)
  );
}

/**
 * Data vazia: a da pessoa já autorizada com a mesma origem, mesmo que o
 * detalhe mude (spec E4); senão ausente (= hoje na gravação).
 */
function authorizationDate(
  cells: AuthorizationCells,
  source: Authorized['source'],
  current: AuthorizationNow | null,
): CivilDate | null {
  if (cells.date !== null) return cells.date;
  const sameSource =
    current?.status === 'AUTORIZADO' && current.source === source;
  return sameSource ? current.date : null;
}

function authorizedInput(
  cells: AuthorizationCells,
  source: Authorized['source'],
  current: AuthorizationNow | null,
): Authorized {
  const input: Authorized = { status: 'AUTORIZADO', source };
  if (source === 'OUTRO' && cells.note !== null) input.note = cells.note;
  const date = authorizationDate(cells, source, current);
  if (date !== null) input.date = date;
  return input;
}

function isSameLegacyAuthorization(
  cells: AuthorizationCells,
  current: AuthorizationNow | null,
): boolean {
  return (
    cells.source === 'CADASTRO_ANTERIOR' &&
    current?.status === 'AUTORIZADO' &&
    current.source === 'CADASTRO_ANTERIOR'
  );
}

/** "Sim": só vale com origem aceita (e o detalhe, se Outro); nunca sem origem. */
function planYes(
  cells: AuthorizationCells,
  current: AuthorizationNow | null,
  newPerson: string[],
): AuthorizationPlan {
  const { source } = cells;
  if (isSameLegacyAuthorization(cells, current)) return ignored();
  if (source === null || source === 'CADASTRO_ANTERIOR') {
    return ignored([ROW_TEXT.authorizationWithoutSource, ...newPerson]);
  }
  if (source === 'OUTRO' && cells.note === null) {
    return ignored([ROW_TEXT.authorizationWithoutNote, ...newPerson]);
  }
  const input = authorizedInput(cells, source, current);
  if (current !== null && authorizationSatisfied(current, input)) {
    return ignored();
  }
  return { input, warnings: [], errors: [] };
}

function planAnswer(
  cells: AuthorizationCells,
  current: AuthorizationNow | null,
): AuthorizationPlan {
  const newPerson = current === null ? [ROW_TEXT.newWithoutAuthorization] : [];
  if (cells.answer === 'yes') return planYes(cells, current, newPerson);
  if (cells.answer === 'no' && current?.status === 'AUTORIZADO') {
    return ignored([ROW_TEXT.noRevoke]);
  }
  return ignored(newPerson);
}

/**
 * O que a planilha faz com a autorização de contato de uma linha (CX7, spec
 * E4). `current` nulo = pessoa nova. A planilha nunca retira autorização, "Sim"
 * sem origem não autoriza, e quem não pode alterá-la (`canEdit`, calculado pelo
 * chamador com `canEditContactAuthorization`) tem as colunas ignoradas, até as
 * com erro. Erro de célula de quem pode alterá-la invalida a linha (`errors`).
 */
export function planAuthorization(input: {
  cells: AuthorizationCells;
  current: AuthorizationNow | null;
  canEdit: boolean;
}): AuthorizationPlan {
  const { cells, current, canEdit } = input;
  const cannotEdit = ignored([ROW_TEXT.cannotEditAuthorization]);
  // Célula com erro: nada dela vira autorização; invalida a linha só de quem
  // pode alterar a autorização (de quem não pode, as colunas são ignoradas).
  if (cells.errors.length > 0) {
    return canEdit
      ? { input: null, warnings: [], errors: [...cells.errors] }
      : cannotEdit;
  }
  const plan = planAnswer(cells, current);
  return plan.input !== null && !canEdit ? cannotEdit : plan;
}
