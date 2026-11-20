import {
  IMPORT_FIELD_LABEL,
  type ColumnMapping,
  type RowClass,
  type RowDiffView,
  type RowView,
} from '../../schemas/contracts/people-import.schema';
import { nameView, phoneView } from '../../shared/authz/phone-visibility';
import { formatPhoneCell } from '../../shared/spreadsheet/cell-rules';
import { fieldsOf, isMaskedPhoneText } from './cell-values';
import { phoneFullFor, type ImportActor } from './import-actor';
import type { FieldDiff } from './import-person';
import type { StoredRow } from './people-import.repository';

/** Spec E5: inválidas, repetidas, em conflito, sem alteração e ignoradas não têm caixa. */
const SELECTABLE: ReadonlySet<RowClass> = new Set(['CREATE', 'UPDATE']);

/** Classificações em que a linha achou a pessoa cadastrada. */
const FOUND_PERSON: ReadonlySet<RowClass> = new Set(['UPDATE', 'UNCHANGED']);

/**
 * Linha sem classificação (EX30) não chega aqui (`rows` recusa antes com
 * `mapping_incomplete`); se chegasse, sairia sem caixa.
 */
const UNCLASSIFIED: RowClass = 'IGNORED';

function textOrNull(text: string): string | null {
  return text === '' ? null : text;
}

/** Telefone do cadastro: completo e formatado só com a chave; senão a máscara. */
function storedPhone(phoneE164: string | null, full: boolean): string | null {
  if (phoneE164 === null) return null;
  if (full) return formatPhoneCell(phoneE164);
  return phoneView(phoneE164, { full: false }).phoneMasked;
}

/**
 * GX8: o `before` vem do cadastro e passa pela máscara (nome que é o próprio
 * telefone sai mascarado junto); o `after` veio do arquivo do ator e volta
 * como veio, com o telefone só formatado.
 */
function diffView(diff: FieldDiff, full: boolean): RowDiffView {
  const base = { field: diff.field, label: IMPORT_FIELD_LABEL[diff.field] };
  if (diff.field === 'phone') {
    return {
      ...base,
      before: storedPhone(diff.before, full),
      after: diff.after === null ? null : formatPhoneCell(diff.after),
    };
  }
  if (diff.field === 'name') {
    return {
      ...base,
      before: nameView(diff.before, { full }),
      after: diff.after,
    };
  }
  return { ...base, before: diff.before, after: diff.after };
}

/**
 * Coluna "nome": a célula do arquivo. Vazia ou mascarada em Atualizar e Sem
 * alteração, vale o nome atual da pessoa, com `nameView`.
 */
function rowName(input: {
  cell: string;
  row: StoredRow;
  classification: RowClass;
  full: boolean;
}): string | null {
  const { cell, row, full } = input;
  const fromFile = cell !== '' && !isMaskedPhoneText(cell);
  if (!fromFile && FOUND_PERSON.has(input.classification) && row.preview) {
    return nameView(row.preview.personName, { full });
  }
  return textOrNull(cell);
}

/** Linha da prévia (spec E5): só as colunas mapeadas saem; nada de `cells`. */
export function toRowView(input: {
  row: StoredRow;
  mapping: ColumnMapping;
  actor: ImportActor;
}): RowView {
  const { row } = input;
  const full = phoneFullFor(input.actor);
  const fields = fieldsOf(row.cells ?? {}, input.mapping);
  const classification = row.classification ?? UNCLASSIFIED;
  return {
    rowNumber: row.rowNumber,
    classification,
    name: rowName({ cell: fields.name, row, classification, full }),
    registration: textOrNull(fields.registration),
    sector: textOrNull(fields.sector),
    reasons: row.reasons,
    warnings: row.warnings,
    diff: (row.preview?.diff ?? []).map((diff) => diffView(diff, full)),
    selectable: SELECTABLE.has(classification),
  };
}
