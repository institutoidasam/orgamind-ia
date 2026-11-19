import { nameView, phoneView } from '../../shared/authz/phone-visibility';
import {
  formatDateCell,
  formatPhoneCell,
  yesNo,
} from '../../shared/spreadsheet/cell-rules';
import {
  AUTHORIZATION_SOURCE_CELL,
  PEOPLE_EXPORT_COLUMNS,
  PERSON_STATUS_CELL,
  type AuthorizationSourceCode,
  type PeopleColumn,
} from '../../shared/spreadsheet/people-columns';
import type { CivilDate } from '../staff-schedule/civil-date';
import {
  assignmentOn,
  type AssignmentLine,
  type AssignmentValues,
} from '../users/assignment-timeline';

/** Candidato do índice (1ª passada): sem e-mail, o vínculo é o espelho de hoje. */
export type PeopleCandidateRow = {
  id: string;
  name: string | null;
  hasAccess: boolean;
} & AssignmentValues;

/** Campos das células (2ª passada); também sem e-mail. */
export type PeopleDetailRow = {
  id: string;
  registration: string | null;
  name: string | null;
  phoneE164: string | null;
  jobTitle: string | null;
  contactAuthorization: 'AUTORIZADO' | 'NAO_AUTORIZADO';
  authorizationSource: AuthorizationSourceCode | null;
  authorizationNote: string | null;
  authorizationDate: CivilDate | null;
  isActive: boolean;
  hasAccess: boolean;
};

/** Nomes por id, inclusive de setor, turno e nível inativos. */
export type ExportNameMaps = {
  sectors: ReadonlyMap<string, string>;
  shifts: ReadonlyMap<string, string>;
  levels: ReadonlyMap<string, string>;
};

/** `reach` nulo só vale para ADMIN; quem não é ADMIN sem `reach` não enxerga ninguém. */
export type ExportViewer = {
  isAdmin: boolean;
  fullPhone: boolean;
  reach: readonly string[] | null;
};

export type PeopleSelection = {
  sectorIds: readonly string[] | null;
  shiftId: string | null;
  date: CivilDate;
  today: CivilDate;
};

export type PeopleIndexEntry = {
  id: string;
  sectorName: string | null;
  displayName: string;
  phoneFull: boolean;
  assignment: AssignmentValues;
};

const COLLATOR = new Intl.Collator('pt-BR');

/** `allowed` nulo = sem restrição (filtro opcional); pessoa sem setor só passa sem restrição. */
function inSectors(
  allowed: readonly string[] | null,
  sectorId: string | null,
): boolean {
  if (allowed === null) return true;
  return sectorId !== null && allowed.includes(sectorId);
}

/** Alcance do ator: ADMIN vê tudo; os demais só os setores de `reach` (nulo = nenhum). */
function inReach(viewer: ExportViewer, sectorId: string | null): boolean {
  if (viewer.isAdmin) return true;
  return viewer.reach !== null && inSectors(viewer.reach, sectorId);
}

/** DX5: setor e turno pedidos e alcance, conferidos de novo sobre o vínculo da data. */
function matchesSelection(
  assignment: AssignmentValues,
  selection: PeopleSelection,
  viewer: ExportViewer,
): boolean {
  if (!inSectors(selection.sectorIds, assignment.sectorId)) return false;
  if (selection.shiftId !== null && assignment.shiftId !== selection.shiftId)
    return false;
  return inReach(viewer, assignment.sectorId);
}

/**
 * DX6/GX4: telefone completo com a chave e (ADMIN, ou pessoa sem login que HOJE
 * está no alcance). O alcance usa o espelho (setor de hoje), não o da data.
 */
function phoneFullFor(row: PeopleCandidateRow, viewer: ExportViewer): boolean {
  if (!viewer.fullPhone) return false;
  if (viewer.isAdmin) return true;
  return !row.hasAccess && inReach(viewer, row.sectorId);
}

function nameOf(
  names: ReadonlyMap<string, string>,
  id: string | null,
): string | null {
  return id === null ? null : (names.get(id) ?? null);
}

/** 1ª passada: null = fora do filtro ou do alcance na data de referência. */
export function selectIndexEntry(input: {
  row: PeopleCandidateRow;
  lines: readonly AssignmentLine[];
  selection: PeopleSelection;
  viewer: ExportViewer;
  names: ExportNameMaps;
}): PeopleIndexEntry | null {
  const { row, lines, selection, viewer, names } = input;
  const assignment = assignmentOn({
    mirror: {
      sectorId: row.sectorId,
      shiftId: row.shiftId,
      levelId: row.levelId,
    },
    lines,
    date: selection.date,
    today: selection.today,
  });
  if (!matchesSelection(assignment, selection, viewer)) return null;
  const phoneFull = phoneFullFor(row, viewer);
  return {
    id: row.id,
    sectorName: nameOf(names.sectors, assignment.sectorId),
    // Nome nulo sai vazio; o e-mail nunca substitui o nome no arquivo.
    displayName: nameView(row.name ?? '', { full: phoneFull }),
    phoneFull,
    assignment,
  };
}

function compareNullsLast(a: string | null, b: string | null): number {
  if (a === null || b === null) return Number(a === null) - Number(b === null);
  return COLLATOR.compare(a, b);
}

function compareIds(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** DX7: setor da data (sem setor por último), nome como sai no arquivo, id. */
export function comparePeopleEntries(
  a: PeopleIndexEntry,
  b: PeopleIndexEntry,
): number {
  return (
    compareNullsLast(a.sectorName, b.sectorName) ||
    COLLATOR.compare(a.displayName, b.displayName) ||
    compareIds(a.id, b.id)
  );
}

function phoneCell(detail: PeopleDetailRow, full: boolean): string {
  if (!detail.phoneE164) return '';
  if (full) return formatPhoneCell(detail.phoneE164);
  return phoneView(detail.phoneE164, { full: false }).phoneMasked ?? '';
}

function assignmentCells(
  assignment: AssignmentValues,
  names: ExportNameMaps,
): Pick<Record<PeopleColumn, string>, 'setor' | 'turno' | 'nivel'> {
  return {
    setor: nameOf(names.sectors, assignment.sectorId) ?? '',
    turno: nameOf(names.shifts, assignment.shiftId) ?? '',
    nivel: nameOf(names.levels, assignment.levelId) ?? '',
  };
}

function authorizationCells(
  detail: PeopleDetailRow,
): Pick<
  Record<PeopleColumn, string>,
  | 'autorizacao_contato'
  | 'origem_autorizacao'
  | 'detalhe_origem'
  | 'data_autorizacao'
> {
  const { authorizationSource: source, authorizationDate: date } = detail;
  return {
    autorizacao_contato: yesNo(detail.contactAuthorization === 'AUTORIZADO'),
    origem_autorizacao: source ? AUTHORIZATION_SOURCE_CELL[source] : '',
    detalhe_origem: detail.authorizationNote ?? '',
    data_autorizacao: date ? formatDateCell(date) : '',
  };
}

/**
 * 2ª passada: as 13 colunas como texto cru (sem apóstrofo; ele é do escritor de
 * CSV). O telefone sai completo só com `entry.phoneFull` e (ADMIN ou sem login
 * agora): quem ganhou login entre as passadas sai mascarado, e o nome que é o
 * próprio telefone acompanha. A posição da linha segue a do índice.
 */
export function peopleCells(input: {
  detail: PeopleDetailRow;
  entry: PeopleIndexEntry;
  names: ExportNameMaps;
  viewer: ExportViewer;
}): string[] {
  const { detail, entry, names, viewer } = input;
  const phoneFull = entry.phoneFull && (viewer.isAdmin || !detail.hasAccess);
  const cells: Record<PeopleColumn, string> = {
    matricula: detail.registration ?? '',
    nome: phoneFull
      ? entry.displayName
      : nameView(entry.displayName, { full: false }),
    telefone: phoneCell(detail, phoneFull),
    funcao: detail.jobTitle ?? '',
    ...assignmentCells(entry.assignment, names),
    ...authorizationCells(detail),
    situacao: detail.isActive
      ? PERSON_STATUS_CELL.active
      : PERSON_STATUS_CELL.inactive,
    tem_acesso: yesNo(detail.hasAccess),
  };
  return PEOPLE_EXPORT_COLUMNS.map((column) => cells[column]);
}
