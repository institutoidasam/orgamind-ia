import type { AuditChange, FieldChange } from '../../shared/audit/audit-change';
import type { ImportEnding, ImportResultCounts } from './import-person';

// Trilha do lote de importação (CX3, EX22): só o arquivo, o desfecho e contagens
// (nenhum nome, telefone ou id de pessoa). Valores como dado; o front traduz.
// `before` sempre nulo: a resposta da trilha devolve `changes`, não `metadata`.
// Nenhum campo se chama `phone` ou `email` (o `recordChange` mascararia pelo
// nome): `phoneTaken` é só um número.

const MAX_REASON = 200;
const REASON_PREFIX = 'Importação de planilha: ';
const AUTO_CLOSE_REASON =
  'Encerrada automaticamente: gravação interrompida há mais de 7 dias.';

/** Motivo gravado em cada criação e alteração da importação, cortado em 200. */
export function importReason(fileName: string): string {
  const text = `${REASON_PREFIX}${fileName}`;
  if (text.length <= MAX_REASON) return text;
  const cut = text.slice(0, MAX_REASON);
  // não deixa meio par substituto (emoji) no fim: a coluna é VARCHAR(200)
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

function created(field: string, after: string | number): FieldChange {
  return { field, before: null, after };
}

/** `categoryOfAction` não conhece `people_import`: a categoria vai explícita. */
function batchEvent(event: {
  action: string;
  batchId: string;
  actorId: string;
  reason: string | null;
  changes: FieldChange[];
}): AuditChange {
  return {
    action: event.action,
    entity: 'Spreadsheet',
    entityId: event.batchId,
    category: 'SPREADSHEET',
    subjectUserId: null,
    reason: event.reason,
    changes: event.changes,
    actorId: event.actorId,
  };
}

export function importConfirmedChange(input: {
  actorId: string;
  batchId: string;
  fileName: string;
  rowCount: number;
  toCreate: number;
  toUpdate: number;
}): AuditChange {
  return batchEvent({
    action: 'people_import.confirmed',
    batchId: input.batchId,
    actorId: input.actorId,
    reason: null,
    changes: [
      created('fileName', input.fileName),
      created('rowCount', input.rowCount),
      created('toCreate', input.toCreate),
      created('toUpdate', input.toUpdate),
    ],
  });
}

/** `writing` (reserva viva no encerramento) só aparece quando passa de zero. */
function countChanges(counts: ImportResultCounts): FieldChange[] {
  const changes = [
    created('rowCount', counts.rows),
    created('created', counts.created),
    created('updated', counts.updated),
    created('unchanged', counts.unchanged),
    created('invalid', counts.invalid),
    created('duplicate', counts.duplicate),
    created('conflict', counts.conflict),
    created('failed', counts.failed),
    created('phoneTaken', counts.phoneTaken),
    created('notWritten', counts.notWritten),
  ];
  if (counts.writing > 0) changes.push(created('writing', counts.writing));
  return changes;
}

export function importCompletedChange(input: {
  actorId: string;
  batchId: string;
  fileName: string;
  ending: ImportEnding;
  counts: ImportResultCounts;
}): AuditChange {
  return batchEvent({
    action: 'people_import.completed',
    batchId: input.batchId,
    actorId: input.actorId,
    reason: input.ending === 'AUTO_CLOSED' ? AUTO_CLOSE_REASON : null,
    changes: [
      created('fileName', input.fileName),
      created('ending', input.ending),
      ...countChanges(input.counts),
    ],
  });
}
