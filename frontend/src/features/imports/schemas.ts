import { z } from 'zod';

/**
 * Lifecycle of an async (BullMQ) import batch (A8 deeper fix). Mirrors the
 * backend Prisma `ImportBatchStatus` enum. Kept as a Zod enum (not a bare
 * string) so a backend value the frontend doesn't know about is caught at parse
 * time rather than crashing a status lookup. Returning batches from before the
 * async migration are backfilled to COMPLETED.
 */
export const importBatchStatusSchema = z.enum([
  'PENDING',
  'PROCESSING',
  'COMPLETED',
  'FAILED',
]);
export type ImportBatchStatus = z.infer<typeof importBatchStatusSchema>;

export const importBatchSchema = z.object({
  id: z.string(),
  filename: z.string(),
  totalRows: z.number(),
  importedRows: z.number(),
  status: importBatchStatusSchema,
  summary: z.unknown().nullable().optional(),
  errors: z.unknown().nullable(),
  createdAt: z.coerce.date(),
});
export type ImportBatch = z.infer<typeof importBatchSchema>;

/**
 * Response of the (now async) upload endpoint: the batch is created PENDING and
 * the import runs in the worker, so the request returns immediately with just
 * the trackable id + status (no per-row summary — that lands on the batch once
 * the worker finishes; poll the history page).
 */
export type ImportUploadResult = {
  batchId: string;
  status: ImportBatchStatus;
};
