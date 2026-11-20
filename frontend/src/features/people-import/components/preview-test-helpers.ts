import {
  IMPORT_FIELDS,
  ROW_CLASSES,
  type BatchSummary,
  type ColumnMapping,
  type RowClass,
  type RowView,
} from '../schemas';

const PERSON = { id: 'u1', name: 'Marina' };

/** Contagem por classificação; o que não vem no argumento é zero. */
export function counts(values: Partial<Record<RowClass, number>>): Record<RowClass, number> {
  return Object.fromEntries(ROW_CLASSES.map((rowClass) => [rowClass, values[rowClass] ?? 0])) as Record<
    RowClass,
    number
  >;
}

/** Resumo de lote em prévia (formato de `batchSummarySchema`); `counts` parte de zero. */
export function batchSummary(overrides: Partial<BatchSummary> = {}): BatchSummary {
  return {
    id: 'b1',
    fileName: 'pessoas.xlsx',
    fileSize: 2048,
    format: 'xlsx',
    situation: 'PREVIEW',
    createdAt: '2026-11-19T12:00:00.000Z',
    createdBy: PERSON,
    confirmedAt: null,
    confirmedBy: null,
    finishedAt: null,
    counts: counts({}),
    progress: null,
    canConfirm: true,
    canContinue: false,
    canClose: false,
    canDiscard: true,
    hasErrorReport: false,
    headers: ['Nome', 'Telefone'],
    mapping: Object.fromEntries(IMPORT_FIELDS.map((field) => [field, null])) as ColumnMapping,
    mappingProblem: null,
    phoneCheckDeferred: false,
    ...overrides,
  };
}

/** Linha da prévia com valores fictícios; `selectable` só em Criar e Atualizar, como a API. */
export function rowView(rowNumber: number, classification: RowClass, extra: Partial<RowView> = {}): RowView {
  return {
    rowNumber,
    classification,
    name: `Pessoa ${rowNumber}`,
    registration: `M${rowNumber}`,
    sector: 'Produção',
    reasons: [],
    warnings: [],
    diff: [],
    selectable: classification === 'CREATE' || classification === 'UPDATE',
    ...extra,
  };
}
