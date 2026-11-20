import { batchSummary } from './components/preview-test-helpers';
import type { BatchSummary, ImportProgress } from './schemas';

/** Andamento de um lote de 300 linhas; o que não vem no argumento é zero. */
export function progress(values: Partial<ImportProgress> = {}): ImportProgress {
  return {
    toWrite: 300,
    pending: 0,
    writing: 0,
    created: 0,
    updated: 0,
    unchanged: 0,
    failed: 0,
    phoneTaken: 0,
    notWritten: 0,
    ...values,
  };
}

/** Lote confirmado, em gravação, de quem pode continuar (formato de `batchSummarySchema`). */
export function writingBatch(values: Partial<BatchSummary> = {}): BatchSummary {
  return batchSummary({
    situation: 'WRITING',
    confirmedAt: '2026-11-19T12:05:00.000Z',
    canConfirm: false,
    canContinue: true,
    canClose: true,
    progress: progress({ pending: 300 }),
    ...values,
  });
}
