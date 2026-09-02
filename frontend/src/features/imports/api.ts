import { useMutation, useQuery, useQueryClient, queryOptions } from '@tanstack/react-query';
import { isTimeoutError } from 'ky';
import { api } from '@/lib/api-client';
import {
  importBatchSchema,
  type ImportBatch,
  type ImportUploadResult,
} from './schemas';

/**
 * The global ky timeout is 15s. The upload now returns 202 immediately (the
 * parse+import runs in the worker), so a timeout is unlikely — but keep a
 * generous override so the multipart upload of a near-10MB file over a slow
 * link still completes.
 */
export const IMPORT_UPLOAD_TIMEOUT_MS = 120_000;

/** A batch is "in flight" while the worker hasn't finished it. */
function isTerminal(b: ImportBatch): boolean {
  return b.status === 'COMPLETED' || b.status === 'FAILED';
}

/**
 * Poll the history list while any batch is still PENDING/PROCESSING, and stop
 * once every batch is terminal. Passed as TanStack Query's `refetchInterval`.
 */
export function importsRefetchInterval(
  query: { state: { data?: ImportBatch[] } },
): number | false {
  const data = query.state.data;
  if (!data) return false;
  return data.some((b) => !isTerminal(b)) ? 3000 : false;
}

/**
 * Translate an upload error into a user-facing message. A {@link isTimeoutError}
 * is special: the request timed out client-side but the backend may still be
 * committing the batch, so we point the operator at the Histórico instead of
 * implying the import failed.
 */
export function importTimeoutMessage(err: unknown): string {
  if (isTimeoutError(err)) {
    return 'A importação demorou e pode ainda estar rodando — veja o Histórico.';
  }
  return 'Falha ao importar';
}

export const importsQueries = {
  list: () =>
    queryOptions({
      queryKey: ['imports'],
      queryFn: async () => {
        const raw = await api.get('imports').json<unknown>();
        return importBatchSchema.array().parse(raw);
      },
      // Auto-poll while any batch is still being processed by the worker.
      refetchInterval: importsRefetchInterval,
    }),
};

export function useImports() {
  return useQuery(importsQueries.list());
}

/** Low-level upload used by both the hook and tests. Returns 202 immediately. */
export async function uploadImport(file: File): Promise<ImportUploadResult> {
  const fd = new FormData();
  fd.append('file', file);
  return api
    .post('imports', { body: fd, timeout: IMPORT_UPLOAD_TIMEOUT_MS })
    .json<ImportUploadResult>();
}

export function useImportExcel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: uploadImport,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['imports'] });
      qc.invalidateQueries({ queryKey: ['contacts'] });
    },
  });
}
