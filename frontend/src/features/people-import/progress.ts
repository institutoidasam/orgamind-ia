import type { BatchSummary, ImportProgress } from './schemas';

/** X do "Gravando X de Y": linhas já resolvidas (gravadas, sem alteração, com falha ou não gravadas). */
export function processedCount(progress: ImportProgress): number {
  return progress.created + progress.updated + progress.unchanged + progress.failed + progress.notWritten;
}

const total = (values: Array<number | undefined>) => values.reduce<number>((sum, value) => sum + (value ?? 0), 0);

/** "Não entraram": o que sai no relatório de erros (inválidas, duplicadas, em conflito, com falha e não gravadas). */
export function notEnteredCount({ counts, progress }: Pick<BatchSummary, 'counts' | 'progress'>): number {
  return total([counts?.INVALID, counts?.DUPLICATE, counts?.CONFLICT, progress?.failed, progress?.notWritten]);
}
