import { z } from 'zod';

/** Espelha o contrato da importação de pessoas do backend (`people-import.schema.ts`, CX2). */

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
export const importFieldSchema = z.enum(IMPORT_FIELDS);
export type ImportField = z.infer<typeof importFieldSchema>;

export const ROW_CLASSES = ['CREATE', 'UPDATE', 'UNCHANGED', 'INVALID', 'DUPLICATE', 'CONFLICT', 'IGNORED'] as const;
export const rowClassSchema = z.enum(ROW_CLASSES);
export type RowClass = z.infer<typeof rowClassSchema>;

export const BATCH_SITUATIONS = ['PREVIEW', 'WRITING', 'INTERRUPTED', 'COMPLETED', 'CLOSED'] as const;
export const batchSituationSchema = z.enum(BATCH_SITUATIONS);
export type BatchSituation = z.infer<typeof batchSituationSchema>;

/** Índice da coluna (0 = primeira) ou `null` = "Não usar". */
const columnIndexSchema = z.number().int().min(0).nullable();
export const columnMappingSchema = z.record(importFieldSchema, columnIndexSchema);
export type ColumnMapping = z.infer<typeof columnMappingSchema>;

const countSchema = z.number().int();
const personRefSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
});

export const importProgressSchema = z.object({
  toWrite: countSchema,
  pending: countSchema,
  writing: countSchema,
  created: countSchema,
  updated: countSchema,
  unchanged: countSchema,
  failed: countSchema,
  /** Das falhas, as por telefone já cadastrado. */
  phoneTaken: countSchema,
  notWritten: countSchema,
});
export type ImportProgress = z.infer<typeof importProgressSchema>;

/** Campos do item da lista; o resumo de um lote acrescenta os da prévia. */
const batchListItemSchema = z.object({
  id: z.string(),
  fileName: z.string(),
  fileSize: countSchema,
  format: z.enum(['csv', 'xlsx']),
  situation: batchSituationSchema,
  createdAt: z.string(),
  createdBy: personRefSchema,
  confirmedAt: z.string().nullable(),
  confirmedBy: personRefSchema.nullable(),
  finishedAt: z.string().nullable(),
  counts: z.record(rowClassSchema, countSchema).nullable(),
  /** Nulo em prévia. */
  progress: importProgressSchema.nullable(),
  canConfirm: z.boolean(),
  canContinue: z.boolean(),
  canClose: z.boolean(),
  canDiscard: z.boolean(),
  hasErrorReport: z.boolean(),
});
export type BatchListItem = z.infer<typeof batchListItemSchema>;

export const batchSummarySchema = batchListItemSchema.extend({
  headers: z.string().array(),
  mapping: columnMappingSchema,
  mappingProblem: z.string().nullable(),
  /** `true` quando o ator não vê telefone completo: a prévia mostra o aviso fixo. */
  phoneCheckDeferred: z.boolean(),
});
export type BatchSummary = z.infer<typeof batchSummarySchema>;

const pageSchema = {
  total: countSchema,
  page: countSchema,
  pageSize: countSchema,
};

export const batchListSchema = z.object({
  items: batchListItemSchema.array(),
  ...pageSchema,
});
export type BatchList = z.infer<typeof batchListSchema>;

const rowDiffSchema = z.object({
  field: z.string(),
  label: z.string(),
  before: z.string().nullable(),
  after: z.string().nullable(),
});

const rowViewSchema = z.object({
  rowNumber: countSchema,
  classification: rowClassSchema,
  name: z.string().nullable(),
  registration: z.string().nullable(),
  sector: z.string().nullable(),
  reasons: z.string().array(),
  warnings: z.string().array(),
  diff: rowDiffSchema.array(),
  selectable: z.boolean(),
});
export type RowView = z.infer<typeof rowViewSchema>;

export const rowsPageSchema = z.object({
  items: rowViewSchema.array(),
  ...pageSchema,
});
export type RowsPage = z.infer<typeof rowsPageSchema>;
