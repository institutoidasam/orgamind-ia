import type { Prisma } from '@prisma/client';
import type { ContactAuthorizationInput } from '../../schemas/contracts/contact-authorization.schema';
import type { RowClass } from '../../schemas/contracts/people-import.schema';
import type { AuthorizationSourceCode } from '../../shared/spreadsheet/people-columns';
import type { CivilDate } from '../staff-schedule/civil-date';

/** Como gravado em `PeopleImportRow.cells`. */
export type RowCells = Readonly<Record<string, string>>;

export type AuthorizationNow = {
  status: 'AUTORIZADO' | 'NAO_AUTORIZADO';
  source: AuthorizationSourceCode | null;
  note: string | null;
  date: CivilDate | null;
};

export type ImportPerson = {
  id: string;
  name: string | null;
  phoneE164: string | null;
  registration: string | null;
  registrationKey: string | null;
  jobTitle: string | null;
  sectorId: string | null;
  shiftId: string | null;
  levelId: string | null;
  authorization: AuthorizationNow;
  isActive: boolean;
  hasAccess: boolean;
};

/** Subconjunto de `UserPatch` (T14). */
export type ImportPatch = {
  name?: string;
  phone?: string;
  jobTitle?: string;
  registration?: string;
  sectorId?: string;
  shiftId?: string;
  levelId?: string;
  contactAuthorization?: ContactAuthorizationInput;
};

export type DiffField =
  | 'name'
  | 'phone'
  | 'registration'
  | 'jobTitle'
  | 'sector'
  | 'shift'
  | 'level'
  | 'authorization';

/**
 * Texto de exibição: setor, turno e nível pelo nome; autorização por
 * `authorizationLabel`; telefone em E.164 e nome cru (mascarados na leitura, T17).
 */
export type FieldDiff = {
  field: DiffField;
  before: string | null;
  after: string | null;
};

export type RowKeys = {
  registrationKey: string | null;
  phoneE164: string | null;
};

/**
 * A T20a converte para `PersonWithoutAccessInput` (T14) com
 * `sectorId: input.sectorId ?? null` (lá o campo é obrigatório e anulável).
 */
export type CreatePlan = {
  name: string;
  phone: string;
  sectorId?: string;
  shiftId?: string;
  levelId?: string;
  jobTitle?: string;
  registration?: string;
  contactAuthorization?: ContactAuthorizationInput;
};

export type RowPlan =
  | { kind: 'create'; keys: RowKeys; input: CreatePlan }
  | {
      kind: 'update';
      keys: RowKeys;
      personId: string;
      fingerprint: string;
      patch: ImportPatch;
    };

export type RowPreview = { personName: string | null; diff: FieldDiff[] };

export type RowVerdict = {
  classification: RowClass;
  reasons: string[];
  warnings: string[];
  preview: RowPreview | null;
  plan: RowPlan | null;
  personId: string | null;
};

export type RowOutcome = {
  outcome: 'CREATED' | 'UPDATED' | 'UNCHANGED' | 'FAILED';
  reason: string | null;
  personId: string | null;
};

export type ImportEnding = 'COMPLETED' | 'CLOSED' | 'AUTO_CLOSED';

/** `phoneTaken` ⊂ `failed`: falhas por telefone já cadastrado (EX17.3). */
export type ImportResultCounts = {
  rows: number;
  created: number;
  updated: number;
  unchanged: number;
  invalid: number;
  duplicate: number;
  conflict: number;
  ignored: number;
  failed: number;
  phoneTaken: number;
  notWritten: number;
  writing: number;
};

export type TrailWriter<T> = (
  tx: Prisma.TransactionClient,
  data: T,
) => Promise<void>;
