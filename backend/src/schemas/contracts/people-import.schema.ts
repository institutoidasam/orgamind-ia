import { z } from 'zod';
import { spreadsheetFormatSchema } from './people-export.schema';

/** Campos da pessoa que uma coluna da planilha pode alimentar (E3). */
export const IMPORT_FIELDS = [
  'registration',
  'name',
  'phone',
  'jobTitle',
  'sector',
  'shift',
  'level',
  'authorization',
  'authorizationSource',
  'authorizationNote',
  'authorizationDate',
] as const;
export type ImportField = (typeof IMPORT_FIELDS)[number];

export const IMPORT_FIELD_LABEL: Readonly<Record<ImportField, string>> = {
  registration: 'Matrícula',
  name: 'Nome',
  phone: 'Telefone',
  jobTitle: 'Função',
  sector: 'Setor',
  shift: 'Turno',
  level: 'Nível',
  authorization: 'Autorização de contato',
  authorizationSource: 'Origem da autorização',
  authorizationNote: 'Detalhe da origem',
  authorizationDate: 'Data da autorização',
};

/** Índice da coluna (0 = primeira) ou `null` = "Não usar". */
export type ColumnMapping = Record<ImportField, number | null>;

const columnIndex = z.number().int().min(0).nullable();

export const columnMappingSchema = z
  .object({
    registration: columnIndex,
    name: columnIndex,
    phone: columnIndex,
    jobTitle: columnIndex,
    sector: columnIndex,
    shift: columnIndex,
    level: columnIndex,
    authorization: columnIndex,
    authorizationSource: columnIndex,
    authorizationNote: columnIndex,
    authorizationDate: columnIndex,
  })
  .strict();

/** `PUT /internal/people-import/batches/:id/mapping`. */
export const mappingBodySchema = z
  .object({ mapping: columnMappingSchema })
  .refine(
    ({ mapping }) => {
      const used = Object.values(mapping).filter((i) => i !== null);
      return new Set(used).size === used.length;
    },
    { message: 'Cada coluna serve a um campo só.', path: ['mapping'] },
  );

export const ROW_CLASSES = [
  'CREATE',
  'UPDATE',
  'UNCHANGED',
  'INVALID',
  'DUPLICATE',
  'CONFLICT',
  'IGNORED',
] as const;
export type RowClass = (typeof ROW_CLASSES)[number];

export const IMPORT_ROWS_PAGE_SIZE = 50;
export const IMPORT_BATCHES_PAGE_SIZE = 20;

const pageParam = z.coerce.number().int().min(1).default(1);

/** `GET .../batches/:id/rows`. */
export const rowsQuerySchema = z.object({
  page: pageParam,
  classification: z.enum(ROW_CLASSES).optional(),
});

/** `GET .../batches`. */
export const batchListQuerySchema = z.object({ page: pageParam });

/**
 * `POST .../batches/:id/confirm` (EX7). Linha 1 é o cabeçalho: dados a partir da 2.
 * `mapping` é o da prévia que a tela mostrou; diferente do gravado → 409
 * `preview_changed` (outra aba remapeou).
 */
export const confirmBodySchema = z.object({
  createNew: z.boolean(),
  updateExisting: z.boolean(),
  excludedRows: z.array(z.number().int().min(2)).max(5000).default([]),
  mapping: columnMappingSchema,
});
export type ConfirmBody = z.infer<typeof confirmBodySchema>;

/** `GET .../template`. */
export const templateQuerySchema = z.object({
  format: spreadsheetFormatSchema,
});

export type BatchSituation =
  'PREVIEW' | 'WRITING' | 'INTERRUPTED' | 'COMPLETED' | 'CLOSED';

export type ImportProgress = {
  toWrite: number;
  pending: number;
  writing: number;
  created: number;
  updated: number;
  unchanged: number;
  failed: number;
  /** Das falhas, as por telefone já cadastrado (Conselho S). */
  phoneTaken: number;
  notWritten: number;
};

/** `name` já passou por `nameView`. */
export type PersonRef = { id: string; name: string | null };

export type BatchSummary = {
  id: string;
  fileName: string;
  fileSize: number;
  format: 'csv' | 'xlsx';
  situation: BatchSituation;
  createdAt: string;
  createdBy: PersonRef;
  confirmedAt: string | null;
  confirmedBy: PersonRef | null;
  finishedAt: string | null;
  headers: string[];
  mapping: ColumnMapping;
  mappingProblem: string | null;
  counts: Record<RowClass, number> | null;
  /** Nulo em prévia. */
  progress: ImportProgress | null;
  canConfirm: boolean;
  canContinue: boolean;
  canClose: boolean;
  canDiscard: boolean;
  hasErrorReport: boolean;
  /** `!phoneFullFor(ator do pedido)`: a prévia mostra o aviso fixo (EX17.3). */
  phoneCheckDeferred: boolean;
};

export type BatchListItem = Omit<
  BatchSummary,
  'headers' | 'mapping' | 'mappingProblem' | 'phoneCheckDeferred'
>;

export type BatchList = {
  items: BatchListItem[];
  total: number;
  page: number;
  pageSize: number;
};

export type RowDiffView = {
  field: string;
  label: string;
  before: string | null;
  after: string | null;
};

export type RowView = {
  rowNumber: number;
  classification: RowClass;
  name: string | null;
  registration: string | null;
  sector: string | null;
  reasons: string[];
  warnings: string[];
  diff: RowDiffView[];
  selectable: boolean;
};

export type RowsPage = {
  items: RowView[];
  total: number;
  page: number;
  pageSize: number;
};
